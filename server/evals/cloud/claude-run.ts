// What a local Claude run is started with: the settings file (sandbox, permissions, hooks) and the MCP config for one condition. The run
// uses the owner's login, so everything else of the owner's (settings, CLAUDE.md, plugins, MCP servers) is kept out by the command line
// (no setting sources, strict MCP config) and what is left is fenced by the sandbox and acceptEdits.
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

type Hook = { type: "command"; command: string; args: string[]; timeout: number };
type HookEntry = { matcher?: string; hooks: Hook[] };

/** Paths a run must never read, whatever the agent tries: the owner's credentials and Sphica's own database. */
export const DENY_READ = [
  ".ssh",
  ".aws",
  ".config",
  ".codex",
  ".claude",
  ".sphica",
  ".gnupg",
  ".npmrc",
  ".netrc",
].map((p) => path.join(os.homedir(), p));

export type RunPaths = {
  /** The run directory: receipts, the gold marker, the database copy live here */
  run: string;
  /** The checkout the agent works in */
  work: string;
  /** The slot's .tools, copied outside the checkout so the agent cannot rewrite what the hooks run */
  tools: string;
  /** The run's copy of the fixture database */
  db: string;
};

/** Exec-form hook: no shell parses the paths, so a space in them never splits an argument. */
const hook = (args: string[], timeout: number): Hook => ({
  type: "command",
  command: "sh",
  args,
  timeout,
});

/** The settings file of one run. The shipped delivery matcher is passed in so inject fires on the tools the plugin does. */
export function runSettings(condition: string, p: RunPaths, deliverMatcher: string): Record<string, unknown> {
  const receipt = (name: string, ...command: string[]) =>
    hook([path.join(p.tools, "hook.sh"), name, ...command], 60);
  const deliver = (name: string) =>
    receipt(name, "sh", path.join(p.tools, "sphica.sh"), path.join(p.tools, "dist", "deliver.js"));
  const hooks: Record<string, HookEntry[]> = {
    SessionStart: [{ hooks: [receipt("start")] }],
    // Every condition logs the prompt, so collect can tell which task a run carried out
    UserPromptSubmit: [{ hooks: [receipt("prompt")] }],
  };
  if (condition === "inject") {
    hooks.SessionStart = [{ hooks: [deliver("start")] }];
    hooks.UserPromptSubmit = [{ hooks: [deliver("prompt")] }];
    hooks.PreToolUse = [{ matcher: deliverMatcher, hooks: [deliver("edit")] }];
  }
  if (condition === "gold")
    hooks.UserPromptSubmit = [{ hooks: [receipt("gold", "sh", path.join(p.tools, "gold.sh"))] }];
  return {
    permissions: {
      // acceptEdits asks before any MCP call, and a run has no one to answer: Sphica's tools are allowed where the condition has them
      allow: condition === "search" || condition === "inject" ? ["mcp__sphica"] : [],
      deny: [
        "PushNotification",
        "WebFetch",
        "WebSearch",
        ...DENY_READ.flatMap((d) => [`Read(/${d}/**)`, `Edit(/${d}/**)`]),
      ],
    },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      filesystem: { denyRead: DENY_READ },
    },
    env: { EVAL_RUN_DIR: p.run, EVAL_SPHICA_DB: p.db },
    hooks,
  };
}

/** The MCP config of one run: Sphica's read server where the condition has it, and nothing otherwise. */
export function runMcp(condition: string, p: RunPaths): { mcpServers: Record<string, unknown> } {
  if (condition !== "search" && condition !== "inject") return { mcpServers: {} };
  return {
    mcpServers: {
      sphica: {
        command: "sh",
        args: [path.join(p.tools, "sphica.sh"), path.join(p.tools, "dist", "mcp.js")],
        env: { EVAL_SPHICA_DB: p.db, EVAL_RUN_DIR: p.run },
      },
    },
  };
}

/** The command line of one run, after `claude`. The model is pinned so old and new are run by the same one. */
export function runArgs(p: { settings: string; mcp: string }, model: string): string[] {
  return [
    "-p",
    "--setting-sources",
    "",
    "--settings",
    p.settings,
    "--strict-mcp-config",
    "--mcp-config",
    p.mcp,
    "--permission-mode",
    "acceptEdits",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--model",
    model,
  ];
}

/** Variables of the parent Claude Code session that would make the run's hooks treat it as a nested call. */
export const PARENT_ENV = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "SPHICA_PARENT_SESSION",
  "SPHICA_DB",
  "SPHICA_HOME",
];

/** Tracked and untracked changes since the starting commit, without the slot's scaffolding or installed dependencies. */
export function patchSince(work: string, start: string): string {
  const leave = [":!.tools", ":!.eval", ":(exclude,glob)**/node_modules/**"];
  execFileSync("git", ["-C", work, "add", "-A", "--", ".", ...leave]);
  return execFileSync("git", ["-C", work, "diff", "--cached", start, "--", ".", ...leave], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** The last result event of a stream-json run: the final answer, or nothing when the run was cut off. */
export function finalAnswer(events: string): { result: string; is_error: boolean } | undefined {
  return events
    .split("\n")
    .flatMap((l) => {
      try {
        const e = JSON.parse(l) as { type?: string; result?: unknown; is_error?: unknown };
        return e.type === "result" ? [{ result: String(e.result ?? ""), is_error: e.is_error === true }] : [];
      } catch {
        return [];
      }
    })
    .at(-1);
}
