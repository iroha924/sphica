// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// A project in a temporary database, and the record MCP server started against it as a host would start it.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { READ_BUDGET } from "../src/reply-budget.ts";
import { project, tempDb } from "./temp-db.ts";
import { tempDir, tmpEnv } from "./temp-dir.ts";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

export async function recordWorld(name: string) {
  const db = tempDb();
  const repo = tempDir(`sphica-${name}-`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", `https://github.com/o/${name}.git`], { cwd: repo });
  const p = project(db, `git:github.com/o/${name}`, `o/${name}`);
  const client = new Client({ name: "test", version: "0" });
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
      },
      stderr: "ignore",
    }),
  );
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
  return {
    db,
    p,
    repo,
    reply,
    done: async () => {
      await client.close();
      await db.done();
    },
  };
}
