// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Picks Sphica's own text out of a classic hook result and fits it to the pane. Hook results carry no mark of which hook wrote what,
// so a match on Sphica's fixed wording is a guess for display only; server/test/pane-sift.test.ts holds it to deliver.ts's real output.

import type { Delivered } from "../types/index.d.ts";

export type { Delivered };

/** What the mod reads from a classic result: its contexts, and a PreToolUse refusal. */
export type Result = { readonly additionalContext?: readonly string[]; readonly deny?: string } | undefined;

export const LIMITS = { kept: 100, chars: 8000, each: 1500 } as const;

const isSphica = (text: string) => text.startsWith("Sphica") || text.includes("Sphica's read");

export function sift(result: Result, event: string, at: string): Delivered[] {
  const kept: Delivered[] = (result?.additionalContext ?? [])
    .filter(isSphica)
    .map((text) => ({ at, event, kind: "context", text }));
  if (typeof result?.deny === "string" && isSphica(result.deny))
    kept.push({ at, event, kind: "stop", text: result.deny });
  return kept;
}

export const heading = (row: Delivered) => `${row.at} ${row.event}${row.kind === "stop" ? " (stopped)" : ""}`;

export const omitted = (cut: number, hidden: number) =>
  [hidden > 0 ? `${hidden} older not shown` : "", cut > 0 ? `${cut} cut to ${LIMITS.each} characters` : ""]
    .filter(Boolean)
    .join(", ");

export type Layout = { shown: Delivered[]; cut: number; hidden: number };

/** The newest first, each cut to `each` characters, headings and the omission line counted, until `chars` in all. */
export function layout(
  list: readonly Delivered[],
  chars: number = LIMITS.chars,
  each: number = LIMITS.each,
): Layout {
  const room = chars - omitted(list.length, list.length).length;
  const shown: Delivered[] = [];
  let used = 0;
  let cut = 0;
  for (const row of [...list].reverse()) {
    const text = row.text.length > each ? `${row.text.slice(0, each - 1)}…` : row.text;
    const size = heading(row).length + text.length;
    if (used + size > room) break;
    used += size;
    if (text !== row.text) cut += 1;
    shown.push({ ...row, text });
  }
  return { shown, cut, hidden: list.length - shown.length };
}
