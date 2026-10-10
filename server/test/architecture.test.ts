// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// check-architecture.mjs run on a copy of the sources, so a module that starts git on its own is shown to fail it
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { tempDir } from "./temp-dir.ts";

const REPO = path.join(import.meta.dirname, "..", "..");

/** The check run on a copy of server/src, with files put into it over the copied ones */
function check(extra: Record<string, string>) {
  const root = tempDir("sphica-architecture-");
  fs.cpSync(path.join(REPO, "server", "src"), path.join(root, "server", "src"), { recursive: true });
  for (const [rel, text] of Object.entries(extra))
    fs.writeFileSync(path.join(root, "server", "src", rel), text);
  return spawnSync(process.execPath, [path.join(REPO, "scripts", "check-architecture.mjs"), "--root", root], {
    encoding: "utf8",
  });
}

test("only git.ts and the git worker start git, and only a few modules start processes at all", () => {
  assert.equal(check({}).status, 0);
  // A module that may start processes (github.ts starts gh) still may not start git, however the name reaches the call
  const loads =
    'import { exec, execFile, execFileSync, spawn } from "node:child_process";\nimport { promisify } from "node:util";\n';
  for (const call of [
    'execFileSync("git", ["status"]);',
    "spawn('git', []);",
    'exec("git status");',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source under check holds a template
    "const sub = 'status';\nexec(`git ${sub}`);",
    'const command = "git";\nexecFileSync(command, ["status"]);',
    'const run = promisify(execFile);\nrun("git", ["status"]);',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source under check holds a template
    'spawn(`${"git"}`, ["status"]);',
    'spawn("git" /* the program */, ["status"]);',
    'execFileSync("git.exe", ["status"]);',
    'spawn("\\x67it", []);',
    'exec("git\\tstatus");',
    'spawn("g\\\nit", []);',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the source under check holds a template
    "const prefix = '';\nexec(`${prefix}git status`);",
  ]) {
    const r = check({ "github.ts": `${loads}${call}\n` });
    assert.equal(r.status, 1, call);
    assert.match(r.stderr, /server\/src\/github\.ts starts git/, call);
  }
  // Any other module may not load node:child_process at all, in whatever form
  for (const load of [
    'import { exec } from "child_process";\nexec("ls");',
    'const { exec } = await import("node:child_process");\nexec("ls");',
    'const cp = require("node:child_process");',
    'import { exec } from "node:child_\\\nprocess";\nexec("ls");',
  ]) {
    const r = check({ "stray.ts": `${load}\n` });
    assert.equal(r.status, 1, load);
    assert.match(r.stderr, /server\/src\/stray\.ts loads node:child_process/, load);
  }
  // Words in comments and messages are not starts
  assert.equal(
    check({
      "stray.ts": '// import { exec } from "node:child_process";\nexport const message = "git failed";\n',
    }).status,
    0,
  );
  // A starter that no longer loads node:child_process, or names git only in a comment, has stopped being looked at
  for (const text of [
    '// execFileSync("git", ["status"]);\nexport {};\n',
    'export const tool = "git";\n',
    "export {};\n",
  ]) {
    const r = check({ "git.ts": text });
    assert.equal(r.status, 1, text);
    assert.match(r.stderr, /server\/src\/git\.ts names no git to start/);
  }
});

test("only own-words.ts makes an OwnWords, and only record.ts and glean.ts write the rows that keep such words", () => {
  const ok = check({});
  assert.equal(ok.status, 0);
  assert.match(
    ok.stdout,
    /authority rows: only server\/src\/record\.ts and server\/src\/glean\.ts write them/,
  );
  // A cast forges the checked words, however it is spelled
  for (const cast of [
    'import type { OwnWords } from "./own-words.ts";\nexport const w = { source: 1, start: 0, end: 1, route: "owner_statement" } as OwnWords;',
    'import type { OwnWords } from "./own-words.ts";\nexport const w = {} as unknown as OwnWords<"owner_statement">;',
    'import type { OwnWords } from "./own-words.ts";\nexport const w = {} as\n  OwnWords;',
  ]) {
    const r = check({ "stray.ts": `${cast}\n` });
    assert.equal(r.status, 1, cast);
    assert.match(r.stderr, /server\/src\/stray\.ts casts a value to OwnWords/, cast);
  }
  // A module outside the two writers saving an adoption, a reason, or a definition
  for (const write of [
    'export const save = (trx: any) => trx.insertInto("unit_adoption").values({}).execute();',
    "export const save = (trx: any) => trx.insertInto('unit_anchor_retirement').values({}).execute();",
    'export const save = (trx: any) => trx.insertInto(\n  "field_def",\n).values({}).execute();',
    'export const sql = "insert into unit_adoption (unit_id) values (1)";',
    "export const retraction = (reason: { source: number }) => ({ retraction_source_id: reason.source, x: 1 });",
  ]) {
    const r = check({ "stray.ts": `${write}\n` });
    assert.equal(r.status, 1, write);
    assert.match(r.stderr, /server\/src\/stray\.ts writes an adoption/, write);
  }
  // Reading those tables, and naming the type, is anyone's
  assert.equal(
    check({
      "stray.ts":
        'import type { OwnWords } from "./own-words.ts";\nexport const read = (db: any, w: OwnWords) => db.selectFrom("unit_adoption").where("retraction_source_id", "=", w.source).execute();\n',
    }).status,
    0,
  );
  // A writer or the maker that the patterns no longer see has stopped being looked at
  const blank = check({ "own-words.ts": "export {};\n" });
  assert.equal(blank.status, 1);
  assert.match(blank.stderr, /own-words\.ts makes no OwnWords where check-architecture\.mjs looks/);
  const moved = check({ "glean.ts": "export {};\n" });
  assert.equal(moved.status, 1);
  assert.match(moved.stderr, /glean\.ts writes no authority row where check-architecture\.mjs looks/);
});
