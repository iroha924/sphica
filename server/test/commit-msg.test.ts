// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

import "./isolate-home.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { commitMessageProblems } from "../../scripts/lib/commit-msg.mjs";

type Opts = { merge?: boolean; hook?: boolean; commentChar?: string; cleanup?: string };
const ok = (m: string, opts: Opts = {}) => assert.deepEqual(commitMessageProblems(m, opts), [], m);
const bad = (m: string, re: RegExp, opts: Opts = {}) =>
  assert.match(commitMessageProblems(m, opts).join("\n"), re, m);
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SCRIPT = fileURLToPath(new URL("../../scripts/check-commit-msg.mjs", import.meta.url));
const SCISSORS = "------------------------ >8 ------------------------";

test("accepts one Conventional Commits line in English", () => {
  ok("feat: add a check\n");
  ok("fix(cli)!: keep the closing line at the line start");
});

test("in the hook, ignores the editor template and the verbose diff, with the configured comment character", () => {
  const hook = { hook: true };
  ok(
    "docs: note the release steps\n\n# Please enter the commit message\n# Lines starting with '#' are ignored\n",
    hook,
  );
  ok(
    `feat: add one\n\n# Please enter the commit message\n# ${SCISSORS}\n# Do not modify.\ndiff --git a/x b/x\n+added\n`,
    hook,
  );
  ok(`feat: add one\n\n; Please enter the commit message\n; ${SCISSORS}\ndiff --git a/x b/x\n`, {
    hook: true,
    commentChar: ";",
  });
  bad("feat: add a check\n# second line", /one-line subject/, hook);
  // commit.cleanup=verbatim keeps the template in the stored commit, so the hook must count it too
  bad("feat: add x\n\n# Please enter the commit message", /one-line subject/, {
    hook: true,
    cleanup: "verbatim",
  });
});

test("checks stored messages as they are, scissors and comment lines included", () => {
  bad(`feat: valid subject\n\n# ${SCISSORS}\n\n日本語 body`, /English/);
  bad("docs: note\n\n# kept by git commit -m", /one-line subject/);
});

test("rejects bodies, other shapes, Japanese, and long subjects", () => {
  bad("feat: add a check\n\nMore detail", /one-line subject/);
  bad("Add a check", /start with <type>/);
  bad("feature: add a check", /start with <type>/);
  bad("feat(CLI): add a check", /start with <type>/);
  bad("feat: 検査を足す", /English/);
  bad(`feat: ${"x".repeat(100)}`, /within 100 characters/);
});

test("lets through only the exact shapes Git writes for merges and reverts", () => {
  ok("Merge pull request #145 from iroha924/biome-config\n\nbuild: lint every tracked source", {
    merge: true,
  });
  ok("Merge branches 'one' and 'two'", { merge: true });
  ok(`Revert "feat: add a check"\n\nThis reverts commit ${SHA}.`);
  ok(
    `Revert "Merge pull request #1 from x/y"\n\nThis reverts commit ${SHA}, reversing\nchanges made to ${SHA}.`,
  );
  bad("Merge pull request #145 from iroha924/biome-config\n\nmore", /one-line subject/);
  bad('Revert "not generated"\n\nAn arbitrary body', /one-line subject/);
  bad("Merge pull request #1 from x/y\n\n検査を足す", /English/, { merge: true });
});

test("--pre-push checks the stored messages of the pushed refs, not HEAD and not commits already on a remote", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-pre-push-"));
  try {
    // Without this, git inside a hook would act on the repository running the tests, and children would inherit the owner's DB.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_") && k !== "SPHICA_DB"),
    );
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], {
        cwd: dir,
        env: { ...env, HOME: dir },
        encoding: "utf8",
      }).trim();
    const check = (stdin: string) =>
      spawnSync(process.execPath, [SCRIPT, "--pre-push"], {
        cwd: dir,
        env: { ...env, HOME: dir },
        input: stdin,
      });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "古いコミット"); // already on the remote, from before the English rule
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("switch", "-q", "-c", "clean");
    git("commit", "-q", "--allow-empty", "-m", "feat: valid subject");
    const clean = git("rev-parse", "HEAD");
    git("switch", "-q", "-c", "bodied", "main");
    git("commit", "-q", "--allow-empty", "-m", "feat: valid subject", "-m", "# retained body");
    const bodied = git("rev-parse", "HEAD");
    const zero = "0".repeat(40);

    const rejected = check(`refs/heads/bodied ${bodied} refs/heads/bodied ${zero}\n`);
    assert.equal(rejected.status, 1);
    assert.match(String(rejected.stderr), /use a one-line subject with no body/);
    assert.doesNotMatch(String(rejected.stderr), /write the message in English/);

    // HEAD is on bodied, but only clean is pushed.
    const other = check(`refs/heads/clean ${clean} refs/heads/clean ${zero}\n`);
    assert.equal(other.status, 0, String(other.stderr));
    assert.match(String(other.stdout), /1 checked/);

    // The remote already has clean: nothing new. A remote tip not fetched here falls back to the remote-tracking refs.
    assert.match(String(check(`refs/heads/clean ${clean} refs/heads/clean ${clean}\n`).stdout), /0 checked/);
    const unknownTip = check(`refs/heads/bodied ${bodied} refs/heads/bodied ${"1".repeat(40)}\n`);
    assert.equal(unknownTip.status, 1);
    assert.match(String(unknownTip.stderr), /use a one-line subject with no body/);
    assert.doesNotMatch(String(unknownTip.stderr), /write the message in English/);
    assert.match(String(check(`(delete) ${zero} refs/heads/gone ${clean}\n`).stdout), /0 checked/);
    // Two refs in one push, the same commit on both: counted once.
    const twoRefs = `refs/heads/clean ${clean} refs/heads/clean ${zero}\nrefs/heads/c2 ${clean} refs/heads/c2 ${zero}\n`;
    assert.match(String(check(twoRefs).stdout), /1 checked/);

    // Notes and other metadata refs are not branches: Git writes their commit messages.
    assert.match(
      String(check(`refs/notes/commits ${bodied} refs/notes/commits ${zero}\n`).stdout),
      /0 checked/,
    );

    // A branch already on the remote that merges in main: main's old message is already pushed.
    git("switch", "-q", "-c", "feature", "clean");
    git("update-ref", "refs/remotes/origin/feature", "HEAD");
    git("switch", "-q", "main");
    git("commit", "-q", "--allow-empty", "-m", "もう一つの古いコミット"); // reached main after feature forked
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("switch", "-q", "feature");
    git("merge", "-q", "--no-ff", "-m", "Merge branch 'main' into feature", "main");
    const merged = git("rev-parse", "HEAD");
    const withMain = check(`refs/heads/feature ${merged} refs/heads/feature ${clean}\n`);
    assert.equal(withMain.status, 0, String(withMain.stderr));

    // Control characters in a stored subject do not reach the terminal.
    git("switch", "-q", "-c", "forged", "main");
    git("commit", "-q", "--allow-empty", "-m", "bad: visible\rFORGED\x1b[2J");
    const forged = check(`refs/heads/forged ${git("rev-parse", "HEAD")} refs/heads/forged ${zero}\n`);
    assert.equal(forged.status, 1);
    assert.ok(
      !String(forged.stderr).includes("\r") && !String(forged.stderr).includes("\x1b"),
      String(forged.stderr),
    );

    // A message cannot shift the record fields: \x01 in the body stays in the body.
    git("switch", "-q", "-c", "framed", "main");
    git("commit", "-q", "--allow-empty", "-m", "feat: valid subject\n\n\x01\x1b[2JFORGED");
    const framed = check(`refs/heads/framed ${git("rev-parse", "HEAD")} refs/heads/framed ${zero}\n`);
    assert.equal(framed.status, 1);
    assert.match(String(framed.stderr), /use a one-line subject with no body/);
    assert.ok(!String(framed.stderr).includes("\x1b"), String(framed.stderr));

    // A commit reachable only from a pushed tag is checked; a release tag on pushed commits adds nothing.
    git("switch", "-q", "-c", "tagged", "main");
    git("commit", "-q", "--allow-empty", "-m", "タグだけのコミット");
    git("tag", "-a", "-m", "hidden", "hidden");
    git("switch", "-q", "main");
    git("branch", "-D", "-q", "tagged");
    const tagged = check(`refs/tags/hidden ${git("rev-parse", "hidden")} refs/tags/hidden ${zero}\n`);
    assert.equal(tagged.status, 1);
    assert.match(String(tagged.stderr), /write the message in English/);
    git("tag", "release", clean);
    git("update-ref", "refs/remotes/origin/clean", clean);
    assert.match(String(check(`refs/tags/release ${clean} refs/tags/release ${zero}\n`).stdout), /0 checked/);
    git("update-ref", "-d", "refs/remotes/origin/clean");

    // With no remote-tracking refs there is no base: skip rather than reject the old message in the history.
    git("update-ref", "-d", "refs/remotes/origin/main");
    git("update-ref", "-d", "refs/remotes/origin/feature");
    const noBase = check(`refs/heads/clean ${clean} refs/heads/clean ${zero}\n`);
    assert.equal(noBase.status, 0, String(noBase.stderr));
    assert.match(String(noBase.stdout), /skipped/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
