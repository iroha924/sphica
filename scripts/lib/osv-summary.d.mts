// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

export type OsvSummary = { status: "found" | "none" | "unavailable"; count: number; markdown: string };
export function osvSummary(
  text: string | null | { code?: string },
  sha: string,
  scannerExit?: string,
): OsvSummary;
export function osvLine(summary: Pick<OsvSummary, "status" | "count">, sha: string): string;
