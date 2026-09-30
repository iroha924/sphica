// What trace reads: sessions not traced yet, the run a draft is bound to, and a session's sources, edits, and the project's live records.
import { type ExpressionBuilder, type Kysely, sql } from "kysely";
import { iso } from "./db.ts";
import type { DB, Session } from "./db-types.ts";
import type { BeginOrigin } from "./knowledge.ts";

/** Days after its last owner message that an untraced session stops counting as waiting. Its messages stay and are still found. */
export const PENDING_DAYS = 30;

/** The oldest last-owner-message time that still counts as recent, as stored (ISO 8601 UTC). */
export const pendingCutoff = (now: Date): string =>
  new Date(now.getTime() - PENDING_DAYS * 86_400_000).toISOString();

type InSession = ExpressionBuilder<DB & { s: Session }, "s">;

/** Owner messages of session `s` that no extraction has looked at. */
const untracedOwner = (eb: InSession) =>
  eb
    .selectFrom("source as m")
    .whereRef("m.session_id", "=", "s.id")
    .where("m.author_kind", "=", "owner")
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("source_processing as p").whereRef("p.source_id", "=", "m.id").select(sql`1`.as("x")),
        ),
      ),
    );

/**
 * Sessions of the project with an owner message no extraction has looked at, with the time of their last owner message, traced
 * or not: a session the owner came back to stays recent even when its untraced messages are old. Session start runs this, so each
 * session is read through its own messages (the source_session index), never by grouping the whole project.
 */
export const untracedSessions = (db: Kysely<DB>, projectId: number) =>
  db
    .selectFrom("session as s")
    .where("s.project_id", "=", projectId)
    .where((eb) => eb.exists(untracedOwner(eb).select(sql`1`.as("x"))))
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
      untracedOwner(eb)
        .select((m) => m.fn.countAll<number>().as("waiting"))
        .as("waiting"),
      untracedOwner(eb)
        .select((m) => m.fn.min("m.id").as("first"))
        .as("first"),
    ]);

/**
 * Untraced sessions of one group, the one whose owner came back most recently first, with how many owner messages wait and the
 * first of them. `total` counts the whole group, beyond the limit.
 */
export async function pendingSessions(
  db: Kysely<DB>,
  projectId: number,
  group: "recent" | "older",
  now: Date = new Date(),
  limit = 20,
) {
  const cutoff = pendingCutoff(now);
  const base = db
    .selectFrom(untracedSessions(db, projectId).as("w"))
    .where("w.last", group === "recent" ? ">=" : "<", cutoff);
  const [rows, total] = await Promise.all([
    base.selectAll("w").orderBy("w.last", "desc").limit(limit).execute(),
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
      status: "running",
      started_at: iso(Date.now()),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return r.id;
}

export async function runOf(db: Kysely<DB>, draftId: string): Promise<Run | null> {
  return (
    (await db
      .selectFrom("extraction_run")
      .select(["id", "project_id", "origin", "target", "session_id", "status", "started_at"])
      .where("draft_id", "=", draftId)
      .executeTakeFirst()) ?? null
  );
}

/** A session's messages in order, with whether an earlier run already looked at each. */
export async function sessionSources(db: Kysely<DB>, sessionId: string) {
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

export async function sessionEdits(db: Kysely<DB>, sessionId: string) {
  return db
    .selectFrom("edit_observation")
    .where("session_id", "=", sessionId)
    .select(["path", "via", "turn_id"])
    .orderBy("id")
    .execute();
}

/** Active and candidate records of the project, newest first: what a new record may supersede or conflict with. */
export async function liveUnits(db: Kysely<DB>, projectId: number, limit = 40) {
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
