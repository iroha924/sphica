#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Runs the shipped entry points (the CLI and the capture hook) as child processes against SQLite in a temp HOME, checking
// SQL, connection roles (the authorizer), and cleanup together.
//
// `sql:reach` runs functions that take a db as an argument from tests. The CLI opens its own connections, so tests have no seam to inject one.
// Starting it for real shows more than a seam would (role connections stop SQL outside their permissions).
//
// .claude/rules/verification.md explains why the child HOME points to a temp directory.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { coveredSites } from "./lib/coverage.mjs";
import { finding, report, runCheck } from "./lib/finding.mjs";
import { makeRepo, root, runCli, runFlush, runHook, withTempDir } from "./lib/live-harness.mjs";
import { ALLOWED_UNREACHED, callSites, LIVE_FILES } from "./lib/sql-call-sites.mjs";

const failures = [];
const fail = (parts) => failures.push(finding(parts));
const CLI = "server/src/cli.ts";
const CAPTURE = "server/src/capture.ts";
// Every step runs the shipped CLI or hook against a real database in a temp HOME, so a failure is a bug in what users run
const SHIPPED = "users run this same entry point against the same kind of database";
const note = (what, r, source = CLI) => {
  if (r.timedOut)
    fail({
      where: `sql:live ${what}`,
      what: "the child process was killed after timing out",
      why: SHIPPED,
      fix: `find where ${source} waits (a lock, a prompt, a child that never exits) with the output below`,
      detail: r.out.trim().slice(0, 600),
    });
  else if (r.status !== 0)
    fail({
      where: `sql:live ${what}`,
      what: `the child process exited ${r.status}`,
      why: SHIPPED,
      fix: `fix ${source} by the error in the output below`,
      detail: r.out.trim().slice(0, 600),
    });
  return r;
};

// An error the steps do not expect (git missing, a database that cannot be opened) is reported as a crash with its stack
await runCheck("sql:live", () =>
  withTempDir(async (dir) => {
    const covDir = path.join(dir, "coverage");
    fs.mkdirSync(covDir, { recursive: true });
    const repo = makeRepo(dir);

    {
      // Outside any repository, so init only creates the database (from the repository root it would register this checkout too)
      // gh is signed out here (the harness puts a fake gh first on PATH): init still sets up, and says why nothing was bound
      const unbound = note("init", runCli(["init", "--cwd", dir], dir, covDir));
      if (!/GitHub account not bound: gh api user failed/.test(unbound.out))
        fail({
          where: "sql:live init (gh signed out)",
          what: "init does not say the GitHub account was not bound, and why",
          why: "harvest and glean need the owner's account, so the owner must learn at init that it was not bound",
          fix: `print "GitHub account not bound: <reason>" from init in ${CLI} when gh api user fails`,
          detail: unbound.out.slice(0, 600),
        });
      // Unbound is neutral: only harvest and glean need it, so doctor never lists it among the things to fix
      const early = runCli(["doctor"], dir, covDir);
      if (!/○ GitHub owner\s+none/.test(early.out) || /to fix:[^\n]*GitHub owner/.test(early.out))
        fail({
          where: "sql:live doctor (no owner bound)",
          what: "doctor does not show an unbound GitHub owner as neutral (○ GitHub owner none, not in to fix)",
          why: "only harvest and glean need the owner, so an unbound one is not a fault to fix",
          fix: `show the GitHub owner line as neutral in doctor (${CLI}) and leave it out of the to-fix list`,
          detail: early.out.slice(0, 800),
        });

      // ---- CLI: register, capture, then delete, in that order ----
      // The repo has a remote, so no --name (the CLI would refuse it). The key becomes git:github.com/example/live.
      const registered = note(
        "init (register)",
        runCli(["init", "--cwd", repo], dir, covDir, {
          SPHICA_TEST_GH_USER: JSON.stringify({ id: 42, login: "hana" }),
        }),
      );
      if (!/GitHub account hana \(id 42\) bound as the owner/.test(registered.out))
        fail({
          where: "sql:live init (gh signed in)",
          what: "init does not bind the account gh answered (hana, id 42)",
          why: "harvest and glean trust the bound owner's words, so init must bind the signed-in account",
          fix: `check that init in ${CLI} reads gh api user through server/src/github.ts and writes the owner with the owner role`,
          detail: registered.out.slice(0, 600),
        });
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
      note("capture flush", runFlush(dir, covDir, asSession("live-1")), CAPTURE);
      // A record tool's PreToolUse writes its session and turn straight through the capture role, before the tool runs
      note(
        "record tool hook",
        hook({
          hook_event_name: "PreToolUse",
          tool_name: "mcp__plugin_sphica_record__trace_begin",
          tool_use_id: "toolu_live",
        }),
        CAPTURE,
      );
      {
        const raw = new DatabaseSync(path.join(dir, ".sphica", "sphica.db"), { readOnly: true });
        const seen = raw
          .prepare("select turn_id from tool_call_observation where tool_use_id = 'toolu_live'")
          .get();
        raw.close();
        if (seen?.turn_id !== "p1")
          fail({
            where: "sql:live record tool hook",
            what: `the PreToolUse hook of a record tool did not log its turn (got ${JSON.stringify(seen)})`,
            why: "the record server joins each record tool call to the session and turn this hook writes first",
            fix: `check that ${CAPTURE} writes tool_call_observation for record tools on PreToolUse, with the capture role`,
          });
      }
      // An observation the hook could not write stays in calls/ until a send writes it
      {
        const calls = path.join(dir, ".sphica", "spool", "calls");
        fs.mkdirSync(calls, { recursive: true });
        const missed = {
          v: 1,
          host: "claude-code",
          session: "live-1",
          turn: "p2",
          toolUse: "toolu_missed",
          tool: "mcp__plugin_sphica_record__record_save",
          owner: 1,
          at: new Date().toISOString(),
        };
        fs.writeFileSync(path.join(calls, `${Date.now()}-0-missed.json`), JSON.stringify(missed));
        note("observation resend", runFlush(dir, covDir, asSession("live-1")), CAPTURE);
        const raw = new DatabaseSync(path.join(dir, ".sphica", "sphica.db"), { readOnly: true });
        const seen = raw
          .prepare("select turn_id from tool_call_observation where tool_use_id = 'toolu_missed'")
          .get();
        raw.close();
        const left = fs.readdirSync(calls).filter((f) => f.endsWith(".json"));
        if (seen?.turn_id !== "p2" || left.length)
          fail({
            where: "sql:live observation resend",
            what: `an observation kept in spool/calls was not resent (got ${JSON.stringify(seen)}, left ${left.join(" / ") || "none"})`,
            why: "an observation the hook could not write must reach the database on the next send, or the record server loses the call",
            fix: `check that the flush in ${CAPTURE} sends spool/calls and removes each file it wrote`,
          });
      }

      // Records from an unregistered project are set aside, not dropped. If the owner works on a new machine before
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
      const strayed = runFlush(dir, covDir, strangerAs);
      const kept = path.join(dir, ".sphica", "spool", "unregistered");
      const left = fs.existsSync(kept) ? fs.readdirSync(kept).filter((f) => f.endsWith(".json")) : [];
      if (left.length === 0) {
        fail({
          where: "sql:live capture (unregistered project)",
          what: `records from an unregistered project are not in ${kept}`,
          why: "the owner may work on a new machine before running init, and dropping those messages loses them for good",
          fix: `set aside records of an unregistered project in spool/unregistered in ${CAPTURE} instead of dropping them`,
          detail: strayed.out.slice(0, 400),
        });
      }

      // Set-aside records older than 30 days are pruned. Without the limit, using an unregistered project for long would fill the disk.
      const stale = path.join(kept, `${Date.now() - 40 * 24 * 60 * 60 * 1000}-0-stale.json`);
      fs.writeFileSync(stale, JSON.stringify({ v: 1, kind: "message", project: "git:example/none" }));

      // Registering the project brings the set-aside records in. Without this link, setting them aside would be pointless.
      note("init (set-aside project)", runCli(["init", "--cwd", stranger], dir, covDir));
      const retried = runFlush(dir, covDir, strangerAs);
      const rejected = path.join(dir, ".sphica", "spool", "rejected");
      const SET_ASIDE =
        "registering a project brings its set-aside records in; otherwise setting them aside is pointless";
      if (fs.existsSync(rejected) && fs.readdirSync(rejected).length)
        fail({
          where: "sql:live capture flush (after registering)",
          what: `set-aside records were rejected after the project was registered: ${fs.readdirSync(rejected).join(" / ")}`,
          why: SET_ASIDE,
          fix: `read the .reason file beside each rejected record and fix the send in ${CAPTURE}`,
          detail: retried.out.slice(0, 400),
        });
      const after = fs.existsSync(kept) ? fs.readdirSync(kept).filter((f) => f.endsWith(".json")) : [];
      if (after.length)
        fail({
          where: "sql:live capture flush (after registering)",
          what: `set-aside records remain after sending: ${after.join(" / ")}`,
          why: SET_ASIDE,
          fix: `make the flush in ${CAPTURE} send spool/unregistered once the project is registered`,
        });
      if (fs.existsSync(stale))
        fail({
          where: "sql:live capture flush (after registering)",
          what: `a set-aside record older than 30 days was not pruned: ${stale}`,
          why: "without the limit, long use of an unregistered project would fill the disk",
          fix: `prune spool/unregistered files older than 30 days in ${CAPTURE}`,
        });
      // Do not rely on the doctor exit code. Plugin versions and install state depend on the local machine (such as an npm CLI that
      // differs from the working tree), so it can be 1 for reasons unrelated to this check. Check only the database rows by content.
      const doctor = runCli(["doctor"], dir, covDir);
      for (const [label, want] of [
        ["Schema version", /✓ Schema version\s+revision \d+/],
        ["Full-text index", /✓ Full-text index\s+healthy/],
        ["GitHub owner", /✓ GitHub owner\s+hana \(id 42\)/],
        ["Projects", /Projects/],
      ]) {
        if (!want.test(doctor.out))
          fail({
            where: "sql:live doctor",
            what: `doctor does not report ${label} as healthy`,
            why: "the owner starts troubleshooting with doctor, so it must read the database it checks",
            fix: `run doctor's ${label} check in ${CLI} against the output below`,
            detail: doctor.out.slice(0, 800),
          });
      }

      // ---- Control sequences from external text never reach the terminal ----
      // PR bodies and titles, handles, conversations, remote spellings, and directory names are decided by third parties or outside factors.
      // First confirm that the injected value reached the output (reach), then check for no ESC, BEL, or CR (no color on a pipe)
      const controlled = (out) => ["\u001b", "\u0007", "\r"].some((c) => out.includes(c));
      const clean = (what, r, reach, { status = true } = {}) => {
        if (status) note(what, r);
        if (!r.out.includes(reach))
          fail({
            where: `sql:live ${what}`,
            what: `the injected value (${reach}) did not reach the output`,
            why: "the control sequence check would pass while looking at output that never held the outside text",
            fix: "change the injected value in scripts/check-sql-live.mjs to one the command prints",
            detail: r.out.slice(0, 400),
          });
        if (controlled(r.out))
          fail({
            where: `sql:live ${what}`,
            what: "control sequences from outside text reached the output",
            why: "text from PRs, remotes, and directory names must not rewrite the owner's terminal (invariant view-parts)",
            fix: "print the value through the parts in server/src/cli/view.ts, which drop control characters",
            detail: JSON.stringify(r.out.slice(0, 400)),
          });
      };
      const esc = "\u001b[2J\u001b]0;pwn\u0007\r";
      // english-exempt: Japanese record fixture sent through the real CLI and hook
      hook({ hook_event_name: "UserPromptSubmit", prompt: `制御列${esc}を含む発言` });
      // english-exempt: Japanese record fixture sent through the real CLI and hook
      hook({ hook_event_name: "Stop", last_assistant_message: `応答${esc}` });
      note("capture flush (control sequences)", runFlush(dir, covDir, asSession("live-1")), CAPTURE);

      const evil = makeRepo(dir, `https://github.com/example/ev${esc}il.git`, "evil\u001b[2Jdir");
      clean("init (remote and directory name)", runCli(["init", "--cwd", evil], dir, covDir), "evil");
      // The doctor exit code depends on the local plugin state, so it is not checked (same reason as above)
      clean("doctor", runCli(["doctor"], dir, covDir), "example/ev", { status: false });

      const removed = note("uninstall", runCli(["uninstall", "--yes"], dir, covDir));
      if (fs.existsSync(path.join(dir, ".sphica")))
        fail({
          where: "sql:live uninstall --yes",
          what: "uninstall left ~/.sphica behind",
          why: "the owner expects uninstall to remove Sphica's data",
          fix: `remove ~/.sphica in uninstall (${CLI}), and close every connection first`,
          detail: removed.out.slice(0, 400),
        });
    }

    {
      // A revision 1 database (as 0.5.7 made it): init migrates it in place, then capture writes into it
      const home = path.join(dir, "old-home");
      fs.mkdirSync(path.join(home, ".sphica"), { recursive: true });
      const file = path.join(home, ".sphica", "sphica.db");
      const old = new DatabaseSync(file);
      old.exec("pragma journal_mode = wal");
      old.exec(fs.readFileSync(path.join(root, "server", "test", "fixtures", "schema-rev1.sql"), "utf8"));
      old.close();
      const oldRepo = makeRepo(home);
      const migrated = note("init (revision 1)", runCli(["init", "--cwd", oldRepo], home, covDir));
      // The revision db/schema.sql is at now, so a new revision keeps this lane checking the whole chain of migrations
      const current = Number(
        /pragma user_version = (\d+);/.exec(
          fs.readFileSync(path.join(root, "db", "schema.sql"), "utf8"),
        )?.[1],
      );
      const MIGRATE =
        "owners upgrade from old releases, so init must carry a database through every migration";
      if (!new RegExp(`Migrated: .*\\(revision 1 → ${current}\\)`).test(migrated.out))
        fail({
          where: "sql:live init (revision 1 database)",
          what: `init does not report migrating a revision 1 database to ${current}`,
          why: MIGRATE,
          fix: "run the migration chain in server/src/admin.ts from revision 1, by the output below",
          detail: migrated.out.slice(0, 600),
        });
      runHook(
        {
          session_id: "old-1",
          prompt_id: "p1",
          cwd: oldRepo,
          hook_event_name: "UserPromptSubmit",
          prompt: "after the migration",
        },
        home,
        covDir,
        { cwd: oldRepo, CLAUDE_CODE_SESSION_ID: "old-1" },
      );
      note(
        "capture flush (migrated)",
        runFlush(home, covDir, { cwd: oldRepo, CLAUDE_CODE_SESSION_ID: "old-1" }),
        CAPTURE,
      );
      const look = new DatabaseSync(file, { readOnly: true });
      const n = look.prepare("select count(*) as n from source where text = 'after the migration'").get().n;
      const revision = look.prepare("pragma user_version").get().user_version;
      if (revision !== current)
        fail({
          where: "sql:live init (revision 1 database)",
          what: `init left the database at revision ${revision}, not ${current}`,
          why: MIGRATE,
          fix: `add the migration from ${revision} in server/src/admin.ts`,
        });
      look.close();
      if (n !== 1)
        fail({
          where: "sql:live capture flush (migrated)",
          what: `capture did not write into the migrated database (${n} rows)`,
          why: MIGRATE,
          fix: `compare the migrated schema with db/schema.sql: capture (${CAPTURE}) writes what the current schema has`,
        });
    }

    // ---- Count reach ----
    const sites = callSites(root).filter((s) => LIVE_FILES.some((f) => s.startsWith(`${f}:`)));
    const covered = coveredSites(covDir, root, sites);
    const missed = sites.filter((s) => !covered.has(s));

    if (missed.length) {
      const allowed = new Set(ALLOWED_UNREACHED.map((a) => a.site));
      const unexpected = missed.filter((s) => !allowed.has(s));
      for (const site of unexpected)
        fail({
          where: site,
          what: "the SQL at this call site does not run in the real database lane",
          why: "SQL that never runs can hold what SQLite rejects, and only this lane runs the CLI and capture (invariant real-sqlite-tests)",
          fix: "drive it from a step in scripts/check-sql-live.mjs, or, if it cannot be reached, add it with the reason to ALLOWED_UNREACHED in scripts/lib/sql-call-sites.mjs",
        });
    }
    for (const a of ALLOWED_UNREACHED) {
      if (covered.has(a.site))
        fail({
          where: "scripts/lib/sql-call-sites.mjs",
          what: `${a.site} is in ALLOWED_UNREACHED but now runs`,
          why: "a stale exception would let the site stop running unseen",
          fix: `remove ${a.site} from ALLOWED_UNREACHED`,
        });
    }

    if (!failures.length)
      console.log(
        `real database: ran the CLI as a child process and ran ${covered.size} / ${sites.length} SQL sites`,
      );
  }),
);
// Outside the steps, so what they found before a crash is reported too. The process is left to end on its own: exiting at once would
// drop output still in the pipe
report("sql:live", failures);
