// Checks and saves the record an agent wrote for one extraction run (trace or harvest). Every quote is located in retained source text,
// so a unit carries byte spans of what was actually said, never the agent's paraphrase. The activation rules live in db/schema.sql triggers.
import type { Kysely } from "kysely";
import { z } from "zod";
import { locate as locateSymbol, masksSymbol } from "./anchors.ts";
import { iso } from "./db.ts";
import type { DB } from "./db-types.ts";
import { commitHolds } from "./git.ts";
import { EVIDENCE_ROLES, OPTION_OUTCOMES, STANCES, UNIT_KINDS, WORK_STATUSES } from "./knowledge.ts";
import { head, sha256 } from "./text.ts";

const KEY = /^[a-z0-9][a-z0-9._/-]{0,63}$/;
/** Sources are cited by the refs context prints (`s<id>`), never by URL or position the agent made up. */
const SOURCE_REF = /^s[1-9][0-9]{0,15}$/;
const MAINTAINERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const text = (max: number) => z.string().trim().min(1).max(max);
const Quote = z
  .object({ source: z.string().regex(SOURCE_REF, "cite a source ref such as s12"), quote: z.string() })
  .strict();
const Evidence = Quote.extend({
  role: z.enum(EVIDENCE_ROLES),
  reported_speaker: text(100).optional(),
}).strict();
const Unit = z
  .object({
    key: z.string().regex(KEY, "use lowercase letters, digits, and . _ - / (at most 64)"),
    kind: z.enum(UNIT_KINDS),
    stance: z.enum(STANCES).optional(),
    text: text(2000),
    why: text(2000).optional(),
    scope_note: text(1000).optional(),
    revisit_when: text(1000).optional(),
    no_code_surface: text(500).optional(),
    options: z
      .array(
        z
          .object({
            text: text(500),
            outcome: z.enum(OPTION_OUTCOMES),
            why: text(2000).optional(),
            // The role defaults from the outcome: a rejected option's evidence rejects it, a chosen one's states it
            evidence: z
              .array(Evidence.partial({ role: true }))
              .max(10)
              .default([]),
          })
          .strict(),
      )
      .max(12)
      .default([]),
    evidence: z.array(Evidence).max(20).default([]),
    adoption: z.array(Quote).max(5).default([]),
    anchors: z
      .array(
        z
          .object({
            path: text(500),
            symbol: text(200).optional(),
            role: z.enum(["applies_to", "evidence"]),
            commit: z
              .string()
              .regex(/^[0-9a-f]{40}$/, "a full 40-character commit sha")
              .optional(),
            lines: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    aliases: z.array(z.string()).max(12).default([]),
    supersedes: z.string().min(1).optional(),
    conflicts: z.array(z.string().min(1)).max(5).default([]),
  })
  .strict();
const Work = z
  .object({
    key: z.string().regex(KEY),
    title: text(200),
    goal: text(1000),
    current: text(2000),
    next: z.array(text(500)).max(10).default([]),
    status: z.enum(WORK_STATUSES),
  })
  .strict();
const Record = z.object({ units: z.array(Unit).max(50), work: Work.optional() }).strict();

type UnitInput = z.infer<typeof Unit>;
type Span = { source: number; start: number; end: number };
type EvidenceSpan = Span & { role: (typeof EVIDENCE_ROLES)[number]; reported: string | null };

/** What the run is about: its project, the key namespace (`trace:<session>/`), and the session whose edits anchors may cite. */
export type Target = {
  projectId: number;
  origin: "trace" | "harvest" | "glean";
  prefix: string;
  sessionId: string | null;
  /** The repository's working tree, where an anchor's symbol is looked up to record its lines; null when unknown */
  root: string | null;
  /** The sources the run may cite (a trace's session, a harvest's pull request); null for glean, which cites any source of the project */
  sources: readonly number[] | null;
};

type Planned = {
  input: UnitInput;
  key: string;
  quarantine: string[];
  /** Every source the unit cites, found or not: the run looked at them and something came of it */
  cites: Set<number>;
  /** Set by glean when nothing but the owner's present words backs the unit */
  unsourced?: boolean;
  evidence: EvidenceSpan[];
  options: { input: UnitInput["options"][number]; evidence: EvidenceSpan[] }[];
  adoption: (Span & { route: "owner_statement" | "explicit" })[];
  anchors: (UnitInput["anchors"][number] & { path: string; observation: number | null })[];
  aliases: string[];
  supersedes: number | null;
  conflicts: number[];
};

/** errors refuse the save; problems name parts left out or units that stay candidates or quarantined, and the save goes ahead. */
export type Checked = {
  errors: string[];
  problems: string[];
  units: Planned[];
  work: z.infer<typeof Work> | null;
};

/** The byte span of quote in text, or null. The first occurrence is taken. */
function locate(body: string, quote: string): [number, number] | null {
  if (!quote.trim()) return null;
  const at = Buffer.from(body, "utf8").indexOf(Buffer.from(quote, "utf8"));
  return at < 0 ? null : [at, at + Buffer.byteLength(quote, "utf8")];
}

/** A repository-relative path with forward slashes, or null when it could leave the repository. */
export function repoPath(p: string): string | null {
  const s = p.trim().replace(/^\.\//, "");
  // Control characters (NUL above all) make a path no filesystem call accepts
  if (!s || s.startsWith("/") || s.includes("\\") || /^[A-Za-z]:/.test(s) || /\p{Cc}/u.test(s)) return null;
  const parts = s.split("/");
  if (parts.some((x) => x === ".." || x === "." || x === "")) return null;
  return s;
}

export async function checkRecord(db: Kysely<DB>, target: Target, raw: unknown): Promise<Checked> {
  const errors: string[] = [];
  const problems: string[] = [];
  const parsed = Record.safeParse(raw);
  if (!parsed.success)
    return {
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "record"}: ${i.message}`),
      problems,
      units: [],
      work: null,
    };
  const record = parsed.data;

  const keys = record.units.map((u) => target.prefix + u.key);
  for (const k of keys.filter((k, i) => keys.indexOf(k) !== i)) errors.push(`${k}: the key appears twice`);
  const taken = keys.length
    ? await db
        .selectFrom("unit")
        .select("key")
        .where("project_id", "=", target.projectId)
        .where("key", "in", keys)
        .execute()
    : [];
  for (const t of taken)
    errors.push(`${t.key}: already recorded. Records are never rewritten; use a new key and supersedes`);
  for (const [i, u] of record.units.entries()) {
    const at = keys[i];
    if (["decision", "constraint"].includes(u.kind) !== (u.stance !== undefined))
      errors.push(`${at}: stance is required for decisions and constraints, and only for them`);
    if (u.revisit_when !== undefined && u.stance !== "defer")
      errors.push(`${at}: revisit_when goes only with stance defer`);
  }

  const refs = new Set<number>();
  for (const u of record.units)
    for (const q of [...u.evidence, ...u.adoption, ...u.options.flatMap((o) => o.evidence)])
      refs.add(Number(q.source.slice(1)));
  const sources = new Map(
    (refs.size
      ? await db
          .selectFrom("source")
          .select(["id", "kind", "author_kind", "author_login", "author_association", "text"])
          .where("project_id", "=", target.projectId)
          .where("id", "in", [...refs])
          .execute()
      : []
    ).map((s) => [s.id, s]),
  );
  for (const r of refs) {
    if (!sources.has(r)) errors.push(`s${r}: not a source of this project`);
    else if (target.sources && !target.sources.includes(r))
      errors.push(`s${r}: not a source of this run (cite the sources record_context lists)`);
  }

  const linked = [
    ...new Set(record.units.flatMap((u) => [...(u.supersedes ? [u.supersedes] : []), ...u.conflicts])),
  ];
  const others = new Map(
    (linked.length
      ? await db
          .selectFrom("unit")
          .select(["id", "key", "lifecycle"])
          .where("project_id", "=", target.projectId)
          .where("key", "in", linked)
          .execute()
      : []
    ).map((u) => [u.key, u]),
  );

  // Logins that speak as a maintainer somewhere in this project: their commits and events carry no association of their own
  const maintainers = new Set(
    record.units.some((u) => u.supersedes || u.conflicts.length)
      ? (
          await db
            .selectFrom("source")
            .select("author_login")
            .distinct()
            .where("project_id", "=", target.projectId)
            .where("author_association", "in", [...MAINTAINERS])
            .execute()
        ).flatMap((r) => (r.author_login ? [r.author_login] : []))
      : [],
  );

  const units: Planned[] = [];
  // Records this save supersedes: one record has one successor
  const claimed = new Set<number>();
  for (const [i, u] of record.units.entries()) {
    const key = keys[i] ?? "";
    const quarantine: string[] = [];
    const cites = new Set<number>();
    const spans = (list: z.infer<typeof Evidence>[]): EvidenceSpan[] =>
      list.flatMap((e) => {
        const s = sources.get(Number(e.source.slice(1)));
        if (!s) return [];
        cites.add(s.id);
        const span = locate(s.text, e.quote);
        if (!span) {
          quarantine.push(`quote not found in ${e.source}: "${head(e.quote, 80)}"`);
          return [];
        }
        if (
          e.reported_speaker !== undefined &&
          !(s.kind === "session_message" && s.author_kind === "owner")
        ) {
          errors.push(
            `${key}: reported_speaker is for the owner reporting someone else, so it must cite an owner message`,
          );
          return [];
        }
        return [
          { source: s.id, start: span[0], end: span[1], role: e.role, reported: e.reported_speaker ?? null },
        ];
      });
    const evidence = spans(u.evidence);
    const options = u.options.map((o) => ({
      input: o,
      evidence: spans(
        o.evidence.map((e) => ({
          ...e,
          role:
            e.role ?? (o.outcome === "rejected" ? "rejects" : o.outcome === "chosen" ? "states" : "explains"),
        })),
      ),
    }));
    if (u.evidence.length === 0) quarantine.push("no evidence cited");
    // Retiring or disputing a record changes what is delivered: outside trace, third-party text alone cannot do it
    // (the owner's own sessions, a maintainer, or the owner count; pull request and issue text from others does not)
    if (target.origin !== "trace" && (u.supersedes || u.conflicts.length)) {
      const trusted = [...u.evidence, ...u.adoption].some((q) => {
        const s = sources.get(Number(q.source.slice(1)));
        return (
          s &&
          (s.kind === "session_message" ||
            s.author_kind === "owner" ||
            MAINTAINERS.has(s.author_association ?? "") ||
            (s.author_login !== null && maintainers.has(s.author_login)))
        );
      });
      if (!trusted)
        errors.push(
          `${key}: supersedes and conflicts from ${target.origin} need the owner's or a maintainer's words, or the owner's session`,
        );
    }

    const adoption: Planned["adoption"] = [];
    for (const a of u.adoption) {
      const s = sources.get(Number(a.source.slice(1)));
      if (s) cites.add(s.id);
      if (!s) continue;
      if (!["decision", "constraint"].includes(u.kind)) {
        problems.push(`${key}: adoption applies to decisions and constraints; ${a.source} left out`);
        continue;
      }
      if (s.kind === "pr_event") {
        problems.push(
          `${key}: the merge does not adopt a proposal (it only shows the code went in); cite the owner's or a maintainer's words`,
        );
        continue;
      }
      const route =
        s.author_kind === "owner"
          ? "owner_statement"
          : MAINTAINERS.has(s.author_association ?? "")
            ? "explicit"
            : null;
      if (!route) {
        problems.push(
          `${key}: ${a.source} is by ${s.author_login ?? s.author_kind} (${s.author_association ?? "no association"}); only the owner or a maintainer can adopt`,
        );
        continue;
      }
      const span = locate(s.text, a.quote);
      if (!span) {
        quarantine.push(`adoption quote not found in ${a.source}: "${head(a.quote, 80)}"`);
        continue;
      }
      adoption.push({ source: s.id, start: span[0], end: span[1], route });
    }

    const anchors: Planned["anchors"] = [];
    for (const a of u.anchors) {
      const p = repoPath(a.path);
      if (!p) {
        problems.push(
          `${key}: anchor path ${JSON.stringify(head(a.path, 80))} is not inside the repository; left out`,
        );
        continue;
      }
      if (a.symbol && masksSymbol(target.root, p, a.symbol)) {
        problems.push(`${key}: anchor symbol in ${p} is text Sphica masks; left out`);
        continue;
      }
      // A commit counts as code evidence only when the repository has it and it holds the path; otherwise the anchor keeps no commit
      let commit = a.commit;
      if (commit && !(target.root && commitHolds(target.root, commit, p))) {
        problems.push(
          `${key}: commit ${commit.slice(0, 12)} does not hold ${p} in the repository${target.root ? "" : " (no working tree to check)"}; the anchor keeps no commit`,
        );
        commit = undefined;
      }
      const observation =
        a.role === "evidence" && !commit && target.sessionId
          ? ((
              await db
                .selectFrom("edit_observation")
                .select("id")
                .where("session_id", "=", target.sessionId)
                .where("path", "=", p)
                .orderBy("id", "desc")
                .executeTakeFirst()
            )?.id ?? null)
          : null;
      anchors.push({ ...a, commit, path: p, observation });
    }

    const aliases = [...new Set(u.aliases.map((a) => a.trim()))];
    const bad = aliases.filter((a) => !a || a.length > 40);
    if (bad.length)
      problems.push(
        `${key}: aliases must be 1 to 40 characters; left out ${bad.map((a) => JSON.stringify(a)).join(", ")}`,
      );

    let supersedes: number | null = null;
    if (u.supersedes) {
      const old = others.get(u.supersedes);
      if (!old) errors.push(`${key}: supersedes ${u.supersedes}, which is not a record of this project`);
      else if (!["active", "candidate"].includes(old.lifecycle))
        errors.push(`${key}: ${u.supersedes} is already ${old.lifecycle}`);
      else if (claimed.has(old.id))
        errors.push(`${key}: another record in this save already supersedes ${u.supersedes}`);
      else supersedes = old.id;
      if (supersedes !== null) claimed.add(supersedes);
    }
    const conflicts = u.conflicts.flatMap((k) => {
      const other = others.get(k);
      if (!other) errors.push(`${key}: conflicts with ${k}, which is not a record of this project`);
      return other ? [other.id] : [];
    });

    units.push({
      input: u,
      key,
      quarantine,
      cites,
      evidence,
      options,
      adoption,
      anchors,
      aliases: aliases.filter((a) => a && a.length <= 40),
      supersedes,
      conflicts,
    });
  }
  // Work is the traced session's own state, shown at session start: a harvest or glean cannot set it from text it read
  if (record.work && target.origin !== "trace") errors.push("work: only trace records work");
  return { errors, problems, units, work: record.work ?? null };
}

export type Saved = {
  active: string[];
  candidates: { key: string; why: string }[];
  quarantined: string[];
  superseded: string[];
};

/** The hash of what a unit says: its text and options. Alias sets are bound to it, so words written for other text are never used. */
const contentHash = (u: UnitInput): Buffer =>
  sha256(
    JSON.stringify([
      u.text,
      u.why ?? null,
      u.scope_note ?? null,
      u.revisit_when ?? null,
      u.options.map((o) => [o.text, o.outcome, o.why ?? null]),
    ]),
  );

/** Messages the schema's activation rules raise; anything else is a real failure. */
const ACTIVATION = /needs|cannot become active/;

/**
 * Writes a checked record inside the caller's transaction. looked lists the sources the run read: each gets a processing outcome, so
 * coverage counts what was examined even when nothing came of it.
 */
export async function saveRecord(
  trx: Kysely<DB>,
  target: Target,
  runId: number,
  checked: Checked,
  looked: number[],
): Promise<Saved> {
  if (checked.errors.length)
    throw new Error(`The record is not valid:\n${checked.errors.map((e) => `  ${e}`).join("\n")}`);
  const now = iso(Date.now());
  const saved: Saved = { active: [], candidates: [], quarantined: [], superseded: [] };
  const cited = new Set<number>();
  for (const p of checked.units) {
    for (const c of p.cites) cited.add(c);
    const u = p.input;
    const hash = contentHash(u);
    const { id } = await trx
      .insertInto("unit")
      .values({
        project_id: target.projectId,
        key: p.key,
        kind: u.kind,
        stance: u.stance ?? null,
        text: u.text,
        why: u.why ?? null,
        scope_note: u.scope_note ?? null,
        revisit_when: u.revisit_when ?? null,
        no_code_surface: u.no_code_surface ?? null,
        extraction: p.quarantine.length ? "quarantined" : "supported",
        extraction_reason: p.quarantine.length ? p.quarantine.join("; ") : null,
        unsourced: p.unsourced ? 1 : 0,
        run_id: runId,
        created_at: now,
        content_hash: hash,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const evidence = async (list: EvidenceSpan[], option: number | null) => {
      for (const e of list) {
        cited.add(e.source);
        await trx
          .insertInto("unit_evidence")
          .values({
            unit_id: id,
            option_id: option,
            source_id: e.source,
            span_start: e.start,
            span_end: e.end,
            role: e.role,
            reported_speaker: e.reported,
            run_id: runId,
            added_at: now,
          })
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
    };
    for (const [i, o] of p.options.entries()) {
      const option = await trx
        .insertInto("unit_option")
        .values({
          unit_id: id,
          position: i + 1,
          text: o.input.text,
          outcome: o.input.outcome,
          why: o.input.why ?? null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await evidence(o.evidence, option.id);
    }
    await evidence(p.evidence, null);
    for (const a of p.adoption) {
      cited.add(a.source);
      await trx
        .insertInto("unit_adoption")
        .values({
          unit_id: id,
          route: a.route,
          source_id: a.source,
          span_start: a.start,
          span_end: a.end,
          run_id: runId,
          added_at: now,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    for (const a of p.anchors) {
      // Lines are recorded where the symbol is now, so a later read can tell a moved symbol from a missing one
      const at = a.lines ? null : a.symbol ? locateSymbol(target.root, a.path, a.symbol) : null;
      const lines = a.lines ?? (at ? [at.line, at.line] : null);
      await trx
        .insertInto("unit_anchor")
        .values({
          unit_id: id,
          path: a.path,
          symbol: a.symbol ?? null,
          commit_sha: a.commit ?? null,
          line_start: lines?.[0] ?? null,
          line_end: lines ? Math.max(lines[0], lines[1]) : null,
          excerpt: at?.excerpt ?? null,
          role: a.role,
          edit_observation_id: a.observation,
          run_id: runId,
          added_at: now,
        })
        .execute();
    }
    await trx
      .insertInto("unit_state")
      .values({
        unit_id: id,
        from_state: null,
        to_state: "candidate",
        at: now,
        reason: `${target.origin} extracted`,
        run_id: runId,
      })
      .execute();
    if (p.aliases.length)
      await trx
        .insertInto("unit_alias")
        .values({
          unit_id: id,
          terms: JSON.stringify(p.aliases),
          content_hash: hash,
          run_id: runId,
          added_at: now,
        })
        .execute();
    if (p.supersedes !== null)
      await trx
        .insertInto("unit_link")
        .values({ from_unit: id, to_unit: p.supersedes, kind: "supersedes", run_id: runId, added_at: now })
        .execute();
    for (const c of p.conflicts)
      await trx
        .insertInto("unit_link")
        .values({ from_unit: id, to_unit: c, kind: "conflicts", run_id: runId, added_at: now })
        .execute();

    if (p.quarantine.length) {
      saved.quarantined.push(`${p.key} (${p.quarantine.join("; ")})`);
      continue;
    }
    const first = p.evidence[0]?.source ?? null;
    try {
      await trx
        .insertInto("unit_state")
        .values({
          unit_id: id,
          from_state: "candidate",
          to_state: "active",
          at: now,
          reason: p.adoption.length ? "evidence and adoption found" : "evidence found",
          source_id: p.adoption[0]?.source ?? first,
          run_id: runId,
        })
        .execute();
    } catch (e) {
      const why = (e as Error).message;
      if (!ACTIVATION.test(why)) throw e;
      saved.candidates.push({ key: p.key, why });
      continue;
    }
    saved.active.push(p.key);
    if (p.supersedes !== null) {
      const old = await trx
        .selectFrom("unit")
        .select(["key", "lifecycle"])
        .where("id", "=", p.supersedes)
        .executeTakeFirstOrThrow();
      await trx
        .insertInto("unit_state")
        .values({
          unit_id: p.supersedes,
          from_state: old.lifecycle,
          to_state: "superseded",
          at: now,
          reason: `superseded by ${p.key}`,
          source_id: first,
          run_id: runId,
        })
        .execute();
      saved.superseded.push(old.key);
    }
  }
  if (checked.work) {
    const w = checked.work;
    const traced = target.sessionId
      ? await trx
          .selectFrom("session")
          .select(["started_at", "branch"])
          .where("id", "=", target.sessionId)
          .executeTakeFirst()
      : undefined;
    const row = {
      title: w.title,
      goal: w.goal,
      current: w.current,
      next: JSON.stringify(w.next),
      status: w.status,
      // Session start marks work on the branch it is on
      branch: traced?.branch ?? null,
      run_id: runId,
      updated_at: now,
    };
    // trace_pending lists the newest session first, so an older session is often traced later: its state must not replace a newer one
    const held = await trx
      .selectFrom("work as w")
      .leftJoin("extraction_run as r", "r.id", "w.run_id")
      .leftJoin("session as s", "s.id", "r.session_id")
      .select("s.started_at")
      .where("w.project_id", "=", target.projectId)
      .where("w.key", "=", w.key)
      .executeTakeFirst();
    const mine = traced?.started_at;
    if (!(held?.started_at && mine && held.started_at > mine))
      await trx
        .insertInto("work")
        .values({ project_id: target.projectId, key: w.key, ...row })
        .onConflict((oc) => oc.columns(["project_id", "key"]).doUpdateSet(row))
        .execute();
  }
  for (const s of new Set(looked))
    await trx
      .insertInto("source_processing")
      .values({ source_id: s, run_id: runId, outcome: cited.has(s) ? "units" : "no_unit" })
      .onConflict((oc) => oc.doNothing())
      .execute();
  await trx
    .updateTable("extraction_run")
    .set({ status: "saved", finished_at: now })
    .where("id", "=", runId)
    .execute();
  return saved;
}
