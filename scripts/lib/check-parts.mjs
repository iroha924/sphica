// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Decides whether the part jobs a required check stands for all succeeded. A required check passes when it is skipped, and a job after a
// failed need is skipped, so the check job runs always and fails here on anything but success. On a push to main the same-tree job runs
// the push's own checks and may find that the pull request already passed this tree; only then may the parts be skipped.

const DETECTOR = "same-tree";

/** What is wrong with the needs context for the event: each expected job must be there and have succeeded, and nothing else may be */
export function partProblems(needs, expected, event) {
  if (!needs || typeof needs !== "object" || Array.isArray(needs))
    return ["the needs context is not an object"];
  if (!expected.length) return ["no part job is expected"];
  if (event !== "push" && event !== "pull_request")
    return [`the event ${JSON.stringify(event)} is neither push nor pull_request`];
  const problems = [];
  const detector = needs[DETECTOR]?.result;
  let tested = false;
  if (detector === undefined) problems.push(`${DETECTOR} is not in needs`);
  else if (event === "push") {
    if (detector !== "success") problems.push(`${DETECTOR} ended ${detector}`);
    else tested = needs[DETECTOR].outputs?.tested === "true";
  } else if (detector !== "skipped") problems.push(`${DETECTOR} ended ${detector} on a pull request`);
  for (const name of expected) {
    const result = needs[name]?.result;
    if (result === undefined) problems.push(`${name} is not in needs`);
    else if (result !== "success" && !(tested && result === "skipped"))
      problems.push(`${name} ended ${result}`);
  }
  for (const name of Object.keys(needs))
    if (name !== DETECTOR && !expected.includes(name)) problems.push(`${name} is in needs but not expected`);
  return problems;
}
