// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Whether a push to main repeats a pull request run that already passed. GitHub tests a pull request as the merge of its head into
// main at that time; main only moves forward, so when the old main is an ancestor of the head, that test had the head's tree. A merge
// commit with the head's tree, whose first parent was main before the push, therefore has the tree the head's last run tested.

/** The pull_request trigger, limited to main, as check.yml writes it; a head without it may have been tested against another base */
export const PR_TO_MAIN = "  pull_request:\n    branches: [main]\n";
const CHECK_YML = ".github/workflows/check.yml";

/**
 * Whether the workflow's one top-level `on:` block holds a pull_request trigger whose only setting is `branches: [main]`. Any other
 * spelling (a quoted key, flow style, a second `on`) reads as not limited, which only keeps the heavy jobs running.
 */
export function limitsPullRequestsToMain(workflow) {
  const lines = workflow.split("\n");
  const top = lines.flatMap((l, i) => (/^[^\s#]/.test(l) ? [i] : []));
  const on = top.filter((i) => /^["']?on["']?\s*:/.test(lines[i] ?? ""));
  if (on.length !== 1 || lines[on[0] ?? -1] !== "on:") return false;
  const start = on[0] ?? 0;
  const end = top.find((i) => i > start) ?? lines.length;
  const block = lines.slice(start + 1, end).filter((l) => !/^\s*(#.*)?$/.test(l));
  const triggers = block.filter((l) => /^ {2}\S/.test(l));
  if (triggers.filter((l) => l.includes("pull_request")).length !== 1) return false;
  const at = block.indexOf("  pull_request:");
  if (at === -1) return false;
  const settings = [];
  for (let k = at + 1; k < block.length && /^ {4}/.test(block[k] ?? ""); k++) settings.push(block[k]);
  return settings.length === 1 && settings[0] === "    branches: [main]";
}

/**
 * facts: parents (of the pushed commit), before (main before the push), ancestor (whether parents[0] is an ancestor of parents[1]),
 * tree and headTree (of the pushed commit and of parents[1]), workflow (parents[1]'s check.yml, or null), runs (the check.yml
 * pull_request runs the API listed for parents[1], or a string saying why they could not be read).
 */
export function sameTree({ parents, before, ancestor, tree, headTree, workflow, runs }) {
  const no = (reason) => ({ tested: false, reason });
  if (parents.length !== 2)
    return no(`the pushed commit has ${parents.length} parent(s), not a merge of two`);
  const [base, head] = parents;
  if (base !== before) return no("its first parent is not main before the push");
  if (!ancestor) return no("main before the push is not an ancestor of the merged head");
  if (!tree || tree !== headTree) return no("its tree differs from the merged head's");
  if (typeof workflow !== "string" || !limitsPullRequestsToMain(workflow))
    return no("the merged head's check.yml does not limit pull request runs to main");
  if (typeof runs === "string") return no(`the head's runs could not be read: ${runs}`);
  const own = runs.filter((r) => r.head_sha === head && r.event === "pull_request" && r.path === CHECK_YML);
  if (!own.length) return no("no check.yml pull request run on the merged head");
  const order = (r) => [Date.parse(r.created_at), r.run_attempt];
  // Unordered candidates cannot tell which run is the latest
  if (own.some((r) => Number.isNaN(order(r)[0])))
    return no("a run on the merged head has no readable start time");
  const sorted = [...own].sort((a, b) => {
    const [x, y] = [order(a), order(b)];
    return y[0] - x[0] || y[1] - x[1];
  });
  const [latest, next] = sorted;
  if (next && order(next)[0] === order(latest)[0] && order(next)[1] === order(latest)[1])
    return no("two runs on the merged head started at the same time");
  if (latest.status !== "completed") return no(`the latest run on the merged head is ${latest.status}`);
  if (latest.conclusion !== "success")
    return no(`the latest run on the merged head ended ${latest.conclusion}`);
  return {
    tested: true,
    reason: `run ${latest.id} passed on the merged head ${head.slice(0, 12)} with this tree`,
  };
}

/** The runs in an API reply, or a string saying why the reply is not one */
export function runsFrom(reply) {
  const list = reply?.workflow_runs;
  if (!Array.isArray(list)) return "the reply has no workflow_runs list";
  if (typeof reply.total_count !== "number" || reply.total_count > list.length)
    return `the reply lists ${list.length} of ${reply.total_count} runs`;
  for (const r of list)
    if (
      typeof r?.id !== "number" ||
      typeof r.head_sha !== "string" ||
      typeof r.event !== "string" ||
      typeof r.status !== "string" ||
      typeof r.created_at !== "string" ||
      typeof r.run_attempt !== "number" ||
      typeof r.path !== "string" ||
      !(typeof r.conclusion === "string" || r.conclusion === null)
    )
      return "a run in the reply lacks a field";
  return list;
}
