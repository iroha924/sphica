// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Writes whether the packed tarball ships the same files as the release the base commit names (scripts/lib/tarball-diff.mjs), with
// what it compared, so a later step or job can tell which tree, base, and run the verdict belongs to.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verdictFor } from "./tarball-diff.mjs";

const toolVersion = (program) => {
  try {
    return execFileSync(program, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};

/**
 * Compares packed with the release named by plugin/package.json at base in the repository at cwd, writes the verdict to out, and
 * returns it. get is fetch, or a stand-in in tests; env gives the run (GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT).
 */
export async function writeVerdict({ packed, base, out, cwd, get = fetch, env = process.env }) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const baseSha = git("rev-parse", `${base}^{commit}`);
  const pkg = JSON.parse(git("show", `${baseSha}:plugin/package.json`));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "release-verdict-"));
  let result;
  try {
    result = await verdictFor({ packed, name: pkg.name, version: pkg.version, work, get });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  const verdict = {
    ...result,
    checkout: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    base: baseSha,
    tools: { node: process.version, bun: toolVersion("bun"), npm: toolVersion("npm") },
    run: { id: env.GITHUB_RUN_ID ?? null, attempt: env.GITHUB_RUN_ATTEMPT ?? null },
  };
  fs.writeFileSync(out, `${JSON.stringify(verdict, null, 2)}\n`);
  return verdict;
}
