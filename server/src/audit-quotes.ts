// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Lists the saved rows that rest on words the quotation rule refuses, for the owner to judge. It only reads: a row was saved under the
// rule of its day, and the rule reads markup, not meaning, so nothing is changed here.
import type { Reads } from "./db.ts";
import { notOwnWords } from "./own-words.ts";

export const KINDS = [
  "adoption",
  "retraction reason",
  "reconsider condition",
  "anchor reason",
  "field definition",
] as const;

export type Finding = {
  project: string;
  /** The record's key, or the field's name */
  what: string;
  kind: (typeof KINDS)[number];
  /** The table and the row's id, to find it again */
  row: string;
  source: number;
  start: number;
  end: number;
  why: "block" | "inline";
  /** Whether it has effect now. A retraction, an anchor's reason, and a definition always do: none of them can be taken back */
  live: boolean;
};

export type Audit = {
  findings: Finding[];
  /** How many rows of each kind were read */
  read: number;
  /** Rows whose words cannot be checked: the words a link rested on are not kept, and a withdrawal or a resolution keeps no span */
  unchecked: { links: number; withdrawals: number; resolutions: number };
};

/** What the owner can do about a finding of each kind, and what cannot be undone */
export const REPAIR: Record<Finding["kind"], string> = {
  adoption:
    "if it is not your decision, retract it with glean's retract_adoption, giving your own words as the reason. The adoption stays in the history",
  "retraction reason":
    "a retraction cannot be undone, and the same words cannot be added again: add evidence or adoption from other words, or save a successor",
  "reconsider condition":
    "retract the condition's quote with glean's retract_evidence (the decision stays), or save a successor with the condition you stated",
  "anchor reason":
    "put the record back where it belongs with glean's anchor or replace_anchor. The retired anchor's row stays",
  "field definition":
    "a definition cannot be changed or withdrawn: define the field again under another name, or forget the message, which removes the message and everything that quotes it",
};

/** What can be said of the rows whose words cannot be checked: what to look at, and what cannot be undone. One line per kind that has rows. */
export function uncheckedLines(unchecked: Audit["unchecked"]): string[] {
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return [
    unchecked.links
      ? `${count(unchecked.links, "link", "links")} from harvest or glean: the words a supersedes or conflicts link rested on are not kept. Read the record's evidence and adoption to judge it`
      : "",
    unchecked.withdrawals
      ? `${count(unchecked.withdrawals, "withdrawal", "withdrawals")}: the reason's message is kept, not its span. A withdrawal cannot be undone: if one was wrong, save the record again under a new key`
      : "",
    unchecked.resolutions
      ? `${count(unchecked.resolutions, "resolved conflict", "resolved conflicts")}: the reason's message is kept, not its span. A resolved conflict cannot be reopened: save a successor of one side that names the other in conflicts`
      : "",
  ].filter(Boolean);
}

export async function auditQuotes(db: Reads): Promise<Audit> {
  const findings: Finding[] = [];
  let read = 0;
  const judge = (
    kind: Finding["kind"],
    r: {
      project: string;
      what: string;
      row: string;
      source: number;
      start: number;
      end: number;
      text: string;
      live: boolean;
    },
  ) => {
    read++;
    const why = notOwnWords(r.text, r.start, r.end);
    if (why)
      findings.push({
        project: r.project,
        what: r.what,
        kind,
        row: r.row,
        source: r.source,
        start: r.start,
        end: r.end,
        why,
        live: r.live,
      });
  };

  for (const a of await db
    .selectFrom("unit_adoption as a")
    .innerJoin("unit as u", "u.id", "a.unit_id")
    .innerJoin("project as p", "p.id", "u.project_id")
    .innerJoin("source as s", "s.id", "a.source_id")
    .select([
      "a.id",
      "u.key",
      "p.name",
      "a.source_id",
      "a.span_start",
      "a.span_end",
      "s.text",
      "a.retracted_at",
    ])
    .orderBy("a.id")
    .execute())
    judge("adoption", {
      project: a.name,
      what: a.key,
      row: `unit_adoption ${a.id}`,
      source: a.source_id,
      start: a.span_start,
      end: a.span_end,
      text: a.text,
      live: a.retracted_at === null,
    });

  const reason = (
    table: string,
    r: {
      id: number;
      key: string;
      name: string;
      source: number;
      retraction_span_start: number | null;
      retraction_span_end: number | null;
      text: string;
    },
  ) =>
    judge("retraction reason", {
      project: r.name,
      what: r.key,
      row: `${table} ${r.id}`,
      source: r.source,
      start: r.retraction_span_start ?? 0,
      end: r.retraction_span_end ?? 0,
      text: r.text,
      live: true,
    });
  for (const r of await db
    .selectFrom("unit_adoption as r")
    .innerJoin("unit as u", "u.id", "r.unit_id")
    .innerJoin("project as p", "p.id", "u.project_id")
    .innerJoin("source as s", "s.id", "r.retraction_source_id")
    .select([
      "r.id",
      "u.key",
      "p.name",
      "s.id as source",
      "r.retraction_span_start",
      "r.retraction_span_end",
      "s.text",
    ])
    .where("r.retraction_span_end", "is not", null)
    .orderBy("r.id")
    .execute())
    reason("unit_adoption", r);
  for (const r of await db
    .selectFrom("unit_evidence as r")
    .innerJoin("unit as u", "u.id", "r.unit_id")
    .innerJoin("project as p", "p.id", "u.project_id")
    .innerJoin("source as s", "s.id", "r.retraction_source_id")
    .select([
      "r.id",
      "u.key",
      "p.name",
      "s.id as source",
      "r.retraction_span_start",
      "r.retraction_span_end",
      "s.text",
    ])
    .where("r.retraction_span_end", "is not", null)
    .orderBy("r.id")
    .execute())
    reason("unit_evidence", r);

  for (const e of await db
    .selectFrom("unit_evidence as e")
    .innerJoin("unit as u", "u.id", "e.unit_id")
    .innerJoin("project as p", "p.id", "u.project_id")
    .innerJoin("source as s", "s.id", "e.source_id")
    .select([
      "e.id",
      "u.key",
      "p.name",
      "e.source_id",
      "e.span_start",
      "e.span_end",
      "s.text",
      "e.retracted_at",
    ])
    .where("e.role", "=", "reconsiders")
    .orderBy("e.id")
    .execute())
    judge("reconsider condition", {
      project: e.name,
      what: e.key,
      row: `unit_evidence ${e.id}`,
      source: e.source_id,
      start: e.span_start,
      end: e.span_end,
      text: e.text,
      live: e.retracted_at === null,
    });

  for (const r of await db
    .selectFrom("unit_anchor_retirement as r")
    .innerJoin("unit_anchor as an", "an.id", "r.anchor_id")
    .innerJoin("unit as u", "u.id", "an.unit_id")
    .innerJoin("project as p", "p.id", "u.project_id")
    .innerJoin("source as s", "s.id", "r.source_id")
    .select(["r.anchor_id", "u.key", "p.name", "r.source_id", "r.span_start", "r.span_end", "s.text"])
    .orderBy("r.anchor_id")
    .execute())
    judge("anchor reason", {
      project: r.name,
      what: r.key,
      row: `unit_anchor_retirement ${r.anchor_id}`,
      source: r.source_id,
      start: r.span_start,
      end: r.span_end,
      text: r.text,
      live: true,
    });

  for (const f of await db
    .selectFrom("field_def as f")
    .innerJoin("project as p", "p.id", "f.project_id")
    .innerJoin("source as s", "s.id", "f.source_id")
    .select(["f.id", "f.name as field", "p.name", "f.source_id", "f.span_start", "f.span_end", "s.text"])
    .orderBy("f.id")
    .execute())
    judge("field definition", {
      project: f.name,
      what: f.field,
      row: `field_def ${f.id}`,
      source: f.source_id,
      start: f.span_start,
      end: f.span_end,
      text: f.text,
      live: true,
    });

  const count = async (q: { executeTakeFirstOrThrow(): Promise<{ n: number | bigint | string }> }) =>
    Number((await q.executeTakeFirstOrThrow()).n);
  const links = await count(
    db
      .selectFrom("unit_link as l")
      .innerJoin("extraction_run as r", "r.id", "l.run_id")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("r.origin", "in", ["harvest", "glean"]),
  );
  const withdrawals = await count(
    db
      .selectFrom("unit_state")
      .select((eb) => eb.fn.countAll().as("n"))
      // Counted whether or not the reason's message is still there: forgetting it leaves the withdrawal
      .where("to_state", "=", "withdrawn")
      .where("run_id", "is not", null),
  );
  const resolutions = await count(
    db
      .selectFrom("unit_link")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("kind", "=", "conflicts")
      .where("resolved_at", "is not", null),
  );
  return { findings, read, unchecked: { links, withdrawals, resolutions } };
}
