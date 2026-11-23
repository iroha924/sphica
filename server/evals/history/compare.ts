// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Reads this machine's own host logs as the import would, and compares each session live capture already recorded with what the database
// holds: message ids and texts, per host and speaker. Prints counts and ids only, never a message's text. The database is opened to read.
//   node server/evals/history/compare.ts --db <copy of the database> [--root <repository root>]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import zlib from "node:zlib";
import { openReader } from "../../src/db.ts";
import { fromClaude, fromCodex, type SessionLog } from "../../src/history.ts";

const { values } = parseArgs({ options: { db: { type: "string" }, root: { type: "string" } } });
if (!values.db) throw new Error("--db <copy of the database> is required");
const root = path.resolve(values.root ?? process.cwd());
const place = { key: "", root };

const read = (file: string): string[] => {
  let buf = fs.readFileSync(file);
  if (file.endsWith(".zst")) buf = zlib.zstdDecompressSync(buf);
  return buf.toString("utf8").split("\n");
};
const walk = (dir: string, out: string[] = []): string[] => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.jsonl(\.zst)?$/.test(e.name)) out.push(p);
  }
  return out;
};
const inside = (cwd: string | null) => cwd !== null && (cwd === root || cwd.startsWith(`${root}${path.sep}`));

const logs: SessionLog[] = [];
/** Per Claude Code session and turn, how its user lines without the human origin start, to name why live capture kept one the import did not */
const unmarked = new Map<string, Map<string, string[]>>();
const shapeOf = (line: Record<string, unknown>): string => {
  const content = (line.message as { content?: unknown } | undefined)?.content;
  const text = typeof content === "string" ? content.trimStart() : "";
  const tag = /^<([A-Za-z][\w-]*)/.exec(text)?.[1];
  return tag === "system-reminder"
    ? "a host event wrapped in system-reminder"
    : tag
      ? `a line starting with <${tag}>`
      : "a line without the human origin";
};
const claudeDir = path.join(os.homedir(), ".claude", "projects", root.replace(/[^A-Za-z0-9]/g, "-"));
for (const f of fs.existsSync(claudeDir) ? fs.readdirSync(claudeDir) : [])
  if (f.endsWith(".jsonl")) {
    const lines = read(path.join(claudeDir, f));
    const log = fromClaude(lines, place);
    logs.push(log);
    const turns = new Map<string, string[]>();
    for (const raw of lines) {
      let line: Record<string, unknown>;
      try {
        line = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      const origin = (line.origin as { kind?: unknown } | undefined)?.kind;
      if (line.type !== "user" || origin === "human" || typeof line.promptId !== "string") continue;
      turns.set(line.promptId, [...(turns.get(line.promptId) ?? []), shapeOf(line)]);
    }
    unmarked.set(log.session, turns);
  }
for (const f of walk(path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "sessions"))) {
  const log = fromCodex(read(f), place);
  if (inside(log.cwd)) logs.push(log);
}

const db = openReader(values.db);
const tally: Record<string, number> = {};
const add = (k: string, n = 1) => {
  tally[k] = (tally[k] ?? 0) + n;
};
const examples: string[] = [];
try {
  for (const log of logs) {
    if (log.excluded) {
      add(`${log.host} excluded: ${log.excluded}`);
      continue;
    }
    const live = await db
      .selectFrom("source")
      .innerJoin("session", "session.id", "source.session_id")
      .select(["source.external_id as id", "source.text as text", "source.author_kind as speaker"])
      .where("session.host", "=", log.host)
      .where("session.external_id", "=", log.session)
      .where("source.kind", "=", "session_message")
      .execute();
    if (!live.length) {
      add(`${log.host} sessions not captured live`);
      continue;
    }
    add(`${log.host} sessions compared`);
    for (const speaker of ["owner", "assistant"] as const) {
      const mine = new Map(
        log.records.flatMap((r) =>
          r.kind === "message" && r.speaker === speaker ? [[r.id, r.body] as const] : [],
        ),
      );
      const theirs = new Map(live.filter((r) => r.speaker === speaker).map((r) => [r.id, r.text] as const));
      const liveTexts = new Set(theirs.values());
      for (const [id, body] of mine) {
        if (theirs.get(id) === body) add(`${log.host} ${speaker}: same id and text`);
        else if (liveTexts.has(body)) add(`${log.host} ${speaker}: same text, other id`);
        else {
          add(`${log.host} ${speaker}: only imported (live capture has nothing for it)`);
          if (examples.length < 20)
            examples.push(`${log.host} ${speaker} only imported: ${log.session} ${id}`);
        }
      }
      for (const [id, text] of theirs)
        if (!mine.has(id) && ![...mine.values()].includes(text)) {
          const shapes = unmarked.get(log.session)?.get(id.split(":")[0] ?? "") ?? [];
          const why =
            speaker === "owner" && shapes.length
              ? `the log has ${[...new Set(shapes)].join(" / ")}`
              : "no line in the log gives it";
          add(`${log.host} ${speaker}: only live (${why})`);
          if (examples.length < 20) examples.push(`${log.host} ${speaker} only live: ${log.session} ${id}`);
        }
    }
    for (const [reason, n] of Object.entries(log.skipped)) add(`${log.host} skipped: ${reason}`, n);
  }
} finally {
  await db.destroy();
}
for (const [k, n] of Object.entries(tally).sort()) console.log(`${n}\t${k}`);
for (const e of examples) console.log(e);
