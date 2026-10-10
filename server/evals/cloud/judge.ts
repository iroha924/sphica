// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The per-run signals the evaluation reports, kept apart so "could not tell" never reads as "no": whether the gold record was delivered,
// whether the run found it through Sphica, what shape Codex's answer came in, and how much of the patch the grader sees.
import { checkAnswer, parseOutput } from "./schema-check.ts";

export type Tri = "yes" | "no" | "unknown";

const names = (text: string, gold: string[]) => gold.some((k) => text.includes(k));

/**
 * Whether the run's context held a gold record. inject: an emitted delivery named it. gold: the gold hook returned it (the record arrives as
 * hook context, not as a delivery row). Other conditions deliver nothing.
 */
export function deliveredSignal(
  condition: string,
  gold: string[],
  emittedUnits: string[],
  goldHookOutput: string | null,
): "yes" | "no" | "not_applicable" {
  if (condition === "inject") return emittedUnits.some((u) => gold.includes(u)) ? "yes" : "no";
  if (condition === "gold") return goldHookOutput && names(goldHookOutput, gold) ? "yes" : "no";
  return "not_applicable";
}

/** Whether a Sphica search or read result in Codex's JSONL events named a gold record; unknown unless every line reads as an event. */
export function foundInCodexEvents(events: string | null, gold: string[]): Tri {
  if (events === null) return "unknown";
  let read = 0;
  let broken = false;
  for (const line of events.split("\n")) {
    if (!line.trim()) continue;
    let e: {
      type?: string;
      item?: { type?: string; server?: string; tool?: string; result?: { content?: { text?: string }[] } };
    };
    try {
      e = JSON.parse(line);
    } catch {
      broken = true;
      continue;
    }
    read++;
    const it = e.item;
    if (e.type !== "item.completed" || it?.type !== "mcp_tool_call" || it.server !== "sphica") continue;
    if (it.tool !== "search" && it.tool !== "read") continue;
    if (names((it.result?.content ?? []).map((c) => c.text ?? "").join("\n"), gold)) return "yes";
  }
  return read && !broken ? "no" : "unknown";
}

/**
 * The same for a routine run log, unknown without it. Results there are not tied to their calls, so only a result in Sphica's
 * record fence (<past-records) counts; a file another tool printed does not.
 */
export function foundInClaudeLog(log: string | null, gold: string[]): Tri {
  if (log === null) return "unknown";
  return log
    .split("\n")
    .some((l) => /\btool_result\b/.test(l) && l.includes("<past-records") && names(l, gold))
    ? "yes"
    : "no";
}

/** Per gold key: whether a delivery carried it, whether a search result named it, whether a read result showed it. */
export type GoldSignal = { in_delivery: Tri | "not_applicable"; in_search: Tri; read: Tri };

const delivery = (condition: string, key: string, emittedUnits: string[], goldHookOutput: string | null) =>
  condition === "inject"
    ? emittedUnits.includes(key)
      ? "yes"
      : "no"
    : condition === "gold"
      ? goldHookOutput?.includes(key)
        ? "yes"
        : "no"
      : "not_applicable";

/**
 * A search result lists a record as a line `## <key> (u<id>)`; a read result opens a record with the line `<key> (u<id>, revision <n>)`.
 * In Codex's events a result keeps its line breaks, so only a line that starts with the heading counts, not one quoted in a record's body.
 */
const esc = (key: string) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const inSearch = (text: string, key: string, lines: boolean) =>
  new RegExp(`${lines ? "(^|\\n)" : ""}## ${esc(key)} \\(u\\d+\\)`).test(text);
const inRead = (text: string, key: string, lines: boolean) =>
  new RegExp(`${lines ? "(^|\\n)" : ""}${esc(key)} \\(u\\d+, revision \\d+\\)`).test(text);

/** The hook prints one JSON line per prompt; its additionalContext is what the session was given. Other lines are kept as text. */
const hookContext = (output: string) =>
  output
    .split("\n")
    .map((l) => {
      try {
        const context = (JSON.parse(l) as { hookSpecificOutput?: { additionalContext?: unknown } })
          ?.hookSpecificOutput?.additionalContext;
        return typeof context === "string" ? context : l;
      } catch {
        return l;
      }
    })
    .join("\n");

/**
 * A gold run is graded as one only when its hook gave every gold record, each as its own delivery line `- <key> (`: a longer key or a
 * mention in another record's body is not the record.
 */
export const goldNotGiven = (condition: string, gold: string[], goldHookOutput: string | null) => {
  if (condition !== "gold") return false;
  const context = hookContext(goldHookOutput ?? "");
  return !gold.length || !gold.every((key) => new RegExp(`(^|\\n)- ${esc(key)} \\(`).test(context));
};

/** The three signals per gold key from Codex's JSONL events, where each tool call carries its own result. */
export function goldSignalsFromCodex(
  condition: string,
  gold: string[],
  emittedUnits: string[],
  goldHookOutput: string | null,
  events: string | null,
): Record<string, GoldSignal> {
  // Any line that is not an event object, or a Sphica call without a result, leaves the log unable to prove "no"; a result elsewhere still proves "yes"
  let readable = events !== null && events.trim() !== "";
  const results: { tool: string; text: string }[] = [];
  for (const line of readable ? (events ?? "").split("\n") : []) {
    if (!line.trim()) continue;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      readable = false;
      continue;
    }
    if (typeof e !== "object" || e === null) {
      readable = false;
      continue;
    }
    const { type, item: it } = e as {
      type?: string;
      item?: {
        type?: string;
        server?: string;
        tool?: string;
        result?: { content?: { text?: string }[] } | null;
      };
    };
    if (type !== "item.completed" || it?.type !== "mcp_tool_call" || it.server !== "sphica" || !it.tool)
      continue;
    if (!it.result || !Array.isArray(it.result.content)) {
      readable = false;
      continue;
    }
    results.push({ tool: it.tool, text: it.result.content.map((c) => c.text ?? "").join("\n") });
  }
  const seen = (tool: string, key: string, test: typeof inSearch): Tri =>
    results.some((r) => r.tool === tool && test(r.text, key, true)) ? "yes" : readable ? "no" : "unknown";
  return Object.fromEntries(
    gold.map((key) => [
      key,
      {
        in_delivery: delivery(condition, key, emittedUnits, goldHookOutput),
        in_search: seen("search", key, inSearch),
        read: seen("read", key, inRead),
      },
    ]),
  );
}

/**
 * The same from a routine run log, where results carry no call id and every tool's calls appear. A result is tied to a tool only while
 * the calls waiting are all that tool; from the moment two tools wait at once until none waits, a result naming a gold key makes its signals unknown.
 * A log that ends with a call still waiting, or holds no call at all, cannot prove "no".
 */
export function goldSignalsFromClaude(
  condition: string,
  gold: string[],
  emittedUnits: string[],
  goldHookOutput: string | null,
  log: string | null,
): Record<string, GoldSignal> {
  const hits = new Map(gold.map((k) => [k, { search: false, read: false, unsure: false }]));
  const waiting: string[] = [];
  let calls = 0;
  let tangled = false;
  for (const line of (log ?? "").split("\n")) {
    const call = /\btool_use (\S+?):/.exec(line);
    if (call) {
      calls++;
      waiting.push(call[1] ?? "");
      if (new Set(waiting).size > 1) tangled = true;
      continue;
    }
    if (!/\btool_result\b/.test(line) || !waiting.length) continue;
    const tool = waiting.shift() ?? "";
    for (const [key, h] of hits) {
      const named = inSearch(line, key, false) || inRead(line, key, false);
      if (!named) continue;
      if (tangled) h.unsure = true;
      else if (tool === "mcp__sphica__search" && inSearch(line, key, false)) h.search = true;
      else if (tool === "mcp__sphica__read" && inRead(line, key, false)) h.read = true;
    }
    if (!waiting.length) tangled = false;
  }
  const blind = log === null || calls === 0 || waiting.length > 0;
  return Object.fromEntries(
    gold.map((key) => {
      const h = hits.get(key) ?? { search: false, read: false, unsure: false };
      const tri = (yes: boolean): Tri => (yes ? "yes" : blind || h.unsure ? "unknown" : "no");
      return [
        key,
        {
          in_delivery: delivery(condition, key, emittedUnits, goldHookOutput),
          in_search: tri(h.search),
          read: tri(h.read),
        },
      ];
    }),
  );
}

/** One tool call of a local Claude run's stream-json, with its result when one came back. */
export type StreamCall = { id: string; name: string; input: unknown; result: string | null; error: boolean };

/**
 * The tool calls of a stream-json run in the order they were made, each tied to its result by id. `readable` is false when a line is not
 * an event or the stream has no final result event, so an absence in it cannot prove "no".
 */
export function claudeStreamCalls(events: string | null): { calls: StreamCall[]; readable: boolean } {
  if (events === null || !events.trim()) return { calls: [], readable: false };
  const calls: StreamCall[] = [];
  const byId = new Map<string, StreamCall>();
  let readable = true;
  let finished = false;
  for (const line of events.split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: string; message?: { content?: unknown } };
    try {
      e = JSON.parse(line);
    } catch {
      readable = false;
      continue;
    }
    // Valid JSON that is not an event object, or a content block that is not an object, is a damaged stream, not an empty one
    if (typeof e !== "object" || e === null || Array.isArray(e)) {
      readable = false;
      continue;
    }
    if (e.type === "result") finished = true;
    // An assistant message is always a list of blocks; a user message may also be plain text. Anything else damages the stream
    const message = e.message as { content?: unknown } | undefined;
    const body = message?.content;
    if (
      (e.type === "assistant" && (typeof message !== "object" || message === null || !Array.isArray(body))) ||
      (e.type === "user" &&
        (typeof message !== "object" ||
          message === null ||
          (typeof body !== "string" && !Array.isArray(body))))
    )
      readable = false;
    const content = Array.isArray(body) ? (body as unknown[]) : [];
    for (const block of content) {
      if (typeof block !== "object" || block === null || Array.isArray(block)) {
        readable = false;
        continue;
      }
      const c = block as Record<string, unknown>;
      if (
        (c.type === "tool_use" && typeof c.id !== "string") ||
        (c.type === "tool_result" && typeof c.tool_use_id !== "string")
      )
        readable = false;
      if (e.type === "assistant" && c.type === "tool_use" && typeof c.id === "string") {
        const call = { id: c.id, name: String(c.name ?? ""), input: c.input, result: null, error: false };
        calls.push(call);
        byId.set(c.id, call);
      }
      if (e.type === "user" && c.type === "tool_result" && typeof c.tool_use_id === "string") {
        const call = byId.get(c.tool_use_id);
        if (!call) continue;
        const body = c.content;
        call.result = Array.isArray(body)
          ? body
              .map((b) =>
                // ToolSearch answers with tool references, which name a tool rather than carry text
                typeof b === "object" && b && "text" in b
                  ? String(b.text)
                  : typeof b === "object" && b && "tool_name" in b
                    ? String(b.tool_name)
                    : "",
              )
              .join("\n")
          : typeof body === "string"
            ? body
            : "";
        if (body !== undefined && typeof body !== "string" && !Array.isArray(body)) readable = false;
        call.error = c.is_error === true;
      }
    }
  }
  return { calls, readable: readable && finished };
}

const SEARCH = "mcp__sphica__search";
const READ = "mcp__sphica__read";

/** Whether a Sphica search or read result in a stream-json run named a gold record. */
export function foundInClaudeStream(events: string | null, gold: string[]): Tri {
  const { calls, readable } = claudeStreamCalls(events);
  const hit = calls.some(
    (c) =>
      c.result !== null &&
      ((c.name === SEARCH && gold.some((k) => inSearch(c.result ?? "", k, true))) ||
        (c.name === READ && gold.some((k) => inRead(c.result ?? "", k, true)))),
  );
  if (hit) return "yes";
  return readable && calls.every((c) => !c.name.startsWith("mcp__sphica__") || c.result !== null)
    ? "no"
    : "unknown";
}

/** The three signals per gold key from a stream-json run, where each call carries its own result. */
export function goldSignalsFromClaudeStream(
  condition: string,
  gold: string[],
  emittedUnits: string[],
  goldHookOutput: string | null,
  events: string | null,
): Record<string, GoldSignal> {
  const { calls, readable } = claudeStreamCalls(events);
  // A Sphica call without its result leaves the stream unable to prove "no"
  const complete = readable && calls.every((c) => !c.name.startsWith("mcp__sphica__") || c.result !== null);
  const seen = (tool: string, key: string, test: typeof inSearch): Tri =>
    calls.some((c) => c.name === tool && c.result !== null && test(c.result, key, true))
      ? "yes"
      : complete
        ? "no"
        : "unknown";
  return Object.fromEntries(
    gold.map((key) => [
      key,
      {
        in_delivery: delivery(condition, key, emittedUnits, goldHookOutput),
        in_search: seen(SEARCH, key, inSearch),
        read: seen(READ, key, inRead),
      },
    ]),
  );
}

/** Tools that never change the work tree; any other tool, including one this list does not know, is taken as one that may. */
const READ_ONLY = new Set(["Read", "Grep", "Glob", "LS", "ToolSearch", "TodoWrite", "WebFetch", "WebSearch"]);

/**
 * Whether a local Claude run searched Sphica before its first edit. The first edit is the call after whose result the work tree first
 * changed; when that change cannot be tied to one call (another call was in flight) the answer is unknown. A run that never changed the tree
 * is "no_edit", kept apart from yes and no. A missing stream or mark log is unknown.
 */
export function searchedBeforeEdit(
  events: string | null,
  marks: string | null,
): "yes" | "no" | "no_edit" | "unknown" {
  const { calls, readable } = claudeStreamCalls(events);
  if (!readable || marks === null) return "unknown";
  const parsed: { after: string; changed: boolean; in_flight: string[]; late: boolean }[] = [];
  for (const line of marks.split("\n")) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line) as Record<string, unknown>;
      if (
        typeof m.after !== "string" ||
        typeof m.changed !== "boolean" ||
        typeof m.late !== "boolean" ||
        !Array.isArray(m.in_flight) ||
        !m.in_flight.every((id) => typeof id === "string")
      )
        return "unknown";
      parsed.push({ after: m.after, changed: m.changed, in_flight: m.in_flight as string[], late: m.late });
    } catch {
      return "unknown";
    }
  }
  // Every result in the stream has its mark, in order; a gap could hide the change that came first
  const answered = calls.filter((c) => c.result !== null).map((c) => c.id);
  // The watcher writes one mark per result as the results arrive, so marks out of that order are damaged too
  if (JSON.stringify(parsed.map((m) => m.after)) !== JSON.stringify(answered)) return "unknown";
  const at0 = parsed.findIndex((m) => m.changed);
  // A mark is tied to its call only when no other call that could write was running beside it: two writers at once can each hide or
  // undo the other's change. Calls that only read (ToolSearch, Read, Sphica's tools) never make a mark ambiguous
  const name = new Map(calls.map((c) => [c.id, c.name]));
  const writes = (id: string) =>
    !READ_ONLY.has(name.get(id) ?? "") && !(name.get(id) ?? "").startsWith("mcp__sphica__");
  const tangled = (m: (typeof parsed)[number]) =>
    m.in_flight.some(writes) && (writes(m.after) || m.in_flight.filter(writes).length > 1);
  // A mark read late may have missed a change a later call undid, so no late mark up to the first change can be trusted
  if (parsed.slice(0, at0 < 0 ? parsed.length : at0 + 1).some((m) => m.late || tangled(m))) return "unknown";
  const first = parsed[at0];
  // A writer whose result never came may have changed the tree after the last mark
  if (!first) return calls.some((c) => c.result === null && writes(c.id)) ? "unknown" : "no_edit";
  // A change seen while a writer was still running may be that writer's
  if (first.in_flight.some(writes)) return "unknown";
  const at = calls.findIndex((c) => c.id === first.after);
  if (at < 0) return "unknown";
  return calls.slice(0, at).some((c) => c.name === "mcp__sphica__search" && c.result !== null) ? "yes" : "no";
}

/**
 * How Sphica's search reached the run before its first call: "deferred" when a ToolSearch result handed it over first (the host had held
 * it back), "loaded" when it was called with no ToolSearch having handed it over (it was there from the start). Without a search call, or
 * from a damaged stream, it cannot be told.
 */
export function searchLoading(events: string | null): "deferred" | "loaded" | "unknown" {
  const { calls, readable } = claudeStreamCalls(events);
  if (!readable) return "unknown";
  const first = calls.findIndex((c) => c.name === "mcp__sphica__search");
  if (first < 0) return "unknown";
  const handed = calls
    .slice(0, first)
    .some((c) => c.name === "ToolSearch" && c.result !== null && c.result.includes("mcp__sphica__search"));
  return handed ? "deferred" : "loaded";
}

/** What the agent sent in a run's stream: Claude's tool inputs and Codex's commands and tool arguments, one per line. */
function agentInputs(events: string): string {
  const out: string[] = [];
  for (const line of events.split("\n")) {
    try {
      const e = JSON.parse(line) as {
        type?: string;
        message?: { content?: unknown };
        item?: { type?: string; command?: unknown; arguments?: unknown };
      };
      if (e.type === "assistant" && Array.isArray(e.message?.content))
        for (const c of e.message.content as { type?: string; input?: unknown }[])
          if (c?.type === "tool_use") out.push(JSON.stringify(c.input ?? null));
      if (e.type === "item.started" && e.item)
        out.push(JSON.stringify([e.item.command ?? null, e.item.arguments ?? null]));
    } catch {}
  }
  return out.join("\n");
}

/**
 * Whether a run's stream shows it reached outside its own run directory into the evaluation's other places: another run, the build (its
 * gold records), or the evaluation cache. The run's own paths are taken out first; any of the places still named in a command, a tool's
 * input, or what came back means the run saw them. Codex has no read fence, so this is how a run that looked is kept out of the results.
 */
export function lookedOutside(events: string | null, own: string[], places: string[]): boolean {
  if (events === null) return false;
  let text = events;
  // JSON escapes the slashes of a path only in some writers; match both spellings
  const spellings = (p: string) => [p, p.replaceAll("/", "\\/")];
  // A path that climbs out of the run's own directory (own/../other) leaves it, whatever it names next
  if (own.flatMap(spellings).some((o) => text.includes(`${o}/..`) || text.includes(`${o}\\/..`))) return true;
  // From the checkout two steps up is the place every run is kept: a command or tool input that climbs that far may reach another
  // run. Only what the agent sent counts here; file contents it read (import paths) often hold ../.. harmlessly
  if (/(^|[^.\w])\.\.[\\/]+\.\.([\\/]|$)/.test(agentInputs(events))) return true;
  for (const o of own.flatMap(spellings).sort((a, b) => b.length - a.length)) text = text.replaceAll(o, "");
  return places.flatMap(spellings).some((p) => p && text.includes(p));
}

/**
 * The record a counterfactual task's run was surely shown, as the gold slot rendered it: only the gold condition gives it for certain, so
 * other conditions' runs are not judged on following it (and a blind prompt carrying it would hint at the condition).
 */
export function presentedText(
  task: string,
  condition: string,
  shown: { id: string; text: string }[],
  counterfactual: Record<string, string[]>,
): string | null {
  if (condition !== "gold" || !counterfactual[task]) return null;
  return shown.find((g) => g.id === task)?.text ?? null;
}

/** Codex's final output checked against answer.schema.json; a valid answer is rendered to text so graders read the same kind of answer. */
export function answerFormat(raw: string | null): {
  format: "valid" | "invalid" | "refused_or_empty";
  reason: string | null;
  text: string;
} {
  if (raw === null || !raw.trim()) return { format: "refused_or_empty", reason: "empty output", text: "" };
  const parsed = parseOutput(raw);
  const checked = parsed.ok ? checkAnswer(parsed.value) : parsed;
  if (!checked.ok) return { format: "invalid", reason: checked.reason, text: raw };
  const a = checked.value;
  return {
    format: "valid",
    reason: null,
    text: [
      a.summary,
      `Implemented the request: ${a.implemented ? "yes" : "no"}`,
      ...(a.past_decisions.length
        ? ["Past decisions:", ...a.past_decisions.map((d) => `- ${d.ref} (${d.how_used})`)]
        : ["Past decisions: none"]),
      ...(a.unverified.length ? ["Unverified:", ...a.unverified.map((u) => `- ${u}`)] : []),
    ].join("\n"),
  };
}

const MAX_PATCH = 60_000;

/** The patch the grader sees, cut at a fixed size with a mark (the grader must then answer unknown for what it cannot see). */
export function capPatch(patch: string): { patch: string; truncated: boolean } {
  if (patch.length <= MAX_PATCH) return { patch, truncated: false };
  return {
    patch: `${patch.slice(0, MAX_PATCH)}\n[patch cut here: ${patch.length - MAX_PATCH} more characters]`,
    truncated: true,
  };
}
