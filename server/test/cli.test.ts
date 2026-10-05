import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { SAMPLES, splitLine } from "../src/split-check.ts";
import { fakeCodex } from "./fake-codex.ts";
import { fakeGhPath } from "./fake-gh.ts";

const signedOut = fakeGhPath();
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
      env: { PATH: signedOut, HOME: home, USERPROFILE: home },
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
  for (const bad of ["--avod", "--limitt"]) {
    const r = run("doctor", bad);
    assert.notEqual(r.code, 0);
    assert.match(r.out, new RegExp(`Unknown flag: ${bad}`), `${bad}: ${r.out}`);
    assert.doesNotMatch(r.out, /No database at/, "tried to connect to the database");
  }
  // The CLI is init, doctor, and uninstall; everything else runs inside Claude Code and Codex, so these fail like any unknown command
  for (const name of [
    "dashboard",
    "search",
    "trace",
    "harvest",
    "glean",
    "capture",
    "project",
    "db",
    "who",
    "advice",
    "frobnicate",
  ]) {
    const gone = run(name);
    assert.notEqual(gone.code, 0);
    assert.match(gone.out, new RegExp(`Unknown command: ${name}`), gone.out);
    assert.doesNotMatch(gone.out, /No database at/, "tried to connect to the database");
  }
});

// A flag table shared by all commands silently accepts flags a command ignores.
test("flags the command does not take and extra positional arguments fail by name", () => {
  for (const [args, want] of [
    [["doctor", "--yes"], /Unknown flag: --yes/],
    [["uninstall", "--reindex"], /Unknown flag: --reindex/],
    [["doctor", "garbage"], /Extra argument: garbage/],
  ] as const) {
    const r = run(...args);
    assert.notEqual(r.code, 0, `sphica ${args.join(" ")}: ${r.out}`);
    assert.match(r.out, want, r.out);
    assert.doesNotMatch(r.out, /No database at/, `sphica ${args.join(" ")} tried to connect to the database`);
  }
});

// If typed arguments went into the error title, a newline in an argument could forge a marked line.
test("the error title uses only the command path the dispatcher chose", () => {
  assert.match(
    run("doctor", "--nope").out,
    /^sphica doctor$/m,
    "shows the subcommand even when parsing fails",
  );
  const flagValue = run("--cwd", "/nonexistent", "init");
  assert.match(flagValue.out, /^sphica$/m, flagValue.out);
  assert.doesNotMatch(flagValue.out, /^sphica.*nonexistent/m, "flag values never go into the title");
  // Closing and status lines start at the line start. Content is indented, so an injected newline cannot forge one
  for (const forged of [run("x\n✓ 直すものは無い"), run("x\n╰─ ✓ 直すものは無い")]) {
    assert.doesNotMatch(forged.out, /^(?:╰─ )?✓ 直すものは無い$/m, forged.out);
    assert.match(forged.out, /^✗ Stopped$/m, forged.out);
  }
});

test("no arguments and --help print usage listing init, doctor, and uninstall", () => {
  for (const args of [[], ["--help"], ["-H"]]) {
    const r = run(...args);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.out}`);
    const commands = [...(r.out.split("Commands:")[1] ?? "").matchAll(/^ {2}(\S+) {2}/gm)].map((m) => m[1]);
    assert.deepEqual(commands.sort(), ["doctor", "init", "uninstall"], r.out);
  }
});

// uninstall deletes only ~/.sphica; the plugin, the marketplace, and the npm package are shown for the owner to remove
test("uninstall refuses without --yes outside a terminal, then deletes ~/.sphica and shows the rest", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-uninstall-"));
  try {
    runIn(home, "init");
    const data = path.join(home, ".sphica");
    assert.ok(fs.existsSync(path.join(data, "sphica.db")));
    const refused = runIn(home, "uninstall");
    assert.notEqual(refused.code, 0, refused.out);
    assert.match(refused.out, /--yes/);
    assert.ok(fs.existsSync(data), "deleted without confirmation");
    const done = runIn(home, "uninstall", "--yes");
    assert.equal(done.code, 0, done.out);
    assert.equal(fs.existsSync(data), false);
    for (const want of [
      /npm uninstall -g sphica/,
      /claude plugin uninstall sphica@sphica/,
      /codex plugin marketplace remove sphica/,
    ])
      assert.match(done.out, want, done.out);
    assert.match(runIn(home, "uninstall", "--yes").out, /does not exist/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// SPHICA_HOME is for tests and measurements: uninstall must not turn it into a recursive delete of any directory it names
test("uninstall refuses while SPHICA_HOME is set and deletes nothing", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-uninstall-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-project-"));
  fs.writeFileSync(path.join(project, "keep.txt"), "mine");
  try {
    let out = "";
    let code = 0;
    try {
      out = execFileSync(process.execPath, [CLI, "uninstall", "--yes"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, SPHICA_HOME: project },
        timeout: 30_000,
      });
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      code = err.status ?? -1;
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    assert.notEqual(code, 0, out);
    assert.match(out, /SPHICA_HOME is set/);
    assert.ok(fs.existsSync(path.join(project, "keep.txt")), "the directory SPHICA_HOME names was deleted");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("uninstall names a SPHICA_DB in a sibling of ~/.sphica as outside it", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-uninstall-"));
  try {
    fs.mkdirSync(path.join(home, ".sphica"));
    const sibling = path.join(home, ".sphica-old", "db.sqlite");
    const out = execFileSync(process.execPath, [CLI, "uninstall", "--yes"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, SPHICA_DB: sibling },
      timeout: 30_000,
    });
    assert.match(out, /SPHICA_DB points outside it/, out);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("doctor as a child process shows Codex's trust in the installed hooks, and an untrusted hook does not fail it", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-cli-"));
  const codex = fakeCodex();
  const doctor = () => {
    try {
      const out = execFileSync(process.execPath, [CLI, "doctor"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: `${codex.bin}${path.delimiter}${signedOut}`,
          HOME: home,
          USERPROFILE: home,
          CODEX_HOME: codex.home,
        },
        timeout: 30_000,
      });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  };
  try {
    // A database, so the only failures doctor could have are its own rows
    assert.equal(runIn(home, "init", "--cwd", home).code, 0);
    const trusted = doctor();
    assert.match(trusted.out, /✓ Codex hooks\s+9 of 9 trusted in /, trusted.out);
    assert.equal(trusted.code, 0, trusted.out);
    const text = fs.readFileSync(codex.config, "utf8");
    fs.writeFileSync(
      codex.config,
      text
        .replace(/(stop:0:0"\]\ntrusted_hash = "sha256:)6/, "$10")
        .replace(/(pre_tool_use:0:0"\]\ntrusted_hash = "[^"]+"\nenabled = )true/, "$1false"),
    );
    const changed = doctor();
    assert.match(
      changed.out,
      /△ Codex hooks\s+8 of 9 trusted in [^\n]+; 1 modified, 1 disabled\. open \/hooks/,
      changed.out,
    );
    assert.equal(changed.code, 0, changed.out);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(path.dirname(codex.home), { recursive: true, force: true });
  }
});

test("doctor's word splitting line: this Node matches the shipped samples, and a mismatch is a warning that does not offer reindex", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-cli-"));
  try {
    assert.match(runIn(home, "doctor").out, /Word splitting\s+matches the fixed samples \(ICU /);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  const [first, ...rest] = SAMPLES;
  assert.ok(first);
  const off = splitLine([{ ...first, terms: [...first.terms, "zz-not-a-term"] }, ...rest], "1.0");
  assert.equal(off.mark, "warn");
  assert.match(
    off.text,
    new RegExp(`^1 of ${SAMPLES.length} fixed samples split differently with ICU 1\\.0`),
  );
  assert.doesNotMatch(off.text, /reindex/i);
});
