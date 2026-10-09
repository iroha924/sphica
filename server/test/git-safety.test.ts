// An agent can write its repository's git config and attributes; Sphica runs git there outside the agent's sandbox. Each path that config
// could run a command through is planted with a program that leaves a mark, shown to mark when plain git runs, and shown to leave none
// when Sphica's git runs.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { renamesSince, repoFiles } from "../src/git.ts";
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
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull };
})();

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
    [process.execPath, mark, name, ...rest].map((p) => JSON.stringify(slash(p))).join(" ");
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
  const keys = ["HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp });
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
  ];
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
        const control = () =>
          name === "extdiff" ? t.plain("diff", "HEAD") : t.plain("status", "--porcelain");
        const got = await compare(t, control, () => {
          unstat(t);
          return call();
        });
        assert.ok(got.plain.includes(name), `plain git runs the planted ${name} (${what})`);
        assert.deepEqual(got.sphica, [], `${what} runs the planted ${name}`);
        assert.ok(got.result, `${what} still answers with ${name} planted`);
      }
    }
  });
});
