// What a save learns from the working tree and git, gathered before it takes the write lock: capture and delivery wait on that lock,
// and masking a large file or asking git takes far longer than reading it. Inside the lock a file is only read again and compared.
import { locateIn, masksSymbolIn, type PathKind, pathKind, type RepoText, readRepoText } from "./anchors.ts";
import { commitHolds } from "./git.ts";

/** The reads and judgments a save makes, replaceable so a test can tell which of them run while the lock is held. */
export type Probe = {
  read: (root: string | null, rel: string) => RepoText;
  masks: (text: string | null | undefined, symbol: string) => boolean;
  locate: (text: string | null | undefined, symbol: string) => { line: number; excerpt: string } | null;
  holds: (root: string, commit: string, rel: string) => boolean;
  kind: (root: string | null, rel: string) => PathKind;
};

export const PROBE: Probe = {
  read: readRepoText,
  masks: masksSymbolIn,
  locate: locateIn,
  holds: commitHolds,
  kind: pathKind,
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
