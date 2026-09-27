// Identifies projects.
//
// The key is the normalized git remote (`git:github.com/owner/repo`), so it is the same on every machine.
// Only projects without a remote are mapped to `local:<name>` through a per-machine table (~/.sphica/projects.json).
// Local paths are not stored in the database. They differ per machine, and each machine finds them under ~/Projects when syncing.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Kysely } from "kysely";
import type { DB } from "./db-types.ts";

export type Place = { key: string; root: string; name: string };

// Resolve the location on every call (so tests that replace HOME never touch the real table).
const localFile = (): string => path.join(os.homedir(), ".sphica", "projects.json");
const LOCAL_KEY = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Normalizes a git remote across ssh / https, with or without .git, ports, and credentials.
 * The URL parser splits the authority. Splitting it by hand leaves pieces of a password containing `@` in the key.
 */
export function normalizeRemote(url: string | null | undefined): string | null {
  const raw = String(url ?? "").trim();
  if (!raw) return null;
  // scp-like remotes (git@host:path) are not URLs, so handle them first.
  const scp = raw.match(/^(?:[^@/]+@)?([^:/]+):(?!\/)(.+?)(?:\.git)?$/);
  if (scp) return `${scp[1]}/${scp[2]}`;
  try {
    const u = new URL(raw);
    if (!u.hostname) return null;
    const p = u.pathname.replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
    return p ? `${u.hostname}/${p}` : u.hostname;
  } catch {
    return null;
  }
}

const git = (dir: string, ...args: string[]): string | null => {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
  } catch {
    return null;
  }
};

/** The table of named projects. **A broken file is not treated as empty** (writing it back empty would drop every other entry). */
function localMap(): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(localFile(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    m = null;
  }
  if (
    !m ||
    typeof m !== "object" ||
    Array.isArray(m) ||
    Object.entries(m).some(
      ([root, name]) => !path.isAbsolute(root) || typeof name !== "string" || !LOCAL_KEY.test(name),
    )
  )
    throw new Error(
      `${localFile()} is not a valid JSON project table. Fix or delete it, then name the project again.`,
    );
  return m as Record<string, string>;
}

/** The repository root, or dir itself outside git. */
const rootOf = (dir: string): string =>
  git(path.resolve(dir), "rev-parse", "--show-toplevel") || path.resolve(dir);

/**
 * The project dir belongs to, or null (nothing is recorded).
 * **The root is the repository's top level**, so relative paths keep the same base when called from a subdirectory.
 */
export function identify(dir: string): Place | null {
  const given = path.resolve(dir);
  const top = git(given, "rev-parse", "--show-toplevel");
  const root = top || given;
  const remote = top ? normalizeRemote(git(root, "remote", "get-url", "origin")) : null;
  if (remote) return { key: `git:${remote}`, root, name: remote.split("/").slice(1).join("/") || remote };
  // A project outside git is found by walking up to the named root, even from a subdirectory.
  const map = localMap();
  for (let d = root; ; d = path.dirname(d)) {
    const local = map[d];
    if (local && LOCAL_KEY.test(local)) return { key: `local:${local}`, root: d, name: local };
    if (top || path.dirname(d) === d) return null;
  }
}

/**
 * The project a record write goes to: the host's workspace (Claude Code's CLAUDE_PROJECT_DIR, or the directory Codex starts the MCP
 * server in), never another project a tool's cwd argument names. Null when the workspace is in no project.
 */
export function writePlace(workspace: string, cwd: string | undefined): Place | null {
  const here = identify(workspace);
  if (!here) return null;
  const asked = cwd ? identify(cwd) : null;
  if (asked && asked.key !== here.key)
    throw new Error(`${asked.name} is not the workspace this session writes to (${here.name})`);
  return here;
}

/** Rejects a name a project without a remote cannot take (before anything is written) */
export function checkLocalName(name: string): void {
  if (!LOCAL_KEY.test(name))
    throw new Error(`Use only lowercase letters, digits, and . _ - in the name: ${name}`);
}

/** The top of the git repository dir is in, or null outside git */
export const repositoryRoot = (dir: string): string | null =>
  git(path.resolve(dir), "rev-parse", "--show-toplevel") || null;

/** Names a project without a remote on this machine. */
export function nameLocal(dir: string, name: string): Place {
  checkLocalName(name);
  // With a remote, the key comes from the remote and the named key is never looked up (the entry would be unreachable).
  const place = identify(dir);
  if (place?.key.startsWith("git:"))
    throw new Error(`${place.root} has a git remote, so its key is ${place.key}. Add it without --name.`);
  const root = rootOf(dir);
  const m = localMap();
  m[root] = name;
  // **Create the directory first.** `sphica init` creates ~/.sphica/, but a user may name a project before that.
  // Writing without it fails with ENOENT, and the project cannot be named.
  fs.mkdirSync(path.dirname(localFile()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(localFile(), `${JSON.stringify(m, null, 2)}\n`);
  return { key: `local:${name}`, root, name };
}

/** The project id, or null (only `sphica init` creates one). */
export async function projectId(db: Kysely<DB>, key: string): Promise<number | null> {
  const r = await db.selectFrom("project").select("id").where("key", "=", key).executeTakeFirst();
  return r?.id ?? null;
}

/**
 * Finds registered projects on this machine. Looks only directly under ~/Projects and at named projects.
 * **When two places share a key, neither is chosen.** Never report whichever copy sorts first as the project.
 */
export function localRoots(roots = [path.join(os.homedir(), "Projects")]): {
  found: Map<string, string>;
  ambiguous: Map<string, string[]>;
} {
  const seen = new Map<string, string[]>();
  const add = (p: Place | null) => {
    if (p) seen.set(p.key, [...new Set([...(seen.get(p.key) ?? []), p.root])]);
  };
  for (const r of roots) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(r, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries)
      if (e.isDirectory() && !e.name.startsWith(".")) add(identify(path.join(r, e.name)));
  }
  for (const [root, name] of Object.entries(localMap())) {
    if (LOCAL_KEY.test(name) && fs.existsSync(root)) add({ key: `local:${name}`, root, name });
  }
  const found = new Map<string, string>();
  const ambiguous = new Map<string, string[]>();
  for (const [key, dirs] of seen) {
    if (dirs.length === 1 && dirs[0]) found.set(key, dirs[0]);
    else ambiguous.set(key, dirs);
  }
  return { found, ambiguous };
}

/** A path relative to the project root, or null when it is outside the root or unreadable. */
export function relativeTo(root: string, file: string, cwd = root): string | null {
  const abs = path.resolve(cwd, file);
  const rel = path.relative(root, abs);
  // A name like `..config` is inside the root. Only `..` itself or paths starting with `../` leave it.
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/** Codex apply_patch names the edited file in the patch header. Only the four header forms are read (not the body). */
export function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    const m = line.match(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/);
    if (m?.[1]) out.push(m[1].trim());
  }
  return out;
}
