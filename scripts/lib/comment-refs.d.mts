export function referenceProblems(
  source: string,
  kind: "js" | "sql",
): { line: number; text: string; reason: string }[];
