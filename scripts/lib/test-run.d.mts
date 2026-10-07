export function runTestsIsolated(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; maxBuffer?: number },
): { stdout: string; stderr: string; problems: string[]; dir: string };
