// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Seeds one run of the claude plugin eval suite (server/evals/plugin/cases/): the tsundoku fixture database under HOME, where the plugin's hooks and MCP
// servers look for it, and the project's files as a git checkout in the working directory, whose origin names the fixture's project.
// The case scaffolds run it with the run's HOME and workspace: node server/evals/plugin/seed.ts [steps.json]
// steps.json holds acceptance steps a case adds after the fixture's own, such as a session to trace.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDriver } from "../acceptance/driver.ts";
import { loadAcceptance, type Step } from "../acceptance/load.ts";
import { fixtureSteps, rekey } from "../cloud/build-lib.ts";

const OWNER = "eval";
const REPO = "tsundoku";
const plan = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "..", "cloud", "tasks.json"), "utf8"),
) as Parameters<typeof fixtureSteps>[0] & { projects: { tsundoku: { current: Record<string, string> } } };

async function main() {
  const home = os.homedir();
  const cwd = process.cwd();
  // The eval gives each run a fresh HOME with an empty workspace at $HOME/cwd. Anywhere else this would write the owner's ~/.sphica and
  // commit over a checkout
  if (cwd !== path.join(home, "cwd") || fs.readdirSync(cwd).length)
    throw new Error("run only from a case scaffold, in the run's empty workspace at $HOME/cwd");
  const db = path.join(home, ".sphica", "sphica.db");
  if (fs.existsSync(db)) throw new Error(`${db} already exists`);
  fs.mkdirSync(path.dirname(db), { recursive: true });

  const extra = process.argv[2] ? (JSON.parse(fs.readFileSync(process.argv[2], "utf8")) as Step[]) : [];
  const { world } = loadAcceptance();
  const driver = await createDriver(world);
  try {
    for (const step of [...fixtureSteps(plan, false), ...extra]) await driver.run(step);
    await driver.snapshot(db);
  } finally {
    await driver.done();
  }
  await rekey(db, OWNER, REPO);

  for (const [rel, text] of Object.entries({ ...world.files, ...plan.projects.tsundoku.current })) {
    if (text === "BINARY" || text === "OVERSIZED") continue;
    fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    fs.writeFileSync(path.join(cwd, rel), text);
  }
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    `${JSON.stringify({ name: "tsundoku", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
  );
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@example.com", ...args], {
      cwd,
      stdio: "ignore",
    });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "tsundoku");
  git("remote", "add", "origin", `https://github.com/${OWNER}/${REPO}.git`);
}

await main();
