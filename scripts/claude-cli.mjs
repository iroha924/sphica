#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Runs the Claude Code CLI that tools/claude-cli pins, for the checks of the sphica-pane mod (plugin validate and plugin test).
// Installed with --ignore-scripts, the package's own launcher is a stub, so the platform package's native binary is started by path.
// Its settings and home go to a temporary directory (CLAUDE_CONFIG_DIR, HOME, USERPROFILE), so a check never reads or writes the owner's ~/.claude.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = "bun install --cwd tools/claude-cli --frozen-lockfile --ignore-scripts";

/** The pinned CLI's native binary for this machine */
export function claudeBinary() {
  const require = createRequire(path.join(root, "tools/claude-cli/package.json"));
  const platform = `@anthropic-ai/claude-code-${process.platform}-${process.arch}`;
  try {
    const dir = path.dirname(require.resolve(`${platform}/package.json`));
    return path.join(dir, process.platform === "win32" ? "claude.exe" : "claude");
  } catch {
    throw new Error(`claude-cli: ${platform} is not installed. Run: ${INSTALL}`);
  }
}

/** Runs the pinned CLI with args in a throwaway config directory; resolves its exit code, output, and errors */
export function runClaude(args, { cwd = root } = {}) {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-claude-cli-"));
  try {
    const r = spawnSync(claudeBinary(), args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: config, HOME: config, USERPROFILE: config },
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error) throw r.error;
    return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
  } finally {
    fs.rmSync(config, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = runClaude(process.argv.slice(2), { cwd: process.cwd() });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exit(r.status);
}
