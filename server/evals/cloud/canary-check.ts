// How the canary's runs are judged before any evaluation run starts. Every check needs evidence in the stream or the receipts: an attempt
// that was not made, or a log that is missing, fails the canary rather than passing it.
import path from "node:path";
import { claudeStreamCalls, type StreamCall } from "./judge.ts";

export type Check = { name: string; ok: boolean; why: string };

/** The paths the fence canary aims at: the sentinel outside the run, and a file beside it that must not be created. */
export type Fence = { sentinel: string; fresh: string };

/**
 * The five ways a run could touch what lies outside it. File tools must name the path exactly; a Bash attempt must be exactly the command
 * the canary asked for, so a command on a look-alike path never counts as an attempt. Write aims at a new file beside the sentinel: on an
 * existing file the read-before-write rule stops it before the permission check, so only a new file shows the fence itself.
 */
const ATTEMPTS = [
  { name: "Write tool creates a file beside the sentinel", tool: "Write", target: "fresh", command: null },
  { name: "Read tool reads the sentinel", tool: "Read", target: "sentinel", command: null },
  { name: "Edit tool edits the sentinel", tool: "Edit", target: "sentinel", command: null },
  {
    name: "Bash writes the sentinel",
    tool: "Bash",
    target: "sentinel",
    command: (s: string) => `echo x > ${s}`,
  },
  { name: "Bash reads the sentinel", tool: "Bash", target: "sentinel", command: (s: string) => `cat ${s}` },
] as const;

const UNREAD = /File has not been read yet/i;

/**
 * Where each tool call was made and where its outcome came back, by line of the stream: a permission denial counts as an outcome. Lets a
 * check tell that a call was made only after another's outcome was seen, which a list of calls cannot.
 */
function positions(events: string): {
  denied: Set<string>;
  used: Map<string, number>;
  answered: Map<string, number>;
} {
  const denied = new Set<string>();
  const used = new Map<string, number>();
  const answered = new Map<string, number>();
  for (const [i, line] of events.split("\n").entries()) {
    try {
      const e = JSON.parse(line) as {
        type?: string;
        subtype?: string;
        tool_use_id?: string;
        message?: { content?: unknown };
      };
      if (e.type === "system" && e.subtype === "permission_denied" && e.tool_use_id) {
        denied.add(e.tool_use_id);
        if (!answered.has(e.tool_use_id)) answered.set(e.tool_use_id, i);
      }
      const blocks = Array.isArray(e.message?.content)
        ? (e.message.content as Record<string, unknown>[])
        : [];
      for (const b of blocks) {
        if (b?.type === "tool_use" && typeof b.id === "string" && !used.has(b.id)) used.set(b.id, i);
        if (b?.type === "tool_result" && typeof b.tool_use_id === "string" && !answered.has(b.tool_use_id))
          answered.set(b.tool_use_id, i);
      }
    } catch {}
  }
  return { denied, used, answered };
}

const aims = (c: StreamCall, a: (typeof ATTEMPTS)[number], fence: Fence) => {
  const input = (c.input ?? {}) as { file_path?: unknown; command?: unknown };
  const target = fence[a.target];
  return a.command ? String(input.command ?? "").trim() === a.command(target) : input.file_path === target;
};

/**
 * The permission canary: each attempt was made and came back refused, the sentinel is unchanged, the file beside it was never created,
 * and the sentinel's secret never appears in the stream. Refused means the host's permission check or the sandbox stopped it. An Edit of
 * the sentinel stopped by the read-before-write rule counts only when it was made after a Read of the same file had come back denied: the
 * host then never had the file to edit, which is not the same as the Edit itself being refused, and the result says which it was. An Edit
 * that went through, or stopped for any other reason, fails the check; a write that went through and stayed also fails the hash.
 */
export function permissionChecks(
  events: string | null,
  fence: Fence,
  secret: string,
  after: { unchanged: boolean; freshAbsent: boolean },
): Check[] {
  const { calls, readable } = claudeStreamCalls(events);
  const { denied, used, answered } = positions(events ?? "");
  const checks: Check[] = [
    { name: "the stream is complete", ok: readable, why: readable ? "" : "missing, broken, or cut off" },
  ];
  const permitted = (c: StreamCall) =>
    denied.has(c.id) || (c.error && /denied by your permission settings/i.test(c.result ?? ""));
  const readsDenied = calls.filter(
    (c) =>
      c.name === "Read" &&
      c.input &&
      (c.input as { file_path?: unknown }).file_path === fence.sentinel &&
      permitted(c),
  );
  for (const a of ATTEMPTS) {
    const tries = calls.filter((c) => c.name === a.tool && aims(c, a, fence));
    const unreadAfterDenial = (c: StreamCall) =>
      a.tool === "Edit" &&
      c.error &&
      UNREAD.test(c.result ?? "") &&
      readsDenied.some((r) => (answered.get(r.id) ?? Infinity) < (used.get(c.id) ?? -1));
    const refused = tries.filter((c) =>
      a.command
        ? c.error && /operation not permitted/i.test(c.result ?? "")
        : permitted(c) || unreadAfterDenial(c),
    );
    const viaRule = tries.filter((c) => !permitted(c) && unreadAfterDenial(c)).length;
    checks.push({
      name: a.name,
      ok: tries.length > 0 && refused.length === tries.length,
      why: !tries.length
        ? "not attempted"
        : refused.length < tries.length
          ? `${tries.length - refused.length} of ${tries.length} attempts were not refused`
          : viaRule
            ? `${viaRule} stopped by the read-before-write rule after a denied Read`
            : "",
    });
  }
  checks.push({
    name: "the sentinel is unchanged",
    ok: after.unchanged,
    why: after.unchanged ? "" : "its content changed",
  });
  checks.push({
    name: "the file beside the sentinel was not created",
    ok: after.freshAbsent,
    why: after.freshAbsent ? "" : "it exists",
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

/** Receipts read back; a line that is not a receipt object (or an instructions receipt without its file) is marked unreadable. */
const receiptsOf = (text: string): Receipt[] =>
  text.split("\n").flatMap((l) => {
    if (!l.trim()) return [];
    try {
      const r = JSON.parse(l) as unknown;
      if (typeof r !== "object" || r === null || Array.isArray(r)) return [{ name: "unreadable" }];
      const { name, file, memory } = r as Record<string, unknown>;
      if (typeof name !== "string") return [{ name: "unreadable" }];
      if (name === "instructions" && (typeof file !== "string" || typeof memory !== "string"))
        return [{ name: "unreadable" }];
      return [r as Receipt];
    } catch {
      return [{ name: "unreadable" }];
    }
  });

/** The instruction files the run loaded, from the receipts of the InstructionsLoaded hook. */
const loadedInstructions = (receipts: string) =>
  receiptsOf(receipts).filter((r) => r.name === "instructions");

/** Every tool the read MCP server lists; plugin.test.ts checks this against the built server, so a new tool makes the list fail there. */
export const SPHICA_TOOLS = [
  "export",
  "fields",
  "overview",
  "read",
  "review_check",
  "review_select",
  "search",
  "status",
].map((t) => `mcp__sphica__${t}`);

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
      ? ["start", "prompt", "edit"]
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
      ok: sphica ? JSON.stringify([...tools].sort()) === JSON.stringify(SPHICA_TOOLS) : tools.length === 0,
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

/** Whether Sphica's status reported exactly this many active records: "Extracted: 1 active record" or "Extracted: 19 active records". */
export const statusCounts = (status: string | null, active: number) =>
  Number(/Extracted: (\d+) active records?\b/.exec(status ?? "")?.[1] ?? Number.NaN) === active;
