// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The lines of a record tool's result that did not fit its reply, kept in this process so record_more can hand them over page by page
// without checking, saving, fetching, or forgetting again.

import crypto from "node:crypto";
import { framed, frameId } from "./frame.ts";
import { inline } from "./panel.ts";
import { fitCount, READ_BUDGET } from "./reply-budget.ts";
import { bytes, head, plural } from "./text.ts";

/** What made a result. The letter leads its cursors, so one whose result is gone still says what to do next */
const KINDS = {
  check: "c",
  refused: "r",
  save: "s",
  fetch: "f",
  forget_preview: "p",
  forget_apply: "a",
} as const;
export type ResultKind = keyof typeof KINDS;

/** Kinds whose writes are committed: reading them again is the only way back to what they said, so checks cannot push them out */
const COMMITTED: ResultKind[] = ["save", "fetch", "forget_apply"];

/** Results kept in each of the two pools. Not a promise: a restart forgets them all */
const KEPT = 20;

/** Bytes of lines kept in each pool. The newest result is kept whatever its size: a cursor just given must work */
const POOL_BYTES = 4 * 1024 * 1024;

/** Bytes of one kept line. A longer line is split when it is kept, so every page can carry at least one */
const PIECE = 4096;

/** frame is the id of the frame around every page, drawn when the lines are kept: null for lines that are Sphica's own */
type Result = { projectId: number; frame: string | null; lines: string[]; given: Set<number>; bytes: number };
const pools = { redo: new Map<string, Result>(), committed: new Map<string, Result>() };

export const CURSOR = /^([crsfpa][0-9a-f]{12})\.(\d{1,15})$/;

/** One line as it is kept: plain and on one line, in pieces of at most PIECE bytes cut between characters, each cut marked on both sides */
export function pieces(line: string): string[] {
  const out: string[] = [];
  let rest = inline(line);
  // Each mark is 4 bytes, and a piece in the middle has one on each side
  while (bytes(rest) > PIECE - (out.length ? 4 : 0)) {
    const part = head(rest, PIECE - 8);
    out.push(`${out.length ? "… " : ""}${part} …`);
    rest = rest.slice(part.length);
  }
  out.push(`${out.length ? "… " : ""}${rest}`);
  return out;
}

/** The lines from one position that fit a reply, after the lead, and how many are left. Sphica's own words stay outside the frame */
function page(r: Result, id: string, from: number, lead: string[]): { text: string; left: number } {
  const reply = (kept: number) => {
    const shown = r.lines.slice(from, from + kept);
    const left = r.lines.length - from - kept;
    return [
      ...lead,
      ...(shown.length ? [r.frame === null ? shown.join("\n") : framed(shown.join("\n"), r.frame)] : []),
      ...(left > 0
        ? [`${plural(left, "more line")}: call record_more with cursor: "${id}.${from + kept}"`]
        : []),
    ].join("\n");
  };
  // A page holds at most one line more than the budget has bytes (each line after the first costs its newline), so only that many
  // are looked at: a long result is not copied whole
  const kept = fitCount(r.lines.slice(from, from + READ_BUDGET + 1), READ_BUDGET, reply);
  const left = r.lines.length - from - kept;
  // Only a position a reply named is read from later: a cursor edited to another would skip lines without a word
  if (left > 0) r.given.add(from + kept);
  return { text: reply(kept), left };
}

/**
 * A result's reply: the lead (the verdict and the counts, which the caller keeps short) and as many lines as fit. When lines are left
 * out, the result is kept and the reply ends with the cursor that reads on. framed is for lines that carry text from outside.
 */
export function firstPage(o: {
  kind: ResultKind;
  projectId: number;
  lead: string[];
  lines: string[];
  framed?: boolean;
}): string {
  const r: Result = {
    projectId: o.projectId,
    frame: o.framed ? frameId() : null,
    lines: o.lines.flatMap(pieces),
    given: new Set(),
    bytes: 0,
  };
  r.bytes = r.lines.reduce((n, l) => n + bytes(l), 0);
  const pool = COMMITTED.includes(o.kind) ? pools.committed : pools.redo;
  let id = "";
  do id = `${KINDS[o.kind]}${crypto.randomBytes(6).toString("hex")}`;
  while (pools.redo.has(id) || pools.committed.has(id));
  const first = page(r, id, 0, o.lead.map(inline));
  if (first.left === 0) return first.text;
  pool.set(id, r);
  let held = [...pool.values()].reduce((n, x) => n + x.bytes, 0);
  for (const [old, x] of pool) {
    if (old === id || (pool.size <= KEPT && held <= POOL_BYTES)) break;
    pool.delete(old);
    held -= x.bytes;
  }
  return first.text;
}

/** What to do when a result is no longer kept, by what made it: only what changed nothing is worth running again */
const GONE: Record<string, string> = {
  c: "Run record_check again: it gives the same result.",
  r: "Nothing was saved. Run record_check or record_save again.",
  s: "The record was saved; do not save it again. Find what it saved with search and read.",
  f: "The sources were kept; do not fetch again. Find them with search and sources: true.",
  p: "Run forget_preview again.",
  a: "The sources were forgotten; nothing is left to do for them.",
};

/**
 * Drops every result kept for a project. A kept line may repeat a source's words (an error quoting what a record cited), and what
 * the owner forgets must not be read again from here. Other sessions' servers keep their own, so no line is built from a source's text.
 */
export function forgetKept(projectId: number): void {
  for (const pool of [pools.redo, pools.committed])
    for (const [id, r] of pool) if (r.projectId === projectId) pool.delete(id);
}

/** The page of a kept result a cursor names. The same cursor gives the same page. */
export function morePage(cursor: string, projectId: number): string {
  const m = CURSOR.exec(cursor);
  if (!m) throw new Error("That is not a cursor a reply gave; pass the cursor as the reply wrote it");
  const [, id = "", at = "0"] = m;
  const r = pools.redo.get(id) ?? pools.committed.get(id);
  if (!r)
    throw new Error(
      `This result is no longer kept (the record server restarted, newer results took its place, or sources were forgotten since). ${GONE[id.charAt(0)] ?? ""}`,
    );
  if (r.projectId !== projectId) throw new Error("This result belongs to another project");
  const from = Number(at);
  if (!r.given.has(from))
    throw new Error("That is not a cursor a reply gave; pass the cursor as the reply wrote it");
  return page(r, id, from, []).text;
}
