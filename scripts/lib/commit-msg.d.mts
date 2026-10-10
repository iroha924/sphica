// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

export function commitMessageProblems(
  text: string,
  opts?: { merge?: boolean; hook?: boolean; commentChar?: string; cleanup?: string },
): string[];
