// A CODEX_HOME holding an installed Sphica 0.6.30 and the config.toml Codex 0.160.0 wrote after trusting its hooks, and a codex first
// on PATH that prints a version and records the CODEX_HOME it was given. POSIX only (a shebang script); verify does not run on Windows.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "codex-trust");

export type FakeCodex = { home: string; config: string; bin: string; seen: string };

export function fakeCodex(version = "0.160.0"): FakeCodex {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-fake-codex-"));
  const home = path.join(dir, "codex-home");
  const root = path.join(home, "plugins", "cache", "sphica", "sphica", "0.6.30");
  for (const d of [".claude-plugin", ".codex-plugin", "hooks"])
    fs.mkdirSync(path.join(root, d), { recursive: true });
  const manifest = { name: "sphica", version: "0.6.30", hooks: "./hooks/codex.json" };
  fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, ".codex-plugin", "plugin.json"), JSON.stringify(manifest));
  fs.copyFileSync(path.join(FIXTURES, "codex-0.6.30.json"), path.join(root, "hooks", "codex.json"));
  const config = path.join(home, "config.toml");
  fs.copyFileSync(path.join(FIXTURES, "config-0.160.0.toml"), config);
  const bin = path.join(dir, "bin");
  const seen = path.join(dir, "codex-home-seen");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "codex"),
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(seen)}, process.env.CODEX_HOME ?? "");\nprocess.stdout.write("codex-cli ${version}\\n");\n`,
    { mode: 0o755 },
  );
  return { home, config, bin, seen };
}
