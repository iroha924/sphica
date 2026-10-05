/**
 * A lock file only its holder removes, and a file replace that never leaves a half-written file. Guaranteed on local file systems only:
 * a network file system may not honor exclusive create.
 */
import fs from "node:fs";

const WAIT_MS = 5_000;
const POLL_MS = 40;
const TRIES = 5;

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Runs op, retrying the errors Windows gives while a scanner or a reader has the file open */
function retryBusy(op: () => void): void {
  for (let attempt = 1; ; attempt++) {
    try {
      op();
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= TRIES || !(code === "EPERM" || code === "EACCES" || code === "EBUSY")) throw e;
      sleep(50 * attempt);
    }
  }
}

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
    let fd: number | null = null;
    let refused: unknown = null;
    try {
      fd = fs.openSync(lock, "wx");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // Windows refuses a create with EPERM while the last holder's delete is pending, so a busy answer is waited out like a held lock
      if (code === "EPERM" || code === "EACCES" || code === "EBUSY") refused = e;
      else if (code !== "EEXIST") throw e;
    }
    if (fd !== null) {
      // The create succeeded, so the file is this call's even if the pid never gets into it or the descriptor fails to close
      try {
        try {
          fs.writeFileSync(fd, mine);
        } finally {
          fs.closeSync(fd);
        }
      } catch (e) {
        try {
          retryBusy(() => fs.rmSync(lock, { force: true }));
        } catch {
          // reported by the next run's timeout; the first error says why
        }
        throw e;
      }
      break;
    }
    if (performance.now() >= until) throw refused ?? new Error(heldBy(lock));
    sleep(POLL_MS);
  }
  let result: T;
  try {
    result = fn();
  } catch (e) {
    // fn's own error is the one to report; a lock that cannot be removed then shows as held on the next run
    try {
      release(lock, mine);
    } catch {
      // reported by the next run's timeout
    }
    throw e;
  }
  release(lock, mine);
  return result;
}

/** Removes lock if it still holds mine. A remove that keeps failing throws, so a lock left behind is never silent. */
function release(lock: string, mine: string): void {
  const cannot = (e: unknown) =>
    new Error(
      `The work finished, but Sphica could not remove ${lock} (${(e as Error).message}). Delete it before running this again.`,
    );
  let held = "";
  try {
    retryBusy(() => {
      held = fs.readFileSync(lock, "utf8");
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cannot(e);
  }
  if (held !== mine) return;
  try {
    retryBusy(() => fs.rmSync(lock, { force: true }));
  } catch (e) {
    throw cannot(e);
  }
}

/**
 * Replaces file with text: written and flushed to a temporary file beside it, then renamed over it, so a reader sees the old or the new
 * file whole. Windows refuses the rename while a scanner or reader has the file open, so those errors are retried a few times. On failure
 * the old file is left as it was, and the temporary file is removed unless its removal keeps failing too.
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
    retryBusy(() => fs.renameSync(tmp, file));
  } catch (e) {
    try {
      retryBusy(() => fs.rmSync(tmp, { force: true }));
    } catch {
      // the first error says why the replace failed
    }
    throw e;
  }
}
