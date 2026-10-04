/**
 * Who called a record tool, read only from what the host passes to the MCP server, never from arguments the model writes.
 * Claude Code puts no turn in a call (only its tool use id, which the PreToolUse hook also sees); Codex puts its turn in x-codex-turn-metadata.
 * A value not classified here is unknown, and an unknown caller never adopts an AI decision.
 */
type Mode = "interactive" | "headless" | "sdk" | "unknown";

export type Caller = {
  host: "claude-code" | "codex" | null;
  session: string | null;
  /** Codex's turn id. Claude Code gives none; its turn comes from the PreToolUse hook */
  turn: string | null;
  /** Claude Code's tool use id, which the PreToolUse hook also sees */
  toolUseId: string | null;
  mode: Mode;
  /** The raw value the mode was read from (entrypoint or turn_trigger), kept for later measurement */
  raw: string | null;
};

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export function callerOf(meta: unknown, env: NodeJS.ProcessEnv = process.env): Caller {
  // A Codex started from a Claude Code shell inherits Claude Code's variables, so Codex's own metadata comes first
  const codex = record(record(meta)?.["x-codex-turn-metadata"]);
  if (codex) {
    // Interactive Codex's turn_trigger values are not measured yet, so only exec is classified
    const trigger = text(codex.turn_trigger);
    return {
      host: "codex",
      session: text(codex.session_id),
      turn: text(codex.turn_id),
      toolUseId: null,
      mode: trigger === "exec" ? "headless" : "unknown",
      raw: trigger,
    };
  }
  const toolUseId = text(record(meta)?.["claudecode/toolUseId"]);
  const entrypoint = text(env.CLAUDE_CODE_ENTRYPOINT);
  if (!toolUseId && !entrypoint)
    return { host: null, session: null, turn: null, toolUseId: null, mode: "unknown", raw: null };
  const session = text(env.CLAUDE_CODE_SESSION_ID);
  const parent = text(env.SPHICA_PARENT_SESSION);
  // The Agent SDK keeps an inherited cli (it sets sdk-* only when unset), so cli counts only without a parent marker naming another session.
  const mode: Mode =
    entrypoint === "sdk-cli"
      ? "headless"
      : entrypoint?.startsWith("sdk-")
        ? "sdk"
        : entrypoint === "cli" && session && (!parent || parent === session)
          ? "interactive"
          : "unknown";
  return { host: "claude-code", session, turn: null, toolUseId, mode, raw: entrypoint };
}
