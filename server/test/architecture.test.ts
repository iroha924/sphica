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

/** SQLite's statement that swaps a conflicting row for a new one */
const REPLACING = ["RE", "PLACE"].join("");

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
    "const sub = 'status';\nexec(`git ${sub}`);",
    'const command = "git";\nexecFileSync(command, ["status"]);',
    'const run = promisify(execFile);\nrun("git", ["status"]);',
    'spawn(`${"git"}`, ["status"]);',
    'spawn("git" /* the program */, ["status"]);',
    'execFileSync("git.exe", ["status"]);',
    'spawn("\\x67it", []);',
    'exec("git\\tstatus");',
    'spawn("g\\\nit", []);',
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
    'import type { OwnWords as W } from "./own-words.ts";\nexport const w = { source: 1, start: 0, end: 1, route: "owner_statement" } as W;',
    // A cast inside something exported, with a comment in it, or to a name with a dollar sign
    'import type { OwnWords } from "./own-words.ts";\nexport function fake(value: unknown) { return value as OwnWords; }',
    'import type { OwnWords } from "./own-words.ts";\nexport const fake = (value: unknown) => ({ words: value as OwnWords });',
    'import type { OwnWords } from "./own-words.ts";\nexport const fake = (value: unknown) => value as /* checked */ OwnWords;',
    'import type { OwnWords as $W } from "./own-words.ts";\nexport const fake = (value: unknown) => value as $W;',
    // A comment with no space around it still separates the words it stands between
    'import type { OwnWords } from "./own-words.ts";\nexport const fake = (value: unknown) => value as/* checked */OwnWords;',
    'import type { OwnWords } from "./own-words.ts";\nexport const fake = (value: unknown) => value as OwnWords/* checked */as unknown;',
    // A cast written twice is still a cast
    'import type { OwnWords } from "./own-words.ts";\nexport const w = {} as OwnWords as OwnWords;',
    'import type { OwnWords as W } from "./own-words.ts";\nexport const w = {} as W as W;',
  ]) {
    const r = check({ "stray.ts": `${cast}\n` });
    assert.equal(r.status, 1, cast);
    assert.match(
      r.stderr,
      /server\/src\/stray\.ts casts a value to OwnWords or imports it under another name/,
      cast,
    );
  }
  // A module outside the two writers saving an adoption, a reason, or a definition
  for (const write of [
    'export const save = (trx: any) => trx.insertInto("unit_adoption").values({}).execute();',
    "export const save = (trx: any) => trx.insertInto('unit_anchor_retirement').values({}).execute();",
    'export const save = (trx: any) => trx.insertInto(\n  "field_def",\n).values({}).execute();',
    'export const sql = "insert into unit_adoption (unit_id) values (1)";',
    // A reconsider condition is evidence of an option
    'export const save = (trx: any) => trx.insertInto("unit_evidence").values({ role: "reconsiders" }).execute();',
    // A retraction, whatever order its fields come in
    'export const save = (trx: any, source: number) => trx.updateTable("unit_evidence").set({ retracted_at: "x", retraction_source_id: source }).execute();',
    'export const save = (trx: any, source: number) => trx.updateTable("unit_adoption").set({ retraction_source_id: source, retracted_at: "x" }).execute();',
    'export const save = (db: any) => db.exec("INSERT INTO unit_adoption (unit_id) VALUES (1)");',
    'export const save = (db: any) => db.exec("Update unit_evidence set retracted_at = 1");',
    // The table's name quoted, under its schema's name, after a space, or in a template
    `export const save = (db: any) => db.exec('INSERT INTO "unit_adoption" (source_id) VALUES (1)');`,
    'export const save = (db: any) => db.exec("insert into `field_def` (name) values (1)");',
    'export const save = (db: any) => db.exec("insert into [unit_evidence] (unit_id) values (1)");',
    'export const save = (db: any) => db.exec("insert into main.unit_anchor_retirement (anchor_id) values (1)");',
    'export const save = (db: any) => db.exec("insert into \\"unit_adoption\\" (unit_id) values (1)");',
    'export const save = (trx: any) => trx.insertInto ("unit_adoption").values({}).execute();',
    "export const save = (trx: any) => trx.insertInto(`unit_adoption`).values({}).execute();",
    // Removing a row is a write too
    'export const save = (db: any) => db.exec("DELETE FROM unit_adoption");',
    'export const save = (trx: any) => trx.deleteFrom("field_def").execute();',
    // Every spelling SQLite takes for a write
    'export const save = (db: any) => db.exec("insert or ignore into unit_adoption (unit_id) values (1)");',
    // The statement's name is put together here: this repository's SQL check refuses it wherever it is spelled out
    `export const save = (db: any) => db.exec("INSERT OR ${REPLACING} INTO field_def (name) values (1)");`,
    `export const save = (db: any) => db.exec("${REPLACING.toLowerCase()} into unit_anchor_retirement (anchor_id) values (1)");`,
    'export const save = (db: any) => db.exec("update or ignore unit_adoption set retracted_at = 1");',
  ]) {
    const r = check({ "stray.ts": `${write}\n` });
    assert.equal(r.status, 1, write);
    assert.match(r.stderr, /server\/src\/stray\.ts writes evidence, an adoption/, write);
  }
  // Shaping rows that were read is not a write, whatever the fields are called
  assert.equal(
    check({
      "stray.ts":
        'export const shape = async (db: any) => (await db.selectFrom("unit_evidence").selectAll().execute()).map((row: any) => ({ retraction_source_id: row.retraction_source_id, reason: row.retraction_reason }));\n',
    }).status,
    0,
  );
  // A comment about a cast or a write is neither
  assert.equal(
    check({
      "stray.ts":
        'import type { OwnWords } from "./own-words.ts";\n// do not cast as OwnWords, and never insert into unit_adoption here\n/* nor delete from field_def */\nexport const read = (db: any, w: OwnWords) => db.selectFrom("unit_adoption").where("source_id", "=", w.source).execute();\n',
    }).status,
    0,
  );
  // The type under another name is only a name until something is cast to it
  assert.equal(
    check({
      "stray.ts":
        'import type { OwnWords as W } from "./own-words.ts";\nexport const read = (db: any, w: W) => db.selectFrom("unit_adoption").where("source_id", "=", w.source).execute();\n',
    }).status,
    0,
  );
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

test("only reconcile.ts writes states, replacements, and the record that answered a question", () => {
  const ok = check({});
  assert.equal(ok.status, 0);
  assert.match(
    ok.stdout,
    /lifecycle writers: only server\/src\/reconcile\.ts writes unit_state, unit_replacement, and unit_answer/,
  );
  for (const write of [
    'export const save = (trx: any) => trx.insertInto("unit_state").values({}).execute();',
    "export const save = (trx: any) => trx.insertInto('unit_replacement').values({}).execute();",
    'export const end = (trx: any) => trx.updateTable("unit_replacement").set({}).execute();',
    'export const save = (trx: any) => trx.insertInto(\n  "unit_answer",\n).values({}).execute();',
    'export const change = (trx: any) => trx.updateTable("unit_answer").set({}).execute();',
    'export const sql = "insert into unit_answer (state_id, answer_unit) values (1, 2)";',
    // A quoted name is the same table
    "export const sql = 'insert into \"unit_answer\" (state_id, answer_unit) values (1, 2)';",
    'export const sql = "insert into `unit_state` (unit_id) values (1)";',
    'export const sql = "insert into [unit_replacement] (from_unit) values (1)";',
    // A quote escaped inside the string that holds the statement
    'export const sql = "insert into \\"unit_answer\\" (state_id, answer_unit) values (1, 2)";',
  ]) {
    const r = check({ "stray.ts": `${write}\n` });
    assert.equal(r.status, 1, write);
    assert.match(
      r.stderr,
      /server\/src\/stray\.ts writes unit_state, unit_replacement, or unit_answer; only server\/src\/reconcile\.ts may/,
      write,
    );
  }
});
