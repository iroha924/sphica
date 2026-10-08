// On-request overviews for MCP overview: every live decision and constraint by directory (live), and records that need a look (look).
// Both read the database and the working tree only, and name records by key so the agent reads each before relying on it.
import path from "node:path";
import { z } from "zod";
import { checkAnchor, fileState } from "./anchors.ts";
import { AI_DECIDED, authorityOf } from "./authority.ts";
import type { Reads } from "./db.ts";
import { framed } from "./frame.ts";
import { inline } from "./panel.ts";
import { READ_BUDGET, UNSUPPORTED } from "./read.ts";
import { pathHash, ruleFiles } from "./rule-files.ts";
import { bytes, head } from "./text.ts";

/** One page: at most 50 records, each part of a line clipped, and as many as fit READ_BUDGET with the frame. Past it the reply says where to go on. */
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

  const page = (taken: typeof shown): string => {
    const groups = [...new Set(taken.map((s) => s.group))].sort((a, b) =>
      a === PROJECT_WIDE ? 1 : b === PROJECT_WIDE ? -1 : a.localeCompare(b),
    );
    const last = taken.at(-1)?.id ?? 0;
    return [
      // Grouped by the whole directory; only the heading shown is clipped, so two directories never merge
      ...groups.flatMap((g) => [
        `## ${head(inline(g), OVERVIEW_LIMITS.heading)}`,
        ...taken.filter((s) => s.group === g).map((s) => s.line),
        "",
      ]),
      `${taken.length} shown of ${n} active decisions and constraints${after === null ? "" : ` (ids after ${after})`}.`,
      rows.length > taken.length
        ? `More follow: call overview again with after: ${last}. Pages are read at different times: a record that became active in between, with a lower id, is not on a later page.`
        : "That is the end of the list.",
      "Read a record by its key or u<id> before relying on it.",
      ...(taken.some((x) => whose.get(x.id) === "agent") ? [AI_DECIDED] : []),
    ].join("\n");
  };
  // Records in id order, one more at a time, while the whole reply with its frame fits; the first that does not ends the page, so the
  // cursor skips nothing. One record always fits: each part of a line is clipped
  const frame = bytes(framed(""));
  let best = page(shown.slice(0, 1));
  for (let k = 2; k <= shown.length; k++) {
    const candidate = page(shown.slice(0, k));
    if (frame + bytes(candidate) > READ_BUDGET) break;
    best = candidate;
  }
  return best;
}

/** Anchors checked per page, bytes per line, and bytes for all the lines of a page together: the rest of a reply's budget holds the frame,
 * the headings, what was not checked, and the closing lines. */
const LOOK_LIMITS = { anchors: 2000, line: 2200, bytes: READ_BUDGET - 4 * 1024 } as const;
/** Condition rows read for one page: more than its bytes can show (a line is over 28 bytes), so a page never reads the whole rest */
const CONDITION_ROWS = Math.ceil(LOOK_LIMITS.bytes / 28);
/** A record key as trace, harvest, and glean write it, inside an HTML comment the owner pasted from a rules draft. */
const MARKER = /<!--\s*sphica:\s*((?:trace|harvest|glean):[^\s>]{1,1000})\s*-->/g;
/** How a comment opens in a check file's language, by extension; a Map, so `constructor` is an unknown extension, not a property */
const COMMENTS = new Map<string, string[]>([
  ...["json", "jsonc", "json5", "js", "cjs", "mjs", "ts", "cts", "mts", "jsx", "tsx"].map(
    (x): [string, string[]] => [x, ["//", "/*"]],
  ),
  ...["toml", "yaml", "yml", "py", "sh", "cfg"].map((x): [string, string[]] => [x, ["#"]]),
  ...["html", "xml", "md"].map((x): [string, string[]] => [x, ["<!--"]]),
]);
const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The same key in a check file: a line that starts with a comment of the file's language, so text in a string or after code is never read
 * as a marker. Null when the extension's comments are not known here.
 */
function commentMarker(file: string): RegExp | null {
  const openers = COMMENTS.get(path.extname(file).slice(1).toLowerCase());
  return openers
    ? new RegExp(
        `^\\s*(?:${openers.map(literal).join("|")})\\s*sphica:\\s*((?:trace|harvest|glean):[\\w.:/-]{1,1000}?)(?=\\s|\\*/|-->|$)`,
        "g",
      )
    : null;
}

/**
 * Where a look page goes on from: the stage, and the last item of it already dealt with, by a position that does not move when other items
 * come or go (an id, or a marker's file, line, and place in the line). Passed back as given, base64url JSON.
 */
const Cursor = z.discriminatedUnion("s", [
  z.object({ s: z.enum(["anchors", "options", "deferred"]), id: z.number().int().min(0) }).strict(),
  z
    .object({
      s: z.literal("markers"),
      // The file's pathHash, or empty for the first marker
      file: z.string().regex(/^(?:[0-9a-f]{16})?$/),
      line: z.number().int().min(0),
      n: z.number().int().min(0),
      // The check files the page was asked about, as one hash: a later page asked about others would skip or repeat files
      c: z
        .string()
        .regex(/^[0-9a-f]{16}$/)
        .optional(),
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

// JSON keeps each path whole whatever it holds, so two lists never hash alike by where a separator falls
export const checksHash = (checks: string[]) =>
  checks.length ? pathHash(JSON.stringify([...checks].sort())) : undefined;

/** Whether a look cursor goes on with the same check files it was given for: another list would skip or repeat files. */
export function cursorFitsChecks(after: string, checks: string[]): boolean {
  const c = lookCursor(after);
  return c?.s !== "markers" || !c.file || c.c === checksHash(checks);
}

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
  checks: string[] = [],
): Promise<string> {
  const from: Cursor = (after === undefined ? null : lookCursor(after)) ?? { s: "anchors", id: 0 };
  if (after !== undefined && !lookCursor(after)) throw new Error("after is not a cursor a look page gave");
  const checked = checksHash(checks);
  if (after !== undefined && !cursorFitsChecks(after, checks))
    throw new Error(
      "after was given for another list of checks; pass the same checks, or call look without after",
    );
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
      .limit(CONDITION_ROWS)
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
    if (!stop && options.length === CONDITION_ROWS) stop = { s: "options", id: last };
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
      .limit(CONDITION_ROWS)
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
    if (!stop && deferred.length === CONDITION_ROWS) stop = { s: "deferred", id: last };
  }

  // Marked lines in instruction files: only the place and the key are shown, never the line, so the file's text cannot forge lines here
  if (!stop) {
    if (!root) notChecked.push("instruction files: no working tree for this project here");
    else {
      // The cursor names its file by pathHash, so it stays short whatever the path, and the files before it are not read again.
      // When that file is gone, its hash matches nothing and the markers start over from the first file
      const resume = from.s === "markers" && from.file ? from : null;
      const scan = ruleFiles(root, resume?.file, checks);
      const todo: { file: string; line: number; n: number; key: string }[] = [];
      let unknownSyntax = 0;
      for (const f of scan.files) {
        const same = resume !== null && pathHash(f.path) === resume.file;
        const marker = f.check ? commentMarker(f.path) : MARKER;
        if (!marker) {
          unknownSyntax++;
          continue;
        }
        for (const [i, text] of f.text.split(/\r?\n/).entries())
          for (const [n, m] of [...text.matchAll(marker)].entries())
            if (!same || i + 1 > resume.line || (i + 1 === resume.line && n > resume.n))
              todo.push({ file: f.path, line: i + 1, n, key: m[1] ?? "" });
      }
      const units = new Map<string, { id: number; key: string; lifecycle: string } | null>();
      const chains = new Map<number, { key: string; lifecycle: string } | null>();
      let last: Cursor | null = resume;
      // In slices of 500: a page asks only about the markers it reaches, and SQLite takes at most 32,766 parameters in one statement
      for (let i = 0; i < todo.length && !stop; i += 500) {
        const slice = todo.slice(i, i + 500);
        const keys = [...new Set(slice.map((f) => f.key))].filter((k) => !units.has(k));
        for (const k of keys) units.set(k, null);
        if (keys.length)
          for (const u of await db
            .selectFrom("unit")
            .select(["id", "key", "lifecycle"])
            .where("project_id", "=", projectId)
            .where("key", "in", keys)
            .execute())
            units.set(u.key, u);
        for (const f of slice) {
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
            // Before the first marker of this page the stage starts over from where the page began
            stop = last ?? { s: "markers", file: "", line: 0, n: 0 };
            break;
          }
          last = {
            s: "markers",
            file: pathHash(f.file),
            line: f.line,
            n: f.n,
            ...(checked ? { c: checked } : {}),
          };
        }
      }
      if (scan.skipped)
        notChecked.push(
          `${scan.skipped} instruction files not read (over the caps, not regular files, or outside the repository)`,
        );
      if (scan.incomplete) notChecked.push(`instruction files: the listing ${scan.incomplete}`);
      if (scan.missing) notChecked.push(`${scan.missing} check files named that are not there`);
      if (scan.outside) notChecked.push(`${scan.outside} check files named outside the repository`);
      if (unknownSyntax)
        notChecked.push(`${unknownSyntax} check files whose comments are not known here by their extension`);
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
    "Read a record by its key before acting on it. Change a record only with the owner's words, through /sphica:trace or /sphica:glean.",
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
