// sphica harvest: the harvest Skill's steps. draft reads one pull request through gh (read only), stores what people wrote as sources,
// and binds a run to it; context, check, and save are shared with trace (cli/extract.ts).
import { buildCommand, buildRouteMap } from "@stricli/core";
import { inTransaction } from "../db.ts";
import { newDraft } from "../draft.ts";
import { gh, linkIssues, readPull, repoOf, storeItems } from "../github.ts";
import { plural } from "../text.ts";
import { openRun } from "../trace.ts";
import { placeOf, registered, withDb } from "./common.ts";
import { extractCommands } from "./extract.ts";
import { document } from "./view.ts";

const PR = {
  parse: (input: string): number => {
    const n = Number(input.replace(/^#/, ""));
    if (!Number.isInteger(n) || n <= 0) throw new Error(`Not a pull request number: ${input.slice(0, 40)}`);
    return n;
  },
  brief: "The pull request number",
  placeholder: "pr",
} as const;

export const harvestRoutes = buildRouteMap({
  docs: {
    brief: "Extract decisions and implementation records from a pull request (run by the harvest Skill)",
  },
  routes: {
    draft: buildCommand({
      docs: {
        brief: "Read a pull request and the issues it closes, store them as sources, and issue a draft",
      },
      parameters: { positional: { kind: "tuple", parameters: [PR] } },
      func: async (_flags: Record<never, never>, number: number) => {
        const place = placeOf(process.cwd());
        const repo = repoOf(place.key);
        if (!repo) throw new Error(`${place.name} is not on github.com, so there is no pull request to read`);
        const pull = await readPull(gh(repo), number);
        const d = await withDb("ingest", (db) =>
          inTransaction(db, async (trx) => {
            const projectId = await registered(trx, place);
            await storeItems(trx, projectId, pull.items);
            await linkIssues(trx, projectId, number, pull.closes);
            const draft = newDraft("harvest");
            await openRun(trx, {
              projectId,
              origin: "harvest",
              target: `pr:${number}`,
              sessionId: null,
              draftId: draft.id,
            });
            return draft;
          }),
        );
        console.log(
          document(
            "sphica harvest draft",
            undefined,
            [
              {
                kind: "lines",
                lines: [`id: ${d.id}`, `file: ${d.file}`, `read: ${plural(pull.items.length, "source")}`],
              },
            ],
            `Read sphica harvest context ${d.id}, write the record to the file, then run sphica harvest check ${d.id}`,
          ),
        );
      },
    }),
    ...extractCommands("harvest"),
  },
});
