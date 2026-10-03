// git run against a repository the caller names, for reading committed objects.
import { execFileSync } from "node:child_process";

/** git without the caller's GIT_* variables, which could point it at another repository or object store. */
export function cleanGit(root: string, args: string[], max = 1024 * 1024): Buffer {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  return execFileSync("git", ["-C", root, ...args], {
    env,
    maxBuffer: max,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
  });
}

/** Whether the commit exists in the repository and holds the path as a regular file (not a folder, a symlink, or a submodule). */
export function commitHolds(root: string, commit: string, rel: string): boolean {
  try {
    const entry = cleanGit(root, ["ls-tree", "-z", commit, "--", rel]).toString("utf8").split("\0")[0] ?? "";
    // "<mode> <type> <object>\t<path>"
    const m = /^(\d{6}) (\w+) [0-9a-f]+\t(.*)$/.exec(entry);
    return !!m && (m[1] === "100644" || m[1] === "100755") && m[2] === "blob" && m[3] === rel;
  } catch {
    return false;
  }
}

/** The repository's tracked and untracked (not ignored) files, or null when git cannot list them. */
export function repoFiles(root: string): string[] | null {
  try {
    const out = cleanGit(
      root,
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      32 * 1024 * 1024,
    );
    return [...new Set(out.toString("utf8").split("\0").filter(Boolean))];
  } catch {
    return null;
  }
}

/**
 * Files git sees as renamed between the commit and the working tree, old path to new; null when git cannot tell (no such commit, too slow,
 * too much output). A move to a file git does not track is not seen.
 */
export function renamesSince(root: string, commit: string): Map<string, string> | null {
  try {
    const out = cleanGit(
      root,
      ["diff", "-M", "-l1000", "--name-status", "-z", commit, "--"],
      32 * 1024 * 1024,
    );
    const parts = out.toString("utf8").split("\0");
    const renames = new Map<string, string>();
    // "R<score>\0<old>\0<new>" for a rename or copy, "<status>\0<path>" otherwise
    for (let i = 0; i < parts.length; ) {
      const status = parts[i] ?? "";
      if (/^[RC]\d*$/.test(status)) {
        if (status.startsWith("R")) renames.set(parts[i + 1] ?? "", parts[i + 2] ?? "");
        i += 3;
      } else i += 2;
    }
    return renames;
  } catch {
    return null;
  }
}
