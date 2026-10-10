import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CASES,
  duplicates,
  judge,
  keysIn,
  OLD,
  type Result,
  tally,
  via,
} from "../evals/post-write/shell-write-harness.ts";

const LEAD =
  "Active decisions applying to src/a.ts, files whose content changed between before and after this call (current code relevance unverified).";
const K = "trace:ext-b0/f1";
const result = (over: Partial<Result>): Result => ({
  case: "p01",
  kind: "positive",
  host: "claude-code",
  plugin: "new",
  session: "s",
  exit: 0,
  pre: "",
  post: "",
  posted: true,
  trial: { event: "post_shell", changed: ["src/a.ts"] },
  ...over,
});

test("the harness holds 40 shell positives of different shapes, and every case names its files", () => {
  const ctx = { repo: "/r", py: "python3", biome: "/b" };
  const positives = CASES.filter((c) => c.kind === "positive" && c.shell === "sh");
  assert.equal(positives.length, 40);
  assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length, "ids are unique");
  assert.equal(
    new Set(positives.map((c) => c.command(ctx))).size,
    40,
    "no two positives run the same command",
  );
  assert.equal(new Set(positives.map((c) => c.what)).size, 40, "no two positives describe the same shape");
  for (const c of CASES) assert.ok(c.files.length, `${c.id} names the files it is about`);
});

test("a positive passes only when Post saw its file change and its record came in during the call", () => {
  assert.equal(judge(result({ post: `${LEAD}\n- ${K} (constraint do): x` }), [K], ["src/a.ts"]), null);
  assert.equal(
    judge(result({ pre: `- ${K} (constraint do): x` }), [K], ["src/a.ts"]),
    null,
    "Pre showed it first",
  );
  assert.equal(judge(result({}), [K], ["src/a.ts"]), `missing ${K}`);
  assert.equal(
    judge(result({ pre: `- ${K}`, trial: { event: "post_shell", changed: [] } }), [K], ["src/a.ts"]),
    "not seen as changed: src/a.ts",
  );
  assert.equal(
    judge(result({ pre: `- ${K}`, trial: { event: "snapshot_missing" } }), [K], ["src/a.ts"]),
    "no comparison logged (snapshot_missing)",
  );
  assert.equal(
    judge(result({ plugin: OLD, pre: `- ${K}`, posted: false, trial: undefined }), [K], ["src/a.ts"]),
    null,
    "the bundle from before the feature is judged on what reached the conversation",
  );
  assert.equal(
    judge(result({ pre: `- ${K}`, posted: false, trial: undefined }), [K], ["src/a.ts"]),
    "no Post hook ran",
    "this bundle must run its Post even when Pre already showed the record",
  );
  assert.equal(
    judge(
      result({ pre: `- ${K}`, trial: { event: "post_shell", changed: ["src/a.ts"], error: "boom" } }),
      [K],
      ["src/a.ts"],
    ),
    "Post failed: boom",
  );
  assert.equal(
    judge(result({ post: `- ${K}` }), [K], ["src/a.ts"]),
    "Post replied without the shell-write lead",
  );
});

test("a negative passes only when its file did not count as changed and Post added nothing", () => {
  const n = (over: Partial<Result>) =>
    result({ kind: "negative", trial: { event: "post_shell", changed: [] }, ...over });
  assert.equal(
    judge(n({ pre: `- ${K}` }), [K], ["src/a.ts"]),
    null,
    "a read's own delivery is not an addition",
  );
  assert.equal(judge(n({ post: `${LEAD}\n- ${K}` }), [K], ["src/a.ts"]), `Post added ${K}`);
  assert.equal(
    judge(n({ trial: { event: "post_shell", changed: ["src/a.ts"] } }), [K], ["src/a.ts"]),
    "seen as changed: src/a.ts",
  );
  // A comparison that did not happen, or could not tell the file, is not "unchanged"
  assert.equal(judge(n({ trial: undefined }), [K], ["src/a.ts"]), "no comparison logged (no trial line)");
  assert.equal(
    judge(n({ trial: { event: "snapshot_missing" } }), [K], ["src/a.ts"]),
    "no comparison logged (snapshot_missing)",
  );
  assert.equal(
    judge(n({ trial: { event: "post_shell", changed: [], unknown: ["src/a.ts"] } }), [K], ["src/a.ts"]),
    "not told: src/a.ts",
  );
  assert.equal(
    judge(n({ trial: { event: "post_shell", changed: [], error: "boom" } }), [K], ["src/a.ts"]),
    "Post failed: boom",
  );
  assert.equal(judge(n({ posted: false, trial: undefined }), [K], ["src/a.ts"]), "no Post hook ran");
});

test("the tally counts each kind apart, and duplicates are counted per conversation", () => {
  const rows = [
    result({ pre: `- ${K}` }),
    result({ case: "p02" }),
    result({ case: "n01", kind: "negative", trial: { event: "post_shell", changed: [] } }),
    result({ case: "s01", kind: "separate", post: `${LEAD}\n- ${K}` }),
    result({ case: "l01", kind: "limit", trial: { event: "post_shell", changed: [] } }),
  ];
  const t = tally(
    rows,
    () => [K],
    () => ["src/a.ts"],
  );
  assert.deepEqual(t.positive, { pass: 1, total: 2 });
  assert.deepEqual(t.negative, { pass: 1, total: 1 });
  assert.deepEqual(t.separate, { changed: 1, delivered: 1, total: 1 });
  assert.deepEqual(t.limit, { changed: 0, delivered: 0, total: 1 });
  assert.deepEqual(t.failures, [`p02 claude-code: missing ${K}`]);
  assert.equal(via(result({ pre: `- ${K}`, post: `${LEAD}\n- ${K}` }), [K]), "both");
  assert.equal(via(result({ post: `${LEAD}\n- ${K}` }), [K]), "post");
  assert.deepEqual(keysIn(`- ${K} and ${K}, trace:ext-b2/f9`), [K, "trace:ext-b2/f9"]);
  assert.equal(
    duplicates([
      result({ pre: `- ${K}`, post: `${LEAD}\n- ${K}` }),
      result({ session: "other", pre: `- ${K}` }),
    ]),
    1,
    "the same record twice in one conversation, once in another",
  );
});
