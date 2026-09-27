// release-finish as release.yml runs it, with fake git, gh, and npm first on PATH (no network), plus its pure parts.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { releaseMerge, releaseNotes } from "../../scripts/lib/release-finish.mjs";

const SCRIPT = path.resolve(import.meta.dirname, "..", "..", "scripts/release-finish.mjs");
const COMMIT = "a".repeat(40);
const MERGE = "b".repeat(40);
const BODY =
  "## What changed\n\nx\n\n## Release notes\n\n<!-- hint -->\nFixes delivery.\n\n## Verification\n\ny\n";

// Every call is appended to CALLS so a test can see what ran. FAKE_* variables pick the scenario.
const FAKES = {
  git: `
const a = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, "git " + a.join(" ") + "\\n");
if (a[0] === "rev-parse" && a[1].endsWith("^2")) console.log(process.env.FAKE_SECOND || "${COMMIT}");
else if (a[0] === "rev-parse") console.log(process.env.FAKE_TAG_COMMIT || "${COMMIT}");
else if (a[0] === "diff") process.exit(process.env.FAKE_DIFF ? 1 : 0);
else if (a[0] === "ls-remote") console.log((process.env.FAKE_REMOTE_TAG || "${COMMIT}") + "\trefs/tags/v1.2.3");
else if (a[0] === "log") console.log("${MERGE} ${"c".repeat(40)} ${COMMIT}");
`,
  npm: `
const a = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, "npm " + a.join(" ") + "\\n");
if (a[0] === "pack") { fs.writeFileSync(path.join(a[a.indexOf("--pack-destination") + 1], "sphica-1.2.3.tgz"), ""); console.log("sphica-1.2.3.tgz"); }
else if (a.includes("dist-tags")) console.log(JSON.stringify({ latest: process.env.FAKE_LATEST || "1.2.3" }));
else if (a[0] === "view") console.log("1.2.3");
`,
  gh: `
const a = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, "gh " + a.join(" ") + "\\n");
const created = path.join(path.dirname(process.env.CALLS), "created");
if (a[0] === "attestation") process.exit(process.env.FAKE_NO_ATTESTATION ? 1 : 0);
else if (a[0] === "api" && a[1].includes("/commits/")) console.log(JSON.stringify([{ number: 6, head: { sha: "${"d".repeat(40)}" } }, { number: 7, head: { sha: "${COMMIT}" } }]));
else if (a[0] === "api") console.log(JSON.stringify({ body: process.env.FAKE_BODY ?? ${JSON.stringify(BODY)}, head: { sha: process.env.FAKE_HEAD || "${COMMIT}" }, base: { ref: process.env.FAKE_BASE || "main" }, merged: !process.env.FAKE_NOT_MERGED, merge_commit_sha: process.env.FAKE_PR_MERGE || "${MERGE}" }));
else if (a[0] === "release" && a[1] === "create") fs.writeFileSync(created, "");
else if (a[0] === "release" && a[1] === "view") {
  if (!process.env.FAKE_RELEASE_EXISTS && !fs.existsSync(created)) process.exit(1);
  if (a.includes("--json")) console.log(JSON.stringify({ url: "https://github.com/o/r/releases/tag/v1.2.3" }));
}
`,
};

function finish(args: string[], env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-release-finish-"));
  try {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    for (const [name, body] of Object.entries(FAKES)) {
      fs.writeFileSync(
        path.join(bin, `${name}.cjs`),
        `const fs = require("node:fs"); const path = require("node:path");\n${body}`,
      );
      fs.writeFileSync(
        path.join(bin, name),
        `#!/bin/sh\nexec "${process.execPath}" "${bin}/${name}.cjs" "$@"\n`,
        {
          mode: 0o755,
        },
      );
    }
    const calls = path.join(dir, "calls");
    fs.writeFileSync(calls, "");
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        // A temporary HOME, so nothing a child runs can reach the owner's home (USERPROFILE on Windows)
        HOME: dir,
        USERPROFILE: dir,
        GITHUB_REPOSITORY: "o/r",
        CALLS: calls,
        ...env,
      },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      calls: fs.readFileSync(calls, "utf8"),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The digest prepare records before the owner approves, for the notes in BODY
const APPROVED = createHash("sha256").update("Fixes delivery.").digest("hex");
const RELEASE = [
  "--tag",
  "v1.2.3",
  "--commit",
  COMMIT,
  "--merge",
  MERGE,
  "--pull",
  "7",
  "--approved-notes",
  APPROVED,
];

test("release-finish creates the Release from the PR's notes and comments on the PR", () => {
  const { status, stderr, calls } = finish(RELEASE);
  assert.equal(status, 0, stderr);
  assert.match(
    calls,
    /gh attestation verify \S+sphica-1\.2\.3\.tgz --repo o\/r .*--source-ref refs\/tags\/v1\.2\.3/,
  );
  assert.match(calls, /gh release create v1\.2\.3 --repo o\/r --verify-tag --title v1\.2\.3 --notes-file /);
  assert.match(calls, /gh pr comment 7 --repo o\/r --body-file /);
});

test("release-finish prints the digest of the PR's notes before approval, and fails without notes", () => {
  const ok = finish(["--notes-digest", "--pull", "7"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), APPROVED);
  const none = finish(["--notes-digest", "--pull", "7"], { FAKE_BODY: "## What changed\n\nx\n" });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no Release notes/);
});

test("release-finish refuses notes changed after the owner approved", () => {
  const { status, stderr, calls } = finish(RELEASE, { FAKE_BODY: "## Release notes\n\nSomething else.\n" });
  assert.equal(status, 1);
  assert.match(stderr, /Release notes changed after the owner approved/);
  assert.doesNotMatch(calls, /release create|pr comment/);
});

test("release-finish does not create the Release twice when it is rerun", () => {
  const { status, calls } = finish(RELEASE, { FAKE_RELEASE_EXISTS: "1" });
  assert.equal(status, 0);
  assert.doesNotMatch(calls, /release create/);
  assert.match(calls, /gh pr comment 7/);
});

test("release-finish fails before creating anything when a check fails", () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{ FAKE_TAG_COMMIT: "d".repeat(40) }, /v1\.2\.3 points to d{40}, not a{40}/],
    [{ FAKE_HEAD: "d".repeat(40) }, /PR #7 has head d{40}, not the tag commit/],
    [{ FAKE_SECOND: "d".repeat(40) }, /does not merge v1\.2\.3/],
    [{ FAKE_REMOTE_TAG: "d".repeat(40) }, /remote tag v1\.2\.3 points to d{40}/],
    [{ FAKE_NOT_MERGED: "1" }, /PR #7 is not merged at b{40}/],
    [{ FAKE_BASE: "release" }, /PR #7 targets release, not main/],
    [{ FAKE_PR_MERGE: "d".repeat(40) }, /PR #7 is not merged at b{40}/],
    [{ FAKE_DIFF: "1" }, /tree of .* differs/],
    [{ FAKE_NO_ATTESTATION: "1" }, /no SBOM attestation/],
    [{ FAKE_LATEST: "1.2.2" }, /npm latest is 1\.2\.2/],
    [{ FAKE_BODY: "## What changed\n\nx\n" }, /no Release notes/],
    [{ FAKE_BODY: "## Release notes\n\n<!-- only a hint -->\n\n## Verification\n" }, /no Release notes/],
  ];
  for (const [env, message] of cases) {
    const { status, stderr, calls } = finish(RELEASE, env);
    assert.equal(status, 1, JSON.stringify(env));
    assert.match(stderr, message);
    assert.doesNotMatch(calls, /release create|pr comment/);
  }
});

test("release-finish --dry-run checks the latest published release and creates or posts nothing", () => {
  const { status, stderr, calls } = finish(["--dry-run"]);
  assert.equal(status, 0, stderr);
  assert.match(calls, /gh attestation verify .*--source-ref refs\/tags\/v1\.2\.3/);
  assert.doesNotMatch(calls, /release create|release view|pr comment/);
  // Of the PRs that contain the tag commit, the release PR is the one whose head it is
  assert.match(calls, /gh api repos\/o\/r\/pulls\/7\n/);
});

test("release-finish refuses malformed arguments", () => {
  assert.equal(finish(["--tag", "v1.2.3", "--commit", "x", "--merge", MERGE, "--pull", "7"]).status, 1);
  assert.equal(finish(["--tag", "1.2.3", "--commit", COMMIT, "--merge", MERGE, "--pull", "7"]).status, 1);
});

test("release-finish reads only the Release notes section, without comments", () => {
  assert.equal(releaseNotes(BODY), "Fixes delivery.");
  assert.equal(releaseNotes("## Release notes\r\n\r\nLast section.\r\n"), "Last section.");
  assert.equal(releaseNotes("## Release notes\n\n<!-- x -->\n"), null);
  assert.equal(releaseNotes(null), null);
  // Nested comment markers must not leave an opening `<!--` that would hide the rest of the notes
  assert.equal(releaseNotes("## Release notes\n\n<!<!---->--x\nHidden\n"), null);
  assert.equal(releaseNotes("## Release notes\n\nText <!-- open\n"), null);
  // A fence closes only with the same character at least as long, so a shorter line inside does not end it
  assert.equal(
    releaseNotes("## What changed\n````md\n```\n## Release notes\nExample\n````\n## Verification\n"),
    null,
  );
  assert.equal(releaseNotes("## What changed\n~~~\n```\n## Release notes\nExample\n~~~\n"), null);
  // Headings inside a code fence are text, not sections
  assert.equal(
    releaseNotes("## What changed\n```md\n## Release notes\nInjected\n```\n## Verification\nOK\n"),
    null,
  );
  assert.equal(
    releaseNotes(
      "## Release notes\n\nRun:\n```sh\n## Verification\nsphica doctor\n```\n\n## Declined findings\n",
    ),
    "Run:\n```sh\n## Verification\nsphica doctor\n```",
  );
});

test("release-finish finds the merge whose second parent is the tag commit", () => {
  const log = `${"e".repeat(40)} ${"f".repeat(40)} ${"9".repeat(40)}\n${MERGE} ${"c".repeat(40)} ${COMMIT}\n`;
  assert.equal(releaseMerge(log, COMMIT), MERGE);
  assert.equal(releaseMerge(log, "0".repeat(40)), null);
});
