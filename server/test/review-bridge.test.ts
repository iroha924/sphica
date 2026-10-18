// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The bridge into the user's own review commands, against real SQLite and a real git checkout: which reviews get the applicable
// decisions, which stay quiet, and when it says it could not check instead of pretending nothing applies.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { CodexThread } from "../src/codex-log.ts";
import { inTransaction } from "../src/db.ts";
import { deliver } from "../src/deliver.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { codexReviewCall, localChange, untrackedFiles } from "../src/review-bridge.ts";
import { openRun } from "../src/trace.ts";
import { childLog, codexLog } from "./codex-log-file.ts";
import { message, project, type TempDb, tempDb } from "./temp-db.ts";
import { ownTmpdir } from "./temp-dir.ts";

// The review hook marks a session once in the shared temp directory; these marks go to a directory of this file's own
ownTmpdir("sphica-deliver-tmp-");

const saved = {
  parent: process.env.SPHICA_PARENT_SESSION,
  entry: process.env.CLAUDE_CODE_ENTRYPOINT,
  names: process.env.SPHICA_REVIEW_COMMANDS,
  option: process.env.CLAUDE_PLUGIN_OPTION_REVIEW_COMMANDS,
};
before(() => {
  delete process.env.SPHICA_PARENT_SESSION;
  delete process.env.CLAUDE_CODE_ENTRYPOINT;
  delete process.env.SPHICA_REVIEW_COMMANDS;
  delete process.env.CLAUDE_PLUGIN_OPTION_REVIEW_COMMANDS;
});
after(() => {
  for (const [k, v] of [
    ["SPHICA_PARENT_SESSION", saved.parent],
    ["CLAUDE_CODE_ENTRYPOINT", saved.entry],
    ["SPHICA_REVIEW_COMMANDS", saved.names],
    ["CLAUDE_PLUGIN_OPTION_REVIEW_COMMANDS", saved.option],
  ] as const)
    if (v !== undefined) process.env[k] = v;
});

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

/** A checkout whose default branch (origin/HEAD) holds src/db.ts and src/old.ts, on a feature branch. */
function checkout(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-bridge-")));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "remote", "add", "origin", "https://github.com/o/r.git");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "db.ts"), "export const open = () => 1;\n");
  fs.writeFileSync(path.join(dir, "src", "old.ts"), "export const old = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(dir, "switch", "-q", "-c", "feature");
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
  kind: "decision",
  stance: "do",
  text: quote,
  evidence: [{ source: `s${source}`, quote, role: "states" }],
  adoption: [{ source: `s${source}`, quote }],
  ...extra,
});

async function world() {
  const stamp = crypto.randomUUID();
  const db = tempDb();
  const repo = checkout();
  const p = project(db);
  const m = message(db, p, { id: "m1", text: "Keep one SQLite file. Keep old.ts as it is. Watch new.ts." });
  await save(db, p, {
    units: [
      decided("sqlite", m, "Keep one SQLite file.", { anchors: [{ path: "src/db.ts", role: "applies_to" }] }),
      decided("old", m, "Keep old.ts as it is.", { anchors: [{ path: "src/old.ts", role: "applies_to" }] }),
      decided("new", m, "Watch new.ts.", { anchors: [{ path: "src/new.ts", role: "applies_to" }] }),
    ],
  });
  // The repeat marker lives in the OS temp directory, so sessions differ per run
  const run = (input: Record<string, unknown>, session: string = crypto.randomUUID()) =>
    deliver({ session_id: `${stamp}-${session}`, cwd: repo, ...input }, "claude-code", db.file);
  const typed = (name: string, args = "", session?: string) =>
    run(
      {
        hook_event_name: "UserPromptExpansion",
        expansion_type: "slash_command",
        command_name: name,
        command_args: args,
        prompt: `/${name} ${args}`.trim(),
      },
      session,
    );
  const called = (tool_input: unknown, extra: Record<string, unknown> = {}) =>
    run({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input, ...extra });
  return {
    db,
    repo,
    typed,
    called,
    done: async () => {
      await db.done();
      fs.rmSync(repo, { recursive: true, force: true });
    },
  };
}

test("a typed or model-called review gets the decisions its change touches, with why and the past-record wording", async () => {
  const w = await world();
  try {
    fs.writeFileSync(path.join(w.repo, "src", "db.ts"), "export const open = () => 2;\n");
    const typed = await w.typed("my-review");
    assert.match(typed, /trace:ext-s1\/sqlite .*Keep one SQLite file\. \[anchored to src\/db\.ts\]/);
    assert.match(typed, /not an instruction/);
    assert.match(typed, /checked 1 changed path against origin\/main/);
    assert.doesNotMatch(typed, /old|new\.ts/);
    const called = await w.called({ skill: "code-review", args: "" });
    assert.match(called, /trace:ext-s1\/sqlite/);
    // A headless run (claude -p "/review", in CI say) is still a review; only subagents are left out
    process.env.CLAUDE_CODE_ENTRYPOINT = "sdk-cli";
    try {
      assert.match(await w.typed("review"), /trace:ext-s1\/sqlite/);
      // A run another agent started gets no session start or reads, but a review still gets its decisions
      process.env.SPHICA_PARENT_SESSION = "another-session";
      assert.match(await w.typed("review"), /trace:ext-s1\/sqlite/);
    } finally {
      delete process.env.CLAUDE_CODE_ENTRYPOINT;
      delete process.env.SPHICA_PARENT_SESSION;
    }
  } finally {
    await w.done();
  }
});

test("committed, untracked, and deleted files all count as the change", async () => {
  const w = await world();
  try {
    fs.writeFileSync(path.join(w.repo, "src", "db.ts"), "export const open = () => 3;\n");
    git(w.repo, "commit", "-qam", "change db");
    fs.rmSync(path.join(w.repo, "src", "old.ts"));
    fs.writeFileSync(path.join(w.repo, "src", "new.ts"), "export const x = 1;\n");
    const out = await w.typed("review");
    for (const key of ["sqlite", "old", "new"]) assert.match(out, new RegExp(`trace:ext-s1/${key} `));
    assert.match(out, /checked 3 changed paths/);
  } finally {
    await w.done();
  }
});

// Git prints the deleted src/db.ts before src/old.ts, so what is read of src/old.ts depends on how the deleted file's hunk is counted
test("a file that follows a deleted one in git's diff keeps its added lines, and a record one of them names is delivered", async () => {
  const db = tempDb();
  const repo = checkout();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "No mongoClient." });
    await save(db, p, {
      units: [
        decided("no-mongo", m, "No mongoClient.", {
          stance: "dont",
          options: [{ text: "mongoClient", outcome: "rejected" }],
        }),
      ],
    });
    fs.rmSync(path.join(repo, "src", "db.ts"));
    fs.appendFileSync(path.join(repo, "src", "old.ts"), "export const client = mongoClient;\n");
    assert.deepEqual(git(repo, "diff", "--name-only", "origin/main").split("\n").filter(Boolean), [
      "src/db.ts",
      "src/old.ts",
    ]);
    const change = await localChange(repo, "");
    const text = await deliver(
      {
        session_id: crypto.randomUUID(),
        cwd: repo,
        hook_event_name: "UserPromptExpansion",
        expansion_type: "slash_command",
        command_name: "review",
        command_args: "",
        prompt: "/review",
      },
      "claude-code",
      db.file,
    );
    assert.deepEqual(
      { files: "files" in change ? change.files : change, delivered: /trace:ext-s1\/no-mongo /.test(text) },
      {
        files: [
          { path: "src/db.ts", added: [], lines: [], gone: true },
          { path: "src/old.ts", added: ["export const client = mongoClient;"], lines: [2] },
        ],
        delivered: true,
      },
    );
  } finally {
    await db.done();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// An untracked symlink is a path only (Git adds the link, not its target); only regular files are read
test("an untracked symlink counts as a path without reading what it points to", async () => {
  const w = await world();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "note.txt"), "send telemetry\n");
    fs.symlinkSync(path.join(outside, "note.txt"), path.join(w.repo, "link.txt"));
    const change = await localChange(w.repo, "");
    assert.ok(!("problem" in change));
    const files = "files" in change ? change.files : [];
    assert.deepEqual(
      files.filter((f) => f.path === "link.txt").map((f) => [f.path, f.added]),
      [["link.txt", []]],
    );
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    await w.done();
  }
});

test("other commands, Sphica's own review, and subagents stay quiet; SPHICA_REVIEW_COMMANDS adds names", async () => {
  const w = await world();
  try {
    fs.writeFileSync(path.join(w.repo, "src", "db.ts"), "export const open = () => 4;\n");
    assert.equal(await w.typed("deploy"), "");
    assert.equal(await w.typed("sphica:review"), "");
    assert.equal(await w.called({ skill: "sphica:review" }), "");
    assert.equal(
      await w.called({ skill: "my-review" }, { agent_id: "sub" }),
      "",
      "only the parent session is told",
    );
    assert.equal(await w.called({ skill: 42 }), "", "an input of unknown shape is not read");
    assert.equal(await w.called({ skill: "x".repeat(500) }), "");
    assert.equal(await w.typed("audit"), "");
    process.env.SPHICA_REVIEW_COMMANDS = "audit, check-pr";
    try {
      assert.match(await w.typed("audit"), /trace:ext-s1\/sqlite/);
    } finally {
      delete process.env.SPHICA_REVIEW_COMMANDS;
    }
  } finally {
    await w.done();
  }
});

test("the plugin's review_commands names the review commands; without a name in it, SPHICA_REVIEW_COMMANDS does", async () => {
  const w = await world();
  try {
    fs.writeFileSync(path.join(w.repo, "src", "db.ts"), "export const open = () => 5;\n");
    process.env.SPHICA_REVIEW_COMMANDS = " DePloy , , Check-ENV ";
    try {
      process.env.CLAUDE_PLUGIN_OPTION_REVIEW_COMMANDS = " Audit ,check-pr ";
      assert.match(await w.typed("audit"), /trace:ext-s1\/sqlite/);
      assert.match(await w.called({ skill: "Check-PR" }), /trace:ext-s1\/sqlite/);
      assert.equal(await w.typed("deploy"), "", "a name only in the environment variable is not used");
      assert.equal(await w.called({ skill: "deploy" }), "");
      for (const empty of [undefined, "", "   ", " , ,"]) {
        if (empty === undefined) delete process.env.CLAUDE_PLUGIN_OPTION_REVIEW_COMMANDS;
        else process.env.CLAUDE_PLUGIN_OPTION_REVIEW_COMMANDS = empty;
        const label = `option ${JSON.stringify(empty)}`;
        for (const name of ["deploy", "check-env"]) {
          assert.match(await w.typed(name), /trace:ext-s1\/sqlite/, `${label}, ${name}`);
          assert.match(await w.called({ skill: name }), /trace:ext-s1\/sqlite/, `${label}, ${name}`);
        }
        assert.equal(await w.typed("audit"), "", label);
      }
      // A setting holding only names no command can have does not hide the environment variable
      process.env.CLAUDE_PLUGIN_OPTION_REVIEW_COMMANDS = "@, code review";
      assert.match(await w.typed("deploy"), /trace:ext-s1\/sqlite/, "malformed option names");
      assert.match(await w.called({ skill: "check-env" }), /trace:ext-s1\/sqlite/, "malformed option names");
    } finally {
      delete process.env.SPHICA_REVIEW_COMMANDS;
      delete process.env.CLAUDE_PLUGIN_OPTION_REVIEW_COMMANDS;
    }
  } finally {
    await w.done();
  }
});

test("no applicable record, no change, no base, and a PR argument each say what was checked, once per change", async () => {
  const w = await world();
  try {
    assert.match(await w.typed("review"), /no local change against origin\/main/);
    fs.writeFileSync(path.join(w.repo, "README.md"), "hi\n");
    const none = await w.typed("review", "", "same");
    assert.match(none, /checked 1 changed path against origin\/main: no active recorded decision applies/);
    assert.equal(
      await w.typed("review", "", "same"),
      "",
      "the same change is not reported twice in a session",
    );
    fs.writeFileSync(path.join(w.repo, "README.md"), "hello\n");
    assert.match(
      await w.typed("review", "", "same"),
      /checked 1 changed path/,
      "an edited change with the same answer is still checked again",
    );
    fs.writeFileSync(path.join(w.repo, "src", "db.ts"), "export const open = () => 5;\n");
    assert.match(
      await w.typed("review", "", "same"),
      /trace:ext-s1\/sqlite/,
      "a changed diff is reported again",
    );
    assert.match(await w.typed("review", "123"), /could not check .*pull request/);
    assert.match(await w.typed("review", "https://github.com/o/r/pull/9"), /could not check .*pull request/);
    git(w.repo, "symbolic-ref", "-d", "refs/remotes/origin/HEAD");
    assert.match(await w.typed("review"), /could not check .*no default branch/);
    const logged = w.db.owner
      .prepare("select event, outcome from delivery where event = 'review' order by id")
      .all()
      .map((r) => `${r.event}:${r.outcome}`);
    assert.ok(logged.includes("review:emitted"), logged.join(" "));
  } finally {
    await w.done();
  }
});

test("user git settings, non-ASCII and binary paths, and a number in the arguments do not change what is checked", async () => {
  const w = await world();
  try {
    git(w.repo, "config", "diff.mnemonicPrefix", "true");
    git(w.repo, "config", "diff.dstPrefix", "new/");
    fs.writeFileSync(path.join(w.repo, "src", "db.ts"), "export const open = () => 6;\n");
    assert.match(
      await w.typed("review", "focus on 2 issues"),
      /trace:ext-s1\/sqlite/,
      "a plain number is not a pull request",
    );
    git(w.repo, "checkout", "-q", "--", "src/db.ts");
    fs.writeFileSync(path.join(w.repo, "src", "old.ts"), Buffer.from([0, 1, 2, 3]));
    assert.match(await w.typed("review"), /trace:ext-s1\/old /, "a binary change still counts as a change");
  } finally {
    await w.done();
  }
});

test("a non-ASCII anchored path is matched, and a record in an unresolved conflict is held back", async () => {
  const db = tempDb();
  const repo = checkout();
  try {
    fs.writeFileSync(path.join(repo, "src", "設計.ts"), "export const a = 1;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "design");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "Design stays. Keep one SQLite file. Maybe not." });
    await save(db, p, {
      units: [
        decided("design", m, "Design stays.", { anchors: [{ path: "src/設計.ts", role: "applies_to" }] }),
        decided("sqlite", m, "Keep one SQLite file.", {
          anchors: [{ path: "src/db.ts", role: "applies_to" }],
        }),
      ],
    });
    // The owner's own words against it hold the owner's decision back until resolved
    await save(db, p, { units: [decided("q", m, "Maybe not.", { conflicts: ["trace:ext-s1/sqlite"] })] });
    fs.writeFileSync(path.join(repo, "src", "設計.ts"), "export const a = 2;\n");
    fs.writeFileSync(path.join(repo, "src", "db.ts"), "export const open = () => 7;\n");
    const out = await deliver(
      {
        hook_event_name: "UserPromptExpansion",
        expansion_type: "slash_command",
        command_name: "review",
        session_id: crypto.randomUUID(),
        cwd: repo,
      } as never,
      "claude-code",
      db.file,
    );
    assert.match(out, /trace:ext-s1\/design /);
    assert.doesNotMatch(out, /sqlite/, "a record in an unresolved conflict is held back");
  } finally {
    await db.done();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("an unwritable temporary directory never silences the review check", async () => {
  const w = await world();
  const saved = process.env.TMPDIR;
  const locked = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-locked-"));
  try {
    fs.writeFileSync(path.join(w.repo, "src", "db.ts"), "export const open = () => 8;\n");
    fs.chmodSync(locked, 0o500);
    process.env.TMPDIR = locked;
    assert.match(await w.typed("review", "", "locked"), /trace:ext-s1\/sqlite/);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    fs.chmodSync(locked, 0o700);
    fs.rmSync(locked, { recursive: true, force: true });
    await w.done();
  }
});

test("a review that leaves decisions out says how many and where to find them", async () => {
  const w = await world();
  try {
    const p = Number(w.db.owner.prepare("select id from project").get()?.id);
    const rule = (n: number) => `Keep db rule ${n}.`;
    const m = message(w.db, p, { id: "m2", text: Array.from({ length: 5 }, (_, n) => rule(n)).join(" ") });
    await save(w.db, p, {
      units: Array.from({ length: 5 }, (_, n) =>
        decided(`db${n}`, m, rule(n), { anchors: [{ path: "src/db.ts", role: "applies_to" }] }),
      ),
    });
    fs.writeFileSync(path.join(w.repo, "src", "db.ts"), "export const open = () => 2;\n");
    const out = await w.typed("my-review");
    assert.equal(out.split("\n").filter((l) => l.startsWith("- trace:")).length, 5);
    assert.equal(
      out.split("\n").at(-1),
      "- 1 more record applies here but was left out for space: find them with Sphica's search or read.",
    );
  } finally {
    await w.done();
  }
});

test("a review is never given a superseded or withdrawn record, while an active one on the same path is", async () => {
  const db = tempDb();
  const repo = checkout();
  try {
    const p = project(db);
    const m = message(db, p, {
      id: "m1",
      text: "Keep one SQLite file. Cache in memory. Log in Japanese. Cache on disk.",
    });
    await save(db, p, {
      units: [
        decided("sqlite", m, "Keep one SQLite file.", {
          anchors: [{ path: "src/db.ts", role: "applies_to" }],
        }),
        decided("memory", m, "Cache in memory.", { anchors: [{ path: "src/db.ts", role: "applies_to" }] }),
        decided("japanese", m, "Log in Japanese.", { anchors: [{ path: "src/db.ts", role: "applies_to" }] }),
      ],
    });
    await save(db, p, {
      units: [decided("disk", m, "Cache on disk.", { supersedes: "trace:ext-s1/memory" })],
    });
    const id = (key: string) =>
      db.owner.prepare("select id from unit where key = ?").get(`trace:ext-s1/${key}`)?.id;
    const run = db.owner.prepare("select max(id) as id from extraction_run").get()?.id;
    db.owner
      .prepare(
        "insert into unit_state (unit_id, from_state, to_state, at, reason, run_id) values (?, 'active', 'withdrawn', ?, 'withdrawn', ?)",
      )
      .run(id("japanese") as number, new Date().toISOString(), run as number);
    assert.deepEqual(
      db.owner
        .prepare("select key, lifecycle from unit where key in (?, ?) order by key")
        .all("trace:ext-s1/japanese", "trace:ext-s1/memory")
        .map((r) => [r.key, r.lifecycle]),
      [
        ["trace:ext-s1/japanese", "withdrawn"],
        ["trace:ext-s1/memory", "superseded"],
      ],
    );
    fs.writeFileSync(path.join(repo, "src", "db.ts"), "export const open = () => 7;\n");
    const out = await deliver(
      {
        hook_event_name: "UserPromptExpansion",
        expansion_type: "slash_command",
        command_name: "review",
        session_id: crypto.randomUUID(),
        cwd: repo,
      } as never,
      "claude-code",
      db.file,
    );
    assert.match(out, /trace:ext-s1\/sqlite /);
    assert.doesNotMatch(out, /trace:ext-s1\/(memory|japanese)/);
  } finally {
    await db.done();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("review selection keeps delivery's own rule: a location-free record in a conflict is selected but not delivered", async () => {
  const db = tempDb();
  const repo = checkout();
  try {
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "No mongoClient. No rabbitClient. Use rabbitClient." });
    const dont = (key: string, quote: string, option: string) =>
      decided(key, m, quote, { stance: "dont", options: [{ text: option, outcome: "rejected" }] });
    await save(db, p, {
      units: [
        dont("no-mongo", "No mongoClient.", "mongoClient"),
        dont("no-rabbit", "No rabbitClient.", "rabbitClient"),
      ],
    });
    await save(db, p, {
      units: [decided("use-rabbit", m, "Use rabbitClient.", { conflicts: ["trace:ext-s1/no-rabbit"] })],
    });
    fs.writeFileSync(
      path.join(repo, "src", "db.ts"),
      "export const open = () => mongoClient ?? rabbitClient;\n",
    );
    const text = await deliver(
      {
        session_id: crypto.randomUUID(),
        cwd: repo,
        hook_event_name: "UserPromptExpansion",
        expansion_type: "slash_command",
        command_name: "review",
        command_args: "",
        prompt: "/review",
      },
      "claude-code",
      db.file,
    );
    assert.match(text, /trace:ext-s1\/no-mongo/);
    assert.doesNotMatch(text, /no-rabbit/);
  } finally {
    await db.done();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

/** Runs fn with HOME moved to dir, and puts it back */
async function withHomeAt<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
}

test("a review says why the git worker would not start, and keeps the slow-or-large wording for those two", async () => {
  const w = await world();
  try {
    fs.writeFileSync(path.join(w.repo, "src", "db.ts"), "export const open = () => 2;\n");
    // A home inside the temp directory: the worker refuses to keep its git folder where an agent can write
    const inTmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-bridge-home-")));
    try {
      const why =
        "Sphica's git worker would not start, because Sphica's git folder (.sphica/git under your home directory) overlaps the temp directory, which an agent can write (run sphica doctor in this work tree)";
      await withHomeAt(inTmp, async () => {
        assert.deepEqual(await localChange(w.repo, ""), { problem: why });
        for (const reply of [
          await w.typed("my-review"),
          await w.called({ skill: "code-review", args: "" }),
        ]) {
          assert.ok(
            reply.includes(`Sphica could not check this review against past decisions: ${why}.`),
            reply,
          );
          assert.doesNotMatch(reply, /in time|too large/);
          // The places are named by what they are, never by their paths
          assert.ok(!reply.includes(inTmp), reply);
        }
      });
    } finally {
      fs.rmSync(inTmp, { recursive: true, force: true });
    }
    // The work tree as the home: the git folder would sit inside what the agent edits
    await withHomeAt(w.repo, async () => {
      const got = await localChange(w.repo, "");
      assert.ok(
        "problem" in got && got.problem.includes("overlaps this work tree, which an agent can write"),
        JSON.stringify(got),
      );
    });
    fs.rmSync(path.join(w.repo, ".sphica"), { recursive: true, force: true });
    // A change past the size limit still gets the wording that names time and size
    fs.writeFileSync(path.join(w.repo, "src", "db.ts"), `${"x".repeat(5 * 1024 * 1024)}\n`);
    assert.deepEqual(await localChange(w.repo, ""), {
      problem:
        "the change could not be read in time, or is too large to read (over 4 MB of diff or file names)",
    });
  } finally {
    await w.done();
  }
});

test("a change git cannot read is called a failure of git, not a slow or large change", async () => {
  const w = await world();
  try {
    fs.writeFileSync(path.join(w.repo, "src", "db.ts"), "export const open = () => 2;\n");
    // The commit HEAD names is gone: git fails at once
    const head = git(w.repo, "rev-parse", "HEAD").trim();
    const base = git(w.repo, "merge-base", "HEAD", "origin/main").trim();
    assert.equal(head, base);
    const tree = git(w.repo, "rev-parse", "HEAD^{tree}").trim();
    fs.rmSync(path.join(w.repo, ".git", "objects", tree.slice(0, 2), tree.slice(2)));
    assert.deepEqual(await localChange(w.repo, ""), {
      problem: "the change could not be read (git failed or could not be started)",
    });
  } finally {
    await w.done();
  }
});

test("a Codex review is its built-in review's child thread, a skill named in the prompt, or a skill file a shell command names", () => {
  const own: CodexThread = {
    id: "cx",
    originator: "codex-tui",
    threadSource: "user",
    parent: null,
    subagent: null,
  };
  const child = (subagent: string | null, parent = "cx"): CodexThread => ({
    id: "cx-child",
    originator: "codex-tui",
    threadSource: "subagent",
    parent,
    subagent,
  });
  const prompt = (text: string, thread: CodexThread | null = own, extra: Record<string, unknown> = {}) =>
    codexReviewCall(
      { hook_event_name: "UserPromptSubmit", session_id: "cx", prompt: text, ...extra },
      thread,
    );
  const shell = (command: string, mine: string[] = [], extra: Record<string, unknown> = {}) =>
    codexReviewCall(
      {
        hook_event_name: "PreToolUse",
        session_id: "cx",
        tool_name: "Bash",
        tool_input: { command },
        ...extra,
      },
      own,
      mine,
    );
  const fixed =
    "Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.";
  try {
    // The built-in review: Codex writes the prompt, so what it says is not read, a skill's name in custom instructions included
    assert.deepEqual(prompt(fixed, child("review")), { name: "review", args: "" });
    assert.deepEqual(prompt("Check $sphica:review and #12", child("review")), { name: "review", args: "" });
    // Another kind of child, another session's child, and a subagent the host names are no review of this conversation
    assert.equal(prompt("$my-review this", child(null)), null);
    assert.equal(prompt(fixed, child("review", "another-session")), null);
    assert.equal(prompt(fixed, child("review"), { agent_id: "sub" }), null);
    assert.equal(prompt("$my-review this", own, { agent_id: "sub" }), null);

    // A skill named in the prompt: the whole prompt is its arguments, as a pull request named in it must be seen
    assert.deepEqual(prompt("$my-review check #12"), { name: "my-review", args: "$my-review check #12" });
    assert.deepEqual(prompt("please run\n$Code-Review."), {
      name: "Code-Review",
      args: "please run\n$Code-Review.",
    });
    assert.deepEqual(prompt("$deploy then $team:review-all now")?.name, "team:review-all");
    assert.equal(prompt("x".repeat(2000) + " $my-review")?.args.length, 1000);
    // A log that says nothing does not stop a named skill: the name is in the owner's own prompt
    assert.equal(prompt("$my-review", null)?.name, "my-review");
    assert.equal(prompt("$sphica:review the change"), null);
    assert.equal(prompt("the price is a$review"), null);
    assert.equal(prompt("$deploy and $lint-all"), null);
    // What shells write as a variable is no skill
    for (const text of [
      "cd $REVIEW_DIR and run the tests",
      "why is $PREVIEW_URL empty in CI?",
      "set $CODE_REVIEW_TOKEN",
    ])
      assert.equal(prompt(text), null, text);
    assert.equal(prompt("review the change"), null);
    assert.equal(prompt(""), null);

    // Names beyond those holding "review" come from the environment alone; Claude Code's plugin setting is not Codex's
    process.env.SPHICA_REVIEW_COMMANDS = "deploy, Lint-All, not a name";
    process.env.CLAUDE_PLUGIN_OPTION_REVIEW_COMMANDS = "audit";
    assert.equal(prompt("$deploy now")?.name, "deploy");
    assert.equal(prompt("$lint-all")?.name, "lint-all");
    assert.equal(prompt("$audit"), null);
    assert.equal(shell("cat ~/.codex/skills/deploy/SKILL.md")?.name, "deploy");
    delete process.env.SPHICA_REVIEW_COMMANDS;
    delete process.env.CLAUDE_PLUGIN_OPTION_REVIEW_COMMANDS;

    // A skill the model picks: one plain command that prints the skill's file, in any reader and either slash
    assert.deepEqual(shell("cat /home/u/.codex/skills/my-review/SKILL.md"), { name: "my-review", args: "" });
    assert.equal(shell("cat .agents/skills/my-review/SKILL.md")?.name, "my-review");
    assert.equal(shell("nl -ba plugin/skills/code-review/SKILL.md")?.name, "code-review");
    assert.equal(shell("  /bin/cat ~/.codex/skills/my-review/SKILL.md docs/notes.md")?.name, "my-review");
    assert.equal(shell('cat "$HOME/.codex/skills/my-review/SKILL.md"')?.name, "my-review");
    assert.equal(shell("head -80 .codex/skills/review/SKILL.md\n")?.name, "review");
    assert.equal(shell(`type "C:\\Users\\u\\.codex\\skills\\code-review\\SKILL.md"`)?.name, "code-review");
    assert.equal(
      shell('Get-Content "C:\\Users\\John Smith\\.codex\\skills\\code-review\\SKILL.md"')?.name,
      "code-review",
    );
    assert.equal(shell("cat.exe skills\\my-review\\SKILL.md")?.name, "my-review");
    assert.equal(shell("cat ~/.codex/skills/deploy/SKILL.md"), null);
    assert.equal(shell("cat skills/my-review/SKILL.md.bak"), null);
    assert.equal(shell("cat skills/my-review/README.md"), null);
    assert.equal(shell("npm test"), null);
    assert.equal(shell("cat skills/my-review/SKILL.md", [], { agent_id: "sub" }), null);
    // Naming a skill's file is not reading the skill: finding, staging, and counting it are no review
    for (const command of [
      "find . -path '*/skills/code-review/SKILL.md'",
      "git add skills/my-review/SKILL.md",
      "rg -l TODO plugin/skills/review/SKILL.md",
      "wc -l .claude/skills/codex-review/SKILL.md",
      "git diff -- skills/my-review/SKILL.md",
      "echo cat skills/my-review/SKILL.md",
      // sed prints a file and also rewrites one in place, so it is not taken for a reader at all
      "sed -n '1,80p' skills/my-review/SKILL.md",
      "sed -i 's/old/new/' skills/my-review/SKILL.md",
      "sed -i '' -e 's/a/b/' .codex/skills/code-review/SKILL.md",
      "sed -i 's#skills/my-review/SKILL.md#skills/code-review/SKILL.md#' README.md",
      "tee skills/my-review/SKILL.md",
      // A pager can write what it is shown into the file it names, and no agent pages a file it reads
      "less -O skills/my-review/SKILL.md -",
      "less skills/my-review/SKILL.md",
      "more skills/my-review/SKILL.md",
      "bat skills/my-review/SKILL.md",
      "cp notes.md skills/my-review/SKILL.md",
    ])
      assert.equal(shell(command), null, command);
    // A line that chains, pipes, redirects, substitutes, or runs to a second line is not read: what it prints is not told without a
    // shell's grammar, so a skill read that way gets no review, and a write is never taken for a read
    for (const command of [
      "cd /repo && cat .codex/skills/review/SKILL.md",
      "cat skills/my-review/SKILL.md | head -50",
      "git status; cat skills/my-review/SKILL.md",
      "git status\ncat skills/my-review/SKILL.md",
      "# Read the skill's instructions\ncat skills/my-review/SKILL.md",
      "sed -n '1,200p;201q' skills/my-review/SKILL.md",
      "cat 2>/dev/null skills/my-review/SKILL.md",
      "cat skills/my-review/SKILL.md > /tmp/copy.md",
      "cat notes.md > skills/my-review/SKILL.md",
      'cat notes.md >> "/Users/John Smith/.codex/skills/my-review/SKILL.md"',
      "cat > skills/review/SKILL.md <<'EOF'",
      "cat <<EOF\ncat skills/my-review/SKILL.md\nEOF",
      "cat `ls skills/my-review/SKILL.md`",
      "cat $(echo skills/my-review/SKILL.md)",
    ])
      assert.equal(shell(command), null, command);
    // Sphica's own review checks the change itself: its file is told by where it is, since its directory is named review like any other
    const mine = [
      "/p/cache/sphica/sphica/0.6.53/skills/review/SKILL.md",
      "/my plugins/sphica/skills/review/SKILL.md",
    ];
    assert.equal(shell("cat /p/cache/sphica/sphica/0.6.53/skills/review/SKILL.md", mine), null);
    assert.equal(shell('cat "/my plugins/sphica/skills/review/SKILL.md"', mine), null);
    assert.equal(shell("cat /p/cache/other/skills/review/SKILL.md", mine)?.name, "review");
    assert.equal(
      shell("cat /p/cache/sphica/sphica/0.6.53/skills/review/SKILL.md /x/skills/pr-review/SKILL.md", mine)
        ?.name,
      "pr-review",
    );
    assert.equal(
      shell("type C:\\p\\skills\\review\\SKILL.md", ["C:\\p\\skills\\review\\SKILL.md"]),
      null,
      "a Windows path of Sphica's own",
    );

    // Anything else is no review: other tools, other events, and Claude Code's own events
    const other = (input: Record<string, unknown>) => codexReviewCall({ session_id: "cx", ...input }, own);
    assert.equal(
      other({
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        tool_input: { command: "skills/my-review/SKILL.md" },
      }),
      null,
    );
    assert.equal(
      other({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "cat skills/my-review/SKILL.md" },
      }),
      null,
    );
    assert.equal(
      other({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: 7 } }),
      null,
    );
    assert.equal(
      other({
        hook_event_name: "UserPromptExpansion",
        expansion_type: "slash_command",
        command_name: "review",
      }),
      null,
    );
    assert.equal(other({ hook_event_name: "SessionStart" }), null);
  } finally {
    delete process.env.SPHICA_REVIEW_COMMANDS;
    delete process.env.CLAUDE_PLUGIN_OPTION_REVIEW_COMMANDS;
  }
});

/** One Codex session against a world: hook calls from the session's own thread unless another thread's log is named */
function codexSession(w: { db: TempDb; repo: string }) {
  const session = `cx-${crypto.randomUUID()}`;
  const made: string[] = [];
  const named = (file: string) => {
    made.push(path.dirname(file));
    return file;
  };
  const own = named(codexLog(session));
  const call = (input: Record<string, unknown>, log: string = own, started?: number) =>
    deliver(
      { session_id: session, cwd: w.repo, transcript_path: log, ...input },
      "codex",
      w.db.file,
      started,
    );
  return {
    session,
    /** A new child thread of the kind the built-in review starts */
    child: (id: string) => named(childLog(session, id)),
    prompt: (text: string, log?: string, extra: Record<string, unknown> = {}, started?: number) =>
      call({ hook_event_name: "UserPromptSubmit", prompt: text, ...extra }, log, started),
    bash: (command: string, log?: string) =>
      call({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }, log),
    rows: () =>
      w.db.owner
        .prepare(
          "select d.agent_id, d.event from delivery d join session s on s.id = d.session_id where s.external_id = ? order by d.id",
        )
        .all(session)
        .map((r) => `${r.agent_id ?? "main"}:${r.event}`),
    clean: () => {
      for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const FIXED =
  "Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.";

test("Codex's built-in review gets the decisions its change touches, each time it starts, in the child thread it runs in", async () => {
  const w = await world();
  const cx = codexSession(w);
  try {
    fs.writeFileSync(path.join(w.repo, "src", "db.ts"), "export const open = () => 2;\n");
    const first = cx.child("review-1");
    const got = await cx.prompt(FIXED, first);
    assert.match(got, /trace:ext-s1\/sqlite .*Keep one SQLite file\. \[anchored to src\/db\.ts\]/);
    assert.match(got, /not an instruction/);
    assert.match(got, /checked 1 changed path against origin\/main/);
    assert.doesNotMatch(got, /old|new\.ts/);
    // The same thread is told once; the next review is a new thread that has seen nothing
    assert.equal(await cx.prompt(FIXED, first), "");
    assert.match(await cx.prompt(FIXED, cx.child("review-2")), /checked 1 changed path against origin\/main/);
    // Custom instructions are a prompt too: the review's decisions come first, then what the instructions name
    const custom = await cx.prompt("Focus on src/old.ts.", cx.child("review-3"));
    assert.match(custom, /checked 1 changed path[\s\S]*\n\n[\s\S]*trace:ext-s1\/old /);
    // The session's own prompt of the same words is no review
    assert.equal(await cx.prompt(FIXED), "");
    // A prompt is logged whether or not it brought a record, and first; a review is logged when it is told
    assert.deepEqual(cx.rows(), [
      "review-1:prompt",
      "review-1:review",
      "review-1:prompt",
      "review-2:prompt",
      "review-2:review",
      "review-3:prompt",
      "review-3:review",
      "main:prompt",
    ]);
  } finally {
    cx.clean();
    await w.done();
  }
});

test("a review skill named in a Codex prompt gets the review's decisions and what the prompt names, the review part once per change", async () => {
  const w = await world();
  const cx = codexSession(w);
  try {
    fs.writeFileSync(path.join(w.repo, "src", "db.ts"), "export const open = () => 2;\n");
    const first = await cx.prompt("$my-review src/old.ts も見て");
    assert.match(first, /trace:ext-s1\/sqlite .*\[anchored to src\/db\.ts\]/);
    assert.match(first, /checked 1 changed path against origin\/main/);
    assert.match(first, /trace:ext-s1\/old /, "the prompt's own delivery still comes");
    const again = await cx.prompt("$my-review src/old.ts も見て");
    assert.doesNotMatch(again, /checked 1 changed path/);
    assert.match(again, /trace:ext-s1\/old /);
    // Sphica's own review checks the change itself, and a subagent's review is left to the conversation that started it
    assert.doesNotMatch(await cx.prompt("$sphica:review"), /checked/);
    assert.equal(await cx.prompt("$my-review", undefined, { agent_id: "sub" }), "");
    // The built-in review after it is another conversation, so it is told
    assert.match(await cx.prompt(FIXED, cx.child("review-1")), /checked 1 changed path against origin\/main/);
    // A change since then is a new review
    fs.writeFileSync(path.join(w.repo, "src", "db.ts"), "export const open = () => 3;\n");
    assert.match(await cx.prompt("$my-review"), /checked 1 changed path against origin\/main/);
    assert.deepEqual(cx.rows(), [
      "main:prompt",
      "main:review",
      "main:prompt",
      "main:prompt",
      "review-1:prompt",
      "review-1:review",
      "main:prompt",
      "main:review",
    ]);
  } finally {
    cx.clean();
    await w.done();
  }
});

test("a review skill the Codex model reads gets the review's decisions before the shell command, beside what the command names", async () => {
  const w = await world();
  const cx = codexSession(w);
  try {
    fs.writeFileSync(path.join(w.repo, "src", "db.ts"), "export const open = () => 2;\n");
    // The command names no recorded file, and the review still comes
    const read = await cx.bash("cat /home/u/.codex/skills/my-review/SKILL.md");
    assert.match(read, /trace:ext-s1\/sqlite .*\[anchored to src\/db\.ts\]/);
    assert.match(read, /checked 1 changed path against origin\/main/);
    // Told once for this change; a file the same command names is still delivered as named
    const both = await cx.bash("cat /home/u/.codex/skills/my-review/SKILL.md src/old.ts");
    assert.doesNotMatch(both, /checked 1 changed path/);
    assert.match(both, /trace:ext-s1\/old /);
    assert.equal(await cx.bash("cat /home/u/.codex/skills/deploy/SKILL.md"), "");
    // Sphica's own review Skill, where this checkout keeps it
    const mine = path.join(import.meta.dirname, "..", "..", "plugin", "skills", "review", "SKILL.md");
    assert.ok(fs.existsSync(mine));
    const other = codexSession(w);
    try {
      assert.equal(await other.bash(`cat "${mine}"`), "");
      assert.match(
        await other.bash("cat /somewhere/else/skills/review/SKILL.md"),
        /checked 1 changed path against origin\/main/,
        "another skill named review",
      );
    } finally {
      other.clean();
    }
    assert.deepEqual(cx.rows(), ["main:review", "main:pre_read"]);
  } finally {
    cx.clean();
    await w.done();
  }
});

test("a review that has no time left says so, and takes nothing from the delivery of the call it came with", async () => {
  const w = await world();
  const cx = codexSession(w);
  try {
    fs.writeFileSync(path.join(w.repo, "src", "db.ts"), "export const open = () => 2;\n");
    // Out of time before the first git: the reason is time, not a branch or a history that is missing
    const late = await localChange(w.repo, "", Date.now() - 1);
    assert.ok("problem" in late);
    assert.match(late.problem, /could not be read in time/);
    assert.ok(!("problem" in (await localChange(w.repo, ""))), "with time, the same change is read");
    // Git is not the only slow part: untracked files are read one by one, and that stops at the same time
    fs.writeFileSync(path.join(w.repo, "src", "one.ts"), "export const one = 1;\nexport const two = 2;\n");
    fs.writeFileSync(path.join(w.repo, "src", "big.bin"), Buffer.alloc(300 * 1024, 1));
    const names = ["src/one.ts", "src/big.bin", "src/missing.ts"];
    assert.equal(untrackedFiles(w.repo, names, Date.now() - 1), null);
    assert.deepEqual(
      untrackedFiles(w.repo, [], Date.now() - 1),
      { files: [], read: [] },
      "nothing to read takes no time",
    );
    assert.deepEqual(untrackedFiles(w.repo, names, Date.now() + 60_000), {
      files: [
        {
          path: "src/one.ts",
          added: ["export const one = 1;", "export const two = 2;", ""],
          lines: [1, 2, 3],
        },
        // Too large to read, or not there: the path still counts as changed
        { path: "src/big.bin", added: [], lines: [] },
        { path: "src/missing.ts", added: [], lines: [] },
      ],
      read: [
        "src/one.ts",
        "export const one = 1;\nexport const two = 2;\n",
        "src/big.bin",
        "",
        "src/missing.ts",
        "",
      ],
    });
    const withThem = await localChange(w.repo, "");
    assert.ok(!("problem" in withThem));
    assert.deepEqual(
      withThem.files.map((f) => f.path).sort(),
      ["src/big.bin", "src/db.ts", "src/one.ts"],
      "the change holds what git tracks and what it does not",
    );
    fs.rmSync(path.join(w.repo, "src", "one.ts"));
    fs.rmSync(path.join(w.repo, "src", "big.bin"));
    // The event's own delivery comes back whatever the review does: here the review cannot check a named pull request
    const got = await cx.prompt("$my-review #12 src/old.ts");
    assert.match(got, /could not check this review against past decisions: it names a pull request/);
    assert.match(got, /trace:ext-s1\/old /);
    // A hook that started long ago leaves the review no time: it says so instead of reading the change, and the prompt's record comes
    const slow = await cx.prompt("$my-review src/old.ts", undefined, {}, Date.now() - 10_000);
    assert.match(
      slow,
      /could not check this review against past decisions: the change could not be read in time/,
    );
    assert.doesNotMatch(slow, /checked 1 changed path/);
    assert.match(slow, /trace:ext-s1\/old /);
    assert.match(await cx.prompt("$my-review src/old.ts"), /checked 1 changed path against origin\/main/);
  } finally {
    cx.clean();
    await w.done();
  }
});
