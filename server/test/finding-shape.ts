// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The shape scripts/lib/finding.mjs prints a check's failures in, held against what a check script really printed
import assert from "node:assert/strict";

/** One finding: where, what broke, why, and the fix, each part non-empty */
const LINE = /^(\S.*?): (\S.*?)\. Why: (\S.*?)\. Fix: (\S.*)$/;
/** Tool output under a finding, indented so it cannot be read as one */
const DETAIL = /^ {4}/;
/** The count report() closes with */
const COUNT = /^[\w :.-]+: \d+ finding\(s\)$/;

/**
 * Asserts that stderr holds at least one finding and that every line is a finding, its detail, or the count. With `after`, lines before
 * the first finding are a tool's own output (markdownlint, lychee) and are left as they are.
 */
export function assertFindings(stderr: string, label: string, { after = false } = {}): void {
  const lines = stderr.replace(/\n+$/, "").split("\n");
  const first = lines.findIndex((l) => LINE.test(l));
  assert.ok(first !== -1, `${label}: no finding line in\n${stderr}`);
  if (!after) assert.equal(first, 0, `${label}: output before the first finding:\n${stderr}`);
  for (const line of lines.slice(first))
    assert.ok(
      LINE.test(line) || DETAIL.test(line) || COUNT.test(line),
      `${label}: a line is neither a finding, its detail, nor the count: ${JSON.stringify(line)}`,
    );
  assert.match(lines.at(-1) ?? "", COUNT, `${label}: the output does not end with the count`);
}
