#!/usr/bin/env node
// The sphica CLI. Imports, trace, and directory writes use the ingest connection; searches use the reader connection (sqlite.ts, db-write.ts).
//
// Argument parsing is left to @stricli/core. **Each command declares the flags and positional arguments it accepts**, so
// another command's flag (`sphica doctor --yes`) or an extra positional argument (`sphica project list garbage`)
// fails at parse time. Usage text is built from these declarations and never written separately.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ApplicationText,
  ArgumentScannerError,
  buildApplication,
  buildCommand,
  buildRouteMap,
  type CommandInfo,
  formatMessageForArgumentScannerError,
  help,
  run,
  text_en,
  version,
} from "@stricli/core";
import { type Kysely, sql } from "kysely";
import { dbInit, inspect, migrate, reindex } from "./admin.ts";
import { flush, readState, rejectedDir, unregisteredDir } from "./capture.ts";
import {
  type Block,
  closing,
  document,
  failure,
  indent,
  panel,
  section,
  steps,
  stopped,
  title,
} from "./cli/view.ts";
import { dbFile, openReader, type Role, SCHEMA_REVISION } from "./db.ts";
import type { DB } from "./db-types.ts";
import { openWriter } from "./db-write.ts";
import { inline, type Mark, mark, pad, plain, width } from "./panel.ts";
import { observe, packageVersionAt, ROOT, report, UPDATE_NOTE } from "./plugin.ts";
import { checkLocalName, identify, localRoots, nameLocal, repositoryRoot } from "./project.ts";
import { requireRuntime } from "./sqlite.ts";
import { plural, reason } from "./text.ts";

/**
 * Heading of the error box. **Built only from the route name routing chose** (never from the typed arguments).
 * It is decided before argument parsing, so even a misspelled flag reports the subcommand.
 */
let heading = "sphica";

/** The block printed on failure. The body is indented, so newlines smuggled into arguments cannot forge a closing line at column 0 (cli/view.ts). */
const failed = (body: string): string => failure(heading, plain(body));

/** Messages for argument parsing failures. Names what is wrong for each kind of stricli error. */
const describeScannerError = (e: ArgumentScannerError): string =>
  formatMessageForArgumentScannerError(e, {
    FlagNotFoundError: (x) =>
      `Unknown flag: --${inline(x.input)}${x.corrections.length ? ` (did you mean ${x.corrections.map((c) => `--${c}`).join(" / ")}?)` : ""}`,
    AliasNotFoundError: (x) => `Unknown short flag: -${inline(x.input)}`,
    // This cannot tell flags from positional arguments, so **the message thrown by parse names itself**.
    ArgumentParseError: (x) => reason(x.exception),
    EnumValidationError: (x) =>
      `--${x.externalFlagName} must be ${x.values.join(" or ")}: ${inline(x.input)}`,
    UnexpectedFlagError: (x) => `--${x.externalFlagName} can be given only once: ${inline(x.input)}`,
    UnexpectedPositionalError: (x) =>
      `Extra argument: ${inline(x.input)} (this command takes ${x.expectedCount})`,
    UnsatisfiedFlagError: (x) => `--${x.externalFlagName} needs a value`,
    UnsatisfiedPositionalError: (x) => `Specify ${x.placeholder}`,
    InvalidNegatedFlagSyntaxError: (x) => `--no-${x.externalFlagName} takes no value`,
  });

/** Usage and failure text. Only stricli's text is overridden here; its layout is not rebuilt. */
const TEXT: ApplicationText = {
  ...text_en,
  headers: {
    usage: "Usage:",
    aliases: "Aliases:",
    commands: "Commands:",
    flags: "Flags:",
    arguments: "Arguments:",
  },
  keywords: { default: "default =", separator: "separator =" },
  briefs: {
    help: "Show usage",
    helpAll: "Show usage including hidden commands and flags",
    version: "Show this CLI's version and location",
    argumentEscapeSequence: "Treat everything after this as arguments",
  },
  noCommandRegisteredForInput: ({ input, corrections }) =>
    failed(
      `Unknown command: ${inline(input)}${corrections.length ? ` (did you mean ${corrections.join(" / ")}?)` : ""}\n\nRun --help for usage`,
    ),
  exceptionWhileParsingArguments: (e) =>
    failed(e instanceof ArgumentScannerError ? describeScannerError(e) : reason(e)),
  exceptionWhileRunningCommand: (e) => failed(reason(e)),
  commandErrorResult: (e) => failed(e.message),
};

async function withDb<T>(role: Exclude<Role, "owner">, fn: (db: Kysely<DB>) => Promise<T>): Promise<T> {
  const db = role === "reader" ? openReader() : openWriter(role);
  try {
    return await fn(db);
  } finally {
    await db.destroy().catch(() => {});
  }
}

async function doctor(cwd: string): Promise<void> {
  const issues: string[] = [];
  const count = (m: Mark, label: string) => {
    if (m === "warn" || m === "fail") issues.push(label);
    if (m === "fail") process.exitCode = 1;
  };
  const say = (m: Mark, label: string, text: string) => {
    count(m, label);
    console.log(indent(`  ${mark(m)} ${pad(label, 26)}${text}`));
  };
  console.log(title("sphica doctor"));
  // Print before the database. Version drift should be visible regardless of the database.
  const plugin = report(observe(identify(cwd)?.root ?? cwd));
  issues.push(...plugin.issues);
  // Lines at column 0 are section headings; indented lines are their contents (the shape plugin.ts report builds)
  for (const line of plugin.lines) console.log(/^\S/.test(line) ? section(line) : indent(line));
  if (plugin.updates.length) console.log(steps("To update", plugin.updates, UPDATE_NOTE));
  console.log(section("DB", true));
  let runtime = true;
  try {
    requireRuntime();
    say("ok", "Node", process.version);
  } catch (e) {
    runtime = false;
    say("fail", "Node", plain(reason(e)));
  }
  const file = dbFile();
  let usable = false;
  if (!runtime) say("none", "DB", "cannot check until Node is upgraded");
  else if (!fs.existsSync(file)) say("fail", "DB", `missing (${file}). Create it with sphica init`);
  else {
    try {
      const x = inspect(file);
      usable = x.revision === SCHEMA_REVISION;
      say("ok", "DB", `${file} (${(x.bytes / 1024 / 1024).toFixed(1)} MB)`);
      say(
        usable ? "ok" : "fail",
        "Schema version",
        usable
          ? `revision ${x.revision}`
          : `revision ${x.revision}, this Sphica expects ${SCHEMA_REVISION} (${x.revision < SCHEMA_REVISION ? "run sphica db migrate" : "update sphica"})`,
      );
      const broken = Object.entries(x.fts).filter(([, v]) => v !== null);
      say(
        broken.length ? "fail" : "ok",
        "Full-text index",
        broken.length
          ? `broken: ${broken.map(([k, v]) => `${k} (${plain(v ?? "")})`).join(" / ")}. Rebuild it with sphica db reindex`
          : "healthy",
      );
    } catch (e) {
      say("fail", "DB", `cannot read: ${plain(reason(e))}`);
    }
  }
  const s = readState();
  say(
    s.stuck ? "fail" : s.rejected ? "warn" : "ok",
    "Recording",
    `${s.pending} pending${s.flushedAt ? ` / last sent ${new Date(s.flushedAt).toLocaleString("sv-SE")}` : ""}${
      s.stuck ? ` / failed: ${plain(s.stuck)} (send again with sphica capture flush)` : ""
    }${s.unregistered ? ` / ${s.unregistered} set aside for unregistered projects (${unregisteredDir()})` : ""}${
      s.rejected ? ` / ${s.rejected} rejected by the database (${rejectedDir()})` : ""
    }`,
  );
  if (usable) {
    try {
      await withDb("reader", async (db) => {
        const { found } = localRoots();
        const rows = await db
          .selectFrom("project as p")
          .select((eb) => [
            "p.key",
            "p.name",
            eb
              .selectFrom("unit as u")
              .select((u) => u.fn.countAll<number>().as("n"))
              .whereRef("u.project_id", "=", "p.id")
              .as("records"),
            eb
              .selectFrom("extraction_run as r")
              .select((r) => r.fn.max("r.finished_at").as("at"))
              .whereRef("r.project_id", "=", "p.id")
              .where("r.status", "=", "saved")
              .as("extracted"),
          ])
          .orderBy("p.name")
          .execute();
        if (rows.length) console.log(section("Projects", true));
        const column = Math.max(...rows.map((x) => width(inline(x.name)))) + 2;
        for (const x of rows) {
          const where = found.get(x.key) ? "" : " (not on this machine)";
          console.log(
            indent(
              `  ${mark("none")} ${pad(inline(x.name), column)}${plural(Number(x.records ?? 0), "record")}${
                x.extracted ? ` / last extraction ${new Date(x.extracted).toLocaleString("sv-SE")}` : ""
              }${where}`,
            ),
          );
        }
      });
    } catch (e) {
      say("fail", "DB", `cannot read: ${plain(reason(e))}`);
    }
  }
  // Count by rows, not unique names (multiple Codex caches or projects with the same name still count separately).
  console.log(
    `${closing(
      `${mark(issues.length ? "warn" : "ok")} ${
        issues.length
          ? `${issues.length} to fix: ${[...new Set(issues)]
              .map((name) => {
                const n = issues.filter((x) => x === name).length;
                return n > 1 ? `${name} ×${n}` : name;
              })
              .join(" / ")}`
          : "nothing to fix"
      }`,
    )}`,
  );
}

/** `--cwd` means the same in every command. Defaults to the current directory. */
const CWD = {
  kind: "parsed",
  parse: String,
  brief: "The project directory (defaults to the current directory)",
  placeholder: "dir",
  optional: true,
} as const;

const projectRoutes = buildRouteMap({
  docs: { brief: "List and remove recorded projects (sphica init registers one)" },
  routes: {
    list: buildCommand({
      docs: { brief: "Registered projects and their last extraction" },
      parameters: {},
      func: async () => {
        const { found, ambiguous } = localRoots();
        await withDb("reader", async (db) => {
          const listed = await db
            .selectFrom("project as p")
            .leftJoin("extraction_run as r", (j) =>
              j.onRef("r.project_id", "=", "p.id").on("r.status", "=", "saved"),
            )
            .select(["p.key", "p.name", (eb) => eb.fn.max("r.finished_at").as("last")])
            .groupBy("p.id")
            .orderBy("p.name")
            .execute();
          const home = os.homedir();
          const cards = listed.map((x) => {
            const root = found.get(x.key);
            const where = root
              ? root.startsWith(`${home}${path.sep}`)
                ? `~${root.slice(home.length)}`
                : root
              : ambiguous.has(x.key)
                ? "multiple locations"
                : "not on this machine";
            return {
              title: inline(x.name),
              body: inline(where),
              meta: [
                inline(x.key),
                x.last
                  ? `last extraction ${new Date(x.last).toLocaleString("sv-SE").slice(0, 16)}`
                  : "nothing extracted yet",
              ],
            };
          });
          console.log(
            document(
              "sphica project list",
              undefined,
              cards.length
                ? [{ kind: "cards", items: cards }]
                : [
                    {
                      kind: "note",
                      tone: "info",
                      text: "No registered projects. Register one with sphica init in the repository",
                    },
                  ],
              cards.length ? plural(cards.length, "project") : "none registered",
            ),
          );
        });
      },
    }),
    forget: buildCommand({
      docs: { brief: "Delete a project's data (without --yes it only counts)" },
      parameters: {
        flags: { yes: { kind: "boolean", brief: "Really delete (cannot be undone)", optional: true } },
        positional: {
          kind: "tuple",
          parameters: [
            { parse: String, brief: "Key or name of the project to delete", placeholder: "key|name" },
          ],
        },
      },
      func: async (flags: { yes?: boolean }, target: string) => {
        await withDb("ingest", async (db) => {
          const hit = await db
            .selectFrom("project")
            .select(["id", "key", "name"])
            .where((eb) => eb.or([eb("key", "=", target), eb("name", "=", target)]))
            .execute();
          const p = hit[0];
          if (hit.length !== 1 || !p)
            throw new Error(`${plural(hit.length, "project")} match ${target}. Specify it by key`);
          const x = await db
            .selectFrom("project")
            .select([
              sql<number>`(select count(*) from session where project_id = ${p.id})`.as("sessions"),
              sql<number>`(select count(*) from source where project_id = ${p.id})`.as("sources"),
              sql<number>`(select count(*) from unit where project_id = ${p.id})`.as("units"),
            ])
            .where("id", "=", p.id)
            .executeTakeFirst();
          const counts: Block = {
            kind: "fields",
            rows: [
              ["project", inline(p.name)],
              ["key", inline(p.key)],
              ["sessions", `${x?.sessions}`],
              ["sources", `${x?.sources}`],
              ["records", `${x?.units}`],
            ],
          };
          if (flags.yes !== true) {
            console.log(
              document(
                "sphica project forget",
                undefined,
                [
                  counts,
                  { kind: "note", tone: "warning", text: "Add --yes to delete. This cannot be undone" },
                ],
                `${mark("none")} nothing deleted`,
              ),
            );
            return;
          }
          await db.deleteFrom("project").where("id", "=", p.id).execute();
          console.log(document("sphica project forget", undefined, [counts], `${mark("ok")} deleted`));
        });
      },
    }),
  },
});

const captureRoutes = buildRouteMap({
  docs: { brief: "Conversation recording" },
  routes: {
    flush: buildCommand({
      docs: { brief: "Send the recording queue to the database" },
      parameters: {},
      func: async () => {
        const r = await flush();
        if (r.busy) {
          console.log(
            panel(
              "sphica capture flush",
              [],
              "Another send is running, so nothing was done (the queue empties when it finishes)",
            ),
          );
          return;
        }
        console.log(
          document(
            "sphica capture flush",
            undefined,
            [
              {
                kind: "fields",
                rows: [
                  ["new messages", `${r.sent}`],
                  ...(r.deferred
                    ? ([["set aside for unregistered projects", `${r.deferred}`]] as [string, string][])
                    : []),
                  ...(r.rejected
                    ? ([["rejected by the database", `${r.rejected} (kept in ${rejectedDir()})`]] as [
                        string,
                        string,
                      ][])
                    : []),
                ],
              },
            ],
            `${mark(r.rejected ? "warn" : "ok")} sent`,
          ),
        );
      },
    }),
  },
});

/**
 * First-time setup: the database, then the project dir belongs to (a repository without a remote needs --name). Safe to run again.
 * A bad --name and a name that differs from the one already given stop before anything is written.
 */
async function init(flags: { cwd?: string; name?: string }): Promise<void> {
  const cwd = flags.cwd ?? process.cwd();
  if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`${cwd} is not a directory`);
  const found = identify(cwd);
  if (flags.name !== undefined) {
    checkLocalName(flags.name);
    if (found?.key.startsWith("git:"))
      throw new Error(
        `${found.root} has a git remote, so its key is ${found.key}. Run sphica init without --name`,
      );
    if (found && found.key !== `local:${flags.name}`)
      throw new Error(
        `${found.root} is already named ${found.name}. Its records stay under that name, so keep it`,
      );
  }
  await boxed("sphica init", async () => {
    dbInit();
    // A place already under this name (the named directory or one below it) is used as is, so the name table never gains a second place
    const place = flags.name !== undefined && !found ? nameLocal(cwd, flags.name) : found;
    if (!place) {
      const root = repositoryRoot(cwd);
      if (root)
        console.log(
          indent(`${mark("warn")} ${root} has no git remote. Register it with \`sphica init --name <name>\``),
        );
      return;
    }
    await withDb("ingest", async (db) => {
      const added = await db
        .insertInto("project")
        .values({ key: place.key, name: place.name })
        .onConflict((oc) => oc.column("key").doNothing())
        .returning("id")
        .executeTakeFirst();
      console.log(
        indent(
          `${mark(added ? "ok" : "none")} ${inline(place.name)} ${added ? "registered" : "already registered"} (${inline(place.key)}, ${inline(place.root)})`,
        ),
      );
    });
  });
}

/** Adds a heading and closing to admin.ts output lines. A failure closes the heading already printed (not a second block from stricli) */
async function boxed(head: string, fn: () => unknown): Promise<void> {
  console.log(title(head));
  let outcome: unknown;
  try {
    outcome = await fn();
  } catch (e) {
    console.log(stopped(plain(reason(e))));
    process.exitCode = 1;
    return;
  }
  if (outcome === "cancelled") {
    console.log(closing(`${mark("fail")} Stopped`));
    process.exitCode = 1;
    return;
  }
  console.log(closing(`${mark("ok")} done`));
}

const dbRoutes = buildRouteMap({
  docs: {
    brief: "This machine's database (~/.sphica/sphica.db) and schema",
    // A maintainer step (a release that changes how search splits words). -H lists it
    hideRoute: { reindex: true },
  },
  routes: {
    migrate: buildCommand({
      docs: { brief: "Apply db/migrations newer than the database version" },
      parameters: {
        flags: {
          yes: {
            kind: "boolean",
            brief: "Skip the confirmation before applying (required outside a terminal)",
            optional: true,
          },
        },
      },
      func: (flags: { yes?: boolean }) => boxed("sphica db migrate", () => migrate(flags.yes === true)),
    }),
    reindex: buildCommand({
      docs: { brief: "Rebuild the full-text index (run after changing how search splits words)" },
      parameters: {},
      func: () => boxed("sphica db reindex", () => reindex()),
    }),
  },
});

const root = buildRouteMap({
  docs: {
    brief: "Keep and search past decisions and conversations",
    fullDescription: "Database: ~/.sphica/sphica.db (created by sphica init). No credentials are needed",
    // Usage shows only what people type. The rest are run by the trace Skill, the capture hooks, maintenance, or on doctor's advice; -H lists them
    hideRoute: { project: true, capture: true, db: true },
  },
  routes: {
    project: projectRoutes,
    capture: captureRoutes,
    db: dbRoutes,
    init: buildCommand({
      docs: {
        brief:
          "Set up: create this machine's database and register the current repository (safe to run again)",
      },
      parameters: {
        flags: {
          cwd: CWD,
          name: {
            kind: "parsed",
            parse: String,
            brief: "Name a project without a git remote on this machine",
            placeholder: "name",
            optional: true,
          },
        },
      },
      func: (flags: { cwd?: string; name?: string }) => init(flags),
    }),
    doctor: buildCommand({
      docs: {
        brief:
          "npm package and plugin versions, Node, the database and schema, and harvest and recording status",
      },
      parameters: {},
      func: () => doctor(process.cwd()),
    }),
    advice: buildCommand({
      docs: { brief: "How often the edit hook showed constraints" },
      parameters: {},
      func: () => {
        // Measures whether the edit hook helps. After a month, if it rarely shows anything, remove the hook.
        const log = path.join(os.homedir(), ".sphica", "advice.jsonl");
        if (!fs.existsSync(log)) {
          console.log(panel("sphica advice", [], "No records yet (the edit hook has never run)"));
          return;
        }
        // Skip lines cut midway (a process stopped while writing). One line does not make the whole unreadable.
        const rows = fs
          .readFileSync(log, "utf8")
          .split("\n")
          .flatMap((l) => {
            try {
              const r = JSON.parse(l) as { at?: unknown; shown?: unknown };
              return typeof r.at === "string" && typeof r.shown === "number"
                ? [{ at: r.at, shown: r.shown }]
                : [];
            } catch {
              return [];
            }
          });
        const shown = rows.filter((r) => r.shown > 0);
        const since = rows[0]?.at;
        const ratio = shown.length / Math.max(rows.length, 1);
        console.log(
          document(
            "sphica advice",
            since ? `since ${new Date(since).toLocaleString("sv-SE").slice(0, 16)}` : undefined,
            [
              {
                kind: "fields",
                rows: [
                  ["edits with the hook", `${rows.length}`],
                  ["constraints shown", `${shown.length}`],
                  ...(since
                    ? ([["records since", new Date(since).toLocaleString("sv-SE")]] as [string, string][])
                    : []),
                ],
              },
              { kind: "meter", label: "share with constraints", ratio, text: `${(ratio * 100).toFixed(1)}%` },
            ],
            `${mark("ok")} constraints shown on ${shown.length} of ${plural(rows.length, "edit")}`,
          ),
        );
      },
    }),
  },
});

const FORMATTING = {
  useAliasInUsageLine: false,
  onlyRequiredInUsageLine: false,
  caseStyle: "original",
} as const;

const app = buildApplication(
  root,
  {
    name: "sphica",
    localization: { text: TEXT },
    // panel.ts decides box and mark colors (only when both stdout and stderr are terminals).
    documentation: { disableAnsiColor: true },
  },
  {
    help: help({
      brief: TEXT.briefs.help,
      alias: "h",
      defaultForRouteMap: true,
      includeHidden: false,
      formatting: FORMATTING,
    }),
    helpAll: help({
      brief: TEXT.briefs.helpAll,
      alias: "H",
      hidden: true,
      includeHidden: true,
      formatting: FORMATTING,
    }),
    version: version({
      brief: TEXT.briefs.version,
      alias: "v",
      info: { getCurrentVersion: async () => `${packageVersionAt(ROOT) ?? "unknown"}  ${ROOT}` },
    }),
  },
);

await run(app, process.argv.slice(2), {
  process,
  forCommand: ({ prefix }: CommandInfo) => {
    heading = prefix.join(" ");
    return { process };
  },
});
// stricli's internal exit codes are negative (argument parse failure is -4). Shells see only the low 8 bits, so map them to 1.
if (typeof process.exitCode === "number" && process.exitCode < 0) process.exitCode = 1;
