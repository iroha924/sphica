export type EmbeddedPackage = {
  name: string;
  version: string;
  license: string;
  source: string;
  in: string;
  text: string;
};
export function embeddedPackages(dir?: string): { packages: EmbeddedPackage[]; problems: string[] };
export function markedPackages(text: string): Set<string>;
export function embeddedProblems(
  metas: Record<string, unknown>,
  read: (input: string) => string,
  listed: { name: string; version: string }[],
): string[];
