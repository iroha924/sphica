// The fields the owner defined for this project, as one Markdown table: what each tracks and how many records carry a value, so the
// owner can judge whether the trial is worth keeping. Every cell is text people or agents wrote, so it is flattened and its pipes escaped.

import type { Kysely } from "kysely";
import type { DB } from "./db-types.ts";
import { inline } from "./panel.ts";
import { head } from "./text.ts";

/** One table cell: a single line cut to 200 bytes, with its pipes escaped so it cannot open another cell. */
const cell = (s: string) => head(inline(s), 200).replaceAll("|", "\\|");

export async function fieldsTable(db: Kysely<DB>, projectId: number): Promise<string> {
  const defs = await db
    .selectFrom("field_def as d")
    .innerJoin("source as s", "s.id", "d.source_id")
    .leftJoin("unit_field as f", "f.field_def_id", "d.id")
    .where("d.project_id", "=", projectId)
    .select((eb) => [
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
    return 'No fields are defined in this project. The owner defines one in a session (for example, "record the affected tenant as tenant"), and trace saves it with the owner\'s words.';
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
  return [
    "| Name | Type | Label | Description | Values | Applies to | Records with a value | Defined by the owner |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}
