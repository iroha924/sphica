// The git worker's own guards: where its isolated directory may be, which files it reads and how, the config it writes, and the deadline
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inIsolation } from "../src/git.ts";
import { isolatedConfig, isolatedHome, readLimited, sweep } from "../src/git-worker.ts";
import { tempDir } from "./temp-dir.ts";

const FIXTURE_ENV: NodeJS.ProcessEnv = (() => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  delete env.SPHICA_DB;
  delete env.SPHICA_HOME;
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull };
})();

/** Runs fn with HOME and the temp directory moved to fresh directories apart from each other, as the worker requires */
async function withHome<T>(fn: (home: string, tmp: string) => T | Promise<T>): Promise<T> {
  const home = fs.realpathSync(tempDir("git-worker-home-"));
  const tmp = fs.realpathSync(tempDir("git-worker-tmp-"));
  const keys = ["HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp });
  try {
    return await fn(home, tmp);
  } finally {
    for (const k of keys)
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
  }
}

function repo(): { root: string; git: (...a: string[]) => string } {
  const root = fs.realpathSync(tempDir("git-worker-repo-"));
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], {
      encoding: "utf8",
      env: FIXTURE_ENV,
    });
  git("init", "-q");
  return { root, git };
}

test("the isolated directory sits under HOME's real path, in plain directories, apart from the work tree and the temp directory", async () => {
  const { root } = repo();
  await withHome((home) => {
    const { iso, hooks } = isolatedHome(root);
    assert.equal(path.dirname(iso), path.join(home, ".sphica", "git"));
    assert.equal(hooks, path.join(home, ".sphica", "git", "hooks"));
    // A work tree that holds HOME's .sphica, or is the temp directory's neighbor inside it, is refused
    assert.throws(() => isolatedHome(home), /overlaps/);
  });
  await withHome((home) => {
    // .sphica leading elsewhere through a link
    const elsewhere = fs.realpathSync(tempDir("git-worker-elsewhere-"));
    fs.symlinkSync(elsewhere, path.join(home, ".sphica"));
    assert.throws(() => isolatedHome(root), /not a plain directory/);
  });
  await withHome((home) => {
    fs.mkdirSync(path.join(home, ".sphica", "git", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(home, ".sphica", "git", "hooks", "post-index-change"), "");
    assert.throws(() => isolatedHome(root), /not empty/);
  });
  await withHome((home) => {
    process.env.TMPDIR = home;
    process.env.TMP = home;
    process.env.TEMP = home;
    assert.throws(() => isolatedHome(root), /overlaps/);
  });
});

test("the worker reads only regular files, never through a link, and never more than its limit", () => {
  const dir = fs.realpathSync(tempDir("git-worker-read-"));
  const file = path.join(dir, "f");
  fs.writeFileSync(file, "abc");
  assert.equal(readLimited(file, 3)?.toString(), "abc");
  assert.equal(readLimited(path.join(dir, "missing"), 3), null);
  assert.throws(() => readLimited(file, 2), /over 2 bytes/);
  fs.symlinkSync(file, path.join(dir, "link"));
  assert.throws(() => readLimited(path.join(dir, "link"), 3), /regular file/);
  fs.mkdirSync(path.join(dir, "d"));
  assert.throws(() => readLimited(path.join(dir, "d"), 3), /regular file/);
  // A FIFO with no writer would block an ordinary read for ever; here it is refused at once
  if (process.platform !== "win32") {
    execFileSync("mkfifo", [path.join(dir, "fifo")]);
    assert.throws(() => readLimited(path.join(dir, "fifo"), 3), /regular file/);
  }
});

test("the isolated config holds only checked values in one fixed form", () => {
  assert.equal(
    isolatedConfig({ "core.ignorecase": "true", "core.autocrlf": "input", "core.excludesFile": "/x" }),
    "[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tquotePath = false\n\tignorecase = true\n\tautocrlf = input\n",
  );
  assert.match(
    isolatedConfig({ "extensions.objectFormat": "sha256", "index.sparse": "false" }),
    /repositoryformatversion = 1[\s\S]*\[index\]\n\tsparse = false\n\[extensions\]\n\tobjectFormat = sha256\n$/,
  );
  // A value carrying a new section is refused, not written
  assert.throws(() => isolatedConfig({ "core.eol": 'lf\n[filter "evil"]\n\tclean = x' }), /does not copy/);
  assert.throws(() => isolatedConfig({ "core.filemode": "yes" }), /does not copy/);
});

test("a repository with no commit or no index still shows its files, and a missed deadline gives null", async () => {
  const { root, git } = repo();
  await withHome(async (home) => {
    fs.writeFileSync(path.join(root, "u.txt"), "u");
    const [none] =
      (await inIsolation(root, [{ kind: "status" }], { deadline: 10_000, max: 1024 * 1024 })) ?? [];
    assert.equal(none, "? u.txt\0");
    git("add", "u.txt");
    const [staged] =
      (await inIsolation(root, [{ kind: "status" }], { deadline: 10_000, max: 1024 * 1024 })) ?? [];
    assert.match(staged ?? "", /^1 A\. N\.\.\. 000000 100644 100644 0{40} [0-9a-f]{40} u\.txt\0$/);
    // The isolated directory is gone after each call
    assert.deepEqual(fs.readdirSync(path.join(home, ".sphica", "git")), ["hooks"]);
    assert.equal(await inIsolation(root, [{ kind: "status" }], { deadline: 1, max: 1024 * 1024 }), null);
  });
});

test("isolated directories left by a cut-off worker are removed once they are an hour old", async () => {
  await withHome((home) => {
    const git = path.join(home, ".sphica", "git");
    fs.mkdirSync(path.join(git, "iso-old"), { recursive: true });
    fs.mkdirSync(path.join(git, "iso-new"));
    const hour = 60 * 60 * 1000;
    const old = new Date(Date.now() - 2 * hour);
    fs.utimesSync(path.join(git, "iso-old"), old, old);
    sweep();
    assert.deepEqual(fs.readdirSync(git).sort(), ["iso-new"]);
  });
});
