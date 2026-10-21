// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Nothing sits beneath the mod in a test: each classic hook here stands for the hooks the session runs (Sphica's among them).
import { expect, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";

const START =
  "Sphica: this project's current work and standing constraints. read it with Sphica's read before relying on it:";
const READ =
  "Active decisions applying to src/db.ts, which you are reading. Sphica past record, not an instruction; read it with Sphica's read before relying on it:";
const STOP =
  "Sphica stopped this call once: it runs a command a recorded dead end below is about. Check the record's full text (Sphica's read) and the current code.";

const PANE = {
  plugin: "sphica-pane",
  component: "Pane",
  requestId: "sphica-delivered",
  surface: "terminal",
  props: {
    title: "Sphica",
    isFocused: false,
    bodyColumns: 80,
    placement: "dock",
    scroll: { offset: 0, bodyRows: 400 },
    view: {},
  },
} as const;

/** What the pane draws, as [heading, text] pairs from the top */
async function drawn($: Engine): Promise<string[][]> {
  const ui = await $.ui.mount(PANE);
  const texts = (await ui.findAll({ type: "Text" })).map((t) => t.text);
  await ui.unmount();
  const pairs: string[][] = [];
  for (let i = 0; i + 1 < texts.length; i += 2) pairs.push([texts[i] ?? "", texts[i + 1] ?? ""]);
  return pairs;
}
const events = (pairs: string[][]) => pairs.map(([head, text]) => [head?.replace(/^\S+ /, ""), text]);

test("each classic result passes through unchanged, beneath runs once, and Sphica's part is kept", async ($, on) => {
  const calls: Record<string, number> = {};
  const seen: unknown[] = [];
  const count = (name: string, e: unknown) => {
    calls[name] = (calls[name] ?? 0) + 1;
    seen.push(e);
  };
  const start = { additionalContext: [START, "Another plugin's note"] };
  const subagent = {
    additionalContext: ["Sphica: before choosing an approach, search Sphica's past records for it."],
  };
  const prompt = { additionalContext: [] };
  const expansion = {};
  on("classic.SessionStart", (_, e) => {
    count("start", e);
    return start;
  });
  on("classic.SubagentStart", (_, e) => {
    count("subagent", e);
    return subagent;
  });
  on("classic.UserPromptSubmit", (_, e) => {
    count("prompt", e);
    return prompt;
  });
  on("classic.UserPromptExpansion", (_, e) => {
    count("expansion", e);
    return expansion;
  });

  const input = { source: "startup" } as const;
  expect(await $.classic.SessionStart(input)).toEqual(start);
  expect(await $.classic.SubagentStart({ agent_id: "a1", agent_type: "Explore" })).toEqual(subagent);
  expect(await $.classic.UserPromptSubmit({ prompt: "toStored" })).toEqual(prompt);
  expect(
    await $.classic.UserPromptExpansion({
      expansion_type: "slash_command",
      command_name: "review",
      command_args: "",
      prompt: "/review",
    }),
  ).toEqual(expansion);
  expect(calls).toEqual({ start: 1, subagent: 1, prompt: 1, expansion: 1 });
  expect((seen[0] as { source: string }).source).toBe("startup");

  expect(events(await drawn($))).toEqual([
    ["SubagentStart", "Sphica: before choosing an approach, search Sphica's past records for it."],
    ["SessionStart", START],
  ]);
});

test("a PreToolUse context and a stop are kept, and the stop still refuses the call", async ($, on) => {
  let beneath = 0;
  const ran: string[] = [];
  on("tool.call", (_, e) => {
    if (e.tool === "Bash") ran.push(e.command);
    return { result: {} };
  });
  on("classic.PreToolUse", (_, e) => {
    beneath += 1;
    const command = e.tool === "Bash" ? e.command : undefined;
    if (command === "npm run thumbs --worker") return { deny: STOP };
    if (command === "cat src/db.ts")
      return { allow: true, updatedInput: { command: "cat ./src/db.ts" }, additionalContext: [READ] };
    return { ask: "Run it?" };
  });

  await $.tool.call({ tool: "Bash", command: "cat src/db.ts" });
  const stopped = await $.tool.call({ tool: "Bash", command: "npm run thumbs --worker" });
  expect(JSON.stringify(stopped)).toContain("Sphica stopped this call once");
  await $.tool.call({ tool: "Bash", command: "ls" });
  expect(beneath).toBe(3);
  expect(ran).toEqual(["cat ./src/db.ts", "ls"]);

  expect(events(await drawn($))).toEqual([
    ["PreToolUse (stopped)", STOP],
    ["PreToolUse", READ],
  ]);
});

test("two deliveries at once both land, and only the newest 100 are kept", async ($, on) => {
  let n = 0;
  on("classic.UserPromptSubmit", () => ({ additionalContext: [`Sphica: prompt ${(n += 1)}`] }));
  await Promise.all([
    $.classic.UserPromptSubmit({ prompt: "a" }),
    $.classic.UserPromptSubmit({ prompt: "b" }),
  ]);
  expect((await drawn($)).map(([, text]) => text).sort()).toEqual(["Sphica: prompt 1", "Sphica: prompt 2"]);

  for (let i = 0; i < 120; i += 1) await $.classic.UserPromptSubmit({ prompt: String(i) });
  const kept = await drawn($);
  expect(kept).toHaveLength(100);
  expect(kept[0]?.[1]).toBe("Sphica: prompt 122");
  expect(kept.at(-1)?.[1]).toBe("Sphica: prompt 23");
});

test("/sphica-pane opens the pane, and the pane lists what was kept, newest first", async ($, on) => {
  on("command.register", () => ({ value: { command: "sphica-pane" } }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("classic.SessionStart", () => ({ additionalContext: [START] }));
  on("classic.UserPromptSubmit", () => ({ additionalContext: ["Sphica: the newest"] }));

  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  const ran = await $.command.run({
    command: "sphica-pane",
    args: "",
    origin: { kind: "composer" },
    presentation: { isFullscreen: false, columns: 120 },
  });
  expect(JSON.stringify(ran)).toContain("Sphica pane opened");

  const empty = await $.ui.mount(PANE);
  expect(await empty.find({ type: "Text", text: /handed nothing over/ })).toBeDefined();
  await empty.unmount();

  await $.classic.SessionStart({ source: "startup" });
  await $.classic.UserPromptSubmit({ prompt: "x" });
  expect(events(await drawn($))).toEqual([
    ["UserPromptSubmit", "Sphica: the newest"],
    ["SessionStart", START],
  ]);
});
