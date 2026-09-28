// Where a record sits in the code, checked against the working tree each time it is served (never cached in the database).
// A located symbol only says the code is still there; it never proves the decision still holds.
import fs from "node:fs";
import path from "node:path";
import { bytes, mask, placeholderRanges, privateKeyRanges } from "./text.ts";

export type AnchorState = "located" | "moved" | "missing" | "unknown";

/** Files larger than this are not scanned for a symbol. */
const MAX_BYTES = 2 * 1024 * 1024;

/** Whether a path.relative result leaves its base. A name like `..config` stays inside; only `..` itself or `../...` leave. */
export const leaves = (rel: string): boolean =>
  rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The text of a repository file, or null when it is absent; undefined when it cannot be read as text here. */
function readText(root: string, rel: string): string | null | undefined {
  const abs = path.join(root, rel);
  if (leaves(path.relative(root, abs))) return undefined;
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (!st) return null;
  if (!st.isFile() || st.size > MAX_BYTES) return undefined;
  // A symlinked directory on the way can lead outside the repository: the real path must stay inside the real root
  const inside = path.relative(fs.realpathSync(root), fs.realpathSync(abs));
  if (leaves(inside)) return undefined;
  const buf = fs.readFileSync(abs);
  return buf.includes(0) ? undefined : buf.toString("utf8");
}

/** The file's lines and the 0-based index of the first one holding symbol as a whole identifier (-1 when none does). */
function findSymbol(text: string, symbol: string): { lines: string[]; i: number } {
  const re = new RegExp(`(?<![\\w$])${literal(symbol)}(?![\\w$])`);
  const lines = text.split(/\r?\n/);
  return { lines, i: lines.findIndex((l) => re.test(l)) };
}

/**
 * Whether a symbol is text mask() hides: a key by its shape, or a name masking swallows somewhere (a copy left elsewhere, or a placeholder's own
 * letters, does not clear it). Names are counted whole, as findSymbol matches them. Such an anchor would store the key in its symbol.
 */
export function masksSymbol(root: string | null, rel: string, symbol: string): boolean {
  if (mask(symbol) !== symbol) return true;
  const text = root ? readText(root, rel) : null;
  if (typeof text !== "string") return false;
  const re = new RegExp(`(?<![\\w$])${literal(symbol)}(?![\\w$])`, "g");
  const raw = [...text.matchAll(re)].length;
  if (raw === 0) return false;
  const masked = mask(text);
  const holes = placeholderRanges(masked);
  // Matches and placeholders both run in order, so one pass pairs them
  let h = 0;
  let kept = 0;
  for (const m of masked.matchAll(re)) {
    while ((holes[h]?.[1] ?? Number.POSITIVE_INFINITY) <= m.index) h++;
    if (!((holes[h]?.[0] ?? Number.POSITIVE_INFINITY) < m.index + symbol.length)) kept++;
  }
  return kept !== raw;
}

/**
 * Where a symbol is in a repository file now, for recording an anchor's lines when it is saved. The line is masked before it is cut to 200
 * characters: cutting first could drop the closing quote that marks a value as a key.
 */
export function locate(
  root: string | null,
  rel: string,
  symbol: string,
): { line: number; excerpt: string } | null {
  if (!root) return null;
  const text = readText(root, rel);
  if (typeof text !== "string") return null;
  const { lines, i } = findSymbol(text, symbol);
  if (i < 0) return null;
  const line = lines[i] ?? "";
  // A line inside a private key cannot be masked alone (its BEGIN and END are on other lines); the file may have changed since the check
  const from = bytes(lines.slice(0, i).join("\n")) + (i > 0 ? 1 : 0);
  if (privateKeyRanges(lines.join("\n")).some(([a, b]) => a < from + bytes(line) && b > from))
    return { line: i + 1, excerpt: "[redacted: private key]" };
  // A value whose key name sits on another line cannot be masked alone: the text around must not change how the line masks
  const before = lines
    .slice(0, i)
    .map((l) => `${l}\n`)
    .join("");
  const after = lines
    .slice(i + 1)
    .map((l) => `\n${l}`)
    .join("");
  const own = mask(line);
  const cut = mask(before + line) !== mask(before) + own || mask(line + after) !== own + mask(after);
  return { line: i + 1, excerpt: cut ? "[redacted]" : own.trim().slice(0, 200) };
}

/** The anchor's state in the working tree: the file and symbol are there (at the recorded line or another), gone, or cannot be checked. */
export function checkAnchor(
  root: string | null,
  a: { path: string; symbol: string | null; line_start: number | null },
): { state: AnchorState; line: number | null } {
  if (!root) return { state: "unknown", line: null };
  const text = readText(root, a.path);
  if (text === null) return { state: "missing", line: null };
  if (text === undefined) return { state: "unknown", line: null };
  if (!a.symbol) return { state: "located", line: a.line_start };
  const { i } = findSymbol(text, a.symbol);
  if (i < 0) return { state: "missing", line: null };
  return {
    state: a.line_start === null || a.line_start === i + 1 ? "located" : "moved",
    line: i + 1,
  };
}
