// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

export function mainCheckArgs(o: {
  tested: string | undefined;
  run: string | undefined;
  attempt: string | undefined;
  repo: string;
  apiRun:
    | { id: number; run_attempt: number; head_repository?: { full_name?: string } | null }
    | string
    | null;
  verdict: { run?: { id?: unknown; attempt?: unknown } } | null;
  file: string;
}): { args: string[]; reason: string };
