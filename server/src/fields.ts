// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The fields the owner defined for this project, as one Markdown table: what each tracks and how many records carry a value, so the
// owner can judge whether the trial is worth keeping. Every cell is text people or agents wrote, so it is flattened and its pipes escaped.

import type { Reads } from "./db.ts";
import { framed } from "./frame.ts";
import { inline } from "./panel.ts";
import { fitCount, READ_BUDGET } from "./reply-budget.ts";

/**
 * One table cell: a single line cut to 200 characters, then backslashes doubled and pipes escaped. GFM splits a row at a pipe after an
 * even run of backslashes, so escaping only the pipes would let a written `\\|` open another cell.
 */
const cell = (s: string) =>
  [...inline(s)].slice(0, 200).join("").replaceAll("\\", "\\\\").replaceAll("|", "\\|");

/**
 * The fields table as the read server returns it: wrapped as past records, since every cell is text someone wrote, and one page of it,
 * the rows after the definition `after` that fit READ_BUDGET, with the call that gives the next page.
 */
export async function fieldsText(db: Reads, projectId: number, after = 0): Promise<string> {
  const defs = await db
    .selectFrom("field_def as d")
    .innerJoin("source as s", "s.id", "d.source_id")
    .leftJoin("unit_field as f", "f.field_def_id", "d.id")
    .where("d.project_id", "=", projectId)
    .where("d.id", ">", after)
    .select((eb) => [
      "d.id",
      "d.name",
      "d.type",
      "d.label",
      "d.description",
      "d.enum_values",
      "d.kinds",
      "d.span_start",
      "d.span_end",
      "s.id as source",
      "s.created_at",
      "s.text",
      eb.fn.count<number>("f.unit_id").distinct().as("records"),
    ])
    .groupBy("d.id")
    .orderBy("d.id")
    .execute();
  if (!defs.length)
    return framed(
      after
        ? `No field is defined after ${after}.`
        : 'No fields are defined in this project. The owner defines one in a session (for example, "record the affected tenant as tenant"), and trace saves it with the owner\'s words.',
    );
  const rows = defs.map((d) => {
    const values = d.enum_values === null ? "" : (JSON.parse(d.enum_values) as string[]).join(", ");
    const kinds = JSON.parse(d.kinds) as string[];
    const quote = Buffer.from(d.text, "utf8").subarray(d.span_start, d.span_end).toString("utf8");
    return [
      d.name,
      d.type,
      d.label,
      d.description,
      values,
      kinds.length ? kinds.join(", ") : "every kind",
      String(d.records),
      `s${d.source}, ${d.created_at}: "${quote}"`,
    ].map(cell);
  });
  const header = [
    "| Name | Type | Label | Description | Values | Applies to | Records with a value | Defined by the owner |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const lines = rows.map((r) => `| ${r.join(" | ")} |`);
  // The call for the next page goes after the frame's closing line, where only Sphica writes
  const reply = (kept: number) =>
    [
      framed([...header, ...lines.slice(0, kept)].join("\n")),
      ...(kept < lines.length
        ? [`${lines.length - kept} more fields: call fields with after: ${defs[kept - 1]?.id ?? after}.`]
        : []),
    ].join("\n");
  return reply(fitCount(lines, READ_BUDGET, reply));
}
