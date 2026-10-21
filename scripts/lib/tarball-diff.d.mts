// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

type Get = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
export interface Verdict {
  verdict: "same" | "differs" | "unknown";
  paths: string[];
  reason: string;
  npm: { name: string; version: string; integrity: string } | null;
}
export function verdictFor(o: {
  packed: string;
  name: string;
  version: string;
  work: string;
  get?: Get;
}): Promise<Verdict>;
