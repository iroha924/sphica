/**
 * A lock file only its holder removes, and a file replace that never leaves a half-written file. Guaranteed on local file systems only:
 * a network file system may not honor exclusive create.
 */
import fs from "node:fs";

const WAIT_MS = 5_000;
const POLL_MS = 40;
const RENAME_TRIES = 5;

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Why a waiter gave up: the holder's pid, and whether that pid is gone (only ESRCH says so; any other answer leaves it unknown). */
function heldBy(lock: string): string {
  let holder = 0;
  try {
    holder = Number(fs.readFileSync(lock, "utf8").trim()) || 0;
  } catch {
    // released or unreadable since the last try
  }
  if (holder <= 0) return `${lock} is held by another process. Run this again when it finishes.`;
  try {
    process.kill(holder, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH")
      return `${lock} is held by process ${holder}, which is not running. If no sphica init is running, delete ${lock} and run this again.`;
  }
  return `${lock} is held by process ${holder}. Run this again when it finishes.`;
}

/**
 * Runs fn while holding lock, created exclusively with this pid inside. Waits up to waitMs for a holder, then fails without running fn.
 * **A lock is never taken over**, however old or whoever held it: a holder that resumes, or two waiters breaking the same stale lock, would
 * both write. A lock left by a killed process stays until someone deletes it, and the timeout says so.
 */
export function withFileLock<T>(lock: string, fn: () => T, waitMs = WAIT_MS): T {
  const mine = String(process.pid);
  const until = performance.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(lock, mine, { flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (performance.now() >= until) throw new Error(heldBy(lock));
    sleep(POLL_MS);
  }
  try {
    return fn();
  } finally {
    try {
      if (fs.readFileSync(lock, "utf8") === mine) fs.rmSync(lock, { force: true });
    } catch {
      // already gone
    }
  }
}

/**
 * Replaces file with text: written and flushed to a temporary file beside it, then renamed over it, so a reader sees the old or the new
 * file whole. Windows refuses the rename while a scanner or reader has the file open, so those errors are retried a few times. On failure
 * the old file is left as it was and the temporary file is removed.
 */
export function replaceFile(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    for (let attempt = 1; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (attempt >= RENAME_TRIES || !(code === "EPERM" || code === "EACCES" || code === "EBUSY")) throw e;
        sleep(50 * attempt);
      }
    }
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
