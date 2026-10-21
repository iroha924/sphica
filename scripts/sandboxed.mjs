#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Runs a command in the sandbox runtime (srt) that CI runs the test lanes in: writes reach only this checkout and the temp directory,
// never .git, and the network is closed. A canary under the same settings runs first and must be refused, so a sandbox that does
// nothing fails the run instead of passing it. Usage: node scripts/sandboxed.mjs <command> [args...]

import { spawnSync } from "node:child_process";
import fs from "node:fs";
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

// Tries each way out and prints the ones that worked; the sandbox is on only when it prints nothing
const CANARY = `
const fs = require("node:fs"), net = require("node:net"), os = require("node:os"), path = require("node:path");
const open = [];
for (const file of [path.join(os.homedir(), ".sphica-sandbox-canary-" + process.pid), path.join(process.argv[1], ".git", "sandbox-canary-" + process.pid)]) {
  try { fs.writeFileSync(file, ""); fs.rmSync(file); open.push("wrote " + file); } catch {}
}
const s = net.connect({ host: "1.1.1.1", port: 53, timeout: 3000 });
s.on("connect", () => { open.push("connected to 1.1.1.1:53"); s.destroy(); });
s.on("timeout", () => s.destroy());
s.on("close", () => { if (open.length) { console.log(open.join("; ")); process.exitCode = 1; } });
s.on("error", () => {});
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

function main(command) {
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
    // srt points TMPDIR inside the sandbox here, or at /tmp/claude, which need not exist
    const tmp = path.join(dir, "tmp");
    fs.mkdirSync(start);
    fs.mkdirSync(tmp);
    fs.writeFileSync(
      settings,
      JSON.stringify({
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: {
          denyRead: [],
          allowWrite: [root, fs.realpathSync(os.tmpdir())],
          denyWrite: [path.join(root, ".git")],
        },
      }),
    );
    const srt = (args, opts) =>
      spawnSync(
        process.execPath,
        [cli, "--settings", settings, "--", process.execPath, "-e", IN_ROOT, root, ...args],
        {
          cwd: start,
          env: { ...process.env, CLAUDE_CODE_TMPDIR: tmp, CLAUDE_TMPDIR: tmp },
          ...opts,
        },
      );
    const canary = srt([process.execPath, "-e", CANARY, root], { encoding: "utf8" });
    if (canary.status !== 0 || canary.error)
      throw new CheckFailure({
        where: "scripts/sandboxed.mjs",
        what: "the sandbox let the canary out, or did not start",
        why: WHY,
        fix: "on Linux install bubblewrap, socat, and ripgrep and allow unprivileged user namespaces; the output below says which",
        detail: `${canary.stdout ?? ""}${canary.stderr ?? ""}${canary.error?.message ?? ""}`,
      });
    const r = srt(command, { stdio: "inherit" });
    if (r.error)
      throw new CheckFailure({
        where: "scripts/sandboxed.mjs",
        what: `the sandboxed command could not start: ${r.error.message}`,
        why: WHY,
        fix: "check that node runs tools/sandbox's srt",
      });
    process.exitCode = r.status ?? 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main(process.argv.slice(2));
