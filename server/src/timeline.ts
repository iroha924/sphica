// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The timeline of a record for MCP read: the records tied to it by replacement, what happened to each and when, the questions they
// answered, and the findings, dead ends, and questions saved by the same runs or anchored at the same places. An overview in time
// order; the quoted words are read's.
import type { Reads } from "./db.ts";
import { framed } from "./frame.ts";
import { inline } from "./panel.ts";
import { speaker, unitByRef } from "./read.ts";
import { keyShown, preview, READ_BUDGET } from "./reply-budget.ts";
import { bytes, head } from "./text.ts";

/** Records followed along replacements from the one asked for, nearest first, and the ones named where following stopped */
const CHAIN_MAX = 20;
const EDGE_NAMED = 10;
/** Related records shown, and how many each way of being related is read for */
const RELATED_MAX = 30;
const RELATED_READ = 200;
/** Places of the chain looked at for records at the same place: one condition each in a single query */
const PLACES_MAX = 200;
/** Records named for the lines a reply left out: a list of every one could alone pass the budget */
const LEFT_NAMED = 20;
const SHOWN = { text: 200, who: 100, path: 200, symbol: 100, sources: 5 } as const;

const LEAD =
  "Timelines are overviews, oldest first: each line sums up a record or a change to it and is not the quoted words (read the record or s<id> for those). A record marked same run or same place was saved by the same run as one in the chain, or is anchored at the same place; that is not a confirmed cause.";

/** The fixed order of changes that share a time, before each table's own key. */
const ORDER = {
  saved: 0,
  evidence: 1,
  adoption: 2,
  state: 3,
  replaced: 4,
  ended: 5,
  anchor: 6,
  conflict: 7,
} as const;

type Line = {
  /** null when the time was never recorded: shown after everything dated */
  at: string | null;
  order: number;
  pk: number[];
  text: string;
  /** The record read shows this line's full account in */
  unit: number;
  /** Kept whatever else is left out: the record asked for, and the newest replacement taking and losing effect */
  must?: boolean;
  related?: boolean;
};

/** Stored times sort as text, so no locale takes part */
const text = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const keys = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d) return d;
  }
  return 0;
};
const byTime = (a: Line, b: Line) =>
  (a.at === null ? 1 : 0) - (b.at === null ? 1 : 0) ||
  text(a.at ?? "", b.at ?? "") ||
  a.order - b.order ||
  keys(a.pk, b.pk);

/** The records reached from one along supersedes intents in either direction, nearest first, and those where following stopped at the cap. */
async function chainOf(db: Reads, entry: number): Promise<{ ids: number[]; edge: number[] }> {
  const ids = [entry];
  const seen = new Set(ids);
  const edge = new Set<number>();
  for (let frontier = [entry]; frontier.length; ) {
    const links = await db
      .selectFrom("unit_link")
      .select(["from_unit", "to_unit"])
      .where("kind", "=", "supersedes")
      .where((eb) => eb.or([eb("from_unit", "in", frontier), eb("to_unit", "in", frontier)]))
      .orderBy("from_unit")
      .orderBy("to_unit")
      .execute();
    const next: number[] = [];
    for (const l of links)
      for (const [near, far] of [
        [l.from_unit, l.to_unit],
        [l.to_unit, l.from_unit],
      ] as const) {
        if (!frontier.includes(near) || seen.has(far)) continue;
        if (ids.length >= CHAIN_MAX) {
          edge.add(near);
          continue;
        }
        seen.add(far);
        ids.push(far);
        next.push(far);
      }
    frontier = next;
  }
  return { ids, edge: [...edge] };
}

/** Every line of one record's timeline, in no order, with what following its chain left unexplored. */
async function linesOf(
  db: Reads,
  projectId: number,
  entry: number,
): Promise<{ lines: Line[]; edge: number[]; relatedMore: number; relatedCut: boolean; placesCut: boolean }> {
  const { ids, edge } = await chainOf(db, entry);
  const units = await db
    .selectFrom("unit")
    .select(["id", "key", "kind", "stance", "text", "why", "created_at", "run_id"])
    .where("project_id", "=", projectId)
    .where("id", "in", ids)
    .execute();
  const unit = new Map(units.map((u) => [u.id, u]));
  const runs = [...new Set(units.map((u) => u.run_id))];
  const [intents, rows, gaps, states, evidence, adoption, anchors, conflicts, sameRun, answered] =
    await Promise.all([
      db
        .selectFrom("unit_link")
        .select(["from_unit", "to_unit", "added_at"])
        .where("kind", "=", "supersedes")
        .where("from_unit", "in", ids)
        .where("to_unit", "in", ids)
        .execute(),
      db
        .selectFrom("unit_replacement")
        .select(["id", "from_unit", "to_unit", "started_at", "ended_at", "end_reason"])
        .where("from_unit", "in", ids)
        .where("to_unit", "in", ids)
        .execute(),
      db
        .selectFrom("unit_replacement_gap")
        .select(["from_unit", "to_unit"])
        .where("from_unit", "in", ids)
        .where("to_unit", "in", ids)
        .execute(),
      db
        .selectFrom("unit_state")
        .select(["id", "unit_id", "from_state", "to_state", "at", "reason"])
        .where("unit_id", "in", ids)
        .execute(),
      db
        .selectFrom("unit_evidence")
        .select([
          "id",
          "unit_id",
          "source_id",
          "role",
          "run_id",
          "added_at",
          "retracted_at",
          "retraction_reason",
          "retraction_source_id",
        ])
        .where("unit_id", "in", ids)
        .orderBy("id")
        .execute(),
      db
        .selectFrom("unit_adoption as a")
        .innerJoin("source as s", "s.id", "a.source_id")
        .select([
          "a.id",
          "a.unit_id",
          "a.source_id",
          "a.route",
          "a.run_id",
          "a.added_at",
          "a.retracted_at",
          "a.retraction_reason",
          "a.retraction_source_id",
          "s.author_kind",
          "s.author_login",
          "s.author_association",
        ])
        .where("a.unit_id", "in", ids)
        .orderBy("a.id")
        .execute(),
      db
        .selectFrom("unit_anchor as a")
        .leftJoin("unit_anchor as to", "to.id", "a.replaced_by")
        .leftJoin("unit_anchor_retirement as r", "r.anchor_id", "a.id")
        .select([
          "a.id",
          "a.unit_id",
          "a.path",
          "a.symbol",
          "a.role",
          "a.run_id",
          "a.added_at",
          "a.retired_at",
          "to.path as to_path",
          "to.symbol as to_symbol",
          "r.source_id as said",
        ])
        .where("a.unit_id", "in", ids)
        .execute(),
      db
        .selectFrom("unit_link as l")
        .innerJoin("unit as a", "a.id", "l.from_unit")
        .innerJoin("unit as b", "b.id", "l.to_unit")
        .select([
          "l.from_unit",
          "l.to_unit",
          "l.added_at",
          "l.resolved_at",
          "l.resolution",
          "a.key as from_key",
          "b.key as to_key",
        ])
        .where("l.kind", "=", "conflicts")
        .where((eb) => eb.or([eb("l.from_unit", "in", ids), eb("l.to_unit", "in", ids)]))
        .execute(),
      db
        .selectFrom("unit")
        .select(["id", "key", "kind", "text", "created_at"])
        .where("project_id", "=", projectId)
        .where("extraction", "=", "supported")
        .where("kind", "in", ["finding", "dead_end", "question"])
        .where("run_id", "in", runs)
        .where("id", "not in", ids)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(RELATED_READ + 1)
        .execute(),
      // The withdrawal of a question a record of the chain answered, found by the row kept beside it and not by the reason's words.
      // Whatever else a chain record's run did to a record outside the chain is not a change to the chain, and is left out
      db
        .selectFrom("unit_answer as w")
        .innerJoin("unit_state as t", "t.id", "w.state_id")
        .innerJoin("unit as o", "o.id", "t.unit_id")
        .select(["t.id", "t.at", "t.to_state", "t.reason", "o.id as unit", "o.key"])
        .where("o.project_id", "=", projectId)
        .where("w.answer_unit", "in", ids)
        .where("o.id", "not in", ids)
        .execute(),
    ]);
  // The places the chain is anchored at now, each once, oldest anchor first. They are matched in the query itself, so the cap on what
  // is read counts records at those places and never ones that only share a path
  const everyPlace = [
    ...new Map(
      anchors
        .filter((a) => a.retired_at === null)
        .sort((a, b) => a.id - b.id)
        .map((a) => [JSON.stringify([a.path, a.symbol]), a]),
    ).values(),
  ];
  const places = everyPlace.slice(0, PLACES_MAX);
  const samePlace = places.length
    ? await db
        .selectFrom("unit_anchor as a")
        // cross join fixes the order: the anchors at the paths drive, whatever the planner guesses for a long list of places
        .crossJoin("unit as f")
        .whereRef("f.id", "=", "a.unit_id")
        .select(["f.id", "f.key", "f.kind", "f.text", "f.created_at"])
        .distinct()
        .where("f.project_id", "=", projectId)
        .where("f.extraction", "=", "supported")
        .where("f.kind", "in", ["finding", "dead_end", "question"])
        .where("f.id", "not in", ids)
        .where("a.retired_at", "is", null)
        // The paths on their own, so the anchors are found through their index by path rather than by walking every record
        .where("a.path", "in", [...new Set(places.map((at) => at.path))])
        .where((eb) =>
          eb.or(
            places.map((at) =>
              eb.and([
                eb("a.path", "=", at.path),
                at.symbol === null ? eb("a.symbol", "is", null) : eb("a.symbol", "=", at.symbol),
              ]),
            ),
          ),
        )
        .orderBy("f.created_at", "desc")
        .orderBy("f.id", "desc")
        .limit(RELATED_READ + 1)
        .execute()
    : [];

  const name = (id: number, key = unit.get(id)?.key ?? `u${id}`) => `${keyShown(key, id)} (u${id})`;
  const cut = (s: string | null) => preview(s ?? "", SHOWN.text);
  const lines: Line[] = [];

  for (const u of units) {
    // What the record was saved with is what its own run wrote: another run can add to it in the very millisecond of the save
    const first = (e: { run_id: number }) => e.run_id === u.run_id;
    const sources = [
      ...new Set(evidence.filter((e) => e.unit_id === u.id && first(e)).map((e) => e.source_id)),
    ];
    const adopted = adoption.filter((a) => a.unit_id === u.id && first(a));
    lines.push({
      at: u.created_at,
      order: ORDER.saved,
      pk: [u.id],
      unit: u.id,
      must: u.id === entry,
      text: [
        `${name(u.id)} saved: ${u.kind}${u.stance ? ` ${u.stance}` : ""}, ${cut(u.text)}`,
        ...(u.why ? [`  Why: ${cut(u.why)}`] : []),
        ...(sources.length
          ? [
              `  Evidence: ${sources
                .slice(0, SHOWN.sources)
                .map((s) => `s${s}`)
                .join(
                  ", ",
                )}${sources.length > SHOWN.sources ? `, and ${sources.length - SHOWN.sources} more` : ""}`,
            ]
          : []),
        ...(adopted.length
          ? [
              `  Adoption: ${adopted
                .slice(0, SHOWN.sources)
                .map((a) => `s${a.source_id} (${preview(speaker(a), SHOWN.who)})`)
                .join(
                  ", ",
                )}${adopted.length > SHOWN.sources ? `, and ${adopted.length - SHOWN.sources} more` : ""}`,
            ]
          : []),
      ].join("\n"),
    });
  }
  for (const e of evidence) {
    const u = unit.get(e.unit_id);
    if (!u) continue;
    if (e.run_id !== u.run_id)
      lines.push({
        at: e.added_at,
        order: ORDER.evidence,
        pk: [e.id, 0],
        unit: u.id,
        text: `${name(u.id)} evidence added: s${e.source_id} (${e.role})`,
      });
    if (e.retracted_at)
      lines.push({
        at: e.retracted_at,
        order: ORDER.evidence,
        pk: [e.id, 1],
        unit: u.id,
        text: `${name(u.id)} evidence retracted: s${e.source_id} (${e.role}); reason: ${cut(e.retraction_reason)}${e.retraction_source_id === null ? "" : `, said in s${e.retraction_source_id}`}`,
      });
  }
  for (const a of adoption) {
    const u = unit.get(a.unit_id);
    if (!u) continue;
    const who = `s${a.source_id} (${preview(speaker(a), SHOWN.who)}, ${a.route})`;
    if (a.run_id !== u.run_id)
      lines.push({
        at: a.added_at,
        order: ORDER.adoption,
        pk: [a.id, 0],
        unit: u.id,
        text: `${name(u.id)} adopted: ${who}`,
      });
    if (a.retracted_at)
      lines.push({
        at: a.retracted_at,
        order: ORDER.adoption,
        pk: [a.id, 1],
        unit: u.id,
        text: `${name(u.id)} adoption retracted: ${who}; reason: ${cut(a.retraction_reason)}${a.retraction_source_id === null ? "" : `, said in s${a.retraction_source_id}`}`,
      });
  }
  for (const s of states) {
    // The first state is the save itself
    if (s.from_state === null || !unit.has(s.unit_id)) continue;
    lines.push({
      at: s.at,
      order: ORDER.state,
      pk: [s.id],
      unit: s.unit_id,
      text: `${name(s.unit_id)} became ${s.to_state}: ${cut(s.reason)}`,
    });
  }
  const newest = (at: (r: (typeof rows)[number]) => string | null) =>
    rows.reduce<(typeof rows)[number] | undefined>(
      (best, r) => (at(r) !== null && (!best || (at(r) ?? "") >= (at(best) ?? "")) ? r : best),
      undefined,
    )?.id;
  const lastStart = newest((r) => r.started_at);
  const lastEnd = newest((r) => r.ended_at);
  for (const r of rows) {
    lines.push({
      at: r.started_at,
      order: ORDER.replaced,
      pk: [r.id],
      unit: r.from_unit,
      must: r.id === lastStart,
      text: `${name(r.from_unit)} replaced ${name(r.to_unit)}`,
    });
    if (r.ended_at)
      lines.push({
        at: r.ended_at,
        order: ORDER.ended,
        pk: [r.id],
        unit: r.from_unit,
        must: r.id === lastEnd,
        text: `${name(r.from_unit)} stopped replacing ${name(r.to_unit)}: ${cut(r.end_reason)}`,
      });
  }
  for (const l of intents) {
    const same = (x: { from_unit: number; to_unit: number }) =>
      x.from_unit === l.from_unit && x.to_unit === l.to_unit;
    // An intent with a period in effect is told by its rows; one whose effect was never dated is not a proposal that never took effect
    if (gaps.some(same))
      lines.push({
        at: null,
        order: ORDER.replaced,
        pk: [l.from_unit, l.to_unit],
        unit: l.from_unit,
        text: `${name(l.from_unit)} replaced ${name(l.to_unit)}`,
      });
    else if (!rows.some(same))
      lines.push({
        at: l.added_at,
        order: ORDER.replaced,
        pk: [l.from_unit, l.to_unit],
        unit: l.from_unit,
        text: `${name(l.from_unit)} proposed to replace ${name(l.to_unit)}; it has not taken effect`,
      });
  }
  for (const a of anchors) {
    const u = unit.get(a.unit_id);
    if (!u) continue;
    // Cut like every other stored string: one line too long to fit would end the chain's part of the reply there
    const where = (path: string, symbol: string | null) =>
      `${preview(path, SHOWN.path)}${symbol ? ` ${preview(symbol, SHOWN.symbol)}` : ""}`;
    // An anchor carries no source of its own; a record's evidence is not the reason for a later change to it
    if (a.run_id !== u.run_id)
      lines.push({
        at: a.added_at,
        order: ORDER.anchor,
        pk: [a.id, 0],
        unit: u.id,
        text: `${name(u.id)} anchor added: ${where(a.path, a.symbol)} (${a.role}); no source recorded for this change`,
      });
    if (a.retired_at)
      lines.push({
        at: a.retired_at,
        order: ORDER.anchor,
        pk: [a.id, 1],
        unit: u.id,
        text: `${name(u.id)} anchor retired: ${where(a.path, a.symbol)} (${a.role})${a.to_path ? `, moved to ${where(a.to_path, a.to_symbol)}` : ""}; ${a.said === null ? "the words that retired it are not recorded or no longer kept" : `said in s${a.said}`}`,
      });
  }
  for (const c of conflicts) {
    const mine = unit.has(c.from_unit) ? c.from_unit : c.to_unit;
    const pair = `${name(c.from_unit, c.from_key)} conflicts with ${name(c.to_unit, c.to_key)}`;
    lines.push({
      at: c.added_at,
      order: ORDER.conflict,
      pk: [c.from_unit, c.to_unit, 0],
      unit: mine,
      text: pair,
    });
    if (c.resolved_at)
      lines.push({
        at: c.resolved_at,
        order: ORDER.conflict,
        pk: [c.from_unit, c.to_unit, 1],
        unit: mine,
        text: `${pair}: resolved, ${cut(c.resolution)}`,
      });
  }
  for (const o of answered)
    lines.push({
      at: o.at,
      order: ORDER.state,
      pk: [o.id],
      unit: o.unit,
      text: `${name(o.unit, o.key)} became ${o.to_state}: ${cut(o.reason)}`,
    });

  // One line per related record, with every way it is related; the newest are kept
  const related = new Map<
    number,
    { key: string; kind: string; text: string; created_at: string; why: Set<string> }
  >();
  for (const [list, why] of [
    [sameRun.slice(0, RELATED_READ), "same run"],
    [samePlace.slice(0, RELATED_READ), "same place"],
  ] as const)
    for (const f of list) {
      const seen = related.get(f.id) ?? { ...f, why: new Set<string>() };
      seen.why.add(why);
      related.set(f.id, seen);
    }
  const ordered = [...related.entries()].sort(([a, x], [b, y]) => text(y.created_at, x.created_at) || b - a);
  for (const [id, f] of ordered.slice(0, RELATED_MAX))
    lines.push({
      at: f.created_at,
      order: ORDER.saved,
      pk: [id],
      unit: id,
      related: true,
      text: `${name(id, f.key)} saved [${[...f.why].join(", ")}]: ${f.kind}, ${cut(f.text)}`,
    });
  return {
    lines,
    edge,
    relatedMore: Math.max(ordered.length - RELATED_MAX, 0),
    relatedCut: sameRun.length > RELATED_READ || samePlace.length > RELATED_READ,
    placesCut: everyPlace.length > PLACES_MAX,
  };
}

const named = (ids: number[], max: number) =>
  `${ids
    .slice(0, max)
    .map((id) => `u${id}`)
    .join(", ")}${ids.length > max ? `, and ${ids.length - max} more` : ""}`;

/**
 * read's reply for the timelines of refs, within READ_BUDGET. Each is an overview: when it does not fit, the record asked for and the
 * newest replacement stay, then the chain's changes from the newest, then related records from the newest, and what was left out is
 * named after the frame up to a fixed count. A ref that is not a record gets a line saying so, and the others go on.
 */
export async function timelineRefs(db: Reads, projectId: number, refs: string[]): Promise<string> {
  const sections: string[] = [];
  const notes: string[] = [];
  const tail = (left: string[]) =>
    left.length
      ? `(This reply stops here to stay within ${READ_BUDGET / 1024} KiB. Call read with timeline: true and refs ${JSON.stringify(left)} for the rest.)`
      : "";
  const reply = (section: string[], note: string[], left: string[]) =>
    [LEAD, framed([...sections, ...section].join("\n\n")), ...notes, ...note, tail(left)]
      .filter(Boolean)
      .join("\n");
  let next: string[] = [];
  for (const [i, ref] of refs.entries()) {
    const rest = refs.slice(i + 1);
    const shown = head(inline(ref), 200);
    // What read takes besides a record: a source, and a record continued from a byte
    const u = /^(s[1-9][0-9]{0,15}(@\d{1,9})?|u[1-9][0-9]{0,15}@\d{1,9}:[0-9a-f]{12})$/.test(ref)
      ? "other"
      : await unitByRef(db, projectId, ref);
    const fixed =
      u === "other"
        ? `${shown}: a timeline takes a record's key or u<id>`
        : u
          ? null
          : `${shown}: not found in this project`;
    if (fixed !== null) {
      // Measured like a timeline: several of these lines are longer than the tail that kept room for naming their refs
      if (bytes(reply([fixed], [], rest)) > READ_BUDGET) {
        next = refs.slice(i);
        break;
      }
      sections.push(fixed);
      continue;
    }
    if (!u || u === "other") continue;
    const { lines, edge, relatedMore, relatedCut, placesCut } = await linesOf(db, projectId, u.id);
    const newestFirst = (a: Line, b: Line) => byTime(b, a);
    const wanted = [
      ...lines.filter((l) => l.must),
      ...lines.filter((l) => !l.must && !l.related).sort(newestFirst),
      ...lines.filter((l) => l.related).sort(newestFirst),
    ];
    const built = (kept: Line[]) => {
      const left = lines.filter((l) => !kept.includes(l));
      const chain = [...new Set(left.filter((l) => !l.related).map((l) => l.unit))];
      const others = [...new Set(left.filter((l) => l.related).map((l) => l.unit))];
      const more = relatedMore + others.length;
      return {
        section: [
          `## Timeline of ${keyShown(u.key, u.id)} (u${u.id})`,
          ...[...kept].sort(byTime).map((l) => `${l.at ?? "at some time (not recorded)"} ${l.text}`),
        ].join("\n"),
        note: [
          chain.length
            ? `u${u.id}: ${left.filter((l) => !l.related).length} changes left out to keep this reply within ${READ_BUDGET / 1024} KiB; read ${named(chain, LEFT_NAMED)} for them.`
            : "",
          more
            ? `u${u.id}: ${more}${relatedCut ? " or more" : ""} related records left out${others.length ? `: ${named(others, LEFT_NAMED)}` : ""}.`
            : "",
          placesCut
            ? `u${u.id}: its chain is anchored at more than ${PLACES_MAX} places; records at the same place were looked for at the ${PLACES_MAX} oldest only.`
            : "",
          edge.length
            ? `u${u.id}: its chain was followed for ${CHAIN_MAX} records and stops at ${named(edge, EDGE_NAMED)}; beyond them it was not followed, and how many more there are is not known.`
            : "",
        ].filter(Boolean),
      };
    };
    const fits = (kept: Line[]) => {
      const b = built(kept);
      return bytes(reply([b.section], b.note, rest)) <= READ_BUDGET;
    };
    const must = wanted.filter((l) => l.must);
    if (!fits(must)) {
      next = refs.slice(i);
      break;
    }
    const kept = [...must];
    // Each tier stops at the first line that does not fit, so what is shown of it is its newest part without holes
    let chainFull = false;
    for (const l of wanted.slice(must.length)) {
      if (!l.related && chainFull) continue;
      if (fits([...kept, l])) kept.push(l);
      else if (l.related) break;
      else chainFull = true;
    }
    const b = built(kept);
    sections.push(b.section);
    notes.push(...b.note);
  }
  return reply([], [], next);
}
