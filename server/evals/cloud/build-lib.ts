// Pieces of building a slot that the builder and the local runner share, kept apart from build.ts so tests can reach them.
import fs from "node:fs";
import path from "node:path";
import { openWriter } from "../../src/db-write.ts";
import { loadAcceptance, type Step } from "../acceptance/load.ts";

/** The shipped delivery hook's PreToolUse matcher, so an inject slot fires on the same tools the plugin does. */
export function deliverMatcher(hooksJson: string): string {
  const hooks = JSON.parse(hooksJson) as {
    hooks: { PreToolUse: { matcher: string; hooks: { command: string; args?: string[] }[] }[] };
  };
  // The shipped hooks are in exec form: the script is an argument, not part of the command
  const entry = hooks.hooks.PreToolUse.find((e) =>
    e.hooks.some((h) => [h.command, ...(h.args ?? [])].some((a) => a.includes("deliver.js"))),
  );
  if (!entry) throw new Error("plugin/hooks/hooks.json has no PreToolUse delivery hook");
  return entry.matcher;
}

export const shippedMatcher = (root: string) =>
  deliverMatcher(fs.readFileSync(path.join(root, "plugin", "hooks", "hooks.json"), "utf8"));

/** The matcher of Codex's delivery hook before a tool, as plugin/hooks/codex.json ships it. */
export function codexDeliverMatcher(hooksJson: string): string {
  const hooks = JSON.parse(hooksJson) as {
    hooks: { PreToolUse?: { matcher: string; hooks: { command: string }[] }[] };
  };
  const entry = hooks.hooks.PreToolUse?.find((e) => e.hooks.some((h) => h.command.includes("deliver.js")));
  if (!entry) throw new Error("plugin/hooks/codex.json has no PreToolUse delivery hook");
  return entry.matcher;
}

export const shippedCodexMatcher = (root: string) =>
  codexDeliverMatcher(fs.readFileSync(path.join(root, "plugin", "hooks", "codex.json"), "utf8"));

/** Re-keys the fixture's project to a slot repository, so Sphica identifies the slot's checkout as the same project. */
export async function rekey(file: string, owner: string, repo: string): Promise<void> {
  // Changing a project's key is the owner's write; the record server's ingest connection may only add projects
  const db = openWriter("owner", file);
  try {
    await db
      .updateTable("project")
      .set({ key: `git:github.com/${owner}/${repo}`, name: `${owner}/${repo}` })
      .execute();
  } finally {
    await db.destroy();
  }
}

type FixturePlan = {
  fixture: { cases: string[]; setups: string[] };
  swapped: { drop: { cases: string[]; setups: string[] }; steps: Step[] };
};

/**
 * The acceptance steps that build the tsundoku fixture, in order: each listed case's own steps (its given cases are not run, so the list
 * names them in order), then each setup, then the counterfactual's steps for a swapped build.
 */
export function fixtureSteps(plan: FixturePlan, swapped: boolean): Step[] {
  const { cases, setups } = loadAcceptance();
  const byId = new Map(cases.map((c) => [c.id, c]));
  const kept = (list: string[], drop: string[]) => list.filter((x) => !swapped || !drop.includes(x));
  const steps: Step[] = [];
  for (const id of kept(plan.fixture.cases, plan.swapped.drop.cases)) {
    const c = byId.get(id);
    if (!c) throw new Error(`no case ${id}`);
    for (const g of c.given) if (!g.case) steps.push(g);
    steps.push(c.when);
  }
  for (const name of kept(plan.fixture.setups, plan.swapped.drop.setups)) {
    const setup = setups[name] as Step | undefined;
    if (!setup) throw new Error(`no setup ${name}`);
    for (const [k, v] of Object.entries(setup)) steps.push({ [k]: v });
  }
  if (swapped) steps.push(...plan.swapped.steps);
  return steps;
}
