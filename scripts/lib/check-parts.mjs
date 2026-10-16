// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Decides whether the part jobs a required check stands for all succeeded. A required check passes when it is skipped, and a job after a
// failed need is skipped, so the check job runs always and fails here on anything but success.

/** What is wrong with the needs context: each expected job must be there and have succeeded, and nothing else may be */
export function partProblems(needs, expected) {
  if (!needs || typeof needs !== "object" || Array.isArray(needs))
    return ["the needs context is not an object"];
  if (!expected.length) return ["no part job is expected"];
  const problems = [];
  for (const name of expected) {
    const result = needs[name]?.result;
    if (result === undefined) problems.push(`${name} is not in needs`);
    else if (result !== "success") problems.push(`${name} ended ${result}`);
  }
  for (const name of Object.keys(needs))
    if (!expected.includes(name)) problems.push(`${name} is in needs but not expected`);
  return problems;
}
