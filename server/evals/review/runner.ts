// How one precedent lane of the review evaluation is started on each host: the reviewer gets the aspect body as its prompt, Read / Grep /
// Glob and Sphica's read MCP server on the run's copy of the fixture database, and nothing else of the owner's (settings, hooks, plugins,
// MCP servers). Claude's reads are fenced to the checkout; Codex's commands are fenced by a permission profile's denies.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DENY_DIRS, DENY_FILES } from "../cloud/claude-run.ts";
import { codexDenies, outsideTree, repoPlaces, type Shield } from "../cloud/codex-run.ts";

/** Where a lane's pieces stay out of reach: the evaluation cache, what the repository and HOME fences are, and a way to report a tree left */
export type LaneEnv = { cache: string; shield: Shield; leave: (tree: string) => void };

/**
 * What a Claude lane may not read: the repository wherever its files or history are (the expected verdicts, the held-out cases, M2's
 * hidden tests and reference check), the output directory (the other runs, each run's own CODEX_HOME), and the owner's credentials.
 * Claude keeps the owner's HOME for its login; its file tools are fenced to the checkout besides.
 */
export const evalDenies = (out: string, places = repoPlaces()): string[] => [
  ...places,
  out,
  ...DENY_DIRS,
  ...DENY_FILES,
];

/** What a Codex lane may not read: what every fenced Codex is denied (all of HOME but the tools), and the output directory */
export const codexLaneDenies = (out: string, cache: string, shield: Shield): string[] => [
  ...codexDenies(cache, shield),
  out,
];

/** A fresh checkout in a temp tree outside everything denied, so denying the output directory never hides the checkout itself */
export const outsideCheckout = (prefix: string, denies: string[]): string =>
  path.join(outsideTree(prefix, denies), "work");

/**
 * Runs every worker to its end before failing with the first error: a run that stopped early while another still had its temp tree
 * would release the lock under that tree.
 */
export async function settleAll(workers: (() => Promise<void>)[]): Promise<void> {
  const ends = await Promise.allSettled(workers.map((w) => w()));
  const failed = ends.find((e): e is PromiseRejectedResult => e.status === "rejected");
  if (failed) throw failed.reason;
}

/**
 * Runs the queued lanes `jobs` at a time, and starts no lane once `stopped` says a temp tree was left behind: the next lane would run
 * beside it without a deny for it. Every started lane runs to its end before the first failure is thrown.
 */
export async function drainLanes<T>(
  queue: T[],
  jobs: number,
  run: (item: T) => Promise<void>,
  stopped: () => boolean,
): Promise<void> {
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      if (stopped()) throw new Error("a temp tree was left behind; no further lane starts");
      await run(item);
      if (stopped()) throw new Error("a temp tree was left behind; no further lane starts");
    }
  };
  await settleAll(Array.from({ length: jobs }, () => worker));
}

/** The code that starts and fences a run, relative to this directory */
export const RUNNER_FILES = [
  "runner.ts",
  "run.ts",
  "m2.ts",
  "fixture.ts",
  "biome.ts",
  "../cloud/codex-home.ts",
  "../cloud/codex-run.ts",
];

/** The code that starts and fences a run, as one hash: runs made by different runner code are different measurements */
export function runnerDigest(): string {
  const hash = crypto.createHash("sha256");
  for (const file of RUNNER_FILES)
    hash.update(`${file}\0`).update(fs.readFileSync(path.join(import.meta.dirname, file)));
  return hash.digest("hex");
}

/**
 * Moves a finished run's temp tree into its run directory, which every later run is denied: a tree left in the temp directory is not.
 * False when the tree could not be removed, so the caller keeps the lock.
 */
export function keepCheckout(work: string, dir: string): boolean {
  const tree = path.dirname(work);
  if (!fs.existsSync(tree)) return true;
  try {
    fs.cpSync(tree, path.join(dir, "checkout"), { recursive: true, verbatimSymlinks: true });
    fs.rmSync(tree, { recursive: true, force: true });
  } catch {}
  return !fs.existsSync(tree);
}

/** The /sphica:rules body M1 measured, with its Biome check drafting: the shipped Skill does not draft checks */
export const RULES_BODY = path.join(import.meta.dirname, "rules-body.md");

const sphicaTools = (names: string[]) => names.map((t) => `mcp__sphica__${t}`);
/** The read server's tools a precedent lane gets, as Claude names them for a server called sphica */
export const READ_TOOLS = sphicaTools(["status", "search", "read", "review_select", "review_check"]);
/** The ones /sphica:rules allows */
export const RULES_TOOLS = sphicaTools(["overview", "search", "read", "status"]);

/** Where one run's pieces live: the checkout the reviewer works in, the diff it reviews, Sphica's files, and the built read server */
export type LanePaths = { work: string; diff: string; db: string; home: string; server: string };

/** Sphica's own paths for the read server: the run's database copy, and a home that is not the owner's */
const sphicaEnv = (p: LanePaths) => ({ SPHICA_DB: p.db, SPHICA_HOME: p.home, HOME: p.home });

/**
 * The prompt a launcher gives the precedent lane: the aspect body in full, then the scope as review's Step 3 passes it (the committed
 * change as a file, the other two layers empty), then the one-call output order peer-model.md asks for and the completion line of
 * review's Step 4.
 */
export function reviewPrompt(
  body: string,
  p: Pick<LanePaths, "work" | "diff"> & { model: "claude" | "codex" },
): string {
  return `${body.trimEnd()}

## Scope

Repository root (pass it as \`cwd\`): ${p.work}

| Layer | How to read it |
|---|---|
| Committed | Read the file ${p.diff}: it holds \`git diff\` of the change |
| Uncommitted, tracked | empty |
| Untracked | empty |

Give the list first, then the full text of every finding in number order, in this one reply: nobody can ask you for more afterwards.

End the report with this line as its last non-empty block, with nothing after it:

\`\`\`
completion: lane=precedent model=${p.model} coverage=<COMPLETE|PARTIAL> unfinished=<unchecked scope | none> findings=<count>
\`\`\`
`;
}

/**
 * The prompt /sphica:rules runs on when the owner names the records: the Skill's body with its target filled in, and the owner's
 * confirmation already given, since nobody can answer a question in the run.
 */
export function rulesPrompt(body: string, picks: string[]): string {
  return `${body.replace("$ARGUMENTS", picks.join(", ")).trimEnd()}

The owner picked exactly these records and has already confirmed the choice, so do not ask again: ${picks.join(", ")}.
Rule lines go into CLAUDE.md. Print the whole draft in this one reply: nobody can answer a question afterwards.
`;
}

/** Claude's settings for a lane: no hooks, reads fenced to the checkout, the owner's credentials and Sphica's home denied, the read tools allowed. */
export function claudeSettings(tools: string[] = READ_TOOLS, denies: string[] = []): Record<string, unknown> {
  return {
    permissions: {
      blockReadsOutsideWorkingDirectories: true,
      allow: tools,
      deny: [
        "WebFetch",
        "WebSearch",
        ...[...DENY_DIRS, ...denies].map((d) => `Read(/${d}/**)`),
        ...DENY_FILES.map((f) => `Read(/${f})`),
      ],
    },
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      filesystem: { denyRead: [...DENY_DIRS, ...DENY_FILES, ...denies] },
    },
    hooks: {},
  };
}

/** The MCP config for Claude: the read server alone, started with node on the run's database. */
export function claudeMcp(p: LanePaths): { mcpServers: Record<string, unknown> } {
  return {
    mcpServers: {
      sphica: { command: process.execPath, args: [p.server], env: sphicaEnv(p) },
    },
  };
}

export function claudeArgs(f: { settings: string; mcp: string }, model: string): string[] {
  return [
    "-p",
    // The checkout has no settings or CLAUDE.md of its own; user and local sources would bring the owner's hooks and plugins
    "--setting-sources",
    "project",
    "--settings",
    f.settings,
    "--strict-mcp-config",
    "--mcp-config",
    f.mcp,
    "--tools",
    "Read,Grep,Glob",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--model",
    model,
  ];
}

/** The lines a lane's CODEX_HOME config adds: the read server on the run's database. */
export function codexMcp(p: LanePaths): string {
  const env = Object.entries(sphicaEnv(p))
    .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
    .join(", ");
  return `\n[mcp_servers.sphica]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(p.server)}]\nenv = { ${env} }\n`;
}

/** codex exec for a lane: ephemeral, the prompt on stdin, the final answer to a file; the sandbox comes from the profile. */
export function codexArgs(work: string, answer: string): string[] {
  return ["exec", "--json", "--ignore-rules", "--ephemeral", "-C", work, "-o", answer, "-"];
}
