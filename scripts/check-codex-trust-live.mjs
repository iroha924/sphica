#!/usr/bin/env node
// Runs a package's `sphica doctor` against a temporary CODEX_HOME holding that package as the installed Codex plugin, and checks the
// "Codex hooks" row: all trusted, then one modified and one disabled. The trusted hashes are written from a template of Codex
// 0.160.0's canonical hook identity, not from doctor's code. On Windows the codex on PATH is npm's codex.cmd with its codex.js.
//
// Usage: node scripts/check-codex-trust-live.mjs [<package root>]   (default: plugin/, which `bun run bundle` builds)

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { root, tempVars, withTempDir } from "./lib/live-harness.mjs";

const windows = process.platform === "win32";
const source = path.resolve(process.argv[2] ?? path.join(root, "plugin"));
const LABELS = {
  SessionStart: "session_start",
  SubagentStart: "subagent_start",
  UserPromptSubmit: "user_prompt_submit",
  PostToolUse: "post_tool_use",
  Stop: "stop",
  Interrupt: "interrupt",
  PreToolUse: "pre_tool_use",
};

await withTempDir(async (dir) => {
  const version = JSON.parse(
    fs.readFileSync(path.join(source, ".claude-plugin", "plugin.json"), "utf8"),
  ).version;
  const codexHome = path.join(dir, "codex-home");
  const installed = path.join(codexHome, "plugins", "cache", "sphica", "sphica", version);
  fs.cpSync(source, installed, { recursive: true });
  const home = path.join(dir, "home");
  fs.mkdirSync(home);

  // Codex 0.160.0 hashes {event_name, hooks: [{async, command, timeout, type}], matcher?} with sorted keys; Sphica's hooks set
  // nothing else, and UserPromptSubmit, Stop, and Interrupt drop their matcher
  const hooks = JSON.parse(fs.readFileSync(path.join(installed, "hooks", "codex.json"), "utf8")).hooks;
  const entries = [];
  for (const [event, groups] of Object.entries(hooks))
    for (const [g, group] of groups.entries())
      for (const [i, h] of group.hooks.entries()) {
        const command = windows ? (h.commandWindows ?? h.command) : h.command;
        const matcher =
          group.matcher && !["UserPromptSubmit", "Stop", "Interrupt"].includes(event)
            ? `,"matcher":${JSON.stringify(group.matcher)}`
            : "";
        const identity = `{"event_name":"${LABELS[event]}","hooks":[{"async":false,"command":${JSON.stringify(command)},"timeout":${h.timeout},"type":"command"}]${matcher}}`;
        const hash = `sha256:${crypto.createHash("sha256").update(identity).digest("hex")}`;
        entries.push({ key: `sphica@sphica:hooks/codex.json:${LABELS[event]}:${g}:${i}`, hash });
      }
  const config = path.join(codexHome, "config.toml");
  const write = (edit = (e) => e) =>
    fs.writeFileSync(
      config,
      entries
        .map(edit)
        .map(
          (e) =>
            `[hooks.state."${e.key}"]\ntrusted_hash = "${e.hash}"\n${e.enabled === false ? "enabled = false\n" : ""}`,
        )
        .join("\n"),
    );
  write();

  // A codex that prints the verified version and records the CODEX_HOME it was given
  const bin = path.join(dir, "bin");
  const seen = path.join(dir, "codex-home-seen");
  const script = `require("node:fs").writeFileSync(${JSON.stringify(seen)}, process.env.CODEX_HOME ?? "");\nprocess.stdout.write("codex-cli 0.160.0\\n");\n`;
  if (windows) {
    const js = path.join(bin, "node_modules", "@openai", "codex", "bin", "codex.js");
    fs.mkdirSync(path.dirname(js), { recursive: true });
    fs.writeFileSync(js, script);
    // Never run: doctor starts the codex.js beside it through node, as a shell would through this shim
    fs.writeFileSync(path.join(bin, "codex.cmd"), "@exit /b 1\r\n");
  } else {
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "codex"), `#!${process.execPath}\n${script}`, { mode: 0o755 });
  }

  const env = {
    PATH: [bin, path.dirname(process.execPath)].join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
  };
  env.CODEX_HOME = codexHome;
  for (const k of ["SystemRoot", "SYSTEMROOT", "windir", "PATHEXT", "ComSpec", "LANG"])
    if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, tempVars(dir));
  const doctor = () => {
    const r = spawnSync(process.execPath, [path.join(installed, "dist", "cli.js"), "doctor"], {
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    if (r.error) throw r.error;
    return `${r.stdout}${r.stderr}`;
  };
  const failures = [];
  const trusted = doctor();
  if (
    !/✓ Codex hooks\s+\d+ of \d+ trusted/.test(trusted) ||
    !new RegExp(`${entries.length} of ${entries.length} trusted`).test(trusted)
  )
    failures.push(`expected all ${entries.length} Codex hooks trusted\n${trusted}`);
  if (fs.readFileSync(seen, "utf8") !== codexHome)
    failures.push("codex --version did not get the temporary CODEX_HOME");

  write((e, i) =>
    i === 0 ? { ...e, hash: `sha256:${"0".repeat(64)}` } : i === 1 ? { ...e, enabled: false } : e,
  );
  const changed = doctor();
  if (
    !new RegExp(
      `△ Codex hooks\\s+${entries.length - 1} of ${entries.length} trusted in [^\\n]+; 1 modified, 1 disabled\\. open /hooks in Codex`,
    ).test(changed)
  )
    failures.push(`expected 1 modified and 1 disabled Codex hook\n${changed}`);

  if (failures.length) {
    console.error(`codex trust: ${failures.length} failure(s)\n${failures.map((f) => `- ${f}`).join("\n")}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `codex trust: doctor read ${entries.length} hooks of ${path.basename(source)} through ${windows ? "npm's codex.cmd" : "codex"}`,
  );
});
