// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Codex runs a plugin hook only while the hash of its current definition equals `[hooks.state."<key>"] trusted_hash` in config.toml.
// The hash rule here is Codex 0.160.0's hook_hash. Another version may hash differently while an old stored hash still matches this
// rule, so only verified versions are compared.

import crypto from "node:crypto";
import { parse } from "smol-toml";

export const CODEX_TRUST_VERIFIED = ["0.160.0"];

export type HookState = { enabled?: boolean; trusted_hash?: string };
export type HookTrust = {
  key: string;
  hash: string;
  trust: "trusted" | "modified" | "untrusted";
  enabled: boolean;
};
export type TrustResult = { hooks: HookTrust[] } | { unknown: string };

const LABELS: Record<string, string> = {
  PreToolUse: "pre_tool_use",
  PermissionRequest: "permission_request",
  PostToolUse: "post_tool_use",
  PreCompact: "pre_compact",
  PostCompact: "post_compact",
  SessionStart: "session_start",
  SessionEnd: "session_end",
  UserPromptSubmit: "user_prompt_submit",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  Stop: "stop",
  Interrupt: "interrupt",
};
// Codex drops the matcher of these events before hashing
const NO_MATCHER = new Set(["UserPromptSubmit", "Stop", "Interrupt"]);
// Only these events can return context, so only they keep additionalContextLimit; 2500 is Codex's default and is dropped too
const CONTEXT = new Set(["PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit", "SubagentStart"]);
const DEFAULT_CONTEXT_LIMIT = 2500;
// Clamped to 1..3 seconds with a default of 1; every other event defaults to 600
const SHORT = new Set(["SessionEnd", "Interrupt"]);

// Rust's char::is_whitespace, which Codex trims state keys with: unlike String.prototype.trim it drops U+0085 and keeps U+FEFF
const RUST_SPACE =
  /^[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+|[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$/g;

const isTable = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** JSON with every object's keys sorted, as serde_json writes Codex's canonical value. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isTable(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

export const sha256 = (text: string): string =>
  `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;

/** The `hooks.state` table of config.toml, keyed by trimmed key. A missing file means nothing is trusted yet. */
export function readHookStates(configToml: string | null): Map<string, HookState> | { unknown: string } {
  const states = new Map<string, HookState>();
  if (configToml === null) return states;
  let config: unknown;
  try {
    config = parse(configToml);
  } catch {
    return { unknown: "config.toml could not be parsed" };
  }
  const hooks = isTable(config) ? config.hooks : undefined;
  if (hooks === undefined) return states;
  const table = isTable(hooks) ? hooks.state : undefined;
  if (table === undefined) return states;
  if (!isTable(table)) return { unknown: "hooks.state in config.toml is not a table" };
  for (const [raw, value] of Object.entries(table)) {
    const key = raw.replace(RUST_SPACE, "");
    // Codex skips an entry it cannot read as a state, as if it were not there
    if (!key || !isTable(value)) continue;
    const { enabled, trusted_hash } = value;
    if (
      (enabled !== undefined && typeof enabled !== "boolean") ||
      (trusted_hash !== undefined && typeof trusted_hash !== "string")
    )
      continue;
    const s = states.get(key) ?? {};
    if (enabled !== undefined) s.enabled = enabled;
    if (trusted_hash !== undefined) s.trusted_hash = trusted_hash;
    states.set(key, s);
  }
  return states;
}

/**
 * Each handler of a plugin hooks file with its state key, current hash, and trust. Anything Sphica does not ship (another handler type,
 * an unknown event, a field of the wrong type) makes the whole answer unknown rather than a count that leaves hooks out.
 */
export function hookTrust(
  hooksJson: string,
  pluginId: string,
  relativePath: string,
  platform: NodeJS.Platform,
  states: Map<string, HookState>,
): TrustResult {
  let file: unknown;
  try {
    // Codex reads these numbers as whole numbers, so 600.0 or 6e2 fails its read even though JSON.parse makes them 600
    file = JSON.parse(hooksJson, (_key, value, context?: { source?: string }) =>
      typeof value === "number" && /[.eE]/.test(context?.source ?? "") ? Number.NaN : value,
    );
  } catch {
    return { unknown: "the hooks file is not JSON" };
  }
  // Codex refuses the whole file for any other top-level key, or a description that is not a string
  if (
    isTable(file) &&
    (Object.keys(file).some((k) => k !== "hooks" && k !== "description") ||
      (file.description != null && typeof file.description !== "string"))
  )
    return { unknown: "the hooks file has a top-level field Codex would not read" };
  const events = isTable(file) ? file.hooks : undefined;
  if (!isTable(events)) return { unknown: "the hooks file has no hooks table" };
  const hooks: HookTrust[] = [];
  for (const [event, groups] of Object.entries(events)) {
    const label = LABELS[event];
    if (!label) return { unknown: `the hooks file has an event Codex does not know (${event})` };
    if (!Array.isArray(groups)) return { unknown: `${event} in the hooks file is not a list` };
    for (const [g, group] of groups.entries()) {
      if (!isTable(group) || !Array.isArray(group.hooks))
        return { unknown: `a ${event} group has no hooks list` };
      if (group.matcher !== undefined && group.matcher !== null && typeof group.matcher !== "string")
        return { unknown: `a ${event} matcher is not a string` };
      const matcher = NO_MATCHER.has(event) ? undefined : (group.matcher ?? undefined);
      for (const [h, handler] of group.hooks.entries()) {
        if (!isTable(handler) || handler.type !== "command")
          return { unknown: `a ${event} hook is not a command` };
        const { command, timeout, statusMessage, additionalContextLimit } = handler;
        // Two names for one field: Codex fails the whole file when both are given
        if ("commandWindows" in handler && "command_windows" in handler)
          return { unknown: `a ${event} hook names its Windows command twice` };
        const commandWindows = handler.commandWindows ?? handler.command_windows;
        if (
          typeof command !== "string" ||
          (commandWindows !== undefined && commandWindows !== null && typeof commandWindows !== "string") ||
          (timeout !== undefined && timeout !== null && !isCount(timeout)) ||
          (handler.async !== undefined && typeof handler.async !== "boolean") ||
          (statusMessage !== undefined && statusMessage !== null && typeof statusMessage !== "string") ||
          (additionalContextLimit !== undefined &&
            additionalContextLimit !== null &&
            !isCount(additionalContextLimit))
        )
          return { unknown: `a ${event} hook has a field Codex would not read` };
        const chosen =
          platform === "win32" ? ((commandWindows as string | null | undefined) ?? command) : command;
        if (!chosen.trim()) return { unknown: `a ${event} hook has an empty command` };
        const given = timeout ?? undefined;
        const seconds = SHORT.has(event) ? Math.min(Math.max(given ?? 1, 1), 3) : Math.max(given ?? 600, 1);
        const limit =
          CONTEXT.has(event) &&
          additionalContextLimit != null &&
          additionalContextLimit !== DEFAULT_CONTEXT_LIMIT
            ? additionalContextLimit
            : undefined;
        const normalized: Record<string, unknown> = {
          type: "command",
          command: chosen,
          timeout: seconds,
          async: handler.async === true,
        };
        if (typeof statusMessage === "string") normalized.statusMessage = statusMessage;
        if (limit !== undefined) normalized.additionalContextLimit = limit;
        const identity: Record<string, unknown> = { event_name: label, hooks: [normalized] };
        if (typeof matcher === "string") identity.matcher = matcher;
        const hash = sha256(canonical(identity));
        const key = `${pluginId}:${relativePath}:${label}:${g}:${h}`;
        const state = states.get(key);
        const stored = state?.trusted_hash;
        const trust = stored === undefined ? "untrusted" : stored === hash ? "trusted" : "modified";
        hooks.push({ key, hash, trust, enabled: state?.enabled !== false });
      }
    }
  }
  if (!hooks.length) return { unknown: "the hooks file defines no hooks" };
  return { hooks };
}
