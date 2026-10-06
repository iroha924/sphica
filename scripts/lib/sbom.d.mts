export function sbomProblems(noticesText: string, bom: unknown): string[];
type Embedded = { name: string; version: string; license: string; in: string };
type Bom = {
  bomFormat: "CycloneDX";
  components: Record<string, unknown>[];
  dependencies?: { ref: string; dependsOn?: string[] }[];
};
export function withEmbedded(bom: unknown, packages: Embedded[]): Bom;
export function embeddedBom(packages: Omit<Embedded, "in">[]): Bom & { specVersion: string; version: number };
