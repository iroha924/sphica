// How the canary's runs are judged before any evaluation run starts. Every check needs evidence in the stream or the receipts: an attempt
// that was not made, or a log that is missing, fails the canary rather than passing it.
import path from "node:path";
import { claudeStreamCalls, type StreamCall } from "./judge.ts";

export type Check = { name: string; ok: boolean; why: string };

/**
 * The five ways a run could touch the sentinel. File tools must name the sentinel exactly; a Bash attempt must be exactly the command the
 * canary asked for, so a command on a look-alike path never counts as an attempt.
 */
export const ATTEMPTS = [
  { name: "Write tool writes the sentinel", tool: "Write", command: null },
  { name: "Edit tool edits the sentinel", tool: "Edit", command: null },
  { name: "Bash writes the sentinel", tool: "Bash", command: (s: string) => `echo x > ${s}` },
  { name: "Read tool reads the sentinel", tool: "Read", command: null },
  { name: "Bash reads the sentinel", tool: "Bash", command: (s: string) => `cat ${s}` },
] as const;

/** The permission denials the stream reported, by tool call id: the host refused the call before it ran. */
function deniedIds(events: string): Set<string> {
  const ids = new Set<string>();
  for (const line of events.split("\n")) {
    try {
      const e = JSON.parse(line) as { type?: string; subtype?: string; tool_use_id?: string };
      if (e.type === "system" && e.subtype === "permission_denied" && e.tool_use_id) ids.add(e.tool_use_id);
    } catch {}
  }
  return ids;
}

const aims = (c: StreamCall, a: (typeof ATTEMPTS)[number], sentinel: string) => {
  const input = (c.input ?? {}) as { file_path?: unknown; command?: unknown };
  return a.command
    ? String(input.command ?? "").trim() === a.command(sentinel)
    : input.file_path === sentinel;
};

/**
 * The permission canary: each attempt was made on the sentinel and came back refused (a denial or an error result), the sentinel is
 * unchanged, and its secret never appears in the stream.
 */
export function permissionChecks(
  events: string | null,
  sentinel: string,
  secret: string,
  unchanged: boolean,
): Check[] {
  const { calls, readable } = claudeStreamCalls(events);
  const denied = deniedIds(events ?? "");
  const checks: Check[] = [
    { name: "the stream is complete", ok: readable, why: readable ? "" : "missing, broken, or cut off" },
  ];
  for (const a of ATTEMPTS) {
    const tries = calls.filter((c) => c.name === a.tool && aims(c, a, sentinel));
    const refused = tries.filter((c) => denied.has(c.id) || c.error);
    checks.push({
      name: a.name,
      ok: tries.length > 0 && refused.length === tries.length,
      why: !tries.length
        ? "not attempted"
        : refused.length < tries.length
          ? `${tries.length - refused.length} of ${tries.length} attempts were not refused`
          : "",
    });
  }
  checks.push({
    name: "the sentinel is unchanged",
    ok: unchanged,
    why: unchanged ? "" : "its content changed",
  });
  const leaked = (events ?? "").includes(secret);
  checks.push({
    name: "the sentinel's secret is not in the stream",
    ok: !leaked,
    why: leaked ? "it was read" : "",
  });
  return checks;
}

type Receipt = { name: string; file?: string; memory?: string };

const receiptsOf = (text: string): Receipt[] =>
  text.split("\n").flatMap((l) => {
    try {
      return l.trim() ? [JSON.parse(l) as Receipt] : [];
    } catch {
      return [{ name: "unreadable" }];
    }
  });

/** The instruction files the run loaded, from the receipts of the InstructionsLoaded hook. */
export const loadedInstructions = (receipts: string) =>
  receiptsOf(receipts).filter((r) => r.name === "instructions");

/**
 * The context canary of one condition: the init event names exactly the MCP servers the condition has, Sphica's tools appear only where
 * they should, the hooks of the condition ran, and every instruction file loaded is the checkout's own. `control` is true for the positive
 * control, a run whose checkout holds a CLAUDE.md, which must show that file loading (otherwise the receipts prove nothing).
 */
export function contextChecks(
  condition: string,
  events: string | null,
  receipts: string,
  work: string,
  control: boolean,
): Check[] {
  type Init = { mcp_servers?: { name: string; status: string }[]; tools?: string[] };
  let init: Init | null = null;
  for (const line of (events ?? "").split("\n")) {
    try {
      const e = JSON.parse(line) as Init & { type?: string; subtype?: string };
      if (e.type === "system" && e.subtype === "init") init = e;
    } catch {}
  }
  const complete = claudeStreamCalls(events).readable;
  const sphica = condition === "search" || condition === "inject";
  const servers = (init?.mcp_servers ?? []).map((s) => `${s.name}:${s.status}`).sort();
  const tools = (init?.tools ?? []).filter((t) => t.startsWith("mcp__"));
  const loaded = loadedInstructions(receipts);
  const names = receiptsOf(receipts).map((r) => r.name);
  const hooksWanted =
    condition === "inject"
      ? ["start", "prompt"]
      : condition === "gold"
        ? ["start", "gold"]
        : ["start", "prompt"];
  const inside = (file: string | undefined) => Boolean(file?.startsWith(work + path.sep));
  const foreign = loaded.filter((r) => r.memory !== "Project" || !inside(r.file));
  const broken = names.filter((n) => n === "unreadable").length;
  const planted = path.join(work, "CLAUDE.md");
  return [
    { name: "the stream is complete", ok: complete, why: complete ? "" : "missing, broken, or cut off" },
    {
      name: "every receipt is readable",
      ok: broken === 0,
      why: broken ? `${broken} unreadable receipts` : "",
    },
    { name: "init event present", ok: init !== null, why: init ? "" : "no init event in the stream" },
    {
      name: "MCP servers are the condition's",
      ok: JSON.stringify(servers) === JSON.stringify(sphica ? ["sphica:connected"] : []),
      why: `servers: ${servers.join(", ") || "none"}`,
    },
    {
      name: "Sphica's tools only where the condition has them",
      ok: sphica ? tools.includes("mcp__sphica__search") : tools.length === 0,
      why: `MCP tools: ${tools.join(", ") || "none"}`,
    },
    {
      name: "the condition's hooks ran",
      ok: hooksWanted.every((h) => names.includes(h)),
      why: `receipts: ${[...new Set(names)].join(", ") || "none"}`,
    },
    {
      name: "only the checkout's instruction files loaded",
      ok:
        foreign.length === 0 &&
        (!control || loaded.some((r) => r.memory === "Project" && r.file === planted)),
      why: foreign.length
        ? `loaded: ${foreign.map((r) => `${r.memory} ${r.file}`).join(", ")}`
        : control && !loaded.length
          ? "the control's CLAUDE.md did not show as loaded, so the receipts cannot prove absence"
          : "",
    },
  ];
}
