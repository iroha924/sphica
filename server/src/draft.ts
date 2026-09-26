// Drafts: how a Skill hands a trace or harvest record to the CLI. The CLI issues an id and a file under ~/.sphica/drafts, the agent writes
// the JSON there with its file tool, and check and save take only the id. Claude Code refuses JSON in a heredoc, and a path the agent
// chose could name any file, so check and save never read a path they did not issue.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type DraftKind = "trace" | "harvest";

/** Records beyond this size are refused before parsing. */
export const DRAFT_BYTES = 1024 * 1024;
/** Drafts left by a session that never saved are removed after this long. */
const STALE_MS = 24 * 60 * 60 * 1000;
const ID = /^[A-Za-z0-9_-]{12}$/;

const draftRoot = (): string => path.join(os.homedir(), ".sphica", "drafts");

/** The id as typed, if it has the shape draft issues. */
export function draftId(input: string): string {
  if (!ID.test(input))
    throw new Error(`Not a draft id: ${JSON.stringify(input.slice(0, 40))}. Use the id draft printed`);
  return input;
}

const fileOf = (root: string, id: string, kind: DraftKind) => path.join(root, id, `${kind}.json`);

/** Issues a new draft and returns its id and the file to write. Removes stale drafts first. */
export function newDraft(kind: DraftKind, root: string = draftRoot()): { id: string; file: string } {
  fs.mkdirSync(root, { recursive: true });
  prune(root);
  const id = crypto.randomBytes(9).toString("base64url");
  // Not recursive: an id that already exists fails instead of reusing someone else's directory
  fs.mkdirSync(path.join(root, id), { mode: 0o700 });
  return { id, file: fileOf(root, id, kind) };
}

/** Reads the record of a draft this CLI issued. Links, directories, and oversized files are refused. */
export function readDraft(id: string, kind: DraftKind, root: string = draftRoot()): unknown {
  if (fs.lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`${root} is a link`);
  const dir = path.join(root, draftId(id));
  const d = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!d?.isDirectory())
    throw new Error(`No draft ${id}. Run draft again and write the record to the path it prints`);
  const file = fileOf(root, id, kind);
  if (!fs.lstatSync(file, { throwIfNoEntry: false }))
    throw new Error(`Draft ${id} has no record yet. Write it to ${file}`);
  // Open once and judge the opened file, so it cannot be swapped for a link or a larger file in between (no O_NOFOLLOW on Windows)
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (e) {
    throw new Error(`${file} is not a regular file (${(e as NodeJS.ErrnoException).code})`);
  }
  try {
    const f = fs.fstatSync(fd);
    if (!f.isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error(`${file} is not a regular file`);
    if (f.size > DRAFT_BYTES)
      throw new Error(`The record is ${f.size} bytes, over the ${DRAFT_BYTES}-byte limit`);
    const buf = Buffer.alloc(DRAFT_BYTES + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n > DRAFT_BYTES) throw new Error(`The record is over the ${DRAFT_BYTES}-byte limit`);
    try {
      return JSON.parse(buf.subarray(0, n).toString("utf8"));
    } catch (e) {
      throw new Error(`${file} is not JSON: ${(e as Error).message}`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Removes a draft after its record is saved. Returns the error text if it could not. */
export function removeDraft(id: string, root: string = draftRoot()): string | null {
  try {
    fs.rmSync(path.join(root, draftId(id)), { recursive: true, force: true });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

function prune(root: string): void {
  const now = Date.now();
  for (const name of fs.readdirSync(root)) {
    if (!ID.test(name)) continue;
    const dir = path.join(root, name);
    const s = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (s?.isDirectory() && now - s.mtimeMs > STALE_MS) fs.rmSync(dir, { recursive: true, force: true });
  }
}
