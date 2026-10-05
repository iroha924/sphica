/**
 * Runs a second process at an exact point of this one, for races that a retry loop would only hit by chance. The parent starts the child
 * right before its own publishing step and waits, blocked, until the child says `done` (it published) or `blocked` (it found the lock held).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type Child = Promise<{ code: number | null; out: string }>;

/** The environment of a child that must see only the temporary home (never the owner's ~/.sphica, SPHICA_HOME, or Codex home) */
export function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.SPHICA_HOME;
  delete env.SPHICA_DB;
  delete env.CODEX_HOME;
  return env;
}

/** Starts script with args and blocks until it signals into signals, at most 20 s. Returns the child's exit (killed after 30 s). */
export function runUntilSignal(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signals: string,
): Child {
  const child = spawn(process.execPath, [script, ...args, signals], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => {
    out += d;
  });
  child.stderr.on("data", (d) => {
    out += d;
  });
  // A child that hangs after signalling is killed, so the test fails with the child's output instead of only the test timeout
  const timer = setTimeout(() => child.kill(), 30_000);
  const exited: Child = new Promise((resolve) =>
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    }),
  );
  const until = Date.now() + 20_000;
  while (!fs.existsSync(path.join(signals, "done")) && !fs.existsSync(path.join(signals, "blocked"))) {
    if (Date.now() > until) {
      child.kill();
      throw new Error("the child process never reached the lock or finished");
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  return exited;
}

/** In the child: writes `blocked` the first time creating a path ending in suffix fails because it exists (another process holds it) */
export function signalWhenHeld(suffix: string, signals: string): void {
  let said = false;
  const watch = <F extends (...a: never[]) => unknown>(name: "openSync" | "writeFileSync") => {
    const real = fs[name] as unknown as F;
    (fs as unknown as Record<string, unknown>)[name] = (...a: Parameters<F>) => {
      try {
        return real(...a);
      } catch (e) {
        if (!said && (e as NodeJS.ErrnoException).code === "EEXIST" && String(a[0]).endsWith(suffix)) {
          said = true;
          fs.closeSync(fs.openSync(path.join(signals, "blocked"), "w"));
        }
        throw e;
      }
    };
  };
  watch("openSync");
  watch("writeFileSync");
}

/** In the child: says it finished */
export const signalDone = (signals: string): void =>
  fs.closeSync(fs.openSync(path.join(signals, "done"), "w"));
