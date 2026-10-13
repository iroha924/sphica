// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Marks that let a hook say something once: each hook call is a new process, so what was already said is kept as empty files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sha256 } from "./text.ts";

/**
 * Marks a key once, in a per-user directory (a shared /tmp holds other users' markers). True the first time; only an existing mark
 * counts as seen, so a directory that cannot be written never silences what the mark guards.
 */
export function markOnce(kind: string, key: string): boolean {
  const user = (() => {
    try {
      return os.userInfo().username;
    } catch {
      return String(process.getuid?.() ?? "user");
    }
  })();
  const dir = path.join(os.tmpdir(), `sphica-${sha256(user).toString("hex").slice(0, 12)}`, kind);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, sha256(key).toString("hex").slice(0, 24)), "", { flag: "wx" });
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "EEXIST";
  }
}
