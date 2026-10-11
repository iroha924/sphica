// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The shape of what guards a fork's pull request before the owner approves it. Each function takes a file's text and returns what is
// wrong with it. They keep a step from being dropped by accident; whoever can edit the files can edit these checks too.

/** `gh pr checkout` and the two other names gh gives it: a deny rule matches a command only as it is written */
const CHECKOUT_DENY = ["Bash(gh pr checkout *)", "Bash(gh pr co *)", "Bash(gh co *)"];

/** @param {unknown} value */
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {string[]} keys */
const named = (keys) => (keys.length ? keys.join(", ") : "none");

/**
 * The project settings hold the checkout deny and nothing else, so a hook or an allow rule cannot arrive without this check changing too.
 * @param {string} text
 * @returns {string[]}
 */
export function settingsProblems(text) {
  let settings;
  try {
    settings = JSON.parse(text);
  } catch {
    return ["not JSON"];
  }
  if (!isRecord(settings)) return ["not an object"];
  const problems = [];
  const keys = Object.keys(settings);
  if (keys.length !== 1 || keys[0] !== "permissions")
    problems.push(`the only key must be permissions (found ${named(keys)})`);
  if (!isRecord(settings.permissions)) return [...problems, "permissions is not an object"];
  const inner = Object.keys(settings.permissions);
  if (inner.length !== 1 || inner[0] !== "deny")
    problems.push(`the only key of permissions must be deny (found ${named(inner)})`);
  const deny = settings.permissions.deny;
  if (!Array.isArray(deny)) return [...problems, "permissions.deny is not a list"];
  for (const rule of CHECKOUT_DENY) if (!deny.includes(rule)) problems.push(`permissions.deny lacks ${rule}`);
  for (const rule of deny)
    if (!CHECKOUT_DENY.includes(rule))
      problems.push(`permissions.deny holds a rule this check does not know: ${String(rule)}`);
  if (deny.length !== new Set(deny).size) problems.push("permissions.deny repeats a rule");
  return problems;
}
