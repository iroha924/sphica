export function gateProblems(input: {
  tag: string;
  commit: string;
  repo: string;
  versions: Record<string, string | undefined>;
  mainIsAncestor: boolean;
  tagCommit: string | null;
  published: boolean;
  pulls: unknown[];
  runs: unknown[];
}): { problems: string[]; pull: number | null };
export function reviewProblems(input: { commit: string; comments: unknown[]; threads: unknown[] }): string[];
