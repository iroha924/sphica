// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

export function gateProblems(input: {
  tag: string;
  commit: string;
  repo: string;
  versions: Record<string, string | undefined>;
  mainIsAncestor: boolean;
  tagCommit: string | null;
  published: boolean;
  pulls: unknown[];
  runs: unknown[];
}): { problems: string[]; pull: number | null };
export function reviewProblems(input: { threads: unknown[] }): string[];
