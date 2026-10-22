// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

export function claudeBinary(): string;
export function childEnv(
  config: string,
  env?: Record<string, string | undefined>,
): Record<string, string | undefined>;
export function runClaude(
  args: readonly string[],
  options?: { cwd?: string },
): { status: number; stdout: string; stderr: string };
