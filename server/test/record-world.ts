// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// A project in a temporary database, and the record MCP server started against it as a host would start it.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { READ_BUDGET } from "../src/reply-budget.ts";
import { project, tempDb } from "./temp-db.ts";
import { tempDir, tmpEnv } from "./temp-dir.ts";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/**
 * `answer` stands for the owner at the host's confirmation dialog: given, the client says it can ask, and answers with what it returns.
 */
export async function recordWorld(
  name: string,
  env: Record<string, string> = {},
  answer?: (message: string) => { action: string; content?: Record<string, string> },
) {
  const db = tempDb();
  const repo = tempDir(`sphica-${name}-`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", `https://github.com/o/${name}.git`], { cwd: repo });
  const p = project(db, `git:github.com/o/${name}`, `o/${name}`);
  const start = async () => {
    const client = new Client(
      { name: "test", version: "0" },
      answer ? { capabilities: { elicitation: { form: {} } } } : undefined,
    );
    if (answer)
      client.setRequestHandler(ElicitRequestSchema, async (r) => answer(String(r.params.message)) as never);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(SRC, "mcp-record.ts")],
        env: {
          ...tmpEnv(),
          PATH: process.env.PATH ?? "",
          HOME: "/nonexistent",
          SPHICA_DB: db.file,
          CLAUDE_PROJECT_DIR: repo,
          ...env,
        },
        stderr: "ignore",
      }),
    );
    return client;
  };
  let client = await start();
  /** A tool's reply text, which must stay within the reply budget whatever was asked */
  const reply = async (tool: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name: tool, arguments: { cwd: repo, ...args } });
    const text = (r.content as { text: string }[]).map((c) => c.text).join("");
    assert.ok(
      Buffer.byteLength(text) <= READ_BUDGET,
      `${tool.slice(0, 40)}: ${Buffer.byteLength(text)} bytes`,
    );
    return { text, isError: r.isError === true };
  };
  /** Begins a trace of a session and returns the run */
  const trace = async (session = "s1") =>
    /^run: (\S+)/.exec((await reply("trace_begin", { session })).text)?.[1] ?? "";
  /** Every page of a run's context, following the cursor each page names, each within the budget */
  const context = async (run: string, auto = false) => {
    const pages: string[] = [];
    const cursors: string[] = [];
    for (let after: string | undefined; ; ) {
      const page = await reply("record_context", {
        run,
        ...(after ? { after } : {}),
        ...(auto ? { auto } : {}),
      });
      assert.ok(!page.isError, page.text.slice(0, 300));
      pages.push(page.text);
      after = /call record_context with after: "([^"]+)"/.exec(page.text)?.[1];
      if (!after) return { pages, cursors };
      assert.ok(!cursors.includes(after), `the cursor ${after} came twice`);
      cursors.push(after);
    }
  };
  return {
    db,
    p,
    repo,
    reply,
    trace,
    context,
    /** Ends the server process and starts a new one against the same database: what the first kept in memory is gone */
    restart: async () => {
      await client.close();
      client = await start();
    },
    done: async () => {
      await client.close();
      await db.done();
    },
  };
}
