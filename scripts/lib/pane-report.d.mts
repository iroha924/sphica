// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

export const ALLOWED: Readonly<Record<"hooks" | "calls" | "state writes" | "state reads", readonly string[]>>;
export function reported(report: {
  contents?: readonly { notes?: readonly string[] }[];
}): Record<string, string[]>;
export function differences(got: Readonly<Record<string, readonly string[]>>): string[];
