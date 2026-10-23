// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Marks that let a hook say something once: each hook call is a new process, so what was already said is kept as empty files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256 } from "./text.ts";

/** The per-user directory the marks live in (a shared /tmp holds other users' markers) */
export function marksDir(): string {
  const user = (() => {
    try {
      return os.userInfo().username;
    } catch {
      return String(process.getuid?.() ?? "user");
    }
  })();
  return path.join(os.tmpdir(), `sphica-${sha256(user).toString("hex").slice(0, 12)}`);
}

/**
 * Whether dir is this user's own: a real directory nobody else can write. Its name is known in advance, so on a shared /tmp another
 * user could make it first and place marks in it. Windows gives each user a temp directory of their own and has no uid to compare.
 */
function ours(dir: string): boolean {
  if (process.platform === "win32" || !process.getuid) return true;
  const st = fs.lstatSync(dir);
  return st.isDirectory() && st.uid === process.getuid() && (st.mode & 0o077) === 0;
}

/**
 * Marks a key once. True the first time; only an existing mark in this user's own directory counts as seen, so a directory that
 * cannot be written, or one another user made, never silences what the mark guards.
 */
export function markOnce(kind: string, key: string): boolean {
  const top = marksDir();
  const dir = path.join(top, kind);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!ours(top)) return true;
    fs.writeFileSync(path.join(dir, sha256(key).toString("hex").slice(0, 24)), "", { flag: "wx" });
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "EEXIST";
  }
}
