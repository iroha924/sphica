// Every git Sphica runs, one function per operation. Sphica runs git outside the agent's sandbox, in a repository whose config the agent
// can write, so no caller passes git its own arguments: each operation builds them here, and only this file starts git.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkerRequest, WorkerResult, WorktreeOp } from "./git-worker.ts";

/**
 * Where Sphica keeps what git reads from it (the hooks folder, isolated git directories): under HOME, which a sandboxed agent cannot
 * write. Nothing is created there for these operations: a hooks folder that does not exist has no hooks to run.
 */
const gitHome = (): string => path.join(os.homedir(), ".sphica", "git");

/**
 * The environment git runs with: none of the caller's GIT_* variables (in any letter case, as Windows matches them), no transport at all
 * (a missing object fails instead of fetching from a remote the config names), no prompt, and no replace refs.
 */
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)),
  );
  return {
    ...env,
    GIT_ALLOW_PROTOCOL: "",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    ...extra,
  };
}

/**
 * Options before the subcommand that keep config from running a command. core.fsmonitor is emptied, not false: git 2.35.1 and older take
 * false as the name of a hook to run. None of the operations here writes the index, the path a config-defined hook runs on.
 */
export const gitOptions = (hooks = path.join(gitHome(), "hooks")): string[] => [
  "-c",
  "core.fsmonitor=",
  "-c",
  `core.hooksPath=${hooks}`,
  "-c",
  "core.quotePath=false",
  "--no-pager",
  "--no-optional-locks",
];

/** Options for every diff: no external diff program, no textconv, and submodules compared by their commit only */
export const DIFF_OPTIONS = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--ignore-submodules=dirty",
  "--submodule=short",
];

type Limits = { max?: number; timeout?: number };

/**
 * Where git and the worker start: HOME, not the caller's directory. Windows looks for a program in the current directory before PATH,
 * so a git.exe the agent put in its work tree would run instead of git; -C moves git only after it has started. Without a HOME on disk,
 * the folder Node itself runs from, which an agent cannot write either.
 */
export function startDir(): string {
  const home = os.homedir();
  return fs.statSync(home, { throwIfNoEntry: false })?.isDirectory() ? home : path.dirname(process.execPath);
}

function run(root: string, args: string[], { max = 1024 * 1024, timeout = 10_000 }: Limits = {}): Buffer {
  return execFileSync("git", ["-C", root, ...gitOptions(), ...args], {
    cwd: startDir(),
    env: gitEnv(),
    maxBuffer: max,
    stdio: ["ignore", "pipe", "ignore"],
    timeout,
    killSignal: "SIGKILL",
  });
}

const text = (root: string, args: string[], limits?: Limits) => run(root, args, limits).toString("utf8");
const list = (out: string) => out.split("\0").filter(Boolean);

/** A revision a caller passes on, refused when git would read it as an option */
function revision(rev: string): string {
  if (!rev || rev.startsWith("-") || /[\0\n]/.test(rev))
    throw new Error(`not a revision: ${JSON.stringify(rev)}`);
  return rev;
}

/** An object id, as commit-to-commit diffs and object reads take only those */
function objectId(oid: string): string {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid))
    throw new Error(`not an object id: ${JSON.stringify(oid)}`);
  return oid;
}

/** The top of the work tree dir is in; throws outside git */
export const topLevel = (dir: string, limits?: Limits): string =>
  text(dir, ["rev-parse", "--show-toplevel"], limits).trim();

/** Whether dir is inside a work tree; throws outside git */
export const insideWorkTree = (dir: string): boolean =>
  text(dir, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";

/** The commit a revision names; throws when it names none */
export const commitOf = (root: string, rev: string, limits?: Limits): string =>
  text(root, ["rev-parse", "--verify", "-q", `${revision(rev)}^{commit}`], limits).trim();

/** The short name of origin/HEAD, or of the branch's upstream; throws when there is none */
export const baseRef = (root: string, which: "origin/HEAD" | "upstream"): string =>
  text(
    root,
    which === "origin/HEAD"
      ? ["rev-parse", "--abbrev-ref", "origin/HEAD"]
      : ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
  ).trim();

/** The best common ancestor of two revisions; throws when they share none */
export const mergeBase = (root: string, a: string, b: string): string =>
  text(root, ["merge-base", revision(a), revision(b)]).trim();

/** Whether commit a is an ancestor of commit b; false when git cannot tell */
export function isAncestor(root: string, a: string, b: string, limits?: Limits): boolean {
  try {
    run(root, ["merge-base", "--is-ancestor", objectId(a), objectId(b)], limits);
    return true;
  } catch {
    return false;
  }
}

/** The paths that differ between two commits */
export const commitDiffNames = (root: string, a: string, b: string, limits?: Limits): string[] =>
  list(text(root, ["diff", ...DIFF_OPTIONS, "--name-only", "-z", objectId(a), objectId(b), "--"], limits));

/** The tree entry for one path in a commit, as `<mode> <type> <object>\t<path>`, or "" when there is none */
export const treeEntry = (root: string, commit: string, rel: string): string =>
  text(root, ["ls-tree", "-z", revision(commit), "--", rel]).split("\0")[0] ?? "";

/** A blob's size in bytes; throws when the object is missing (it is never fetched) */
export const blobSize = (root: string, blob: string): number =>
  Number(text(root, ["cat-file", "-s", objectId(blob)]).trim());

/** A blob's bytes as committed, never through a filter or textconv; throws when the object is missing */
export const blobBytes = (root: string, blob: string, max: number): Buffer =>
  run(root, ["cat-file", "blob", objectId(blob)], { max });

/**
 * Paths from the index and the work tree, by name only (no file is compared by content): tracked ones, untracked ones git does not
 * ignore, both, or tracked ones deleted from the work tree, optionally within pathspecs
 */
export function listFiles(
  root: string,
  kind: "tracked" | "untracked" | "tracked-and-untracked" | "deleted",
  { pathspecs = [], ...limits }: Limits & { pathspecs?: string[] } = {},
): string[] {
  const which = {
    tracked: ["--cached"],
    untracked: ["--others", "--exclude-standard"],
    "tracked-and-untracked": ["--cached", "--others", "--exclude-standard"],
    deleted: ["--deleted"],
  }[kind];
  return list(text(root, ["ls-files", "-z", ...which, "--", ...pathspecs], limits));
}

/** Where a file of the repository's git directory is (`index`, `info/exclude`), as git resolves it for linked work trees */
export const gitPath = (
  root: string,
  name: "index" | "info/exclude" | "info/attributes" | "info/sparse-checkout",
  limits?: Limits,
): string => path.resolve(root, text(root, ["rev-parse", "--git-path", name], limits).replace(/\n$/, ""));

/** The git directory linked work trees share, which holds the objects */
export const commonDir = (root: string, limits?: Limits): string =>
  path.resolve(root, text(root, ["rev-parse", "--git-common-dir"], limits).replace(/\n$/, ""));

/** Whether HEAD names a branch that has no commit yet; false when HEAD is detached, its branch exists, or git cannot tell */
export function unbornHead(root: string, limits?: Limits): boolean {
  let ref: string;
  try {
    ref = text(root, ["symbolic-ref", "-q", "HEAD"], limits).trim();
  } catch {
    return false;
  }
  try {
    run(root, ["show-ref", "--verify", "-q", "--", revision(ref)], limits);
    return false;
  } catch (e) {
    // show-ref exits 1 for a ref that does not exist; anything else (a timeout, a signal) tells nothing
    return (e as { status?: number | null }).status === 1;
  }
}

/** Config keys whose values only change how files are read or listed, never what runs, by the type git checks them as */
export const SAFE_KEYS = {
  "core.ignorecase": "bool",
  "core.precomposeunicode": "bool",
  "core.filemode": "bool",
  "core.symlinks": "bool",
  "core.trustctime": "bool",
  "core.sparseCheckout": "bool",
  "core.sparseCheckoutCone": "bool",
  "index.sparse": "bool",
  "core.autocrlf": "text",
  "core.eol": "text",
  "core.checkStat": "text",
  "extensions.objectFormat": "text",
  "core.excludesFile": "path",
} as const;

/** A config value as git reads it (local, global, and system), typed by git where it can; null when unset or unreadable */
export function configGet(root: string, key: keyof typeof SAFE_KEYS, limits?: Limits): string | null {
  const type = SAFE_KEYS[key];
  try {
    return text(
      root,
      ["config", ...(type === "text" ? [] : [`--type=${type}`]), "--get", key],
      limits,
    ).replace(/\n$/, "");
  } catch {
    return null;
  }
}

/** The URL of the origin remote; throws when there is none */
export const originUrl = (root: string, limits?: Limits): string =>
  text(root, ["remote", "get-url", "origin"], limits).trim();

/** Whether the commit exists in the repository and holds the path as a regular file (not a folder, a symlink, or a submodule). */
export function commitHolds(root: string, commit: string, rel: string): boolean {
  try {
    // "<mode> <type> <object>\t<path>"
    const m = /^(\d{6}) (\w+) [0-9a-f]+\t(.*)$/.exec(treeEntry(root, commit, rel));
    return !!m && (m[1] === "100644" || m[1] === "100755") && m[2] === "blob" && m[3] === rel;
  } catch {
    return false;
  }
}

/** The repository's tracked and untracked (not ignored) files, or null when git cannot list them. */
export function repoFiles(root: string): string[] | null {
  try {
    const max = 32 * 1024 * 1024;
    // --cached keeps a file deleted from the working tree until the deletion is staged
    const deleted = new Set(listFiles(root, "deleted", { max }));
    return [...new Set(listFiles(root, "tracked-and-untracked", { max }))].filter((p) => !deleted.has(p));
  } catch {
    return null;
  }
}

/**
 * `git status --porcelain=v2 -z --untracked-files=all` of the work tree, read in the git worker; null when it fails or misses the
 * deadline
 */
export async function worktreeStatus(root: string, deadline: number): Promise<string | null> {
  const out = await inIsolation(root, [{ kind: "status" }], { deadline, max: 16 * 1024 * 1024 });
  return out?.[0] ?? null;
}

/**
 * The work tree's diff against a commit, read in the git worker: the patch text (no renames, a/ and b/ prefixes) and every changed
 * path. Null when it fails, misses the deadline, or an output is over max.
 */
export async function worktreeDiff(
  root: string,
  from: string,
  { max, deadline }: { max: number; deadline: number },
): Promise<{ patch: string; names: string[] } | null> {
  const out = await inIsolation(root, [{ kind: "diff", from: objectId(from) }], { deadline, max });
  return out && out.length === 2 ? { patch: out[0] ?? "", names: list(out[1] ?? "") } : null;
}

/**
 * Files git sees as renamed between the commit and the working tree, old path to new; a deleted path maps to null when git skipped
 * looking for its rename (too many files). Null when git cannot tell at all (no such commit, too slow, too much output). A move to a file
 * git does not track is not seen.
 */
export async function renamesSince(
  root: string,
  commit: string,
  deadline = 10_000,
): Promise<Map<string, string | null> | null> {
  const limit = 1000;
  // One deadline for resolving the commit and the worker both
  const until = Date.now() + deadline;
  let oid: string;
  try {
    oid = commitOf(root, commit, { timeout: deadline });
  } catch {
    return null;
  }
  const left = until - Date.now();
  if (left <= 0) return null;
  const out = await inIsolation(root, [{ kind: "renames", commit: oid }], {
    deadline: left,
    max: 32 * 1024 * 1024,
  });
  const names = out?.[0];
  if (names === undefined) return null;
  const parts = names.split("\0");
  const renames = new Map<string, string | null>();
  const deleted: string[] = [];
  let added = 0;
  // "R<score>\0<old>\0<new>" for a rename or copy, "<status>\0<path>" otherwise
  for (let i = 0; i < parts.length; ) {
    const status = parts[i] ?? "";
    if (/^[RC]\d*$/.test(status)) {
      if (status.startsWith("R")) renames.set(parts[i + 1] ?? "", parts[i + 2] ?? "");
      i += 3;
    } else {
      if (status === "D") deleted.push(parts[i + 1] ?? "");
      if (status === "A") added++;
      i += 2;
    }
  }
  // git pairs what is left only while sources times destinations stays within the limit squared; beyond it, it only warns on stderr
  if (deleted.length * added > limit * limit) for (const d of deleted) renames.set(d, null);
  return renames;
}

/** The worker beside this module: the bundle's git-worker.js, or the source when run from the source */
function workerFile(): string {
  const js = path.join(import.meta.dirname, "git-worker.js");
  return fs.existsSync(js) ? js : path.join(import.meta.dirname, "git-worker.ts");
}

/**
 * Runs work tree comparisons in the git worker, one isolated git directory for all of them, and gives their outputs in order (a diff
 * gives two: the patch and the changed paths). Null when the worker fails or misses the deadline; the worker is then killed and not
 * waited for, since a read stalled in it may never end.
 */
export function inIsolation(
  root: string,
  ops: WorktreeOp[],
  { deadline, max }: { deadline: number; max: number },
): Promise<string[] | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // A process group of its own on POSIX, so the git it started goes with it when it is killed
      child = spawn(process.execPath, [workerFile()], {
        cwd: startDir(),
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (out: string[] | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (out === null) {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.unref();
      }
      resolve(out);
    };
    const timer = setTimeout(() => finish(null), deadline);
    // Room for every output at its own limit, as JSON may write each byte as six (\u0001), plus the JSON around them
    const cap = 6 * max * Math.max(1, ops.length * 2) + 64 * 1024;
    child.stdout?.on("data", (c: Buffer) => {
      size += c.length;
      if (size > cap) finish(null);
      else chunks.push(c);
    });
    child.on("error", () => finish(null));
    child.on("close", () => {
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WorkerResult;
        finish(result.ok ? result.out : null);
      } catch {
        finish(null);
      }
    });
    child.stdin?.on("error", () => finish(null));
    child.stdin?.end(
      // The worker's own deadline comes first, so it kills its git before it is killed (Windows has no group to kill)
      JSON.stringify({
        root,
        ops,
        max,
        until: Date.now() + Math.floor(deadline * 0.8),
      } satisfies WorkerRequest),
    );
  });
}
