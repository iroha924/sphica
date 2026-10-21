// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

export type Run = {
  id: number;
  head_sha: string;
  event: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  run_attempt: number;
  path: string;
};
export const PR_TO_MAIN: string;
export function limitsPullRequestsToMain(workflow: string): boolean;
export function sameTree(facts: {
  parents: string[];
  before: string;
  ancestor: boolean;
  tree: string | null;
  headTree: string | null;
  workflow: string | null;
  runs: Run[] | string;
}): { tested: boolean; reason: string; run?: { id: number; attempt: number } };
export function runsFrom(reply: unknown): Run[] | string;
