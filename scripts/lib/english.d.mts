export const JAPANESE: RegExp;
export function englishProblems(
  source: string,
  mode: "all" | "comments",
): { line: number; text: string; reason: string }[];
export function commentLines(source: string): { line: number; text: string }[];
