// Maps acceptance steps and expectations onto Sphica's public entry points (capture hooks, CLI, MCP, delivery hooks).
// Each operation is filled in when its feature is built; until then it fails and names the missing operation.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Kysely, sql } from "kysely";
import type { ReadonlyKysely } from "kysely/readonly";
import { checkAnchor } from "../../src/anchors.ts";
import { askedBefore, askedText } from "../../src/asked.ts";
import { flush, onHook } from "../../src/capture.ts";
import { openReader } from "../../src/db.ts";
import type { DB } from "../../src/db-types.ts";
import { connectWriter, openWriter } from "../../src/db-write.ts";
import { deliver } from "../../src/deliver.ts";
import { exportDecisions, exportPath } from "../../src/export.ts";
import {
  beginGlean,
  beginHarvest,
  beginTrace,
  checkText,
  contextText,
  pendingText,
  saveText,
} from "../../src/extract.ts";
import { applyForget, previewForget } from "../../src/forget.ts";
import { framed } from "../../src/frame.ts";
import { gh } from "../../src/github.ts";
import { type Host, sessionId } from "../../src/knowledge.ts";
import { liveOverview, lookOverview } from "../../src/overview.ts";
import { readSource, readUnit } from "../../src/read.ts";
import { type Applicable, parseDiff, selectForReview } from "../../src/review.ts";
import { checkFindings } from "../../src/review-findings.ts";
import { searchSources, searchUnits, type UnitHit } from "../../src/search.ts";
import { status } from "../../src/status.ts";
import { ftsQuery } from "../../src/text.ts";
import type { Step, World } from "./load.ts";

export type Driver = {
  run(step: Step): Promise<void>;
  expect(expectation: Step): Promise<void>;
  /** Writes the world's database, as it stands, to one self-contained file (for the cloud evaluation's fixtures). */
  snapshot(to: string): Promise<void>;
  /** What the delivery hooks returned for the last inject step, one entry per call (for the offline order bench). */
  delivered(): string[];
  done(): Promise<void>;
};

class NotBuilt extends Error {}

type Session = World["sessions"][number];

/** One delivery hook call of an inject step. event subagent_start is the host's SubagentStart. */
type Inject = {
  event: string;
  path?: string;
  prompt?: string;
  source?: string;
  host?: Host;
  agent_id?: string;
  command?: string;
};

const CLI = path.join(import.meta.dirname, "..", "..", "src", "cli.ts");
/** Variables from the shell running the cases that would point hooks and the CLI at the owner's sessions or database. */
const LEAKY = [
  "SPHICA_DB",
  "SPHICA_HOME",
  "SPHICA_PARENT_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
];

export async function createDriver(world: World): Promise<Driver> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-acceptance-")));
  const saved = Object.fromEntries(["HOME", "USERPROFILE", "PATH", ...LEAKY].map((k) => [k, process.env[k]]));
  for (const k of LEAKY) delete process.env[k];
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  const file = path.join(dir, ".sphica", "sphica.db");
  const repo = path.join(dir, "tsundoku");
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-C",
        repo,
        "-c",
        "user.name=hana",
        "-c",
        "user.email=hana@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { stdio: "ignore" },
    );
  /** Runs the CLI as a child process; out holds stdout and stderr together. */
  /** Environment for the next CLI runs: glean runs inside the owner's session, so the host's session variable is set. */
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: repo,
      env: { ...process.env, NO_COLOR: "1" },
      encoding: "utf8",
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const cli = (...args: string[]) => {
    const r = run(...args);
    if (r.status !== 0) throw new Error(`sphica ${args.join(" ")} exited ${r.status}\n${r.out}`);
    return r.out;
  };

  fs.mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "https://github.com/example/tsundoku.git");
  for (const [rel, text] of Object.entries(world.files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    // The world marks the binary and the oversized file by name; the real content is made here
    const body =
      text === "BINARY"
        ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1])
        : text === "OVERSIZED"
          ? "x".repeat(2 * 1024 * 1024)
          : text;
    fs.writeFileSync(path.join(repo, rel), body);
  }
  git("add", "-A");
  git("commit", "-qm", "initial");

  const sessions = new Map(world.sessions.map((s) => [s.id, s]));
  // A fake gh first on PATH answers from the world (no network), before init, which reads the signed-in account through it.
  // edited lists PRs whose body is served with its edits; signedIn is the login gh answers `api user` with (signed out when null).
  const edited = new Set<number>();
  let signedIn: string | null = null;
  const ghState = path.join(dir, "gh-world.json");
  const writeGh = () => fs.writeFileSync(ghState, JSON.stringify({ world, edited: [...edited], signedIn }));
  writeGh();
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(path.join(dir, "bin", "gh"), fakeGh(ghState), { mode: 0o755 });
  process.env.PATH = `${path.join(dir, "bin")}${path.delimiter}${saved.PATH ?? ""}`;
  cli("init", "--cwd", repo);
  let reader: ReadonlyKysely<DB> | null = null;
  let ingest: Kysely<DB> | null = null;
  /** The ingest connection, as the record MCP server opens it */
  const writer = () => {
    ingest ??= openWriter("ingest", file);
    return ingest;
  };
  const db = () => {
    reader ??= openReader(file);
    return reader;
  };
  const projectId = async () =>
    (
      await db()
        .selectFrom("project")
        .select("id")
        .where("key", "=", "git:github.com/example/tsundoku")
        .executeTakeFirstOrThrow()
    ).id;
  /** What the delivery hooks returned for the last inject step, one entry per call. */
  let delivered: string[] = [];
  let injectSession = 0;
  /**
   * Calls the delivery hook the way the host would (Claude Code unless the call names Codex), in a fresh session each time a case injects.
   * A call with agent_id runs inside that subagent; a read with a command is a shell command naming the path.
   */
  const inject = async (i: Inject) => {
    const input = {
      session_id: `inject-${++injectSession}-${path.basename(dir)}`,
      cwd: repo,
      ...(i.agent_id ? { agent_id: i.agent_id, agent_type: "Explore" } : {}),
      ...(i.event === "pre_read" && i.command !== undefined
        ? { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: i.command } }
        : i.event === "pre_edit" || i.event === "pre_read"
          ? {
              hook_event_name: "PreToolUse",
              tool_name: i.event === "pre_read" ? "Read" : "Edit",
              tool_input: { file_path: path.join(repo, i.path ?? "") },
            }
          : i.event === "prompt"
            ? { hook_event_name: "UserPromptSubmit", prompt: i.prompt ?? "" }
            : i.event === "subagent_start"
              ? { hook_event_name: "SubagentStart" }
              : { hook_event_name: "SessionStart", source: i.source ?? "startup" }),
    };
    return deliver(input, i.host ?? "claude-code", file);
  };
  /** Every delivery a session could see: start, a prompt naming the needle, and an edit of every anchored path. */
  const everything = async (needle: string) => {
    const anchored = await db().selectFrom("unit_anchor").select("path").distinct().execute();
    return [
      await inject({ event: "session_start" }),
      await inject({ event: "prompt", prompt: needle }),
      ...(await Promise.all(anchored.map((a) => inject({ event: "pre_edit", path: a.path })))),
    ].join("\n");
  };

  /** The decision lane's last selection, whether it could run, and the last verdict check. */
  let applicable: Applicable[] = [];
  let lane = "";
  let validation: string[] = [];
  /** A one-file diff as git prints it */
  const diffOf = (d: { path: string; add: string }) =>
    `--- a/${d.path}\n+++ b/${d.path}\n@@ -1,0 +1,1 @@\n+${d.add}\n`;

  /** The last search's hits and the last read's text, for expectations about them. */
  let found: UnitHit[] = [];
  /** What the last search with asked returned, as the read server words it. */
  let asked = "";
  /** What the last overview returned, as the read server words it. */
  let overview = "";
  /** The document the last export built. */
  let exported = "";
  const exportOf = async (records: string[], at: string) => {
    const where = exportPath(repo, at);
    if ("error" in where) return where;
    return exportDecisions(db(), await projectId(), "example/tsundoku", records);
  };
  let lastRead = "";
  /** A time after every write so far and before the latest glean's, for reading as of just before it (writes carry the real clock). */
  let beforeGlean = "";
  const search = async (query: string) =>
    (await searchUnits(db(), await projectId(), { question: query, limit: 10 })).hits;
  /** The last check output, for expectations about what check reported. */
  let checked = "";
  /** Quotes each saved key cited, to confirm stored spans cut exactly those bytes. */
  const quotes = new Map<string, Set<string>>();
  const missing = (kind: string, s: Step) =>
    new NotBuilt(`${kind} not built yet: ${Object.keys(s).join(", ")}`);

  /** Plays a session through the capture hooks the way its host would, editing the repository for real, then sends the queue. */
  const captured = new Set<string>();
  async function capture(id: string): Promise<void> {
    const s = sessions.get(id);
    if (!s) throw new Error(`unknown session ${id}`);
    if (captured.has(id)) return;
    captured.add(id);
    const host: Host = s.host === "codex" ? "codex" : "claude-code";
    const hook = (turn: string, input: Record<string, unknown>) =>
      onHook(host, {
        session_id: s.id,
        ...(host === "codex" ? { turn_id: turn } : { prompt_id: turn }),
        cwd: repo,
        ...input,
      });
    const touch = (rel: string, turn: number) => {
      const abs = path.join(repo, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.appendFileSync(abs, `// ${s.id} turn ${turn}\n`);
      return abs;
    };
    const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
    if (s.entrypoint) process.env.CLAUDE_CODE_ENTRYPOINT = s.entrypoint;
    try {
      hook("start", { hook_event_name: "SessionStart" });
      s.turns.forEach((t, i) => {
        const turn = turnId(i + 1);
        hook(turn, { hook_event_name: "UserPromptSubmit", prompt: t.owner });
        t.edits.forEach((rel, k) => {
          const abs = touch(rel, i + 1);
          hook(turn, {
            hook_event_name: "PostToolUse",
            tool_use_id: `${turn}-edit-${k}`,
            ...(host === "codex"
              ? {
                  tool_name: "apply_patch",
                  tool_input: { command: `*** Begin Patch\n*** Update File: ${rel}\n*** End Patch` },
                }
              : { tool_name: "Edit", tool_input: { file_path: abs } }),
          });
        });
        for (const rel of t.shell_edits ?? []) touch(rel, i + 1);
        if (t.compact) hook(turn, { hook_event_name: "SessionStart", source: "compact" });
        if (t.ends !== "interrupt")
          hook(turn, { hook_event_name: "Stop", last_assistant_message: t.assistant });
        else if (host === "codex") hook(turn, { hook_event_name: "Interrupt" });
        for (const rel of t.owner_edits_after ?? []) touch(rel, i + 1);
      });
    } finally {
      if (entrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
      else process.env.CLAUDE_CODE_ENTRYPOINT = entrypoint;
    }
    const sent = await flush(file);
    assert.equal(sent.rejected, 0, `the database rejected records of ${id}`);
  }

  /** The source a case names as `session:<id>#<turn>.<owner|assistant>`. */
  async function sessionSource(ref: string) {
    const m = /^session:([^#]+)#(\d+)\.(owner|assistant)$/.exec(ref);
    if (!m) return undefined;
    return db()
      .selectFrom("source as m")
      .innerJoin("session as s", "s.id", "m.session_id")
      .where("s.external_id", "=", m[1] ?? "")
      .where("m.turn_id", "=", turnId(Number(m[2])))
      .where("m.author_kind", "=", m[3] === "owner" ? "owner" : "assistant")
      .select(["m.id", "m.kind", "m.text", "s.host"])
      .executeTakeFirst();
  }

  /** The source id behind a case's reference, as the `s<id>` ref context prints. */
  /** The current revision of the source a case names as `pr:<n>#...` or `issue:<n>#...`. */
  async function githubSource(r: string) {
    const m = /^(pr|issue):(\d+)#(body|merge|comment:\d+|review:\d+|commit:\w+)$/.exec(r);
    if (!m) return undefined;
    const [, what, n, part = ""] = m;
    const [kind, external] =
      part === "body"
        ? [what === "pr" ? "pr_body" : "issue_body", `${what}:${n}`]
        : part === "merge"
          ? ["pr_event", `pr:${n}#merged`]
          : part.startsWith("comment:")
            ? [what === "pr" ? "pr_comment" : "issue_comment", part]
            : part.startsWith("review:")
              ? ["review_comment", `review_comment:${part.slice(7)}`]
              : ["commit_message", `commit:${fakeSha(part.slice(7))}`];
    return db()
      .selectFrom("source")
      .selectAll()
      .where("kind", "=", kind as "pr_body")
      .where("external_id", "=", external)
      .orderBy("revision", "desc")
      .executeTakeFirst();
  }

  async function ref(r: string): Promise<string> {
    const got = (await sessionSource(r)) ?? (await githubSource(r));
    if (!got) throw new Error(`no source for ${r}`);
    return `s${got.id}`;
  }

  /** The record server's flow, called as its tools call it: check (kept for expectations), then save. */
  async function extract(run: string, prefix: string, record: Record<string, unknown>, pages?: number) {
    const pid = await projectId();
    // Read the context pages first, as the Skills do: saving marks only the sources shown (and quoted) as looked at.
    // The cursor is taken from the page's last line only: source text above it may hold the same words
    for (let page = await contextText(writer(), run, pid, repo), read = 1; ; read++) {
      const next = /call record_context with after: "(s\d+)"[^\n]*$/.exec(page)?.[1];
      if (!next || (pages !== undefined && read >= pages)) break;
      page = await contextText(writer(), run, pid, repo, next);
    }
    const translated = await translate(record);
    checked = (await checkText(writer(), run, pid, repo, translated)).text;
    await saveText(writer(), run, pid, repo, translated);
    remember(prefix, record);
  }

  /** Quotes each saved key cited, to confirm stored spans cut exactly those bytes. */
  function remember(prefix: string, record: Record<string, unknown>) {
    for (const u of (record.units ?? []) as { key: string }[]) {
      const cited = new Set<string>();
      JSON.stringify(u, (k, x) => {
        if (k === "quote" && typeof x === "string") cited.add(x);
        return x;
      });
      quotes.set(`${prefix}${u.key}`, cited);
    }
  }

  async function harvest(step: {
    pr: number;
    refetch_with_edits?: boolean;
    record: Record<string, unknown>;
  }) {
    if (step.refetch_with_edits) {
      edited.add(step.pr);
      writeGh();
    }
    const begun = await beginHarvest(writer(), await projectId(), step.pr, gh("example/tsundoku"));
    await extract(begun.run, `harvest:${step.pr}/`, step.record);
  }

  /** Replaces case references with source refs, deep inside a record. */
  async function translate(v: unknown): Promise<unknown> {
    if (Array.isArray(v)) return Promise.all(v.map(translate));
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v))
      out[k] =
        (k === "source" || k === "reason_source") && typeof x === "string"
          ? await ref(x)
          : await translate(x);
    return out;
  }

  async function trace(step: {
    session: string;
    record: Record<string, unknown>;
    refused?: boolean;
    /** How many context pages the agent reads before saving; every page when absent */
    pages?: number;
  }): Promise<void> {
    const s = sessions.get(step.session);
    if (!s) throw new Error(`unknown session ${step.session}`);
    const uuid = sessionId(await projectId(), s.host === "codex" ? "codex" : "claude-code", s.id);
    const { processed_without_units: empty, ...record } = step.record;
    const run = await beginTrace(writer(), await projectId(), uuid);
    const pages = step.pages;
    // Only a case that expects the refusal keeps it as an outcome; any other failed save still fails the case
    if (step.refused) {
      saves = [
        await extract(run, `trace:${s.id}/`, record).then(
          () => ({ status: 0, out: "saved" }),
          (e: Error) => ({ status: 1, out: e.message }),
        ),
      ];
      return;
    }
    await extract(run, `trace:${s.id}/`, record, pages);
    for (const other of (empty ?? []) as string[]) await trace({ session: other, record: { units: [] } });
  }

  /** The outcome of the last glean save (glean may refuse, and the refusal is what some cases check). */
  let saves: { status: number | null; out: string }[] = [];
  const commitAll = () => {
    git("add", "-A");
    if (spawnSync("git", ["-C", repo, "diff", "--cached", "--quiet"]).status !== 0)
      git("commit", "-qm", "owner edits");
  };

  /** Begins a glean run in the owner's session, with each op carrying the revision read would show now. */
  async function gleanDraft(
    session: string,
    record: Record<string, unknown>,
  ): Promise<{ run: string; record: unknown }> {
    const s = sessions.get(session);
    if (!s) throw new Error(`unknown session ${session}`);
    await capture(session);
    commitAll();
    const run = await beginGlean(writer(), await projectId(), s.id);
    const translated = (await translate(record)) as { ops?: { unit: string; revision?: number }[] };
    for (const op of translated.ops ?? []) op.revision = (await unitOf(op.unit)).revision;
    remember("glean:", record);
    return { run, record: translated };
  }

  /** Saves a glean run; a refusal is an outcome some cases check, so it is returned rather than thrown. */
  const gleanSave = async (d: { run: string; record: unknown }) =>
    saveText(writer(), d.run, await projectId(), repo, d.record).then(
      (out) => ({ status: 0, out }),
      (e: Error) => ({ status: 1, out: e.message }),
    );

  async function glean(step: { session: string; record: Record<string, unknown> }) {
    const d = await gleanDraft(step.session, step.record);
    checked = (await checkText(writer(), d.run, await projectId(), repo, d.record)).text;
    saves = [await gleanSave(d)];
  }

  const unitOf = async (key: string) => {
    const u = await db().selectFrom("unit").selectAll().where("key", "=", key).executeTakeFirst();
    assert.ok(u, `no unit ${key}`);
    return u;
  };

  return {
    delivered: () => [...delivered],
    run: async (step) => {
      if (typeof step.capture === "string") return capture(step.capture);
      if (typeof step.set_remote === "string") {
        git("remote", "set-url", "origin", step.set_remote);
        return;
      }
      if (step.edit_file && typeof step.edit_file === "object") {
        const edit = step.edit_file as {
          path: string;
          replace?: [string, string];
          prepend?: string;
          crlf?: boolean;
          create?: string;
          remove?: boolean;
        };
        const abs = path.join(repo, edit.path);
        if (edit.remove) {
          fs.rmSync(abs);
          return;
        }
        if (edit.create !== undefined) {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, edit.create);
          return;
        }
        let text = fs.readFileSync(abs, "utf8");
        if (edit.replace) {
          assert.ok(text.includes(edit.replace[0]), `${edit.path} has no ${edit.replace[0]}`);
          text = text.replace(edit.replace[0], edit.replace[1]);
        }
        if (edit.prepend) text = edit.prepend + text;
        if (edit.crlf) text = text.replace(/\r?\n/g, "\r\n");
        fs.writeFileSync(abs, text);
        return;
      }
      if (step.search && typeof step.search === "object") {
        found = await search(String((step.search as { query: string }).query));
        return;
      }
      if (step.asked && typeof step.asked === "object") {
        const question = String((step.asked as { query: string }).query);
        asked = askedText(
          await askedBefore(db(), await projectId(), { question, limit: 10, notSessions: [] }),
        );
        return;
      }
      if (step.overview && typeof step.overview === "object") {
        const o = step.overview as { view: "live" | "look"; after?: number };
        overview =
          o.view === "live"
            ? await liveOverview(db(), await projectId(), o.after ?? null)
            : await lookOverview(db(), await projectId(), repo);
        return;
      }
      if (step.export && typeof step.export === "object") {
        const x = step.export as { records: string[]; path: string };
        const r = await exportOf(x.records, x.path);
        if (!("document" in r)) assert.fail(r.error);
        exported = r.document;
        return;
      }
      if (Array.isArray(step.read)) {
        const parts: string[] = [];
        for (const key of step.read as string[])
          parts.push((await readUnit(db(), await projectId(), key, repo)) ?? `${key}: not found`);
        lastRead = parts.join("\n\n");
        return;
      }
      // The owner's confirmation is the record server's part (tested there); here the preview is applied as confirmed
      if (step.forget && typeof step.forget === "object") {
        const ids: number[] = [];
        for (const r of (step.forget as { sources: string[] }).sources)
          ids.push(Number((await ref(r)).slice(1)));
        const pid = await projectId();
        await applyForget(file, pid, ids, await previewForget(file, pid, ids));
        return;
      }
      if (step.glean && typeof step.glean === "object") {
        const tick = () => new Promise((r) => setTimeout(r, 2));
        await tick();
        beforeGlean = new Date().toISOString();
        await tick();
        return glean(step.glean as { session: string; record: Record<string, unknown> });
      }
      if (step.glean_each && typeof step.glean_each === "object") {
        const each = step.glean_each as { session: string; files: string[] };
        const target = await db().selectFrom("unit").select("key").orderBy("id").executeTakeFirstOrThrow();
        saves = [];
        for (const f of each.files) {
          const id = await gleanDraft(each.session, {
            ops: [
              {
                op: "add_evidence",
                unit: target.key,
                file: { path: f, commit: "HEAD", lines: [1, 1] },
                quote: "x",
                role: "explains",
              },
            ],
          });
          saves.push(await gleanSave(id));
        }
        return;
      }
      if (step.glean_twice && typeof step.glean_twice === "object") {
        const twice = step.glean_twice as { session: string; record: Record<string, unknown> };
        const id = await gleanDraft(twice.session, twice.record);
        saves = [await gleanSave(id), await gleanSave(id)];
        // A draft written before its target changed is refused: another glean changes the unit in between
        const stale = await gleanDraft(twice.session, twice.record);
        const unit = ((twice.record.ops ?? []) as { unit: string }[])[0]?.unit ?? "";
        const other = await gleanDraft(twice.session, {
          ops: [{ op: "anchor", unit, path: "README.md", role: "applies_to" }],
        });
        assert.equal((await gleanSave(other)).status, 0);
        saves.push(await gleanSave(stale));
        return;
      }
      // gh signs in as this login and init runs again, binding it as the owner
      if (typeof step.gh_login === "string") {
        signedIn = step.gh_login;
        writeGh();
        cli("init", "--cwd", repo);
        return;
      }
      if (step.symlink && typeof step.symlink === "object") {
        const link = step.symlink as { path: string; to: string };
        fs.symlinkSync(link.to, path.join(repo, link.path));
        commitAll();
        return;
      }
      if (step.as_of && typeof step.as_of === "object") {
        const at = step.as_of as { before: "glean"; read: string };
        assert.ok(at.before === "glean" && beforeGlean, "as_of reads as of just before a glean step");
        lastRead = (await readUnit(db(), await projectId(), at.read, repo, beforeGlean)) ?? "";
        return;
      }
      if (step.review_select && typeof step.review_select === "object") {
        const d = (step.review_select as { diff: { path: string; add: string } }).diff;
        // A fresh reader, as the MCP server opens one: a missing database must show as not checked
        const r = openReader(file);
        try {
          applicable = await selectForReview(r, await projectId().catch(() => -1), parseDiff(diffOf(d)));
          lane = "checked";
        } catch {
          applicable = [];
          lane = "not_checked";
        } finally {
          await r.destroy();
        }
        return;
      }
      if (step.review_validate && typeof step.review_validate === "object") {
        const v = step.review_validate as { findings: unknown };
        validation = await checkFindings(db(), await projectId(), [], v.findings);
        return;
      }
      if (step.inject && typeof step.inject === "object") {
        const i = step.inject as Inject & { repeat?: number; sequence?: Inject[] };
        // A repeat stays in one session: the second call shows what the same session sees again
        delivered = [];
        const repeat = i.repeat ?? 1;
        injectSession++;
        const fixed = injectSession;
        for (const call of i.sequence ?? Array.from({ length: repeat }, () => i)) {
          injectSession = fixed - 1;
          delivered.push(await inject(call));
        }
        return;
      }
      if (step.work && typeof step.work === "object") {
        const w = step.work as { key: string; title: string; current: string; next?: string[] };
        await writer()
          .insertInto("work")
          .values({
            project_id: await projectId(),
            key: w.key,
            title: w.title,
            goal: w.title,
            current: w.current,
            next: JSON.stringify(w.next ?? []),
            status: "active",
            updated_at: new Date().toISOString(),
          })
          .execute();
        return;
      }
      if (step.database === "missing") {
        for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
        return;
      }
      if (step.harvest && typeof step.harvest === "object")
        return harvest(step.harvest as { pr: number; record: Record<string, unknown> });
      if (step.trace && typeof step.trace === "object")
        return trace(step.trace as { session: string; record: Record<string, unknown> });
      if (step.session && typeof step.session === "object") {
        // A session a case gives inline happened: it goes through the hooks like any other
        const s = step.session as Session;
        sessions.set(s.id, s);
        return capture(s.id);
      }
      throw missing("operation", step);
    },
    expect: async (e) => {
      if (typeof e.source === "string" && /^(pr|issue):/.test(e.source)) {
        const got = await githubSource(e.source);
        assert.ok(got, `no source ${e.source}`);
        if (e.author !== undefined) assert.equal(got.author_login, e.author);
        if (e.association !== undefined) assert.equal(got.author_association, e.association);
        if (e.author_is_owner !== undefined) assert.equal(got.author_kind === "owner", e.author_is_owner);
        if (typeof e.linked_to === "string") {
          const link = await db()
            .selectFrom("artifact_link")
            .select("kind")
            .where("from_artifact", "=", e.linked_to)
            .where("to_artifact", "=", got.artifact)
            .executeTakeFirst();
          assert.ok(link, `${got.artifact} is not linked from ${e.linked_to}`);
        }
        return;
      }
      if (typeof e.source === "string" && e.source.startsWith("session:")) {
        const got = await sessionSource(e.source);
        assert.ok(got, `no source ${e.source}`);
        if (e.kind !== undefined) assert.equal(got.kind, e.kind);
        if (e.host !== undefined) assert.equal(got.host, e.host);
        return;
      }
      if (typeof e.no_source === "string") {
        assert.equal(await sessionSource(e.no_source), undefined, `${e.no_source} was recorded`);
        return;
      }
      const observed = e.edit_observation ?? e.no_edit_observation;
      if (observed && typeof observed === "object") {
        const want = observed as { session: string; path: string };
        const got = await db()
          .selectFrom("edit_observation as o")
          .innerJoin("session as s", "s.id", "o.session_id")
          .where("s.external_id", "=", want.session)
          .where("o.path", "=", want.path)
          .select("o.id")
          .execute();
        if (e.no_edit_observation)
          assert.equal(got.length, 0, `${want.path} was observed in ${want.session}`);
        else assert.ok(got.length > 0, `no edit observed for ${want.path} in ${want.session}`);
        return;
      }
      if (typeof e.units_for_session === "string") {
        const got = await db()
          .selectFrom("unit_evidence as e")
          .innerJoin("source as m", "m.id", "e.source_id")
          .innerJoin("session as s", "s.id", "m.session_id")
          .where("s.external_id", "=", e.units_for_session)
          .select((eb) => eb.fn.count<number>("e.unit_id").distinct().as("n"))
          .executeTakeFirstOrThrow();
        assert.equal(Number(got.n), e.count);
        return;
      }
      if (typeof e.unit === "string") {
        const u = await unitOf(e.unit);
        for (const k of ["extraction", "lifecycle", "stance", "kind", "revisit_when", "text"] as const)
          if (e[k] !== undefined) assert.equal(u[k], e[k], `${e.unit} ${k}`);
        if (e.reason_contains !== undefined)
          assert.match(u.extraction_reason ?? "", new RegExp(String(e.reason_contains)));
        if (e.unsourced !== undefined) assert.equal(u.unsourced === 1, e.unsourced);
        if (e.code_surface === "none") {
          const anchors = await db()
            .selectFrom("unit_anchor")
            .select("id")
            .where("unit_id", "=", u.id)
            .where("retired_at", "is", null)
            .execute();
          assert.equal(anchors.length, 0, `${e.unit} has anchors`);
        }
        if (e.successor !== undefined) {
          const next = await db()
            .selectFrom("unit_link as l")
            .innerJoin("unit as n", "n.id", "l.from_unit")
            .where("l.to_unit", "=", u.id)
            .where("l.kind", "=", "supersedes")
            .select("n.key")
            .execute();
          assert.deepEqual(
            next.map((n) => n.key),
            [e.successor],
          );
        }
        return;
      }
      if (typeof e.option === "string") {
        const u = await unitOf(String(e.of));
        const o = await db()
          .selectFrom("unit_option")
          .selectAll()
          .where("unit_id", "=", u.id)
          .where("text", "=", e.option)
          .executeTakeFirst();
        assert.ok(o, `${e.of} has no option ${e.option}`);
        if (e.outcome !== undefined) assert.equal(o.outcome, e.outcome);
        if (e.has_evidence !== undefined) {
          const ev = await db()
            .selectFrom("unit_evidence")
            .select("id")
            .where("option_id", "=", o.id)
            .execute();
          assert.equal(ev.length > 0, e.has_evidence, `evidence of option ${e.option}`);
        }
        return;
      }
      if (typeof e.evidence_span_matches_source === "string") {
        const key = e.evidence_span_matches_source;
        const spans = await db()
          .selectFrom("unit_evidence as e")
          .innerJoin("unit as u", "u.id", "e.unit_id")
          .innerJoin("source as m", "m.id", "e.source_id")
          .where("u.key", "=", key)
          .select(["m.text", "e.span_start", "e.span_end"])
          .execute();
        assert.ok(spans.length, `${key} has no evidence`);
        for (const x of spans)
          assert.ok(
            quotes.get(key)?.has(Buffer.from(x.text).subarray(x.span_start, x.span_end).toString("utf8")),
            `a span of ${key} does not cut a cited quote`,
          );
        return;
      }
      if (typeof e.state_history_of === "string") {
        const u = await unitOf(e.state_history_of);
        const last = await db()
          .selectFrom("unit_state")
          .selectAll()
          .where("unit_id", "=", u.id)
          .orderBy("id", "desc")
          .executeTakeFirstOrThrow();
        const want = e.last as { to: string; has_evidence?: boolean };
        assert.equal(last.to_state, want.to);
        if (want.has_evidence !== undefined) assert.equal(last.source_id !== null, want.has_evidence);
        return;
      }
      if (e.status && typeof e.status === "object") {
        const want = e.status as Record<string, unknown>;
        // Seen this many days after the capture, which stamps messages with the real clock
        const now =
          typeof want.after_days === "number"
            ? new Date(Date.now() + want.after_days * 86_400_000)
            : new Date();
        const text = await status(db(), await projectId(), "example/tsundoku", now);
        const n = (re: RegExp) => Number(re.exec(text)?.[1] ?? 0);
        if (want.quarantined !== undefined)
          assert.equal(n(/(\d+) quarantined record/), want.quarantined, text);
        if (want.processed_without_units !== undefined)
          assert.equal(
            n(/(\d+) sessions? traced with nothing to record/),
            want.processed_without_units,
            text,
          );
        if (typeof want.pending_sessions_includes === "string") {
          const s = sessions.get(want.pending_sessions_includes);
          const uuid = sessionId(
            await projectId(),
            s?.host === "codex" ? "codex" : "claude-code",
            want.pending_sessions_includes,
          );
          assert.match(await pendingText(writer(), await projectId(), now), new RegExp(uuid));
        }
        if (want.pending_recent !== undefined)
          assert.equal(n(/(\d+) sessions? not traced yet/), want.pending_recent, text);
        if (want.pending_older !== undefined)
          assert.equal(n(/(\d+) older sessions? /), want.pending_older, text);
        if (typeof want.pending_older_includes === "string") {
          const s = sessions.get(want.pending_older_includes);
          const uuid = sessionId(
            await projectId(),
            s?.host === "codex" ? "codex" : "claude-code",
            want.pending_older_includes,
          );
          const listed = await pendingText(writer(), await projectId(), now);
          assert.match(listed.slice(listed.indexOf("Older than 14 days")), new RegExp(uuid), listed);
        }
        return;
      }
      if (e.source_revisions && typeof e.source_revisions === "object") {
        const want = e.source_revisions as { of: string; count: number };
        const latest = await githubSource(want.of);
        assert.ok(latest, `no source ${want.of}`);
        assert.equal(latest.revision, want.count);
        return;
      }
      if (typeof e.evidence_of === "string") {
        const got = await db()
          .selectFrom("unit_evidence as e")
          .innerJoin("unit as u", "u.id", "e.unit_id")
          .innerJoin("source as m", "m.id", "e.source_id")
          .where("u.key", "=", e.evidence_of)
          .where("m.kind", "in", ["pr_body", "issue_body"])
          .select("m.revision")
          .execute();
        assert.ok(got.length, `${e.evidence_of} cites no body`);
        for (const g of got) assert.equal(g.revision, e.cites_revision);
        return;
      }
      if (typeof e.no_unit_text_contains === "string") {
        const texts = await db().selectFrom("unit").select(["key", "text"]).execute();
        assert.deepEqual(
          texts.filter((u) => u.text.includes(String(e.no_unit_text_contains))).map((u) => u.key),
          [],
        );
        return;
      }
      if (Array.isArray(e.overview_contains) || Array.isArray(e.overview_lacks)) {
        for (const w of (e.overview_contains ?? []) as string[])
          assert.ok(overview.includes(w), `overview lacks "${w}"\n${overview}`);
        for (const w of (e.overview_lacks ?? []) as string[])
          assert.ok(!overview.includes(w), `overview shows "${w}"\n${overview}`);
        return;
      }
      if (Array.isArray(e.export_contains)) {
        for (const w of e.export_contains as string[])
          assert.ok(exported.includes(w), `export lacks "${w}"\n${exported}`);
        return;
      }
      if (e.export_refuses && typeof e.export_refuses === "object") {
        const want = e.export_refuses as { records: string[]; contains: string };
        const r = await exportOf(want.records, "docs/decisions.md");
        assert.ok("error" in r && r.error.includes(want.contains), JSON.stringify(r));
        return;
      }
      if (Array.isArray(e.asked_contains)) {
        for (const w of e.asked_contains as string[])
          assert.ok(asked.includes(w), `asked lacks "${w}"\n${asked}`);
        return;
      }
      if (typeof e.hits_include === "string") {
        const at = found.findIndex((h) => h.key === e.hits_include);
        assert.ok(
          at >= 0 && at < Number(e.within ?? 10),
          `${e.hits_include} not within ${e.within}: ${found.map((h) => h.key).join(", ")}`,
        );
        return;
      }
      if (e.no_active_unit_hits === true) {
        assert.deepEqual(
          found.filter((h) => h.lifecycle === "active").map((h) => h.key),
          [],
        );
        return;
      }
      if (e.hit_shows_option && typeof e.hit_shows_option === "object") {
        const want = e.hit_shows_option as { unit: string; text: string; outcome: string };
        const hit = found.find((h) => h.key === want.unit);
        assert.ok(
          hit?.options.some((o) => o.text === want.text && o.outcome === want.outcome),
          `${want.unit} does not show ${want.text}`,
        );
        return;
      }
      if (Array.isArray(e.ranks_above)) {
        const [a, b] = e.ranks_above as [string, string];
        const ia = found.findIndex((h) => h.key === a);
        const ib = found.findIndex((h) => h.key === b);
        assert.ok(
          ia >= 0 && (ib < 0 || ia < ib),
          `${a} is not above ${b}: ${found.map((h) => h.key).join(", ")}`,
        );
        return;
      }
      if (typeof e.source_gone === "string") {
        assert.equal((await sessionSource(e.source_gone)) ?? (await githubSource(e.source_gone)), undefined);
        return;
      }
      // The index itself, not joined to source rows: an entry left behind by a removed row still counts here
      if (typeof e.source_index_misses === "string") {
        const left = await sql<{
          n: number;
        }>`select count(*) as n from source_fts where source_fts match ${ftsQuery(e.source_index_misses)}`.execute(
          // A raw statement needs kysely's executor, which the read-only type does not show; the connection itself still only reads
          db() as unknown as Kysely<DB>,
        );
        assert.equal(Number(left.rows[0]?.n), 0, `the index still holds ${e.source_index_misses}`);
        return;
      }
      if (e.source_search && typeof e.source_search === "object") {
        const want = e.source_search as { query: string; hits: number };
        const got = await searchSources(db(), await projectId(), want.query, 10);
        assert.equal(got.hits.length, want.hits, got.hits.map((h) => h.text).join(" / "));
        return;
      }
      if (e.search && typeof e.search === "object") {
        const want = e.search as { query: string; top_active_is: string };
        const hits = (await search(want.query)).filter((h) => h.lifecycle === "active");
        assert.equal(hits[0]?.key, want.top_active_is, hits.map((h) => h.key).join(", "));
        return;
      }
      if (e.search_not_include && typeof e.search_not_include === "object") {
        const want = e.search_not_include as { query: string; key: string };
        const hits = await search(want.query);
        assert.ok(!hits.some((h) => h.key === want.key), hits.map((h) => h.key).join(", "));
        return;
      }
      if (e.anchor && typeof e.anchor === "object") {
        const want = e.anchor as { of: string; symbol: string; state: string };
        const u = await unitOf(want.of);
        const anchors = await db()
          .selectFrom("unit_anchor")
          .selectAll()
          .where("unit_id", "=", u.id)
          .where("symbol", "=", want.symbol)
          .where("retired_at", "is", null)
          .execute();
        assert.ok(anchors[0], `${want.of} has no live anchor on ${want.symbol}`);
        assert.equal(checkAnchor(repo, anchors[0]).state, want.state);
        return;
      }
      if (e.evidence && typeof e.evidence === "object") {
        const want = e.evidence as { of: string; reported_speaker?: string; author_is_owner?: boolean };
        const got = await db()
          .selectFrom("unit_evidence as e")
          .innerJoin("unit as u", "u.id", "e.unit_id")
          .innerJoin("source as m", "m.id", "e.source_id")
          .where("u.key", "=", want.of)
          .where("e.reported_speaker", "=", want.reported_speaker ?? "")
          .select("m.author_kind")
          .execute();
        assert.ok(got.length, `${want.of} has no evidence reported as ${want.reported_speaker}`);
        if (want.author_is_owner !== undefined)
          assert.equal(got[0]?.author_kind === "owner", want.author_is_owner);
        return;
      }
      if (e.adoption_count && typeof e.adoption_count === "object") {
        const want = e.adoption_count as { of: string; count: number };
        const got = await db()
          .selectFrom("unit_adoption as a")
          .innerJoin("unit as u", "u.id", "a.unit_id")
          .where("u.key", "=", want.of)
          .where("a.retracted_at", "is", null)
          .select("a.id")
          .execute();
        assert.equal(got.length, want.count);
        return;
      }
      if (e.retracted_adoption_kept && typeof e.retracted_adoption_kept === "object") {
        const want = e.retracted_adoption_kept as { of: string; count: number };
        const got = await db()
          .selectFrom("unit_adoption as a")
          .innerJoin("unit as u", "u.id", "a.unit_id")
          .where("u.key", "=", want.of)
          .where("a.retracted_at", "is not", null)
          .select("a.id")
          .execute();
        assert.equal(got.length, want.count);
        return;
      }
      if (e.retired_anchor_kept && typeof e.retired_anchor_kept === "object") {
        const want = e.retired_anchor_kept as { of: string; symbol: string };
        const got = await db()
          .selectFrom("unit_anchor as a")
          .innerJoin("unit as u", "u.id", "a.unit_id")
          .where("u.key", "=", want.of)
          .where("a.symbol", "=", want.symbol)
          .where("a.retired_at", "is not", null)
          .select("a.id")
          .execute();
        assert.equal(got.length, 1);
        return;
      }
      if (e.evidence_count && typeof e.evidence_count === "object") {
        const want = e.evidence_count as { of: string; source: string; count: number };
        const src = Number((await ref(want.source)).slice(1));
        const got = await db()
          .selectFrom("unit_evidence as e")
          .innerJoin("unit as u", "u.id", "e.unit_id")
          .where("u.key", "=", want.of)
          .where("e.source_id", "=", src)
          .select("e.id")
          .execute();
        assert.equal(got.length, want.count);
        return;
      }
      if (e.file_source && typeof e.file_source === "object") {
        const want = e.file_source as {
          path: string;
          lines: [number, number];
          text: string;
          blob_recorded?: boolean;
          partial?: boolean;
          not_text?: string;
          redacted?: boolean;
        };
        const got = await db()
          .selectFrom("source")
          .selectAll()
          .where("kind", "=", "file_excerpt")
          .where("path", "=", want.path)
          .executeTakeFirst();
        assert.ok(got, `no excerpt of ${want.path}`);
        assert.deepEqual([got.line_start, got.line_end], want.lines);
        assert.ok(got.text.includes(want.text), got.text);
        if (want.blob_recorded) assert.match(got.blob_sha ?? "", /^[0-9a-f]{40}$/);
        if (want.partial !== undefined) assert.equal(got.truncated === 1, want.partial);
        if (want.not_text !== undefined) assert.ok(!got.text.includes(want.not_text), got.text);
        if (want.redacted !== undefined) assert.equal(got.redacted === 1, want.redacted);
        return;
      }
      if (typeof e.field_defined === "string") {
        const d = await db()
          .selectFrom("field_def")
          .select("name")
          .where("project_id", "=", await projectId())
          .where("name", "=", e.field_defined)
          .executeTakeFirst();
        assert.ok(d, `no field ${e.field_defined}`);
        return;
      }
      if (e.field_value && typeof e.field_value === "object") {
        const want = e.field_value as { of: string; name: string; value: string };
        const got = await db()
          .selectFrom("unit_field as f")
          .innerJoin("field_def as d", "d.id", "f.field_def_id")
          .where("f.unit_id", "=", (await unitOf(want.of)).id)
          .where("d.name", "=", want.name)
          .select("f.value")
          .executeTakeFirst();
        assert.equal(got?.value, want.value, `${want.of} ${want.name}`);
        return;
      }
      if (e.source_outcome && typeof e.source_outcome === "object") {
        const want = e.source_outcome as { source: string; outcome: string };
        const id = Number((await ref(want.source)).slice(1));
        const got = await db()
          .selectFrom("source_processing")
          .select("outcome")
          .where("source_id", "=", id)
          .execute();
        assert.ok(
          got.some((r) => r.outcome === want.outcome),
          `${want.source}: ${got.map((r) => r.outcome).join(", ")}`,
        );
        return;
      }
      if (typeof e.source_pending === "string") {
        const id = Number((await ref(e.source_pending)).slice(1));
        const got = await db()
          .selectFrom("source_processing")
          .select("outcome")
          .where("source_id", "=", id)
          .execute();
        assert.deepEqual(got, [], `${e.source_pending} was marked looked at`);
        return;
      }
      if (typeof e.no_unit === "string") {
        const u = await db().selectFrom("unit").select("id").where("key", "=", e.no_unit).executeTakeFirst();
        assert.equal(u, undefined, `${e.no_unit} was saved`);
        return;
      }
      if (typeof e.save_refused_contains === "string") {
        assert.ok(
          saves[0] && saves[0].status !== 0 && saves[0].out.includes(e.save_refused_contains),
          saves[0]?.out,
        );
        return;
      }
      if (e.every_save_refused === true) {
        assert.ok(saves.length > 0);
        for (const r of saves) assert.notEqual(r.status, 0, r.out);
        return;
      }
      if (e.stale_draft_refused === true) {
        assert.equal(saves[0]?.status, 0, saves[0]?.out);
        assert.notEqual(saves[1]?.status, 0, "the same draft saved twice");
        assert.ok(
          saves[2] && saves[2].status !== 0 && /changed since you read it/.test(saves[2].out),
          saves[2]?.out,
        );
        return;
      }
      if (typeof e.evidence_sources_not_include === "string") {
        assert.ok(!lastRead.includes(e.evidence_sources_not_include), lastRead);
        assert.ok(lastRead.length > 0, "nothing was read");
        return;
      }
      if (typeof e.check_notes_contain === "string") {
        assert.ok(
          checked.includes(e.check_notes_contain),
          `check did not say "${e.check_notes_contain}"\n${checked}`,
        );
        return;
      }
      if (typeof e.read_contains === "string") {
        assert.ok(lastRead.includes(e.read_contains), `read does not say "${e.read_contains}"\n${lastRead}`);
        return;
      }
      if (typeof e.applicable_include === "string") {
        assert.ok(
          applicable.some((u) => u.key === e.applicable_include),
          applicable.map((u) => u.key).join(", "),
        );
        return;
      }
      if (Array.isArray(e.applicable_not_include)) {
        for (const k of e.applicable_not_include as string[])
          assert.ok(!applicable.some((u) => u.key === k), k);
        return;
      }
      if (e.applicable_empty === true) {
        assert.deepEqual(
          applicable.map((u) => u.key),
          [],
        );
        return;
      }
      if (typeof e.lane === "string") {
        assert.equal(lane, e.lane);
        return;
      }
      if (Array.isArray(e.validation_problems_contain)) {
        for (const w of e.validation_problems_contain as string[])
          assert.ok(
            validation.some((p) => p.includes(w)),
            validation.join(" | "),
          );
        return;
      }
      if (Array.isArray(e.context_contains)) {
        for (const w of e.context_contains as string[])
          assert.ok(delivered[0]?.includes(w), `delivery lacks "${w}"\n${delivered[0]}`);
        return;
      }
      if (Array.isArray(e.context_not_contains)) {
        for (const w of e.context_not_contains as string[])
          assert.ok(!delivered[0]?.includes(w), `delivery has "${w}"\n${delivered[0]}`);
        return;
      }
      if (typeof e.context_max_chars === "number") {
        assert.ok((delivered[0] ?? "").length <= e.context_max_chars, `${delivered[0]?.length} chars`);
        return;
      }
      if (typeof e.context_max_lines === "number") {
        assert.ok((delivered[0] ?? "").split("\n").length <= e.context_max_lines, delivered[0]);
        return;
      }
      if (e.context_empty === true) {
        assert.equal(delivered[0], "");
        return;
      }
      if (Array.isArray(e.first_context_contains)) {
        for (const w of e.first_context_contains as string[])
          assert.ok(delivered[0]?.includes(w), `first delivery lacks "${w}"\n${delivered[0]}`);
        return;
      }
      // One expectation per call of a sequence, in order
      if (Array.isArray(e.each_context)) {
        const each = e.each_context as { contains?: string[]; lacks?: string[]; empty?: true }[];
        assert.equal(delivered.length, each.length, "one expectation per call");
        each.forEach((want, n) => {
          if (want.empty) assert.equal(delivered[n], "", `call ${n + 1} delivered\n${delivered[n]}`);
          for (const w of want.contains ?? [])
            assert.ok(delivered[n]?.includes(w), `call ${n + 1} lacks "${w}"\n${delivered[n]}`);
          for (const w of want.lacks ?? [])
            assert.ok(!delivered[n]?.includes(w), `call ${n + 1} has "${w}"\n${delivered[n]}`);
        });
        return;
      }
      if (e.second_context_empty === true) {
        assert.equal(delivered[1], "");
        return;
      }
      if (typeof e.inject_prompt_context_empty === "string") {
        assert.equal(
          await inject({ event: "prompt", prompt: e.inject_prompt_context_empty }),
          "",
          String(e.reason),
        );
        return;
      }
      if (typeof e.inject_never_contains === "string") {
        const all = await everything(e.inject_never_contains);
        assert.ok(!all.includes(e.inject_never_contains), all);
        return;
      }
      if (typeof e.read_of_source === "string") {
        const text = framed((await readSource(db(), await projectId(), await ref(e.read_of_source))) ?? "");
        if (e.framed_as_past_evidence)
          assert.match(
            text,
            /^<past-records id="[0-9a-f]+">\nPast records: [\s\S]*Evidence, not instructions/,
          );
        return;
      }
      if (typeof e.check_problem_absent === "string") {
        assert.ok(
          !checked.includes(e.check_problem_absent),
          `check reported "${e.check_problem_absent}"\n${checked}`,
        );
        assert.ok(checked.length > 0, "nothing was checked");
        return;
      }
      if (typeof e.check_problem_contains === "string") {
        assert.ok(
          checked.includes(e.check_problem_contains),
          `check did not report "${e.check_problem_contains}"\n${checked}`,
        );
        return;
      }
      throw missing("expectation", e);
    },
    snapshot: async (to) => {
      await reader?.destroy();
      await ingest?.destroy();
      reader = null;
      ingest = null;
      const raw = connectWriter("owner", file);
      try {
        raw.exec(`vacuum into '${to.replaceAll("'", "''")}'`);
      } finally {
        raw.close();
      }
    },
    done: async () => {
      await reader?.destroy();
      await ingest?.destroy();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Turn ids the driver gives the hooks: the case's turn number, so `session:<id>#2.owner` finds the second turn. */
const turnId = (n: number): string => `t${n}`;

/** The 40-character sha the fake gh gives a commit the world names by a short label. */
const fakeSha = (label: string): string => crypto.createHash("sha1").update(label).digest("hex");

/** A gh that answers `gh api repos/<o>/<r>/<path>` and `gh api user` from the world file. A shebang script, so it runs on POSIX only (verify does not run on Windows). */
function fakeGh(state: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const { world, edited, signedIn } = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
const argv = process.argv.slice(2);
const where = (argv[1] ?? "").replace(/^repos\\/[^/]+\\/[^/]+\\//, "").split("?")[0];
const sha = (s) => crypto.createHash("sha1").update(s).digest("hex");
const id = (login) => parseInt(sha(login).slice(0, 8), 16);
const user = (login) => ({ login, id: id(login), type: login.endsWith("-bot") ? "Bot" : "User" });
const comment = (c, url) => ({ id: c.id, body: c.body, user: user(c.author), author_association: c.association, created_at: c.created_at, html_url: url + "#c" + c.id });
const answers = {};
for (const p of world.pulls) {
  const url = "https://github.com/example/tsundoku/pull/" + p.number;
  const edits = edited.includes(p.number) ? p.body_edits ?? [] : [];
  answers["pulls/" + p.number] = { number: p.number, title: p.title, body: edits.length ? edits[edits.length - 1].body : p.body, html_url: url,
    created_at: p.created_at, merged_at: p.merged_at, merged_by: p.merged_at ? user(p.author) : null, user: user(p.author), author_association: p.association };
  answers["issues/" + p.number + "/comments"] = p.comments.map((c) => comment(c, url));
  answers["pulls/" + p.number + "/reviews"] = [];
  answers["pulls/" + p.number + "/comments"] = p.review_comments.map((c) => ({ ...comment(c, url), path: c.path, line: c.line, commit_id: sha(c.commit) }));
  answers["pulls/" + p.number + "/commits"] = p.commits.map((c) => ({ sha: sha(c.sha), author: user(p.author), commit: { message: c.message, author: { date: c.date } } }));
}
for (const i of world.issues) {
  const url = "https://github.com/example/tsundoku/issues/" + i.number;
  answers["issues/" + i.number] = { number: i.number, body: i.body, html_url: url, created_at: i.created_at, user: user(i.author), author_association: i.association };
  answers["issues/" + i.number + "/comments"] = i.comments.map((c) => comment(c, url));
}
if (argv[1] === "user") {
  if (!signedIn) { process.stderr.write("fake gh: not signed in\\n"); process.exit(1); }
  process.stdout.write(JSON.stringify(user(signedIn)));
  process.exit(0);
}
if (!(where in answers)) { process.stderr.write("fake gh: no answer for " + argv[1] + "\\n"); process.exit(1); }
process.stdout.write(JSON.stringify(argv.includes("--slurp") ? [answers[where]] : answers[where]));
`;
}
