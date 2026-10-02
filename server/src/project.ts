// Identifies projects.
//
// The key is the normalized git remote (`git:github.com/owner/repo`), so it is the same on every machine.
// Only projects without a remote are mapped to `local:<name>` through a per-machine table (~/.sphica/projects.json).
// Local paths are not stored in the database. They differ per machine, and each machine finds them under ~/Projects when syncing.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { leaves } from "./anchors.ts";
import type { Reads } from "./db.ts";
import { sphicaHome } from "./sqlite.ts";

export type Place = { key: string; root: string; name: string };

// Resolve the location on every call (so tests that replace HOME never touch the real table).
const localFile = (): string => path.join(sphicaHome(), "projects.json");
const LOCAL_KEY = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Splits a git remote across ssh / https, with or without .git, ports, and credentials. The path keeps the case it was written in, and so
 * does the host of an scp-like or ssh/git remote; the URL parser lowercases an http(s) host.
 * The URL parser splits the authority. Splitting it by hand leaves pieces of a password containing `@` in the key.
 * Capture spools keys in this form so a database whose project keys are not normalized yet finds its project; drop it once capture can no
 * longer write to such a database.
 */
function legacyRemote(url: string | null | undefined): string | null {
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

// ASCII only, like SQLite's lower(): the migration and the key triggers fold with it, and any other folding would disagree with them.
const fold = (s: string): string => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

/** Folds a `git:` key's host, and the whole key on github.com (owner and repository names are case-insensitive there). Idempotent. */
export function normalizeKey(key: string): string {
  if (!key.startsWith("git:")) return key;
  const rest = key.slice(4);
  const cut = rest.indexOf("/");
  const host = fold(cut < 0 ? rest : rest.slice(0, cut));
  return host === "github.com" ? fold(key) : `git:${host}${cut < 0 ? "" : rest.slice(cut)}`;
}

/** The remote as it appears in a project key: the same repository gives the same text however its remote is written. */
export function normalizeRemote(url: string | null | undefined): string | null {
  const r = legacyRemote(url);
  return r === null ? null : normalizeKey(`git:${r}`).slice(4);
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
export function identify(dir: string): (Place & { legacyKey: string }) | null {
  const given = path.resolve(dir);
  const top = git(given, "rev-parse", "--show-toplevel");
  const root = top || given;
  const legacy = top ? legacyRemote(git(root, "remote", "get-url", "origin")) : null;
  if (legacy) {
    const key = normalizeKey(`git:${legacy}`);
    const remote = key.slice(4);
    return { key, legacyKey: `git:${legacy}`, root, name: remote.split("/").slice(1).join("/") || remote };
  }
  // A project outside git is found by walking up to the named root, even from a subdirectory.
  const map = localMap();
  for (let d = root; ; d = path.dirname(d)) {
    const local = map[d];
    if (local && LOCAL_KEY.test(local))
      return { key: `local:${local}`, legacyKey: `local:${local}`, root: d, name: local };
    if (top || path.dirname(d) === d) return null;
  }
}

/**
 * The session's directory Codex puts in a tool call's _meta when the server declares the `codex/sandbox-state-meta` capability
 * (codex-cli 0.157.1 starts plugin MCP servers in the plugin root, so this is its only workspace signal). Null when absent or not a file URL.
 */
export function hostWorkspace(meta: unknown): string | null {
  const state = (meta as Record<string, unknown> | undefined)?.["codex/sandbox-state-meta"];
  const cwd = (state as Record<string, unknown> | undefined)?.sandboxCwd;
  if (typeof cwd !== "string" || !cwd.startsWith("file:")) return null;
  try {
    return fileURLToPath(cwd);
  } catch {
    return null;
  }
}

/**
 * The project a record write goes to: the host's workspace (Claude Code's CLAUDE_PROJECT_DIR, or the directory Codex names in the
 * call), never another project a tool's cwd argument names. Null when the workspace is in no project.
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
export async function projectId(db: Reads, key: string): Promise<number | null> {
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
  // The database refuses a path with a control character (no filesystem call takes a NUL either)
  if (!rel || leaves(rel) || /\p{Cc}/u.test(rel)) return null;
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
