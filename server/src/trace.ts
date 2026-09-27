// What trace reads: sessions not traced yet, the run a draft is bound to, and a session's sources, edits, and the project's live records.
import { type Kysely, sql } from "kysely";
import { iso } from "./db.ts";
import type { DB } from "./db-types.ts";

/** Sessions with owner messages no extraction has looked at, newest first. */
export async function pendingSessions(db: Kysely<DB>, projectId: number, limit = 20) {
  return db
    .selectFrom("session as s")
    .innerJoin("source as m", "m.session_id", "s.id")
    .where("s.project_id", "=", projectId)
    .where("m.author_kind", "=", "owner")
    .where((eb) =>
      eb.not(
        eb.exists(
          eb.selectFrom("source_processing as p").whereRef("p.source_id", "=", "m.id").select(sql`1`.as("x")),
        ),
      ),
    )
    .groupBy("s.id")
    .select((eb) => [
      "s.id",
      "s.host",
      "s.started_at",
      "s.branch",
      eb.fn.countAll<number>().as("waiting"),
      eb.fn.min("m.id").as("first"),
    ])
    .orderBy("s.started_at", "desc")
    .limit(limit)
    .execute();
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
    origin: "trace" | "harvest" | "glean";
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
