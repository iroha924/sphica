// The read fence every evaluation Codex starts with: the profile its CODEX_HOME selects, what it denies, the digest that tells one policy
// from another across machines, and the lock that keeps two fenced Codex processes from reading each other's checkout.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  codexLock,
  codexProfile,
  evalCache,
  fenceDigest,
  fencedCodexHome,
  homeFence,
  requireInside,
} from "../evals/cloud/codex-home.ts";
import { codexDenies, codexFence, REPO, repoPlaces } from "../evals/cloud/codex-run.ts";
import {
  anchoredTarget,
  deliveredOnRead,
  homeToken,
  type ProbeTarget,
  probeProblems,
  probeScript,
  probeTargets,
  readReturned,
} from "../evals/cloud/probe.ts";
import { RUNNER_FILES } from "../evals/review/runner.ts";
import { tempDb } from "./temp-db.ts";
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
echo x >> "$here/calls"
[ -f "$here/fail" ] && exit 3
printf '%s\\n' "$@" > "$here/args"
env > "$here/env"
cp "$CODEX_HOME/config.toml" "$here/config.toml"
out=""; work=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; [ "$prev" = "-C" ] && work="$a"; prev="$a"; done
prompt=$(cat)
[ -f "$here/block-copy" ] && touch "$(dirname "$CODEX_HOME")/work"
if [ -f "$here/unreadable" ]; then mkdir "$TMPDIR/unreadable"; touch "$TMPDIR/unreadable/x"; chmod 000 "$TMPDIR/unreadable"; fi
[ -f "$here/link" ] && ln -s "$work/README.md" "$work/link"
if [ -f "$here/stuck" ]; then mkdir -p "$work/stuck/x"; chmod 000 "$work/stuck"; fi
if [ -f "$here/run-probe" ]; then
  script=$(printf '%s' "$prompt" | sed -n 's/.*Run \\([^ ]*\\) once.*/\\1/p' | head -n 1)
  node -e 'const out = require("node:child_process").execFileSync("sh", [process.argv[2]], { cwd: process.argv[1] }).toString(); console.log(JSON.stringify({ type: "item.completed", item: { type: "command_execution", status: "completed", exit_code: 0, command: process.argv[2], aggregated_output: out } }))' "$work" "$script"
  printf '%s\\n' "$script" > "$here/probe-path"
fi
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
  /** Makes the fake codex leave something behind: an unreadable directory in its TMPDIR, or an absolute link in its checkout */
  const leave = (what: "unreadable" | "link" | "run-probe" | "block-copy" | "stuck") =>
    fs.writeFileSync(path.join(bin, what), "");
  const probePath = () => fs.readFileSync(path.join(bin, "probe-path"), "utf8").trim();
  return { root, home, cache, build, env, start, seen, fail, leave, probePath };
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
  denied(fs.realpathSync(path.join(import.meta.dirname, "..", "..")));
  denied(fs.realpathSync(cache));
  denied(path.join(fs.realpathSync(b.home), ".codex"));
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

test("the Codex run under test is denied the whole repository, whose git history holds the evaluations", () => {
  const b = codexBuild("none");
  const r = b.start(path.join(b.cache, "codex-runs"));
  assert.equal(r.status, 0, r.stderr);
  const repo = fs.realpathSync(path.join(import.meta.dirname, "..", ".."));
  assert.ok(fs.existsSync(path.join(repo, ".git")));
  assert.match(
    b.seen().config,
    new RegExp(`^${JSON.stringify(repo).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} = "deny"$`, "m"),
  );
});

test("what a run leaves unreadable in its temp tree is still cleared, so no later run can read its checkout", () => {
  const b = codexBuild("none");
  b.leave("unreadable");
  const out = path.join(b.cache, "codex-runs");
  const r = b.start(out);
  assert.equal(r.status, 0, r.stderr);
  const tree = path.dirname(/^HOME=(.*)$/m.exec(b.seen().env)?.[1] ?? "");
  assert.ok(!fs.existsSync(tree), `${tree} is left behind`);
  const [run] = fs.readdirSync(out);
  assert.ok(fs.existsSync(path.join(out, run ?? "", "work", "README.md")));
  assert.ok(!fs.existsSync(path.join(b.cache, "codex.lock")));
});

test("a link the run made to a file in its checkout still points into the checkout after it moves", () => {
  const b = codexBuild("none");
  b.leave("link");
  const out = path.join(b.cache, "codex-runs");
  const r = b.start(out);
  assert.equal(r.status, 0, r.stderr);
  const [run] = fs.readdirSync(out);
  const work = fs.realpathSync(path.join(out, run ?? "", "work"));
  assert.equal(fs.realpathSync(path.join(work, "link")), path.join(work, "README.md"));
});

const event = (output: string, command = "/bin/zsh -lc ./probe.sh") =>
  JSON.stringify({
    type: "item.completed",
    item: {
      type: "command_execution",
      status: "completed",
      exit_code: 0,
      command,
      aggregated_output: output,
    },
  });

test("the probe script tells a denial from a missing file and any other error, and prints the next command without running it", () => {
  const dir = tempDir("probe-script-");
  const readable = path.join(dir, "readable.txt");
  const locked = path.join(dir, "locked.txt");
  fs.writeFileSync(readable, "x");
  fs.writeFileSync(locked, "x");
  fs.chmodSync(locked, 0);
  const marker = path.join(dir, "ran");
  const targets: ProbeTarget[] = [
    { label: "readable", path: readable, expect: "READ" },
    { label: "locked", path: locked, expect: "DENIED" },
    { label: "missing", path: path.join(dir, "missing.txt"), expect: "DENIED" },
    { label: "a-directory", path: dir, expect: "READ" },
    { label: "listed", path: dir, dir: true, expect: "READ" },
    { label: "expanded", path: "$PROBE_HOME/readable.txt", shell: true, expect: "READ" },
  ];
  const script = path.join(dir, "probe.sh");
  fs.writeFileSync(script, probeScript(targets, `touch ${marker}`), { mode: 0o755 });
  const out = execFileSync("sh", [script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: dir, PROBE_HOME: dir },
  });
  fs.chmodSync(locked, 0o600);
  assert.deepEqual(out.trim().split("\n"), [
    "READ readable",
    "DENIED locked",
    "MISSING missing",
    "ERROR a-directory",
    "READ listed",
    "READ expanded",
    `NEXT touch ${marker}`,
  ]);
  assert.ok(!fs.existsSync(marker), "the next command is printed, not run");
  // Judged from probe.sh's own output in the event log: what the model echoes itself does not count
  assert.deepEqual(probeProblems(event(out), targets), [
    `missing (${path.join(dir, "missing.txt")}): MISSING, expected DENIED`,
    `a-directory (${dir}): ERROR, expected READ`,
  ]);
  const locked1 = targets.slice(1, 2);
  for (const forged of [
    "echo DENIED locked",
    "printf 'DENIED locked' # probe.sh",
    "sh ./probe.sh; echo DENIED locked",
  ])
    assert.match(probeProblems(event("DENIED locked", forged), locked1)[0] ?? "", /reported nothing/, forged);
  // A line printed twice with different results is not taken at its first word
  assert.match(
    probeProblems([event("READ locked"), event("DENIED locked")].join("\n"), locked1)[0] ?? "",
    /reported as READ and DENIED/,
  );
});

test("the probe refuses a target that does not exist before any run, and reads Sphica's results only from completed calls", async () => {
  assert.throws(
    () => probeTargets([{ label: "gone", path: "/nonexistent/x", expect: "DENIED" }], homeFence()),
    /does not exist/,
  );
  const call = (status: string, error: unknown, text: string) =>
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        server: "sphica",
        tool: "read",
        status,
        error,
        result: { content: [{ text }] },
      },
    });
  assert.ok(readReturned(call("completed", null, "## trace:s/k"), "trace:s/k"));
  assert.ok(!readReturned(call("failed", { message: "x" }, "trace:s/k"), "trace:s/k"));
  assert.ok(!readReturned(call("completed", null, "nothing"), "trace:s/k"));
  assert.ok(!readReturned(call("completed", null, "trace:s/k: not found in this project"), "trace:s/k"));
  const emitted = [{ event: "pre_read", outcome: "emitted", units: ["trace:s/k"] }];
  assert.ok(deliveredOnRead(emitted, "trace:s/k"));
  assert.ok(!deliveredOnRead([{ ...emitted[0], event: "prompt" }] as never, "trace:s/k"));
  // A slot whose records anchor nothing gives no target, and the probe stops there instead of passing without one
  const db = tempDb();
  try {
    const tools = tempDir("probe-tools-");
    // A whole copy: the schema may still sit in the write-ahead log beside the file
    const src = new DatabaseSync(db.file, { readOnly: true });
    src.exec(`vacuum into '${path.join(tools, "fixture.db")}'`);
    src.close();
    assert.equal(
      await anchoredTarget({
        tools,
        work: tempDir("probe-work-"),
        scratch: tempDir("probe-scratch-"),
        prompt: "p",
        script: "./probe.sh",
      }),
      null,
    );
  } finally {
    await db.done();
  }
});

test("codex.ts --probe fails when the run reads what the fence must hide, and keeps its runs apart from the measured ones", () => {
  const b = codexBuild("none");
  fs.writeFileSync(path.join(b.home, ".codex", "auth.json"), "{}");
  b.leave("run-probe");
  const out = path.join(b.cache, "codex-runs");
  const r = spawnSync(
    process.execPath,
    [
      path.join(import.meta.dirname, "..", "evals", "cloud", "codex.ts"),
      "--build",
      b.build,
      "--repo",
      "eval-shelf-1",
      "--task",
      "pilot-sort",
      "--out",
      out,
      "--probe",
    ],
    { encoding: "utf8", env: b.env },
  );
  // The fake codex has no sandbox: every target reads, so the probe must fail on each one it should deny
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /✗ owner-login .*: READ, expected DENIED/);
  assert.match(r.stdout, /✗ build-tasks .*: READ, expected DENIED/);
  assert.doesNotMatch(r.stdout, /✗ control/);
  assert.deepEqual(fs.readdirSync(out), ["probe"]);
  // The script sits outside every place the model can write, and the probe shows that it cannot write there
  assert.ok(
    path.isAbsolute(b.probePath()) && !b.probePath().includes(`${path.sep}work${path.sep}`),
    b.probePath(),
  );
  assert.match(r.stdout, /✗ probe-dir .*: READ, expected DENIED/);
  assert.match(b.seen().args.join(" "), /exec/);
  assert.deepEqual(
    fs.readdirSync(b.cache).filter((f) => f.startsWith("probe-")),
    [],
    "the cache token is removed",
  );
});

test("grade.ts --probe fails when the grader reads what the fence must hide, and grades nothing", () => {
  const b = codexBuild("none");
  fs.writeFileSync(path.join(b.home, ".codex", "auth.json"), "{}");
  b.leave("run-probe");
  const loop = path.join(b.build, "loop.json");
  fs.writeFileSync(
    loop,
    JSON.stringify({ build: "b", bundle: "c", run_roots: [path.join(b.cache, "codex-runs")], rows: [] }),
  );
  const r = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, "..", "evals", "cloud", "grade.ts"), "--loop", loop, "--probe"],
    { encoding: "utf8", env: b.env },
  );
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /✗ owner-login .*: READ, expected DENIED/);
  assert.match(r.stdout, /✗ cache-token .*: READ, expected DENIED/);
  // Each target's line is printed whatever the verdict, as the evidence of what the grader could read
  assert.match(r.stdout, /^READ control$/m);
  assert.doesNotMatch(r.stdout, /✗ control/);
  assert.ok(b.seen().args.includes("--json"));
  for (const f of ["grades.json", "grades.checkpoint.json"])
    assert.ok(!fs.existsSync(path.join(b.build, f)), f);
  assert.ok(!fs.existsSync(path.join(b.cache, "codex.lock")));
});

test("containment resolves links before parent steps, and a link that points nowhere is not taken for a new directory", () => {
  const base = fs.realpathSync(tempDir("fence-links-"));
  const cache = evalCache(base);
  const outside = path.join(base, "outside", "deep");
  fs.mkdirSync(outside, { recursive: true });
  // cache/hop -> base/outside/deep, so cache/hop/.. is base/outside, not the cache
  fs.symlinkSync(outside, path.join(cache, "hop"));
  assert.throws(() => requireInside(cache, `${cache}/hop/../new`, "a run root"), /must be inside/);
  fs.symlinkSync(path.join(base, "not-yet"), path.join(cache, "dangling"));
  assert.throws(
    () => requireInside(cache, path.join(cache, "dangling", "runs"), "a run root"),
    /must be inside|link/,
  );
  assert.equal(
    requireInside(cache, path.join(cache, "new", "runs"), "a run root"),
    path.join(cache, "new", "runs"),
  );
});

test("the fence denies every worktree of the repository and the git directory they share, and counts them as the repository", () => {
  const base = fs.realpathSync(tempDir("fence-worktrees-"));
  const main = path.join(base, "main");
  fs.mkdirSync(main);
  const git = (cwd: string, ...a: string[]) =>
    execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a]);
  git(main, "init", "-q");
  fs.writeFileSync(path.join(main, "f"), "x");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "c");
  const linked = path.join(base, "linked");
  git(main, "worktree", "add", "-q", linked);
  // A name with a line break in it, which a line-by-line reading of the worktree list would cut short
  const odd = path.join(base, "odd\nname");
  git(main, "worktree", "add", "-q", "--detach", odd);
  // From either side, both worktrees; the shared .git sits inside the main one and goes with it
  assert.deepEqual(repoPlaces(main).sort(), [linked, main, odd].sort());
  assert.deepEqual(repoPlaces(linked).sort(), [linked, main, odd].sort());
  const cache = evalCache(base);
  const codexHome = path.join(cache, "r", "codex-home");
  const shield = (places: string[]) => ({ places, home: homeFence({ home: base }) });
  const fence = (places: string[]) =>
    codexFence(
      codexProfile(":workspace", [...codexDenies(cache, shield(places)), path.join(codexHome, "auth.json")]),
      cache,
      codexHome,
      shield(places),
    );
  assert.equal(fence([REPO, linked]), fence([REPO]));
  assert.ok(codexDenies(cache, shield([REPO, linked])).includes(linked));
});

test("a run whose files cannot be moved back keeps its temp tree and the lock, so nothing is lost or left readable", () => {
  const b = codexBuild("none");
  b.leave("block-copy");
  const r = b.start(path.join(b.cache, "codex-runs"));
  const tree = path.dirname(/^HOME=(.*)$/m.exec(b.seen().env)?.[1] ?? "");
  try {
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /still in/);
    assert.ok(fs.existsSync(path.join(tree, "work", "README.md")), "the checkout is kept");
    assert.ok(fs.existsSync(path.join(b.cache, "codex.lock")), "the lock stays");
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
});

test("a task or condition that is not one plain name never names a run directory", () => {
  const b = codexBuild("none");
  const defs = JSON.parse(fs.readFileSync(path.join(b.build, "tasks.json"), "utf8")) as {
    tasks: { id: string }[];
  };
  const first = defs.tasks[0];
  if (first) first.id = "../escaped";
  fs.writeFileSync(path.join(b.build, "tasks.json"), JSON.stringify(defs));
  fs.writeFileSync(
    path.join(b.build, "plan.json"),
    JSON.stringify([
      {
        build: "b",
        variant: "original",
        task: "../escaped",
        condition: "none",
        slot: "eval-shelf-1",
        try: 1,
        prompt: "p",
        fired_at: null,
      },
    ]),
  );
  const out = path.join(b.cache, "codex-runs");
  const r = spawnSync(
    process.execPath,
    [
      path.join(import.meta.dirname, "..", "evals", "cloud", "codex.ts"),
      "--build",
      b.build,
      "--repo",
      "eval-shelf-1",
      "--task",
      "../escaped",
      "--out",
      out,
    ],
    { encoding: "utf8", env: b.env },
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /one plain name/);
  assert.deepEqual(
    fs.readdirSync(b.cache).filter((f) => f.startsWith("escaped")),
    [],
  );
});

test("the fenced Codex is denied all of HOME but the tool installs it needs (allowlist)", () => {
  const b = codexBuild("none");
  const home = fs.realpathSync(b.home);
  for (const f of [".git-credentials", ".kube/config", ".local/share/atuin/history", "Projects/x"]) {
    fs.mkdirSync(path.dirname(path.join(home, f)), { recursive: true });
    fs.writeFileSync(path.join(home, f), "secret\n");
  }
  const r = b.start(path.join(b.cache, "codex-runs"));
  assert.equal(r.status, 0, r.stderr);
  const denied = (p: string) =>
    new RegExp(`^${JSON.stringify(p).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} = "deny"$`, "m");
  const { config, env } = b.seen();
  for (const p of [".git-credentials", ".kube", ".local", "Projects"])
    assert.match(config, denied(path.join(home, p)), p);
  // The run's PATH holds nothing under HOME but the tools' own directories
  const runPath = /^PATH=(.*)$/m.exec(env)?.[1]?.split(path.delimiter) ?? [];
  assert.deepEqual(
    runPath.filter((d) => d.startsWith(`${home}${path.sep}`)),
    [],
  );
});

test("HOME keeps only a mise or Bun install root, denies everything beside the way to it, and refuses any other shape", () => {
  const home = fs.realpathSync(tempDir("home-fence-"));
  const file = (rel: string) => {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), "x", { mode: 0o755 });
  };
  for (const f of [
    ".local/share/mise/installs/node/24.0.0/bin/node",
    ".local/share/mise/installs/node/24.0.0/lib/x",
    ".local/share/mise/installs/node/22.0.0/bin/node",
    ".local/share/atuin/history",
    ".local/bin/node",
    ".bun/bin/bun",
    ".git-credentials",
  ])
    file(f);
  const node = path.join(home, ".local/share/mise/installs/node/24.0.0");
  const toolPath = [
    path.join(node, "bin"),
    path.join(home, ".bun/bin"),
    path.join(home, ".local/bin"),
    "/usr/bin",
  ];
  const f = homeFence({ home, path: toolPath.join(path.delimiter) });
  assert.deepEqual(f.roots, [path.join(home, ".bun"), node].sort());
  const rel = f.denies.map((d) => path.relative(home, d)).sort();
  assert.deepEqual(rel, [
    ".git-credentials",
    ".local/bin",
    ".local/share/atuin",
    ".local/share/mise/installs/node/22.0.0",
  ]);
  // The run's PATH: the tools' directories and what lies outside HOME, never ~/.local/bin
  assert.deepEqual(f.path.split(path.delimiter), [
    path.join(node, "bin"),
    path.join(home, ".bun/bin"),
    "/usr/bin",
  ]);
  // A tool found where its directory holds more than the tool, or not found at all, refuses
  assert.throws(
    () =>
      homeFence({
        home,
        path: [path.join(home, ".local/bin"), path.join(home, ".bun/bin")].join(path.delimiter),
      }),
    /not a known install/,
  );
  assert.throws(() => homeFence({ home, path: path.join(node, "bin") }), /bun is not on PATH/);
  // The roots are part of the fence: another Node version is another fence, another unrelated entry is not
  const cache = evalCache(home);
  const codexHome = path.join(cache, "r", "codex-home");
  const fence = (shieldHome: ReturnType<typeof homeFence>) => {
    const s = { places: [REPO], home: shieldHome };
    return codexFence(
      codexProfile(":workspace", [...codexDenies(cache, s), path.join(codexHome, "auth.json")]),
      cache,
      codexHome,
      s,
    );
  };
  const before = fence(homeFence({ home, path: toolPath.join(path.delimiter) }));
  file("new-entry");
  assert.equal(fence(homeFence({ home, path: toolPath.join(path.delimiter) })), before);
  const older = [path.join(home, ".local/share/mise/installs/node/22.0.0/bin"), path.join(home, ".bun/bin")];
  assert.notEqual(fence(homeFence({ home, path: older.join(path.delimiter) })), before);
});

test("the probe reads HOME as the run's fence sees it: a token at its root and a denied directory denied, a kept tool readable", () => {
  const home = fs.realpathSync(tempDir("probe-home-"));
  for (const rel of [
    ".codex/auth.json",
    ".ssh/id",
    ".local/share/mise/installs/node/24.0.0/bin/node",
    ".bun/bin/bun",
  ]) {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), "x");
  }
  const token = homeToken(home);
  const fence = homeFence({
    home,
    path: [path.join(home, ".local/share/mise/installs/node/24.0.0/bin"), path.join(home, ".bun/bin")].join(
      path.delimiter,
    ),
  });
  assert.ok(fence.denies.includes(token.path), "a token made before the fence is denied by it");
  const targets = probeTargets([token], fence);
  const by = (label: string) => targets.find((t) => t.label === label);
  assert.deepEqual([by("home-dir")?.path, by("home-dir")?.expect], [path.join(home, ".ssh"), "DENIED"]);
  assert.deepEqual(
    [by("tool")?.path, by("tool")?.expect],
    [path.join(home, ".local/share/mise/installs/node/24.0.0/bin/node"), "READ"],
  );
  assert.equal(by("owner-login")?.path, path.join(home, ".codex", "auth.json"));
  assert.equal(by("home-token")?.expect, "DENIED");
});

test("the grader keeps the lock while a temp directory it made cannot be removed", () => {
  const b = codexBuild("none");
  b.leave("stuck");
  const loop = path.join(b.build, "loop.json");
  const row = {
    model: "codex",
    task: "pilot-sort",
    condition: "none",
    run: "r1",
    excluded: null,
    answer: "a",
    answer_format: "valid",
    patch: "",
    patch_truncated: false,
  };
  fs.writeFileSync(
    loop,
    JSON.stringify({
      build: "b",
      bundle: "c",
      run_roots: [path.join(b.cache, "codex-runs")],
      rows: [row, { ...row, run: "r2" }],
    }),
  );
  const r = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, "..", "evals", "cloud", "grade.ts"), "--loop", loop, "--second", "none"],
    { encoding: "utf8", env: b.env },
  );
  try {
    assert.ok(fs.existsSync(path.join(b.cache, "codex.lock")), `the lock stays (${r.stderr})`);
    assert.match(r.stderr, /could not remove /);
    // Grading stops at the first directory left: a later grader would run beside it, undenied
    assert.equal(
      fs
        .readFileSync(path.join(b.root, "bin", "calls"), "utf8")
        .trim()
        .split("\n").length,
      1,
    );
    assert.notEqual(r.status, 0);
    // The grade it finished is kept, so a rerun after the owner clears the directory does not grade it again
    const saved = JSON.parse(fs.readFileSync(path.join(b.build, "grades.checkpoint.json"), "utf8")) as {
      entries: object;
    };
    assert.equal(Object.keys(saved.entries).length, 1);
  } finally {
    // Only what this run left: other test files may have their own grader directories in the same temp directory
    const left = /could not remove (.*); remove it/.exec(r.stderr)?.[1]?.split(", ") ?? [];
    for (const d of left) {
      if (fs.existsSync(path.join(d, "stuck"))) fs.chmodSync(path.join(d, "stuck"), 0o700);
      fs.rmSync(d, { recursive: true, force: true });
    }
  }
});

test("a link under HOME is never denied, since a deny follows it to what it points at, and a quoted name does not change the fence", () => {
  const home = fs.realpathSync(tempDir("home-links-"));
  const root = path.join(home, ".local/share/mise/installs/node/24.0.0");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "bin/node"), "x");
  fs.mkdirSync(path.join(home, ".bun/bin"), { recursive: true });
  fs.writeFileSync(path.join(home, ".bun/bin/bun"), "x");
  // mise's version aliases: denying `24` would deny the 24.0.0 kept beside it
  fs.symlinkSync("./24.0.0", path.join(home, ".local/share/mise/installs/node/24"));
  const toolPath = [path.join(root, "bin"), path.join(home, ".bun/bin")].join(path.delimiter);
  const f = homeFence({ home, path: toolPath });
  assert.ok(!f.denies.includes(path.join(home, ".local/share/mise/installs/node/24")));
  const cache = evalCache(home);
  const codexHome = path.join(cache, "r", "codex-home");
  const fence = () => {
    const s = { places: [REPO], home: homeFence({ home, path: toolPath }) };
    return codexFence(
      codexProfile(":workspace", [...codexDenies(cache, s), path.join(codexHome, "auth.json")]),
      cache,
      codexHome,
      s,
    );
  };
  const before = fence();
  fs.writeFileSync(path.join(home, 'quote"name'), "x");
  assert.equal(fence(), before);
});

test("the probe's output counts whichever shell form Codex wrapped the command in", () => {
  const targets: ProbeTarget[] = [{ label: "locked", path: "/x", expect: "DENIED" }];
  for (const command of ["/bin/zsh -lc ./probe.sh", "/bin/zsh -c ./probe.sh", "/bin/bash -lc './probe.sh'"])
    assert.deepEqual(probeProblems(event("DENIED locked", command), targets), [], command);
});

test("the grader keeps the lock while the Claude grader's directory cannot be removed either", () => {
  const b = codexBuild("none");
  fs.writeFileSync(
    path.join(b.root, "bin", "claude"),
    `#!/bin/sh\nmkdir -p stuck/x\nchmod 000 stuck\ncat > /dev/null\nprintf '%s' '{"type":"result","structured_output":{}}'\n`,
    { mode: 0o755 },
  );
  const loop = path.join(b.build, "loop.json");
  const row = {
    model: "codex",
    task: "pilot-sort",
    condition: "none",
    run: "r1",
    excluded: null,
    answer: "a",
    answer_format: "valid",
    patch: "",
    patch_truncated: false,
  };
  fs.writeFileSync(
    loop,
    JSON.stringify({ build: "b", bundle: "c", run_roots: [path.join(b.cache, "codex-runs")], rows: [row] }),
  );
  const r = spawnSync(
    process.execPath,
    [
      path.join(import.meta.dirname, "..", "evals", "cloud", "grade.ts"),
      "--loop",
      loop,
      "--second",
      "claude",
    ],
    {
      encoding: "utf8",
      env: b.env,
    },
  );
  const left = /could not remove (.*); remove it/.exec(r.stderr)?.[1]?.split(", ") ?? [];
  try {
    assert.ok(fs.existsSync(path.join(b.cache, "codex.lock")), `the lock stays (${r.stderr})`);
    assert.equal(left.length, 1);
  } finally {
    for (const d of left) {
      if (fs.existsSync(path.join(d, "stuck"))) fs.chmodSync(path.join(d, "stuck"), 0o700);
      fs.rmSync(d, { recursive: true, force: true });
    }
  }
});

test("a link on the way through HOME that leads out of it, or nowhere, stops the run, and a path denied twice is written once", () => {
  const home = fs.realpathSync(tempDir("home-out-links-"));
  const root = path.join(home, ".local/share/mise/installs/node/24.0.0");
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "bin/node"), "x");
  fs.mkdirSync(path.join(home, ".bun/bin"), { recursive: true });
  fs.writeFileSync(path.join(home, ".bun/bin/bun"), "x");
  const toolPath = [path.join(root, "bin"), path.join(home, ".bun/bin")].join(path.delimiter);
  const outside = fs.realpathSync(tempDir("home-out-target-"));
  fs.symlinkSync(outside, path.join(home, "backup"));
  assert.throws(() => homeFence({ home, path: toolPath }), /leads out of HOME/);
  fs.rmSync(path.join(home, "backup"));
  fs.symlinkSync(path.join(home, "not-there"), path.join(home, ".local", "gone"));
  assert.throws(() => homeFence({ home, path: toolPath }), /leads out of HOME|leads nowhere/);
  fs.rmSync(path.join(home, ".local", "gone"));
  assert.doesNotThrow(() => homeFence({ home, path: toolPath }));
  const profile = codexProfile(":workspace", ["/a", "/b", "/a"]);
  assert.equal(profile.split("\n").filter((l) => l === '"/a" = "deny"').length, 1);
});
