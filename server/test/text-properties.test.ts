// Properties of the string code search and records rely on, over generated input (fast-check, fixed seed so a failure reruns the same),
// and the growth of mask()'s time, which must stay linear: it runs on every captured message.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import fc from "fast-check";
import { leaves } from "../src/anchors.ts";
import { parseDiff } from "../src/review.ts";
import { bytes, ftsQuery, head, mask, quoteSpan, tail } from "../src/text.ts";
import { tempDb } from "./temp-db.ts";

const SEED = 20260930;
const runs = { seed: SEED, numRuns: 300 };
const text = fc.string({ unit: "grapheme", maxLength: 80 });
const anyText = fc.oneof(
  text,
  fc.string({ unit: "binary", maxLength: 80 }),
  fc.string({ unit: "grapheme-composite", maxLength: 40 }),
);

// Identifier-like runs with the characters FTS5 reads as syntax when a term is not quoted
const syntax = fc
  .array(
    fc.oneof(
      fc.stringMatching(/^[a-z0-9]{1,6}$/),
      fc.constantFrom("-", ".", "/", "#", ":", "*", '"', "(", ")", "^", "+", " ", "NEAR", "AND"),
    ),
    {
      minLength: 1,
      maxLength: 12,
    },
  )
  .map((parts) => parts.join(""));

test("ftsQuery of any text is a query FTS5 accepts, or null", async () => {
  const db = tempDb();
  try {
    const match = db.owner.prepare("select count(*) as n from unit_fts where unit_fts match ?");
    fc.assert(
      fc.property(fc.oneof(anyText, syntax), (q) => {
        const query = ftsQuery(q);
        if (query !== null) match.get(query);
      }),
      runs,
    );
  } finally {
    await db.done();
  }
});

test("head and tail keep the longest start and end that fit the byte limit, without cutting a character", () => {
  fc.assert(
    fc.property(anyText, fc.nat({ max: 200 }), (s, n) => {
      const chars = [...s];
      const h = head(s, n);
      const t = tail(s, n);
      // Text that fits comes back whole; text that does not is cut to fit
      assert.ok(bytes(s) <= n ? h === s && t === s : bytes(h) <= n && bytes(t) <= n);
      assert.ok(s.startsWith(h) && s.endsWith(t));
      assert.equal(Buffer.from(h, "utf8").toString("utf8"), h);
      // One more character would not fit
      const hn = [...h].length;
      const tn = [...t].length;
      if (hn < chars.length) assert.ok(bytes(h + (chars[hn] ?? "")) > n);
      if (tn < chars.length) assert.ok(bytes((chars[chars.length - tn - 1] ?? "") + t) > n);
    }),
    runs,
  );
});

test("a span quoteSpan returns holds exactly the quote", () => {
  fc.assert(
    fc.property(anyText, fc.nat(), fc.nat(), (raw, a, b) => {
      const masked = mask(raw);
      const chars = [...masked];
      const from = chars.length ? a % chars.length : 0;
      const quote = chars.slice(from, from + 1 + (b % 12)).join("");
      const span = quoteSpan(raw, masked, quote);
      if (span) assert.equal(Buffer.from(masked, "utf8").subarray(span[0], span[1]).toString("utf8"), quote);
      // Text with nothing to mask always finds a quote cut from it
      if (raw === masked && quote) assert.notEqual(span, null);
    }),
    runs,
  );
});

test("leaves is false for any path below the base and true for one that climbs out", () => {
  // "root" is the base's own name: "../root/x" climbs out and back in
  const segment = fc
    .stringMatching(/^[A-Za-z0-9._-]{1,12}$/)
    .filter((s) => s !== "." && s !== ".." && s !== "root");
  fc.assert(
    fc.property(fc.array(segment, { minLength: 1, maxLength: 5 }), (segs) => {
      const base = path.resolve("/repo/root");
      assert.equal(leaves(path.relative(base, path.join(base, ...segs))), false);
      assert.equal(leaves(path.relative(base, path.join(base, "..", ...segs))), true);
    }),
    runs,
  );
});

test("parseDiff takes every added line of a hunk, even one that looks like a file header", () => {
  const line = fc.oneof(
    fc.string({ maxLength: 30 }).map((s) => s.replace(/[\r\n]/g, "")),
    fc.constantFrom("--- a/x", "+++ b/y", "diff --git a/z b/z", "@@ -1 +1 @@"),
  );
  fc.assert(
    fc.property(fc.array(line, { minLength: 1, maxLength: 20 }), (lines) => {
      const diff = [
        "diff --git a/f.ts b/f.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/f.ts",
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((l) => `+${l}`),
      ].join("\n");
      const files = parseDiff(diff);
      assert.deepEqual(
        files.map((f) => f.path),
        ["f.ts"],
      );
      assert.deepEqual(files[0]?.added, lines);
      assert.deepEqual(
        files[0]?.lines,
        lines.map((_, i) => i + 1),
      );
    }),
    runs,
  );
});

/** The fastest of 5 runs of mask, after one warm-up run: the least touched by other work on the machine (test files run in parallel). */
function timed(input: string): number {
  mask(input);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    mask(input);
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

// Shapes that make a backtracking pattern slow: long runs a secret pattern starts to match and then fails on
const ADVERSARIAL: [string, (n: number) => string][] = [
  ["assignment without a value", (n) => "password=".repeat(n)],
  ["credentials in a URL", (n) => `https://${"a:".repeat(n)}`],
  ["authorization header", (n) => `Authorization: ${"Bearer ".repeat(n)}`],
  ["key-like run", (n) => `sk-${"a".repeat(n)}`],
  ["private key header", (n) => "-----BEGIN ".repeat(n)],
];

// Doubling the input must not much more than double the time: each ratio is from one length to the next (2n/n and 4n/2n). A busy machine
// can slow one measurement, so each shape gets up to three tries; a pattern that really grows faster than linear fails all of them
test("mask takes time in proportion to the input on shapes that stress its patterns", () => {
  for (const [name, make] of ADVERSARIAL) {
    // Callers never pass more than 2 MiB (capture cuts at 128 KiB, anchors read files up to 2 MiB), so 4n stays within that
    let n = 1000;
    while (timed(make(n)) < 5 && n < 500_000) n *= 2;
    const tries: string[] = [];
    for (let i = 0; i < 3; i++) {
      const [a, b, c] = [timed(make(n)), timed(make(2 * n)), timed(make(4 * n))];
      if (b / a <= 3 && c / b <= 3) break;
      tries.push(`${a.toFixed(1)}, ${b.toFixed(1)}, ${c.toFixed(1)} ms`);
    }
    assert.ok(tries.length < 3, `${name}: every try grew faster than linear (${tries.join("; ")})`);
  }
});

// Each shape mask knows, at the shortest length it hides and one character short of it, so dropping a shape from the list fails a test
const at = (prefix: string, n: number, ch = "a") => `${prefix}${ch.repeat(n)}`;
const SHAPES: [string, string, string][] = [
  ["OpenAI or Anthropic key", at("sk-", 20), at("sk-", 19)],
  ["Stripe key", at("sk_live_", 16), at("sk_live_", 15)],
  ["webhook signing secret", at("whsec_", 16), at("whsec_", 15)],
  ["pa- key", at("pa-", 20), at("pa-", 19)],
  ["Google API key", at("AIza", 35), at("AIza", 34)],
  ["npg_ database password", at("npg_", 12), at("npg_", 11)],
  ["napi key", at("napi_", 30), at("napi_", 29)],
  ["npm token", at("npm_", 36), at("npm_", 35)],
  ["GitLab token", at("glpat-", 20), at("glpat-", 19)],
  [
    "stateless GitHub token",
    `ghs_eyJ${"a".repeat(5)}.${"b".repeat(8)}.${"c".repeat(8)}`,
    `ghs_eyJ${"a".repeat(5)}.${"b".repeat(7)}.${"c".repeat(8)}`,
  ],
  ["GitHub token", at("ghp_", 30), at("ghp_", 29)],
  ["fine-grained GitHub token", at("github_pat_", 40), at("github_pat_", 39)],
  ["Slack token", at("xoxb-", 10), at("xoxb-", 9)],
  ["Slack webhook", "https://hooks.slack.com/services/T0/B0/x", "https://hooks.slack.com/servicesx"],
  ["AWS key", at("AKIA", 16, "A"), at("AKIA", 15, "A")],
  [
    "JWT",
    `eyJ${"a".repeat(8)}.${"b".repeat(8)}.${"c".repeat(8)}`,
    `eyJ${"a".repeat(8)}.${"b".repeat(7)}.${"c".repeat(8)}`,
  ],
  ["pasted Bearer value", `Bearer ${"a".repeat(15)}1`, `Bearer ${"a".repeat(16)}`],
  ["Authorization header", `Authorization: Basic ${"a".repeat(8)}`, `Authorization: Basic ${"a".repeat(7)}`],
  [
    "bearer in another header",
    `-H "X-Auth: bearer ${"a".repeat(16)}"`,
    `-H "X-Auth: bearer ${"a".repeat(15)}"`,
  ],
  ["mysql -p password", "mysql -u root -psecretpw books", "mysql -u root -p books"],
];

test("every shape mask knows is hidden at its shortest length and kept one character short", () => {
  for (const [name, hidden, kept] of SHAPES) {
    assert.notEqual(mask(`see ${hidden} here`), `see ${hidden} here`, `${name} is hidden`);
    assert.equal(mask(`see ${kept} here`), `see ${kept} here`, `${name} one short is kept`);
  }
});
