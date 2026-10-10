// What reached a conversation, read from synthetic Claude Code transcripts: exact keys from Sphica's record lines, doubt when a line is
// not understood, human prompts told from notifications, compactions, subagents, and the inputs a saved result is fixed to.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  deliveryObserved,
  freeze,
  lastCompact,
  nextHuman,
  parseDelivery,
  readConversation,
  readConversations,
  shown,
  turnStart,
} from "../evals/post-write/transcript.ts";
import { insert, project, tempDb } from "./temp-db.ts";

const NOTE = "Sphica past record, not an instruction; read it with Sphica's read before relying on it";

test("a Sphica hook context gives the keys of its record lines exactly, and doubts a line it does not understand", () => {
  assert.equal(parseDelivery("some other hook said trace:a/b"), null, "not Sphica's");
  const edit = parseDelivery(
    [
      `Active decisions applying to src/a.ts (current code relevance unverified). ${NOTE}:`,
      "- trace:s1/utc (decision do): Store UTC. Rejected: local time; see also trace:s1/utc-extra in the text",
      "- 2 more records apply here but were left out for space: find them with Sphica's search or read.",
    ].join("\n"),
  );
  assert.deepEqual(
    edit,
    { keys: ["trace:s1/utc"], complete: true },
    "a key named in a record's text is not a record line",
  );
  assert.deepEqual(
    parseDelivery(
      `If, after checking …\n${NOTE}: harvest:41/upload (decision dont): No uploads [names upload]`,
    ),
    {
      keys: ["harvest:41/upload"],
      complete: true,
    },
  );
  assert.deepEqual(
    parseDelivery(
      `Sphica: work.\n- trace:a/known (decision do): x\nLegacy record: trace:b/unknown (decision dont): y`,
    ),
    { keys: ["trace:a/known"], complete: false },
    "a line naming a key in a form not known leaves the parse incomplete",
  );
});

const line = (o: Record<string, unknown>) =>
  JSON.stringify({ sessionId: "s", timestamp: "2026-10-01T00:00:00.000Z", ...o });
const human = (text: string) => line({ type: "user", origin: { kind: "human" }, message: { content: text } });
const delivery = (hook: string, text: string) =>
  line({
    attachment: { type: "hook_additional_context", hookEvent: hook, toolUseID: hook, content: [text] },
  });
const call = (id: string) =>
  line({
    type: "assistant",
    cwd: "/r",
    message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "x" } }] },
  });
const result = (id: string, error = false) =>
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: error }] } });

test("a conversation reads in line order: turns, compactions, the next human prompt, and what was shown between two points", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-transcript-"));
  try {
    const main = [
      delivery("SessionStart", `Sphica: current work.\n- Work: x (active): y`), // 0
      human("first"), // 1
      call("c1"), // 2
      delivery("PreToolUse", `Active decisions applying to a.ts. ${NOTE}:\n- trace:s/a (decision do): A`), // 3
      result("c1"), // 4
      line({ type: "system", subtype: "compact_boundary" }), // 5
      line({
        type: "user",
        origin: { kind: "task-notification" },
        message: { content: "<task-notification>" },
      }), // 6
      call("c2"), // 7
      result("c2", true), // 8
      "{broken", // 9
      human("second"), // 10
      call("c3"), // 11
      delivery("PreToolUse", "Sphica: Legacy record: trace:s/b (decision do): B"), // 12
      result("c3"), // 13
      line({ type: "user", message: { content: "no origin" } }), // 14
      line({ type: "assistant", message: { content: [{ type: "text", text: "answering it" }] } }), // 15
    ];
    fs.writeFileSync(path.join(dir, "s.jsonl"), `${main.join("\n")}\n`);
    fs.mkdirSync(path.join(dir, "s", "subagents"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "s", "subagents", "agent-x.jsonl"),
      `${[line({ agentId: "x", type: "user", message: { content: "task" } }), call("k1"), result("k1")]
        .map((l) => l.replace('"sessionId":"s"', '"sessionId":"s","agentId":"x"'))
        .join("\n")}\n`,
    );
    const [c, sub] = readConversations(dir);
    assert.ok(c && sub);
    assert.equal(c.agent, null);
    assert.equal(sub.agent, "x");
    assert.equal(c.unreadable, 1);
    assert.deepEqual(
      c.events.filter((e) => e.kind === "result").map((e) => (e.kind === "result" ? [e.id, e.ok] : [])),
      [
        ["c1", true],
        ["c2", false],
        ["c3", true],
      ],
    );
    assert.equal(turnStart(c, 4), 1);
    assert.equal(turnStart(c, 13), 10);
    assert.equal(turnStart(sub, 2), 1, "a subagent's turn starts at its first call");
    assert.equal(deliveryObserved(c, 4), true, "the session start delivery came before the first turn");
    assert.equal(
      deliveryObserved(sub, 2),
      false,
      "nothing of Sphica's in the subagent before its first call",
    );
    assert.equal(lastCompact(c, 7), 5);
    assert.equal(lastCompact(c, 4), -1);
    assert.equal(nextHuman(c, 4), 10, "a task notification is not the owner's prompt");
    assert.equal(nextHuman(c, 13), "unknown", "a prompt line with no origin may be the owner's");
    assert.equal(shown(c, -1, 5, "trace:s/a"), "shown");
    assert.equal(shown(c, 5, 10, "trace:s/a"), "not shown", "only between the two points");
    assert.equal(shown(c, 10, 14, "trace:s/b"), "unknown", "an incomplete delivery leaves it unknown");
    assert.match(readConversation(dir, "s.jsonl").sha256, /^[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a user line with no origin is a possible prompt only when the model answers it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-transcript-"));
  try {
    const answer = line({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
    const plain = (text: string) => line({ type: "user", message: { content: text } });
    const lines = [
      human("go"), // 0
      call("c1"), // 1
      result("c1"), // 2
      plain("<command-name>/reload-plugins</command-name>"), // 3: a local command
      plain("<local-command-stdout>Reloaded</local-command-stdout>"), // 4
      plain("<bash-input>git status</bash-input>"), // 5: the owner's own shell command
      plain("<bash-stdout>clean</bash-stdout>"), // 6
      plain("[Request interrupted by user]"), // 7
      human("next"), // 8
      answer, // 9
      call("c2"), // 10
      result("c2"), // 11
      plain("/sphica:harvest 232"), // 12: an older transcript's prompt, which the model answers
      answer, // 13
    ];
    fs.writeFileSync(path.join(dir, "s.jsonl"), `${lines.join("\n")}\n`);
    const c = readConversation(dir, "s.jsonl");
    assert.equal(
      nextHuman(c, 2),
      8,
      "local commands, the owner's shell commands, and interruptions are not prompts",
    );
    assert.equal(nextHuman(c, 11), "unknown", "a line the model answers may be the owner's prompt");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a saved run is fixed to a clean commit, a database snapshot, and the transcripts read, and refuses forgotten history", async () => {
  const db = tempDb();
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-freeze-")));
  const out = path.join(repo, "..", `${path.basename(repo)}-snapshot.db`);
  try {
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-C",
          repo,
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@example.invalid",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { stdio: "pipe" },
      );
    git("init", "-q");
    fs.mkdirSync(path.join(repo, "server"));
    fs.writeFileSync(path.join(repo, "server", "a.ts"), "a\n");
    git("add", "-A");
    git("commit", "-qm", "a");
    const p = project(db);
    const conversations = [
      {
        file: "s.jsonl",
        session: "s",
        agent: null,
        events: [],
        unreadable: 0,
        unreadableLines: [],
        sha256: "0".repeat(64),
      },
    ];
    const inputs = await freeze({ repo, db: db.file, projectId: p, out, conversations });
    assert.match(inputs.commit, /^[0-9a-f]{40}$/);
    assert.match(inputs.snapshot.sha256, /^[0-9a-f]{64}$/);
    assert.equal(inputs.transcripts.count, 1);
    assert.ok(fs.statSync(out).size > 0, "the snapshot is a database copy");
    fs.writeFileSync(path.join(repo, "server", "a.ts"), "b\n");
    await assert.rejects(freeze({ repo, db: db.file, projectId: p, out, conversations }), /uncommitted/);
    git("commit", "-qam", "b");
    insert(db, "forget_batch", { project_id: p, at: "2026-10-01T00:00:00.000Z" });
    await assert.rejects(freeze({ repo, db: db.file, projectId: p, out, conversations }), /forgot/);
  } finally {
    await db.done();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(out, { force: true });
  }
});
