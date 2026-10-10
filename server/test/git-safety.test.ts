// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// An agent can write its repository's git config and attributes; Sphica runs git there outside the agent's sandbox. Each path that config
// could run a command through is planted with a program that leaves a mark, shown to mark when plain git runs, and shown to leave none
// when Sphica's git runs.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inIsolation, renamesSince, repoFiles } from "../src/git.ts";
import { prepareGlean } from "../src/glean.ts";
import { localChange } from "../src/review-bridge.ts";
import { ruleFiles } from "../src/rule-files.ts";
import { snapshot } from "../src/worktree.ts";
import { tempDir } from "./temp-dir.ts";

/** git for building fixtures: none of the owner's or the runner's config */
const FIXTURE_ENV: NodeJS.ProcessEnv = (() => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  delete env.SPHICA_DB;
  delete env.SPHICA_HOME;
  // Git for Windows opens /dev/null as nul but cannot open \\.\nul, what os.devNull gives there
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
})();

/** One word for a POSIX shell (git runs config commands and hooks through one), quoted so nothing in it is expanded */
const shellWord = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A path git can put in a shell command or an ext:: URL on every platform */
const slash = (p: string) => p.split(path.sep).join("/");

/** A repository with one commit, and a mark file the planted commands append their names to */
function trap() {
  const base = fs.realpathSync(tempDir("git-safety-"));
  const repo = path.join(base, "repo");
  const marks = path.join(base, "marks");
  const mark = path.join(base, "mark.cjs");
  // Appends its name, passes stdin through (a clean filter), and fails (a fetch gives up)
  fs.writeFileSync(
    mark,
    `require("node:fs").appendFileSync(${JSON.stringify(marks)}, process.argv[2] + "\\n");\nprocess.exitCode = process.argv[3] === "fail" ? 1 : 0;\n`,
  );
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
      encoding: "utf8",
      env: FIXTURE_ENV,
    });
  execFileSync("git", ["init", "-q", repo], { env: FIXTURE_ENV });
  fs.writeFileSync(path.join(repo, "a.txt"), "hi\n");
  fs.writeFileSync(path.join(repo, "CLAUDE.md"), "rules\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  /** The shell command git runs for a planted key */
  const command = (name: string, ...rest: string[]) =>
    [process.execPath, mark, name, ...rest].map((p) => shellWord(slash(p))).join(" ");
  const read = () => (fs.existsSync(marks) ? fs.readFileSync(marks, "utf8").split("\n").filter(Boolean) : []);
  const clear = () => fs.rmSync(marks, { force: true });
  /** Plain git as an owner's shell would run it: the positive control */
  const plain = (...args: string[]) =>
    spawnSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      env: FIXTURE_ENV,
      stdio: ["ignore", "pipe", "pipe"],
    });
  return { base, repo, git, command, mark, read, clear, plain };
}

/** Runs the plain-git control, then Sphica's call, and returns the marks each left */
async function compare(t: ReturnType<typeof trap>, control: () => unknown, sphica: () => unknown) {
  t.clear();
  control();
  const plain = t.read();
  t.clear();
  const result = await sphica();
  return { plain, sphica: t.read(), result };
}

/**
 * HOME and the temp directory moved to fresh directories apart from each other for the duration: Sphica's work tree comparisons keep
 * their isolated git directory under HOME, never in the owner's own, and apart from the temp directory
 */
async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = fs.realpathSync(tempDir("git-safety-home-"));
  const tmp = fs.realpathSync(tempDir("git-safety-tmp-"));
  const keys = ["HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "XDG_CONFIG_HOME"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    // git reads its global ignore file and config under XDG_CONFIG_HOME before HOME (runners set it)
    XDG_CONFIG_HOME: path.join(home, ".config"),
  });
  try {
    return await fn();
  } finally {
    for (const k of keys)
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
  }
}

test("core.fsmonitor in the repository's config, or in a file it includes, runs nothing when Sphica lists files", async () => {
  const t = trap();
  t.git("config", "core.fsmonitor", t.command("fsmonitor"));
  for (const [what, call] of [
    ["repoFiles", () => repoFiles(t.repo)],
    ["ruleFiles", () => ruleFiles(t.repo)],
  ] as const) {
    const got = await compare(t, () => t.plain("ls-files", "-z"), call);
    assert.deepEqual(got.plain, ["fsmonitor"], "plain git runs the planted fsmonitor");
    assert.deepEqual(got.sphica, [], `${what} runs it`);
    assert.ok(got.result, `${what} still answers`);
  }
  assert.deepEqual(repoFiles(t.repo)?.sort(), ["CLAUDE.md", "a.txt"]);
  const rules = ruleFiles(t.repo);
  assert.deepEqual([rules.files.map((f) => f.path), rules.incomplete], [["CLAUDE.md"], null]);
  // The same key in a file the config includes
  t.git("config", "--unset", "core.fsmonitor");
  const included = path.join(t.base, "included.cfg");
  fs.writeFileSync(
    included,
    `[core]\n\tfsmonitor = ${t.command("fsmonitor").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}\n`,
  );
  t.git("config", "include.path", included);
  const got = await compare(
    t,
    () => t.plain("ls-files", "-z"),
    () => repoFiles(t.repo),
  );
  assert.deepEqual(got.plain, ["fsmonitor"], "plain git runs the included fsmonitor");
  assert.deepEqual(got.sphica, []);
  assert.deepEqual((got.result as string[] | null)?.sort(), ["CLAUDE.md", "a.txt"]);
});

test("a missing object never fetches from a promisor remote the repository names", async () => {
  const t = trap();
  const blob = t.git("rev-parse", "HEAD:a.txt").trim();
  fs.rmSync(path.join(t.repo, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  t.git("config", "core.repositoryformatversion", "1");
  t.git("config", "extensions.partialClone", "evil");
  t.git("config", "remote.evil.promisor", "true");
  t.git("config", "remote.evil.url", `ext::${slash(process.execPath)} ${slash(t.mark)} fetch fail`);
  t.git("config", "protocol.ext.allow", "always");
  const op = {
    op: "add_evidence",
    unit: "u1",
    revision: 1,
    file: { path: "a.txt", commit: "HEAD", lines: [1, 1] },
    quote: "hi",
    role: "states",
  };
  const got = await compare(
    t,
    () => t.plain("cat-file", "-s", blob),
    () => prepareGlean(t.repo, { ops: [op] }),
  );
  assert.ok(got.plain.includes("fetch"), "plain git fetches the missing object through the planted remote");
  assert.deepEqual(got.sphica, []);
  // The excerpt is a read failure, not a fetched file
  const excerpts = [...(got.result as ReturnType<typeof prepareGlean>).excerpts.values()];
  assert.ok(excerpts.length === 1 && excerpts[0] instanceof Error);
});

/**
 * A.txt changed in the work tree, its index entry rewritten with no stat data so git must read the file to compare it, and an
 * origin/main at the commit for a review to compare against
 */
function unstat(t: ReturnType<typeof trap>) {
  const blob = t.git("rev-parse", "HEAD:a.txt").trim();
  fs.writeFileSync(path.join(t.repo, "a.txt"), "changed\n");
  t.git("update-index", "--cacheinfo", `100644,${blob},a.txt`);
}

test("filters, diff drivers, and textconv the repository names run nothing when Sphica compares the work tree", async () => {
  const cases: [string, (t: ReturnType<typeof trap>) => void][] = [
    [
      "clean",
      (t) => {
        fs.writeFileSync(path.join(t.repo, ".gitattributes"), "*.txt filter=evil\n");
        t.git("config", "filter.evil.clean", t.command("clean"));
      },
    ],
    [
      "process",
      (t) => {
        fs.writeFileSync(path.join(t.repo, ".gitattributes"), "*.txt filter=evil\n");
        t.git("config", "filter.evil.process", t.command("process"));
      },
    ],
    [
      "info-attributes",
      (t) => {
        fs.mkdirSync(path.join(t.repo, ".git", "info"), { recursive: true });
        fs.writeFileSync(path.join(t.repo, ".git", "info", "attributes"), "*.txt filter=evil\n");
        t.git("config", "filter.evil.clean", t.command("info-attributes"));
      },
    ],
    [
      "extdiff",
      (t) => {
        fs.writeFileSync(path.join(t.repo, ".gitattributes"), "*.txt diff=evil\n");
        t.git("config", "diff.evil.command", t.command("extdiff"));
      },
    ],
    [
      "textconv",
      (t) => {
        fs.writeFileSync(path.join(t.repo, ".gitattributes"), "*.txt diff=evil\n");
        t.git("config", "diff.evil.textconv", t.command("textconv"));
      },
    ],
    ["external", (t) => t.git("config", "diff.external", t.command("external"))],
  ];
  const diffs = new Set(["extdiff", "textconv", "external"]);
  await withHome(async () => {
    for (const [name, plant] of cases) {
      const t = trap();
      t.git("update-ref", "refs/remotes/origin/main", "HEAD");
      t.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
      const head = t.git("rev-parse", "HEAD").trim();
      plant(t);
      const calls: [string, () => unknown][] = [
        ["snapshot", () => snapshot(t.repo)],
        ["renamesSince", () => renamesSince(t.repo, head)],
        ["localChange", () => localChange(t.repo, "")],
      ];
      for (const [what, call] of calls) {
        unstat(t);
        const control = () => (diffs.has(name) ? t.plain("diff", "HEAD") : t.plain("status", "--porcelain"));
        const got = await compare(t, control, () => {
          unstat(t);
          return call();
        });
        assert.ok(got.plain.includes(name), `plain git runs the planted ${name} (${what})`);
        assert.deepEqual(got.sphica, [], `${what} runs the planted ${name}`);
        // The answer is the real one, not a failure that ran nothing: a.txt is seen as changed
        const result = got.result as
          | Awaited<ReturnType<typeof snapshot>>
          | Awaited<ReturnType<typeof renamesSince>>
          | Awaited<ReturnType<typeof localChange>>;
        if (what === "snapshot")
          assert.ok(result && "entries" in result && "a.txt" in result.entries, `${what} with ${name}`);
        else if (what === "renamesSince") assert.ok(result instanceof Map, `${what} with ${name}`);
        else
          assert.ok(
            result && "files" in result && result.files.some((f) => f.path === "a.txt"),
            `${what} with ${name}: ${JSON.stringify(result).slice(0, 200)}`,
          );
      }
    }
  });
});

/** The git version as numbers, to tell a control that cannot mark on an older git from a broken one */
const gitVersion = (): number[] =>
  (/(\d+)\.(\d+)/.exec(execFileSync("git", ["--version"], { encoding: "utf8" })) ?? []).slice(1).map(Number);
const atLeast = (v: number[], [a, b]: [number, number]) =>
  (v[0] ?? 0) > a || ((v[0] ?? 0) === a && (v[1] ?? 0) >= b);

/** a.txt's index entry rewritten with no stat data while the file is unchanged: status refreshes and writes the index */
function restat(t: ReturnType<typeof trap>) {
  const blob = t.git("rev-parse", "HEAD:a.txt").trim();
  fs.writeFileSync(path.join(t.repo, "a.txt"), "hi\n");
  t.git("update-index", "--cacheinfo", `100644,${blob},a.txt`);
}

test("hooks, a submodule's config, per-worktree config, and the owner's global filters run nothing", async () => {
  await withHome(async () => {
    // A hook in .git/hooks, and one defined in config where git supports that
    const t = trap();
    fs.copyFileSync(t.mark, path.join(t.repo, ".git", "hooks", "post-index-change.cjs"));
    fs.writeFileSync(
      path.join(t.repo, ".git", "hooks", "post-index-change"),
      `#!/bin/sh\nexec ${shellWord(slash(process.execPath))} ${shellWord(slash(t.mark))} hook\n`,
      { mode: 0o755 },
    );
    // The fixture git that rewrites the entry runs the hook too, so the marks are cleared after it
    const marksOf = async (run: () => unknown) => {
      restat(t);
      t.clear();
      const result = await run();
      return { marks: t.read(), result };
    };
    const plainStatus = () => t.plain("status", "--porcelain");
    const sphicaStatus = () => snapshot(t.repo);
    // Git for Windows runs a hook through its own shell, so the control holds there too
    assert.ok((await marksOf(plainStatus)).marks.includes("hook"), "plain git runs the hook");
    let seen = await marksOf(sphicaStatus);
    assert.deepEqual(seen.marks, []);
    assert.ok(seen.result && typeof seen.result === "object" && "entries" in seen.result, "snapshot answers");
    fs.rmSync(path.join(t.repo, ".git", "hooks", "post-index-change"));
    t.git("config", "hook.evil.event", "post-index-change");
    t.git("config", "hook.evil.command", t.command("config-hook"));
    // Hooks defined in config came in a later git than the oldest one Sphica supports; 2.54 has them
    if (!(await marksOf(plainStatus)).marks.includes("config-hook"))
      assert.ok(!atLeast(gitVersion(), [2, 54]), "plain git runs the config hook");
    seen = await marksOf(sphicaStatus);
    assert.deepEqual(seen.marks, []);
    assert.ok(seen.result && typeof seen.result === "object" && "entries" in seen.result, "snapshot answers");
  });
  await withHome(async () => {
    // A submodule whose own config names an fsmonitor and a filter its attributes pick, with a change inside it
    const t = trap();
    const sub = path.join(t.base, "sub");
    execFileSync("git", ["init", "-q", sub], { env: FIXTURE_ENV });
    fs.writeFileSync(path.join(sub, "s.txt"), "s\n");
    execFileSync("git", ["-C", sub, "add", "s.txt"], { env: FIXTURE_ENV });
    execFileSync(
      "git",
      ["-C", sub, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "s"],
      {
        env: FIXTURE_ENV,
      },
    );
    t.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub");
    t.git("commit", "-qm", "sub");
    const inSub = (...a: string[]) =>
      execFileSync("git", ["-C", path.join(t.repo, "sub"), ...a], { encoding: "utf8", env: FIXTURE_ENV });
    inSub("config", "core.fsmonitor", t.command("submodule"));
    fs.writeFileSync(path.join(t.repo, "sub", ".gitattributes"), "*.txt filter=sub\n");
    inSub("config", "filter.sub.clean", t.command("submodule-filter"));
    // s.txt's entry without stat data, so the submodule's own status reads the file through the filter
    const blob = inSub("rev-parse", "HEAD:s.txt").trim();
    fs.appendFileSync(path.join(t.repo, "sub", "s.txt"), "more\n");
    inSub("update-index", "--cacheinfo", `100644,${blob},s.txt`);
    const got = await compare(
      t,
      () => t.plain("status", "--porcelain"),
      () => snapshot(t.repo),
    );
    assert.ok(got.plain.includes("submodule"), "plain git runs the submodule's fsmonitor");
    assert.ok(got.plain.includes("submodule-filter"), "plain git runs the submodule's filter");
    assert.deepEqual(got.sphica, []);
    assert.ok(got.result && typeof got.result === "object" && "entries" in got.result, "snapshot answers");
  });
  await withHome(async () => {
    // core.fsmonitor in the work tree's own config
    const t = trap();
    t.git("config", "extensions.worktreeConfig", "true");
    t.git("config", "--worktree", "core.fsmonitor", t.command("worktree-config"));
    const got = await compare(
      t,
      () => t.plain("ls-files", "-z"),
      () => repoFiles(t.repo),
    );
    assert.ok(got.plain.includes("worktree-config"), "plain git runs the per-worktree fsmonitor");
    assert.deepEqual(got.sphica, []);
    assert.deepEqual((got.result as string[] | null)?.sort(), ["CLAUDE.md", "a.txt"]);
  });
  await withHome(async () => {
    // The owner's global config defines a filter; the agent picks it in .gitattributes, and the command it runs is the agent's
    const t = trap();
    const global = path.join(os.homedir(), ".gitconfig");
    fs.writeFileSync(
      global,
      `[filter "owner"]\n\tclean = ${t.command("global").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}\n`,
    );
    fs.writeFileSync(path.join(t.repo, ".gitattributes"), "*.txt filter=owner\n");
    unstat(t);
    const got = await compare(
      t,
      () =>
        spawnSync("git", ["-C", t.repo, "status", "--porcelain"], {
          env: { ...FIXTURE_ENV, GIT_CONFIG_GLOBAL: global },
          stdio: "ignore",
        }),
      () => {
        unstat(t);
        return snapshot(t.repo);
      },
    );
    assert.ok(got.plain.includes("global"), "plain git runs the owner's global filter");
    assert.deepEqual(got.sphica, []);
    const snap = got.result as Awaited<ReturnType<typeof snapshot>>;
    assert.ok(snap && "a.txt" in snap.entries, "snapshot sees a.txt changed");
  });
});

/** Status as Sphica reads it through the isolated git directory, and as plain git prints it in the repository itself */
async function bothStatus(root: string): Promise<{ sphica: string | undefined; plain: string }> {
  const sphica = (await inIsolation(root, [{ kind: "status" }], { deadline: 10_000, max: 1024 * 1024 }))?.[0];
  const plain = execFileSync(
    "git",
    ["-C", root, "status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=dirty"],
    { encoding: "utf8", env: FIXTURE_ENV },
  );
  return { sphica, plain };
}

test("the isolated status matches plain git for linked work trees, split and sparse indexes, SHA-256, and submodule commits", async () => {
  await withHome(async () => {
    const t = trap();
    const change = (root: string) => {
      fs.writeFileSync(path.join(root, "a.txt"), "changed\n");
      fs.writeFileSync(path.join(root, "new.txt"), "n\n");
    };
    // A linked work tree, which has its own index under the shared git directory
    const linked = path.join(t.base, "linked");
    t.git("worktree", "add", "-q", linked);
    change(linked);
    let got = await bothStatus(linked);
    assert.equal(got.sphica, got.plain, "linked work tree");
    assert.match(got.plain, /a\.txt/);
    // A split index, whose shared part sits beside the index
    t.git("update-index", "--split-index");
    change(t.repo);
    got = await bothStatus(t.repo);
    assert.equal(got.sphica, got.plain, "split index");
    t.git("update-index", "--no-split-index");
    // A sparse checkout that leaves a directory out
    fs.mkdirSync(path.join(t.repo, "kept"));
    fs.mkdirSync(path.join(t.repo, "left"));
    fs.writeFileSync(path.join(t.repo, "kept", "k.txt"), "k\n");
    fs.writeFileSync(path.join(t.repo, "left", "l.txt"), "l\n");
    t.git("add", "-A");
    t.git("commit", "-qm", "dirs");
    t.git("sparse-checkout", "set", "kept");
    fs.writeFileSync(path.join(t.repo, "kept", "k.txt"), "changed\n");
    got = await bothStatus(t.repo);
    assert.equal(got.sphica, got.plain, "sparse checkout");
    t.git("sparse-checkout", "disable");
  });
  await withHome(async () => {
    // A SHA-256 repository
    const root = fs.realpathSync(tempDir("git-safety-sha256-"));
    execFileSync("git", ["init", "-q", "--object-format=sha256", root], { env: FIXTURE_ENV });
    const git = (...a: string[]) =>
      execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], {
        encoding: "utf8",
        env: FIXTURE_ENV,
      });
    fs.writeFileSync(path.join(root, "a.txt"), "a\n");
    git("add", "a.txt");
    git("commit", "-qm", "one");
    fs.writeFileSync(path.join(root, "a.txt"), "b\n");
    const got = await bothStatus(root);
    assert.equal(got.sphica, got.plain, "SHA-256");
    assert.match(got.plain, /a\.txt/);
  });
  await withHome(async () => {
    // A submodule moved to a new commit still shows as changed
    const t = trap();
    const sub = path.join(t.base, "sub");
    execFileSync("git", ["init", "-q", sub], { env: FIXTURE_ENV });
    const subGit = (dir: string, ...a: string[]) =>
      execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], {
        env: FIXTURE_ENV,
      });
    fs.writeFileSync(path.join(sub, "s.txt"), "s\n");
    subGit(sub, "add", "s.txt");
    subGit(sub, "commit", "-qm", "s");
    t.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub");
    t.git("commit", "-qm", "sub");
    fs.writeFileSync(path.join(t.repo, "sub", "s.txt"), "moved\n");
    subGit(path.join(t.repo, "sub"), "commit", "-qam", "move");
    const got = await bothStatus(t.repo);
    assert.equal(got.sphica, got.plain, "submodule commit");
    assert.match(got.plain, /sub/);
  });
});
