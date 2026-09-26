// The full view of one record or source for MCP read: a record's text, options, the exact words cited as evidence and adoption with who
// said them, its links and state history, and each anchor checked against the working tree now.
import type { Kysely } from "kysely";
import { checkAnchor } from "./anchors.ts";
import type { DB } from "./db-types.ts";
import { inline } from "./panel.ts";
import { head } from "./text.ts";

/** The bytes of a source a span points at. */
const cut = (text: string, start: number, end: number) =>
  Buffer.from(text, "utf8").subarray(start, end).toString("utf8");

const speaker = (s: {
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
  db: Kysely<DB>,
  projectId: number,
  ref: string,
  root: string | null,
): Promise<string | null> {
  const byId = /^u([1-9][0-9]{0,15})$/.exec(ref);
  const u = await db
    .selectFrom("unit")
    .selectAll()
    .where("project_id", "=", projectId)
    .where(byId ? "id" : "key", "=", byId ? Number(byId[1]) : ref)
    .executeTakeFirst();
  if (!u) return null;
  const [options, evidence, adoption, anchors, links, states] = await Promise.all([
    db
      .selectFrom("unit_option")
      .select(["id", "text", "outcome", "why"])
      .where("unit_id", "=", u.id)
      .orderBy("position")
      .execute(),
    db
      .selectFrom("unit_evidence as e")
      .innerJoin("source as s", "s.id", "e.source_id")
      .where("e.unit_id", "=", u.id)
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
      .orderBy("id")
      .execute(),
    db
      .selectFrom("unit_link as l")
      .innerJoin("unit as a", "a.id", "l.from_unit")
      .innerJoin("unit as b", "b.id", "l.to_unit")
      .where((eb) => eb.or([eb("l.from_unit", "=", u.id), eb("l.to_unit", "=", u.id)]))
      .select(["l.kind", "l.resolved_at", "a.id as from_id", "a.key as from_key", "b.key as to_key"])
      .execute(),
    db
      .selectFrom("unit_state")
      .select(["from_state", "to_state", "at", "reason"])
      .where("unit_id", "=", u.id)
      .orderBy("id")
      .execute(),
  ]);

  const out = [
    `${u.key} (u${u.id}): ${u.kind}${u.stance ? ` ${u.stance}` : ""}, ${u.lifecycle}${u.extraction === "quarantined" ? `, quarantined: ${u.extraction_reason}` : ""}${u.unsourced ? ", unsourced: no source was given, so it is never used as fact" : ""}`,
    u.text,
  ];
  if (u.why) out.push(`Why: ${u.why}`);
  if (u.scope_note) out.push(`Scope: ${u.scope_note}`);
  if (u.revisit_when) out.push(`Revisit when: ${u.revisit_when}`);
  if (u.no_code_surface) out.push(`No code location: ${u.no_code_surface}`);
  const quote = (e: (typeof evidence)[number]) =>
    `  - s${e.source} ${e.kind}${e.revision > 1 ? ` revision ${e.revision}` : ""}, ${speaker(e)}${e.reported_speaker ? ` reporting what ${e.reported_speaker} said` : ""}, ${e.created_at} (${e.role}): "${inline(cut(e.text, e.span_start, e.span_end))}"${e.retracted_at ? ` [retracted: ${e.retraction_reason}]` : ""}`;
  if (options.length) {
    out.push("Options:");
    for (const o of options) {
      out.push(`- ${o.text}: ${o.outcome}${o.why ? `, because ${o.why}` : ""}`);
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
  const live = anchors.filter((a) => !a.retired_at);
  if (live.length) {
    out.push(
      "Code (checked in the working tree now; a located symbol does not prove the record still holds):",
    );
    for (const a of live) {
      const c = checkAnchor(root, a);
      const where = `${a.path}${a.symbol ? ` ${a.symbol}` : ""}`;
      out.push(
        `  - ${where} (${a.role}${a.commit_sha ? `, commit ${a.commit_sha.slice(0, 12)}` : ""}): ${c.state}${c.line ? ` at line ${c.line}` : ""}${c.state === "missing" ? " — needs review: the code it points at is gone" : ""}`,
      );
    }
  }
  for (const l of links) {
    if (l.kind === "supersedes")
      out.push(l.from_id === u.id ? `Supersedes ${l.to_key}` : `Superseded by ${l.from_key}`);
    else if (l.kind === "conflicts")
      out.push(
        `Conflicts with ${l.from_id === u.id ? l.to_key : l.from_key}${l.resolved_at ? " (resolved)" : " (unresolved)"}`,
      );
    else
      out.push(
        `${l.from_id === u.id ? "Implements" : "Implemented by"} ${l.from_id === u.id ? l.to_key : l.from_key}`,
      );
  }
  out.push(`History: ${states.map((s) => `${s.to_state} ${s.at} (${s.reason})`).join("; ")}`);
  return out.join("\n");
}

/** A retained source by `s<id>`, with who wrote it and where it lives; null when there is none. */
export async function readSource(db: Kysely<DB>, projectId: number, ref: string): Promise<string | null> {
  const m = /^s([1-9][0-9]{0,15})$/.exec(ref);
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
    head(s.text, 64 * 1024),
  ].join("\n");
}
