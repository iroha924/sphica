// On-request overviews for MCP overview: every live decision and constraint by directory (live), and records that need a look (look).
// Both read the database and the working tree only, and name records by key so the agent reads each before relying on it.
import path from "node:path";
import { z } from "zod";
import { checkAnchor, fileState } from "./anchors.ts";
import { AI_DECIDED, authorityOf } from "./authority.ts";
import type { Reads } from "./db.ts";
import { inline } from "./panel.ts";
import { UNSUPPORTED } from "./read.ts";
import { ruleFiles } from "./rule-files.ts";
import { bytes, head } from "./text.ts";

/** One page: 50 records whose key, text, paths, and heading are each clipped, so a page stays under 64 KiB. Past it the reply says where to go on. */
export const OVERVIEW_LIMITS = { records: 50, key: 200, text: 300, paths: 520, heading: 120 } as const;

const PROJECT_WIDE = "Project-wide (no code location)";

/** Whole paths while they fit the budget, then how many more; a single path longer than the budget is cut. */
function pathList(paths: string[]): string {
  const all = paths.map(inline);
  const out: string[] = [];
  let used = 0;
  for (const p of all) {
    if (used + Buffer.byteLength(p) + 2 > OVERVIEW_LIMITS.paths) break;
    out.push(p);
    used += Buffer.byteLength(p) + 2;
  }
  if (!out.length) out.push(head(all[0] ?? "", OVERVIEW_LIMITS.paths));
  return `${out.join(", ")}${all.length > out.length ? ` (+${all.length - out.length} more)` : ""}`;
}

/** A page of the project's active decisions and constraints in id order after `after`, grouped by the directory each first applies to. */
export async function liveOverview(db: Reads, projectId: number, after: number | null): Promise<string> {
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

  const whose = await authorityOf(
    db,
    rows.map((r) => r.id),
  );
  // Each record once, under the directory of its first live applies_to anchor; the page is cut before grouping, so the cursor skips nothing
  const shown: { id: number; group: string; line: string }[] = [];
  for (const r of rows.slice(0, OVERVIEW_LIMITS.records)) {
    const paths = [...new Set(anchors.filter((a) => a.unit_id === r.id).map((a) => a.path))];
    const first = paths[0];
    const dir = first === undefined ? null : path.posix.dirname(first);
    // Each part is clipped on its own, so a long text never pushes the paths off the line
    // The id reads the record even when a long key is cut
    const line = `- ${head(inline(r.key), OVERVIEW_LIMITS.key)} (u${r.id}, ${r.kind}${r.stance ? ` ${r.stance}` : ""}${whose.get(r.id) === "agent" ? ", decided by an AI" : ""}): ${head(inline(r.text), OVERVIEW_LIMITS.text)}${paths.length ? ` [${pathList(paths)}]` : ""}`;
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
    // Grouped by the whole directory; only the heading shown is clipped, so two directories never merge
    ...groups.flatMap((g) => [
      `## ${head(inline(g), OVERVIEW_LIMITS.heading)}`,
      ...shown.filter((s) => s.group === g).map((s) => s.line),
      "",
    ]),
    `${shown.length} shown of ${n} active decisions and constraints${after === null ? "" : ` (ids after ${after})`}.`,
    more
      ? `More follow: call overview again with after: ${last}. Pages are read at different times: a record that became active in between, with a lower id, is not on a later page.`
      : "That is the end of the list.",
    "Read a record by its key or u<id> before relying on it.",
    ...(shown.some((x) => whose.get(x.id) === "agent") ? [AI_DECIDED] : []),
  ].join("\n");
}

/** Anchors checked per page, bytes per line, and bytes for all the lines of a page together. */
const LOOK_LIMITS = { anchors: 2000, line: 2200, bytes: 56 * 1024 } as const;
/** A record key as trace, harvest, and glean write it, inside an HTML comment the owner pasted from a rules draft. */
const MARKER = /<!--\s*sphica:\s*((?:trace|harvest|glean):[^\s>]{1,1000})\s*-->/g;

/**
 * Where a look page goes on from: the stage, and the last item of it already dealt with, by a position that does not move when other items
 * come or go (an id, or a marker's file, line, and place in the line). Passed back as given, base64url JSON.
 */
const Cursor = z.discriminatedUnion("s", [
  z.object({ s: z.enum(["anchors", "options", "deferred"]), id: z.number().int().min(0) }).strict(),
  z
    .object({
      s: z.literal("markers"),
      file: z.string().max(4096),
      line: z.number().int().min(0),
      n: z.number().int().min(0),
    })
    .strict(),
]);
type Cursor = z.infer<typeof Cursor>;
const STAGES = ["anchors", "options", "deferred", "markers"] as const;

/** A look cursor from the string a page gave, or null when it is not one. */
export function lookCursor(after: string): Cursor | null {
  try {
    const parsed = Cursor.safeParse(JSON.parse(Buffer.from(after, "base64url").toString("utf8")));
    // Decoding skips characters outside base64url, so only text that encodes back to itself is the cursor a page gave
    return parsed.success && cursorText(parsed.data) === after ? parsed.data : null;
  } catch {
    return null;
  }
}

const cursorText = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString("base64url");

/**
 * Records that need a look, a page at a time: live records whose anchored file is gone or whose symbol is not found, written conditions for
 * reconsidering, and marked lines in instruction files whose record was replaced or withdrawn. A page stops at its byte budget or after
 * checking LOOK_LIMITS.anchors anchors, and moves past an item only once its line is shown. It never decides or changes anything.
 */
export async function lookOverview(
  db: Reads,
  projectId: number,
  root: string | null,
  after?: string,
): Promise<string> {
  const from: Cursor = (after === undefined ? null : lookCursor(after)) ?? { s: "anchors", id: 0 };
  if (after !== undefined && !lookCursor(after)) throw new Error("after is not a cursor a look page gave");
  const stage = STAGES.indexOf(from.s);
  const notChecked: string[] = [];
  const lines = {
    gone: [] as string[],
    lost: [] as string[],
    conditions: [] as string[],
    marked: [] as string[],
  };
  let used = 0;
  let stop: Cursor | null = null;
  /** Adds a line when it fits the page; false means the page is full and the item waits for the next page */
  const fits = (to: string[], line: string) => {
    const shown = head(line, LOOK_LIMITS.line);
    if (used + bytes(shown) + 1 > LOOK_LIMITS.bytes) return false;
    used += bytes(shown) + 1;
    to.push(shown);
    return true;
  };

  // Anchored code: a gone file and a symbol no longer found are different reasons to look
  if (stage <= 0) {
    if (!root) notChecked.push("code locations: no working tree for this project here");
    else {
      const start = from.s === "anchors" ? from.id : 0;
      const anchors = await db
        .selectFrom("unit_anchor as a")
        .innerJoin("unit as u", "u.id", "a.unit_id")
        .where("u.project_id", "=", projectId)
        .where("u.lifecycle", "=", "active")
        .where("a.retired_at", "is", null)
        .where("a.id", ">", start)
        .select(["a.id", "u.key", "u.kind", "a.path", "a.symbol", "a.line_start", "a.role"])
        .orderBy("a.id")
        .limit(LOOK_LIMITS.anchors + 1)
        .execute();
      let unknown = 0;
      let unscanned = 0;
      let last = start;
      for (const a of anchors.slice(0, LOOK_LIMITS.anchors)) {
        const file = fileState(root, a.path);
        let shown = true;
        if (file === "gone")
          shown = fits(lines.gone, `- ${inline(a.key)} (${a.kind}): ${inline(a.path)} (${a.role})`);
        else if (file === "unknown") unknown++;
        else if (a.symbol) {
          const state = checkAnchor(root, a).state;
          if (state === "missing")
            shown = fits(
              lines.lost,
              `- ${inline(a.key)} (${a.kind}): ${inline(a.symbol)} in ${inline(a.path)} (${a.role})`,
            );
          else if (state === "unknown") unscanned++;
        }
        if (!shown) {
          stop = { s: "anchors", id: last };
          break;
        }
        last = a.id;
      }
      if (!stop && anchors.length > LOOK_LIMITS.anchors) stop = { s: "anchors", id: last };
      if (unknown)
        notChecked.push(`${unknown} code locations that lead outside the repository or cannot be followed`);
      if (unscanned)
        notChecked.push(
          `${unscanned} code locations whose file could not be scanned for the symbol (too large, binary, or unreadable)`,
        );
    }
  }

  // Conditions are shown for a person or agent to judge; whether one has come about is never decided here
  if (!stop && stage <= 1) {
    const start = from.s === "options" ? from.id : 0;
    const options = await db
      .selectFrom("unit_option as o")
      .innerJoin("unit as u", "u.id", "o.unit_id")
      .where("u.project_id", "=", projectId)
      .where("u.lifecycle", "=", "active")
      .where("o.reconsider_when", "is not", null)
      .where("o.id", ">", start)
      .select((eb) => [
        "o.id",
        "u.key",
        "o.text",
        "o.reconsider_when",
        eb
          .exists(
            eb
              .selectFrom("unit_evidence as e")
              .innerJoin("source as s", "s.id", "e.source_id")
              .whereRef("e.option_id", "=", "o.id")
              .where("e.role", "=", "reconsiders")
              .where("e.retracted_at", "is", null)
              .where("s.author_kind", "=", "owner")
              .select("e.id"),
          )
          .as("stands"),
      ])
      .orderBy("o.id")
      .execute();
    let last = start;
    for (const o of options) {
      const line = `- ${inline(o.key)}: rejected option ${inline(head(o.text, 120))}, reconsider when: ${inline(head(o.reconsider_when ?? "", 300))}${o.stands ? "" : ` [${UNSUPPORTED}]`}`;
      if (!fits(lines.conditions, line)) {
        stop = { s: "options", id: last };
        break;
      }
      last = o.id;
    }
  }
  if (!stop && stage <= 2) {
    const start = from.s === "deferred" ? from.id : 0;
    const deferred = await db
      .selectFrom("unit")
      .where("project_id", "=", projectId)
      .where("lifecycle", "=", "active")
      .where("revisit_when", "is not", null)
      .where("id", ">", start)
      .select(["id", "key", "text", "revisit_when"])
      .orderBy("id")
      .execute();
    let last = start;
    for (const d of deferred) {
      const line = `- ${inline(d.key)}: deferred ${inline(head(d.text, 120))}, revisit when: ${inline(head(d.revisit_when ?? "", 300))}`;
      if (!fits(lines.conditions, line)) {
        stop = { s: "deferred", id: last };
        break;
      }
      last = d.id;
    }
  }

  // Marked lines in instruction files: only the place and the key are shown, never the line, so the file's text cannot forge lines here
  if (!stop) {
    if (!root) notChecked.push("instruction files: no working tree for this project here");
    else {
      const scan = ruleFiles(root);
      const found: { file: string; line: number; n: number; key: string }[] = [];
      for (const f of scan.files)
        for (const [i, text] of f.text.split(/\r?\n/).entries())
          for (const [n, m] of [...text.matchAll(MARKER)].entries())
            found.push({ file: f.path, line: i + 1, n, key: m[1] ?? "" });
      found.sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : x.line - y.line || x.n - y.n));
      const past = (f: { file: string; line: number; n: number }) =>
        from.s === "markers" &&
        (f.file < from.file ||
          (f.file === from.file && (f.line < from.line || (f.line === from.line && f.n <= from.n))));
      const todo = found.filter((f) => !past(f));
      const keys = [...new Set(todo.map((f) => f.key))];
      // In slices: SQLite takes at most 32,766 parameters in one statement, and instruction files can hold more markers
      const units = new Map<string, { id: number; key: string; lifecycle: string }>();
      for (let i = 0; i < keys.length; i += 500)
        for (const u of await db
          .selectFrom("unit")
          .select(["id", "key", "lifecycle"])
          .where("project_id", "=", projectId)
          .where("key", "in", keys.slice(i, i + 500))
          .execute())
          units.set(u.key, u);
      const chains = new Map<number, { key: string; lifecycle: string } | null>();
      let last: Cursor | null = from.s === "markers" ? from : null;
      for (const f of todo) {
        const u = units.get(f.key);
        const where = `- ${inline(f.file)}:${f.line}: ${inline(f.key)}`;
        let line: string | null = null;
        if (!u) line = `${where} is not a record of this project`;
        else if (u.lifecycle === "withdrawn") line = `${where} was withdrawn`;
        else if (u.lifecycle === "superseded") {
          // A file can mark the same record thousands of times: its chain is followed once
          let next = chains.get(u.id);
          if (next === undefined) {
            next = await successor(db, u.id);
            chains.set(u.id, next);
          }
          line = `${where} was superseded${next ? ` by ${inline(next.key)}${next.lifecycle === "active" ? "" : `, which is ${next.lifecycle} too`}` : ""}`;
        }
        if (line !== null && !fits(lines.marked, line)) {
          // Before the first marker of this page the stage starts over from the beginning of the markers
          stop = last ?? { s: "markers", file: "", line: 0, n: 0 };
          break;
        }
        last = { s: "markers", file: f.file, line: f.line, n: f.n };
      }
      if (scan.skipped)
        notChecked.push(
          `${scan.skipped} instruction files not read (over the caps, not regular files, or outside the repository)`,
        );
      if (scan.incomplete) notChecked.push(`instruction files: the listing ${scan.incomplete}`);
    }
  }

  // A heading appears on the pages that reach its part of the list: on one page when everything fits
  const reached = (at: number) => stage <= at && (stop === null || STAGES.indexOf(stop.s) >= at);
  const section = (title: string, shown: string[], empty: string) =>
    `## ${title}\n${shown.length ? shown.join("\n") : empty}`;
  const sections: string[] = [];
  if (reached(0)) {
    sections.push(section("Files gone", lines.gone, root ? "none" : "not checked"));
    sections.push(
      section("Symbol not found (the file is still there)", lines.lost, root ? "none" : "not checked"),
    );
  }
  if (reached(1) || reached(2))
    sections.push(
      section(
        "Conditions to reconsider (judge whether one has come about; nothing here is decided)",
        lines.conditions,
        "none",
      ),
    );
  if (reached(3))
    sections.push(section("Rule markers whose record changed", lines.marked, root ? "none" : "not checked"));
  return [
    ...sections,
    `## Not checked\n${notChecked.length ? notChecked.map((n) => `- ${n}`).join("\n") : "nothing: every place above was checked"}`,
    stop
      ? `Partial: more follow. Call overview with view look and after: "${cursorText(stop)}". Pages are read at different times: a record or file that changed in between may be missed or shown twice.`
      : "Complete: every section was listed to its end. Not checked entries on any page still apply.",
    "Read a record by its key before acting on it. Change a record only through /sphica:trace, with the owner's words.",
  ].join("\n\n");
}

/** The end of a record's supersedes chain: the schema refuses cycles, so it ends. The caller says when the end is not active. */
async function successor(db: Reads, id: number): Promise<{ key: string; lifecycle: string } | null> {
  let end: { key: string; lifecycle: string } | null = null;
  let at = id;
  for (;;) {
    // The replacement in effect: a superseded record always has one, and a proposal waiting beside it is not it
    const next = await db
      .selectFrom("unit_replacement as h")
      .innerJoin("unit as u", "u.id", "h.from_unit")
      .where("h.to_unit", "=", at)
      .where("h.ended_at", "is", null)
      .select(["u.id", "u.key", "u.lifecycle"])
      .executeTakeFirst();
    if (!next) break;
    end = { key: next.key, lifecycle: next.lifecycle };
    if (next.lifecycle !== "superseded") break;
    at = next.id;
  }
  return end;
}
