// What Sphica holds for one project: current work and coverage (captured, extracted, and still waiting), for MCP status and the CLI.
import { type Kysely, sql } from "kysely";
import type { DB } from "./db-types.ts";
import { plural } from "./text.ts";

type Coverage = {
  sessions: number;
  /** Sessions with owner messages that no extraction has looked at yet */
  pendingSessions: number;
  /** Sessions a run looked at that gave no record */
  emptySessions: number;
  sources: number;
  active: number;
  candidates: number;
  quarantined: number;
  work: { title: string; current: string; status: string }[];
};

async function coverage(db: Kysely<DB>, projectId: number): Promise<Coverage> {
  const count = async (q: Promise<{ n: number | string | bigint } | undefined>) => Number((await q)?.n ?? 0);
  const units = (where: (q: ReturnType<typeof unitBase>) => ReturnType<typeof unitBase>) =>
    count(
      where(unitBase())
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .executeTakeFirst(),
    );
  const unitBase = () => db.selectFrom("unit").where("project_id", "=", projectId);
  const processed = (outcome: "units" | "no_unit") =>
    db
      .selectFrom("source_processing as p")
      .innerJoin("source as m", "m.id", "p.source_id")
      .where("m.project_id", "=", projectId)
      .where("p.outcome", "=", outcome)
      .where("m.session_id", "is not", null)
      .select("m.session_id");
  const [sessions, pendingSessions, emptySessions, sources, active, candidates, quarantined, work] =
    await Promise.all([
      count(
        db
          .selectFrom("session")
          .where("project_id", "=", projectId)
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .executeTakeFirst(),
      ),
      count(
        db
          .selectFrom("session as s")
          .where("s.project_id", "=", projectId)
          .where((eb) =>
            eb.exists(
              eb
                .selectFrom("source as m")
                .whereRef("m.session_id", "=", "s.id")
                .where("m.author_kind", "=", "owner")
                .where((eb2) =>
                  eb2.not(
                    eb2.exists(
                      eb2
                        .selectFrom("source_processing as p")
                        .whereRef("p.source_id", "=", "m.id")
                        .select(sql`1`.as("x")),
                    ),
                  ),
                )
                .select(sql`1`.as("x")),
            ),
          )
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .executeTakeFirst(),
      ),
      count(
        db
          .selectFrom("session")
          .where("id", "in", processed("no_unit"))
          .where("id", "not in", processed("units"))
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .executeTakeFirst(),
      ),
      count(
        db
          .selectFrom("source")
          .where("project_id", "=", projectId)
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .executeTakeFirst(),
      ),
      units((q) => q.where("lifecycle", "=", "active")),
      units((q) => q.where("lifecycle", "=", "candidate").where("extraction", "=", "supported")),
      units((q) => q.where("extraction", "=", "quarantined")),
      db
        .selectFrom("work")
        .where("project_id", "=", projectId)
        .where("status", "in", ["active", "blocked", "paused"])
        .orderBy("updated_at", "desc")
        .select(["title", "current", "status"])
        .limit(5)
        .execute(),
    ]);
  return { sessions, pendingSessions, emptySessions, sources, active, candidates, quarantined, work };
}

export async function status(db: Kysely<DB>, projectId: number, name: string): Promise<string> {
  const c = await coverage(db, projectId);
  const lines = [
    `${name}`,
    `Captured: ${plural(c.sessions, "session")}, ${plural(c.sources, "source")}.`,
    `Extracted: ${plural(c.active, "active record")}, ${plural(c.candidates, "candidate")} waiting for adoption, ${plural(c.quarantined, "quarantined record")}.`,
    c.pendingSessions
      ? `${plural(c.pendingSessions, "session")} not traced yet: their decisions exist only as captured text (run /sphica:trace pending).`
      : "Every captured session has been traced.",
    ...(c.emptySessions ? [`${plural(c.emptySessions, "session")} traced with nothing to record.`] : []),
    ...(c.work.length
      ? ["Work in progress:", ...c.work.map((w) => `- ${w.title} (${w.status}): ${w.current}`)]
      : ["No work in progress."]),
  ];
  return lines.join("\n");
}
