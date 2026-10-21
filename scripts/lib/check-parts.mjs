// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Decides whether the part jobs a required check stands for all succeeded. A required check passes when it is skipped, and a job after a
// failed need is skipped, so the check job runs always and fails here on anything but success. On a push to main the same-tree job runs
// the push's own checks and may find that the pull request already passed this tree; only then may the parts be skipped.

const DETECTOR = "same-tree";

const WORKFLOW = ".github/workflows/check.yml (the check job)";
const SHAPE = {
  where: WORKFLOW,
  why: "the required check can only vouch for the parts it reads from the needs context",
  fix: "pass toJSON(needs) as NEEDS and github.event_name as EVENT in the check job of .github/workflows/check.yml",
};
const LIST = {
  where: WORKFLOW,
  why: "a part missing from the list would let its failure go unchecked, and an extra one has no rule for skipping",
  fix: "make the check job's needs in .github/workflows/check.yml and the jobs passed to check-parts.mjs name the same parts",
};
const PART = {
  why: "the required checks pass only when every part they stand for succeeded",
  fix: "open the part's log in the same run, fix what failed, and push again (or rerun it if it was cancelled)",
};

/**
 * What is wrong with the needs context for the event, each with where to look, why, and the fix: each expected job must be there and have succeeded,
 * and nothing else may be
 */
export function partProblems(needs, expected, event) {
  if (!needs || typeof needs !== "object" || Array.isArray(needs))
    return [{ what: "the needs context is not an object", ...SHAPE }];
  if (!expected.length) return [{ what: "no part job is expected", ...LIST }];
  if (event !== "push" && event !== "pull_request")
    return [{ what: `the event ${JSON.stringify(event)} is neither push nor pull_request`, ...SHAPE }];
  const problems = [];
  const detector = needs[DETECTOR]?.result;
  let tested = false;
  if (detector === undefined) problems.push({ what: `${DETECTOR} is not in needs`, ...LIST });
  else if (event === "push") {
    if (detector !== "success")
      problems.push({
        where: `the ${DETECTOR} job of this run`,
        what: `${DETECTOR} ended ${detector}`,
        why: "on a push to main it runs the push's own checks and decides whether the parts may be skipped",
        fix: `open the ${DETECTOR} job's log in the same run and fix what failed`,
      });
    else tested = needs[DETECTOR].outputs?.tested === "true";
  } else if (detector !== "skipped")
    problems.push({
      where: WORKFLOW,
      what: `${DETECTOR} ended ${detector} on a pull request`,
      why: "only a push to main may skip the parts, so on a pull request the detector must not run",
      fix: `restore the condition that skips the ${DETECTOR} job on pull requests in .github/workflows/check.yml`,
    });
  for (const name of expected) {
    const result = needs[name]?.result;
    if (result === undefined) problems.push({ what: `${name} is not in needs`, ...LIST });
    else if (result !== "success" && !(tested && result === "skipped"))
      problems.push({ where: `the ${name} job of this run`, what: `${name} ended ${result}`, ...PART });
  }
  for (const name of Object.keys(needs))
    if (name !== DETECTOR && !expected.includes(name))
      problems.push({ what: `${name} is in needs but not expected`, ...LIST });
  return problems;
}
