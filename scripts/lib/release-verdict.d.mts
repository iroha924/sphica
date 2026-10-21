// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

import type { Verdict } from "./tarball-diff.mjs";

export interface WrittenVerdict extends Verdict {
  checkout: string;
  tree: string;
  base: string;
  tools: { node: string; bun: string | null; npm: string | null };
  run: { id: string | null; attempt: string | null };
}
export function writeVerdict(o: {
  packed: string;
  base: string;
  out: string;
  cwd: string;
  get?: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  env?: Record<string, string | undefined>;
}): Promise<WrittenVerdict>;
export interface Run {
  id: number;
  run_attempt: number;
  head_sha: string;
  event: string;
  path: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  head_repository?: { full_name?: string } | null;
}
export function latestRun(runs: Run[], o: { repo: string; head: string }): Run | string;
export function verdictMismatch(
  v: unknown,
  o: { run: Pick<Run, "id" | "run_attempt">; attempt: number | string; tree: string; version: string },
): string | null;
