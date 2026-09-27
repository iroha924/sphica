// Where a record sits in the code, checked against the working tree each time it is served (never cached in the database).
// A located symbol only says the code is still there; it never proves the decision still holds.
import fs from "node:fs";
import path from "node:path";

export type AnchorState = "located" | "moved" | "missing" | "unknown";

/** Files larger than this are not scanned for a symbol. */
const MAX_BYTES = 2 * 1024 * 1024;

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The text of a repository file, or null when it is absent; undefined when it cannot be read as text here. */
function readText(root: string, rel: string): string | null | undefined {
  const abs = path.join(root, rel);
  if (path.relative(root, abs).startsWith("..")) return undefined;
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (!st) return null;
  if (!st.isFile() || st.size > MAX_BYTES) return undefined;
  // A symlinked directory on the way can lead outside the repository: the real path must stay inside the real root
  const inside = path.relative(fs.realpathSync(root), fs.realpathSync(abs));
  if (inside.startsWith("..") || path.isAbsolute(inside)) return undefined;
  const buf = fs.readFileSync(abs);
  return buf.includes(0) ? undefined : buf.toString("utf8");
}

/** The 1-based line where symbol first appears as a whole identifier, and that line; null when it does not. */
function findSymbol(text: string, symbol: string): { line: number; excerpt: string } | null {
  const re = new RegExp(`(?<![\\w$])${literal(symbol)}(?![\\w$])`);
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => re.test(l));
  return i < 0 ? null : { line: i + 1, excerpt: (lines[i] ?? "").trim().slice(0, 200) };
}

/** Where a symbol is in a repository file now, for recording an anchor's lines when it is saved. */
export function locate(
  root: string | null,
  rel: string,
  symbol: string,
): { line: number; excerpt: string } | null {
  if (!root) return null;
  const text = readText(root, rel);
  return typeof text === "string" ? findSymbol(text, symbol) : null;
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
  const found = findSymbol(text, a.symbol);
  if (!found) return { state: "missing", line: null };
  return {
    state: a.line_start === null || a.line_start === found.line ? "located" : "moved",
    line: found.line,
  };
}
