// The read fence every evaluation Codex starts with: the profile its CODEX_HOME selects, what it denies, the digest that tells one policy
// from another across machines, and the lock that keeps two fenced Codex processes from reading each other's checkout.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  codexLock,
  codexProfile,
  evalCache,
  fenceDigest,
  fencedCodexHome,
  requireInside,
} from "../evals/cloud/codex-home.ts";
import { RUNNER_FILES } from "../evals/review/runner.ts";
import { tempDir } from "./temp-dir.ts";

test("a fenced CODEX_HOME selects the profile before any table, denies its own login, and keeps the given settings", () => {
  const home = path.join(tempDir("codex-fence-"), "codex-home");
  const { denied } = fencedCodexHome(home, {
    base: ":workspace",
    deny: ["/evals", "/cache"],
    extraConfig: '\n[mcp_servers.sphica]\ncommand = "node"\n',
    settings: 'model = "m"',
    managed: [],
  });
  const config = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  assert.deepEqual(denied, ["/evals", "/cache", path.join(home, "auth.json")]);
  assert.ok(config.startsWith('model = "m"\n'), "the settings snapshot is written as given");
  assert.match(config, /^default_permissions = "eval"$/m);
  assert.ok(config.indexOf("default_permissions") < config.indexOf("[permissions.eval]"));
  assert.ok(config.indexOf("[permissions.eval]") < config.indexOf("[mcp_servers.sphica]"));
  assert.match(config, new RegExp(`^${JSON.stringify(path.join(home, "auth.json"))} = "deny"$`, "m"));
  assert.match(config, /^extends = ":workspace"$/m);
  assert.throws(
    () =>
      fencedCodexHome(path.join(tempDir("codex-fence-"), "h"), {
        base: ":read-only",
        deny: [],
        settings: "",
        managed: ["/etc/codex/config.toml"],
      }),
    /administrator settings/,
  );
});

test("the fence digest names places by role, so the same policy elsewhere compares equal and another policy does not", () => {
  const profile = (home: string, cache: string) =>
    fencedCodexHome(path.join(home, "codex-home"), {
      base: ":workspace",
      deny: [cache, `${home}/.ssh`],
      settings: "",
      managed: [],
    }).profile;
  const a = tempDir("fence-a-");
  const b = tempDir("fence-b-");
  const roles = (home: string) => ({
    "<codex-home>": path.join(home, "codex-home"),
    "<cache>": `${home}/cache`,
    "<home>": home,
  });
  const da = fenceDigest(profile(a, `${a}/cache`), roles(a));
  assert.equal(da, fenceDigest(profile(b, `${b}/cache`), roles(b)));
  const c = tempDir("fence-c-");
  const readOnly = fencedCodexHome(path.join(c, "codex-home"), {
    base: ":read-only",
    deny: [`${c}/cache`, `${c}/.ssh`],
    settings: "",
    managed: [],
  }).profile;
  assert.notEqual(da, fenceDigest(readOnly, roles(c)));
});

test("only one fenced Codex evaluation runs at a time, and outputs must sit inside the denied cache", () => {
  const home = tempDir("fence-lock-");
  const cache = evalCache(home);
  const release = codexLock(cache);
  assert.throws(() => codexLock(cache), /another fenced Codex evaluation holds .*"pid":/);
  release();
  codexLock(cache)();
  const inside = path.join(cache, "codex-runs");
  fs.mkdirSync(inside);
  assert.equal(requireInside(cache, inside, "--out"), inside);
  assert.throws(() => requireInside(cache, home, "--out"), /must be inside/);
  assert.throws(() => requireInside(cache, cache, "--out"), /must be inside/);
  // A sibling that shares the cache's name as a prefix is outside it
  fs.mkdirSync(`${cache}-other`);
  assert.throws(() => requireInside(cache, `${cache}-other`, "--out"), /must be inside/);
  const link = path.join(cache, "link-out");
  fs.symlinkSync(home, link);
  assert.throws(() => requireInside(cache, link, "--out"), /must be inside/);
});

test("review's runner identity covers the shared fence", () => {
  assert.ok(RUNNER_FILES.includes("../cloud/codex-home.ts"));
});

/** A fake `codex` that records its arguments, environment, and config, and answers like `codex exec -o` */
const FAKE_CODEX = `#!/bin/sh
here=$(cd "$(dirname "$0")" && pwd)
[ -f "$here/fail" ] && exit 3
printf '%s\\n' "$@" > "$here/args"
env > "$here/env"
cp "$CODEX_HOME/config.toml" "$here/config.toml"
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
cat > /dev/null
printf '{}' > "$out"
echo '{"type":"thread.started"}'
`;

/** A build with one slot of the given condition, a HOME with the owner's Codex settings, and a fake codex first on PATH */
function codexBuild(condition: string) {
  const root = tempDir("eval-codex-run-");
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "m"\nmodel_reasoning_effort = "low"\n');
  const cache = path.join(home, ".cache", "sphica-eval");
  const build = path.join(cache, "builds", "b");
  const slot = path.join(build, "eval-shelf-1");
  fs.mkdirSync(path.join(slot, ".tools"), { recursive: true });
  fs.writeFileSync(path.join(slot, ".tools", "hook.sh"), "");
  fs.writeFileSync(path.join(slot, "README.md"), "slot\n");
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", slot, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a]);
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "slot");
  fs.copyFileSync(
    path.join(import.meta.dirname, "..", "evals", "cloud", "tasks.json"),
    path.join(build, "tasks.json"),
  );
  fs.writeFileSync(
    path.join(build, "manifest.json"),
    JSON.stringify({
      build: "b",
      owner: "o",
      matchers: { codex: "^Bash$" },
      repositories: { "eval-shelf-1": { condition } },
    }),
  );
  fs.writeFileSync(
    path.join(build, "plan.json"),
    JSON.stringify([
      {
        build: "b",
        variant: "original",
        task: "pilot-sort",
        condition,
        slot: "eval-shelf-1",
        try: 1,
        prompt: "p",
        fired_at: null,
      },
    ]),
  );
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "codex"), FAKE_CODEX, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  delete env.SPHICA_DB;
  delete env.SPHICA_HOME;
  delete env.CODEX_HOME;
  const start = (out: string) =>
    spawnSync(
      process.execPath,
      [
        path.join(import.meta.dirname, "..", "evals", "cloud", "codex.ts"),
        "--build",
        build,
        "--repo",
        "eval-shelf-1",
        "--task",
        "pilot-sort",
        "--out",
        out,
      ],
      { encoding: "utf8", env },
    );
  const seen = () => ({
    args: fs.readFileSync(path.join(bin, "args"), "utf8").trimEnd().split("\n"),
    env: fs.readFileSync(path.join(bin, "env"), "utf8"),
    config: fs.readFileSync(path.join(bin, "config.toml"), "utf8"),
  });
  const fail = () => fs.writeFileSync(path.join(bin, "fail"), "");
  return { root, home, cache, build, start, seen, fail };
}

test("codex.ts replays a task with codex exec in the run's own homes and records the run", () => {
  const b = codexBuild("none");
  const out = path.join(b.cache, "codex-runs");
  const r = b.start(out);
  assert.equal(r.status, 0, r.stderr);
  const [run] = fs.readdirSync(out);
  const dir = path.join(out, run ?? "");
  const result = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
  assert.equal(result.status, 0);
  assert.equal(result.codex_model, "m, low");
  for (const f of ["started.json", "answer.json", "events.jsonl", "patch.diff"])
    assert.ok(fs.existsSync(path.join(dir, f)), f);
  const seen = b.seen();
  assert.equal(seen.args[0], "exec");
  assert.ok(seen.args.includes("--ignore-rules"));
  assert.match(seen.config, /^model = "m"$/m);
});

test("the Codex run under test reads through a read fence and keeps its files where collect looks", () => {
  const b = codexBuild("none");
  const cache = fs.realpathSync(b.cache);
  // Outputs outside the cache would sit where the fence does not reach
  const outside = b.start(path.join(b.root, "runs"));
  assert.notEqual(outside.status, 0);
  assert.match(outside.stderr, /must be inside/);
  const out = path.join(cache, "codex-runs");
  const r = b.start(out);
  assert.equal(r.status, 0, r.stderr);
  const [run] = fs.readdirSync(out);
  const dir = path.join(out, run ?? "");
  const seen = b.seen();
  assert.ok(!seen.args.includes("-s") && !seen.args.includes("--sandbox"), "the profile is the sandbox");
  assert.match(seen.config, /^default_permissions = "eval"$/m);
  assert.match(seen.config, /^extends = ":workspace"$/m);
  const denied = (p: string) =>
    assert.match(
      seen.config,
      new RegExp(`^${JSON.stringify(p).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} = "deny"$`, "m"),
      p,
    );
  denied(fs.realpathSync(path.join(import.meta.dirname, "..", "evals")));
  denied(fs.realpathSync(cache));
  denied(path.join(b.home, ".codex"));
  denied(path.join(b.home, ".ssh"));
  denied(path.join(dir, "codex-home", "auth.json"));
  // The run's checkout, homes, and temp directory sit outside everything denied, and come back into the run directory afterwards
  const env = seen.env;
  const home = /^HOME=(.*)$/m.exec(env)?.[1] ?? "";
  assert.ok(!home.startsWith(fs.realpathSync(cache)), home);
  assert.ok(!fs.existsSync(path.dirname(home)), "the temp tree is removed");
  assert.match(env, new RegExp(`^EVAL_SPHICA_DB=${path.join(dir, "db", "sphica.db")}$`, "m"));
  for (const d of ["work", "home", "tmp"]) assert.ok(fs.existsSync(path.join(dir, d)), d);
  assert.ok(fs.existsSync(path.join(dir, "work", "README.md")));
  const result = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
  assert.match(result.fence, /^[0-9a-f]{64}$/);
  assert.ok(result.fence_roots.includes(fs.realpathSync(cache)));
  assert.ok(!fs.existsSync(path.join(cache, "codex.lock")), "the lock is released");
});

test("a Codex run that fails still comes back into its run directory and releases the lock", () => {
  const b = codexBuild("none");
  b.fail();
  const out = path.join(b.cache, "codex-runs");
  const r = b.start(out);
  assert.equal(r.status, 0, r.stderr);
  const [run] = fs.readdirSync(out);
  const dir = path.join(out, run ?? "");
  const result = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
  assert.equal(result.status, 3);
  assert.match(result.reason, /codex exited 3/);
  assert.ok(fs.existsSync(path.join(dir, "work", "README.md")));
  assert.ok(!fs.existsSync(path.join(b.cache, "codex.lock")));
});

test("a released lock stays released: calling release again never removes the next holder's lock", () => {
  const cache = evalCache(tempDir("fence-relock-"));
  const first = codexLock(cache);
  first();
  const second = codexLock(cache);
  first();
  assert.throws(() => codexLock(cache), /another fenced Codex evaluation/);
  second();
});

test("containment and the fence digest hold for names starting with dots and for Windows paths", () => {
  const win = (user: string) => {
    const home = `C:\\Users\\${user}`;
    const codexHome = `${home}\\.cache\\sphica-eval\\run\\codex-home`;
    const profile = codexProfile(":workspace", [
      `${home}\\.cache\\sphica-eval`,
      `${home}\\.ssh`,
      `${codexHome}\\auth.json`,
    ]);
    return fenceDigest(profile, {
      "<codex-home>": codexHome,
      "<cache>": `${home}\\.cache\\sphica-eval`,
      "<home>": home,
    });
  };
  assert.equal(win("a"), win("b"));
  const cache = evalCache(tempDir("fence-dots-"));
  const dotted = path.join(cache, "..build");
  fs.mkdirSync(dotted);
  assert.equal(requireInside(cache, dotted, "--build"), dotted);
});
