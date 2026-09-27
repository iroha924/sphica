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
