// sphica trace: the trace Skill's steps. pending lists sessions to trace, draft binds a run to one session of this project, context prints
// that session's sources with the refs a record cites, and check and save take only the draft id (the record never names its project or session).
import { buildCommand, buildRouteMap } from "@stricli/core";
import { flush } from "../capture.ts";
import { inTransaction } from "../db.ts";
import { draftId, newDraft, readDraft, removeDraft } from "../draft.ts";
import { HOSTS, type Host, sessionId } from "../knowledge.ts";
import { inline, mark } from "../panel.ts";
import { checkRecord, saveRecord, type Target } from "../record.ts";
import { plural } from "../text.ts";
import {
  liveUnits,
  openRun,
  pendingSessions,
  type Run,
  runOf,
  sessionEdits,
  sessionSources,
} from "../trace.ts";
import { hostSession, placeOf, registered, withDb } from "./common.ts";
import { closing, document, indent, section, title } from "./view.ts";

const DRAFT = { parse: draftId, brief: "The id draft printed", placeholder: "id" } as const;

/** The run a draft is bound to, refused when it belongs to another project or was saved already. */
async function boundRun(
  db: Parameters<typeof runOf>[0],
  draft: string,
): Promise<{ run: Run; projectId: number }> {
  const projectId = await registered(db, placeOf(process.cwd()));
  const run = await runOf(db, draft);
  if (run?.origin !== "trace") throw new Error(`No trace draft ${draft}. Run sphica trace draft`);
  if (run.project_id !== projectId)
    throw new Error(`Draft ${draft} belongs to another project. Run it from that repository`);
  if (run.status !== "running")
    throw new Error(`Draft ${draft} was already ${run.status}. Run sphica trace draft for a new one`);
  return { run, projectId };
}

const targetOf = (run: Run, externalId: string): Target => ({
  projectId: run.project_id,
  origin: "trace",
  prefix: `trace:${externalId}/`,
  sessionId: run.session_id,
});

async function externalOf(db: Parameters<typeof runOf>[0], session: string | null): Promise<string> {
  const s = session
    ? await db.selectFrom("session").select("external_id").where("id", "=", session).executeTakeFirst()
    : undefined;
  if (!s) throw new Error("The draft's session is gone. Run sphica trace draft again");
  return s.external_id;
}

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
    context: buildCommand({
      docs: {
        brief: "Print the draft's session: messages with their source refs, observed edits, and live records",
      },
      parameters: { positional: { kind: "tuple", parameters: [DRAFT] } },
      func: async (_flags: Record<never, never>, draft: string) => {
        await withDb("reader", async (db) => {
          const { run, projectId } = await boundRun(db, draft);
          const external = await externalOf(db, run.session_id);
          const sources = await sessionSources(db, run.session_id ?? "");
          const edits = await sessionEdits(db, run.session_id ?? "");
          const live = await liveUnits(db, projectId);
          const out = [
            title("sphica trace context"),
            indent(`session ${external}; keys are saved as trace:${external}/<key>`),
          ];
          out.push(section("Messages (cite a source by its ref; quote it exactly)", true));
          for (const m of sources)
            out.push(
              indent(
                `## s${m.id} ${m.author_kind === "owner" ? "owner" : "assistant"} ${m.turn_id ?? ""} ${m.created_at}${m.looked ? " (traced before)" : ""}${m.truncated ? " (middle not saved)" : ""}\n${m.text}`,
              ),
            );
          if (edits.length) {
            out.push(section("Edits observed (paths only; not proof of an implementation)", true));
            out.push(
              indent(edits.map((e) => `- ${e.path} (${e.via}, ${e.turn_id ?? "no turn"})`).join("\n")),
            );
          }
          out.push(section("Live records of this project (supersedes and conflicts take these keys)", true));
          out.push(
            indent(
              live.length
                ? live
                    .map(
                      (u) =>
                        `- ${u.key} (${u.kind}${u.stance ? ` ${u.stance}` : ""}, ${u.lifecycle}) ${inline(u.text).slice(0, 160)}`,
                    )
                    .join("\n")
                : "None.",
            ),
          );
          out.push(
            closing(
              `${plural(sources.length, "message")}. Write the record, then run sphica trace check ${draft}`,
            ),
          );
          console.log(out.join("\n"));
        });
      },
    }),
    check: buildCommand({
      docs: { brief: "Check a record against the retained text without saving it" },
      parameters: { positional: { kind: "tuple", parameters: [DRAFT] } },
      func: async (_flags: Record<never, never>, draft: string) => {
        const raw = readDraft(draft, "trace");
        await withDb("reader", async (db) => {
          const { run } = await boundRun(db, draft);
          const c = await checkRecord(db, targetOf(run, await externalOf(db, run.session_id)), raw);
          const quarantined = c.units.filter((u) => u.quarantine.length);
          const lines = [
            ...c.errors.map((e) => `${mark("fail")} ${e}`),
            ...c.problems.map((p) => `${mark("warn")} ${p}`),
            ...quarantined.map(
              (u) => `${mark("warn")} ${u.key} will be quarantined: ${u.quarantine.join("; ")}`,
            ),
          ];
          if (c.errors.length) process.exitCode = 1;
          console.log(
            document(
              "sphica trace check",
              undefined,
              lines.length ? [{ kind: "lines", lines }] : [],
              c.errors.length
                ? `${mark("fail")} ${plural(c.errors.length, "error")}; fix the record and check again`
                : `${mark("ok")} ${plural(c.units.length, "record")} can be saved${lines.length ? " (see the notes above)" : ""}. Run sphica trace save ${draft}`,
            ),
          );
        });
      },
    }),
    save: buildCommand({
      docs: { brief: "Save a checked record and remove its draft" },
      parameters: { positional: { kind: "tuple", parameters: [DRAFT] } },
      func: async (_flags: Record<never, never>, draft: string) => {
        const raw = readDraft(draft, "trace");
        const saved = await withDb("ingest", (db) =>
          inTransaction(db, async (trx) => {
            const { run } = await boundRun(trx, draft);
            const target = targetOf(run, await externalOf(trx, run.session_id));
            const checked = await checkRecord(trx, target, raw);
            const looked = (await sessionSources(trx, run.session_id ?? "")).map((m) => m.id);
            return saveRecord(trx, target, run.id, checked, looked);
          }),
        );
        const left = removeDraft(draft);
        const lines = [
          ...saved.active.map((k) => `${mark("ok")} ${k} active`),
          ...saved.superseded.map((k) => `${mark("ok")} ${k} superseded`),
          ...saved.candidates.map((c) => `${mark("warn")} ${c.key} candidate: ${c.why}`),
          ...saved.quarantined.map((q) => `${mark("warn")} ${q} quarantined`),
        ];
        console.log(
          document(
            "sphica trace save",
            undefined,
            lines.length ? [{ kind: "lines", lines }] : [],
            `${mark("ok")} saved${left ? `; draft cleanup failed (${left}), do not save again` : ""}`,
          ),
        );
      },
    }),
  },
});
