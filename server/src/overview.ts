// On-request overviews for MCP overview: every live decision and constraint by directory (live), and records that need a look (look).
// Both read the database and the working tree only, and name records by key so the agent reads each before relying on it.
import path from "node:path";
import type { Kysely } from "kysely";
import type { DB } from "./db-types.ts";
import { inline } from "./panel.ts";
import { head } from "./text.ts";

/** One reply's bounds: 50 lines of at most 600 bytes keep a page under 64 KiB. Past them the reply says where to go on. */
export const OVERVIEW_LIMITS = { records: 50, line: 600 } as const;

const PROJECT_WIDE = "Project-wide (no code location)";

/** A page of the project's active decisions and constraints in id order after `after`, grouped by the directory each first applies to. */
export async function liveOverview(db: Kysely<DB>, projectId: number, after: number | null): Promise<string> {
  const live = db
    .selectFrom("unit")
    .where("project_id", "=", projectId)
    .where("lifecycle", "=", "active")
    .where("kind", "in", ["decision", "constraint"]);
  const [total, rows] = await Promise.all([
    live.select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirst(),
    live
      .select(["id", "key", "kind", "stance", "text"])
      .where("id", ">", after ?? 0)
      .orderBy("id")
      .limit(OVERVIEW_LIMITS.records + 1)
      .execute(),
  ]);
  const anchors = rows.length
    ? await db
        .selectFrom("unit_anchor")
        .select(["unit_id", "path"])
        .where(
          "unit_id",
          "in",
          rows.map((r) => r.id),
        )
        .where("role", "=", "applies_to")
        .where("retired_at", "is", null)
        .orderBy("id")
        .execute()
    : [];

  // Each record once, under the directory of its first live applies_to anchor; the page is cut before grouping, so the cursor skips nothing
  const shown: { id: number; group: string; line: string }[] = [];
  for (const r of rows.slice(0, OVERVIEW_LIMITS.records)) {
    const paths = [...new Set(anchors.filter((a) => a.unit_id === r.id).map((a) => a.path))];
    const first = paths[0];
    const dir = first === undefined ? null : path.posix.dirname(first);
    const line = head(
      `- ${r.key} (${r.kind}${r.stance ? ` ${r.stance}` : ""}): ${inline(r.text)}${paths.length ? ` [${paths.map(inline).join(", ")}]` : ""}`,
      OVERVIEW_LIMITS.line,
    );
    shown.push({
      id: r.id,
      group: dir === null ? PROJECT_WIDE : dir === "." ? "(repository root)" : `${dir}/`,
      line,
    });
  }
  const n = Number(total?.n ?? 0);
  if (!shown.length)
    return after === null
      ? "No active decision or constraint is recorded for this project. status says whether sessions are still untraced."
      : `No active decision or constraint after id ${after}. ${n} in all.`;

  const groups = [...new Set(shown.map((s) => s.group))].sort((a, b) =>
    a === PROJECT_WIDE ? 1 : b === PROJECT_WIDE ? -1 : a.localeCompare(b),
  );
  const last = shown.at(-1)?.id ?? 0;
  const more = rows.length > shown.length;
  return [
    ...groups.flatMap((g) => [
      `## ${inline(g)}`,
      ...shown.filter((s) => s.group === g).map((s) => s.line),
      "",
    ]),
    `${shown.length} shown of ${n} active decisions and constraints${after === null ? "" : ` (ids after ${after})`}.`,
    more
      ? `More follow: call overview again with after: ${last}. Pages are read at different times: a record that became active in between, with a lower id, is not on a later page.`
      : "That is the end of the list.",
    "Read a record by its key before relying on it.",
  ].join("\n");
}
