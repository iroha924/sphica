#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Runs a command in the sandbox runtime (srt) that CI runs the test lanes in: writes reach only this checkout and the temp directory,
// never .git, and the network is closed. A canary under the same settings runs first and must be refused, so a sandbox that does
// nothing fails the run instead of passing it. Usage: node scripts/sandboxed.mjs <command> [args...]

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { CheckFailure, guard } from "./lib/finding.mjs";
import { root } from "./lib/live-harness.mjs";

guard("sandboxed");

const cli = path.join(
  root,
  "tools",
  "sandbox",
  "node_modules",
  "@anthropic-ai",
  "sandbox-runtime",
  "dist",
  "cli.js",
);
const WHY =
  "tests must not reach the owner's ~/.sphica, Codex home, or repository, and only the OS can stop one that gets it wrong";
const home = os.homedir();
// srt leaves these writable when they exist, as a convenience for npm and Claude Code
const RUNTIME_DEFAULTS = [
  path.join(home, ".claude", "debug"),
  path.join(home, ".npm", "_logs"),
  "/tmp/claude",
  "/private/tmp/claude",
];
// What the owner keeps for Sphica, Codex, and Claude Code is not even read, and the variables that point at it are dropped
const OWNER_HOMES = [".sphica", ".codex", ".claude"].map((name) => path.join(home, name));
const OWNER_VARIABLES = ["SPHICA_DB", "SPHICA_HOME", "CODEX_HOME"];
// CI runs these after the sandbox exits, outside it, so nothing inside may change them
const RUN_AFTER = [path.join(root, "scripts"), path.join(root, "plugin", "package.json")];
const CLOSED = "sandbox canary: every way out was refused";

// Tries each way out and prints the ones that worked, or CLOSED when none did: a runtime that runs nothing prints neither
const CANARY = `
const fs = require("node:fs"), net = require("node:net"), path = require("node:path");
const [root, port, ...dirs] = process.argv.slice(1);
const open = [];
for (const dir of [path.join(root, ".git"), ...dirs]) {
  const file = path.join(dir, "sandbox-canary-" + process.pid);
  try { fs.writeFileSync(file, ""); fs.rmSync(file); open.push("wrote " + file); } catch {}
}
const s = net.connect({ host: "127.0.0.1", port: Number(port), timeout: 3000 });
s.on("connect", () => { open.push("connected to 127.0.0.1:" + port); s.destroy(); });
s.on("timeout", () => s.destroy());
s.on("error", () => {});
s.on("close", () => {
  if (open.length) { console.log(open.join("; ")); process.exitCode = 1; } else console.log(${JSON.stringify(CLOSED)});
});
`;

// srt blocks writes to files like .mcp.json and .bashrc in its working directory by placing stubs there while it runs, so it starts in
// an empty directory and this moves into the checkout
const IN_ROOT = `
const [dir, command, ...args] = process.argv.slice(1);
process.chdir(dir);
const r = require("node:child_process").spawnSync(command, args, { stdio: "inherit" });
if (r.error) console.error(r.error.message);
process.exit(r.status ?? 1);
`;

/** Resolves with the child's exit status and, when piped, its output */
function run(command, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, opts);
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, out }));
  });
}

/** A loopback listener outside the sandbox that the canary must not reach; it is checked reachable from here first */
async function listener() {
  const server = net.createServer((socket) => {
    server.reached = true;
    socket.destroy();
  });
  server.reached = false;
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const reached = new Promise((resolve) => server.once("connection", resolve));
  await new Promise((resolve, reject) => {
    const probe = net.connect({ host: "127.0.0.1", port });
    probe.once("error", reject);
    probe.once("close", resolve);
  });
  await reached;
  server.reached = false;
  return { server, port };
}

async function main(command) {
  if (!command.length)
    throw new CheckFailure({
      where: "scripts/sandboxed.mjs",
      what: "no command was given",
      why: "the script only wraps another command",
      fix: "run `node scripts/sandboxed.mjs <command> [args...]`",
    });
  if (!fs.existsSync(cli))
    throw new CheckFailure({
      where: "tools/sandbox",
      what: "the sandbox runtime is not installed",
      why: WHY,
      fix: "run `bun install --cwd tools/sandbox --frozen-lockfile --ignore-scripts`",
    });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-sandbox-")));
  try {
    const settings = path.join(dir, "srt-settings.json");
    const start = path.join(dir, "start");
    // The only temp directory the sandbox may write; srt points TMPDIR inside it here, or at /tmp/claude, which need not exist
    const tmp = path.join(dir, "tmp");
    fs.mkdirSync(start);
    fs.mkdirSync(tmp);
    fs.writeFileSync(
      settings,
      JSON.stringify({
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: {
          denyRead: OWNER_HOMES,
          allowWrite: [root, tmp],
          denyWrite: [path.join(root, ".git"), ...RUNTIME_DEFAULTS, ...RUN_AFTER],
        },
      }),
    );
    const srt = (args, opts) =>
      run(
        process.execPath,
        [cli, "--settings", settings, "--", process.execPath, "-e", IN_ROOT, root, ...args],
        {
          cwd: start,
          env: {
            ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !OWNER_VARIABLES.includes(k))),
            CLAUDE_CODE_TMPDIR: tmp,
            CLAUDE_TMPDIR: tmp,
            TMP: tmp,
            TEMP: tmp,
          },
          ...opts,
        },
      );
    const { server, port } = await listener();
    let canary;
    try {
      canary = await srt(
        [
          process.execPath,
          "-e",
          CANARY,
          root,
          String(port),
          home,
          os.tmpdir(),
          ...RUNTIME_DEFAULTS,
          ...RUN_AFTER.slice(0, 1),
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } finally {
      server.close();
    }
    if (canary.status !== 0 || !canary.out.includes(CLOSED) || server.reached)
      throw new CheckFailure({
        where: "scripts/sandboxed.mjs",
        what: "the sandbox let the canary out, or did not run it",
        why: WHY,
        fix: "on Linux install bubblewrap, socat, and ripgrep and allow unprivileged user namespaces; the output below says which",
        detail: `${server.reached ? `the listener on 127.0.0.1:${port} was reached\n` : ""}${canary.out}`,
      });
    const r = await srt(command, { stdio: "inherit" });
    process.exitCode = r.status ?? 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

await main(process.argv.slice(2));
