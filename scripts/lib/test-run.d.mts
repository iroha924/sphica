// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

export function runTestsIsolated(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; maxBuffer?: number; remove?: (dir: string) => void },
): { stdout: string; stderr: string; problems: string[]; dir: string };
