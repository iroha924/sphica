// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Reads what the hooks beneath handed the agent and lists Sphica's part in a pane. Every hook returns the result beneath unchanged,
// and its .catch replays that result: next() never runs Sphica's hooks twice, so a failure here cannot repeat a delivery or a stop.
import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";
import { heading, LIMITS, layout, omitted, type Result, sift } from "./sift.ts";

const PANE = "sphica-delivered";
const delivered = atom({ plugin: "sphica-pane", key: "delivered" } as const, []);

async function keep($: EngineInterface, event: string, result: Result): Promise<void> {
  const rows = sift(result, event, new Date().toTimeString().slice(0, 8));
  if (rows.length > 0) await update($, delivered, (list) => [...list, ...rows].slice(-LIMITS.kept));
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "sphica-pane",
      description: "Show what Sphica's hooks handed the agent in this session",
    });
    return next(e);
  });

  on("command.run", { command: "sphica-pane" }, async ($) => {
    await $.ui.open({ id: PANE, title: "Sphica" });
    return { text: "Sphica pane opened. Close it with ctrl+x x." };
  });

  on("classic.SessionStart", async ($, e, next) => {
    const result = await next(e);
    await keep($, "SessionStart", result).catch(() => {});
    return result;
  }).catch(($, e, replay) => replay(e));

  on("classic.SubagentStart", async ($, e, next) => {
    const result = await next(e);
    await keep($, "SubagentStart", result).catch(() => {});
    return result;
  }).catch(($, e, replay) => replay(e));

  on("classic.UserPromptSubmit", async ($, e, next) => {
    const result = await next(e);
    await keep($, "UserPromptSubmit", result).catch(() => {});
    return result;
  }).catch(($, e, replay) => replay(e));

  on("classic.UserPromptExpansion", async ($, e, next) => {
    const result = await next(e);
    await keep($, "UserPromptExpansion", result).catch(() => {});
    return result;
  }).catch(($, e, replay) => replay(e));

  on("classic.PreToolUse", async ($, e, next) => {
    const result = await next(e);
    await keep($, "PreToolUse", result).catch(() => {});
    return result;
  }).catch(($, e, replay) => replay(e));

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    const { shown, cut, hidden } = layout(await read($, delivered));
    const note = omitted(cut, hidden);
    return (
      <Box flexDirection="column">
        {shown.length === 0 && <Text dimColor>Sphica has handed nothing over in this session yet.</Text>}
        {shown.map((row) => (
          <Box flexDirection="column">
            <Text bold color={row.kind === "stop" ? "yellow" : undefined}>
              {heading(row)}
            </Text>
            <Text>{row.text}</Text>
          </Box>
        ))}
        {note && <Text dimColor>{note}</Text>}
      </Box>
    );
  });
};
