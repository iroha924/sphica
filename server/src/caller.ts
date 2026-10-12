// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

/**
 * Who called a record tool, read only from what the host passes to the MCP server, never from arguments the model writes.
 * Claude Code puts no turn in a call (only its tool use id, which the PreToolUse hook also sees); Codex puts its session, thread, and turn in
 * x-codex-turn-metadata.
 * A value not classified here is unknown, and an unknown caller never adopts an AI decision.
 */
type Mode = "interactive" | "headless" | "sdk" | "unknown";

export type Caller = {
  host: "claude-code" | "codex" | null;
  session: string | null;
  /** Codex's turn id, for the owner's own thread only. Claude Code gives none; its turn comes from the PreToolUse hook */
  turn: string | null;
  /** Claude Code's tool use id, which the PreToolUse hook also sees */
  toolUseId: string | null;
  mode: Mode;
  /** The raw value the mode was read from (entrypoint, or turn_trigger with thread_source after it for another thread), kept for later measurement */
  raw: string | null;
};

// Hosts send ids and short names here; anything else (too long, spaces, control characters) is kept as unknown, never stored as sent
const text = (v: unknown): string | null =>
  typeof v === "string" && /^[\x21-\x7e]{1,200}$/.test(v) ? v : null;
const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export function callerOf(meta: unknown, env: NodeJS.ProcessEnv = process.env): Caller {
  // A Codex started from a Claude Code shell inherits Claude Code's variables, so Codex's own metadata comes first
  const codex = record(record(meta)?.["x-codex-turn-metadata"]);
  if (codex) {
    const session = text(codex.session_id);
    const source = text(codex.thread_source);
    const trigger = text(codex.turn_trigger);
    // A thread spawned in a session carries the parent's session id and the trigger of the parent's turn; only its thread id and source differ
    const own = session !== null && session === text(codex.thread_id) && source === "user";
    return {
      host: "codex",
      session,
      // A child's turn is none of the parent's, so its call is logged as one that cannot be placed
      turn: own ? text(codex.turn_id) : null,
      toolUseId: null,
      // The client sends the trigger: measured as user from the terminal and exec from codex exec; anything else stays unknown
      mode: trigger === "exec" ? "headless" : own && trigger === "user" ? "interactive" : "unknown",
      raw:
        own || (trigger === null && source === null)
          ? trigger
          : text(`${trigger ?? "none"}:${source ?? "none"}`),
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
