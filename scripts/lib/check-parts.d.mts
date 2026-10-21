// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

export function partProblems(
  needs: unknown,
  expected: readonly string[],
  event: unknown,
): { where: string; what: string; why: string; fix: string }[];
