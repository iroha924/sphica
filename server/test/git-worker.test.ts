// The git worker's own guards: where its isolated directory may be, which files it reads and how, the config it writes, and the deadline
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inIsolation, repoFiles } from "../src/git.ts";
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
    sweep(git);
    assert.deepEqual(fs.readdirSync(git).sort(), ["iso-new"]);
  });
});

test("git and the worker start in HOME, not in the caller's directory, where Windows would look for git.exe first", async () => {
  // A git first on PATH that records where it started, then runs git
  const bin = fs.realpathSync(tempDir("git-worker-bin-"));
  const log = path.join(bin, "cwd.log");
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh\npwd >> ${JSON.stringify(log)}\nexec ${JSON.stringify(real)} "$@"\n`,
    {
      mode: 0o755,
    },
  );
  const { root } = repo();
  const saved = { PATH: process.env.PATH, cwd: process.cwd() };
  await withHome(async (home) => {
    process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ""}`;
    process.chdir(root);
    try {
      assert.ok(repoFiles(root));
      assert.ok(await inIsolation(root, [{ kind: "status" }], { deadline: 10_000, max: 1024 * 1024 }));
    } finally {
      process.chdir(saved.cwd);
      process.env.PATH = saved.PATH;
    }
    const dirs = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.ok(dirs.length > 2);
    assert.deepEqual([...new Set(dirs.map((d) => fs.realpathSync(d)))], [home]);
  });
});

test("a cut-off worker's leftovers are swept only from a checked directory, never through a link", async () => {
  const { root } = repo();
  await withHome(async (home) => {
    const elsewhere = fs.realpathSync(tempDir("git-worker-elsewhere-"));
    const owned = path.join(elsewhere, "git", "iso-owner-data");
    fs.mkdirSync(owned, { recursive: true });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(owned, old, old);
    fs.symlinkSync(elsewhere, path.join(home, ".sphica"));
    assert.equal(await inIsolation(root, [{ kind: "status" }], { deadline: 10_000, max: 1024 * 1024 }), null);
    assert.ok(fs.existsSync(owned), "the directory behind the link is left alone");
  });
});

test("a HEAD that names a missing commit fails instead of passing for a new repository", async () => {
  const { root, git } = repo();
  fs.writeFileSync(path.join(root, "a.txt"), "a");
  git("add", "a.txt");
  git("commit", "-qm", "one");
  const head = git("rev-parse", "HEAD").trim();
  fs.rmSync(path.join(root, ".git", "objects", head.slice(0, 2), head.slice(2)));
  await withHome(async () => {
    assert.equal(await inIsolation(root, [{ kind: "status" }], { deadline: 10_000, max: 1024 * 1024 }), null);
  });
});

test("core.excludesFile set empty reads no global ignore file, as git does", async () => {
  const { root, git } = repo();
  fs.writeFileSync(path.join(root, "u.txt"), "u");
  await withHome(async (home) => {
    fs.mkdirSync(path.join(home, ".config", "git"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "git", "ignore"), "u.txt\n");
    const status = async () =>
      ((await inIsolation(root, [{ kind: "status" }], { deadline: 10_000, max: 1024 * 1024 })) ?? [])[0];
    assert.equal(await status(), "", "the default global ignore file hides u.txt");
    git("config", "core.excludesFile", "");
    assert.equal(await status(), "? u.txt\0");
  });
});

test("names whose control characters JSON writes six times longer still come back within the output limit", async () => {
  const { root } = repo();
  // 400 names of 100 bytes, each control character six bytes once written as JSON: about 40 KB raw, far more as JSON
  for (let i = 0; i < 400; i++)
    fs.writeFileSync(path.join(root, `${String(i).padStart(4, "0")}${"\u0001".repeat(96)}`), "");
  await withHome(async () => {
    const out = await inIsolation(root, [{ kind: "status" }], { deadline: 10_000, max: 64 * 1024 });
    assert.equal(out?.[0]?.split("\0").filter(Boolean).length, 400);
  });
});

test("a git that stalls is killed with the worker at the deadline, and nothing of the call is left running", async () => {
  // A git first on PATH that never answers status, under a name ps can find
  const bin = fs.realpathSync(tempDir("git-worker-stall-"));
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const marker = `sphica-stall-${process.pid}`;
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh\ncase " $* " in *" status "*) exec ${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 30000)" ${marker};; esac\nexec ${JSON.stringify(real)} "$@"\n`,
    { mode: 0o755 },
  );
  const { root } = repo();
  const saved = process.env.PATH;
  await withHome(async () => {
    process.env.PATH = `${bin}${path.delimiter}${saved ?? ""}`;
    try {
      const started = Date.now();
      assert.equal(
        await inIsolation(root, [{ kind: "status" }], { deadline: 1_500, max: 1024 * 1024 }),
        null,
      );
      assert.ok(Date.now() - started < 3_000);
    } finally {
      process.env.PATH = saved;
    }
    await new Promise((r) => setTimeout(r, 1_000));
    const left = execFileSync("ps", ["-A", "-o", "args="], { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.includes(marker));
    assert.deepEqual(left, []);
  });
});
