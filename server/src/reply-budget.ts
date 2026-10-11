// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// What a reply of either MCP server may carry, and the parts that keep one within it: fitting a count of parts, showing text from
// outside cut and marked, naming what was left out, and cutting an error the SDK built.

import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { inline, plain } from "./panel.ts";
import { bytes, head } from "./text.ts";

/**
 * What one reply carries, its frame included. Codex keeps about 10,000 tokens it counts as bytes / 4 and drops the middle of a longer
 * reply without a word; Claude Code sets aside a reply over 25,000 tokens.
 */
export const READ_BUDGET = 32 * 1024;

/**
 * How many parts, from the first, a reply can carry within limit bytes. reply builds the whole text for a count, with its frame and what it
 * says about the parts left out, so what is measured is what is sent. The reply for no parts has to fit by the caller's own bounds.
 */
export function fitCount(parts: string[], limit: number, reply: (kept: number) => string): number {
  // A first guess from the parts' own sizes saves building every reply; the frame can drop characters, so the guess is tried both ways
  let kept = 0;
  let used = 0;
  for (; kept < parts.length; kept++) {
    used += bytes(parts[kept] ?? "");
    if (used > limit) break;
  }
  while (kept > 0 && bytes(reply(kept)) > limit) kept--;
  while (kept < parts.length && bytes(reply(kept + 1)) <= limit) kept++;
  return kept;
}

/** Refs as calls to read, ten to a call as read takes them, so every one left out of a reply can still be reached from it */
export function readCalls(refs: string[]): string {
  const calls: string[] = [];
  for (let i = 0; i < refs.length; i += 10)
    calls.push(`read with refs ${JSON.stringify(refs.slice(i, i + 10))}`);
  return calls.join(", then ");
}

/**
 * What a reply says about the parts it left out to stay within READ_BUDGET; empty when it left none. It goes after the frame's closing
 * line, where only Sphica writes: inside the frame a record's own text could spell the same sentence.
 */
export const leftOut = (refs: string[], what: string): string =>
  refs.length
    ? `${refs.length} more ${what} left out to keep this reply within ${READ_BUDGET / 1024} KiB: ${readCalls(refs)}.`
    : "";

/** A record's key as a line shows it: whole, or cut with the id read takes in its place, so a record a reply names can always be opened */
export function keyShown(key: string, id: number, n = 200): string {
  const shown = preview(key, n);
  return shown === inline(key) ? shown : `${shown} [key cut: read u${id}]`;
}

/**
 * Text from a record or from the caller as a reply shows it, within n bytes and marked when cut. It is made plain before it is cut: a cut
 * that drops the end of a terminal control sequence would leave the frame stripping everything after it. lines keeps line breaks.
 */
export function preview(s: string, n: number, lines = false): string {
  const clean = lines ? plain(s) : inline(s);
  const cut = head(clean, n);
  return cut === clean ? cut : `${cut}…`;
}

/**
 * An error reply whose text is over READ_BUDGET, made plain and then cut if it is still over, with a note saying which. The SDK builds
 * some errors itself, before any tool runs (a tool name it does not know, input its schema refuses), and they repeat what the caller
 * sent. An error within the budget, and a reply that is not an error, pass as they are: each tool completes its own within the budget.
 */
export function withinBudget(message: JSONRPCMessage): JSONRPCMessage {
  if (!("result" in message)) return message;
  const result = message.result as { isError?: unknown; content?: unknown };
  if (result.isError !== true || !Array.isArray(result.content)) return message;
  const whole = (result.content as { type?: unknown; text?: unknown }[])
    .flatMap((c) => (c.type === "text" && typeof c.text === "string" ? [c.text] : []))
    .join("\n");
  if (bytes(whole) <= READ_BUDGET) return message;
  // The notes are built here, not kept by the module: the hooks bundle this file for its budget alone
  const CUT = `\n(This error was cut to keep the reply within ${READ_BUDGET / 1024} KiB.)`;
  const TIDIED = `\n(Terminal control sequences were removed from this error, which was over ${READ_BUDGET / 1024} KiB.)`;
  // Plain first: a cut inside a terminal sequence would leave it open, and the terminal would read what follows as part of it
  const clean = plain(whole);
  const note = bytes(clean) + bytes(TIDIED) <= READ_BUDGET ? TIDIED : CUT;
  return {
    ...message,
    result: {
      ...message.result,
      content: [{ type: "text", text: `${head(clean, READ_BUDGET - bytes(note))}${note}` }],
    },
  };
}
