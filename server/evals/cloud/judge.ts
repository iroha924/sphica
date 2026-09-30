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

/** The three signals per gold key from Codex's JSONL events, where each tool call carries its own result. */
export function goldSignalsFromCodex(
  condition: string,
  gold: string[],
  emittedUnits: string[],
  goldHookOutput: string | null,
  events: string | null,
): Record<string, GoldSignal> {
  // Any line that is not an event object, or a Sphica call without a result, leaves the log unable to prove "no"
  let readable = events !== null && events.trim() !== "";
  const results: { tool: string; text: string }[] = [];
  for (const line of readable ? (events ?? "").split("\n") : []) {
    if (!line.trim()) continue;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      readable = false;
      break;
    }
    if (typeof e !== "object" || e === null) {
      readable = false;
      break;
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
      break;
    }
    results.push({ tool: it.tool, text: it.result.content.map((c) => c.text ?? "").join("\n") });
  }
  const seen = (tool: string, key: string, test: typeof inSearch): Tri =>
    !readable ? "unknown" : results.some((r) => r.tool === tool && test(r.text, key, true)) ? "yes" : "no";
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
