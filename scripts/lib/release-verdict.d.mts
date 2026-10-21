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
