// What trace reads: sessions not traced yet (the owner's messages for an explicit trace, every speaker's for an automatic one), the run a draft is bound to, and a session's sources, edits, and the project's live records.
import { type ExpressionBuilder, type Kysely, sql } from "kysely";
import type { Caller } from "./caller.ts";
import { iso, type Reads } from "./db.ts";
import type { DB, Session } from "./db-types.ts";
import type { BeginOrigin } from "./knowledge.ts";

/** Days after its last owner message that an untraced session stops counting as waiting. Its messages stay and are still found. */
export const PENDING_DAYS = 14;

/** The oldest last-owner-message time that still counts as recent, as stored (ISO 8601 UTC). */
export const pendingCutoff = (now: Date): string =>
  new Date(now.getTime() - PENDING_DAYS * 86_400_000).toISOString();

type InSession = ExpressionBuilder<DB & { s: Session }, "s">;

/**
 * Which sessions wait. An explicit trace waits on the owner's messages only. An automatic one waits on every speaker's, so a reply
 * captured after a run began is traced by the next run, and `skip` names the caller's own session, which is still being written.
 */
export type PendingOptions = { auto?: boolean; skip?: { host: string; session: string } | null };

/** Messages of session `s` that no extraction has looked at: the owner's, or with `auto` every speaker's. */
const untraced = (eb: InSession, auto: boolean) => {
  const q = eb.selectFrom("source as m").whereRef("m.session_id", "=", "s.id");
  return (auto ? q : q.where("m.author_kind", "=", "owner")).where(({ not, exists, selectFrom }) =>
    not(
      exists(
        selectFrom("source_processing as p").whereRef("p.source_id", "=", "m.id").select(sql`1`.as("x")),
      ),
    ),
  );
};

/**
 * Sessions of the project with a message no extraction has looked at, with the time of their last owner message, traced or not: a
 * session the owner came back to stays recent even when its untraced messages are old. Session start runs this, so each session is
 * read through its own messages (the source_session index), never by grouping the whole project.
 */
export const untracedSessions = (db: Reads, projectId: number, o: PendingOptions = {}) => {
  const auto = o.auto ?? false;
  const skip = o.skip;
  return db
    .selectFrom("session as s")
    .where("s.project_id", "=", projectId)
    .$if(Boolean(skip), (q) =>
      q.where((eb) =>
        eb.not(eb.and([eb("s.host", "=", skip?.host ?? ""), eb("s.external_id", "=", skip?.session ?? "")])),
      ),
    )
    .where((eb) => eb.exists(untraced(eb, auto).select(sql`1`.as("x"))))
    .select((eb) => [
      "s.id",
      "s.host",
      "s.started_at",
      "s.branch",
      eb
        .selectFrom("source as o")
        .whereRef("o.session_id", "=", "s.id")
        .where("o.author_kind", "=", "owner")
        .select((o) => o.fn.max("o.created_at").as("last"))
        .as("last"),
      untraced(eb, auto)
        .select((m) => m.fn.countAll<number>().as("waiting"))
        .as("waiting"),
      untraced(eb, auto)
        .select((m) => m.fn.min("m.id").as("first"))
        .as("first"),
    ]);
};

/**
 * Untraced sessions of one group, with how many messages wait and the first of them. An explicit trace lists first the session whose
 * owner came back most recently; an automatic one the session that started first, ordered before the limit so the oldest is never
 * left out. `total` counts the whole group, beyond the limit.
 */
export async function pendingSessions(
  db: Reads,
  projectId: number,
  group: "recent" | "older",
  now: Date = new Date(),
  limit = 20,
  o: PendingOptions = {},
) {
  const cutoff = pendingCutoff(now);
  const base = db
    .selectFrom(untracedSessions(db, projectId, o).as("w"))
    .where("w.last", group === "recent" ? ">=" : "<", cutoff);
  const ordered = o.auto
    ? base.selectAll("w").orderBy("w.started_at").orderBy("w.id")
    : base.selectAll("w").orderBy("w.last", "desc");
  const [rows, total] = await Promise.all([
    ordered.limit(limit).execute(),
    base.select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirst(),
  ]);
  return { rows, total: Number(total?.n ?? 0) };
}

export type Run = {
  id: number;
  project_id: number;
  origin: string;
  target: string;
  session_id: string | null;
  status: string;
  begin_call_id: number | null;
  started_at: string;
};

/** Starts a run for a draft. The draft is bound to this run's project and target, so the record cannot name another. */
export async function openRun(
  db: Kysely<DB>,
  v: {
    projectId: number;
    origin: BeginOrigin;
    target: string;
    sessionId: string | null;
    draftId: string;
    beginCall?: number | null;
  },
): Promise<number> {
  const r = await db
    .insertInto("extraction_run")
    .values({
      project_id: v.projectId,
      origin: v.origin,
      target: v.target,
      session_id: v.sessionId,
      draft_id: v.draftId,
      begin_call_id: v.beginCall ?? null,
      status: "running",
      started_at: iso(Date.now()),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return r.id;
}

export async function runOf(db: Reads, draftId: string): Promise<Run | null> {
  return (
    (await db
      .selectFrom("extraction_run")
      .select(["id", "project_id", "origin", "target", "session_id", "status", "begin_call_id", "started_at"])
      .where("draft_id", "=", draftId)
      .executeTakeFirst()) ?? null
  );
}

/** Logs a record tool call before it does anything. It commits on its own, so a call that fails or is rolled back keeps its row. */
export async function logCall(db: Kysely<DB>, projectId: number, tool: string, c: Caller): Promise<number> {
  const r = await db
    .insertInto("record_call")
    .values({
      project_id: projectId,
      tool,
      host: c.host,
      caller_session: c.session,
      caller_turn: c.turn,
      tool_use_id: c.toolUseId,
      mode: c.mode,
      mode_raw: c.raw,
      called_at: iso(Date.now()),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return r.id;
}

/**
 * The host and session a logged call came from: Codex's own metadata, or for Claude Code the session its PreToolUse hook saw. The
 * server's own environment is never trusted for it (a server Claude Code keeps across /clear would name the old session).
 */
export async function callSession(
  db: Reads,
  callId: number,
): Promise<{ host: string; session: string } | null> {
  const c = await db
    .selectFrom("record_call as c")
    .leftJoin("tool_call_observation as o", (j) =>
      j.on("o.host", "=", "claude-code").onRef("o.tool_use_id", "=", "c.tool_use_id"),
    )
    .select(["c.host", "c.caller_session", "o.session_external"])
    .where("c.id", "=", callId)
    .executeTakeFirst();
  if (!c?.host) return null;
  const session = c.host === "codex" ? c.caller_session : c.session_external;
  return session ? { host: c.host, session } : null;
}

/** A session's messages in order, with whether an earlier run already looked at each. */
export async function sessionSources(db: Reads, sessionId: string) {
  return db
    .selectFrom("source as m")
    .where("m.session_id", "=", sessionId)
    .select((eb) => [
      "m.id",
      "m.external_id",
      "m.author_kind",
      "m.turn_id",
      "m.created_at",
      "m.captured_at",
      "m.text",
      "m.truncated",
      eb
        .exists(
          eb.selectFrom("source_processing as p").whereRef("p.source_id", "=", "m.id").select(sql`1`.as("x")),
        )
        .as("looked"),
    ])
    .orderBy("m.created_at")
    .orderBy("m.id")
    .execute();
}

export async function sessionEdits(db: Reads, sessionId: string) {
  return db
    .selectFrom("edit_observation")
    .where("session_id", "=", sessionId)
    .select(["path", "via", "turn_id"])
    .orderBy("id")
    .execute();
}

/** Active and candidate records of the project, newest first: what a new record may supersede or conflict with. */
export async function liveUnits(db: Reads, projectId: number, limit = 40) {
  return db
    .selectFrom("unit")
    .where("project_id", "=", projectId)
    .where("lifecycle", "in", ["active", "candidate"])
    .where("extraction", "=", "supported")
    .select(["key", "kind", "stance", "lifecycle", "text"])
    .orderBy("id", "desc")
    .limit(limit)
    .execute();
}
