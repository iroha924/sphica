// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Which version check a push to main runs (scripts/main-version-check.mjs). When same-tree reused a pull request run, the jobs that
// compare the tarball are skipped, so that run's own verdict has to carry the decision; when it did not, those jobs run and decide.

/**
 * The arguments for scripts/check-mcp-version.mjs besides --base, and why. tested, run, and attempt are same-tree's outputs; apiRun is
 * the API's record of that run (or a string saying why it could not be read); verdict is its release-verdict artifact (or null); file
 * is where that artifact was saved. Anything that does not hold leaves no exemption: today's rule.
 */
export function mainCheckArgs({ tested, run, attempt, repo, apiRun, verdict, file }) {
  if (tested !== "true")
    return { args: ["--defer-deps"], reason: "the full jobs run on this push and compare the tarball" };
  const strict = (why) => ({ args: [], reason: `no exemption: ${why}` });
  if (typeof apiRun === "string" || !apiRun)
    return strict(`run ${run} could not be read (${apiRun ?? "no reply"})`);
  if (String(apiRun.id) !== String(run) || String(apiRun.run_attempt) !== String(attempt))
    return strict(
      `the API names run ${apiRun.id} attempt ${apiRun.run_attempt}, not ${run} attempt ${attempt}`,
    );
  if (apiRun.head_repository?.full_name !== repo)
    return strict(`run ${run} is not from ${repo}'s own branches`);
  if (!verdict) return strict(`run ${run} left no release verdict`);
  if (String(verdict.run?.id) !== String(run) || String(verdict.run?.attempt) !== String(attempt))
    return strict(`the verdict is not from run ${run} attempt ${attempt}`);
  return { args: ["--verdict", file], reason: `the verdict of run ${run} attempt ${attempt}` };
}
