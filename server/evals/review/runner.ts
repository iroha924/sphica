// How one precedent lane of the review evaluation is started on each host: the reviewer gets the aspect body as its prompt, Read / Grep /
// Glob and Sphica's read MCP server on the run's copy of the fixture database, and nothing else of the owner's (settings, hooks, plugins,
// MCP servers). Claude's reads are fenced to the checkout; Codex has no read fence, so its runs are graded on what they named instead.
import { DENY_DIRS, DENY_FILES } from "../cloud/claude-run.ts";

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
export function claudeSettings(tools: string[] = READ_TOOLS): Record<string, unknown> {
  return {
    permissions: {
      blockReadsOutsideWorkingDirectories: true,
      allow: tools,
      deny: [
        "WebFetch",
        "WebSearch",
        ...DENY_DIRS.map((d) => `Read(/${d}/**)`),
        ...DENY_FILES.map((f) => `Read(/${f})`),
      ],
    },
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      filesystem: { denyRead: [...DENY_DIRS, ...DENY_FILES] },
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

/** codex exec as review's peer-model.md starts a lane: read-only and ephemeral, the prompt on stdin, the final answer to a file. */
export function codexArgs(work: string, answer: string): string[] {
  return [
    "exec",
    "--json",
    "--ignore-rules",
    "--ephemeral",
    "-s",
    "read-only",
    "-C",
    work,
    "-o",
    answer,
    "-",
  ];
}
