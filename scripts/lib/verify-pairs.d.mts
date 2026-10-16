// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

export function chain(line: unknown): string[] | null;
export function verifyProblems(files: {
  pkg: string;
  check: string;
  release: string;
  lychee: string | null;
}): string[];
