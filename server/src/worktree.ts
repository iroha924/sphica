// What changed in the working tree during a turn, from git status at the turn's start and end. Catches edits the edit-tool hooks
// never see (shell commands, formatters) and files committed within the turn. An observation only: it never says who changed a file.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The commit and a signature per changed path. A path missing from `entries` was clean. */
export type Snapshot = { head: string | null; entries: Record<string, string> };

/** Paths reported per turn at most. A generated tree or a mass rename is not worth a row per file. */
const MAX_PATHS = 200;

const git = (root: string, args: string[]): string | null => {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
};

/** Paths git prints relative to the root. Ones the edit table would refuse (a backslash in a POSIX name) are skipped here. */
const usable = (p: string): boolean => p !== "" && !p.includes("\\");

/**
 * Reads `git status --porcelain=v2 -z`. The signature is the entry without its path plus the file's size and mtime, so a second edit
 * to a file that was already dirty still counts as a change.
 */
export function snapshot(root: string): Snapshot | null {
  const out = git(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
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
    const st = fs.statSync(path.join(root, p), { throwIfNoEntry: false });
    entries[p] = `${parts.slice(0, skip).join(" ")} ${st ? `${st.size}:${st.mtimeMs}` : "gone"}`;
  }
  const head = git(root, ["rev-parse", "--verify", "-q", "HEAD"])?.trim() || null;
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
    git(root, ["merge-base", "--is-ancestor", before.head, after.head]) !== null
  )
    for (const p of (git(root, ["diff", "--name-only", "-z", before.head, after.head]) ?? "").split("\0"))
      if (usable(p)) paths.add(p);
  return [...paths].sort().slice(0, MAX_PATHS);
}
