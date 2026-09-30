// Forgets sources the owner chose: the rows, their index entries, and the bytes left in the file, while the records that cited
// them are judged again with the same activation rules as saving. Runs only on the forget connection, only after the owner
// confirmed a preview.

import { type Kysely, sql } from "kysely";
import { backupDir, backups } from "./backups.ts";
import { iso } from "./db.ts";
import type { DB } from "./db-types.ts";
import { openWriter } from "./db-write.ts";
import { inline } from "./panel.ts";
import { ACTIVATION } from "./record.ts";
import { plural } from "./text.ts";

export type ForgetOutcome = {
  /** Sources that will be (or were) removed. No text: the preview must not show the words being forgotten */
  sources: { id: number; kind: string; artifact: string; bytes: number }[];
  /** Ids forgotten earlier: only the cleanup runs again for them */
  already: number[];
  /** Units whose evidence, adoption, or retraction reasons are removed, and their lifecycle before and after */
  units: { key: string; before: string; after: string; removed: number }[];
  /** Unfetched references the owner gave in a forgotten message */
  references: number;
  /** Field definitions quoting a forgotten source, and field values removed with them or quoting one themselves */
  fields: { definitions: number; values: number };
};

export type Cleanup = "done" | "incomplete";

/** Thrown inside the transaction to roll a preview back; never leaves this file. */
class Preview extends Error {
  readonly outcome: ForgetOutcome;
  constructor(outcome: ForgetOutcome) {
    super("preview");
    this.outcome = outcome;
  }
}

/** The error an unknown id or another project's id gives. The same words for both, so ids of other projects cannot be probed. */
const unknown = (id: number) => new Error(`s${id} is not a source of this project`);

/**
 * Removes the sources inside the caller's transaction and returns what happened. Order matters: what the deletes take is counted before
 * them, and units are judged after the cascade (which also takes each retracted row whose reason cited a removed source).
 */
async function forgetIn(
  trx: Kysely<DB>,
  projectId: number,
  ids: number[],
  at: string,
): Promise<ForgetOutcome> {
  const unique = [...new Set(ids)];
  const rows = unique.length
    ? await trx
        .selectFrom("source")
        .where("id", "in", unique)
        .where("project_id", "=", projectId)
        .select([
          "id",
          "kind",
          "artifact",
          "external_id",
          "revision",
          "content_hash",
          sql<number>`length(cast(text as blob))`.as("bytes"),
        ])
        .orderBy("id")
        .execute()
    : [];
  const gone = unique.length
    ? await trx
        .selectFrom("source_forgotten")
        .where("source_id", "in", unique)
        .where("project_id", "=", projectId)
        .select("source_id")
        .execute()
    : [];
  const already = gone.map((g) => g.source_id).sort((a, b) => a - b);
  for (const id of unique) if (!rows.some((r) => r.id === id) && !already.includes(id)) throw unknown(id);
  const outcome: ForgetOutcome = {
    sources: rows.map((r) => ({ id: r.id, kind: r.kind, artifact: r.artifact, bytes: r.bytes })),
    already,
    units: [],
    references: 0,
    fields: { definitions: 0, values: 0 },
  };
  if (!rows.length) return outcome;
  const targets = rows.map((r) => r.id);

  // Every unit that loses a row: evidence or adoption on a forgotten source, or a retracted row whose reason is one
  const touched = await trx
    .selectFrom("unit as u")
    .where("u.project_id", "=", projectId)
    .where((eb) =>
      eb.or(
        (["unit_evidence", "unit_adoption"] as const).flatMap((t) => [
          eb.exists(
            eb
              .selectFrom(t)
              .select(`${t}.id`)
              .whereRef(`${t}.unit_id`, "=", "u.id")
              .where(`${t}.source_id`, "in", targets),
          ),
          eb.exists(
            eb
              .selectFrom(t)
              .select(`${t}.id`)
              .whereRef(`${t}.unit_id`, "=", "u.id")
              .where(`${t}.retraction_source_id`, "in", targets),
          ),
        ]),
      ),
    )
    .select(["u.id", "u.key", "u.lifecycle"])
    .orderBy("u.id")
    .execute();
  const count = async (t: "unit_evidence" | "unit_adoption", unitId: number) =>
    Number(
      (
        await trx
          .selectFrom(t)
          .where("unit_id", "=", unitId)
          .where((eb) => eb.or([eb("source_id", "in", targets), eb("retraction_source_id", "in", targets)]))
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .executeTakeFirstOrThrow()
      ).n,
    );
  const definitions = await trx
    .selectFrom("field_def")
    .where("project_id", "=", projectId)
    .where("source_id", "in", targets)
    .select("id")
    .execute();
  const defIds = definitions.map((d) => d.id);
  outcome.fields = {
    definitions: defIds.length,
    values: Number(
      (
        await trx
          .selectFrom("unit_field")
          .where((eb) =>
            eb.or([
              eb("source_id", "in", targets),
              ...(defIds.length ? [eb("field_def_id", "in", defIds)] : []),
            ]),
          )
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .executeTakeFirstOrThrow()
      ).n,
    ),
  };
  const removed = new Map<number, number>();
  for (const u of touched)
    removed.set(u.id, (await count("unit_evidence", u.id)) + (await count("unit_adoption", u.id)));

  const batch = (
    await trx
      .insertInto("forget_batch")
      .values({ project_id: projectId, at })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  await trx
    .insertInto("source_forgotten")
    .values(
      rows.map((r) => ({
        source_id: r.id,
        project_id: projectId,
        artifact: r.artifact,
        kind: r.kind,
        external_id: r.external_id,
        revision: r.revision,
        content_hash: r.content_hash,
        batch_id: batch,
      })),
    )
    .execute();
  outcome.references = Number(
    (await trx.deleteFrom("external_reference").where("owner_source_id", "in", targets).executeTakeFirst())
      .numDeletedRows,
  );
  await trx.deleteFrom("source").where("id", "in", targets).execute();

  // Judge active units again with the rules saving uses: back to candidate, then try active. Other lifecycles keep their state
  // (a superseded or withdrawn unit never comes back through a later activation).
  const reason = `sources ${targets.map((id) => `s${id}`).join(", ")} forgotten by the owner`;
  for (const u of touched) {
    let after = u.lifecycle;
    if (u.lifecycle === "active") {
      await trx
        .insertInto("unit_state")
        .values({ unit_id: u.id, from_state: "active", to_state: "candidate", at, reason, forget_id: batch })
        .execute();
      after = "candidate";
      try {
        await trx
          .insertInto("unit_state")
          .values({
            unit_id: u.id,
            from_state: "candidate",
            to_state: "active",
            at,
            reason: "support checked again after forgetting sources",
            forget_id: batch,
          })
          .execute();
        after = "active";
      } catch (e) {
        if (!ACTIVATION.test((e as Error).message)) throw e;
      }
    }
    outcome.units.push({ key: u.key, before: u.lifecycle, after, removed: removed.get(u.id) ?? 0 });
  }
  return outcome;
}

/** What forgetting these sources would do, computed by doing it and rolling back. Unknown ids and other projects' ids are refused. */
export async function previewForget(file: string, projectId: number, ids: number[]): Promise<ForgetOutcome> {
  const db = openWriter("forget", file);
  try {
    return await db.connection().execute(async (c) => {
      await sql`begin immediate`.execute(c);
      try {
        throw new Preview(await forgetIn(c, projectId, ids, iso(Date.now())));
      } catch (e) {
        await sql`rollback`.execute(c).catch(() => {});
        if (e instanceof Preview) return e.outcome;
        throw e;
      }
    });
  } finally {
    await db.destroy();
  }
}

/**
 * Forgets the sources, but only if the result matches the preview the owner confirmed (another writer may have changed what cites
 * them meanwhile). Then clears the bytes the deletion left: the FTS segments (optimize) and the WAL (checkpoint). A reader holding
 * the WAL makes the checkpoint busy; running the same ids again finishes it.
 */
export async function applyForget(
  file: string,
  projectId: number,
  ids: number[],
  confirmed: ForgetOutcome,
  signal?: AbortSignal,
): Promise<{ outcome: ForgetOutcome; cleanup: Cleanup }> {
  const db = openWriter("forget", file);
  try {
    return await db.connection().execute(async (c) => {
      // Overwrite freed pages with zeros, so the deleted text does not stay in the file
      await sql`pragma secure_delete = on`.execute(c);
      await sql`begin immediate`.execute(c);
      let outcome: ForgetOutcome;
      try {
        outcome = await forgetIn(c, projectId, ids, iso(Date.now()));
        if (JSON.stringify(outcome) !== JSON.stringify(confirmed))
          throw new Error(
            "What these sources support changed after you confirmed. Nothing was forgotten; look at the preview again",
          );
        // The call may be cancelled while this waits for the write lock: nothing is committed for a call nobody waits on
        if (signal?.aborted) throw new Error("The call was cancelled, so nothing was forgotten");
        await sql`commit`.execute(c);
      } catch (e) {
        await sql`rollback`.execute(c).catch(() => {});
        throw e;
      }
      // The sources are gone once committed: a cleanup that fails (a busy database) is reported as unfinished, never as a failed forget
      try {
        await sql`insert into source_fts (source_fts) values ('optimize')`.execute(c);
        // A removed field value leaves its words in the unit index segments until they are merged. Every run merges, since a run
        // after a failed cleanup no longer sees the values it removed
        await sql`insert into unit_fts (unit_fts) values ('optimize')`.execute(c);
        const checkpoint = await sql<{ busy: number }>`pragma wal_checkpoint(TRUNCATE)`.execute(c);
        return { outcome, cleanup: checkpoint.rows[0]?.busy === 0 ? "done" : "incomplete" };
      } catch {
        return { outcome, cleanup: "incomplete" };
      }
    });
  } finally {
    await db.destroy();
  }
}

/** The preview and the result in words, without the forgotten text (it would be copied into the session the owner wants it gone from). */
export function forgetText(o: ForgetOutcome, file: string): string {
  const lines = o.sources.map(
    (s) => `- s${s.id} ${s.kind} in ${inline(s.artifact).slice(0, 120)} (${plural(s.bytes, "byte")})`,
  );
  if (o.already.length)
    lines.push(
      `- already forgotten: ${o.already.map((id) => `s${id}`).join(", ")} (only the cleanup runs again)`,
    );
  for (const u of o.units) {
    const change = u.before === u.after ? `stays ${u.after}` : `${u.before} → ${u.after}`;
    lines.push(`- record ${inline(u.key).slice(0, 120)}: ${change}, loses ${plural(u.removed, "citation")}`);
  }
  if (o.references)
    lines.push(`- ${plural(o.references, "unfetched reference")} the forgotten messages gave`);
  if (o.fields.definitions || o.fields.values)
    lines.push(
      `- ${plural(o.fields.definitions, "field definition")} and ${plural(o.fields.values, "field value")} go with them`,
    );
  if (o.units.length || o.fields.values)
    lines.push("Records keep their own text: if one repeats the forgotten words, they stay in it.");
  let copies: number | null;
  try {
    copies = backups(file).length;
  } catch {
    copies = null;
  }
  lines.push(
    copies === null
      ? `Copies outside the database are not touched: capture's waiting and set-aside files. Backups made before migrating in ${backupDir(file)} could not be listed; look there yourself if the words must go from every copy.`
      : copies
        ? `Copies outside the database are not touched: capture's waiting and set-aside files, and ${plural(copies, "backup")} made before migrating, in ${backupDir(file)}. Delete those backups yourself if the words must go from them too.`
        : "Copies outside the database (capture's waiting and set-aside files) are not touched.",
  );
  return lines.join("\n");
}
