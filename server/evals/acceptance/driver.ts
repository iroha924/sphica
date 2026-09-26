// Maps acceptance steps and expectations onto Sphica's public entry points (capture hooks, CLI, MCP, delivery hooks).
// Each operation is filled in when its feature is built; until then it fails and names the missing operation.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Kysely } from "kysely";
import { checkAnchor } from "../../src/anchors.ts";
import { flush, onHook } from "../../src/capture.ts";
import { openReader } from "../../src/db.ts";
import type { DB } from "../../src/db-types.ts";
import { type Host, sessionId } from "../../src/knowledge.ts";
import { readUnit } from "../../src/read.ts";
import { searchUnits, type UnitHit } from "../../src/search.ts";
import { status } from "../../src/status.ts";
import type { Step, World } from "./load.ts";

export type Driver = {
  run(step: Step): Promise<void>;
  expect(expectation: Step): Promise<void>;
  done(): Promise<void>;
};

class NotBuilt extends Error {}

type Session = World["sessions"][number];

const CLI = path.join(import.meta.dirname, "..", "..", "src", "cli.ts");
/** Variables from the shell running the cases that would point hooks and the CLI at the owner's sessions or database. */
const LEAKY = [
  "SPHICA_DB",
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
    fs.writeFileSync(path.join(repo, rel), text);
  }
  git("add", "-A");
  git("commit", "-qm", "initial");
  cli("init", "--cwd", repo);

  const sessions = new Map(world.sessions.map((s) => [s.id, s]));
  // A fake gh first on PATH answers from the world (no network). edited lists PRs whose body is served with its edits.
  const edited = new Set<number>();
  const ghState = path.join(dir, "gh-world.json");
  const writeGh = () => fs.writeFileSync(ghState, JSON.stringify({ world, edited: [...edited] }));
  writeGh();
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(path.join(dir, "bin", "gh"), fakeGh(ghState), { mode: 0o755 });
  process.env.PATH = `${path.join(dir, "bin")}${path.delimiter}${saved.PATH ?? ""}`;
  let reader: Kysely<DB> | null = null;
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
  /** The last search's hits and the last read's text, for expectations about them. */
  let found: UnitHit[] = [];
  let lastRead = "";
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
    hook("start", { hook_event_name: "SessionStart" });
    s.turns.forEach((t, i) => {
      const turn = turnId(i + 1);
      hook(turn, { hook_event_name: "UserPromptSubmit", prompt: t.owner });
      t.edits.forEach((rel, k) => {
        const abs = path.join(repo, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.appendFileSync(abs, `// ${s.id} turn ${i + 1}\n`);
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
      hook(turn, { hook_event_name: "Stop", last_assistant_message: t.assistant });
    });
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

  /** Issues a draft through the CLI, writes the translated record into it, checks it, and saves it. */
  async function extract(
    origin: "trace" | "harvest",
    draftArgs: string[],
    prefix: string,
    record: Record<string, unknown>,
  ) {
    const drafted = cli(origin, "draft", ...draftArgs);
    const id = /^ {2}id: (\S+)$/m.exec(drafted)?.[1];
    const draftFile = /^ {2}file: (.+)$/m.exec(drafted)?.[1];
    if (!id || !draftFile) throw new Error(`${origin} draft printed no id or file\n${drafted}`);
    fs.writeFileSync(draftFile, JSON.stringify(await translate(record)));
    checked = run(origin, "check", id).out;
    cli(origin, "save", id);
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
    await extract("harvest", [String(step.pr)], `harvest:${step.pr}/`, step.record);
  }

  /** Replaces case references with source refs, deep inside a record. */
  async function translate(v: unknown): Promise<unknown> {
    if (Array.isArray(v)) return Promise.all(v.map(translate));
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v))
      out[k] = k === "source" && typeof x === "string" ? await ref(x) : await translate(x);
    return out;
  }

  async function trace(step: { session: string; record: Record<string, unknown> }): Promise<void> {
    const s = sessions.get(step.session);
    if (!s) throw new Error(`unknown session ${step.session}`);
    const uuid = sessionId(await projectId(), s.host === "codex" ? "codex" : "claude-code", s.id);
    const { processed_without_units: empty, ...record } = step.record;
    await extract("trace", ["--session", uuid], `trace:${s.id}/`, record);
    for (const other of (empty ?? []) as string[]) await trace({ session: other, record: { units: [] } });
  }

  const unitOf = async (key: string) => {
    const u = await db().selectFrom("unit").selectAll().where("key", "=", key).executeTakeFirst();
    assert.ok(u, `no unit ${key}`);
    return u;
  };

  return {
    run: async (step) => {
      if (typeof step.capture === "string") return capture(step.capture);
      if (step.edit_file && typeof step.edit_file === "object") {
        const edit = step.edit_file as { path: string; replace?: [string, string]; prepend?: string };
        const abs = path.join(repo, edit.path);
        let text = fs.readFileSync(abs, "utf8");
        if (edit.replace) {
          assert.ok(text.includes(edit.replace[0]), `${edit.path} has no ${edit.replace[0]}`);
          text = text.replace(edit.replace[0], edit.replace[1]);
        }
        if (edit.prepend) text = edit.prepend + text;
        fs.writeFileSync(abs, text);
        return;
      }
      if (step.search && typeof step.search === "object") {
        found = await search(String((step.search as { query: string }).query));
        return;
      }
      if (Array.isArray(step.read)) {
        const parts: string[] = [];
        for (const key of step.read as string[])
          parts.push((await readUnit(db(), await projectId(), key, repo)) ?? `${key}: not found`);
        lastRead = parts.join("\n\n");
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
      if (e.edit_observation && typeof e.edit_observation === "object") {
        const want = e.edit_observation as { session: string; path: string };
        const got = await db()
          .selectFrom("edit_observation as o")
          .innerJoin("session as s", "s.id", "o.session_id")
          .where("s.external_id", "=", want.session)
          .where("o.path", "=", want.path)
          .select("o.id")
          .execute();
        assert.ok(got.length > 0, `no edit observed for ${want.path} in ${want.session}`);
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
        const text = await status(db(), await projectId(), "example/tsundoku");
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
          assert.match(cli("trace", "pending"), new RegExp(uuid));
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
      if (e.search && typeof e.search === "object") {
        const want = e.search as { query: string; top_active_is: string };
        const hits = (await search(want.query)).filter((h) => h.lifecycle === "active");
        assert.equal(hits[0]?.key, want.top_active_is, hits.map((h) => h.key).join(", "));
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
      if (typeof e.read_contains === "string") {
        assert.ok(lastRead.includes(e.read_contains), `read does not say "${e.read_contains}"\n${lastRead}`);
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
    done: async () => {
      await reader?.destroy();
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

/** A gh that answers `gh api repos/<o>/<r>/<path>` from the world file. A shebang script, so it runs on POSIX only (verify does not run on Windows). */
function fakeGh(state: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const { world, edited } = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
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
if (!(where in answers)) { process.stderr.write("fake gh: no answer for " + argv[1] + "\\n"); process.exit(1); }
process.stdout.write(JSON.stringify(argv.includes("--slurp") ? [answers[where]] : answers[where]));
`;
}
