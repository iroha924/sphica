// Maps acceptance steps and expectations onto Sphica's public entry points (capture hooks, CLI, MCP, delivery hooks).
// Each operation is filled in when its feature is built; until then it fails and names the missing operation.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Kysely } from "kysely";
import { flush, onHook } from "../../src/capture.ts";
import { openReader } from "../../src/db.ts";
import type { DB } from "../../src/db-types.ts";
import { type Host, sessionId } from "../../src/knowledge.ts";
import { status } from "../../src/status.ts";
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
  /** Runs the CLI as a child process; out holds stdout and stderr together. */
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: repo,
      env: { ...process.env, NO_COLOR: "1" },
      encoding: "utf8",
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const cli = (...args: string[]) => {
    const r = run(...args);
    if (r.status !== 0) throw new Error(`sphica ${args.join(" ")} exited ${r.status}\n${r.out}`);
    return r.out;
  };

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
  const projectId = async () =>
    (
      await db()
        .selectFrom("project")
        .select("id")
        .where("key", "=", "git:github.com/example/tsundoku")
        .executeTakeFirstOrThrow()
    ).id;
  /** The last check output, for expectations about what check reported. */
  let checked = "";
  /** Quotes each saved key cited, to confirm stored spans cut exactly those bytes. */
  const quotes = new Map<string, Set<string>>();
  const missing = (kind: string, s: Step) =>
    new NotBuilt(`${kind} not built yet: ${Object.keys(s).join(", ")}`);

  /** Plays a session through the capture hooks the way its host would, editing the repository for real, then sends the queue. */
  const captured = new Set<string>();
  async function capture(id: string): Promise<void> {
    const s = sessions.get(id);
    if (!s) throw new Error(`unknown session ${id}`);
    if (captured.has(id)) return;
    captured.add(id);
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

  /** The source id behind a case's reference, as the `s<id>` ref context prints. */
  async function ref(r: string): Promise<string> {
    const got = await sessionSource(r);
    if (!got) throw new Error(`no source for ${r}`);
    return `s${got.id}`;
  }

  /** Replaces case references with source refs, deep inside a record. */
  async function translate(v: unknown): Promise<unknown> {
    if (Array.isArray(v)) return Promise.all(v.map(translate));
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v))
      out[k] = k === "source" && typeof x === "string" ? await ref(x) : await translate(x);
    return out;
  }

  async function trace(step: { session: string; record: Record<string, unknown> }): Promise<void> {
    const s = sessions.get(step.session);
    if (!s) throw new Error(`unknown session ${step.session}`);
    const uuid = sessionId(await projectId(), s.host === "codex" ? "codex" : "claude-code", s.id);
    const { processed_without_units: empty, ...record } = step.record;
    const drafted = cli("trace", "draft", "--session", uuid);
    const id = /^ {2}id: (\S+)$/m.exec(drafted)?.[1];
    const draftFile = /^ {2}file: (.+)$/m.exec(drafted)?.[1];
    if (!id || !draftFile) throw new Error(`trace draft printed no id or file\n${drafted}`);
    fs.writeFileSync(draftFile, JSON.stringify(await translate(record)));
    checked = run("trace", "check", id).out;
    cli("trace", "save", id);
    for (const u of (record.units ?? []) as { key: string }[]) {
      const cited = new Set<string>();
      JSON.stringify(u, (k, x) => {
        if (k === "quote" && typeof x === "string") cited.add(x);
        return x;
      });
      quotes.set(`trace:${s.id}/${u.key}`, cited);
    }
    for (const other of (empty ?? []) as string[]) await trace({ session: other, record: { units: [] } });
  }

  const unitOf = async (key: string) => {
    const u = await db().selectFrom("unit").selectAll().where("key", "=", key).executeTakeFirst();
    assert.ok(u, `no unit ${key}`);
    return u;
  };

  return {
    run: async (step) => {
      if (typeof step.capture === "string") return capture(step.capture);
      if (step.trace && typeof step.trace === "object")
        return trace(step.trace as { session: string; record: Record<string, unknown> });
      if (step.session && typeof step.session === "object") {
        // A session a case gives inline happened: it goes through the hooks like any other
        const s = step.session as Session;
        sessions.set(s.id, s);
        return capture(s.id);
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
      if (typeof e.unit === "string") {
        const u = await unitOf(e.unit);
        for (const k of ["extraction", "lifecycle", "stance", "kind", "revisit_when", "text"] as const)
          if (e[k] !== undefined) assert.equal(u[k], e[k], `${e.unit} ${k}`);
        if (e.reason_contains !== undefined)
          assert.match(u.extraction_reason ?? "", new RegExp(String(e.reason_contains)));
        if (e.unsourced !== undefined) assert.equal(u.unsourced === 1, e.unsourced);
        if (e.code_surface === "none") {
          const anchors = await db()
            .selectFrom("unit_anchor")
            .select("id")
            .where("unit_id", "=", u.id)
            .where("retired_at", "is", null)
            .execute();
          assert.equal(anchors.length, 0, `${e.unit} has anchors`);
        }
        if (e.successor !== undefined) {
          const next = await db()
            .selectFrom("unit_link as l")
            .innerJoin("unit as n", "n.id", "l.from_unit")
            .where("l.to_unit", "=", u.id)
            .where("l.kind", "=", "supersedes")
            .select("n.key")
            .execute();
          assert.deepEqual(
            next.map((n) => n.key),
            [e.successor],
          );
        }
        return;
      }
      if (typeof e.option === "string") {
        const u = await unitOf(String(e.of));
        const o = await db()
          .selectFrom("unit_option")
          .selectAll()
          .where("unit_id", "=", u.id)
          .where("text", "=", e.option)
          .executeTakeFirst();
        assert.ok(o, `${e.of} has no option ${e.option}`);
        if (e.outcome !== undefined) assert.equal(o.outcome, e.outcome);
        if (e.has_evidence !== undefined) {
          const ev = await db()
            .selectFrom("unit_evidence")
            .select("id")
            .where("option_id", "=", o.id)
            .execute();
          assert.equal(ev.length > 0, e.has_evidence, `evidence of option ${e.option}`);
        }
        return;
      }
      if (typeof e.evidence_span_matches_source === "string") {
        const key = e.evidence_span_matches_source;
        const spans = await db()
          .selectFrom("unit_evidence as e")
          .innerJoin("unit as u", "u.id", "e.unit_id")
          .innerJoin("source as m", "m.id", "e.source_id")
          .where("u.key", "=", key)
          .select(["m.text", "e.span_start", "e.span_end"])
          .execute();
        assert.ok(spans.length, `${key} has no evidence`);
        for (const x of spans)
          assert.ok(
            quotes.get(key)?.has(Buffer.from(x.text).subarray(x.span_start, x.span_end).toString("utf8")),
            `a span of ${key} does not cut a cited quote`,
          );
        return;
      }
      if (typeof e.state_history_of === "string") {
        const u = await unitOf(e.state_history_of);
        const last = await db()
          .selectFrom("unit_state")
          .selectAll()
          .where("unit_id", "=", u.id)
          .orderBy("id", "desc")
          .executeTakeFirstOrThrow();
        const want = e.last as { to: string; has_evidence?: boolean };
        assert.equal(last.to_state, want.to);
        if (want.has_evidence !== undefined) assert.equal(last.source_id !== null, want.has_evidence);
        return;
      }
      if (e.status && typeof e.status === "object") {
        const want = e.status as Record<string, unknown>;
        const text = await status(db(), await projectId(), "example/tsundoku");
        const n = (re: RegExp) => Number(re.exec(text)?.[1] ?? 0);
        if (want.quarantined !== undefined)
          assert.equal(n(/(\d+) quarantined record/), want.quarantined, text);
        if (want.processed_without_units !== undefined)
          assert.equal(
            n(/(\d+) sessions? traced with nothing to record/),
            want.processed_without_units,
            text,
          );
        if (typeof want.pending_sessions_includes === "string") {
          const s = sessions.get(want.pending_sessions_includes);
          const uuid = sessionId(
            await projectId(),
            s?.host === "codex" ? "codex" : "claude-code",
            want.pending_sessions_includes,
          );
          assert.match(cli("trace", "pending"), new RegExp(uuid));
        }
        return;
      }
      if (typeof e.check_problem_contains === "string") {
        assert.ok(
          checked.includes(e.check_problem_contains),
          `check did not report "${e.check_problem_contains}"\n${checked}`,
        );
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
