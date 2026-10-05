// read against real SQLite and a real Git working tree: what one reply carries, and that a record reads the same whatever else is read.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inTransaction } from "../src/db.ts";
import { readUnit } from "../src/read.ts";
import { checkRecord, saveRecord, type Target } from "../src/record.ts";
import { openRun } from "../src/trace.ts";
import { message, project, type TempDb, tempDb } from "./temp-db.ts";

async function save(db: TempDb, p: number, root: string | null, record: unknown) {
  const t: Target = {
    projectId: p,
    origin: "trace",
    prefix: "trace:ext-s1/",
    sessionId: "s1",
    root,
    sources: null,
  };
  return inTransaction(db.ingest, async (trx) => {
    const run = await openRun(trx, {
      projectId: p,
      origin: "trace",
      target: "session:s1",
      sessionId: "s1",
      draftId: `d${Math.random()}`,
    });
    return saveRecord(trx, t, run, await checkRecord(trx, t, record), []);
  });
}

function repo(): { root: string; git: (...args: string[]) => string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-read-")));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
      encoding: "utf8",
    }).trim();
  git("init", "-q");
  return { root, git };
}

test("read rename budget: a record reads the same alone and after a record that used up its own rename lookups", async () => {
  const db = tempDb();
  const { root, git } = repo();
  try {
    const commits: string[] = [];
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(root, `f${i}.ts`), `export const f${i} = ${i};\n`);
      git("add", "-A");
      git("commit", "-qm", `f${i}`);
      commits.push(git("rev-parse", "HEAD"));
    }
    const p = project(db);
    const m = message(db, p, { id: "m1", text: "f を足した。g を足した。" });
    const finding = (key: string, quote: string, anchors: unknown[]) => ({
      key,
      kind: "finding",
      text: quote,
      evidence: [{ source: `s${m}`, quote, role: "states" }],
      anchors,
    });
    await save(db, p, root, {
      units: [
        finding(
          "five",
          "f を足した。",
          commits.slice(0, 5).map((commit, i) => ({ path: `f${i}.ts`, role: "evidence", commit })),
        ),
        finding("sixth", "g を足した。", [{ path: "f5.ts", role: "evidence", commit: commits[5] }]),
      ],
    });
    for (let i = 0; i < 6; i++) fs.rmSync(path.join(root, `f${i}.ts`));
    const alone = (await readUnit(db.reader, p, "trace:ext-s1/sixth", root)) ?? "";
    assert.doesNotMatch(alone, /rename not checked/);
    // One read shares what git said, but each record counts its own lookups
    const shared = new Map();
    const first = (await readUnit(db.reader, p, "trace:ext-s1/five", root, undefined, shared)) ?? "";
    assert.doesNotMatch(first, /rename not checked/);
    assert.equal((await readUnit(db.reader, p, "trace:ext-s1/sixth", root, undefined, shared)) ?? "", alone);
  } finally {
    await db.done();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
