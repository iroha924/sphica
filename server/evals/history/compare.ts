// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Reads this machine's own host logs with the import's own reader, and compares each session live capture already recorded with what the
// database holds: message ids and texts, per host and speaker. A message only live capture holds is named by the log line that gives its
// id (one the import leaves out on purpose, or none). Prints counts and ids only, never a message's text. The database is opened to read.
//   node server/evals/history/compare.ts --db <copy of the database> [--root <repository root>]
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { messageOf } from "../../src/capture.ts";
import { openReader } from "../../src/db.ts";
import { hostHomes, readLogs } from "../../src/history.ts";
import { identify } from "../../src/project.ts";

const { values } = parseArgs({ options: { db: { type: "string" }, root: { type: "string" } } });
if (!values.db) throw new Error("--db <copy of the database> is required");
const place = identify(path.resolve(values.root ?? process.cwd()));
if (!place) throw new Error("--root is not inside a repository");
const { logs } = await readLogs({ key: place.legacyKey, match: place.key, root: place.root });

type Line = {
  type?: unknown;
  sessionId?: unknown;
  promptId?: unknown;
  isMeta?: unknown;
  origin?: { kind?: unknown };
  message?: { content?: unknown };
  attachment?: { type?: unknown; prompt?: unknown; origin?: { kind?: unknown } };
};
const textOf = (c: unknown): string =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c
          .filter((b): b is { text: string } => b?.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\n")
      : "";

/** For each Claude Code session, the owner-message id every user line or queued prompt would give, with the shape of that line */
const shapes = new Map<string, Map<string, string>>();
const projects = path.join(hostHomes().claude, "projects");
for (const dir of fs.existsSync(projects) ? fs.readdirSync(projects, { withFileTypes: true }) : []) {
  if (!dir.isDirectory()) continue;
  const d = path.join(projects, dir.name);
  for (const f of fs.readdirSync(d).filter((n) => n.endsWith(".jsonl"))) {
    let session = "";
    let turn: string | null = null;
    const byId = new Map<string, string>();
    for (const raw of fs.readFileSync(path.join(d, f), "utf8").split("\n")) {
      let line: Line;
      try {
        line = JSON.parse(raw) as Line;
      } catch {
        continue;
      }
      if (!session && typeof line.sessionId === "string") session = line.sessionId;
      if (line.type === "user" && typeof line.promptId === "string") turn = line.promptId;
      const queued = line.type === "attachment" && line.attachment?.type === "queued_command";
      const content =
        line.type === "user" ? line.message?.content : queued ? line.attachment?.prompt : undefined;
      if (content === undefined || !turn) continue;
      if (Array.isArray(content) && content.some((b) => b?.type === "tool_result")) continue;
      const origin = String((line.type === "user" ? line.origin : line.attachment?.origin)?.kind ?? "none");
      const text = textOf(content);
      const host = /^\s*<system-reminder>/.test(text) ? ", starting with a host system-reminder" : "";
      const base = { v: 2 as const, host: "claude-code" as const, session, project: "", branch: null, turn };
      const r = messageOf(base, `${turn}:owner`, "owner", text, "2026-01-01T00:00:00.000Z");
      if (r)
        byId.set(
          r.id,
          `a ${queued ? "queued prompt" : "user line"} of origin ${origin}${line.isMeta ? " (meta)" : ""}${host}`,
        );
    }
    shapes.set(session, byId);
  }
}

const db = openReader(values.db);
const tally: Record<string, number> = {};
const add = (k: string) => {
  tally[k] = (tally[k] ?? 0) + 1;
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
      .innerJoin("project", "project.id", "session.project_id")
      .select(["source.external_id as id", "source.text as text", "source.author_kind as speaker"])
      .where("project.key", "in", [place.key, place.legacyKey])
      .where("session.host", "=", log.host)
      .where("session.external_id", "=", log.session)
      .where("source.kind", "=", "session_message")
      .execute();
    if (!live.length) {
      add(`${log.host} sessions not captured live`);
      continue;
    }
    add(`${log.host} sessions compared`);
    for (const [reason, n] of Object.entries(log.skipped))
      for (let i = 0; i < n; i++) add(`${log.host} skipped: ${reason}`);
    for (const speaker of ["owner", "assistant"] as const) {
      const mine = new Map(
        log.records.flatMap((r) =>
          r.kind === "message" && r.speaker === speaker ? [[r.id, r.body] as const] : [],
        ),
      );
      const theirs = new Map(live.filter((r) => r.speaker === speaker).map((r) => [r.id, r.text] as const));
      for (const [id, body] of mine) {
        if (theirs.get(id) === body) add(`${log.host} ${speaker}: same id and text`);
        else {
          // Live capture kept the host's block in front of the prompt, which the import leaves out
          const trimmed = [...theirs.values()].some((text) => text !== body && text.endsWith(body));
          add(
            `${log.host} ${speaker}: only imported${trimmed ? ", a live message with the host block left out" : ""}`,
          );
          if (examples.length < 30)
            examples.push(`${log.host} ${speaker} only imported: ${log.session} ${id}`);
        }
      }
      for (const id of theirs.keys())
        if (!mine.has(id)) {
          const shape = speaker === "owner" ? shapes.get(log.session)?.get(id) : undefined;
          add(`${log.host} ${speaker}: only live, from ${shape ?? "no line of the log"}`);
          if (examples.length < 30) examples.push(`${log.host} ${speaker} only live: ${log.session} ${id}`);
        }
    }
  }
} finally {
  await db.destroy();
}
// Reasons and ids come from the logs, so control characters are shown escaped and cannot redraw the terminal
const safe = (s: string) =>
  // oxlint-disable-next-line no-control-regex -- matches the control characters it escapes
  s.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
for (const [k, n] of Object.entries(tally).sort()) console.log(`${n}\t${safe(k)}`);
for (const e of examples) console.log(safe(e));
