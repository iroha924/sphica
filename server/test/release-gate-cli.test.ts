// Runs scripts/release-gate.mjs as release.yml does, with fake git, gh, and npm first on PATH (no network).
// The workflow reads the PR number from GITHUB_OUTPUT, so check what the script actually writes there.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "plugin/package.json"), "utf8")).version;
const TAG = `v${VERSION}`;
const COMMIT = "a".repeat(40);
const REPO = "iroha924/sphica";

// Each fake answers only what release-gate.mjs asks. FAKE_NO_PR makes gh list no PR, so the gate fails.
const FAKES = {
  git: `
const [cmd] = process.argv.slice(2);
if (cmd === "ls-remote") process.stdout.write("${COMMIT}\\trefs/tags/${TAG}\\n");
`,
  npm: `
process.stderr.write("npm error code E404\\n");
process.exit(1);
`,
  gh: `
const args = process.argv.slice(2);
const endpoint = args.find((a) => a.startsWith("repos/") || a === "graphql") ?? "";
const pull = { state: "open", number: 7, base: { ref: "main" }, head: { sha: "${COMMIT}", repo: { full_name: "${REPO}" } } };
const run = (name) => ({ id: 1, name, event: "pull_request", head_sha: "${COMMIT}", status: "completed", conclusion: "success", pull_requests: [{ number: 7, base: { ref: "main" } }] });
if (endpoint.includes("/pulls")) process.stdout.write(JSON.stringify(process.env.FAKE_NO_PR ? [] : [pull]));
else if (endpoint.includes("actions/runs")) process.stdout.write(JSON.stringify({ workflow_runs: [run("check"), run("pr-body"), run("release")] }));
else if (endpoint.endsWith("/comments?per_page=100")) process.stdout.write(JSON.stringify([[{ user: { id: 199175422, type: "Bot" }, body: '<!-- codex-security-review:v1 {"headSha":"${COMMIT}","status":"' + (process.env.FAKE_REVIEW_RUNNING ? "running" : "completed") + '"} -->' }]]));
else if (endpoint === "graphql") process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: true }], pageInfo: { hasNextPage: false, endCursor: null } } } } } }));
else process.exit(1);
`,
};

function runGate(env: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-release-gate-"));
  try {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    for (const [name, body] of Object.entries(FAKES)) {
      fs.writeFileSync(path.join(bin, `${name}.cjs`), body);
      fs.writeFileSync(
        path.join(bin, name),
        `#!/bin/sh\nexec "${process.execPath}" "${bin}/${name}.cjs" "$@"\n`,
        {
          mode: 0o755,
        },
      );
    }
    const output = path.join(dir, "github_output");
    fs.writeFileSync(output, "");
    const result = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts/release-gate.mjs"), "--tag", TAG, "--commit", COMMIT],
      {
        encoding: "utf8",
        env: {
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          // A temporary HOME, so nothing a child runs can reach the owner's home (USERPROFILE on Windows)
          HOME: dir,
          USERPROFILE: dir,
          GITHUB_REPOSITORY: REPO,
          GITHUB_OUTPUT: output,
          ...env,
        },
      },
    );
    return { status: result.status, stderr: result.stderr, output: fs.readFileSync(output, "utf8") };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("release-gate writes the PR number to GITHUB_OUTPUT when the tag may be released", () => {
  const { status, stderr, output } = runGate({});
  assert.equal(status, 0, stderr);
  assert.equal(output, "pull=7\n");
});

test("release-gate writes nothing to GITHUB_OUTPUT when the gate fails", () => {
  const { status, output } = runGate({ FAKE_NO_PR: "1" });
  assert.equal(status, 1);
  assert.equal(output, "");
});

test("release-gate stops a head whose Codex review is still running", () => {
  const { status, stderr, output } = runGate({ FAKE_REVIEW_RUNNING: "1" });
  assert.equal(status, 1);
  assert.match(stderr, /running, not completed/);
  assert.equal(output, "");
});
