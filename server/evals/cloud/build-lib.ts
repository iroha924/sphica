// Pieces of building a slot that the builder and the local runner share, kept apart from build.ts so tests can reach them.
import fs from "node:fs";
import path from "node:path";
import { openWriter } from "../../src/db-write.ts";

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
