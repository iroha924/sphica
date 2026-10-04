// The full view of one record or source for MCP read: a record's text, options, the exact words cited as evidence and adoption with who
// said them, its links and state history, and each anchor checked against the working tree now.
import type { Selectable } from "kysely";
import { checkAnchor, fileState } from "./anchors.ts";
import type { Reads } from "./db.ts";
import type { DB } from "./db-types.ts";
import { renamesSince } from "./git.ts";
import { inline } from "./panel.ts";
import { cut, head } from "./text.ts";

/** How a reconsider condition reads once its owner quote is gone. */
export const UNSUPPORTED =
  "unsupported: its owner quote was retracted or forgotten, so it is not the owner's condition";

export const speaker = (s: {
  author_kind: string;
  author_login: string | null;
  author_association: string | null;
}) =>
  s.author_kind === "owner"
    ? "the owner"
    : s.author_kind === "assistant"
      ? "the assistant"
      : `${s.author_login ?? "someone"} (${s.author_association ?? s.author_kind})`;

/** A record by key (`trace:<session>/<key>`, `harvest:<n>/<key>`, `glean:<key>`) or by `u<id>`, as text; null when there is none. */
export async function readUnit(
  db: Reads,
  projectId: number,
  ref: string,
  root: string | null,
  /** Only what existed by this time: the record, its evidence, adoption, anchors, and links (an as-of snapshot for replaying a past task) */
  asOf?: string,
  /** Renames per anchor commit, shared by the records of one read so git runs once per commit */
  renames: Renames = new Map(),
): Promise<string | null> {
  const byId = /^u([1-9][0-9]{0,15})$/.exec(ref);
  const u = await db
    .selectFrom("unit")
    .selectAll()
    .where("project_id", "=", projectId)
    .where(byId ? "id" : "key", "=", byId ? Number(byId[1]) : ref)
    .executeTakeFirst();
  // A key without its origin prefix (ext-s1/storage) reads the record when exactly one origin has it
  const bare =
    u ??
    (byId
      ? undefined
      : await db
          .selectFrom("unit")
          .selectAll()
          .where("project_id", "=", projectId)
          .where(
            "key",
            "in",
            ["trace:", "harvest:", "glean:"].map((o) => o + ref),
          )
          .execute()
          .then((rows) => (rows.length === 1 ? rows[0] : undefined)));
  // As of a past time, a record created later does not exist yet
  if (!bare || (asOf && bare.created_at > asOf)) return null;
  return describe(db, bare, root, asOf, renames);
}

type Renames = Map<string, Map<string, string | null> | null>;

/** Commits one read asks git about for renames. */
const RENAME_LOOKUPS = 5;

async function describe(
  db: Reads,
  u: Selectable<DB["unit"]>,
  root: string | null,
  asOf: string | undefined,
  renames: Renames,
): Promise<string> {
  const [options, evidence, adoption, anchors, links, states, fields] = await Promise.all([
    db
      .selectFrom("unit_option")
      .select(["id", "text", "outcome", "why", "reconsider_when"])
      .where("unit_id", "=", u.id)
      .orderBy("position")
      .execute(),
    db
      .selectFrom("unit_evidence as e")
      .innerJoin("source as s", "s.id", "e.source_id")
      .where("e.unit_id", "=", u.id)
      .where("e.added_at", "<=", asOf ?? "9999")
      .select([
        "e.option_id",
        "e.role",
        "e.span_start",
        "e.span_end",
        "e.reported_speaker",
        "e.retracted_at",
        "e.retraction_reason",
        "s.id as source",
        "s.kind",
        "s.artifact",
        "s.revision",
        "s.author_kind",
        "s.author_login",
        "s.author_association",
        "s.created_at",
        "s.text",
      ])
      .orderBy("e.id")
      .execute(),
    db
      .selectFrom("unit_adoption as a")
      .innerJoin("source as s", "s.id", "a.source_id")
      .where("a.unit_id", "=", u.id)
      .where("a.added_at", "<=", asOf ?? "9999")
      .select([
        "a.route",
        "a.span_start",
        "a.span_end",
        "a.retracted_at",
        "a.retraction_reason",
        "s.id as source",
        "s.author_kind",
        "s.author_login",
        "s.author_association",
        "s.created_at",
        "s.text",
      ])
      .orderBy("a.id")
      .execute(),
    db
      .selectFrom("unit_anchor")
      .select(["path", "symbol", "role", "commit_sha", "line_start", "retired_at"])
      .where("unit_id", "=", u.id)
      .where("added_at", "<=", asOf ?? "9999")
      .orderBy("id")
      .execute(),
    db
      .selectFrom("unit_link as l")
      .innerJoin("unit as a", "a.id", "l.from_unit")
      .innerJoin("unit as b", "b.id", "l.to_unit")
      .where((eb) => eb.or([eb("l.from_unit", "=", u.id), eb("l.to_unit", "=", u.id)]))
      .where("l.added_at", "<=", asOf ?? "9999")
      .select(["l.kind", "l.resolved_at", "a.id as from_id", "a.key as from_key", "b.key as to_key"])
      .execute(),
    db
      .selectFrom("unit_state")
      .select(["from_state", "to_state", "at", "reason"])
      .where("unit_id", "=", u.id)
      .orderBy("id")
      .execute(),
    db
      .selectFrom("unit_field as f")
      .innerJoin("field_def as d", "d.id", "f.field_def_id")
      .innerJoin("source as s", "s.id", "f.source_id")
      .where("f.unit_id", "=", u.id)
      .where("f.added_at", "<=", asOf ?? "9999")
      .select([
        "d.name",
        "f.value",
        "f.span_start",
        "f.span_end",
        "s.id as source",
        "s.kind",
        "s.artifact",
        "s.author_kind",
        "s.author_login",
        "s.author_association",
        "s.created_at",
        "s.text",
      ])
      .orderBy("f.id")
      .execute(),
  ]);
  // As of a past time, what happened later has not happened: retractions, retired anchors, and resolved conflicts after it read as open,
  // and the lifecycle is the last state reached by then
  let lifecycle = u.lifecycle;
  let history = states;
  if (asOf) {
    history = states.filter((s) => s.at <= asOf);
    lifecycle = history.at(-1)?.to_state ?? "candidate";
    const later = (at: string | null) => (at && at > asOf ? null : at);
    for (const e of evidence)
      if (!later(e.retracted_at)) Object.assign(e, { retracted_at: null, retraction_reason: null });
    for (const a of adoption)
      if (!later(a.retracted_at)) Object.assign(a, { retracted_at: null, retraction_reason: null });
    for (const a of anchors) a.retired_at = later(a.retired_at);
    for (const l of links) l.resolved_at = later(l.resolved_at);
  }

  const out = [
    `${u.key} (u${u.id}, revision ${u.revision}): ${u.kind}${u.stance ? ` ${u.stance}` : ""}, ${lifecycle}${u.extraction === "quarantined" ? `, quarantined: ${u.extraction_reason}` : ""}${u.unsourced ? ", unsourced: no source was given, so it is never used as fact" : ""}`,
    u.text,
  ];
  if (u.why) out.push(`Why: ${u.why}`);
  if (u.scope_note) out.push(`Scope: ${u.scope_note}`);
  if (u.revisit_when) out.push(`Revisit when: ${u.revisit_when}`);
  if (u.no_code_surface) out.push(`No code location: ${u.no_code_surface}`);
  const quote = (e: (typeof evidence)[number]) =>
    `  - s${e.source} ${e.kind} ${e.artifact}${e.revision > 1 ? ` revision ${e.revision}` : ""}, ${speaker(e)}${e.reported_speaker ? ` reporting what ${e.reported_speaker} said` : ""}, ${e.created_at} (${e.role}): "${inline(cut(e.text, e.span_start, e.span_end))}"${e.retracted_at ? ` [retracted: ${e.retraction_reason}]` : ""}`;
  if (options.length) {
    out.push("Options:");
    for (const o of options) {
      out.push(`- ${o.text}: ${o.outcome}${o.why ? `, because ${o.why}` : ""}`);
      if (o.reconsider_when) {
        // Without the owner's words standing behind it, the condition is only text an agent once wrote
        const stands = evidence.some(
          (e) => e.option_id === o.id && e.role === "reconsiders" && !e.retracted_at,
        );
        out.push(
          `  Reconsider when: ${inline(o.reconsider_when)}${stands ? " (the owner's words are quoted below)" : ` [${UNSUPPORTED}]`}`,
        );
      }
      for (const e of evidence.filter((x) => x.option_id === o.id)) out.push(quote(e));
    }
  }
  out.push("Evidence:");
  const own = evidence.filter((e) => e.option_id === null);
  out.push(...(own.length ? own.map(quote) : ["  none"]));
  if (["decision", "constraint"].includes(u.kind)) {
    out.push("Adoption:");
    out.push(
      ...(adoption.length
        ? adoption.map(
            (a) =>
              `  - s${a.source}, ${speaker(a)}, ${a.created_at} (${a.route}): "${inline(cut(a.text, a.span_start, a.span_end))}"${a.retracted_at ? ` [retracted: ${a.retraction_reason}]` : ""}`,
          )
        : ["  none: nobody with the standing to adopt it has, so it is a candidate"]),
    );
  }
  if (fields.length) {
    out.push("Fields:");
    for (const f of fields)
      out.push(
        `  - ${f.name}: ${inline(f.value)} (s${f.source} ${f.kind} ${f.artifact}, ${speaker(f)}, ${f.created_at}): "${inline(cut(f.text, f.span_start, f.span_end))}"`,
      );
  }
  const live = anchors.filter((a) => !a.retired_at);
  if (live.length) {
    out.push(
      "Code (checked in the working tree now; a located symbol does not prove the record still holds):",
    );
    for (const a of live) {
      const c = checkAnchor(root, a);
      const where = inline(`${a.path}${a.symbol ? ` ${a.symbol}` : ""}`);
      out.push(
        `  - ${where} (${a.role}${a.commit_sha ? `, commit ${a.commit_sha.slice(0, 12)}` : ""}): ${c.state}${c.line ? ` at line ${c.line}` : ""}${c.state === "missing" ? ` — needs review: the code it points at is gone${movedTo(root, a, renames)}` : ""}`,
      );
    }
  }
  for (const l of links) {
    if (l.kind === "supersedes")
      out.push(l.from_id === u.id ? `Supersedes ${l.to_key}` : `Superseded by ${l.from_key}`);
    else
      out.push(
        `Conflicts with ${l.from_id === u.id ? l.to_key : l.from_key}${l.resolved_at ? " (resolved)" : " (unresolved)"}`,
      );
  }
  // The newest set bound to the record's words, as of the time read; search uses the same one
  const aliases = await db
    .selectFrom("unit_alias")
    .select("terms")
    .where("unit_id", "=", u.id)
    .where("content_hash", "=", u.content_hash)
    .where("added_at", "<=", asOf ?? "9999")
    .orderBy("id", "desc")
    .executeTakeFirst();
  const terms: string[] = aliases ? JSON.parse(aliases.terms) : [];
  if (terms.length) out.push(`Aliases (search only): ${terms.map((t) => inline(t)).join(", ")}`);
  out.push(`History: ${history.map((s) => `${s.to_state} ${s.at} (${s.reason})`).join("; ")}`);
  return out.join("\n");
}

/** Where a gone file may have moved since the anchor's commit; empty when there is no commit to compare with or no rename was seen. */
function movedTo(
  root: string | null,
  a: { path: string; commit_sha: string | null },
  renames: Renames,
): string {
  if (!root || !a.commit_sha || fileState(root, a.path) !== "gone") return "";
  if (!renames.has(a.commit_sha)) {
    // Each lookup is a git run; a read of records with many anchor commits stays within the tool's time
    if (renames.size >= RENAME_LOOKUPS) return "; rename not checked";
    renames.set(a.commit_sha, renamesSince(root, a.commit_sha));
  }
  const seen = renames.get(a.commit_sha);
  if (!seen) return "; rename not checked";
  const to = seen.get(a.path);
  if (to === null) return "; rename not checked";
  return to
    ? `; may have moved to ${JSON.stringify(inline(head(to, 300)))} since ${a.commit_sha.slice(0, 12)}`
    : "";
}

/** A retained source by `s<id>`, with who wrote it and where it lives; null when there is none. */
export async function readSource(db: Reads, projectId: number, ref: string): Promise<string | null> {
  // s<id>@<byte> reads on from that byte: a source can hold more than one reply carries
  const m = /^s([1-9][0-9]{0,15})(?:@(\d{1,9}))?$/.exec(ref);
  if (!m) return null;
  const s = await db
    .selectFrom("source")
    .selectAll()
    .where("project_id", "=", projectId)
    .where("id", "=", Number(m[1]))
    .executeTakeFirst();
  if (!s) return null;
  return [
    `s${s.id}: ${s.kind} ${s.artifact}${s.revision > 1 ? ` revision ${s.revision}` : ""}, by ${speaker(s)}, ${s.created_at}${s.url ? `, ${s.url}` : ""}${s.path ? `, ${s.path}${s.line_start ? `:${s.line_start}` : ""}` : ""}${s.truncated ? " (middle not saved)" : ""}`,
    ...part(s.id, s.text, Number(m[2] ?? 0)),
  ].join("\n");
}

const PART = 64 * 1024;

/** One reply's worth of the text from a byte offset (moved back to a character boundary), and where the rest starts. */
function part(id: number, text: string, from: number): string[] {
  const all = Buffer.from(text, "utf8");
  let start = Math.min(from, all.length);
  while (start > 0 && start < all.length && ((all[start] ?? 0) & 0xc0) === 0x80) start--;
  const shown = head(all.subarray(start).toString("utf8"), PART);
  const end = start + Buffer.byteLength(shown, "utf8");
  return end < all.length
    ? [shown, `(${all.length - end} more bytes; read s${id}@${end} for the rest)`]
    : [shown];
}
