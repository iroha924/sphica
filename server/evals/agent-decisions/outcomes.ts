// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// How the records that were ever active as an AI's decision held up: what happened to each later (the owner adopted, replaced, or withdrew
// it, the AI's adoption was taken back, it went back to a candidate, or nothing), and, for the ones nothing happened to, whether Claude and
// Codex each judge that it still holds against the code now.
// No change is not counted as holding up: those are labelled, and a disagreement between the two labels is unknown.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { type Authority, agentHistory, authorityOf } from "../../src/authority.ts";
import { openReader, type Reads } from "../../src/db.ts";
import { projectId } from "../../src/project.ts";

export type Outcome = "owner adopted" | "replaced" | "withdrawn" | "taken back" | "deactivated" | "unchanged";
const OUTCOMES: Outcome[] = [
  "owner adopted",
  "replaced",
  "withdrawn",
  "taken back",
  "deactivated",
  "unchanged",
];

const LABELS = ["holds", "no longer holds", "unknown"] as const;
type Label = (typeof LABELS)[number];

export type Row = {
  unit: number;
  key: string;
  activeAt: string;
  lifecycle: string;
  authority: Authority;
  outcome: Outcome;
  /** The record that replaced it, and whose decision that record is now */
  replacedBy: { unit: number; key: string; authority: Authority } | null;
};

/** What happened to it after it became an AI's decision. What ended it outranks who adopted it, and no longer active outranks the owner's adoption */
export function outcomeOf(r: { lifecycle: string; authority: Authority }): Outcome {
  if (r.lifecycle === "withdrawn") return "withdrawn";
  if (r.lifecycle === "superseded") return "replaced";
  if (r.authority === "none") return "taken back";
  if (r.lifecycle === "candidate") return "deactivated";
  return r.authority === "owner" ? "owner adopted" : "unchanged";
}

export async function outcomes(db: Reads, project: number): Promise<Row[]> {
  const history = await agentHistory(db, project);
  if (!history.length) return [];
  // The replacement in effect, not a supersedes link that has not taken effect
  const links = await db
    .selectFrom("unit_replacement as r")
    .innerJoin("unit as f", "f.id", "r.from_unit")
    .where("r.ended_at", "is", null)
    .where(
      "r.to_unit",
      "in",
      history.map((h) => h.id),
    )
    .select(["r.to_unit", "f.id", "f.key"])
    .execute();
  const whose = await authorityOf(
    db,
    links.map((l) => l.id),
  );
  return history.map((h) => {
    const by = links.find((l) => l.to_unit === h.id);
    return {
      unit: h.id,
      key: h.key,
      activeAt: h.activeAt,
      lifecycle: h.lifecycle,
      authority: h.authority,
      outcome: outcomeOf(h),
      replacedBy: by ? { unit: by.id, key: by.key, authority: whose.get(by.id) ?? "none" } : null,
    };
  });
}

/** Claude's and Codex's labels of one unchanged record, each made without seeing the other's */
export type Labelled = {
  unit: number;
  claude: Label;
  claude_reason: string;
  codex: Label;
  codex_reason: string;
};

const settle = (l: Labelled): Label => (l.claude === l.codex ? l.claude : "unknown");

/** Each model's label is one of the fixed set and carries a reason, and each record is labelled once */
function checkLabels(labels: Labelled[]): void {
  const seen = new Set<number>();
  for (const l of labels) {
    if (seen.has(l.unit)) throw new Error(`u${l.unit} is labelled more than once`);
    seen.add(l.unit);
    for (const by of ["claude", "codex"] as const) {
      if (!(LABELS as readonly unknown[]).includes(l[by]))
        throw new Error(
          `u${l.unit}: ${by}'s label ${JSON.stringify(l[by])} is not one of ${LABELS.join(", ")}`,
        );
      if (typeof l[`${by}_reason`] !== "string" || !l[`${by}_reason`].trim())
        throw new Error(`u${l.unit}: ${by}'s label has no reason`);
    }
  }
}

export type Counts = { outcomes: Record<Outcome, number>; unchanged: Record<Label, number> };

/** Counts the outcomes, and the settled labels of the unchanged records; an unchanged record without both labels is an error */
export function count(rows: Row[], labels: Labelled[]): Counts {
  checkLabels(labels);
  const unchanged = Object.fromEntries(LABELS.map((l) => [l, 0])) as Record<Label, number>;
  for (const r of rows.filter((x) => x.outcome === "unchanged")) {
    const l = labels.find((x) => x.unit === r.unit);
    if (!l) throw new Error(`u${r.unit} (${r.key}) is unchanged but has no labels`);
    unchanged[settle(l)] += 1;
  }
  const stray = labels.filter((l) => !rows.some((r) => r.unit === l.unit && r.outcome === "unchanged"));
  if (stray.length)
    throw new Error(
      `labels for records that are not unchanged: ${stray.map((l) => `u${l.unit}`).join(", ")}`,
    );
  return {
    outcomes: Object.fromEntries(
      OUTCOMES.map((o) => [o, rows.filter((r) => r.outcome === o).length]),
    ) as Record<Outcome, number>,
    unchanged,
  };
}

type Baseline = { rows: Row[]; labels: Labelled[]; counts: Counts };

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      project: { type: "string" },
      labels: { type: "string" },
      note: { type: "string" },
      out: { type: "string" },
      check: { type: "string" },
    },
  });
  if (values.check) {
    const file = JSON.parse(fs.readFileSync(values.check, "utf8")) as Baseline;
    const now = count(file.rows, file.labels);
    console.log(JSON.stringify(file.counts));
    if (JSON.stringify(now) !== JSON.stringify(file.counts)) {
      console.error(`the rows and labels give ${JSON.stringify(now)}`);
      process.exitCode = 1;
    }
    return;
  }
  const missing = (["db", "project", "out"] as const).filter((k) => !values[k]);
  if (missing.length)
    throw new Error(`pass --check <file>, or ${missing.map((k) => `--${k}`).join(", ")} to extract`);
  if (path.resolve(values.out as string) === path.resolve(values.db as string))
    throw new Error("--out is the database --db reads; write the output elsewhere");
  const reader = openReader(values.db as string);
  try {
    const id = await projectId(reader, values.project as string);
    if (id === null) throw new Error(`no project ${values.project} in ${values.db}`);
    const rows = await outcomes(reader, id);
    const labels = values.labels
      ? (JSON.parse(fs.readFileSync(values.labels, "utf8")) as { labels: Labelled[] }).labels
      : [];
    // Without labels the file lists the records to label, and counts nothing
    const out = {
      note: values.note ?? "",
      extracted_at: new Date().toISOString(),
      ...(values.labels ? { counts: count(rows, labels) } : {}),
      rows,
      labels,
    };
    fs.writeFileSync(values.out as string, `${JSON.stringify(out, null, 2)}\n`);
    console.log(JSON.stringify(out.counts ?? rows.map((r) => [r.key, r.outcome])));
  } finally {
    await reader.destroy();
  }
}

if (process.argv[1] && /outcomes\.(ts|js)$/.test(process.argv[1])) await main();
