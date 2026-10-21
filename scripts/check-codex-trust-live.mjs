#!/usr/bin/env node
// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

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
import { fail, finding, report, runCheck } from "./lib/finding.mjs";
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

const failures = [];
// What doctor reads: the trust state Codex keeps for each hook in config.toml
const TRUST = "server/src/codex-trust.ts";
const ROW =
  "doctor's Codex hooks row is how the owner learns that Codex will not run a hook it no longer trusts";

await runCheck("codex trust", () =>
  withTempDir(async (dir) => {
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
      if (r.error)
        fail({
          where: "codex trust: sphica doctor",
          what: `doctor could not run: ${r.error.message}`,
          why: "the Codex hooks row can only be read from a doctor that ran",
          fix: "run `bun run bundle` so the package has dist/cli.js, then check that doctor ends within 60 seconds",
        });
      return `${r.stdout}${r.stderr}`;
    };
    const trusted = doctor();
    if (
      !/✓ Codex hooks\s+\d+ of \d+ trusted/.test(trusted) ||
      !new RegExp(`${entries.length} of ${entries.length} trusted`).test(trusted)
    )
      failures.push(
        finding({
          where: "codex trust: doctor with every hook trusted",
          what: `doctor does not show all ${entries.length} Codex hooks trusted`,
          why: ROW,
          fix: `compare how ${TRUST} hashes a hook with Codex's identity above ({event_name, hooks, matcher?} with sorted keys)`,
          detail: trusted,
        }),
      );
    if (fs.readFileSync(seen, "utf8") !== codexHome)
      failures.push(
        finding({
          where: "codex trust: codex --version",
          what: "doctor did not start codex with the CODEX_HOME it reads",
          why: "doctor must ask the same Codex home whose trust state it reads, or the row describes another install",
          fix: "pass the environment doctor was given when server/src/plugin.ts starts codex --version",
        }),
      );

    write((e, i) =>
      i === 0 ? { ...e, hash: `sha256:${"0".repeat(64)}` } : i === 1 ? { ...e, enabled: false } : e,
    );
    const changed = doctor();
    if (
      !new RegExp(
        `△ Codex hooks\\s+${entries.length - 1} of ${entries.length} trusted in [^\\n]+; 1 modified, 1 disabled\\. open /hooks in Codex`,
      ).test(changed)
    )
      failures.push(
        finding({
          where: "codex trust: doctor with one hook modified and one disabled",
          what: "doctor does not show 1 modified and 1 disabled Codex hook with the advice to open /hooks",
          why: ROW,
          fix: `check how ${TRUST} tells a changed hash and enabled = false apart, and the Codex hooks row in server/src/plugin.ts`,
          detail: changed,
        }),
      );

    if (!failures.length)
      console.log(
        `codex trust: doctor read ${entries.length} hooks of ${path.basename(source)} through ${windows ? "npm's codex.cmd" : "codex"}`,
      );
  }),
);
// Outside the steps, so what they found before doctor failed to run is reported too
report("codex trust", failures);
