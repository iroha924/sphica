// Maps acceptance steps and expectations onto Sphica's public entry points (capture hooks, CLI, MCP, delivery hooks).
// Each operation is filled in when its feature is built; until then it fails and names the missing operation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Kysely } from "kysely";
import { flush, onHook } from "../../src/capture.ts";
import { openReader } from "../../src/db.ts";
import type { DB } from "../../src/db-types.ts";
import type { Host } from "../../src/knowledge.ts";
import type { Step, World } from "./load.ts";

export type Driver = {
  run(step: Step): Promise<void>;
  expect(expectation: Step): Promise<void>;
  done(): Promise<void>;
};

class NotBuilt extends Error {}

type Session = World["sessions"][number];

const CLI = path.join(import.meta.dirname, "..", "..", "src", "cli.ts");
/** Variables from the shell running the cases that would point hooks and the CLI at the owner's sessions or database. */
const LEAKY = [
  "SPHICA_DB",
  "SPHICA_PARENT_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
];

export async function createDriver(world: World): Promise<Driver> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-acceptance-")));
  const saved = Object.fromEntries(["HOME", "USERPROFILE", ...LEAKY].map((k) => [k, process.env[k]]));
  for (const k of LEAKY) delete process.env[k];
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  const file = path.join(dir, ".sphica", "sphica.db");
  const repo = path.join(dir, "tsundoku");
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        repo,
        "-c",
        "user.name=hana",
        "-c",
        "user.email=hana@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { stdio: "ignore" },
    );
  const cli = (...args: string[]) =>
    execFileSync(process.execPath, [CLI, ...args], {
      cwd: repo,
      env: { ...process.env, NO_COLOR: "1" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

  fs.mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "https://github.com/example/tsundoku.git");
  for (const [rel, text] of Object.entries(world.files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  }
  git("add", "-A");
  git("commit", "-qm", "initial");
  cli("init", "--cwd", repo);

  const sessions = new Map(world.sessions.map((s) => [s.id, s]));
  let reader: Kysely<DB> | null = null;
  const db = () => {
    reader ??= openReader(file);
    return reader;
  };
  const missing = (kind: string, s: Step) =>
    new NotBuilt(`${kind} not built yet: ${Object.keys(s).join(", ")}`);

  /** Plays a session through the capture hooks the way its host would, editing the repository for real, then sends the queue. */
  async function capture(id: string): Promise<void> {
    const s = sessions.get(id);
    if (!s) throw new Error(`unknown session ${id}`);
    const host: Host = s.host === "codex" ? "codex" : "claude-code";
    const hook = (turn: string, input: Record<string, unknown>) =>
      onHook(host, {
        session_id: s.id,
        ...(host === "codex" ? { turn_id: turn } : { prompt_id: turn }),
        cwd: repo,
        ...input,
      });
    hook("start", { hook_event_name: "SessionStart" });
    s.turns.forEach((t, i) => {
      const turn = turnId(i + 1);
      hook(turn, { hook_event_name: "UserPromptSubmit", prompt: t.owner });
      t.edits.forEach((rel, k) => {
        const abs = path.join(repo, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.appendFileSync(abs, `// ${s.id} turn ${i + 1}\n`);
        hook(turn, {
          hook_event_name: "PostToolUse",
          tool_use_id: `${turn}-edit-${k}`,
          ...(host === "codex"
            ? {
                tool_name: "apply_patch",
                tool_input: { command: `*** Begin Patch\n*** Update File: ${rel}\n*** End Patch` },
              }
            : { tool_name: "Edit", tool_input: { file_path: abs } }),
        });
      });
      hook(turn, { hook_event_name: "Stop", last_assistant_message: t.assistant });
    });
    const sent = await flush(file);
    assert.equal(sent.rejected, 0, `the database rejected records of ${id}`);
  }

  /** The source a case names as `session:<id>#<turn>.<owner|assistant>`. */
  async function sessionSource(ref: string) {
    const m = /^session:([^#]+)#(\d+)\.(owner|assistant)$/.exec(ref);
    if (!m) return undefined;
    return db()
      .selectFrom("source as m")
      .innerJoin("session as s", "s.id", "m.session_id")
      .where("s.external_id", "=", m[1] ?? "")
      .where("m.turn_id", "=", turnId(Number(m[2])))
      .where("m.author_kind", "=", m[3] === "owner" ? "owner" : "assistant")
      .select(["m.id", "m.kind", "m.text", "s.host"])
      .executeTakeFirst();
  }

  return {
    run: async (step) => {
      if (typeof step.capture === "string") return capture(step.capture);
      if (step.session && typeof step.session === "object") {
        const s = step.session as Session;
        sessions.set(s.id, s);
        return;
      }
      throw missing("operation", step);
    },
    expect: async (e) => {
      if (typeof e.source === "string" && e.source.startsWith("session:")) {
        const got = await sessionSource(e.source);
        assert.ok(got, `no source ${e.source}`);
        if (e.kind !== undefined) assert.equal(got.kind, e.kind);
        if (e.host !== undefined) assert.equal(got.host, e.host);
        return;
      }
      if (e.edit_observation && typeof e.edit_observation === "object") {
        const want = e.edit_observation as { session: string; path: string };
        const got = await db()
          .selectFrom("edit_observation as o")
          .innerJoin("session as s", "s.id", "o.session_id")
          .where("s.external_id", "=", want.session)
          .where("o.path", "=", want.path)
          .select("o.id")
          .execute();
        assert.ok(got.length > 0, `no edit observed for ${want.path} in ${want.session}`);
        return;
      }
      if (typeof e.units_for_session === "string") {
        const got = await db()
          .selectFrom("unit_evidence as e")
          .innerJoin("source as m", "m.id", "e.source_id")
          .innerJoin("session as s", "s.id", "m.session_id")
          .where("s.external_id", "=", e.units_for_session)
          .select((eb) => eb.fn.count<number>("e.unit_id").distinct().as("n"))
          .executeTakeFirstOrThrow();
        assert.equal(Number(got.n), e.count);
        return;
      }
      throw missing("expectation", e);
    },
    done: async () => {
      await reader?.destroy();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Turn ids the driver gives the hooks: the case's turn number, so `session:<id>#2.owner` finds the second turn. */
const turnId = (n: number): string => `t${n}`;
