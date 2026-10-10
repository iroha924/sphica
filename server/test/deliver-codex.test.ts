// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Automatic delivery in Codex against real SQLite and a git checkout: apply_patch edits bring the records anchored to every patched path at once,
// and a shell command that names an anchored path brings its decisions once per session, worded as named rather than read.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { inTransaction } from "../src/db.ts";
import { CONFIRM, deliver } from "../src/deliver.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { openRun } from "../src/trace.ts";
import { message, project, type TempDb, tempDb } from "./temp-db.ts";

const saved = { parent: process.env.SPHICA_PARENT_SESSION, entry: process.env.CLAUDE_CODE_ENTRYPOINT };
before(() => {
  delete process.env.SPHICA_PARENT_SESSION;
  delete process.env.CLAUDE_CODE_ENTRYPOINT;
});
after(() => {
  if (saved.parent !== undefined) process.env.SPHICA_PARENT_SESSION = saved.parent;
  if (saved.entry !== undefined) process.env.CLAUDE_CODE_ENTRYPOINT = saved.entry;
});

function checkout(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-codex-")));
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

const decided = (key: string, source: number, quote: string, anchors: string[]) => ({
  key,
  kind: "decision",
  stance: "do",
  text: quote,
  evidence: [{ source: `s${source}`, quote, role: "states" }],
  adoption: [{ source: `s${source}`, quote }],
  anchors: anchors.map((p) => ({ path: p, role: "applies_to" })),
});

async function world() {
  const db = tempDb();
  const repo = checkout();
  const p = project(db);
  const m = message(db, p, {
    id: "m1",
    text: "Store UTC. Keep one SQLite file. Open lazily. Share the schema.",
  });
  await save(db, p, {
    units: [
      decided("utc", m, "Store UTC.", ["src/dates.ts"]),
      decided("sqlite", m, "Keep one SQLite file.", ["src/db.ts"]),
      decided("opener", m, "Open lazily.", ["src/open.ts"]),
      decided("schema", m, "Share the schema.", ["src/a.ts", "src/b.ts"]),
    ],
  });
  const session = crypto.randomUUID();
  const run = (input: Record<string, unknown>) =>
    deliver({ session_id: session, cwd: repo, ...input } as never, "codex", db.file);
  const patch = (text: string, extra: Record<string, unknown> = {}) =>
    run({ hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: text }, ...extra });
  const bash = (command: string, extra: Record<string, unknown> = {}) =>
    run({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, ...extra });
  return {
    db,
    repo,
    run,
    patch,
    bash,
    done: async () => {
      await db.done();
      fs.rmSync(repo, { recursive: true, force: true });
    },
  };
}

test("an apply_patch edit brings the records for every patched path once, both ends of a move included", async () => {
  const w = await world();
  try {
    const out = await w.patch(
      [
        "*** Begin Patch",
        "*** Update File: src/dates.ts",
        "@@",
        "-a",
        "+b",
        "*** Delete File: src/db.ts",
        "*** Update File: src/old.ts",
        "*** Move to: src/open.ts",
        "*** Add File: src/a.ts",
        "+x",
        "*** Update File: src/b.ts",
        "*** Add File: ../outside.ts",
        "+y",
        "*** End Patch",
      ].join("\n"),
    );
    for (const key of ["utc", "sqlite", "opener", "schema"])
      assert.match(out, new RegExp(`trace:ext-s1/${key} `));
    assert.equal(
      out.match(/trace:ext-s1\/schema /g)?.length,
      1,
      "a record anchored to two patched paths shows once",
    );
    assert.match(out, /current code relevance unverified/);
    assert.ok(out.length <= 1500);
    assert.equal(await w.patch("*** Begin Patch\n*** Update File: src/other.ts\n*** End Patch"), "");
  } finally {
    await w.done();
  }
});

test("a shell command naming an anchored path brings it once, never on a longer name, and a later edit still does", async () => {
  const w = await world();
  try {
    assert.equal(await w.bash("cat src/dates.ts.bak && ls src/dates"), "", "only a whole path token counts");
    const named = await w.bash("sed -n '1,80p' src/dates.ts");
    assert.match(named, /trace:ext-s1\/utc /);
    assert.match(named, /which this command names/);
    assert.doesNotMatch(named, /which you are reading/);
    assert.equal(
      await w.bash(`rg open ${path.join(w.repo, "src", "dates.ts")}`),
      "",
      "shown once per session",
    );
    assert.match(
      await w.bash(`cat ${path.join(w.repo, "src", "db.ts")}`),
      /trace:ext-s1\/sqlite /,
      "an absolute path counts",
    );
    assert.match(
      await w.patch("*** Begin Patch\n*** Update File: src/dates.ts\n*** End Patch"),
      /trace:ext-s1\/utc /,
      "the edit reminder still comes",
    );
    assert.equal(await w.bash("npm test"), "");
  } finally {
    await w.done();
  }
});

test("Codex subagents still get path records, prompts stay the owner's, and deliveries are logged for Codex", async () => {
  const w = await world();
  try {
    assert.match(
      await w.patch("*** Begin Patch\n*** Update File: src/db.ts\n*** End Patch", {
        agent_id: "sub",
        agent_type: "worker",
      }),
      /trace:ext-s1\/sqlite /,
    );
    assert.equal(
      await w.run({ hook_event_name: "UserPromptSubmit", prompt: "src/db.ts を直す", agent_id: "sub" }),
      "",
    );
    assert.match(await w.run({ hook_event_name: "UserPromptSubmit", prompt: "src/db.ts を直す" }), /sqlite/);
    const hosts = w.db.owner
      .prepare("select distinct s.host from delivery d join session s on s.id = d.session_id")
      .all()
      .map((r) => r.host);
    assert.deepEqual(hosts, ["codex"]);
  } finally {
    await w.done();
  }
});

test("a shell command names a path as ./path, relative to a subdirectory, or with backslashes; a shell-run patch is an edit", async () => {
  const w = await world();
  try {
    assert.match(await w.bash("sed -n '1,80p' ./src/dates.ts"), /trace:ext-s1\/utc /);
    fs.mkdirSync(path.join(w.repo, "src"), { recursive: true });
    assert.match(
      await w.run({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "cat db.ts" },
        cwd: path.join(w.repo, "src"),
      }),
      /trace:ext-s1\/sqlite /,
    );
    assert.match(await w.bash("Get-Content src\\open.ts"), /trace:ext-s1\/opener /);
    const edit =
      "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: src/dates.ts\n@@\n-a\n+b\n*** End Patch\nEOF";
    const out = await w.bash(edit);
    assert.match(
      out,
      /trace:ext-s1\/utc /,
      "a patch run through the shell is still an edit, even after a read showed the record",
    );
    assert.doesNotMatch(out, /which this command names/);
  } finally {
    await w.done();
  }
});

test("a long lead or a rich record never empties an edit delivery: a line that does not fit is shortened or skipped", async () => {
  const db = tempDb();
  const repo = checkout();
  try {
    const p = project(db);
    const dirs = [1, 2, 3].map((n) => `src/${String(n).repeat(150)}/f.ts`);
    const long = "Keep the long rule as written here. ".repeat(8).trim();
    const why = "Because it was measured again and again. ".repeat(8).trim();
    const m = message(db, p, { id: "m1", text: `${long} ${why} Short rule.` });
    await save(db, p, {
      units: [
        decided("short", m, "Short rule.", dirs),
        {
          ...decided("rich", m, long, dirs),
          why,
          options: [1, 2, 3, 4].map((n) => ({ text: `${"option ".repeat(10)}${n}`, outcome: "rejected" })),
        },
      ],
    });
    const out = await deliver(
      {
        session_id: crypto.randomUUID(),
        cwd: repo,
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        tool_input: {
          command: `*** Begin Patch\n${dirs.map((d) => `*** Update File: ${d}`).join("\n")}\n*** End Patch`,
        },
      } as never,
      "codex",
      db.file,
    );
    assert.ok(out.length > 0 && out.length <= 1500 + CONFIRM.length + 1, `${out.length} chars`);
    assert.match(out, /trace:ext-s1\/rich /);
    assert.match(out, /trace:ext-s1\/short /, "a shorter record after a long one still fits");
  } finally {
    await db.done();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
