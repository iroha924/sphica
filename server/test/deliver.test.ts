// Automatic delivery against real SQLite and a git checkout: which records reach the model before an edit, on a prompt, and at session
// start, which never do, and that each delivery is logged by unit id without its text.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { inTransaction } from "../src/db.ts";
import { deliver } from "../src/deliver.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { openRun } from "../src/trace.ts";
import { insert, message, project, type TempDb, tempDb } from "./temp-db.ts";

const saved = { parent: process.env.SPHICA_PARENT_SESSION, entry: process.env.CLAUDE_CODE_ENTRYPOINT };
before(() => {
  // Run from Claude Code's Bash, the parent session marker would make every prompt look like a child's
  delete process.env.SPHICA_PARENT_SESSION;
  delete process.env.CLAUDE_CODE_ENTRYPOINT;
});
after(() => {
  if (saved.parent !== undefined) process.env.SPHICA_PARENT_SESSION = saved.parent;
  if (saved.entry !== undefined) process.env.CLAUDE_CODE_ENTRYPOINT = saved.entry;
});

function checkout(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-deliver-")));
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/o/r.git"], {
    stdio: "ignore",
  });
  return dir;
}

async function save(db: TempDb, p: number, record: unknown) {
  const t: Target = {
    projectId: p,
    origin: "trace",
    prefix: "trace:ext-s1/",
    sessionId: "s1",
    root: null,
    sources: null,
  };
  return inTransaction(db.ingest, async (trx) => {
    const run = await openRun(trx, {
      projectId: p,
      origin: "trace",
      target: "session:s1",
      sessionId: "s1",
      draftId: `d${Math.random()}`,
    });
    return saveRecord(trx, t, run, await checkRecord(trx, t, record), []);
  });
}

const decided = (key: string, source: number, quote: string, extra: Record<string, unknown> = {}) => ({
  key,
  kind: "constraint",
  stance: "do",
  text: quote,
  evidence: [{ source: `s${source}`, quote, role: "states" }],
  adoption: [{ source: `s${source}`, quote }],
  ...extra,
});

test("delivery brings anchored, named, and broad records, never candidates or conflicts, and logs what it sent", async () => {
  const db = tempDb();
  const repo = checkout();
  try {
    const p = project(db);
    const m = message(db, p, {
      id: "m1",
      text: "Store every timestamp in UTC. No telemetry. Keep one SQLite file. Maybe Postgres.",
    });
    await save(db, p, {
      units: [
        decided("utc", m, "Store every timestamp in UTC.", {
          anchors: [{ path: "src/dates.ts", symbol: "toStored", role: "applies_to" }],
        }),
        decided("no-telemetry", m, "No telemetry.", {
          stance: "dont",
          options: [{ text: "telemetry", outcome: "rejected" }],
          aliases: ["usage analytics"],
        }),
        decided("sqlite", m, "Keep one SQLite file.", {
          anchors: [{ path: "src/db.ts", role: "applies_to" }],
        }),
        decided("opener", m, "No telemetry.", {
          anchors: [{ path: "src/open.ts", symbol: "open", role: "applies_to" }],
        }),
        {
          key: "maybe",
          kind: "decision",
          stance: "do",
          text: "Maybe Postgres",
          evidence: [{ source: `s${m}`, quote: "Maybe Postgres.", role: "states" }],
          anchors: [{ path: "src/dates.ts", role: "applies_to" }],
        },
      ],
    });
    await save(db, p, {
      units: [
        {
          key: "q",
          kind: "question",
          text: "q",
          evidence: [{ source: `s${m}`, quote: "SQLite", role: "states" }],
          conflicts: ["trace:ext-s1/sqlite"],
        },
      ],
    });
    insert(db, "work", {
      project_id: p,
      key: "w",
      title: "Rework CSV export",
      goal: "g",
      current: "notes removed",
      next: '["add column order"]',
      status: "active",
      updated_at: "2026-09-27T00:00:00.000Z",
    });
    const at = (input: Record<string, unknown>) =>
      deliver({ session_id: "sess", cwd: repo, ...input }, "claude-code", db.file);
    const edit = (file: string, tool = "Edit", session = "sess") =>
      at({
        session_id: session,
        hook_event_name: "PreToolUse",
        tool_name: tool,
        tool_input: { file_path: path.join(repo, file) },
      });

    const dates = await edit("src/dates.ts");
    assert.match(dates, /Active decisions applying to src\/dates\.ts \(current code relevance unverified\)/);
    assert.match(dates, /trace:ext-s1\/utc/);
    assert.doesNotMatch(dates, /maybe/, "a candidate is never delivered");
    assert.equal(await edit("src/db.ts"), "", "a record in an unresolved conflict is held back");
    assert.equal(await edit("src/other.ts"), "");
    const read = await edit("src/dates.ts", "Read", "reader");
    assert.match(
      read,
      /Active decisions applying to src\/dates\.ts, which you are reading \(current code relevance unverified\)/,
    );
    assert.match(read, /trace:ext-s1\/utc/);
    assert.equal(
      await edit("src/dates.ts", "Read", "reader"),
      "",
      "a record already shown in this session is not shown again on a read",
    );
    assert.match(
      await edit("src/dates.ts", "Edit", "reader"),
      /trace:ext-s1\/utc/,
      "the edit reminder still comes",
    );
    assert.equal(
      await edit("src/dates.ts", "Read"),
      "",
      "a record an edit already showed is not shown again on a read",
    );
    assert.equal(await edit("src/open.ts", "Grep"), "", "only Read counts as reading");
    assert.equal(
      await at({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/etc/hosts" } }),
      "",
    );

    const prompt = (text: string) => at({ hook_event_name: "UserPromptSubmit", prompt: text });
    assert.match(await prompt("toStored を直したい"), /trace:ext-s1\/utc .*\[names toStored\]/);
    assert.match(await prompt("src/dates.ts を見て"), /\[names src\/dates\.ts\]/);
    assert.match(
      await prompt("Add Telemetry for usage stats"),
      /no-telemetry.*\[names the rejected option telemetry\]/,
    );
    assert.equal(await prompt("Do we collect usage analytics?"), "", "alias-only matches never deliver");
    assert.equal(await prompt("今日の天気は？"), "");
    // A symbol that is also a plain word (open) counts only when the prompt writes it as code
    assert.equal(
      await prompt("Carry out the task. Do not open pull requests."),
      "",
      "a plain word is not a code mention",
    );
    assert.match(await prompt("open() が遅い"), /opener .*\[names open\]/);
    assert.match(await prompt("`open` を直したい"), /opener .*\[names open\]/);
    assert.equal(
      await at({ hook_event_name: "UserPromptSubmit", prompt: "toStored", agent_id: "sub" }),
      "",
      "subagent prompts are not the owner's",
    );

    const start = await at({ hook_event_name: "SessionStart", source: "startup" });
    assert.match(start, /Work: Rework CSV export \(active\): notes removed; next: add column order/);
    assert.match(start, /no-telemetry/, "a constraint with no code location is a standing constraint");
    assert.doesNotMatch(start, /trace:ext-s1\/utc/, "anchored constraints wait for their edit");
    assert.ok(start.length <= 1000);
    assert.equal(
      await at({ hook_event_name: "SessionStart", source: "resume" }),
      "",
      "resume does not repeat the briefing",
    );
    assert.equal(await at({ hook_event_name: "Stop" }), "");
    assert.equal(await deliver({ hook_event_name: "SessionStart", cwd: repo }, "claude-code", db.file), "");

    const logged = db.owner
      .prepare(
        "select event, outcome, count(u.unit_id) as units from delivery d left join delivery_unit u on u.delivery_id = d.id group by d.id order by d.id",
      )
      .all()
      .map((r) => [r.event, r.outcome, r.units]);
    assert.deepEqual(logged.slice(0, 6), [
      ["pre_edit", "emitted", 1],
      ["pre_edit", "nothing", 0],
      ["pre_edit", "nothing", 0],
      ["pre_read", "emitted", 1],
      ["pre_read", "nothing", 0],
      ["pre_edit", "emitted", 1],
    ]);
    assert.ok(logged.some(([e, o]) => e === "session_start" && o === "emitted"));
  } finally {
    await db.done();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("reads deliver within a session-wide budget, never a unit twice, and only decisions and constraints", async () => {
  const db = tempDb();
  const repo = checkout();
  try {
    const p = project(db);
    const text = Array.from({ length: 12 }, (_, n) => `Rule ${n} ${"x".repeat(300)}.`).join(" ");
    const m = message(db, p, { id: "m1", text: `${text} Found a slow path.` });
    await save(db, p, {
      units: [
        ...Array.from({ length: 12 }, (_, n) =>
          decided(`r${n}`, m, `Rule ${n} ${"x".repeat(300)}.`, {
            anchors: [{ path: `src/f${n}.ts`, role: "applies_to" }],
          }),
        ),
        {
          key: "slow",
          kind: "finding",
          text: "Found a slow path.",
          evidence: [{ source: `s${m}`, quote: "Found a slow path.", role: "states" }],
          anchors: [{ path: "src/f0.ts", role: "applies_to" }],
        },
      ],
    });
    const read = (file: string) =>
      deliver(
        {
          hook_event_name: "PreToolUse",
          session_id: "budget",
          cwd: repo,
          tool_name: "Read",
          tool_input: { file_path: path.join(repo, file) },
        },
        "claude-code",
        db.file,
      );
    const out: string[] = [];
    for (let n = 0; n < 12; n++) out.push(await read(`src/f${n}.ts`));
    assert.doesNotMatch(out[0] ?? "", /slow/, "a finding is not delivered on a read");
    const shown = out.filter(Boolean);
    assert.ok(shown.length >= 1 && shown.length < 12, `${shown.length} reads delivered`);
    assert.ok(shown.join("").length <= 3000, `${shown.join("").length} chars over the session`);
    assert.ok(shown.length <= 8);
  } finally {
    await db.done();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// Only `..` itself or `../...` leave the repository; a folder named `..config` is inside it
test("an edit under a folder whose name starts with two dots is delivered", async () => {
  const db = tempDb();
  const repo = checkout();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "Keep the config flat." });
    await save(db, p, {
      units: [
        decided("flat", m, "Keep the config flat.", {
          anchors: [{ path: "..config/app.ts", role: "applies_to" }],
        }),
      ],
    });
    const out = await deliver(
      {
        hook_event_name: "PreToolUse",
        session_id: "dots",
        cwd: repo,
        tool_name: "Edit",
        tool_input: { file_path: path.join(repo, "..config", "app.ts") },
      },
      "claude-code",
      db.file,
    );
    assert.match(out, /Keep the config flat/);
  } finally {
    await db.done();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a read shows at most 5 records, and reads over a session at most 8, even when the text would fit", async () => {
  const db = tempDb();
  const repo = checkout();
  try {
    const p = project(db);
    const rules = Array.from({ length: 17 }, (_, n) => `Short rule ${n}.`);
    const m = message(db, p, { id: "m1", text: rules.join(" ") });
    await save(db, p, {
      units: rules.map((r, n) =>
        decided(`s${n}`, m, r, {
          anchors: [{ path: n < 7 ? "src/many.ts" : `src/g${n}.ts`, role: "applies_to" }],
        }),
      ),
    });
    const read = (file: string, session: string) =>
      deliver(
        {
          hook_event_name: "PreToolUse",
          session_id: session,
          cwd: repo,
          tool_name: "Read",
          tool_input: { file_path: path.join(repo, file) },
        },
        "claude-code",
        db.file,
      );
    const lines = (text: string) => text.split("\n").filter((l) => l.startsWith("- ")).length;
    assert.equal(lines(await read("src/many.ts", "one")), 5, "one read shows at most 5 records");
    let total = 0;
    for (let n = 7; n < 17; n++) total += lines(await read(`src/g${n}.ts`, "many"));
    assert.equal(total, 8, "reads over one session show at most 8 records");
  } finally {
    await db.done();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("reads and edits carry each record's reason and rejected options, edits ask for a check, prompts stay short", async () => {
  const db = tempDb();
  const repo = checkout();
  try {
    const p = project(db);
    const m = message(db, p, {
      id: "m1",
      text: "Keep search as it is. Each candidate was measured over 3 runs. Fusion lowered direct answers. Trigram cost more. Regex was slow. Prefix too.",
    });
    const why = `Each candidate was measured over 3 runs. ${"x".repeat(300)}`;
    await save(db, p, {
      units: [
        decided("keep", m, "Keep search as it is.", {
          kind: "decision",
          why,
          options: [
            { text: "multi-phrasing fusion", outcome: "rejected" },
            { text: "trigram", outcome: "rejected" },
            { text: "regex", outcome: "rejected" },
            { text: "prefix syntax", outcome: "rejected" },
            { text: "as it is", outcome: "chosen" },
          ],
          anchors: [{ path: "src/search.ts", symbol: "search", role: "applies_to" }],
        }),
        decided("bare", m, "Fusion lowered direct answers.", {
          anchors: [{ path: "src/search.ts", role: "applies_to" }],
        }),
      ],
    });
    const at = (session: string, input: Record<string, unknown>) =>
      deliver({ session_id: session, cwd: repo, ...input }, "claude-code", db.file);
    const tool = (session: string, name: string) =>
      at(session, {
        hook_event_name: "PreToolUse",
        tool_name: name,
        tool_input: { file_path: path.join(repo, "src/search.ts") },
      });
    const read = await tool("r", "Read");
    assert.match(read, /trace:ext-s1\/keep .*Why: Each candidate was measured over 3 runs\. x+…/);
    assert.match(read, /Rejected: multi-phrasing fusion; trigram; regex \(\+1 more\)/);
    assert.doesNotMatch(read, /as it is;|Rejected: .*as it is/, "a chosen option is not listed as rejected");
    assert.match(
      read,
      /trace:ext-s1\/bare \(constraint do\): Fusion lowered direct answers\.$/m,
      "no reason, nothing added",
    );
    const edit = await tool("e", "Edit");
    assert.match(edit, /Check this change against them: if it seems to go against one/);
    assert.match(edit, /not an instruction/);
    assert.match(edit, /Why: /);
    assert.doesNotMatch(read, /Check this change/);
    const prompt = await at("p", { hook_event_name: "UserPromptSubmit", prompt: "search() を直したい" });
    assert.match(prompt, /trace:ext-s1\/keep/);
    assert.doesNotMatch(prompt, /Why:|Rejected:/);
  } finally {
    await db.done();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("an unavailable database is said once per session before an edit, never passed off as nothing, and prompts stay quiet", async () => {
  const repo = checkout();
  try {
    const missing = path.join(repo, "none.db");
    const session = `gone-${Date.now()}`;
    const edit = () =>
      deliver(
        {
          hook_event_name: "PreToolUse",
          session_id: session,
          cwd: repo,
          tool_name: "Write",
          tool_input: { file_path: "src/db.ts" },
        },
        "claude-code",
        missing,
      );
    assert.match(
      await edit(),
      /^Sphica unavailable: no database at .*Past decisions for src\/db\.ts could not be checked/,
    );
    assert.equal(await edit(), "");
    assert.equal(
      await deliver(
        { hook_event_name: "UserPromptSubmit", session_id: session, cwd: repo, prompt: "x" },
        "claude-code",
        missing,
      ),
      "",
    );
    assert.equal(
      await deliver(
        {
          hook_event_name: "PreToolUse",
          session_id: session,
          cwd: os.tmpdir(),
          tool_name: "Edit",
          tool_input: { file_path: "a.ts" },
        },
        "claude-code",
        missing,
      ),
      "",
      "outside a project there is nothing to check",
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// The hook runs as its own process: it must answer with the host's JSON shape, and print nothing when there is nothing to say
test("the delivery hook process answers with additionalContext, and prints nothing when nothing applies", () => {
  const repo = checkout();
  try {
    const run = (input: Record<string, unknown>) =>
      execFileSync(process.execPath, [path.join(import.meta.dirname, "..", "src", "deliver.ts")], {
        input: JSON.stringify({ session_id: `proc-${Date.now()}`, cwd: repo, ...input }),
        env: {
          PATH: process.env.PATH ?? "",
          HOME: repo,
          USERPROFILE: repo,
          SPHICA_DB: path.join(repo, "none.db"),
        },
        encoding: "utf8",
      });
    const out = JSON.parse(
      run({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "a.ts" } }),
    );
    assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.match(out.hookSpecificOutput.additionalContext, /Sphica unavailable/);
    assert.equal(run({ hook_event_name: "UserPromptSubmit", prompt: "hi" }), "");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a constraint anchored only as evidence is a standing constraint at session start", async () => {
  const db = tempDb();
  const repo = checkout();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "Never log tokens." });
    await save(db, p, {
      units: [
        decided("no-token-logs", m, "Never log tokens.", {
          anchors: [{ path: "src/log.ts", role: "evidence" }],
        }),
      ],
    });
    const start = await deliver(
      { hook_event_name: "SessionStart", session_id: crypto.randomUUID(), cwd: repo, source: "startup" },
      "claude-code",
      db.file,
    );
    assert.match(start, /no-token-logs/);
  } finally {
    await db.done();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
