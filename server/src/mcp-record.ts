#!/usr/bin/env node
// The record MCP server: the trace, harvest, and glean Skills write through it (the ingest connection). The read server (mcp.ts) stays
// reader-only. Every record write is bound to a run begin issued for one project and target; the record never names them. The forget
// Skill's forget_apply is the one exception: it removes sources on the forget connection, only after the owner confirms in the host.
// The project is the host's workspace: Claude Code's CLAUDE_PROJECT_DIR, or the session directory Codex puts in each call's _meta (it
// starts this server in the plugin root). A cwd argument naming another project is refused, so text read in one project cannot steer a write into another.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Kysely } from "kysely";
import { z } from "zod";
import { dbFile } from "./db.ts";
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
import { applyForget, forgetText, previewForget } from "./forget.ts";
import { framed } from "./frame.ts";
import { gh, repoOf } from "./github.ts";
import { inline } from "./panel.ts";
import { ROOT, versionAt } from "./plugin.ts";
import { hostWorkspace, type Place, projectId, writePlace } from "./project.ts";
import { requireRuntime } from "./sqlite.ts";
import { head, plural, reason } from "./text.ts";

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

async function projectOf(cwd: string | undefined, meta: unknown): Promise<Place & { projectId: number }> {
  const workspace = process.env.CLAUDE_PROJECT_DIR || hostWorkspace(meta);
  if (!workspace)
    throw new Error(
      "The host did not say which workspace this session is in, so nothing is written (update Claude Code or Codex)",
    );
  const place = writePlace(workspace, cwd);
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
    // Asks Codex to name the session's directory in each call's _meta (hostWorkspace)
    capabilities: { experimental: { "codex/sandbox-state-meta": {} } },
    instructions: [
      "Writes Sphica records for the trace, harvest, glean, and forget Skills. Use these tools only while running one of those Skills.",
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
    description:
      "Lists this project's captured sessions with owner messages no trace has looked at, then apart those whose last owner message is over 14 days old.",
    inputSchema: z.object({ cwd: CWD }).strict(),
    annotations: READ,
  },
  async (a, extra) => tool(async () => pendingText(conn(), (await projectOf(a.cwd, extra._meta)).projectId)),
);

server.registerTool(
  "trace_begin",
  {
    title: "Begin tracing a session",
    description:
      "Binds a run to one captured session of this project and returns its id. session is an id from trace_pending, or this session's id.",
    inputSchema: z.object({ session: z.string().min(1).max(200).optional(), cwd: CWD }).strict(),
    annotations: WRITE,
  },
  async (a, extra) =>
    tool(
      async () =>
        `run: ${await beginTrace(conn(), (await projectOf(a.cwd, extra._meta)).projectId, a.session)}\nNext: record_context with this run.`,
    ),
);

server.registerTool(
  "harvest_begin",
  {
    title: "Begin harvesting a pull request",
    description:
      "Reads a pull request of this repository and the issues it closes through gh (read only), keeps them as sources, and returns a run id.",
    inputSchema: z.object({ pr: z.number().int().positive(), cwd: CWD }).strict(),
    annotations: { ...WRITE, openWorldHint: true },
  },
  async (a, extra) =>
    tool(async () => {
      const p = await projectOf(a.cwd, extra._meta);
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
    inputSchema: z.object({ session: z.string().min(1).max(200).optional(), cwd: CWD }).strict(),
    annotations: WRITE,
  },
  async (a, extra) =>
    tool(
      async () =>
        `run: ${await beginGlean(conn(), (await projectOf(a.cwd, extra._meta)).projectId, a.session)}\nNext: record_context with this run.`,
    ),
);

server.registerTool(
  "glean_fetch",
  {
    title: "Keep an issue or pull request the owner named",
    description:
      "Reads a GitHub issue or pull request URL of this repository through gh (read only), keeps it as sources, and lists their refs.",
    inputSchema: z.object({ run: RUN, url: z.string().url().max(500), cwd: CWD }).strict(),
    annotations: { ...WRITE, openWorldHint: true },
  },
  async (a, extra) =>
    tool(async () => {
      const p = await projectOf(a.cwd, extra._meta);
      return framed(await gleanFetch(conn(), a.run, p, a.url, gh(repoOf(p.key) ?? "")));
    }),
);

server.registerTool(
  "record_context",
  {
    title: "What a run may cite",
    description:
      "Prints the run's sources with their refs (s<id>) and this project's live records, a page at a time. A page that ends with " +
      "'call record_context with after' names the after to pass for the next one. Saving counts as looked at only the sources shown " +
      "and those the record quotes.",
    inputSchema: z
      .object({
        run: RUN,
        after: z
          .string()
          .regex(/^s[1-9][0-9]{0,15}$/, "the ref the previous page named, such as s12")
          .optional()
          .describe("The ref the previous page named, to read the next page"),
        cwd: CWD,
      })
      .strict(),
    annotations: READ,
  },
  async (a, extra) =>
    tool(async () => {
      const p = await projectOf(a.cwd, extra._meta);
      return framed(await contextText(conn(), a.run, p.projectId, p.root, a.after));
    }),
);

server.registerTool(
  "record_check",
  {
    title: "Check a record",
    description: "Checks a record against the run's retained text without saving it.",
    inputSchema: z.object({ run: RUN, record: RECORD, cwd: CWD }).strict(),
    annotations: READ,
  },
  async (a, extra) =>
    tool(async () => {
      const p = await projectOf(a.cwd, extra._meta);
      return (await checkText(conn(), a.run, p.projectId, p.root, a.record)).text;
    }),
);

server.registerTool(
  "record_save",
  {
    title: "Save a record",
    description: "Checks and saves a record for the run in one transaction. A run saves once.",
    inputSchema: z.object({ run: RUN, record: RECORD, cwd: CWD }).strict(),
    annotations: WRITE,
  },
  async (a, extra) =>
    tool(async () => {
      const p = await projectOf(a.cwd, extra._meta);
      return saveText(conn(), a.run, p.projectId, p.root, a.record);
    }),
);

const SOURCES = z
  .array(z.string().regex(/^s[1-9][0-9]{0,15}$/))
  .min(1)
  .max(50)
  .describe("Sources to forget, as search and read show them (s12)");
const idsOf = (refs: string[]) => refs.map((r) => Number(r.slice(1)));
/** How long the owner has to answer the confirmation. The SDK's default request timeout (60 s) is too short for a person */
const ANSWER_MS = 10 * 60 * 1000;

server.registerTool(
  "forget_preview",
  {
    title: "What forgetting sources would do",
    description:
      "Shows which sources would be removed and which records would lose citations or leave active. Changes nothing. Never shows the text.",
    inputSchema: z.object({ sources: SOURCES, cwd: CWD }).strict(),
    annotations: READ,
  },
  async (a, extra) =>
    tool(async () => {
      const p = await projectOf(a.cwd, extra._meta);
      return forgetText(await previewForget(dbFile(), p.projectId, idsOf(a.sources)), dbFile());
    }),
);

server.registerTool(
  "forget_apply",
  {
    title: "Forget sources",
    description:
      "Asks the owner in the host to confirm by typing the number of sources, then removes them, their index entries, and the bytes left in the file, and judges the records that cited them again. Nothing is removed without that answer.",
    inputSchema: z.object({ sources: SOURCES, cwd: CWD }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async (a, extra) =>
    tool(async () => {
      const p = await projectOf(a.cwd, extra._meta);
      const ids = idsOf(a.sources);
      const seen = await previewForget(dbFile(), p.projectId, ids);
      const n = seen.sources.length;
      // Only the cleanup runs for ids forgotten earlier: nothing left to confirm
      if (n > 0) {
        // The model cannot answer this: the host shows it to the person. Anything but a matching typed count stops here
        const refused = (why: string) => new Error(`${why}, so nothing was forgotten`);
        if (!server.server.getClientCapabilities()?.elicitation)
          throw refused("This host cannot ask you directly (run /sphica:forget in Claude Code)");
        let answer: Awaited<ReturnType<typeof server.server.elicitInput>>;
        try {
          answer = await server.server.elicitInput(
            {
              mode: "form",
              message: `Forget ${plural(n, "source")} for good?\n${forgetText(seen, dbFile())}`,
              requestedSchema: {
                type: "object",
                properties: {
                  confirm: {
                    type: "string",
                    title: "Number of sources",
                    description: `Type ${n} to forget ${plural(n, "source")}`,
                  },
                },
                required: ["confirm"],
              },
            },
            { timeout: ANSWER_MS, signal: extra.signal },
          );
        } catch (e) {
          throw refused(`The confirmation did not come back (${head(reason(e), 200)})`);
        }
        // The host gave up on this call: an answer arriving after that must not act on its own
        if (extra.signal.aborted) throw refused("The call was cancelled");
        if (answer.action !== "accept")
          throw refused(`You ${answer.action === "decline" ? "declined" : "cancelled"}`);
        if (String(answer.content?.confirm ?? "").trim() !== String(n))
          throw refused(`The number typed does not match ${n}`);
      }
      const done = await applyForget(dbFile(), p.projectId, ids, seen, extra.signal);
      return [
        n ? `Forgot ${plural(n, "source")}.` : "Nothing new to forget.",
        forgetText(done.outcome, dbFile()),
        done.cleanup === "done"
          ? "The deleted text was cleared from the database file."
          : "Clearing the deleted text from the database file did not finish (another session may be reading it), so it may stay there until you run forget_apply with the same sources again.",
      ].join("\n");
    }),
);

await server.connect(new StdioServerTransport());
