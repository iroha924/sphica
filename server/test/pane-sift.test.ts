// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The pane mod finds Sphica's text by its wording alone, so every kind of text deliver.ts really writes must pass its sift.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type Delivered, LIMITS, layout, omitted, type Result, sift } from "../../pane/hooks/sift.ts";
import { inTransaction } from "../src/db.ts";
import { respond } from "../src/deliver.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { openRun } from "../src/trace.ts";
import { insert, message, project, tempDb } from "./temp-db.ts";
import { ownTmpdir } from "./temp-dir.ts";

ownTmpdir("sphica-pane-sift-tmp-");

for (const k of [
  "SPHICA_PARENT_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "SPHICA_AUTO_TRACE",
  "CLAUDE_PLUGIN_OPTION_AUTO_TRACE",
])
  delete process.env[k];

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    stdio: "ignore",
  });

/** A checkout whose default branch (origin/HEAD) holds src/dates.ts, on a feature branch, so a review has something to compare */
function checkout(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-pane-sift-")));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "remote", "add", "origin", "https://github.com/o/r.git");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "dates.ts"), "export const toStored = (d: Date) => d;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(dir, "switch", "-q", "-c", "feature");
  return dir;
}

/** What Claude Code hands a mod for a command hook's answer: the context as one entry, a refusal as deny */
const asResult = (r: string | { stop: string }): Result =>
  typeof r === "string" ? (r ? { additionalContext: [r] } : {}) : { deny: r.stop };

test("every kind of text deliver.ts writes passes the sift, and other hooks' text does not", async () => {
  const db = tempDb();
  const repo = checkout();
  try {
    const p = project(db);
    const m = message(db, p, {
      id: "m1",
      text: "Store every timestamp in UTC. The worker build of thumbs failed.",
    });
    const t: Target = {
      projectId: p,
      origin: "trace",
      prefix: "trace:ext-s1/",
      sessionId: "s1",
      root: null,
      sources: null,
    };
    await inTransaction(db.ingest, async (trx) => {
      const run = await openRun(trx, {
        projectId: p,
        origin: "trace",
        target: "session:s1",
        sessionId: "s1",
        draftId: "d1",
      });
      const record = {
        units: [
          {
            key: "utc",
            kind: "constraint",
            stance: "do",
            text: "Store every timestamp in UTC.",
            evidence: [{ source: `s${m}`, quote: "Store every timestamp in UTC.", role: "states" }],
            adoption: [{ source: `s${m}`, quote: "Store every timestamp in UTC." }],
            anchors: [{ path: "src/dates.ts", symbol: "toStored", role: "applies_to" }],
          },
          // A stop shows five dead ends, so the sixth is what the same call run again shows (RAN)
          ...Array.from({ length: 6 }, (_, n) => ({
            key: `thumbs-${n}`,
            kind: "dead_end",
            text: `Thumbnails in a worker fail (${n})`,
            evidence: [{ source: `s${m}`, quote: "The worker build of thumbs failed.", role: "states" }],
            commands: ["npm run thumbs --worker"],
          })),
        ],
      };
      return saveRecord(trx, t, run, await checkRecord(trx, t, record), []);
    });
    insert(db, "work", {
      project_id: p,
      key: "w",
      title: "Rework CSV export",
      goal: "g",
      current: "notes removed",
      next: "[]",
      status: "active",
      updated_at: "2026-09-27T00:00:00.000Z",
    });
    const call = (input: Record<string, unknown>, file = db.file) =>
      respond({ session_id: "sess", cwd: repo, ...input }, "claude-code", file);
    const file = (name: string) => path.join(repo, name);
    const said = {
      start: await call({ hook_event_name: "SessionStart", source: "startup" }),
      subagent: await call({ hook_event_name: "SubagentStart", agent_id: "a1", agent_type: "Explore" }),
      edit: await call({
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: file("src/dates.ts") },
      }),
      read: await respond(
        {
          session_id: "reader",
          cwd: repo,
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_input: { file_path: file("src/dates.ts") },
        },
        "claude-code",
        db.file,
      ),
      // english-exempt: an owner prompt in their own language, which names the record's symbol
      prompt: await call({ hook_event_name: "UserPromptSubmit", prompt: "toStored を直したい" }),
      stop: await call({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "npm run thumbs --worker" },
      }),
      unavailable: await respond(
        { session_id: "gone", cwd: repo, hook_event_name: "SessionStart", source: "startup" },
        "claude-code",
        path.join(repo, "missing", "sphica.db"),
      ),
    };
    // The same call run again goes through, with the dead end shown instead
    const ran = await call({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm run thumbs --worker" },
    });
    // A new interactive session gets the request to trace the sessions that wait
    const today = new Date().toISOString();
    message(db, p, { id: "u1", text: "untraced", session: "u1", sent: today });
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    const traced = await call({
      hook_event_name: "SessionStart",
      source: "startup",
      session_id: crypto.randomUUID(),
    });
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    const review = () =>
      call({
        hook_event_name: "UserPromptExpansion",
        session_id: crypto.randomUUID(),
        expansion_type: "slash_command",
        command_name: "review",
        command_args: "",
        prompt: "/review",
      });
    const unchanged = await review();
    fs.appendFileSync(file("src/dates.ts"), "export const toDisplay = (d: Date) => toStored(d);\n");
    const changed = await review();
    Object.assign(said, { ran, traced, unchanged, changed });
    assert.match(String(ran), /Dead ends recorded for a command this call runs/);
    assert.match(String(traced), /earlier session/);
    assert.match(String(unchanged), /^Sphica: no local change/);
    assert.match(String(changed), /^Sphica: past decisions that apply to this change/);
    for (const [kind, r] of Object.entries(said)) {
      assert.ok(typeof r !== "string" || r !== "", `${kind}: deliver.ts said something to test against`);
      const kept = sift(asResult(r), kind, "12:00:00");
      assert.equal(kept.length, 1, `${kind}: ${JSON.stringify(r).slice(0, 200)}`);
      assert.equal(kept[0]?.kind, kind === "stop" ? "stop" : "context", kind);
    }

    assert.deepEqual(
      sift({ additionalContext: ["Lint passed.", "Another plugin's note"] }, "PreToolUse", "t"),
      [],
    );
    assert.deepEqual(sift({ deny: "Blocked by policy" }, "PreToolUse", "t"), []);
    assert.deepEqual(sift({}, "SessionStart", "t"), []);
    assert.deepEqual(sift(undefined, "SessionStart", "t"), []);
  } finally {
    await db.done();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

const row = (n: number, text: string, kind: Delivered["kind"] = "context"): Delivered => ({
  at: `12:00:${String(n % 60).padStart(2, "0")}`,
  event: "PreToolUse",
  kind,
  text,
});

test("the layout shows the newest first within its budget and says what it cut or left out", () => {
  assert.deepEqual(layout([]), { shown: [], cut: 0, hidden: 0 });

  const few = [row(1, "Sphica: one"), row(2, "Sphica: two", "stop")];
  assert.deepEqual(
    layout(few).shown.map((r) => r.text),
    ["Sphica: two", "Sphica: one"],
  );

  const long = Array.from({ length: LIMITS.kept }, (_, i) =>
    // english-exempt: records keep the language they were saved in
    row(i, `Sphica: ${"記録の本文".repeat(400)} ${i}`),
  );
  const fitted = layout(long);
  assert.ok(fitted.shown.length > 0);
  assert.equal(fitted.shown[0]?.text.startsWith("Sphica: "), true);
  assert.equal(fitted.cut, fitted.shown.length, "every long row is cut");
  assert.equal(fitted.hidden, LIMITS.kept - fitted.shown.length);
  for (const r of fitted.shown) assert.ok(r.text.length <= LIMITS.each, `${r.text.length} characters`);
  const drawn = fitted.shown.reduce((n, r) => n + `${r.at} ${r.event}`.length + r.text.length, 0);
  assert.ok(drawn + omitted(fitted.cut, fitted.hidden).length <= LIMITS.chars, `${drawn} drawn`);

  // A row that fills the budget exactly still shows, one character more does not
  const exact = (n: number) => [row(1, "x".repeat(n))];
  const room = 200 - omitted(1, 1).length - "12:00:01 PreToolUse".length;
  assert.equal(layout(exact(room), 200, 1000).shown.length, 1);
  assert.equal(layout(exact(room + 1), 200, 1000).shown.length, 0);
});
