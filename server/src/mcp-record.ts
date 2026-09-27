#!/usr/bin/env node
// The record MCP server: the trace, harvest, and glean Skills write through it (the ingest connection). The read server (mcp.ts) stays
// reader-only. Every write is bound to a run begin issued for one project and target; the record never names them.
// The project is the host's workspace: Claude Code's CLAUDE_PROJECT_DIR, or the directory Codex starts this server in (measured with
// codex-cli 0.157.1). A cwd argument naming another project is refused, so text read in one project cannot steer a write into another.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { DB } from "./db-types.ts";
import { openWriter } from "./db-write.ts";
import {
  beginGlean,
  beginHarvest,
  beginTrace,
  checkText,
  contextText,
  gleanFetch,
  pendingText,
  saveText,
} from "./extract.ts";
import { framed } from "./frame.ts";
import { gh, repoOf } from "./github.ts";
import { inline } from "./panel.ts";
import { ROOT, versionAt } from "./plugin.ts";
import { type Place, projectId, writePlace } from "./project.ts";
import { requireRuntime } from "./sqlite.ts";
import { head, reason } from "./text.ts";

requireRuntime();
let db: Kysely<DB> | null = null;
/** Opened on the first call, so the server starts even before `sphica init` */
const conn = () => {
  db ??= openWriter("ingest");
  return db;
};

const reply = (t: string, isError = false) => ({
  content: [{ type: "text" as const, text: t }],
  ...(isError ? { isError: true } : {}),
});

async function projectOf(cwd: string | undefined): Promise<Place & { projectId: number }> {
  const place = writePlace(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), cwd);
  if (!place) throw new Error("This directory is not in a registered project (run `sphica init` there)");
  const id = await projectId(conn(), place.key);
  if (id === null)
    throw new Error(
      `${head(inline(place.name), 200)} is not registered with Sphica (run \`sphica init\` there)`,
    );
  return { ...place, projectId: id };
}

/** Runs a tool body, turning a failure into an error reply the agent can read. */
const tool = (fn: () => Promise<string>) =>
  fn().then(
    (t) => reply(t),
    (e) => reply(`Sphica: ${head(reason(e), 2000)}`, true),
  );

const server = new McpServer(
  { name: "sphica-record", version: versionAt(ROOT) ?? "unknown" },
  {
    instructions: [
      "Writes Sphica records for the trace, harvest, and glean Skills. Use these tools only while running one of those Skills.",
      "Flow: begin (trace_begin, harvest_begin, or glean_begin) returns a run id; context shows what the run may cite; check the record; save it.",
      "Always pass the repository root as cwd.",
    ].join("\n"),
  },
);

const CWD = z
  .string()
  .optional()
  .describe("The repository root (Claude Code's project directory is used when available)");
const RUN = z.string().min(1).max(40).describe("The run id begin returned");
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const RECORD = z.record(z.string(), z.unknown()).describe("The record, as the Skill describes");

server.registerTool(
  "trace_pending",
  {
    title: "Sessions not traced yet",
    description: "Lists this project's captured sessions with owner messages no trace has looked at.",
    inputSchema: { cwd: CWD },
    annotations: READ,
  },
  async (a) => tool(async () => pendingText(conn(), (await projectOf(a.cwd)).projectId)),
);

server.registerTool(
  "trace_begin",
  {
    title: "Begin tracing a session",
    description:
      "Binds a run to one captured session of this project and returns its id. session is an id from trace_pending, or this session's id.",
    inputSchema: { session: z.string().min(1).max(200).optional(), cwd: CWD },
    annotations: WRITE,
  },
  async (a) =>
    tool(
      async () =>
        `run: ${await beginTrace(conn(), (await projectOf(a.cwd)).projectId, a.session)}\nNext: record_context with this run.`,
    ),
);

server.registerTool(
  "harvest_begin",
  {
    title: "Begin harvesting a pull request",
    description:
      "Reads a pull request of this repository and the issues it closes through gh (read only), keeps them as sources, and returns a run id.",
    inputSchema: { pr: z.number().int().positive(), cwd: CWD },
    annotations: { ...WRITE, openWorldHint: true },
  },
  async (a) =>
    tool(async () => {
      const p = await projectOf(a.cwd);
      const repo = repoOf(p.key);
      if (!repo) throw new Error(`${p.name} is not on github.com, so there is no pull request to read`);
      const r = await beginHarvest(conn(), p.projectId, a.pr, gh(repo));
      return `run: ${r.run}\n${r.sources} sources kept. Next: record_context with this run.`;
    }),
);

server.registerTool(
  "glean_begin",
  {
    title: "Begin gleaning",
    description:
      "Binds a run to this session, whose owner messages are the evidence glean cites, and returns its id. session is this session's id.",
    inputSchema: { session: z.string().min(1).max(200).optional(), cwd: CWD },
    annotations: WRITE,
  },
  async (a) =>
    tool(
      async () =>
        `run: ${await beginGlean(conn(), (await projectOf(a.cwd)).projectId, a.session)}\nNext: record_context with this run.`,
    ),
);

server.registerTool(
  "glean_fetch",
  {
    title: "Keep an issue or pull request the owner named",
    description:
      "Reads a GitHub issue or pull request URL of this repository through gh (read only), keeps it as sources, and lists their refs.",
    inputSchema: { run: RUN, url: z.string().url().max(500), cwd: CWD },
    annotations: { ...WRITE, openWorldHint: true },
  },
  async (a) =>
    tool(async () => {
      const p = await projectOf(a.cwd);
      return framed(await gleanFetch(conn(), a.run, p, a.url, gh(repoOf(p.key) ?? "")));
    }),
);

server.registerTool(
  "record_context",
  {
    title: "What a run may cite",
    description: "Prints the run's sources with their refs (s<id>) and this project's live records.",
    inputSchema: { run: RUN, cwd: CWD },
    annotations: READ,
  },
  async (a) =>
    tool(async () => {
      const p = await projectOf(a.cwd);
      return framed(await contextText(conn(), a.run, p.projectId, p.root));
    }),
);

server.registerTool(
  "record_check",
  {
    title: "Check a record",
    description: "Checks a record against the run's retained text without saving it.",
    inputSchema: { run: RUN, record: RECORD, cwd: CWD },
    annotations: READ,
  },
  async (a) =>
    tool(async () => {
      const p = await projectOf(a.cwd);
      return (await checkText(conn(), a.run, p.projectId, p.root, a.record)).text;
    }),
);

server.registerTool(
  "record_save",
  {
    title: "Save a record",
    description: "Checks and saves a record for the run in one transaction. A run saves once.",
    inputSchema: { run: RUN, record: RECORD, cwd: CWD },
    annotations: WRITE,
  },
  async (a) =>
    tool(async () => {
      const p = await projectOf(a.cwd);
      return saveText(conn(), a.run, p.projectId, p.root, a.record);
    }),
);

await server.connect(new StdioServerTransport());
