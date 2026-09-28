#!/usr/bin/env node
// The sphica CLI. Imports, trace, and directory writes use the ingest connection; searches use the reader connection (sqlite.ts, db-write.ts).
//
// Argument parsing is left to @stricli/core. **Each command declares the flags and positional arguments it accepts**, so
// another command's flag (`sphica doctor --yes`) or an extra positional argument (`sphica doctor garbage`)
// fails at parse time. Usage text is built from these declarations and never written separately.

import fs from "node:fs";
import path from "node:path";
import { confirm, isCancel } from "@clack/prompts";
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
import { bindOwner, dbInit, inspect, reindex } from "./admin.ts";
import { leaves } from "./anchors.ts";
import { readState, rejectedDir, unregisteredDir } from "./capture.ts";
import { withDb } from "./cli/common.ts";
import { closing, failure, indent, section, steps, stopped, title } from "./cli/view.ts";
import { dbFile, SCHEMA_REVISION } from "./db.ts";
import { ghUser } from "./github.ts";
import { inline, type Mark, mark, pad, plain, width } from "./panel.ts";
import { observe, packageVersionAt, ROOT, report, UPDATE_NOTE } from "./plugin.ts";
import { checkLocalName, identify, localRoots, nameLocal, repositoryRoot } from "./project.ts";
import { requireRuntime, sphicaHome } from "./sqlite.ts";
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
          : `revision ${x.revision}, this Sphica expects ${SCHEMA_REVISION} (${x.revision < SCHEMA_REVISION ? "made by an older Sphica: move it aside, then run sphica init" : "update sphica"})`,
      );
      const broken = Object.entries(x.fts).filter(([, v]) => v !== null);
      say(
        broken.length ? "fail" : "ok",
        "Full-text index",
        broken.length
          ? `broken: ${broken.map(([k, v]) => `${k} (${plain(v ?? "")})`).join(" / ")}. Rebuild it with sphica doctor --reindex`
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
      s.stuck ? ` / failed: ${plain(s.stuck)} (sent again after the next turn)` : ""
    }${s.unregistered ? ` / ${s.unregistered} set aside for unregistered projects (${unregisteredDir()})` : ""}${
      s.rejected ? ` / ${s.rejected} rejected by the database (${rejectedDir()})` : ""
    }`,
  );
  if (usable) {
    try {
      await withDb("reader", async (db) => {
        // Unbound is not a fault: only harvest and glean need it, and only for pull requests where the owner is not a maintainer
        const owners = await db
          .selectFrom("owner_identity")
          .select(["external_id", "login"])
          .where("provider", "=", "github")
          .orderBy("bound_at")
          .execute();
        say(
          owners.length ? "ok" : "none",
          "GitHub owner",
          owners.length
            ? owners.map((o) => `${inline(o.login ?? "?")} (id ${inline(o.external_id)})`).join(" / ")
            : "none. Bind it with sphica init while gh is signed in",
        );
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

const GH_WHY = {
  missing: "gh could not be started. Install GitHub CLI, run gh auth login, then sphica init again",
  failed: "gh api user failed (signed out or offline). Run gh auth login, then sphica init again",
  unexpected: "unexpected response from gh api user",
} as const;

/**
 * Binds the GitHub account gh is signed in to as the owner's, so their words adopt in repositories they do not maintain.
 * Without gh the rest of Sphica works, so every outcome is one line and none fails init.
 */
async function bindGitHub(): Promise<void> {
  const user = await ghUser();
  const line = (m: Mark, text: string) => console.log(indent(`${mark(m)} ${text}`));
  if (!user.ok) {
    line("warn", `GitHub account not bound: ${GH_WHY[user.reason]}`);
    return;
  }
  const who = `${inline(user.login)} (id ${user.id})`;
  const b = bindOwner(user);
  if (b.kind === "bound") line("ok", `GitHub account ${who} bound as the owner`);
  else if (b.kind === "already") line("none", `GitHub account ${who} already bound`);
  else if (b.kind === "other")
    line(
      "warn",
      `gh is signed in as ${who}, but ${inline(b.login ?? "?")} (id ${inline(b.id)}) is bound as the owner; not added`,
    );
  else line("none", `GitHub account not bound: the database is revision ${b.revision}`);
}

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
    await bindGitHub();
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

/**
 * Deletes ~/.sphica: the database, the recording queue, and the hooks' state. The plugin, the marketplace, and the npm package are the
 * owner's to remove, so only their commands are shown.
 */
async function uninstall(yes: boolean): Promise<void> {
  const home = sphicaHome();
  // Inside by path segments: ~/.sphica-old is a sibling, not a folder in ~/.sphica
  const inHome = (p: string) => {
    const rel = path.relative(home, path.resolve(p));
    return rel === "" || !leaves(rel);
  };
  const where = [
    home,
    ...(process.env.SPHICA_DB && !inHome(process.env.SPHICA_DB) ? [process.env.SPHICA_DB] : []),
  ];
  await boxed("sphica uninstall", async () => {
    // SPHICA_HOME may name any directory (tests and measurements set it); a recursive delete must never follow it
    if (process.env.SPHICA_HOME)
      throw new Error(
        "SPHICA_HOME is set; uninstall deletes only ~/.sphica. Unset SPHICA_HOME and run it again",
      );
    if (!fs.existsSync(home)) console.log(indent(`${mark("none")} ${home} does not exist`));
    else {
      if (!yes) {
        if (!process.stdin.isTTY)
          throw new Error(
            `This deletes ${home} and every record in it. Run sphica uninstall --yes to go ahead`,
          );
        const answer = await confirm({
          message: `Delete ${home} and every record in it? This cannot be undone`,
        });
        if (isCancel(answer) || !answer) return "cancelled";
      }
      fs.rmSync(home, { recursive: true, force: true });
      console.log(indent(`${mark("ok")} deleted ${home}`));
    }
    if (where.length > 1)
      console.log(
        indent(`${mark("warn")} SPHICA_DB points outside it (${where[1]}); delete that file yourself`),
      );
    console.log(
      steps(
        "To remove the rest",
        [
          {
            who: "Claude Code",
            command: "claude plugin uninstall sphica@sphica && claude plugin marketplace remove sphica",
            after: null,
          },
          {
            who: "Codex",
            command: "codex plugin remove sphica@sphica && codex plugin marketplace remove sphica",
            after: null,
          },
          { who: "CLI", command: "npm uninstall -g sphica", after: null },
        ],
        "Sphica does not run these for you",
      ),
    );
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

const root = buildRouteMap({
  docs: {
    brief: "Keep and search past decisions and conversations",
    fullDescription:
      "Database: ~/.sphica/sphica.db (created by sphica init). No credentials of its own: init reads your GitHub account through gh",
  },
  routes: {
    init: buildCommand({
      docs: {
        brief:
          "Set up: create this machine's database, bind the GitHub account gh is signed in to as the owner, and register the current repository (safe to run again)",
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
      parameters: {
        flags: {
          reindex: {
            kind: "boolean",
            brief: "Rebuild the full-text index when doctor reports it broken",
            optional: true,
          },
        },
      },
      func: (flags: { reindex?: boolean }) =>
        flags.reindex ? boxed("sphica doctor --reindex", () => reindex()) : doctor(process.cwd()),
    }),
    uninstall: buildCommand({
      docs: { brief: "Delete this machine's Sphica data (~/.sphica) and show how to remove the rest" },
      parameters: {
        flags: {
          yes: {
            kind: "boolean",
            brief: "Skip the confirmation (required outside a terminal)",
            optional: true,
          },
        },
      },
      func: (flags: { yes?: boolean }) => uninstall(flags.yes === true),
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
