// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

export const ALLOWED: Readonly<Record<"hooks" | "calls" | "state writes" | "state reads", readonly string[]>>;
export type Reported = { register: Record<string, string[]>; others: string[] };
export function reported(report: { contents?: readonly { notes?: readonly string[] }[] }): Reported;
export function differences(got: Reported): string[];
