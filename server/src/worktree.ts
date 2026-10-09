// What changed in the working tree during a turn, from git status at the turn's start and end. Catches edits the edit-tool hooks
// never see (shell commands, formatters) and files committed within the turn. An observation only: it never says who changed a file.
import fs from "node:fs";
import path from "node:path";
import { commitDiffNames, commitOf, isAncestor, worktreeStatus } from "./git.ts";

/** The commit and a signature per changed path. A path missing from `entries` was clean. */
export type Snapshot = { head: string | null; entries: Record<string, string> };

/** Paths reported per turn at most. A generated tree or a mass rename is not worth a row per file. */
const MAX_PATHS = 200;

const LIMITS = { timeout: 5_000 };

/**
 * Paths git prints relative to the root. Ones the edit table would refuse (a backslash in a POSIX name, a control character) are
 * skipped here, so one odd file name cannot get its turn's record rejected.
 */
const usable = (p: string): boolean => p !== "" && !p.includes("\\") && !/\p{Cc}/u.test(p);

/**
 * Reads `git status --porcelain=v2 -z`. The signature is the entry without its path plus the file's size and mtime, so a second edit
 * to a file that was already dirty still counts as a change.
 */
export function snapshot(root: string): Snapshot | null {
  const out = worktreeStatus(root, LIMITS);
  if (out === null) return null;
  const fields = out.split("\0");
  const entries: Record<string, string> = {};
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i] ?? "";
    // Field counts before the path: ordinary 8, renamed or copied 9 (then the original path as its own field), unmerged 10, untracked 1
    const skip = { "1": 8, "2": 9, u: 10, "?": 1 }[f[0] ?? ""];
    if (!skip) continue;
    const parts = f.split(" ");
    const p = parts.slice(skip).join(" ");
    if (f[0] === "2") i++;
    if (!usable(p)) continue;
    // The entry itself, not what a symlink points to (a looping or dangling link must not stop recording)
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(path.join(root, p), { throwIfNoEntry: false });
    } catch {
      st = undefined;
    }
    entries[p] = `${parts.slice(0, skip).join(" ")} ${st ? `${st.size}:${st.mtimeMs}` : "gone"}`;
  }
  let head: string | null = null;
  try {
    head = commitOf(root, "HEAD", LIMITS) || null;
  } catch {
    // no commit yet
  }
  return { head, entries };
}

/** Paths that changed between two snapshots of the same tree, plus the files of commits made in between (when history only moved forward). */
export function changed(root: string, before: Snapshot, after: Snapshot): string[] {
  const paths = new Set<string>();
  for (const p of new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]))
    if (before.entries[p] !== after.entries[p]) paths.add(p);
  if (
    before.head &&
    after.head &&
    before.head !== after.head &&
    isAncestor(root, before.head, after.head, LIMITS)
  ) {
    let between: string[] = [];
    try {
      between = commitDiffNames(root, before.head, after.head, LIMITS);
    } catch {
      // the commits' files are not added
    }
    for (const p of between) if (usable(p)) paths.add(p);
  }
  return [...paths].sort().slice(0, MAX_PATHS);
}
