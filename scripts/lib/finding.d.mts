// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

export interface FindingParts {
  where: string;
  what: string;
  why: string;
  fix: string;
  detail?: string | undefined;
}

export interface Finding {
  readonly where: string;
  readonly what: string;
  readonly why: string;
  readonly fix: string;
  readonly detail: string | undefined;
}

export function finding(parts: FindingParts): Finding;
export function ruleMessage(parts: Omit<FindingParts, "where" | "detail">): string;
export function formatFinding(f: Finding): string;
export function report(check: string, findings: readonly Finding[]): boolean;
export class CheckFailure extends Error {
  constructor(parts: FindingParts);
  readonly finding: Finding;
}
export function fail(parts: FindingParts): never;
export function guard(check: string, collected?: () => readonly Finding[]): void;
export function crashFinding(check: string, error: unknown): Finding;
