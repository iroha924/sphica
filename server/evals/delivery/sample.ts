// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The delivery precision sample: every record a hook delivered in a window, pinned to a file so the same sample can be drawn again after
// the delivery log has pruned rows, then a seeded sample with labelling sheets, and the bar fixed before labelling.
import crypto from "node:crypto";
import fs from "node:fs";
import { parseArgs } from "node:util";
import type { ReadonlyKysely } from "kysely/readonly";
import { openReader } from "../../src/db.ts";
import type { DB } from "../../src/db-types.ts";

export type Window = { from: string; to: string };

/** One delivered record: the delivery row's id and the unit's id */
export type DeliveredPair = [number, number];

export type Population = {
  project: string;
  window: Window;
  condition: string;
  extracted_at: string;
  size: number;
  sha256: string;
  pairs: DeliveredPair[];
};

const CONDITION =
  "delivery_unit pairs of the project's delivery rows with outcome emitted and from <= at < to, every event, main and subagent, ordered by at, delivery id, unit id";

/** The delivered pairs of one project in the window, in the order the sample shuffles them from */
export async function extract(
  db: ReadonlyKysely<DB>,
  projectId: number,
  w: Window,
): Promise<DeliveredPair[]> {
  const rows = await db
    .selectFrom("delivery as d")
    .innerJoin("session as s", "s.id", "d.session_id")
    .innerJoin("delivery_unit as du", "du.delivery_id", "d.id")
    .where("s.project_id", "=", projectId)
    .where("d.outcome", "=", "emitted")
    .where("d.at", ">=", w.from)
    .where("d.at", "<", w.to)
    .select(["d.id as delivery", "du.unit_id as unit"])
    .orderBy("d.at")
    .orderBy("d.id")
    .orderBy("du.unit_id")
    .execute();
  return rows.map((r) => [r.delivery, r.unit]);
}

export const digest = (pairs: DeliveredPair[]): string =>
  crypto.createHash("sha256").update(JSON.stringify(pairs)).digest("hex");

/** What differs between the pinned population and one extracted again: empty when they match */
export function differences(pinned: Population, fresh: DeliveredPair[]): string[] {
  const out: string[] = [];
  if (digest(pinned.pairs) !== pinned.sha256)
    out.push(`the pinned pairs do not hash to the pinned sha256 ${pinned.sha256}`);
  const key = (p: DeliveredPair) => `${p[0]}:${p[1]}`;
  const now = new Set(fresh.map(key));
  const then = new Set(pinned.pairs.map(key));
  const gone = pinned.pairs.filter((p) => !now.has(key(p)));
  const added = fresh.filter((p) => !then.has(key(p)));
  if (gone.length)
    out.push(
      `${gone.length} pinned pairs are no longer in the database, first ${key(gone[0] as DeliveredPair)}`,
    );
  if (added.length)
    out.push(
      `${added.length} pairs are in the database but not pinned, first ${key(added[0] as DeliveredPair)}`,
    );
  if (!gone.length && !added.length && digest(fresh) !== pinned.sha256)
    out.push("the same pairs come back in another order");
  return out;
}

async function pin(file: string, project: string, w: Window, population: string): Promise<void> {
  const db = openReader(file);
  try {
    const p = await db.selectFrom("project").select("id").where("name", "=", project).executeTakeFirst();
    if (!p) throw new Error(`no project named ${project} in ${file}`);
    const pairs = await extract(db, p.id, w);
    if (fs.existsSync(population)) {
      const pinned = JSON.parse(fs.readFileSync(population, "utf8")) as Population;
      if (pinned.project !== project || pinned.window.from !== w.from || pinned.window.to !== w.to)
        throw new Error(
          `${population} pins ${pinned.project} from ${pinned.window.from} to ${pinned.window.to}, not this extraction`,
        );
      const diff = differences(pinned, pairs);
      if (diff.length)
        throw new Error(`the database no longer gives the pinned population:\n${diff.join("\n")}`);
      console.log(`${pairs.length} pairs, the same as ${population}`);
      return;
    }
    const out: Population = {
      project,
      window: w,
      condition: CONDITION,
      extracted_at: new Date().toISOString(),
      size: pairs.length,
      sha256: digest(pairs),
      pairs,
    };
    fs.writeFileSync(population, `${JSON.stringify(out)}\n`);
    console.log(`${pairs.length} pairs pinned to ${population}`);
  } finally {
    await db.destroy();
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      project: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      population: { type: "string" },
    },
  });
  if (values.db) {
    const missing = (["project", "from", "to", "population"] as const).filter((k) => !values[k]);
    if (missing.length) throw new Error(`--db needs ${missing.map((k) => `--${k}`).join(", ")}`);
    await pin(
      values.db,
      values.project as string,
      { from: values.from as string, to: values.to as string },
      values.population as string,
    );
    return;
  }
  throw new Error("pass --db to pin a population");
}

if (process.argv[1] && /sample\.(ts|js)$/.test(process.argv[1])) await main();
