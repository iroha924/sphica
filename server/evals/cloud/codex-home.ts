// The CODEX_HOME the evaluation starts Codex with, for a run under test and for the grader alike: a link to the owner's login and the
// owner's model and effort, nothing else, so the owner's hooks, plugins, rules, and MCP servers reach neither. Also each Codex run's directory.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function isolatedCodexHome(codexHome: string, extraConfig = ""): void {
  const owner = path.join(os.homedir(), ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.symlinkSync(path.join(owner, "auth.json"), path.join(codexHome, "auth.json"));
  const settings = fs
    .readFileSync(path.join(owner, "config.toml"), "utf8")
    .split("\n")
    .filter((l) => /^(model|model_reasoning_effort)\s*=/.test(l))
    .join("\n");
  fs.writeFileSync(path.join(codexHome, "config.toml"), `${settings}\n${extraConfig}`);
}

// Parallel runs of one task and condition can start in the same millisecond: a random suffix tells them apart, and the directory is
// created without recursive so a collision fails instead of two runs sharing one directory
export function claimRunDir(out: string, prefix: string, now = new Date()): { run: string; dir: string } {
  const run = `${prefix}-${now.toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
  const dir = path.join(out, run);
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(dir);
  return { run, dir };
}
