// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Both MCP servers as a host starts them, fed raw bytes: the SDK closes the transport when its receive buffer passes 10 MiB, and a
// server that then ended with code 0 and no word would look like one that was simply done.

import "./isolate-home.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { stopOnOverflow } from "../src/stdio-limit.ts";
import { tempDir, tmpEnv } from "./temp-dir.ts";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const LIMIT = 10 * 1024 * 1024;

/** A server process, what it wrote, and how it ended */
function server(entry: string) {
  // A home and a database path of its own: nothing the server reads or writes is the owner's, on any platform
  const home = tempDir("sphica-stdio-home-");
  const child = spawn(process.execPath, [path.join(SRC, entry)], {
    env: {
      ...tmpEnv(),
      PATH: process.env.PATH ?? "",
      HOME: home,
      USERPROFILE: home,
      SPHICA_DB: path.join(home, "sphica.db"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => {
    out += d;
  });
  child.stderr.on("data", (d) => {
    err += d;
  });
  // A server that stopped reading closes its end; what is still being written to it then fails, which is the case under test
  child.stdin.on("error", () => {});
  const ended = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  /** Waits until the server has answered the request with this id */
  const answered = async (id: number) => {
    for (let i = 0; i < 600 && !out.includes(`"id":${id}`); i++) await new Promise((r) => setTimeout(r, 50));
    return out.split("\n").find((l) => l.includes(`"id":${id}`)) ?? "";
  };
  return { child, ended, answered, err: () => err, out: () => out };
}

const ping = (id: number, pad = "") =>
  `${JSON.stringify({ jsonrpc: "2.0", id, method: "ping", ...(pad ? { params: { pad } } : {}) })}\n`;

for (const entry of ["mcp.ts", "mcp-record.ts"]) {
  test(`${entry}: a receive buffer past the SDK's limit ends the server with code 1 and a line on stderr`, async () => {
    // No line ends, so the buffer only grows: written in two parts, neither over the limit alone
    const s = server(entry);
    s.child.stdin.write("x".repeat(6 * 1024 * 1024));
    s.child.stdin.write("x".repeat(6 * 1024 * 1024));
    assert.equal(await s.ended, 1);
    assert.equal(
      s.err(),
      "Sphica: the receive buffer passed 10 MiB, so the server stops. No request in it was run.\n",
    );
    assert.equal(s.out(), "");
  });

  test(`${entry}: a request of exactly the limit is answered, bad JSON is passed over, and the server ends with code 0 when its input closes`, async () => {
    const s = server(entry);
    // One line of exactly the limit, its newline included
    const pad = "x".repeat(
      LIMIT - Buffer.byteLength(ping(1, "")) - Buffer.byteLength(',"params":{"pad":""}'),
    );
    const line = ping(1, pad);
    assert.equal(Buffer.byteLength(line), LIMIT);
    s.child.stdin.write(line);
    assert.match(await s.answered(1), /"result":\{\}/);
    s.child.stdin.write("this is not JSON\n");
    s.child.stdin.write(ping(2));
    assert.match(await s.answered(2), /"result":\{\}/);
    s.child.stdin.end();
    assert.equal(await s.ended, 0);
    assert.equal(s.err(), "");
  });
}

// The SDK calls onclose only on its own overflow or an explicit close today, so a server process cannot show the other closes
test("only the close that follows the buffer's own error is turned into an error exit", () => {
  const transport = {} as StdioServerTransport;
  const seen: string[] = [];
  transport.onerror = (e) => seen.push(`error: ${e.message}`);
  transport.onclose = () => seen.push("close");
  stopOnOverflow(transport);
  const write = process.stderr.write;
  const said: string[] = [];
  process.stderr.write = ((s: string) => said.push(s) > 0) as typeof process.stderr.write;
  const before = process.exitCode;
  try {
    transport.onclose?.();
    transport.onerror?.(new Error("Unexpected token in JSON"));
    transport.onclose?.();
    assert.equal(process.exitCode, before);
    assert.deepEqual(said, []);
    transport.onerror?.(new Error("ReadBuffer exceeded maximum size of 10485760 bytes"));
    transport.onclose?.();
    assert.equal(process.exitCode, 1);
    assert.deepEqual(said, [
      "Sphica: the receive buffer passed 10 MiB, so the server stops. No request in it was run.\n",
    ]);
    // What the server had set on the transport still runs
    assert.equal(seen.filter((x) => x === "close").length, 3);
    assert.equal(seen.filter((x) => x.startsWith("error: ")).length, 2);
  } finally {
    process.stderr.write = write;
    process.exitCode = before;
  }
});
