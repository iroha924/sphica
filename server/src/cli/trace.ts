// sphica trace: the trace Skill's steps. pending lists sessions to trace and draft binds a run to one session of this project;
// context, check, and save are shared with harvest (cli/extract.ts).
import { buildCommand, buildRouteMap } from "@stricli/core";
import { flush } from "../capture.ts";
import { newDraft } from "../draft.ts";
import { HOSTS, type Host, sessionId } from "../knowledge.ts";
import { inline, mark } from "../panel.ts";
import { plural } from "../text.ts";
import { openRun, pendingSessions } from "../trace.ts";
import { hostSession, placeOf, registered, withDb } from "./common.ts";
import { extractCommands } from "./extract.ts";
import { document } from "./view.ts";

export const traceRoutes = buildRouteMap({
  docs: { brief: "Extract decisions and implementation records from a session (run by the trace Skill)" },
  routes: {
    pending: buildCommand({
      docs: { brief: "List sessions of this project with owner messages not traced yet" },
      parameters: {},
      func: async () => {
        await flush().catch(() => {});
        await withDb("reader", async (db) => {
          const projectId = await registered(db, placeOf(process.cwd()));
          const rows = await pendingSessions(db, projectId);
          const firsts = new Map(
            (rows.length
              ? await db
                  .selectFrom("source")
                  .select(["id", "text"])
                  .where(
                    "id",
                    "in",
                    rows.map((r) => Number(r.first)),
                  )
                  .execute()
              : []
            ).map((m) => [m.id, m.text]),
          );
          console.log(
            document(
              "sphica trace pending",
              undefined,
              rows.length
                ? [
                    {
                      kind: "lines",
                      lines: rows.map(
                        (r) =>
                          `${r.id}  ${r.host}  ${r.started_at}  ${plural(Number(r.waiting), "message")} waiting: ${inline(firsts.get(Number(r.first)) ?? "").slice(0, 100)}`,
                      ),
                    },
                  ]
                : [],
              rows.length
                ? `${plural(rows.length, "session")} to trace. Run sphica trace draft --session <id> for one`
                : `${mark("ok")} Every captured session has been traced`,
            ),
          );
        });
      },
    }),
    draft: buildCommand({
      docs: { brief: "Start tracing one session: issue the draft file to write the record to, and its id" },
      parameters: {
        flags: {
          session: {
            kind: "parsed",
            parse: String,
            brief: "A session id from trace pending (default: the current session)",
            placeholder: "id",
            optional: true,
          },
          host: {
            kind: "enum",
            values: HOSTS,
            brief: "Your host, when both hosts' sessions are in the environment",
            optional: true,
          },
        },
      },
      func: async (flags: { session?: string; host?: Host }) => {
        await flush().catch(() => {});
        const place = placeOf(process.cwd());
        const d = await withDb("ingest", async (db) => {
          const projectId = await registered(db, place);
          const id =
            flags.session ?? sessionId(projectId, hostSession(flags.host).host, hostSession(flags.host).id);
          const s = await db
            .selectFrom("session")
            .select(["id", "project_id"])
            .where("id", "=", id)
            .executeTakeFirst();
          if (!s || s.project_id !== projectId)
            throw new Error(
              flags.session
                ? `${id} is not a session of ${place.name}. Use an id from sphica trace pending`
                : "This session has no captured messages yet, so there is nothing to trace",
            );
          const draft = newDraft("trace");
          await openRun(db, {
            projectId,
            origin: "trace",
            target: `session:${s.id}`,
            sessionId: s.id,
            draftId: draft.id,
          });
          return draft;
        });
        console.log(
          document(
            "sphica trace draft",
            undefined,
            [{ kind: "lines", lines: [`id: ${d.id}`, `file: ${d.file}`] }],
            `Read sphica trace context ${d.id}, write the record to the file, then run sphica trace check ${d.id}`,
          ),
        );
      },
    }),
    ...extractCommands("trace"),
  },
});
