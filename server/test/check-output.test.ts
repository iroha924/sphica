// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Every check script run on a copy of the repository with one thing broken, so each failure it prints is held against the one shape:
// where, what broke, why, and the fix. The copy is a fresh git repository of the working tree's files, sharing server/node_modules.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { assertFindings } from "./finding-shape.ts";
import { tempDir } from "./temp-dir.ts";

const REPO = path.join(import.meta.dirname, "..", "..");

/** The environment with none of git's own variables, so no git call here can reach the repository this runs in */
const cleanEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
  delete env.SPHICA_DB;
  delete env.SPHICA_HOME;
  delete env.CODEX_HOME;
  return env;
};
/** The files a commit of the working tree would hold: tracked ones and new ones git does not ignore */
const TRACKED = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
  cwd: REPO,
  encoding: "utf8",
  env: cleanEnv(),
})
  .split("\0")
  // node_modules is linked into the copy below; as a link of its own it is a file git does not ignore
  .filter((f) => f && !/(?:^|\/)node_modules(?:\/|$)/.test(f));

/** A copy of the tracked files with `edit` applied, made a git repository of its own after the edit so new files are tracked */
function copy(edit: (root: string) => void): string {
  const root = path.join(tempDir("sphica-check-output-"), "repo");
  for (const file of TRACKED) {
    const from = path.join(REPO, file);
    const to = path.join(root, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const stat = fs.lstatSync(from, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else fs.copyFileSync(from, to);
  }
  fs.symlinkSync(
    path.join(REPO, "server", "node_modules"),
    path.join(root, "server", "node_modules"),
    "junction",
  );
  edit(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, env: cleanEnv(), stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  return root;
}

const write = (root: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const append = (root: string, rel: string, text: string) => fs.appendFileSync(path.join(root, rel), text);
const HEADER = "// Copyright (c) 2026 iroha924 and contributors\n// SPDX-License-Identifier: MIT\n";

/** Runs a script of the copy and asserts that it failed and printed only findings */
function fails(
  root: string,
  script: string,
  { args = [] as string[], env = {} as NodeJS.ProcessEnv, timeout = 50_000 } = {},
) {
  const r = spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], {
    cwd: root,
    env: { ...cleanEnv(), ...env },
    encoding: "utf8",
    timeout,
  });
  assert.equal(r.status, 1, `${script} exited ${r.status}\n${r.stdout}${r.stderr}`);
  assertFindings(r.stderr, script);
  return r.stderr;
}

// Old and banned spellings are put together here, so this file does not hold them
const OLD_NAME = ["mi", "tos"].join("");
const JAPANESE = "日本語";

test("the static checks print each failure as a finding", () => {
  const root = copy((r) => {
    write(r, "scripts/zz-dup.json", '{\n  "a": 1,\n  "a": 2\n}\n');
    write(r, "scripts/zz-no-header.mjs", "export const a = 1;\n");
    append(
      r,
      "db/schema.sql",
      `-- see ${["issue #", "12"].join("")}\ncreate table zz (a text unique on conflict ${["re", "place"].join("")});\n`,
    );
    write(
      r,
      "scripts/zz-japanese.mjs",
      `${HEADER}export const a = "${JAPANESE}";\n// english-exempt: nothing follows\nexport const b = 1;\n`,
    );
    write(r, "docs-zz.md", `# ${OLD_NAME}\n\n[x]()\n\n[y](missing-zz.md)\n`);
    write(r, ".claude/rules/zz.md", "# Always\n");
    append(r, "AGENTS.md", "\nSee .claude/rules for more.\n");
    fs.writeFileSync(
      path.join(r, "mise.toml"),
      fs.readFileSync(path.join(r, "mise.toml"), "utf8").replace(/^bun = "[^"]+"$/m, 'bun = "0.0.1"'),
    );
  });
  const json = fails(root, "check-json-keys.mjs");
  assert.match(json, /^scripts\/zz-dup\.json:3: "a" appears a second time/m);
  assert.match(fails(root, "check-license-headers.mjs"), /^scripts\/zz-no-header\.mjs:1: /m);
  assert.match(fails(root, "check-sql.mjs"), /^db\/schema\.sql:\d+: REPLACE is used\./m);
  assert.match(
    fails(root, "check-comments.mjs"),
    /^db\/schema\.sql:\d+: the comment points at an issue number/m,
  );
  const english = fails(root, "check-english.mjs");
  assert.match(english, /^scripts\/zz-japanese\.mjs:3: Japanese text: /m);
  assert.match(english, /^scripts\/zz-japanese\.mjs:4: an english-exempt marker has no Japanese/m);
  assert.match(fails(root, "check-naming.mjs"), /^docs-zz\.md:1: the old tool name remains/m);
  assert.match(fails(root, "check-rule-scopes.mjs"), /^\.claude\/rules\/zz\.md: the rule has no paths/m);
  assert.match(fails(root, "check-ai-config.mjs"), /^AGENTS\.md: the file mentions \.claude\/rules/m);
  assert.match(
    fails(root, "check-pairs.mjs"),
    /^package\.json: packageManager is bun@[^,]+, but mise\.toml pins bun 0\.0\.1/m,
  );
  assert.match(
    fails(root, "check-markdown.mjs"),
    /markdownlint found Markdown that renders or links wrong.+\n {4}\S/,
  );
  // lychee's report is the detail; without lychee on PATH the one finding says so
  assert.match(
    fails(root, "check-links.mjs"),
    /^lychee(?: \(each link below\))?: lychee (?:found broken links|is not on PATH)/m,
  );
});

test("a manifest that does not parse is named in the AI config check's finding", () => {
  const root = copy((r) => append(r, "plugin/hooks/codex.json", "}"));
  assert.match(
    fails(root, "check-ai-config.mjs"),
    /^plugin\/hooks\/codex\.json: the file is not valid JSON: /m,
  );
});

test("the architecture check prints each failure as a finding", () => {
  const root = copy((r) => {
    write(r, "server/src/stray.ts", `${HEADER}import { exec } from "node:child_process";\nexec("ls");\n`);
    append(r, "server/src/mcp.ts", '\nimport "./db-write.ts";\n');
  });
  const out = fails(root, "check-architecture.mjs");
  assert.match(out, /^server\/src\/stray\.ts: the module loads node:child_process/m);
  assert.match(out, /^server\/src\/mcp\.ts: the read server reaches the write connection/m);
});

test("the checks that take a file, a message, or the CI context print each failure as a finding", () => {
  const root = copy(() => {});
  // What fails before a check gets going: a message file that is not there, and an option without its value
  assert.match(
    fails(root, "check-commit-msg.mjs", { args: [path.join(root, "..", "absent.txt")] }),
    /^commit messages: the check crashed: ENOENT/m,
  );
  assert.match(
    fails(root, "check-mcp-version.mjs", { args: ["--base"] }),
    /^version: the check crashed: Option '--base <value>' argument missing/m,
  );
  const message = path.join(root, "..", "msg.txt");
  fs.writeFileSync(message, `feat: ${JAPANESE}\n\nbody\n`);
  assert.match(
    fails(root, "check-commit-msg.mjs", { args: [message] }),
    /^this commit ".*": the message holds Japanese/m,
  );
  const sbom = path.join(root, "..", "sbom.json");
  fs.writeFileSync(sbom, '{"bomFormat":"SPDX"}');
  // The notices table is built by the bundle, which the copy has not run
  assert.match(
    fails(root, "check-sbom.mjs", { args: [sbom] }),
    /^plugin\/THIRD_PARTY_NOTICES\.md: the file cannot be read: .+ Fix: run `bun run bundle`/m,
  );
  write(
    root,
    "plugin/THIRD_PARTY_NOTICES.md",
    "| package | version | license |\n|---|---|---|\n| zod | 4.6.5 | MIT |\n",
  );
  assert.match(
    fails(root, "check-sbom.mjs", { args: [sbom] }),
    /^.+sbom\.json: the SBOM is not CycloneDX JSON/m,
  );
  fs.writeFileSync(sbom, "{");
  assert.match(fails(root, "check-sbom.mjs", { args: [sbom] }), /^.+sbom\.json: the SBOM is not JSON: /m);
  assert.match(fails(root, "check-sbom.mjs"), /^node scripts\/check-sbom\.mjs: no SBOM path was given/m);
  assert.match(
    fails(root, "check-parts.mjs", { args: ["part"], env: { NEEDS: "not json", EVENT: "push" } }),
    /the needs context is not an object/,
  );
  assert.match(
    fails(root, "run-unit.mjs", { env: { SPHICA_UNIT_MODE: "fast" } }),
    /^SPHICA_UNIT_MODE: SPHICA_UNIT_MODE is "fast"/m,
  );
});

test("the lanes that run what ships print each failure as a finding, a crash included", () => {
  const root = copy((r) => write(r, "server/src/cli.ts", "process.exit(3);\n"));
  // The tarball: one that holds only its package.json lacks every shipped file
  const pkg = path.join(root, "..", "pack", "package");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), "{}");
  const tgz = path.join(root, "..", "pack.tgz");
  execFileSync("tar", ["czf", tgz, "-C", path.dirname(pkg), "package"]);
  assert.match(
    fails(root, "check-tarball.mjs", { args: [tgz] }),
    /^pack\.tgz: tarball is missing dist\/cli\.js\./m,
  );
  assert.match(
    fails(root, "check-tarball.mjs", { args: [path.join(root, "..", "absent.tgz")] }),
    /^absent\.tgz: tar tzf failed: .+\n {4}\S/,
  );
  // A package root that does not exist stops the hook lanes before they start anything
  const nowhere = path.join(root, "..", "no-package");
  assert.match(
    fails(root, "check-codex-trust-live.mjs", { args: [nowhere] }),
    /^codex trust: the check crashed: /m,
  );
  assert.match(fails(root, "check-hooks-live.mjs", { args: [nowhere] }), /^hooks: the check crashed: /m);
  // A CLI that exits 3: every step that runs it fails, and the first read of the database it never made crashes the lane
  const live = fails(root, "check-sql-live.mjs");
  assert.match(live, /^sql:live init: the child process exited 3\./m);
  assert.match(live, /^sql:live: the check crashed: /m);
});
