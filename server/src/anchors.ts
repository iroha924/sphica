// Where a record sits in the code, checked against the working tree each time it is served (never cached in the database).
// A located symbol only says the code is still there; it never proves the decision still holds.
import crypto from "node:crypto";
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

/** The bytes of a repository file, or null when it is absent; undefined when it cannot be read as text here. */
function readBytes(root: string, rel: string): Buffer | null | undefined {
  const abs = path.join(root, rel);
  if (leaves(path.relative(root, abs))) return undefined;
  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(abs, { throwIfNoEntry: false });
  } catch (e) {
    // A path through what is a regular file is absent; any other failure (no permission) cannot be checked
    return (e as NodeJS.ErrnoException).code === "ENOTDIR" ? null : undefined;
  }
  if (!st) return null;
  if (!st.isFile() || st.size > MAX_BYTES) return undefined;
  try {
    // A symlinked directory on the way can lead outside the repository: the real path must stay inside the real root
    const inside = path.relative(fs.realpathSync(root), fs.realpathSync(abs));
    if (leaves(inside)) return undefined;
    const buf = fs.readFileSync(abs);
    return buf.includes(0) ? undefined : buf;
  } catch {
    // Not readable here (no permission, or gone since the stat): it cannot be checked, which is not the same as missing
    return undefined;
  }
}

function readText(root: string, rel: string): string | null | undefined {
  const buf = readBytes(root, rel);
  return buf ? buf.toString("utf8") : buf;
}

/** Text of a repository file (null when absent, undefined when it cannot be read as text) and a hash that tells a later read whether it changed. */
export type RepoText = { text: string | null | undefined; hash: string };

export function readRepoText(root: string | null, rel: string): RepoText {
  const buf = root ? readBytes(root, rel) : null;
  if (!buf) return { text: buf, hash: buf === null ? "absent" : "unreadable" };
  return { text: buf.toString("utf8"), hash: crypto.createHash("sha256").update(buf).digest("hex") };
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
function swallowed(text: string | null | undefined, symbol: string): boolean {
  if (mask(symbol) !== symbol) return true;
  // A file that is there but cannot be scanned (too large, binary, a link) gives no context to clear the symbol
  if (text === undefined) return true;
  if (text === null) return false;
  const re = new RegExp(`(?<![\\w$])${literal(symbol)}(?![\\w$])`, "g");
  let raw = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) raw++;
  if (raw === 0) return false;
  const masked = mask(text);
  const holes = placeholderRanges(masked);
  // Matches and placeholders both run in order, so one pass pairs them. A match touching a placeholder is not counted either: masking
  // can make a whole name there out of one that was part of a key, and it would stand in for an occurrence masking swallowed
  let h = 0;
  let kept = 0;
  re.lastIndex = 0;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    while ((holes[h]?.[1] ?? Number.POSITIVE_INFINITY) < m.index) h++;
    if (!((holes[h]?.[0] ?? Number.POSITIVE_INFINITY) <= m.index + symbol.length)) kept++;
  }
  return kept !== raw;
}

/** A symbol with spaces around it is checked as written and trimmed, since the name in the file is the trimmed one. */
export function masksSymbolIn(text: string | null | undefined, symbol: string): boolean {
  const trimmed = symbol.trim();
  return swallowed(text, symbol) || (trimmed !== symbol && trimmed !== "" && swallowed(text, trimmed));
}

export const masksSymbol = (root: string | null, rel: string, symbol: string): boolean =>
  masksSymbolIn(root ? readText(root, rel) : null, symbol);

/**
 * Where a symbol is in a repository file now, for recording an anchor's lines when it is saved. The line is masked before it is cut to 200
 * characters: cutting first could drop the closing quote that marks a value as a key.
 */
export function locateIn(
  text: string | null | undefined,
  symbol: string,
): { line: number; excerpt: string } | null {
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

export const locate = (
  root: string | null,
  rel: string,
  symbol: string,
): { line: number; excerpt: string } | null => (root ? locateIn(readText(root, rel), symbol) : null);

/**
 * Whether a repository file is there now, apart from any symbol in it: gone when some part of its path does not exist, unknown when there
 * is no working tree or a symlink on the way leads outside the repository (or cannot be followed).
 */
export function fileState(root: string | null, rel: string): "present" | "gone" | "unknown" {
  if (!root) return "unknown";
  if (leaves(path.relative(root, path.join(root, rel)))) return "unknown";
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return "unknown";
  }
  let at = root;
  for (const part of rel.split("/")) {
    at = path.join(at, part);
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(at, { throwIfNoEntry: false });
    } catch (e) {
      // A path through what is now a regular file is gone too
      if ((e as NodeJS.ErrnoException).code === "ENOTDIR") return "gone";
      return "unknown";
    }
    if (!st) return "gone";
    if (st.isSymbolicLink()) {
      try {
        if (leaves(path.relative(realRoot, fs.realpathSync(at)))) return "unknown";
      } catch {
        return "unknown";
      }
    }
  }
  return "present";
}

export type PathKind = "file" | "directory" | "gone" | "unknown";

/** What a repository path is now. A file too large or binary to scan is still a file; only its symbols cannot be checked. */
export function pathKind(root: string | null, rel: string): PathKind {
  const state = fileState(root, rel);
  if (state !== "present" || !root) return state === "gone" ? "gone" : "unknown";
  try {
    const st = fs.statSync(path.join(root, rel));
    return st.isFile() ? "file" : st.isDirectory() ? "directory" : "unknown";
  } catch {
    return "unknown";
  }
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
