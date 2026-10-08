// Runs the Biome the server pins on a fixture directory with that directory's own biome.json, so a drafted import check is judged by the
// linter the owner would paste it into.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";

const BIOME = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");
const RULE = "lint/style/noRestrictedImports";

type Diagnostic = {
  severity: string;
  message: string;
  category?: string;
  location: { path?: string; start?: { line: number } };
};
export type Restricted = { path: string; line: number; message: string };

/**
 * The restricted imports Biome reports under dir. Any other diagnostic, or a run that prints no report, throws: a broken config must not
 * read as a check that passed.
 */
export function restrictedImports(dir: string): Restricted[] {
  // An override's includes match only when the config path and the files share one spelling: /var and /private/var on macOS do not
  const real = fs.realpathSync(dir);
  const r = spawnSync(process.execPath, [BIOME, "lint", "--reporter=json", `--config-path=${real}`, "."], {
    cwd: real,
    encoding: "utf8",
  });
  let report: { diagnostics: Diagnostic[] };
  try {
    report = JSON.parse(r.stdout) as { diagnostics: Diagnostic[] };
  } catch {
    throw new Error(`biome printed no report (exit ${r.status}): ${r.stderr}`);
  }
  const other = report.diagnostics.filter((d) => d.category !== RULE);
  if (other.length)
    throw new Error(
      `biome reported ${other.map((d) => `${d.category ?? d.severity}: ${d.message}`).join("; ")}`,
    );
  return report.diagnostics.map((d) => ({
    path: d.location.path ?? "",
    line: d.location.start?.line ?? 0,
    message: d.message,
  }));
}
