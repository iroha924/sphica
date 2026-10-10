// What a shell call changed among the files records are anchored to: each file's content hash before and after the call. Hashes are
// cached per checkout under the lstat signature they were read with, so a call re-reads only files whose signature moved. Changes that
// keep the whole signature are not seen, and neither are writes a background command makes after its hook ran.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sphicaHome } from "./sqlite.ts";

/** lstat's view of a file, as strings so the nanosecond times and 64-bit numbers survive JSON */
type Signature = { dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string };

export type State =
  | { kind: "ok"; sig: Signature; hash: string }
  | { kind: "missing" }
  /** Not a regular file, or an error other than not existing */
  | { kind: "unreadable"; reason: string }
  /** Not looked at before the deadline, or kept changing while it was read */
  | { kind: "unknown"; reason: string };

/** project is the key the call's project had at Pre, so Post compares and delivers for that project even if the call changed it */
export type Snapshot = {
  v: 1;
  key: string;
  at: string;
  root: string;
  project: string;
  paths: Record<string, State>;
};

/** How many times a file that changes while it is read is read again before it counts as unknown */
const READS = 3;
/** How long a snapshot waits for its call to end before it is removed (a Codex command can end long after it started) */
export const SNAPSHOT_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

const dir = (...parts: string[]) => path.join(sphicaHome(), "shell-state", ...parts);
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

const signature = (st: fs.BigIntStats): Signature => ({
  dev: String(st.dev),
  ino: String(st.ino),
  size: String(st.size),
  mtimeNs: String(st.mtimeNs),
  ctimeNs: String(st.ctimeNs),
});
const same = (a: Signature, b: Signature) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs;

/**
 * The file a repository-relative path names, or null when it would leave the checkout: the path itself, or for a missing one its nearest
 * existing parent, must resolve inside the root. Node has no openat, so a process that swaps a directory for a link out and back between
 * these checks can still make one call hash a file outside; it reads nothing that process could not, and only that call is misjudged.
 */
export function inside(root: string, rel: string): string | null {
  const real = fs.realpathSync.native(root);
  const file = path.resolve(root, rel);
  if (leaves(path.relative(root, file))) return null;
  let probe = file;
  while (!fs.existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) return null;
    probe = up;
  }
  return leaves(path.relative(real, fs.realpathSync.native(probe))) ? null : file;
}

/** Whether a relative path climbs out (`..` as a whole step, not a name that starts with two dots) or is on another root */
const leaves = (rel: string) => rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);

type Cache = Map<string, { sig: Signature; hash: string }>;

/** The per-checkout cache file, named by the checkout's real path */
const cacheFile = (root: string) => dir("cache", `${sha(fs.realpathSync.native(root))}.json`);

/** The cached hashes of a checkout; a missing or unreadable cache is an empty one */
export function loadCache(root: string): Cache {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(root), "utf8")) as unknown;
    const out: Cache = new Map();
    if (raw && typeof raw === "object" && !Array.isArray(raw))
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        const e = v as { sig?: Signature; hash?: unknown };
        if (e?.sig && typeof e.hash === "string" && /^[0-9a-f]{64}$/.test(e.hash) && validSig(e.sig))
          out.set(k, { sig: e.sig, hash: e.hash });
      }
    return out;
  } catch {
    return new Map();
  }
}

const validSig = (s: unknown): s is Signature =>
  !!s &&
  typeof s === "object" &&
  ["dev", "ino", "size"].every((k) => /^\d+$/.test(String((s as Record<string, unknown>)[k]))) &&
  ["mtimeNs", "ctimeNs"].every((k) => /^-?\d+$/.test(String((s as Record<string, unknown>)[k])));

/** Writes a file whole or not at all: another process reading it sees the old content or the new, never part */
function publish(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * Saves the cache for the watched paths only, when it can: a path no longer watched (its anchor retired or moved) leaves the cache, and a
 * cache that cannot be saved only costs the next call its reads.
 */
export function saveCache(root: string, cache: Cache, watched: string[]): void {
  try {
    const kept = watched.flatMap((rel) => {
      const e = cache.get(rel);
      return e ? [[rel, e] as const] : [];
    });
    publish(cacheFile(root), JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Rebuilt by the next call that can save it
  }
}

/** The sha256 of a file read in chunks, or "deadline" when the deadline passes before it is read through */
function readHash(fd: number, deadline: number): string | "deadline" {
  const h = createHash("sha256");
  const buf = Buffer.allocUnsafe(1 << 20);
  for (
    let n = fs.readSync(fd, buf, 0, buf.length, null);
    n > 0;
    n = fs.readSync(fd, buf, 0, buf.length, null)
  ) {
    h.update(buf.subarray(0, n));
    if (Date.now() >= deadline) return "deadline";
  }
  return h.digest("hex");
}

const failed = (e: unknown): State => {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR"
    ? { kind: "missing" }
    : { kind: "unreadable", reason: String(code) };
};

/**
 * The state of a file opened at path, or "again" when it changed meanwhile. A path can be swapped for a link out between any two calls,
 * so the opened file must be the one the path now resolves to inside the checkout, with the signature it had before it was opened.
 */
function readOpened(
  root: string,
  file: string,
  fd: number,
  sig: Signature,
  deadline: number,
): State | "again" {
  const opened = fs.fstatSync(fd, { bigint: true });
  if (!same(sig, signature(opened))) return "again";
  const real = fs.realpathSync.native(file);
  if (leaves(path.relative(fs.realpathSync.native(root), real)))
    return { kind: "unreadable", reason: "outside the checkout" };
  const there = fs.lstatSync(real, { bigint: true });
  if (there.dev !== opened.dev || there.ino !== opened.ino) return "again";
  const hash = readHash(fd, deadline);
  if (hash === "deadline") return { kind: "unknown", reason: "deadline" };
  if (!same(sig, signature(fs.fstatSync(fd, { bigint: true })))) return "again";
  if (!same(sig, signature(fs.lstatSync(file, { bigint: true })))) return "again";
  return { kind: "ok", sig, hash };
}

/**
 * One file's state. The hash comes from the cache when the signature is unchanged; otherwise the file is read between two lstats, and
 * read again when they differ (it changed meanwhile), up to READS times. Every try checks the checkout's boundary again (a directory
 * may have been swapped for a link meanwhile) and the deadline.
 */
function stateOf(root: string, rel: string, cache: Cache, deadline: number): State {
  for (let i = 0; i < READS; i++) {
    if (Date.now() >= deadline) return { kind: "unknown", reason: "deadline" };
    let file: string | null;
    let before: fs.BigIntStats;
    try {
      file = inside(root, rel);
      if (!file) return { kind: "unreadable", reason: "outside the checkout" };
      before = fs.lstatSync(file, { bigint: true });
      // A link to a file inside the checkout is that file: its target's signature and content, so a retarget counts too
      if (before.isSymbolicLink()) {
        file = fs.realpathSync.native(file);
        if (leaves(path.relative(fs.realpathSync.native(root), file)))
          return { kind: "unreadable", reason: "outside the checkout" };
        before = fs.lstatSync(file, { bigint: true });
      }
    } catch (e) {
      return failed(e);
    }
    if (!before.isFile()) return { kind: "unreadable", reason: "not a regular file" };
    const sig = signature(before);
    const cached = cache.get(rel);
    if (cached && same(cached.sig, sig)) return { kind: "ok", sig, hash: cached.hash };
    let fd: number;
    try {
      fd = fs.openSync(file, "r");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      return failed(e);
    }
    let outcome: State | "again";
    try {
      outcome = readOpened(root, file, fd, sig, deadline);
    } catch (e) {
      outcome = (e as NodeJS.ErrnoException).code === "ENOENT" ? "again" : failed(e);
    } finally {
      fs.closeSync(fd);
    }
    if (outcome === "again") continue;
    if (outcome.kind === "ok") cache.set(rel, { sig, hash: outcome.hash });
    return outcome;
  }
  return { kind: "unknown", reason: "changed while read" };
}

/** Every path's state, with the paths not reached by the deadline (a time in ms) unknown */
export function takeStates(
  root: string,
  rels: string[],
  cache: Cache,
  deadline: number,
): Record<string, State> {
  // No prototype, so a file named __proto__ is a key like any other
  const out = Object.create(null) as Record<string, State>;
  for (const rel of rels) out[rel] = stateOf(root, rel, cache, deadline);
  return out;
}

/**
 * The paths whose content changed between two states (a different hash, or created, or deleted), and those that cannot be told (unknown
 * or unreadable on either side). A path in only one of them is compared with nothing and counts as unknown.
 */
export function compare(
  before: Record<string, State>,
  after: Record<string, State>,
): { changed: string[]; unknown: string[] } {
  const changed: string[] = [];
  const unknown: string[] = [];
  for (const rel of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[rel];
    const b = after[rel];
    if (
      !a ||
      !b ||
      a.kind === "unknown" ||
      a.kind === "unreadable" ||
      b.kind === "unknown" ||
      b.kind === "unreadable"
    ) {
      unknown.push(rel);
      continue;
    }
    if (a.kind === "missing" && b.kind === "missing") continue;
    if (a.kind !== b.kind || (a.kind === "ok" && b.kind === "ok" && a.hash !== b.hash)) changed.push(rel);
  }
  return { changed: changed.sort(), unknown: unknown.sort() };
}

/** The snapshot file of one call, named by a hash of who made it so no host-given id becomes a file name */
export const snapshotKey = (host: string, session: string, agent: string | null, call: string) =>
  sha(JSON.stringify([host, session, agent ?? "", call]));
const snapshotFile = (key: string) => dir("calls", `${key}.json`);

export function writeSnapshot(s: Snapshot): void {
  publish(snapshotFile(s.key), JSON.stringify(s));
}

/**
 * The snapshot a call's Pre took, removed as it is read; "expired" when it is past its life (reported, never taken for "nothing
 * changed"), and null when there is none or it does not hold together.
 */
export function takeSnapshot(key: string): Snapshot | "expired" | null {
  const file = snapshotFile(key);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  fs.rmSync(file, { force: true });
  const s = raw as Partial<Snapshot>;
  if (
    s?.v !== 1 ||
    s.key !== key ||
    typeof s.root !== "string" ||
    typeof s.project !== "string" ||
    typeof s.at !== "string" ||
    !s.paths ||
    typeof s.paths !== "object" ||
    Array.isArray(s.paths) ||
    Number.isNaN(Date.parse(s.at))
  )
    return null;
  if (Date.now() - Date.parse(s.at) > SNAPSHOT_LIFE_MS) return "expired";
  for (const v of Object.values(s.paths)) {
    const st = v as State;
    if (!st || !["ok", "missing", "unreadable", "unknown"].includes(st.kind)) return null;
    if (st.kind === "ok" && (!validSig(st.sig) || !/^[0-9a-f]{64}$/.test(st.hash))) return null;
  }
  return s as Snapshot;
}

/** Removes the snapshots older than their life and returns how many */
export function pruneSnapshots(now: number = Date.now(), deadline = Number.POSITIVE_INFINITY): number {
  let removed = 0;
  let names: string[];
  try {
    names = fs.readdirSync(dir("calls"));
  } catch {
    return 0;
  }
  for (const n of names) {
    // The rest wait for a later call: a backlog never pushes the hook past its time
    if (Date.now() >= deadline) break;
    const file = dir("calls", n);
    try {
      if (now - fs.statSync(file).mtimeMs > SNAPSHOT_LIFE_MS) {
        fs.rmSync(file, { force: true });
        removed++;
      }
    } catch {
      // Removed meanwhile by its own Post
    }
  }
  return removed;
}
