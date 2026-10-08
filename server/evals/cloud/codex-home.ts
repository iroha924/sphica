// The CODEX_HOME the evaluation starts Codex with, for a run under test and for the grader alike: a link to the owner's login and the
// owner's model and effort, nothing else, so the owner's hooks, plugins, rules, and MCP servers reach neither. Also each run's directory
// and the git directory the runners read its checkout through.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The lines of the owner's Codex config that an isolated CODEX_HOME keeps: the model and the effort. */
export function ownerCodexSettings(): string {
  return fs
    .readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8")
    .split("\n")
    .filter((l) => /^(model|model_reasoning_effort)\s*=/.test(l))
    .join("\n");
}

export function isolatedCodexHome(
  codexHome: string,
  extraConfig = "",
  settings = ownerCodexSettings(),
): void {
  fs.mkdirSync(codexHome, { recursive: true });
  fs.symlinkSync(path.join(os.homedir(), ".codex", "auth.json"), path.join(codexHome, "auth.json"));
  fs.writeFileSync(path.join(codexHome, "config.toml"), `${settings}\n${extraConfig}`);
}

/**
 * The permission profile a CODEX_HOME config selects: `:read-only` or `:workspace`, with every path in `deny` unreadable to the commands
 * the model runs (Codex itself still reads its login). A parent that is denied cannot be read under, so only what must stay hidden is
 * denied. No `--sandbox` goes with it: that flag would select the old sandbox settings instead.
 */
export function codexProfile(base: ":read-only" | ":workspace", deny: string[]): string {
  const lines = deny.map((d) => `${JSON.stringify(d)} = "deny"`).join("\n");
  return `\ndefault_permissions = "eval"\n[permissions.eval]\nextends = ${JSON.stringify(base)}\n[permissions.eval.filesystem]\n${lines}\n`;
}

/**
 * Settings an administrator set for every Codex on this machine. They can replace the profile a run selects, and its denies with it
 * (a `sandbox_mode` in any loaded config selects the old sandbox), so a fenced Codex does not start while any is present.
 */
export function managedCodexSettings(
  roots = { etc: "/etc/codex", prefs: "/Library/Managed Preferences" },
): string[] {
  const found = ["requirements.toml", "config.toml"]
    .map((f) => path.join(roots.etc, f))
    .filter((f) => fs.existsSync(f));
  const visit = (dir: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.name.startsWith("com.openai.codex")) found.push(full);
      else if (e.isDirectory() && depth < 2) visit(full, depth + 1);
    }
  };
  visit(roots.prefs, 0);
  return found;
}

/**
 * An isolated CODEX_HOME whose config selects the profile, with the run's own link to the login denied too. The profile goes before
 * `extraConfig`: default_permissions is a top-level key, and after a table TOML would read it as part of that table.
 */
export function fencedCodexHome(
  codexHome: string,
  o: {
    base: ":read-only" | ":workspace";
    deny: string[];
    extraConfig?: string;
    settings?: string;
    managed?: string[];
  },
): { profile: string; denied: string[] } {
  const managed = o.managed ?? managedCodexSettings();
  if (managed.length)
    throw new Error(`administrator settings for Codex can replace the run's profile: ${managed.join(", ")}`);
  const denied = [...o.deny, path.join(codexHome, "auth.json")];
  const profile = codexProfile(o.base, denied);
  isolatedCodexHome(codexHome, `${profile}${o.extraConfig ?? ""}`, o.settings);
  return { profile, denied };
}

/**
 * The profile as one digest that names each denied place by its role, so runs on other machines or in other directories under the same
 * policy compare equal. `roles` maps a placeholder to the path it stands for; longer paths are replaced first.
 */
export function fenceDigest(profile: string, roles: Record<string, string>): string {
  let text = profile;
  for (const [role, p] of Object.entries(roles).sort((a, b) => b[1].length - a[1].length))
    text = text.split(p).join(role);
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** Where every evaluation output lives; the fenced Codex runs and graders are denied all of it */
export function evalCache(home = os.homedir()): string {
  const cache = path.join(home, ".cache", "sphica-eval");
  fs.mkdirSync(cache, { recursive: true });
  return fs.realpathSync(cache);
}

/** `p` resolved through links, or an error when it is not inside `root` (compared by path components, not by string prefix). */
export function requireInside(root: string, p: string, what: string): string {
  const real = fs.realpathSync(p);
  const rel = path.relative(root, real);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error(`${what} must be inside ${root}, which fenced Codex runs cannot read: ${real}`);
  return real;
}

/**
 * One lock for every process that starts a fenced Codex: two at once could read each other's checkout in the temp directory, whatever
 * output directory each was given. A lock left by a process that died is not taken over: whoever removes it checks that it is gone.
 */
export function codexLock(cache: string): () => void {
  const file = path.join(cache, "codex.lock");
  let fd: number;
  try {
    fd = fs.openSync(file, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    let held = "";
    try {
      held = fs.readFileSync(file, "utf8").trim();
    } catch {}
    throw new Error(
      `another fenced Codex evaluation holds ${file} (${held}); remove it only once that process is gone`,
    );
  }
  fs.writeSync(fd, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
  fs.closeSync(fd);
  return () => fs.rmSync(file, { force: true });
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
