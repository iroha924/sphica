export function runTestsIsolated(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; maxBuffer?: number; remove?: (dir: string) => void },
): { stdout: string; stderr: string; problems: string[]; dir: string };
