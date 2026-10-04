// The CODEX_HOME the evaluation starts Codex with, for a run under test and for the grader alike: a link to the owner's login and the
// owner's model and effort, nothing else, so the owner's hooks, plugins, rules, and MCP servers reach neither. Also each run's directory
// and the git directory the runners read its checkout through.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function isolatedCodexHome(codexHome: string, extraConfig = ""): void {
  const owner = path.join(os.homedir(), ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.symlinkSync(path.join(owner, "auth.json"), path.join(codexHome, "auth.json"));
  const settings = fs
    .readFileSync(path.join(owner, "config.toml"), "utf8")
    .split("\n")
    .filter((l) => /^(model|model_reasoning_effort)\s*=/.test(l))
    .join("\n");
  fs.writeFileSync(path.join(codexHome, "config.toml"), `${settings}\n${extraConfig}`);
}

/** The model and effort a run's CODEX_HOME starts Codex with, as one label ("gpt-6.1-sol, medium"); null when the config names no model. */
export function codexModelOf(codexHome: string): string | null {
  const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  const value = (key: string) => new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(config)?.[1];
  const model = value("model");
  return model ? [model, value("model_reasoning_effort")].filter(Boolean).join(", ") : null;
}

// Parallel runs of one task and condition can start in the same millisecond: a random suffix tells them apart, and the directory is
// created without recursive so a collision fails instead of two runs sharing one directory
export function claimRunDir(out: string, prefix: string, now = new Date()): { run: string; dir: string } {
  const run = `${prefix}-${now.toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const dir = path.join(out, run);
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(dir);
  return { run, dir };
}

/** A run's checkout and the git directory outside it that the runner looks at it through. */
export type Checkout = { work: string; git: string };

/**
 * Git on a checkout through its pinned git directory, with no system or global config: the checkout's own .git is the agent's to rewrite,
 * and a core.fsmonitor or a filter set there would run a command in this process, outside the agent's sandbox.
 */
export function checkoutGit(c: Checkout, args: string[]): string {
  return execFileSync("git", [`--git-dir=${c.git}`, `--work-tree=${c.work}`, "-C", c.work, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull },
  });
}

/** Copies the checkout's git directory to `git` before the agent starts; no hardlinks, since the agent can write the checkout's objects. */
export function pinCheckout(work: string, git: string): Checkout {
  execFileSync("git", ["clone", "-q", "--bare", "--no-local", work, git]);
  const c = { work, git };
  checkoutGit(c, ["reset", "-q"]);
  return c;
}
