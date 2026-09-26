#!/usr/bin/env node
// Assembles the shipped files under plugin/. **plugin/ itself is the npm package root**:
// Claude Code installs it from the marketplace npm source, and Codex from the same tarball.
//
// **Generated files are not tracked by git.** They are built at publish time, so they are not compared with commits
// (plugin/dist used to be committed and checked with `git diff --exit-code`).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "plugin", "dist");
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });

// **Do not add --minify.** The CLI's own argument error messages are chosen by the exception class's constructor.name,
// so mangled class names fall back to stricli's default text.
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
for (const entry of ["mcp", "mcp-record", "capture", "deliver", "cli"]) {
  run("bun", ["build", `server/src/${entry}.ts`, "--target=node", "--outfile", `plugin/dist/${entry}.js`]);
}

// The plugin cache has no repository, so ship the schema (and migrations, if any).
const db = path.join(root, "plugin", "db");
fs.rmSync(db, { recursive: true, force: true });
fs.mkdirSync(db, { recursive: true });
fs.copyFileSync(path.join(root, "db", "schema.sql"), path.join(db, "schema.sql"));
if (fs.existsSync(path.join(root, "db", "migrations")))
  fs.cpSync(path.join(root, "db", "migrations"), path.join(db, "migrations"), { recursive: true });

// Shows the README on the npm package page. The source of truth is README.md at the repository root
fs.copyFileSync(path.join(root, "README.md"), path.join(root, "plugin", "README.md"));

// On Windows, npm reads the shebang to create a .cmd, so the file must be executable.
for (const entry of ["cli"]) fs.chmodSync(path.join(dist, `${entry}.js`), 0o755);

// **Bundling does not remove the obligation to include notices.** They are rebuilt from the current node_modules for every package.
run("node", ["scripts/third-party-notices.mjs"]);

const count = (dir) =>
  fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length;
console.log(
  `package: dist ${count(dist)} files / db ${count(db)} files (${path.relative(process.cwd(), path.join(root, "plugin"))} is the package root)`,
);
