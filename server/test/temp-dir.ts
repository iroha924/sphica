// Temp directories a test file makes and the process removes when it exits, however the tests ended. sql:reach fails a run that leaves
// anything in its temp directory, so a directory made outside a test's own try/finally comes from here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const made: string[] = [];
process.on("exit", () => {
  for (const dir of made) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A directory a test locked and never reopened stays; sql:reach then names it
    }
  }
});

/** A new directory under os.tmpdir(), removed when this process exits */
export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** The temp directory variables for a child whose environment is built from scratch, so it writes under the same directory */
export function tmpEnv(): { TMPDIR: string; TMP: string; TEMP: string } {
  const dir = os.tmpdir();
  return { TMPDIR: dir, TMP: dir, TEMP: dir };
}

/**
 * Points this process's os.tmpdir() at a directory of its own, removed at exit: for code under test that keeps state in the shared
 * temp directory, such as the delivery hook's once-per-session marks
 */
export function ownTmpdir(prefix: string): string {
  const dir = fs.realpathSync(tempDir(prefix));
  process.env.TMPDIR = dir;
  process.env.TMP = dir;
  process.env.TEMP = dir;
  return dir;
}
