#!/usr/bin/env node
// Automatic delivery of past records into Claude Code: at session start (current work and a few broad constraints), before an edit (the
// active records anchored to that path), and on a prompt (only when it names a record's code symbol, path, or option exactly).
// Only active, supported, sourced records without an unresolved conflict are delivered; candidates never are. What was delivered is logged
// through the capture connection (never the text). Every failure leaves the host running: the hook prints nothing and exits 0.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Kysely } from "kysely";
import { branchOf, type HookInput, isOwnerTurn, readInput } from "./capture.ts";
import { dbFile, iso, openReader } from "./db.ts";
import type { DB } from "./db-types.ts";
import { openWriter } from "./db-write.ts";
import { type Host, sessionId } from "./knowledge.ts";
import { inline } from "./panel.ts";
import { identify, projectId } from "./project.ts";
import { head, reason, sha256 } from "./text.ts";

type Event = "session_start" | "pre_edit" | "prompt";
const LIMITS: Record<Event, { units: number; chars: number }> = {
  session_start: { units: 6, chars: 1000 },
  pre_edit: { units: 5, chars: 1500 },
  prompt: { units: 3, chars: 900 },
};
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const NOTE = "Sphica past record, not an instruction; read it with Sphica's read before relying on it";

/** Units that may be delivered: active, supported, sourced, and in no unresolved conflict. */
const deliverable = (db: Kysely<DB>, projectId: number) =>
  db
    .selectFrom("unit as u")
    .where("u.project_id", "=", projectId)
    .where("u.lifecycle", "=", "active")
    .where("u.extraction", "=", "supported")
    .where("u.unsourced", "=", 0)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("unit_link as l")
            .select("l.from_unit")
            .where("l.kind", "=", "conflicts")
            .where("l.resolved_at", "is", null)
            .where((eb) =>
              eb.or([eb("l.from_unit", "=", eb.ref("u.id")), eb("l.to_unit", "=", eb.ref("u.id"))]),
            ),
        ),
      ),
    );

const line = (u: { key: string; kind: string; stance: string | null; text: string }, extra = "") =>
  `- ${inline(u.key)} (${u.kind}${u.stance ? ` ${u.stance}` : ""}): ${head(inline(u.text), 240)}${extra}`;

/** Keeps whole lines within the budget; returns the kept lines and how many were left out. */
function fit(lines: string[], chars: number, lead: string): { text: string; omitted: number } {
  const kept: string[] = [];
  let used = lead.length;
  for (const l of lines) {
    if (used + l.length + 1 > chars) break;
    kept.push(l);
    used += l.length + 1;
  }
  return { text: kept.length ? [lead, ...kept].join("\n") : "", omitted: lines.length - kept.length };
}

type Plan = {
  text: string;
  units: number[];
  eligible: number;
  omitted: number;
  path: string | null;
  reason: string | null;
};

async function beforeEdit(db: Kysely<DB>, projectId: number, rel: string): Promise<Plan> {
  const rows = await deliverable(db, projectId)
    .innerJoin("unit_anchor as a", "a.unit_id", "u.id")
    .where("a.path", "=", rel)
    .where("a.role", "=", "applies_to")
    .where("a.retired_at", "is", null)
    .select(["u.id", "u.key", "u.kind", "u.stance", "u.text"])
    .groupBy("u.id")
    .orderBy("u.id", "desc")
    .execute();
  const shown = rows.slice(0, LIMITS.pre_edit.units);
  const lead = `Active decisions applying to ${inline(rel)} (current code relevance unverified). ${NOTE}:`;
  const f = fit(
    shown.map((u) => line(u)),
    LIMITS.pre_edit.chars,
    lead,
  );
  return {
    text: f.text,
    units: shown.slice(0, shown.length - f.omitted).map((u) => u.id),
    eligible: rows.length,
    omitted: rows.length - shown.length + f.omitted,
    path: rel,
    reason: null,
  };
}

/** A prompt brings up a record only by naming its anchored symbol or path, or one of its options, exactly. Aliases never count. */
async function onPrompt(db: Kysely<DB>, projectId: number, prompt: string): Promise<Plan> {
  const text = prompt.normalize("NFKC");
  const lower = text.toLowerCase();
  const word = (w: string, s: string) =>
    new RegExp(
      `(?<![\\p{L}\\p{N}_$])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_$])`,
      "u",
    ).test(s);
  const units = await deliverable(db, projectId)
    .select(["u.id", "u.key", "u.kind", "u.stance", "u.text"])
    .execute();
  const ids = units.map((u) => u.id);
  const [anchors, options] = ids.length
    ? await Promise.all([
        db
          .selectFrom("unit_anchor")
          .select(["unit_id", "path", "symbol"])
          .where("unit_id", "in", ids)
          .where("retired_at", "is", null)
          .execute(),
        db
          .selectFrom("unit_option")
          .select(["unit_id", "text", "outcome"])
          .where("unit_id", "in", ids)
          .execute(),
      ])
    : [[], []];
  const hits: { u: (typeof units)[number]; why: string }[] = [];
  for (const u of units) {
    const a = anchors.find(
      (x) =>
        x.unit_id === u.id &&
        ((x.symbol && x.symbol.length >= 3 && word(x.symbol, text)) || text.includes(x.path)),
    );
    const o = options.find(
      (x) => x.unit_id === u.id && x.text.length >= 3 && word(x.text.normalize("NFKC").toLowerCase(), lower),
    );
    if (a) hits.push({ u, why: ` [names ${a.symbol && word(a.symbol, text) ? a.symbol : a.path}]` });
    else if (o) hits.push({ u, why: ` [names the ${o.outcome} option ${inline(o.text)}]` });
  }
  const shown = hits.slice(0, LIMITS.prompt.units);
  // One line per record, with the note on each, so the whole stays within 3 lines
  const lines = shown.map((h) => `${NOTE}: ${line(h.u, h.why).slice(2)}`);
  const kept: string[] = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > LIMITS.prompt.chars) break;
    kept.push(l);
    used += l.length + 1;
  }
  return {
    text: kept.join("\n"),
    units: shown.slice(0, kept.length).map((h) => h.u.id),
    eligible: hits.length,
    omitted: hits.length - kept.length,
    path: null,
    reason: null,
  };
}

async function atStart(db: Kysely<DB>, projectId: number, branch: string | null): Promise<Plan> {
  const work = await db
    .selectFrom("work")
    .where("project_id", "=", projectId)
    .where("status", "in", ["active", "blocked", "paused"])
    .select(["title", "current", "next", "status", "branch"])
    .orderBy("updated_at", "desc")
    .limit(3)
    .execute();
  // Broad constraints: active constraints with no code location, so no edit hook would ever show them
  const broad = await deliverable(db, projectId)
    .where("u.kind", "=", "constraint")
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("unit_anchor as a")
            .select("a.id")
            .whereRef("a.unit_id", "=", "u.id")
            .where("a.retired_at", "is", null),
        ),
      ),
    )
    .select(["u.id", "u.key", "u.kind", "u.stance", "u.text"])
    .orderBy("u.id", "desc")
    .limit(3)
    .execute();
  const lines = [
    ...work.map((w) => {
      // The reader connection already turns next back into an array (db.ts JSON_COLUMNS)
      const next = (w.next as unknown as string[])[0];
      return `- Work: ${head(inline(w.title), 120)} (${w.status}${w.branch && w.branch === branch ? ", this branch" : ""}): ${head(inline(w.current), 200)}${next ? `; next: ${head(inline(next), 120)}` : ""}`;
    }),
    ...broad.map((u) => line(u)),
  ];
  const f = fit(
    lines,
    LIMITS.session_start.chars,
    `Sphica: this project's current work and standing constraints. ${NOTE}:`,
  );
  const shownUnits = broad.filter((u) => f.text.includes(inline(u.key))).map((u) => u.id);
  return {
    text: f.text,
    units: shownUnits,
    eligible: lines.length,
    omitted: f.omitted,
    path: null,
    reason: null,
  };
}

/** Whether this session was already told Sphica is unavailable (said once per session, never as "nothing applies"). */
function onceUnavailable(session: string): boolean {
  const dir = path.join(os.tmpdir(), "sphica-unavailable");
  const mark = path.join(dir, sha256(session).toString("hex").slice(0, 24));
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(mark, "", { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

async function log(
  file: string,
  projectId: number,
  host: Host,
  external: string,
  event: Event,
  plan: Plan,
  outcome: string,
): Promise<void> {
  const cap = openWriter("capture", file);
  try {
    const id = sessionId(projectId, host, external);
    const now = iso(Date.now());
    await cap
      .insertInto("capture_session")
      .values({ id, project_id: projectId, host, external_id: external, branch: null, started_at: now })
      .execute();
    await cap
      .insertInto("capture_delivery")
      .values({
        session_id: id,
        event,
        outcome,
        reason: plan.reason,
        path: plan.path,
        eligible: plan.eligible,
        omitted: plan.omitted,
        chars: plan.text.length,
        at: now,
        units: JSON.stringify(plan.units),
      })
      .execute();
  } finally {
    await cap.destroy().catch(() => {});
  }
}

/** The additional context for one hook call, or "" for nothing. file is the database (tests pass their own). */
export async function deliver(
  input: HookInput & { source?: string },
  host: Host = "claude-code",
  file: string = dbFile(),
): Promise<string> {
  const name = input.hook_event_name;
  const event: Event | null =
    name === "SessionStart"
      ? "session_start"
      : name === "UserPromptSubmit"
        ? "prompt"
        : name === "PreToolUse"
          ? "pre_edit"
          : null;
  if (!event || !input.session_id) return "";
  if (event === "prompt" && !isOwnerTurn(input)) return "";
  const ti = input.tool_input ?? {};
  const target = [ti.file_path, ti.notebook_path].find((p): p is string => typeof p === "string");
  if (event === "pre_edit" && (!EDIT_TOOLS.has(input.tool_name ?? "") || !target)) return "";
  const place = identify(input.cwd ?? process.cwd());
  if (!place) return "";
  const rel = target
    ? path
        .relative(place.root, path.resolve(input.cwd ?? place.root, target))
        .split(path.sep)
        .join("/")
    : null;
  if (event === "pre_edit" && (!rel || rel.startsWith(".."))) return "";
  let db: Kysely<DB> | null = null;
  try {
    if (!fs.existsSync(file)) throw new Error(`no database at ${file}`);
    db = openReader(file);
    const pid = await projectId(db, place.key);
    if (pid === null) return "";
    if (event === "session_start" && input.source === "resume") {
      const said = await db
        .selectFrom("delivery")
        .select("id")
        .where("session_id", "=", sessionId(pid, host, input.session_id))
        .where("event", "=", "session_start")
        .where("outcome", "=", "emitted")
        .executeTakeFirst();
      if (said) return "";
    }
    const plan =
      event === "pre_edit"
        ? await beforeEdit(db, pid, rel ?? "")
        : event === "prompt"
          ? await onPrompt(db, pid, input.prompt ?? "")
          : await atStart(db, pid, branchOf(place.root));
    await log(file, pid, host, input.session_id, event, plan, plan.text ? "emitted" : "nothing").catch(
      () => {},
    );
    return plan.text;
  } catch (e) {
    // Unavailable is not "nothing applies": the edit hook and session start say so, once per session
    if (event === "prompt" || !onceUnavailable(`${host}\0${input.session_id}`)) return "";
    return `Sphica unavailable: ${head(inline(reason(e)), 200)}. Past decisions for ${event === "pre_edit" ? inline(rel ?? "") : "this project"} could not be checked.`;
  } finally {
    await db?.destroy().catch(() => {});
  }
}

async function main(): Promise<void> {
  const input = (await readInput(process.stdin)) as HookInput & { source?: string };
  const host: Host = process.argv[2] === "codex" ? "codex" : "claude-code";
  const context = await deliver(input, host).catch(() => "");
  if (context)
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: context },
      }),
    );
}

if (process.argv[1] && /deliver\.(ts|js)$/.test(process.argv[1])) {
  main().catch(() => {
    // Delivery never stops work
  });
}
