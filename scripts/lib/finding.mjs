// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The one shape every check prints a failure in, so whoever hits it can fix the cause from the line alone: where, what broke, why the
// rule exists, and what to do instead. A part left empty throws, so a check cannot print a line that is missing one.

const PARTS = ["where", "what", "why", "fix"];

// A part may hold text from a file, a commit, or a tool: control characters become "?" so it cannot rewrite the terminal, and in a
// part, whitespace runs with line breaks become one space so it cannot start a line of its own
// oxlint-disable-next-line no-control-regex -- matches the control characters a part must not carry
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const flat = (text) => text.replace(/\s+/g, " ").replace(CONTROL, "?").trim().replace(/\.$/, "");

function required(parts, names) {
  if (!parts || typeof parts !== "object") throw new TypeError("a finding takes an object of parts");
  const out = {};
  for (const name of names) {
    const value = parts[name];
    if (typeof value !== "string" || !flat(value)) throw new TypeError(`a finding needs a non-empty ${name}`);
    out[name] = flat(value);
  }
  return out;
}

/** Every finding made here, so a string or a look-alike object cannot be printed as one */
const made = new WeakSet();

/**
 * One failure: where to look (`path:line`, a path, or the step that failed), what broke, why the rule exists (a clause, or the
 * invariant's name), and the fix or what to use instead. `detail` is tool output worth reading beside it, printed indented below.
 */
export function finding(parts) {
  const f = required(parts, PARTS);
  if (parts.detail !== undefined && typeof parts.detail !== "string")
    throw new TypeError("a finding's detail is a string when given");
  f.detail = parts.detail?.replace(/\r\n?/g, "\n").replace(CONTROL, "?").trimEnd() || undefined;
  made.add(Object.freeze(f));
  return f;
}

/** The message of a lint rule, whose location the linter prints: the same parts without `where` */
export function ruleMessage(parts) {
  const { what, why, fix } = required(parts, ["what", "why", "fix"]);
  return `${what}. Why: ${why}. Fix: ${fix}`;
}

/** The finding as text: one line, then the detail indented four spaces so it cannot be read as another finding */
export function formatFinding(f) {
  if (!made.has(f)) throw new TypeError(`only a finding prints as one, not ${JSON.stringify(f)}`);
  const line = `${f.where}: ${f.what}. Why: ${f.why}. Fix: ${f.fix}`;
  if (!f.detail) return line;
  return `${line}\n${f.detail
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n")}`;
}

/**
 * Prints the findings to stderr with a count after them and marks the process failed, or does nothing when there are none. The process
 * is left to end on its own so output still in the pipe is not cut off. Returns whether anything was reported.
 */
export function report(check, findings) {
  if (!findings.length) return false;
  const text = findings.map(formatFinding).join("\n");
  console.error(`${text}\n${check}: ${findings.length} finding(s)`);
  process.exitCode = 1;
  return true;
}

/** Thrown by a check that cannot go on after a failure; `runCheck` reports it */
export class CheckFailure extends Error {
  constructor(parts) {
    const f = finding(parts);
    super(f.what);
    this.finding = f;
  }
}

/** Stops the check here with this finding */
export function fail(parts) {
  throw new CheckFailure(parts);
}

/**
 * Runs a check's steps and reports what stops them: a CheckFailure as its finding, and any other error as one that names the crash.
 * The process exit code is set to 1 on either.
 */
export async function runCheck(check, main) {
  try {
    await main();
  } catch (error) {
    report(check, [crashFinding(check, error)]);
  }
}

/** A thrown error as a finding: a CheckFailure is its own, and anything else is the check crashing before it could decide */
export function crashFinding(check, error) {
  if (error instanceof CheckFailure) return error.finding;
  return finding({
    where: check,
    what: `the check crashed: ${error instanceof Error ? error.message : String(error)}`,
    why: "a check that stops before it decides proves nothing either way",
    fix: "read the stack below, fix the cause, and run the check again",
    detail: error instanceof Error ? error.stack : undefined,
  });
}
