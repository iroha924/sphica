import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { osvLine, osvSummary } from "../../scripts/lib/osv-summary.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SHA = "b".repeat(40);

// The shape osv-scanner 2.6.0 writes with --format=json (its internal/ci/testdata/results-some.json)
const pkg = (name: string, version: string, ids: string[]) => ({
  package: { name, version, ecosystem: "npm" },
  vulnerabilities: ids.map((id) => ({ id, aliases: [], summary: "x" })),
  groups: ids.map((id) => ({ ids: [id], aliases: null })),
});
const report = (...packages: object[]) =>
  JSON.stringify({ results: [{ source: { path: "/w/server/bun.lock", type: "lockfile" }, packages }] });

test("a missing, empty, non-JSON, or foreign results file is unavailable, never none", () => {
  for (const [text, reason] of [
    [null, "no results file"],
    ["", "is empty"],
    ["  \n", "is empty"],
    ["{", "not JSON"],
    ["[]", "not osv-scanner's JSON"],
    [JSON.stringify({ results: [{ packages: [{ package: { name: "a" } }] }] }), "not osv-scanner's JSON"],
    [
      JSON.stringify({
        results: [{ packages: [{ package: { name: "a", version: "1" }, vulnerabilities: [{}] }] }],
      }),
      "not osv-scanner's JSON",
    ],
  ] as const) {
    const s = osvSummary(text, SHA);
    assert.equal(s.status, "unavailable", String(text));
    assert.equal(s.count, 0);
    assert.match(s.markdown, new RegExp(reason));
    assert.doesNotMatch(s.markdown, /No known vulnerabilities/);
  }
});

test("no results, or packages without vulnerabilities, is none", () => {
  for (const text of [
    JSON.stringify({ results: [], experimental_config: {} }),
    report(pkg("a", "1.0.0", [])),
  ]) {
    const s = osvSummary(text, SHA);
    assert.equal(s.status, "none");
    assert.equal(s.count, 0);
    assert.match(s.markdown, new RegExp(`OSV scan of \`${SHA}\``));
    assert.match(s.markdown, /No known vulnerabilities/);
  }
});

test("one vulnerability is found with its package row", () => {
  const s = osvSummary(report(pkg("hono", "4.0.0", ["GHSA-aaaa"]), pkg("zod", "4.6.5", [])), SHA);
  assert.equal(s.status, "found");
  assert.equal(s.count, 1);
  assert.match(s.markdown, /1 known vulnerability in 1 package\./);
  assert.match(s.markdown, /^\| `hono` \| `4\.0\.0` \| `npm` \| `GHSA-aaaa` \|$/m);
  assert.doesNotMatch(s.markdown, /zod/);
});

test("an ID in two packages counts once; each package keeps its row", () => {
  const s = osvSummary(
    JSON.stringify({
      results: [
        { source: { path: "/w/server/bun.lock" }, packages: [pkg("a", "1", ["GHSA-1", "GHSA-2"])] },
        {
          source: { path: "/w/plugin/package-lock.json" },
          packages: [pkg("b", "2", ["GHSA-1"]), pkg("c", "3", ["GHSA-3"])],
        },
      ],
    }),
    SHA,
  );
  assert.equal(s.status, "found");
  assert.equal(s.count, 3);
  assert.match(s.markdown, /3 known vulnerabilities in 3 packages\./);
  assert.match(s.markdown, /^\| `a` \| `1` \| `npm` \| `GHSA-1`, `GHSA-2` \|$/m);
  assert.match(s.markdown, /^\| `b` \| `2` \| `npm` \| `GHSA-1` \|$/m);
});

test("a table cell cannot break out of its row", () => {
  for (const name of ["a|b\n| x |", "a\\| ![x](https://example.org/i)", "a`|`b", "a\\`|"]) {
    const s = osvSummary(report(pkg(name, "1", ["GHSA-1"])), SHA);
    const row = s.markdown.split("\n").find((l) => l.endsWith("| `GHSA-1` |"));
    assert.ok(row, name);
    assert.equal(row.split("|").length, 6, row);
    assert.doesNotMatch(row, /\\/, row);
    assert.equal(row.split("`").length, 9, row);
  }
});

test("groups naming vulnerabilities the package does not list are unavailable, not none", () => {
  for (const vulnerabilities of [undefined, null, []]) {
    const text = JSON.stringify({
      results: [
        {
          packages: [
            {
              package: { name: "a", version: "1", ecosystem: "npm" },
              vulnerabilities,
              groups: [{ ids: ["GHSA-1"] }],
            },
          ],
        },
      ],
    });
    assert.equal(osvSummary(text, SHA).status, "unavailable", String(vulnerabilities));
  }
});

// Cells keep only the characters package names, versions, and IDs use, inside a code span, so GFM shows them as typed
test("a cell keeps name characters and replaces the rest", () => {
  const s = osvSummary(
    report(
      pkg("@scope/a_b.js", "1.0.0-rc.1+build~2", ["GHSA-x1y2-z3w4-0000"]),
      pkg("golang.org/x/net", "v0.0.0-20210101:1", ["GO-2021-0053"]),
      pkg("![x](https://example.org/i)", "1", ["*ID*&copy;"]),
      pkg("a`<b>`c d", "1", ["X"]),
    ),
    SHA,
  );
  assert.match(
    s.markdown,
    /^\| `@scope\/a_b\.js` \| `1\.0\.0-rc\.1\+build~2` \| `npm` \| `GHSA-x1y2-z3w4-0000` \|$/m,
  );
  assert.match(
    s.markdown,
    /^\| `golang\.org\/x\/net` \| `v0\.0\.0-20210101:1` \| `npm` \| `GO-2021-0053` \|$/m,
  );
  assert.match(
    s.markdown,
    /^\| `\?\?x\?\?https:\/\/example\.org\/i\?` \| `1` \| `npm` \| `\?ID\?\?copy\?` \|$/m,
  );
  assert.match(s.markdown, /^\| `a\?\?b\?\?c\?d` \| `1` \| `npm` \| `X` \|$/m);
});

test("the approval comment's line names the status", () => {
  assert.equal(
    osvLine({ status: "found", count: 2 }, SHA),
    `OSV scan of ${SHA}: 2 known vulnerabilities (see the run summary)`,
  );
  assert.equal(
    osvLine({ status: "found", count: 1 }, SHA),
    `OSV scan of ${SHA}: 1 known vulnerability (see the run summary)`,
  );
  assert.equal(osvLine({ status: "none", count: 0 }, SHA), `OSV scan of ${SHA}: no known vulnerabilities`);
  assert.equal(
    osvLine({ status: "unavailable", count: 0 }, SHA),
    `OSV scan of ${SHA}: results unavailable (see the run summary)`,
  );
});

// Runs the CLI as release.yml does: it must exit 0 with the outputs even when the scan left no results
test("the CLI writes the summary and outputs, and exits 0 when results are missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-osv-summary-"));
  try {
    const run = (file: string) => {
      const env = {
        ...process.env,
        GITHUB_STEP_SUMMARY: path.join(dir, "summary.md"),
        GITHUB_OUTPUT: path.join(dir, "output"),
      };
      fs.rmSync(env.GITHUB_STEP_SUMMARY, { force: true });
      fs.rmSync(env.GITHUB_OUTPUT, { force: true });
      const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/osv-summary.mjs"), file, SHA], {
        env,
        encoding: "utf8",
      });
      return {
        ...r,
        summary: fs.readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"),
        output: fs.readFileSync(env.GITHUB_OUTPUT, "utf8"),
      };
    };
    const missing = run(path.join(dir, "results.json"));
    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(missing.summary, missing.stdout);
    assert.match(missing.summary, /Results unavailable: the scan wrote no results file/);
    assert.equal(
      missing.output,
      `status=unavailable\ncount=0\nline=OSV scan of ${SHA}: results unavailable (see the run summary)\n`,
    );

    fs.writeFileSync(path.join(dir, "results.json"), report(pkg("a", "1", ["GHSA-1"])));
    const found = run(path.join(dir, "results.json"));
    assert.equal(found.status, 0, found.stderr);
    assert.match(found.output, /^status=found\ncount=1\nline=OSV scan of b{40}: 1 known vulnerability/);

    const unreadable = run(dir);
    assert.equal(unreadable.status, 0, unreadable.stderr);
    assert.match(unreadable.summary, /Results unavailable: the results file could not be read \(EISDIR\)/);
    assert.match(unreadable.output, /^status=unavailable\n/);

    const bad = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts/osv-summary.mjs"), "x.json", "not-a-sha"],
      { encoding: "utf8" },
    );
    assert.notEqual(bad.status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
