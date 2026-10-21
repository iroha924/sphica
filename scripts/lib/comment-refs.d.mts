// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

export const REFERENCE_RULE: { why: string; fix: string };
export function referenceProblems(
  source: string,
  kind: "js" | "sql",
): { line: number; text: string; reason: string }[];
