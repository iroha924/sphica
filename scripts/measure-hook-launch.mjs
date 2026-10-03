#!/usr/bin/env node
// Measures how long the hook bundles take to start: run directly (as an exec-form hook does) and through the shell a shell-form
// hook uses (PowerShell on Windows without Git Bash, sh elsewhere). Prints medians; it never fails on the numbers.
//
// Usage: node scripts/measure-hook-launch.mjs [--pairs 20] [--root plugin]

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const pairs = Number(arg("pairs", "20"));
const root = path.resolve(arg("root", path.join(repo, "plugin")));
const windows = process.platform === "win32";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-launch-"));
// The hooks must not read or write the owner's ~/.sphica
const env = { ...process.env, HOME: home, USERPROFILE: home };
delete env.SPHICA_DB;
delete env.SPHICA_HOME;
const input = JSON.stringify({
  session_id: "measure",
  hook_event_name: "PreToolUse",
  tool_name: "Read",
  tool_input: { file_path: path.join(home, "none.ts") },
  cwd: home,
});

const launch = (mode, script) => {
  const [cmd, args] =
    mode === "direct"
      ? [process.execPath, [script]]
      : windows
        ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `node "${script}"`]]
        : ["sh", ["-c", `node "${script}"`]];
  const start = process.hrtime.bigint();
  const r = spawnSync(cmd, args, { input, env, cwd: home, encoding: "utf8", timeout: 30_000 });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  if (r.error || r.status !== 0)
    throw new Error(`${mode} ${script}: ${r.error?.message ?? `exit ${r.status}`}`);
  return ms;
};
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

try {
  const shell = windows ? "powershell" : "sh";
  for (const name of ["deliver", "capture"]) {
    const script = path.join(root, "dist", `${name}.js`);
    for (let i = 0; i < 3; i++) launch("direct", script);
    for (let i = 0; i < 3; i++) launch("shell", script);
    const direct = [];
    const viaShell = [];
    for (let i = 0; i < pairs; i++) {
      // Alternate which goes first so a drift in machine load falls on both sides
      if (i % 2) {
        viaShell.push(launch("shell", script));
        direct.push(launch("direct", script));
      } else {
        direct.push(launch("direct", script));
        viaShell.push(launch("shell", script));
      }
    }
    const d = median(direct);
    const s = median(viaShell);
    console.log(
      `launch ${name}.js (${process.platform}, ${pairs} pairs): direct median ${d.toFixed(1)} ms, through ${shell} median ${s.toFixed(1)} ms, difference ${(s - d).toFixed(1)} ms`,
    );
  }
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
