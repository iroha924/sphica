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

/** Whether the commit exists in the repository and holds the path. */
export function commitHolds(root: string, commit: string, rel: string): boolean {
  try {
    cleanGit(root, ["cat-file", "-e", `${commit}:${rel}`]);
    return true;
  } catch {
    return false;
  }
}
