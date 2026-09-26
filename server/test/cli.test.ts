import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

/** Runs without a database or credentials. Only argument parsing and checks before connecting matter here. */
function run(...args: string[]): { code: number; out: string } {
  return runIn("/nonexistent", ...args);
}
function runIn(home: string, ...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home },
      // Keep a hanging regression from stalling the test run (--test-timeout does not apply to sync calls).
      timeout: 30_000,
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string; code?: string };
    // A timeout fails even after the expected output (so the exit code comparison cannot hide a hang).
    if (err.code === "ETIMEDOUT") throw new Error(`sphica ${args.join(" ")} did not finish in 30 seconds`);
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

// A parser that skips unknown arguments would run the command as if the misspelled flag were not there.
test("unknown flags and commands fail before connecting to the database", () => {
  for (const bad of ["--avod", "--limitt", "--all-scopes"]) {
    const r = run("project", "list", bad);
    assert.notEqual(r.code, 0);
    assert.match(r.out, new RegExp(`Unknown flag: ${bad}`), `${bad}: ${r.out}`);
    assert.doesNotMatch(r.out, /No database at/, "tried to connect to the database");
  }
  // Removed commands (the terminal screen, and search, which MCP recall covers) fail like any unknown one
  for (const name of ["dashboard", "search"]) {
    const gone = run(name);
    assert.notEqual(gone.code, 0);
    assert.match(gone.out, new RegExp(`Unknown command: ${name}`), gone.out);
  }
  const r = run("frobnicate");
  assert.notEqual(r.code, 0);
  assert.match(r.out, /Unknown command: frobnicate/);
  assert.doesNotMatch(r.out, /No database at/, "tried to connect to the database");
});

// A flag table shared by all commands silently accepts flags a command ignores.
// The results then come back without the intended filter, and the user cannot tell.
test("flags the command does not take and extra positional arguments fail by name", () => {
  for (const [args, want] of [
    [["doctor", "--yes"], /Unknown flag: --yes/],
    [["project", "list", "--reset-docs"], /Unknown flag: --reset-docs/],
    [["capture", "flush", "--avoid"], /Unknown flag: --avoid/],
    [["project", "list", "garbage"], /Extra argument: garbage/],
  ] as const) {
    const r = run(...args);
    assert.notEqual(r.code, 0, `sphica ${args.join(" ")}: ${r.out}`);
    assert.match(r.out, want, r.out);
    assert.doesNotMatch(r.out, /No database at/, `sphica ${args.join(" ")} tried to connect to the database`);
  }
});

// If typed arguments went into the error title, a newline in an argument could forge a marked line.
test("the error title uses only the command path the dispatcher chose", () => {
  assert.match(run("project", "forget").out, /^sphica project forget$/m);
  assert.match(
    run("project", "forget", "--limit", "0", "f").out,
    /^sphica project forget$/m,
    "shows the subcommand even when parsing fails",
  );
  const flagValue = run("project", "--cwd", "/nonexistent", "list");
  assert.match(flagValue.out, /^sphica$/m, flagValue.out);
  assert.doesNotMatch(flagValue.out, /^sphica.*nonexistent/m, "flag values never go into the title");
  // Closing and status lines start at the line start. Content is indented, so an injected newline cannot forge one
  for (const forged of [run("x\n✓ 直すものは無い"), run("x\n╰─ ✓ 直すものは無い")]) {
    assert.doesNotMatch(forged.out, /^(?:╰─ )?✓ 直すものは無い$/m, forged.out);
    assert.match(forged.out, /^✗ Stopped$/m, forged.out);
  }
});

test("no arguments and --help print usage for that level and succeed", () => {
  for (const args of [[], ["--help"], ["project", "--help"], ["db", "--help"]]) {
    const r = run(...args);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.out}`);
    assert.match(r.out, /Usage:/, `${args.join(" ")}: ${r.out}`);
  }
  // Usage is built from the declarations. Check that command names show up there so no hand-copied text drifts.
  assert.match(run("--help").out, /^ {2}init {2}/m);
  assert.match(run("db", "--help").out, /^ {2}migrate {2}/m);
  assert.match(run("project", "--help").out, /^ {2}forget {2}/m);
});

// Usage lists only what people type. Commands for agents, hooks, and maintenance still run, and -H lists them
test("usage lists only init and doctor, and -H shows the rest", () => {
  const commands = (out: string) =>
    [...(out.split("Commands:")[1] ?? "").matchAll(/^ {2}(\S+) {2}/gm)].map((m) => m[1]);
  assert.deepEqual(commands(run("--help").out).sort(), ["doctor", "init"]);
  const all = commands(run("-H").out);
  for (const name of ["project", "db", "capture", "trace", "harvest"]) assert.ok(all.includes(name), name);
  // Removed without aliases: the people directory and the edit-hook statistics
  for (const name of ["who", "advice"]) assert.match(run(name).out, new RegExp(`Unknown command: ${name}`));
  const db = run("db", "--help").out;
  for (const name of ["reindex", "terms"]) assert.doesNotMatch(db, new RegExp(`^ {2}${name} {2}`, "m"), name);
  assert.match(db, /^ {2}migrate {2}/m);
  // init registers the project now, so the old command is gone without an alias
  const add = run("project", "add");
  assert.notEqual(add.code, 0);
  assert.match(add.out, /Unknown command: add/, add.out);
});
