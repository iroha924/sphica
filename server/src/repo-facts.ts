// What a save learns from the working tree and git, gathered before it takes the write lock: capture and delivery wait on that lock,
// and masking a large file or asking git takes far longer than reading it. Inside the lock a file is only read again and compared.
import { locateIn, masksSymbolIn, type PathKind, pathKind, type RepoText, readRepoText } from "./anchors.ts";
import { commitHolds, repoFiles } from "./git.ts";

/** The reads and judgments a save makes, replaceable so a test can tell which of them run while the lock is held. */
export type Probe = {
  read: (root: string | null, rel: string) => RepoText;
  masks: (text: string | null | undefined, symbol: string) => boolean;
  locate: (text: string | null | undefined, symbol: string) => { line: number; excerpt: string } | null;
  holds: (root: string, commit: string, rel: string) => boolean;
  kind: (root: string | null, rel: string) => PathKind;
  files: (root: string) => string[] | null;
};

export const PROBE: Probe = {
  read: readRepoText,
  masks: masksSymbolIn,
  locate: locateIn,
  holds: commitHolds,
  kind: pathKind,
  files: repoFiles,
};

type FileFacts = {
  read: RepoText;
  kind?: PathKind;
  masks: Map<string, boolean>;
  at: Map<string, { line: number; excerpt: string } | null>;
};

export type RepoFacts = {
  root: string | null;
  probe: Probe;
  files: Map<string, FileFacts>;
  commits: Map<string, boolean>;
  /** The repository's file list, read once when some anchor path is gone; undefined until then, null when git could not list it */
  listing?: string[] | null;
};

export const repoFacts = (root: string | null, probe: Probe = PROBE): RepoFacts => ({
  root,
  probe,
  files: new Map(),
  commits: new Map(),
});

function file(f: RepoFacts, rel: string): FileFacts {
  let got = f.files.get(rel);
  if (!got) {
    got = { read: f.probe.read(f.root, rel), masks: new Map(), at: new Map() };
    f.files.set(rel, got);
  }
  return got;
}

/** Whether mask() hides the symbol in the file as it was read. */
export function symbolMasked(f: RepoFacts, rel: string, symbol: string): boolean {
  const got = file(f, rel);
  let v = got.masks.get(symbol);
  if (v === undefined) {
    v = f.probe.masks(got.read.text, symbol);
    got.masks.set(symbol, v);
  }
  return v;
}

/** Where the symbol is in the file as it was read. */
export function symbolAt(
  f: RepoFacts,
  rel: string,
  symbol: string,
): { line: number; excerpt: string } | null {
  if (!f.root) return null;
  const got = file(f, rel);
  if (!got.at.has(symbol)) got.at.set(symbol, f.probe.locate(got.read.text, symbol));
  return got.at.get(symbol) ?? null;
}

/** What the path is in the working tree as it was read. */
export function kindOf(f: RepoFacts, rel: string): PathKind {
  const got = file(f, rel);
  got.kind ??= f.probe.kind(f.root, rel);
  return got.kind;
}

/** Lists the repository's files for near-path suggestions, once, when the path is gone. Call before the write lock. */
export function listFilesIfGone(f: RepoFacts, rel: string): void {
  if (f.root && f.listing === undefined && kindOf(f, rel) === "gone") f.listing = f.probe.files(f.root);
}

/** Up to 3 listed files near rel: the same file name first, then the smallest edit distance. Undefined when the list was not read. */
export function nearPaths(f: RepoFacts, rel: string): string[] | undefined {
  if (!f.listing) return undefined;
  const name = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const limit = Math.max(3, Math.floor(rel.length / 2));
  return f.listing
    .map((p) => ({ p, same: name(p) === name(rel), d: distance(p, rel, limit) }))
    .filter((x) => x.same || x.d <= limit)
    .sort((a, b) => Number(b.same) - Number(a.same) || a.d - b.d || a.p.localeCompare(b.p))
    .slice(0, 3)
    .map((x) => x.p);
}

/** Levenshtein distance, cut short once it is sure to exceed limit (returns limit + 1 then). */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let least = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      row.push(v);
      least = Math.min(least, v);
    }
    if (least > limit) return limit + 1;
    prev = row;
  }
  return prev[b.length] ?? limit + 1;
}

/** Whether the file was read as text and the symbol is not in it; false when it could not be checked. */
export function symbolMissing(f: RepoFacts, rel: string, symbol: string): boolean {
  return Boolean(f.root) && typeof file(f, rel).read.text === "string" && symbolAt(f, rel, symbol) === null;
}

/** Whether the repository has the commit and it holds the path. A commit's content never changes, so this is never asked again. */
export function commitHeld(f: RepoFacts, commit: string, rel: string): boolean {
  if (!f.root) return false;
  const key = `${commit}\0${rel}`;
  let v = f.commits.get(key);
  if (v === undefined) {
    v = f.probe.holds(f.root, commit, rel);
    f.commits.set(key, v);
  }
  return v;
}

/** Reads the file again and forgets what was judged on it when its content changed, so the next judgment sees the file as it is now. */
export function refresh(f: RepoFacts, rel: string): void {
  const read = f.probe.read(f.root, rel);
  if (f.files.get(rel)?.read.hash !== read.hash) f.files.set(rel, { read, masks: new Map(), at: new Map() });
}
