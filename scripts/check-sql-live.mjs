#!/usr/bin/env node
// Runs the shipped entry points (the CLI and the capture hook) as child processes against SQLite in a temp HOME, checking
// SQL, connection roles (the authorizer), and cleanup together.
//
// `sql:reach` runs functions that take a db as an argument from tests. The CLI opens its own connections, so tests have no seam to inject one.
// Starting it for real shows more than a seam would (role connections stop SQL outside their permissions).
//
// .claude/rules/verification.md explains why the child HOME points to a temp directory.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { coveredSites } from "./lib/coverage.mjs";
import { fakeGh, makeRepo, root, runCli, runHook, withTempDir } from "./lib/live-harness.mjs";
import { ALLOWED_UNREACHED, callSites, LIVE_FILES } from "./lib/sql-call-sites.mjs";

const failures = [];
const note = (what, r) => {
  if (r.timedOut) failures.push(`${what}: killed after timing out`);
  else if (r.status !== 0) failures.push(`${what}: exit ${r.status}\n${r.out.trim().slice(0, 600)}`);
  return r;
};

await withTempDir(async (dir) => {
  const covDir = path.join(dir, "coverage");
  fs.mkdirSync(covDir, { recursive: true });
  const repo = makeRepo(dir);
  fakeGh(dir);

  {
    // Outside any repository, so init only creates the database (from the repository root it would register this checkout too)
    note("init", runCli(["init", "--cwd", dir], dir, covDir));

    // ---- CLI: register, capture, then delete, in that order ----
    // The repo has a remote, so no --name (the CLI would refuse it). The key becomes git:github.com/example/live.
    note("init (register)", runCli(["init", "--cwd", repo], dir, covDir));
    note("project list", runCli(["project", "list"], dir, covDir));
    // The capture hook and flush take the host session from the environment, as in a real session.
    const asSession = (id) => ({ cwd: repo, CLAUDE_CODE_SESSION_ID: id });
    // Capture. Queue through the hook, then flush. Flushing an empty queue returns 0 and never runs the write SQL.
    const turn = { session_id: "live-1", prompt_id: "p1", cwd: repo };
    const hook = (extra) => runHook({ ...turn, ...extra }, dir, covDir, asSession("live-1"));
    // english-exempt: Japanese record fixture sent through the real CLI and hook
    hook({ hook_event_name: "UserPromptSubmit", prompt: "実 DB で SQL を通す" });
    hook({
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      tool_input: { file_path: `${repo}/docs/design.md` },
    });
    // english-exempt: Japanese record fixture sent through the real CLI and hook
    hook({ hook_event_name: "Stop", last_assistant_message: "通した。" });
    note("capture flush", runCli(["capture", "flush"], dir, covDir, asSession("live-1")));

    // Records from an unregistered project are set aside, not dropped (#104). If the owner works on a new machine before
    // running init, those messages land here. Deleting them would lose them for good.
    const stranger = makeRepo(dir, "https://github.com/example/stranger.git", "stranger");
    const strangerTurn = { session_id: "live-3", prompt_id: "p9", cwd: stranger };
    const strangerAs = { cwd: stranger, CLAUDE_CODE_SESSION_ID: "live-3" };
    runHook(
      // english-exempt: Japanese record fixture sent through the real CLI and hook
      { ...strangerTurn, hook_event_name: "UserPromptSubmit", prompt: "未登録のプロジェクトでの発言" },
      dir,
      covDir,
      strangerAs,
    );
    runHook(
      // english-exempt: Japanese record fixture sent through the real CLI and hook
      { ...strangerTurn, hook_event_name: "Stop", last_assistant_message: "返した。" },
      dir,
      covDir,
      strangerAs,
    );
    const strayed = runCli(["capture", "flush"], dir, covDir, strangerAs);
    const kept = path.join(dir, ".sphica", "spool", "unregistered");
    const left = fs.existsSync(kept) ? fs.readdirSync(kept).filter((f) => f.endsWith(".json")) : [];
    if (left.length === 0) {
      failures.push(
        `records from the unregistered project are not in ${kept}. They may have been dropped\n${strayed.out.slice(0, 400)}`,
      );
    }

    // Set-aside records older than 30 days are pruned. Without the limit, using an unregistered project for long would fill the disk.
    const stale = path.join(kept, `${Date.now() - 40 * 24 * 60 * 60 * 1000}-0-stale.json`);
    fs.writeFileSync(stale, JSON.stringify({ v: 1, kind: "message", project: "git:example/none" }));

    // Registering the project brings the set-aside records in. Without this link, setting them aside would be pointless.
    note("init (set-aside project)", runCli(["init", "--cwd", stranger], dir, covDir));
    const retried = runCli(["capture", "flush"], dir, covDir, strangerAs);
    if (!/new messages\s+[1-9]/.test(retried.out)) {
      failures.push(`set-aside records were not stored after registering\n${retried.out.slice(0, 400)}`);
    }
    const after = fs.existsSync(kept) ? fs.readdirSync(kept).filter((f) => f.endsWith(".json")) : [];
    if (after.length) failures.push(`set-aside records remain after sending: ${after.join(" / ")}`);
    if (fs.existsSync(stale)) failures.push(`a set-aside record older than 30 days was not pruned: ${stale}`);
    // Do not rely on the doctor exit code. Plugin versions and install state depend on the local machine (such as an npm CLI that
    // differs from the working tree), so it can be 1 for reasons unrelated to this check. Check only the database rows by content.
    const doctor = runCli(["doctor"], dir, covDir);
    for (const [label, want] of [
      ["Schema version", /✓ Schema version\s+revision \d+/],
      ["Full-text index", /✓ Full-text index\s+healthy/],
      ["Projects", /Projects/],
    ]) {
      if (!want.test(doctor.out))
        failures.push(`doctor does not report ${label} as healthy\n${doctor.out.slice(0, 800)}`);
    }

    // ---- Control sequences from external text never reach the terminal ----
    // PR bodies and titles, handles, conversations, remote spellings, and directory names are decided by third parties or outside factors.
    // First confirm that the injected value reached the output (reach), then check for no ESC, BEL, or CR (no color on a pipe)
    const controlled = (out) => ["\u001b", "\u0007", "\r"].some((c) => out.includes(c));
    const clean = (what, r, reach, { status = true } = {}) => {
      if (status) note(what, r);
      if (!r.out.includes(reach))
        failures.push(
          `the injected value (${reach}) did not reach the ${what} output, so the check would pass vacuously\n${r.out.slice(0, 400)}`,
        );
      if (controlled(r.out))
        failures.push(
          `control sequences remain in the ${what} output\n${JSON.stringify(r.out.slice(0, 400))}`,
        );
    };
    const esc = "\u001b[2J\u001b]0;pwn\u0007\r";
    // english-exempt: Japanese record fixture sent through the real CLI and hook
    hook({ hook_event_name: "UserPromptSubmit", prompt: `制御列${esc}を含む発言` });
    // english-exempt: Japanese record fixture sent through the real CLI and hook
    hook({ hook_event_name: "Stop", last_assistant_message: `応答${esc}` });
    note("capture flush (control sequences)", runCli(["capture", "flush"], dir, covDir, asSession("live-1")));

    // Trace the captured session: the draft binds a run to it, context prints refs, and the record cites one of them.
    // Context prints what the owner said, so it is also where control sequences from a conversation must not reach the terminal.
    clean("trace pending", runCli(["trace", "pending"], dir, covDir, asSession("live-1")), "SQL");
    const drafted = note("trace draft", runCli(["trace", "draft"], dir, covDir, asSession("live-1")));
    const id = /^ {2}id: (\S+)$/m.exec(drafted.out)?.[1];
    const file = /^ {2}file: (.+)$/m.exec(drafted.out)?.[1];
    if (!id || !file) throw new Error(`trace draft printed no id or file\n${drafted.out}`);
    const context = runCli(["trace", "context", id], dir, covDir, asSession("live-1"));
    // english-exempt: Japanese record fixture sent through the real CLI and hook
    clean("trace context", context, "を含む発言");
    const ref = /^ {2}## (s\d+) owner/m.exec(context.out)?.[1];
    if (!ref) failures.push(`trace context printed no owner source ref\n${context.out.slice(0, 600)}`);
    fs.writeFileSync(
      file,
      JSON.stringify({
        units: [
          {
            key: "live",
            kind: "decision",
            stance: "do",
            text: "Run SQL against a real database",
            evidence: [{ source: ref, quote: "SQL", role: "states" }],
            adoption: [{ source: ref, quote: "SQL" }],
          },
        ],
      }),
    );
    note("trace check", runCli(["trace", "check", id], dir, covDir, asSession("live-1")));
    const traced = note("trace save", runCli(["trace", "save", id], dir, covDir, asSession("live-1")));
    if (!/trace:live-1\/live active/.test(traced.out))
      failures.push(`trace save did not activate the decision\n${traced.out.slice(0, 600)}`);
    if (fs.existsSync(path.dirname(file))) failures.push(`trace save left its draft behind: ${file}`);

    // Harvest a pull request through the fake gh. Its comment carries control sequences, which context must drop
    const harvested = note("harvest draft", runCli(["harvest", "draft", "1"], dir, covDir, { cwd: repo }));
    const hid = /^ {2}id: (\S+)$/m.exec(harvested.out)?.[1];
    const hfile = /^ {2}file: (.+)$/m.exec(harvested.out)?.[1];
    if (!hid || !hfile) throw new Error(`harvest draft printed no id or file\n${harvested.out}`);
    const hcontext = runCli(["harvest", "context", hid], dir, covDir, { cwd: repo });
    clean("harvest context", hcontext, "Checked");
    const body = /^ {2}## (s\d+) pr_body/m.exec(hcontext.out)?.[1];
    if (!body) failures.push(`harvest context printed no body ref\n${hcontext.out.slice(0, 600)}`);
    fs.writeFileSync(
      hfile,
      JSON.stringify({
        units: [
          {
            key: "real-db",
            kind: "decision",
            stance: "do",
            text: "Use the real database for checks",
            evidence: [{ source: body, quote: "Use the real database for checks.", role: "states" }],
            adoption: [{ source: body, quote: "Use the real database for checks." }],
          },
        ],
      }),
    );
    note("harvest check", runCli(["harvest", "check", hid], dir, covDir, { cwd: repo }));
    const hsaved = note("harvest save", runCli(["harvest", "save", hid], dir, covDir, { cwd: repo }));
    if (!/harvest:1\/real-db active/.test(hsaved.out))
      failures.push(`harvest save did not activate the decision\n${hsaved.out.slice(0, 600)}`);
    const evil = makeRepo(dir, `https://github.com/example/ev${esc}il.git`, "evil\u001b[2Jdir");
    clean("init (remote and directory name)", runCli(["init", "--cwd", evil], dir, covDir), "evil");
    clean("project list", runCli(["project", "list"], dir, covDir), "example/ev");
    // The doctor exit code depends on the local plugin state, so it is not checked (same reason as above)
    clean("doctor", runCli(["doctor"], dir, covDir), "example/ev", { status: false });

    note(
      "project forget",
      runCli(["project", "forget", "git:github.com/example/live", "--yes"], dir, covDir),
    );
  }

  // ---- Count reach ----
  const sites = callSites(root).filter((s) => LIVE_FILES.some((f) => s.startsWith(`${f}:`)));
  const covered = coveredSites(covDir, root, sites);
  const missed = sites.filter((s) => !covered.has(s));

  if (missed.length) {
    const allowed = new Set(ALLOWED_UNREACHED.map((a) => a.site));
    const unexpected = missed.filter((s) => !allowed.has(s));
    if (unexpected.length) {
      failures.push(
        `some SQL does not run even against the real database.\n    ${unexpected.join("\n    ")}\n` +
          "  If it cannot be reached, add it with a reason to ALLOWED_UNREACHED in scripts/lib/sql-call-sites.mjs.",
      );
    }
  }
  for (const a of ALLOWED_UNREACHED) {
    if (covered.has(a.site)) failures.push(`${a.site}: now reached. Remove it from ALLOWED_UNREACHED`);
  }

  if (failures.length) {
    console.error(`${failures.length} failures in the real database lane.\n`);
    for (const f of failures) console.error(`  ${f}\n`);
    process.exit(1);
  }
  console.log(
    `real database: ran the CLI as a child process and ran ${covered.size} / ${sites.length} SQL sites`,
  );
});
