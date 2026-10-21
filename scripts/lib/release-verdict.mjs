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

const CHECK_YML = ".github/workflows/check.yml";

/**
 * The latest check.yml pull_request run on head from this repository's own branches, or a string saying why there is none to rely on.
 * A run from a fork never counts: its artifact was written by code nobody approved yet.
 */
export function latestRun(runs, { repo, head }) {
  const own = runs.filter(
    (r) =>
      r.head_sha === head &&
      r.event === "pull_request" &&
      r.path === CHECK_YML &&
      r.head_repository?.full_name === repo,
  );
  if (!own.length) return `no check.yml pull request run on ${head.slice(0, 12)} from ${repo}`;
  const started = (r) => Date.parse(r.created_at);
  if (own.some((r) => Number.isNaN(started(r)))) return "a run has no readable start time";
  const [latest, next] = [...own].sort((a, b) => started(b) - started(a));
  if (next && started(next) === started(latest)) return "two runs started at the same time";
  if (latest.status !== "completed") return `the latest run ${latest.id} is ${latest.status}`;
  if (latest.conclusion !== "success") return `the latest run ${latest.id} ended ${latest.conclusion}`;
  return latest;
}

/**
 * Why the verdict cannot stand for this run, tree, and release version, or null when it can. attempt is the attempt whose artifact it
 * came from: re-running only failed jobs reuses an earlier attempt's comparison, so any attempt up to the run's latest can hold it.
 */
export function verdictMismatch(v, { run, attempt, tree, version }) {
  if (v?.verdict !== "same") return `the verdict is ${v?.verdict ?? "missing"}: ${v?.reason ?? "no reason"}`;
  if (
    String(v.run?.id) !== String(run.id) ||
    String(v.run?.attempt) !== String(attempt) ||
    !(Number(attempt) >= 1 && Number(attempt) <= Number(run.run_attempt))
  )
    return `the verdict is not from run ${run.id} attempt ${attempt}`;
  if (v.tree !== tree) return "the verdict is for another tree";
  if (v.npm?.version !== version)
    return `the verdict compared with ${v.npm?.version ?? "no release"}, not ${version}`;
  return null;
}

/** Text from the pull request (shipped paths, tar's messages) as one line with Markdown's characters escaped, for the log and the summary */
const plain = (text) =>
  JSON.stringify(String(text))
    .slice(1, -1)
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029")
    .replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, "\\$&");

/** The verdict as the one line the CI log and job summary show */
export function verdictLine(v) {
  const against = v.npm ? `${v.npm.name}@${v.npm.version}` : "the base release";
  const paths = v.paths.length ? ` (${v.paths.map(plain).join(", ")})` : "";
  return `release verdict: ${v.verdict} against ${against}: ${plain(v.reason)}${paths}`;
}
