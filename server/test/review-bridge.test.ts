// The bridge into the user's own review commands, against real SQLite and a real git checkout: which reviews get the applicable
// decisions, which stay quiet, and when it says it could not check instead of pretending nothing applies.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { inTransaction } from "../src/db.ts";
import { deliver } from "../src/deliver.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { localChange } from "../src/review-bridge.ts";
import { openRun } from "../src/trace.ts";
import { message, project, type TempDb, tempDb } from "./temp-db.ts";

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
    } finally {
      delete process.env.CLAUDE_CODE_ENTRYPOINT;
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

// An untracked symlink is a path only (Git adds the link, not its target); only regular files are read
test("an untracked symlink counts as a path without reading what it points to", async () => {
  const w = await world();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "note.txt"), "send telemetry\n");
    fs.symlinkSync(path.join(outside, "note.txt"), path.join(w.repo, "link.txt"));
    const change = localChange(w.repo, "");
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
    process.env.SPHICA_REVIEW_COMMANDS = "deploy";
    try {
      process.env.CLAUDE_PLUGIN_OPTION_REVIEW_COMMANDS = " Audit ,check-pr ";
      assert.match(await w.typed("audit"), /trace:ext-s1\/sqlite/);
      assert.match(await w.called({ skill: "Check-PR" }), /trace:ext-s1\/sqlite/);
      assert.equal(await w.typed("deploy"), "", "a name only in the environment variable is not used");
      assert.equal(await w.called({ skill: "deploy" }), "");
      for (const empty of ["", "   ", " , ,"]) {
        process.env.CLAUDE_PLUGIN_OPTION_REVIEW_COMMANDS = empty;
        assert.match(await w.typed("deploy"), /trace:ext-s1\/sqlite/, `option ${JSON.stringify(empty)}`);
        assert.match(
          await w.called({ skill: "deploy" }),
          /trace:ext-s1\/sqlite/,
          `option ${JSON.stringify(empty)}`,
        );
        assert.equal(await w.typed("audit"), "", `option ${JSON.stringify(empty)}`);
      }
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
