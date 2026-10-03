// Versions of the npm package and the distributed plugin, and where each one runs from.
//
// Claude Code and Codex both copy the plugin to `<cache>/<marketplace>/sphica/<version>/`
// and start MCP from there. Only Claude Code with a directory marketplace (observed in 2.1.268) and
// `--plugin-dir` read the working tree directly.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { caution, faint, type Mark, mark, pad, width } from "./panel.ts";

const MANIFEST = path.join(".claude-plugin", "plugin.json");
const PACKAGE = "package.json";

/** The version when root is a sphica package. null for a removed cache or another plugin. */
export function versionAt(root: string): string | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return m.name === "sphica" && typeof m.version === "string" ? m.version : null;
  } catch {
    return null;
  }
}

/** The version when root is the sphica npm package. It can move independently of the plugin channel version. */
export function packageVersionAt(root: string): string | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, PACKAGE), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return m.name === "sphica" && typeof m.version === "string" ? m.version : null;
  } catch {
    return null;
  }
}

// The bundle runs from <root>/dist/*.js; tests and `node src/*.ts` run from server/src/.
const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT =
  [path.join(here, ".."), path.join(here, "..", "..", "plugin")].find((r) => versionAt(r) !== null) ??
  path.join(here, "..");

/**
 * Whether the directory it started from is still a live package.
 * Codex deletes the old version's cache immediately on update; Claude Code keeps it for about 14 days with `.orphaned_at`.
 * **`.orphaned_at` is only a hint.** The official docs describe the orphaned state; the file name is observed.
 * Its absence is not proof of being current.
 */
function rootState(root: string): "gone" | "orphaned" | "ok" {
  if (!fs.existsSync(path.join(root, MANIFEST))) return "gone";
  if (fs.existsSync(path.join(root, ".orphaned_at"))) return "orphaned";
  return "ok";
}

/** Keeps 0.10.9 < 0.10.18 from flipping under string comparison. */
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// Markers Claude Code adds to the cache root (`.orphaned_at` on replaced versions, `.in_use/<pid>` on versions in use).
// **Listed by name.** Skipping everything starting with a dot would silently hide package differences such as `.mcp.json`.
const HOST_MARKS = new Set([".orphaned_at", ".in_use"]);

/**
 * Files the bundle creates and npm ships but git does not track.
 * **List files, not only directories** — forgetting the bundled notices made a healthy install show
 * "same version, different contents" (measured: comparing a package with itself differed only in THIRD_PARTY_NOTICES.md).
 */
const GENERATED = /^(dist|db)\/|^THIRD_PARTY_NOTICES\.md$|^README\.md$/;

/** Files the OS and editors create. Not tracked, and not packed by npm. */
const JUNK = /^\.DS_Store$|\.sw[a-p]$|~$/;

/** Package files under root. Marker directories are not entered (they vanish if a session ends during the scan). */
function distributed(root: string, tracked: boolean): Map<string, string> {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (dir === root && HOST_MARKS.has(e.name)) return [];
      const abs = path.join(dir, e.name);
      return e.isDirectory() ? walk(abs) : e.isFile() ? [path.relative(root, abs)] : [];
    });
  // The repository ships what git tracks plus what the bundle creates.
  // Ignored files and editor temporary files are not counted as differences.
  let rels: string[] | undefined;
  if (tracked) {
    try {
      rels = execFileSync("git", ["-C", root, "ls-files", "-z"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split("\0")
        .filter((rel) => rel && fs.existsSync(path.join(root, rel)));
      // **Generated files are not tracked by git, but npm files ships them** (plugin/dist and plugin/db in .gitignore).
      // Comparing only tracked files would count everything installed but untracked as a difference and make a healthy install look broken.
      rels = [...rels, ...walk(root).filter((rel) => GENERATED.test(rel) && !JUNK.test(path.basename(rel)))];
    } catch {
      // Outside git (a repository taken from a tarball, for example) everything counts.
    }
  }
  rels ??= walk(root);
  return new Map(
    rels.filter((rel) => path.basename(rel) !== ".DS_Store").map((rel) => [rel, path.join(root, rel)]),
  );
}

/**
 * Files whose contents differ between two roots. **mtime is ignored** — rebundling the same content would be a false alarm.
 * `tracked` is set when a is the repository's working tree.
 */
export function differingFiles(a: string, b: string, { tracked = false } = {}): string[] {
  const x = distributed(a, tracked);
  const y = distributed(b, false);
  return [...new Set([...x.keys(), ...y.keys()])]
    .filter((rel) => {
      const p = x.get(rel);
      const q = y.get(rel);
      return !p || !q || !fs.readFileSync(p).equals(fs.readFileSync(q));
    })
    .sort();
}

export type McpProcess = { pid: number; started: Date; script: string };

/** Picks only `node …/dist/mcp.js` from the output of `LC_ALL=C ps -o pid=,lstart=,args=`. */
export function parsePs(out: string): McpProcess[] {
  const procs: McpProcess[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
    const script = m?.[3]?.match(/(?:^|\/)node\s+(.*\/dist\/mcp\.js)\s*$/)?.[1];
    if (m && script) procs.push({ pid: Number(m[1]), started: new Date(m[2] ?? ""), script });
  }
  return procs;
}

/**
 * Codex starts `./dist/mcp.js` with the plugin root as cwd, so relative paths are resolved against cwd.
 * **A cache recreated at the same path is not read as alive.** The process still holds the removed old directory
 * as its cwd, so Linux shows a ` (deleted)` marker and macOS an inode mismatch.
 */
function cwdOf(pid: number): { dir: string; replaced: boolean } | null {
  try {
    const link = fs.readlinkSync(`/proc/${pid}/cwd`);
    return { dir: link.replace(/ \(deleted\)$/, ""), replaced: link.endsWith(" (deleted)") };
  } catch {
    // No /proc (macOS).
  }
  try {
    const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    const field = (k: string) =>
      out
        .split("\n")
        .find((l) => l.startsWith(k))
        ?.slice(1);
    const dir = field("n");
    if (!dir) return null;
    let now: string | undefined;
    try {
      now = String(fs.statSync(dir).ino);
    } catch {
      // If it is gone, rootState() catches it.
    }
    const held = field("i");
    return { dir, replaced: now !== undefined && held !== undefined && now !== held };
  } catch {
    return null;
  }
}

const CACHED = /\/plugins\/cache\/[^/]+\/sphica\/[^/]+$/;

export type Install = { version: string | null; packageVersion?: string | null; root: string };
/** Something doctor could not inspect, and why. Kept apart from "not installed". */
type Unknown = { unknown: string };
type Running = {
  pid: number;
  started: Date;
  root: string | null;
  version: string | null;
  /** Started from a path that was recreated and runs on the contents of the removed old directory. */
  replaced?: boolean;
};

export type Seen = {
  /** The working tree's plugin/. Visible only when cwd or the CLI location is the sphica repository. */
  repository: Install | null;
  cli: Install;
  /**
   * The CLI installed with `npm i -g`. It can stay old apart from the running one (it updates separately from the plugin cache).
   * null when not installed.
   */
  global: Install | null | Unknown;
  /** null when not installed. */
  claude: Install | null | Unknown;
  codex: Install[];
  codexCache: string;
  running: Running[] | Unknown;
};

const unknown = (i: unknown): i is Unknown => typeof i === "object" && i !== null && "unknown" in i;

/**
 * npm's own CLI script next to the running node, started through process.execPath: on Windows `npm` is a .cmd shim, which
 * execFile cannot start. null when node's layout has none there.
 */
export function npmCli(execPath: string, platform: NodeJS.Platform): string | null {
  const dir = path.dirname(execPath);
  const at =
    platform === "win32"
      ? path.join(dir, "node_modules", "npm", "bin", "npm-cli.js")
      : path.resolve(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  return fs.existsSync(at) ? at : null;
}

/** The first `<name>.exe` on a Windows PATH. A .cmd of the same name is skipped: execFile cannot start it. */
export function findExe(name: string, pathEnv: string, platform: NodeJS.Platform): string | null {
  const sep = platform === "win32" ? ";" : path.delimiter;
  for (const dir of pathEnv.split(sep).filter(Boolean)) {
    const at = path.join(dir, `${name}.exe`);
    if (fs.existsSync(at)) return at;
  }
  return null;
}

/** Observations that run external commands live here. report() decides; tests build Seen and pass it. */
export function observe(
  cwdRoot: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Seen {
  const install = (root: string): Install => ({
    version: versionAt(root),
    packageVersion: packageVersionAt(root),
    root,
  });

  const repository =
    [path.dirname(ROOT), cwdRoot]
      .filter((d) => fs.existsSync(path.join(d, ".claude-plugin", "marketplace.json")))
      .map((d) => install(path.join(d, "plugin")))
      .find((r) => r.version !== null) ?? null;

  let claude: Seen["claude"];
  const claudeExe = platform === "win32" ? findExe("claude", env.PATH ?? env.Path ?? "", platform) : "claude";
  if (!claudeExe) claude = { unknown: "no claude.exe on PATH (an npm install puts claude.cmd there)" };
  else
    try {
      const list = JSON.parse(
        execFileSync(claudeExe, ["plugin", "list", "--json"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 30_000,
        }),
      ) as { id: string; version?: string; installPath?: string; scope?: string }[];
      // The same id appears per scope. Only the user install is checked, matching the README install steps and `claude plugin update`
      // below (user scope by default). project / local installs only affect sessions elsewhere.
      const m = list.find((p) => p.id.startsWith("sphica@") && p.scope === "user");
      claude = m?.installPath ? { version: m.version ?? null, root: m.installPath } : null;
    } catch {
      claude = { unknown: "claude plugin list --json failed" };
    }

  // `codex plugin list --json` takes 7 seconds and cannot tell whether the version comes from the cache or the source.
  // Read the cache location directly.
  // lsof returns paths with symlinks resolved, so the side matched with the running MCP resolves them too.
  // Resolve on the CODEX_HOME side so it works even when the whole cache is gone.
  let codexHome = env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  try {
    codexHome = fs.realpathSync(codexHome);
  } catch {
    // When missing, the scan below is empty and reports "not found".
  }
  const codexCache = path.join(codexHome, "plugins", "cache");
  const codex: Install[] = [];
  for (const market of safeDirs(codexCache)) {
    for (const v of safeDirs(path.join(codexCache, market, "sphica"))) {
      codex.push(install(path.join(codexCache, market, "sphica", v)));
    }
  }

  let running: Seen["running"];
  if (platform === "win32") running = { unknown: "not checked on Windows" };
  else
    try {
      const out = execFileSync("ps", ["-U", String(process.getuid?.()), "-o", "pid=,lstart=,args="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, LC_ALL: "C" },
        timeout: 10_000,
      });
      running = parsePs(out).flatMap((p): Running[] => {
        const cwd = path.isAbsolute(p.script) ? { dir: "/", replaced: false } : cwdOf(p.pid);
        if (!cwd) return [{ pid: p.pid, started: p.started, root: null, version: null }];
        const root = path.dirname(path.dirname(path.resolve(cwd.dir, p.script)));
        const cached = CACHED.test(root);
        const now = versionAt(root);
        // Skip dist/mcp.js of other plugins. A removed cache has no readable manifest, so it is recognized by its path.
        if (now === null && !cached) return [];
        // Shows the version at start. For removed or recreated caches, the directory name is that version. The working tree
        // changes after start, so when the bundle or manifest is newer than the start time, it cannot claim the current version.
        let version = cwd.replaced || now === null ? (cached ? path.basename(root) : null) : now;
        if (!cached && version !== null) {
          try {
            const touched = Math.max(
              ...[path.join("dist", "mcp.js"), MANIFEST].map((f) => fs.statSync(path.join(root, f)).mtimeMs),
            );
            if (touched > p.started.getTime()) version = null;
          } catch {
            version = null;
          }
        }
        return [{ pid: p.pid, started: p.started, root, version, replaced: cwd.replaced }];
      });
    } catch {
      running = { unknown: "ps failed" };
    }

  // **This is a separate path from the plugin cache.** `claude plugin update` does not update it, and on the day the database
  // revision goes up, only the old CLI fails with "expects revision N".
  let global: Seen["global"] = null;
  const cli = npmCli(process.execPath, platform);
  if (!cli && platform === "win32") global = { unknown: "no npm CLI next to node" };
  else
    try {
      const [cmd, args] = cli ? [process.execPath, [cli, "root", "-g"]] : ["npm", ["root", "-g"]];
      const out = execFileSync(cmd, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      });
      const at = path.join(out.trim(), "sphica");
      if (fs.existsSync(at)) global = install(at);
    } catch {
      global = { unknown: "npm root -g failed" };
    }

  return { repository, cli: install(ROOT), global, claude, codex, codexCache, running };
}

function safeDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// The official docs do not say `plugin update` refetches the marketplace, so it is refetched first.
// MCP servers still running after the update keep the old path. In an interactive Claude Code session
// /reload-plugins moves them to the new path (official plugins-reference). Codex needs to be reopened.
/** How to fix an old install: the command to run and what to do after it (after) */
const UPDATE = {
  global: { who: "npm CLI", command: "npm i -g sphica@<version>", after: null },
  claude: {
    who: "Claude Code",
    command: "claude plugin marketplace update sphica && claude plugin update sphica@sphica",
    after: "run /reload-plugins in open sessions",
  },
  codex: {
    who: "Codex",
    command: "codex plugin marketplace upgrade sphica && codex plugin add sphica@sphica",
    after: "reopen Codex",
  },
} as const;

export type Update = { who: string; command: string; after: string | null };

/** A note at the end of the update steps: what decides the delivered contents */
export const UPDATE_NOTE =
  "Each host's marketplace source decides what is delivered. When it pulls from GitHub, unpushed changes do not arrive";
const RELOAD = { claude: "/reload-plugins or a new session", codex: "reopening Codex" };

/**
 * The plugin section of doctor. **The baseline is the repository** (or each host's installed version when absent); the running
 * CLI is never the baseline. Using the cached CLI on an old session's PATH as the baseline would call
 * the newer one "old".
 */
export function report(s: Seen, now = new Date()): { lines: string[]; issues: string[]; updates: Update[] } {
  const lines: string[] = [];
  const issues: string[] = [];
  const todo = new Set<keyof typeof UPDATE>();
  const home = os.homedir();
  const short = (p: string) => (p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
  const say = (m: Mark, label: string, text: string) => {
    if (m === "warn" || m === "fail") issues.push(label);
    lines.push(`  ${mark(m)} ${pad(label, 19)}${text}`);
  };
  // The reason goes on the next line aligned with the path column, not after the path (with a long path it wraps off the right edge)
  const row = (
    label: string,
    i: Install | null,
    note?: string,
    aside = "",
    m: Mark = note ? "warn" : "ok",
  ) => {
    const version = pad(i?.version ?? "unknown", 9);
    const indent = " ".repeat(2 + 2 + width(pad(label, 19)) + width(version));
    say(
      m,
      label,
      `${version}${i ? faint(short(i.root)) : ""}${faint(aside)}${note ? `\n${indent}${caution(note)}` : ""}`,
    );
  };
  const packageInstall = (i: Install): Install => ({ version: i.packageVersion ?? null, root: i.root });
  const packageBase = packageInstall(s.repository ?? s.cli);
  const packageAgainst = (i: Install): { note?: string; update?: boolean } => {
    const candidate = packageInstall(i);
    if (!candidate.version || !packageBase.version) return {};
    const c = compareVersions(candidate.version, packageBase.version);
    if (c < 0)
      return { note: `older than the repository npm package (${packageBase.version})`, update: true };
    if (c > 0 && s.repository) {
      return { note: `newer than the repository npm package (${packageBase.version}); the checkout is old` };
    }
    return {};
  };

  lines.push("npm package versions");
  if (s.repository) row("repository", packageInstall(s.repository));
  row("Running CLI", packageInstall(s.cli), packageAgainst(s.cli).note);
  if (unknown(s.global)) say("none", "npm i -g CLI", `unknown (${s.global.unknown})`);
  else if (s.global && path.resolve(s.global.root) !== path.resolve(s.cli.root)) {
    const { note, update } = packageAgainst(s.global);
    if (update) todo.add("global");
    row("npm i -g CLI", packageInstall(s.global), note);
  }
  lines.push("");
  // **Usually there is no repository.** Users who installed from npm have no clone, and if comparison stopped there
  // nobody would report the CLI and plugin drifting apart after separate updates
  // (the CLI updates with `npm i -g`, the plugin with `claude plugin update`).
  const base = s.repository ?? (s.cli.version ? s.cli : null);
  const baseName = s.repository ? "repository" : "this CLI";

  /**
   * Differences from the baseline, and whether a host update fixes them. At the same version the contents are compared too (so changes made without a version bump are caught).
   * When the install is newer, or the same version with different contents, updating changes nothing, so no steps are shown
   * (the cache is copied again only when the version changes).
   */
  const against = (i: Install): { note?: string; update?: boolean } => {
    if (!fs.existsSync(i.root))
      return { note: "The install directory is gone. Skill paths are invalid too", update: true };
    if (!base?.version || !i.version) return {};
    const c = compareVersions(i.version, base.version);
    if (c < 0) return { note: `older than ${baseName} (${base.version})`, update: true };
    if (c > 0) {
      return {
        note: s.repository
          ? `newer than the repository (${base.version}); the repository checkout is old`
          : `newer than this CLI (${base.version}). Match the CLI with \`npm i -g sphica@${i.version}\``,
      };
    }
    if (path.resolve(i.root) === path.resolve(base.root)) return {};
    // `tracked` is set only when the baseline is the repository's working tree. Comparing two installs has
    // no notion of tracking; the shipped files are on both sides as is.
    const diff = differingFiles(base.root, i.root, { tracked: Boolean(s.repository) });
    if (!diff.length) return {};
    const files = `${diff.slice(0, 3).join(", ")}${diff.length > 3 ? " and more" : ""}`;
    return {
      note: s.repository
        ? `same version, different contents (${files}). Repository changes do not arrive until the version is bumped and merged to main`
        : `same version, different contents (${files}). Reinstall to match`,
    };
  };

  lines.push("Plugin channel versions");
  if (s.repository) row("repository", s.repository);
  else say("none", "repository", "not visible. Comparing against this CLI's version");

  row("Plugin in this CLI", s.cli, against(s.cli).note);

  if (unknown(s.claude)) say("none", "Claude Code", `unknown (${s.claude.unknown})`);
  else if (s.claude === null) say("none", "Claude Code", "not installed");
  else {
    const { note, update } = against(s.claude);
    if (update) todo.add("claude");
    row("Claude Code", s.claude, note);
  }

  if (s.codex.length === 0) say("none", "Codex", `not found (looked in ${short(s.codexCache)})`);
  for (const x of s.codex) {
    // Reinstalling makes Codex delete the old version's cache (observed in codex-cli 0.153.4).
    const { note, update } =
      s.codex.length > 1
        ? { note: "multiple caches. Codex decides which one it uses", update: true }
        : against(x);
    if (update) todo.add("codex");
    row("Codex", x, note);
  }

  // The minimum without a visible repository: the same version with different contents on the two hosts. It does not claim which is older.
  const x = s.codex.length === 1 ? s.codex[0] : undefined;
  if (!base && s.claude && !unknown(s.claude) && x && s.claude.version === x.version) {
    if (fs.existsSync(s.claude.root) && differingFiles(s.claude.root, x.root).length) {
      say("warn", "Claude Code and Codex", "same version, different contents");
    }
  }

  if (unknown(s.running)) say("none", "Running MCP", `unknown (${s.running.unknown})`);
  else if (s.running.length === 0) say("none", "Running MCP", "none");
  for (const r of unknown(s.running) ? [] : s.running) {
    const when = r.started
      .toLocaleString("sv-SE")
      .slice(r.started.toDateString() === now.toDateString() ? 11 : 5, 16);
    const label = `MCP pid ${r.pid}`;
    const aside = ` (started ${when})`;
    if (!r.root) {
      row(label, null, "unknown start directory", aside, "none");
      continue;
    }
    const codex = r.root.startsWith(`${s.codexCache}/`);
    const installed = codex ? (s.codex.length === 1 ? s.codex[0] : undefined) : s.claude;
    const again = RELOAD[codex ? "codex" : "claude"];
    const state = rootState(r.root);
    let note: string | undefined;
    if (state === "gone")
      note = `The start directory is gone, and Skill paths are invalid too. Fix with ${again}`;
    else if (r.replaced)
      note = `The start directory was recreated in place, and it runs on the removed old version. Fix with ${again}`;
    else if (!CACHED.test(r.root)) {
      note =
        "reads this location directly, not a distributed cache (a directory marketplace or --plugin-dir)";
    } else if (state === "orphaned") note = `a version Claude Code replaced on update. Fix with ${again}`;
    else if (installed && !unknown(installed) && installed.version && r.version) {
      if (compareVersions(r.version, installed.version) < 0)
        note = `older than the installed ${installed.version}. Fix with ${again}`;
    }
    row(label, { version: r.version, root: r.root }, note, aside);
  }

  // The npm CLI's target version is known, so fill it in (a command that can be run as is)
  const updates = [...todo].map((k): Update => {
    const u = UPDATE[k];
    return k === "global" && packageBase.version
      ? { ...u, command: `npm i -g sphica@${packageBase.version}` }
      : { ...u };
  });
  return { lines, issues, updates };
}
