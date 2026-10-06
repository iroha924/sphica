// Checks and saves the record an agent wrote for one extraction run (trace or harvest). Every quote is located in retained source text,
// so a unit carries byte spans of what was actually said, never the agent's paraphrase. The activation rules live in db/schema.sql triggers.
import type { Kysely } from "kysely";
import { z } from "zod";
import { iso, type Reads } from "./db.ts";
import type { DB } from "./db-types.ts";
import { replaceable } from "./judge.ts";
import {
  EVIDENCE_ROLES,
  FIELD_TYPES,
  OPTION_OUTCOMES,
  STANCES,
  UNIT_KINDS,
  WORK_STATUSES,
} from "./knowledge.ts";
import { inline } from "./panel.ts";
import { firstState, type Hint, type Reconciled, reconcile } from "./reconcile.ts";
import {
  commitHeld,
  kindOf,
  listFilesIfGone,
  nearPaths,
  type Probe,
  type RepoFacts,
  refresh,
  repoFacts,
  symbolAt,
  symbolMasked,
  symbolMissing,
} from "./repo-facts.ts";
import { instructionFile } from "./rule-files.ts";
import { head, sha256 } from "./text.ts";

const KEY = /^[a-z0-9][a-z0-9._/-]{0,63}$/;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,39}$/;
/** Sources are cited by the refs context prints (`s<id>`), never by URL or position the agent made up. */
const SOURCE_REF = /^s[1-9][0-9]{0,15}$/;
const MAINTAINERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const text = (max: number) => z.string().trim().min(1).max(max);
const Quote = z
  .object({ source: z.string().regex(SOURCE_REF, "cite a source ref such as s12"), quote: z.string() })
  .strict();
const Evidence = Quote.extend({
  // A reconsider quote comes only as an option's reconsider_quote, tied to the condition it backs
  role: z.enum(EVIDENCE_ROLES).exclude(["reconsiders"]),
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
            // What the owner said would bring a rejected option back, with the owner's words
            reconsider_when: text(1000).optional(),
            reconsider_quote: Quote.optional(),
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
    fields: z
      .array(
        z
          .object({
            name: z.string().regex(FIELD_NAME, "a defined field name"),
            value: text(200),
            quote: Quote,
          })
          .strict(),
      )
      .max(12)
      .default([]),
  })
  .strict();
const FieldDef = z
  .object({
    name: z
      .string()
      .regex(FIELD_NAME, "a lowercase letter, then lowercase letters, digits, and _ (at most 40)"),
    type: z.enum(FIELD_TYPES),
    label: text(100),
    description: text(500),
    enum: z.array(text(100)).min(1).max(30).optional(),
    kinds: z.array(z.enum(UNIT_KINDS)).max(UNIT_KINDS.length).default([]),
    quote: Quote,
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
const Record = z
  .object({
    field_defs: z.array(FieldDef).max(10).default([]),
    units: z.array(Unit).max(50),
    work: Work.optional(),
  })
  .strict();

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
  /** Whether this run may adopt an AI's own decision: a trace begun and saved by an interactive session */
  agent?: boolean;
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
  options: { input: UnitInput["options"][number]; evidence: EvidenceSpan[]; reconsider: Span | null }[];
  adoption: (Span & { route: "owner_statement" | "explicit" | "agent" })[];
  anchors: (UnitInput["anchors"][number] & { path: string; observation: number | null })[];
  aliases: string[];
  supersedes: number | null;
  conflicts: number[];
  fields: (Span & { name: string; value: string })[];
};

type FieldType = (typeof FIELD_TYPES)[number];
type PlannedDef = Span & Omit<z.infer<typeof FieldDef>, "quote">;

/** errors refuse the save; problems name parts left out or units that stay candidates or quarantined, and the save goes ahead. */
export type Checked = {
  errors: string[];
  problems: string[];
  units: Planned[];
  work: z.infer<typeof Work> | null;
  /** Field definitions this record adds; they are written before its units */
  fieldDefs: PlannedDef[];
  /** What the check read from the working tree and git; save reads each file again and judges it anew only when it changed */
  facts: RepoFacts;
};

/**
 * Whether every line the byte span [start, end) touches is quoted (starts with ">") or inside a fenced code block: words someone pasted, not
 * words their writer chose. A heuristic: a paste with no quote marks is not caught.
 */
function quotedSpan(body: string, start: number, end: number): boolean {
  const bytes = Buffer.from(body, "utf8");
  let fenced = false;
  let touched = false;
  for (let at = 0; at <= bytes.length; ) {
    const nl = bytes.indexOf(0x0a, at);
    const stop = nl < 0 ? bytes.length : nl;
    const line = bytes.subarray(at, stop).toString("utf8").trimStart();
    const fence = /^(```|~~~)/.test(line);
    if (stop >= start && at < end) {
      touched = true;
      if (!(fenced || fence || line.startsWith(">"))) return false;
    }
    if (fence) fenced = !fenced;
    if (nl < 0) break;
    at = nl + 1;
  }
  return touched;
}

/** Whether the byte span [start, end) sits right inside quotation marks on its line: words the writer reports, not words they chose */
function inlineQuoted(body: string, start: number, end: number): boolean {
  const bytes = Buffer.from(body, "utf8");
  const before = bytes.subarray(0, start).toString("utf8").trimEnd().at(-1) ?? "";
  const after = bytes.subarray(end).toString("utf8").trimStart()[0] ?? "";
  // english-exempt: Japanese quotation brackets are quotation marks too
  return /["“'‘`「『]/.test(before) && /["”'’`」』]/.test(after);
}

/** The byte span of quote in text, or null. The first occurrence is taken. */
function locate(body: string, quote: string): [number, number] | null {
  if (!quote.trim()) return null;
  const at = Buffer.from(body, "utf8").indexOf(Buffer.from(quote, "utf8"));
  return at < 0 ? null : [at, at + Buffer.byteLength(quote, "utf8")];
}

/**
 * Why an anchor may point at the wrong place in the working tree, or null. Left unchecked: no working tree, a commit the repository holds
 * (past evidence, where the file may have changed since), and evidence of a file this session deleted.
 */
export function anchorProblem(
  facts: RepoFacts,
  a: { path: string; symbol?: string | null; role: string; held: boolean; observed: boolean },
): string | null {
  if (!facts.root || a.held) return null;
  const kind = kindOf(facts, a.path);
  const fix = "fix it and check again, or keep it if you know it is right";
  // Paths and symbols come from the record and from git; inline keeps line separators in them from starting a line
  const at = inline(a.path);
  if (kind === "gone") {
    if (a.role === "evidence" && a.observed) return null;
    const near = nearPaths(facts, a.path);
    // The list is read only before the lock, so a file gone since then gets no suggestions
    const hint = near?.length
      ? ` (near: ${near.map((n) => JSON.stringify(inline(n))).join(", ")})`
      : near === undefined
        ? " (near paths not checked)"
        : "";
    return `anchor path ${at} is not in the working tree${hint}; ${fix}`;
  }
  if (kind === "directory") return `anchor path ${at} is a directory; anchor a file`;
  if (kind === "file" && a.symbol && symbolMissing(facts, a.path, a.symbol))
    return `symbol ${JSON.stringify(inline(head(a.symbol, 80)))} is not found in ${at}; ${fix}`;
  return null;
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

/**
 * Reads what the record's anchors need from the working tree and git, before the caller takes the write lock. A record that does not
 * parse reads nothing; checkRecord reports it.
 */
export function prepareRecord(root: string | null, raw: unknown, probe?: Probe): RepoFacts {
  const facts = repoFacts(root, probe);
  const parsed = Record.safeParse(raw);
  if (!parsed.success) return facts;
  for (const a of parsed.data.units.flatMap((u) => u.anchors)) {
    const p = repoPath(a.path);
    if (!p) continue;
    listFilesIfGone(facts, p);
    if (a.symbol && !symbolMasked(facts, p, a.symbol)) symbolAt(facts, p, a.symbol);
    if (a.commit) commitHeld(facts, a.commit, p);
  }
  return facts;
}

export async function checkRecord(
  db: Reads,
  target: Target,
  raw: unknown,
  facts: RepoFacts = prepareRecord(target.root, raw),
): Promise<Checked> {
  const errors: string[] = [];
  const problems: string[] = [];
  const parsed = Record.safeParse(raw);
  if (!parsed.success)
    return {
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "record"}: ${i.message}`),
      problems,
      units: [],
      work: null,
      fieldDefs: [],
      facts,
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
    for (const o of u.options) {
      if ((o.reconsider_when === undefined) !== (o.reconsider_quote === undefined))
        errors.push(`${at}: option "${head(o.text, 60)}": reconsider_when and reconsider_quote go together`);
      else if (o.reconsider_when !== undefined && o.outcome !== "rejected")
        errors.push(
          `${at}: option "${head(o.text, 60)}": a reconsider condition goes only on a rejected option`,
        );
    }
  }

  const refs = new Set<number>();
  for (const u of record.units)
    for (const q of [
      ...u.evidence,
      ...u.adoption,
      ...u.options.flatMap((o) => [...o.evidence, ...(o.reconsider_quote ? [o.reconsider_quote] : [])]),
      ...u.fields.map((f) => f.quote),
    ])
      refs.add(Number(q.source.slice(1)));
  for (const d of record.field_defs) refs.add(Number(d.quote.source.slice(1)));
  const sources = new Map(
    (refs.size
      ? await db
          .selectFrom("source")
          .select([
            "id",
            "kind",
            "author_kind",
            "author_login",
            "author_association",
            "text",
            "external_id",
            "session_id",
            "turn_id",
          ])
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

  const withFields = record.field_defs.length > 0 || record.units.some((u) => u.fields.length > 0);
  // Fields are a trial kept to the owner's own sessions: a harvest or glean reads text others wrote
  if (withFields && target.origin !== "trace")
    errors.push("field_defs and fields: only trace records fields");
  const defined = new Map<string, { type: FieldType; enum: string[] | null; kinds: string[] }>(
    (withFields
      ? await db
          .selectFrom("field_def")
          .select(["name", "type", "enum_values", "kinds"])
          .where("project_id", "=", target.projectId)
          .execute()
      : []
    ).map((d) => [
      d.name,
      {
        type: d.type as FieldType,
        enum: d.enum_values === null ? null : (JSON.parse(d.enum_values) as string[]),
        kinds: JSON.parse(d.kinds) as string[],
      },
    ]),
  );
  const fieldDefs: PlannedDef[] = [];
  for (const d of record.field_defs) {
    const at = `field_defs ${d.name}`;
    if (defined.has(d.name)) {
      errors.push(`${at}: already defined in this project; a field cannot be defined again`);
      continue;
    }
    if ((d.type === "enum") !== (d.enum !== undefined))
      errors.push(`${at}: enum goes with type enum, and only with it`);
    if (d.enum && new Set(d.enum).size !== d.enum.length) errors.push(`${at}: enum values appear twice`);
    if (new Set(d.kinds).size !== d.kinds.length) errors.push(`${at}: kinds appear twice`);
    const s = sources.get(Number(d.quote.source.slice(1)));
    if (!s) continue;
    // A field is the owner's choice of what to track: the AI proposing one is not a definition
    if (s.author_kind !== "owner") {
      errors.push(
        `${at}: the quote must be the owner's; ${d.quote.source} is by ${s.author_login ?? s.author_kind}`,
      );
      continue;
    }
    const span = locate(s.text, d.quote.quote);
    if (!span) {
      errors.push(`${at}: quote not found in ${d.quote.source}: "${head(d.quote.quote, 80)}"`);
      continue;
    }
    defined.set(d.name, { type: d.type, enum: d.enum ?? null, kinds: d.kinds });
    const { quote: _, ...rest } = d;
    fieldDefs.push({ ...rest, source: s.id, start: span[0], end: span[1] });
  }
  const names = record.field_defs.map((d) => d.name);
  for (const n of new Set(names.filter((n, i) => names.indexOf(n) !== i)))
    errors.push(`field_defs ${n}: defined twice in this record`);

  const linked = [
    ...new Set(record.units.flatMap((u) => [...(u.supersedes ? [u.supersedes] : []), ...u.conflicts])),
  ];
  const others = new Map(
    (linked.length
      ? await db
          .selectFrom("unit as o")
          .select(["o.id", "o.key", "o.kind", "o.lifecycle"])
          .where("o.project_id", "=", target.projectId)
          .where("o.key", "in", linked)
          .execute()
      : []
    ).map((u) => [u.key, u]),
  );

  const units: Planned[] = [];
  for (const [i, u] of record.units.entries()) {
    const key = keys[i] ?? "";
    const quarantine: string[] = [];
    const cites = new Set<number>();
    const spans = (list: z.infer<typeof Evidence>[], option = false): EvidenceSpan[] =>
      list.flatMap((e) => {
        const s = sources.get(Number(e.source.slice(1)));
        if (!s) return [];
        cites.add(s.id);
        // The schema refuses these at save; refused here too, so check never says a save would pass
        if (
          e.role === "decides" &&
          (option ||
            target.origin !== "trace" ||
            !(s.kind === "session_message" && s.author_kind === "assistant") ||
            /:ask:.*:q:/.test(s.external_id))
        ) {
          errors.push(
            `${key}: decides quotes the AI choosing in its own reply, never a question it asked, someone else's words, or an option, and only a trace records it`,
          );
          return [];
        }
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
    // Only the owner states a condition for reconsidering: the AI suggesting one, or someone else's words, is not the owner's condition
    const reconsider = (o: UnitInput["options"][number]): Span | null => {
      const q = o.reconsider_quote;
      const s = q && sources.get(Number(q.source.slice(1)));
      if (!q || !s || o.reconsider_when === undefined) return null;
      cites.add(s.id);
      if (s.author_kind !== "owner") {
        errors.push(
          `${key}: option "${head(o.text, 60)}": reconsider_quote must quote the owner; ${q.source} is by ${s.author_login ?? s.author_kind}`,
        );
        return null;
      }
      const span = locate(s.text, q.quote);
      // Refused rather than quarantined: an optional condition whose words are not there should not hold back the record it sits on
      if (!span) {
        errors.push(
          `${key}: option "${head(o.text, 60)}": reconsider_quote not found in ${q.source}: "${head(q.quote, 80)}"`,
        );
        return null;
      }
      return { source: s.id, start: span[0], end: span[1] };
    };
    const options = u.options.map((o) => ({
      input: o,
      evidence: spans(
        o.evidence.map((e) => ({
          ...e,
          role:
            e.role ?? (o.outcome === "rejected" ? "rejects" : o.outcome === "chosen" ? "states" : "explains"),
        })),
        true,
      ),
      reconsider: reconsider(o),
    }));
    if (u.evidence.length === 0) quarantine.push("no evidence cited");
    // Retiring or disputing a record changes what is delivered: outside trace, third-party text alone cannot do it (the owner's own
    // sessions, the owner, or a maintainer's own association count; a commit's login comes from its git author email, which a fork can forge)
    if (target.origin !== "trace" && (u.supersedes || u.conflicts.length)) {
      const trusted = [...u.evidence, ...u.adoption].some((q) => {
        const s = sources.get(Number(q.source.slice(1)));
        return (
          s &&
          (s.kind === "session_message" ||
            s.author_kind === "owner" ||
            MAINTAINERS.has(s.author_association ?? ""))
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
      // The AI's own reply adopts only for the AI, only in a run an interactive session began and saves; checked below with the anchors
      const route =
        s.author_kind === "owner"
          ? "owner_statement"
          : MAINTAINERS.has(s.author_association ?? "")
            ? "explicit"
            : s.author_kind === "assistant" && s.kind === "session_message" && target.agent
              ? "agent"
              : null;
      if (!route) {
        problems.push(
          `${key}: ${a.source} is by ${s.author_login ?? s.author_kind} (${s.author_association ?? "no association"}); only the owner or a maintainer can adopt${s.author_kind === "assistant" ? ", and an AI's own decision only in a trace an interactive session runs" : ""}`,
        );
        continue;
      }
      const span = locate(s.text, a.quote);
      if (!span) {
        quarantine.push(`adoption quote not found in ${a.source}: "${head(a.quote, 80)}"`);
        continue;
      }
      // Words in quotation marks are reported, whoever writes them: an owner pasting what someone wrote, or the AI repeating it
      if (quotedSpan(s.text, span[0], span[1]) || inlineQuoted(s.text, span[0], span[1])) {
        problems.push(
          `${key}: the adoption in ${a.source} is quoted or in a code block, so it is someone else's words pasted in; left out, so it stays a candidate unless other words adopt it`,
        );
        continue;
      }
      adoption.push({ source: s.id, start: span[0], end: span[1], route });
    }

    const anchors: Planned["anchors"] = [];
    const fallbacks = new Set<(typeof anchors)[number]>();
    for (const a of u.anchors) {
      const p = repoPath(a.path);
      if (!p) {
        problems.push(
          `${key}: anchor path ${JSON.stringify(head(a.path, 80))} is not inside the repository; left out`,
        );
        continue;
      }
      // The path still delivers the record; only the symbol, which would store the key, is dropped
      const symbol = a.symbol && symbolMasked(facts, p, a.symbol) ? undefined : a.symbol;
      if (a.symbol && !symbol)
        problems.push(`${key}: anchor symbol in ${p} is text Sphica masks; the anchor keeps only its path`);
      // A commit counts as code evidence only when the repository has it and it holds the path; otherwise the anchor keeps no commit
      let commit = a.commit;
      if (commit && !commitHeld(facts, commit, p)) {
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
      const planned = { ...a, symbol, commit, path: p, observation };
      if (a.symbol && !symbol) fallbacks.add(planned);
      anchors.push(planned);
      const wrong = anchorProblem(facts, {
        path: p,
        symbol,
        role: a.role,
        held: Boolean(commit),
        observed: observation !== null,
      });
      if (wrong) problems.push(`${key}: ${wrong}`);
    }
    // A masked symbol's fallback merges into a path-only anchor like it, in any order: identical rows could not be told apart by replace_anchor
    // Lines as saved (the end never before the start), so a reversed range meets the same place
    const place = (x: (typeof anchors)[number]) =>
      `${x.path}\0${x.role}\0${x.commit}\0${x.lines ? [x.lines[0], Math.max(...x.lines)] : ""}`;
    const covered = new Set(anchors.filter((x) => !x.symbol && !fallbacks.has(x)).map(place));
    for (const x of [...fallbacks]) {
      if (!covered.has(place(x))) {
        covered.add(place(x));
        continue;
      }
      problems.push(`${key}: another path-only anchor on ${x.path} already covers it; left out`);
      anchors.splice(anchors.indexOf(x), 1);
    }
    // The schema keeps one live anchor per place: a symbol, or lines when there is no symbol
    const places = new Set<string>();
    for (const x of [...anchors]) {
      const at = [
        x.path,
        x.role,
        x.commit ?? "",
        x.symbol ?? "",
        x.symbol ? "" : x.lines ? place(x) : "",
      ].join("\0");
      if (!places.has(at)) {
        places.add(at);
        continue;
      }
      problems.push(
        `${key}: the anchor on ${x.path}${x.symbol ? ` ${x.symbol}` : ""} appears twice; left out`,
      );
      anchors.splice(anchors.indexOf(x), 1);
    }

    const aliases = [...new Set(u.aliases.map((a) => a.trim()))];
    // Characters as SQLite counts them; a word read would show changed (control or invisible characters) would not match its index
    const bad = aliases.filter((a) => !a || [...a].length > 40 || inline(a) !== a);
    if (bad.length)
      problems.push(
        `${key}: aliases must be 1 to 40 characters; left out ${bad.map((a) => JSON.stringify(a)).join(", ")}`,
      );

    let supersedes: number | null = null;
    if (u.supersedes) {
      // Which successor takes the place is the judge's to say, after the save writes: see settleSaved
      const old = others.get(u.supersedes);
      if (!old) errors.push(`${key}: supersedes ${u.supersedes}, which is not a record of this project`);
      else if (!["active", "candidate"].includes(old.lifecycle))
        errors.push(`${key}: ${u.supersedes} is already ${old.lifecycle}`);
      else if (!replaceable(u.kind, old.kind))
        errors.push(
          `${key}: a ${u.kind} cannot supersede ${u.supersedes}, a ${old.kind} (a record supersedes one of its own kind; a decision and a constraint can replace each other)`,
        );
      else supersedes = old.id;
    }
    const conflicts = u.conflicts.flatMap((k) => {
      const other = others.get(k);
      if (!other) errors.push(`${key}: conflicts with ${k}, which is not a record of this project`);
      return other ? [other.id] : [];
    });

    for (const x of adoption.filter((x) => x.route === "agent")) {
      const why = await agentRefusal(db, u, x, sources.get(x.source), evidence, anchors);
      if (!why) continue;
      problems.push(`${key}: the AI's adoption in s${x.source} left out, so it stays a candidate: ${why}`);
      adoption.splice(adoption.indexOf(x), 1);
    }

    const fields: Planned["fields"] = [];
    for (const f of u.fields) {
      const at = `${key}: field ${f.name}`;
      const d = defined.get(f.name);
      if (!d) {
        errors.push(`${at}: not a field of this project (define it in field_defs first)`);
        continue;
      }
      if (fields.some((x) => x.name === f.name)) {
        errors.push(`${at}: given twice`);
        continue;
      }
      if (d.kinds.length && !d.kinds.includes(u.kind)) {
        errors.push(`${at}: applies to ${d.kinds.join(", ")}, not ${u.kind}`);
        continue;
      }
      const wrong = fieldTypeError(d.type, d.enum, f.value);
      if (wrong) {
        errors.push(`${at}: ${wrong}`);
        continue;
      }
      const s = sources.get(Number(f.quote.source.slice(1)));
      if (!s) continue;
      cites.add(s.id);
      const span = locate(s.text, f.quote.quote);
      // Refused rather than quarantined: a value nobody said should not be kept, and should not hold back the record either
      if (!span) {
        errors.push(`${at}: quote not found in ${f.quote.source}: "${head(f.quote.quote, 80)}"`);
        continue;
      }
      if (!valueInQuote(d.type, f.value, f.quote.quote)) {
        errors.push(`${at}: the value ${JSON.stringify(f.value)} is not written in the quote as it is`);
        continue;
      }
      fields.push({ name: f.name, value: f.value, source: s.id, start: span[0], end: span[1] });
    }

    units.push({
      input: u,
      key,
      quarantine,
      cites,
      evidence,
      options,
      adoption,
      anchors,
      aliases: aliases.filter((a) => !bad.includes(a)),
      supersedes,
      conflicts,
      fields,
    });
  }
  // Work is the traced session's own state, shown at session start: a harvest or glean cannot set it from text it read
  if (record.work && target.origin !== "trace") errors.push("work: only trace records work");
  return { errors, problems, units, work: record.work ?? null, fieldDefs, facts };
}

/** Why a value does not fit its field's type, or null. The schema's triggers check the same. */
function fieldTypeError(type: FieldType, values: string[] | null, v: string): string | null {
  if (type === "integer" && !/^-?[0-9]+$/.test(v)) return "an integer is an optional minus sign and digits";
  if (type === "date" && !(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v) && isoDate(v)))
    return "a date is a valid YYYY-MM-DD";
  if (type === "enum" && !values?.includes(v)) return `one of ${values?.join(", ")}`;
  return null;
}

const isoDate = (v: string) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

/** Characters a value runs into when it sits inside a longer word or number. Kana and kanji are not among them: Japanese has no spaces. */
const WORD = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{M}\p{N}_]/u;

/**
 * A number written in a quote, whole: a sign, digit grouping (`1,000`), a decimal point, and an exponent belong to it. Nothing starts
 * right after a Latin, Greek, or Cyrillic letter (full width too), a combining mark, a digit, `_`, `.`, a dash, or a plus or minus sign
 * of any width, so `p95`, `β95`, and the `5` of `x-5` or `x−5` are not numbers. Kana and kanji do not stop one, since Japanese puts a
 * particle right before a number.
 */
const NUMBER =
  /(?<![\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{M}\p{N}\p{Pd}_.+\uFF0B\u2212])[+-]?(?:[0-9]{1,3}(?:,[0-9]{3})+(?![0-9])|[0-9]+)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/gu;

/** Whether value occurs in quote with no letter, digit, mark, or `_` right before or after it. */
function standsAlone(quote: string, value: string): boolean {
  for (let at = quote.indexOf(value); at >= 0; at = quote.indexOf(value, at + 1)) {
    const before = [...quote.slice(Math.max(0, at - 2), at)].at(-1) ?? "";
    const after = String.fromCodePoint(quote.codePointAt(at + value.length) ?? 32);
    if (!WORD.test(before) && !WORD.test(after)) return true;
  }
  return false;
}

/**
 * Whether the quote writes the value as it is, so a value can only be one that was said. An integer must be a whole number in the quote,
 * an enum value or a date must stand alone, and text may be any part of the quote.
 */
export function valueInQuote(type: FieldType, value: string, quote: string): boolean {
  if (type === "text") return quote.includes(value);
  if (type !== "integer") return standsAlone(quote, value);
  return [...quote.matchAll(NUMBER)].some((m) => m[0].replace(/^\+/, "").replaceAll(",", "") === value);
}

export type Saved = {
  active: string[];
  candidates: { key: string; why: string }[];
  quarantined: string[];
  superseded: string[];
  /** Anchors judged again under the lock that may point at the wrong place */
  anchorProblems: string[];
  /** The units this save wrote, for a caller that reconciles them with its own changes */
  written: { id: number; key: string; hint: Hint }[];
};

/** CI's definitions, or a directory holding them, in any letter case */
const ciPath = (path: string) => {
  const p = path.toLowerCase().replace(/\/+$/, "");
  return p === ".github" || p === ".github/workflows" || p.startsWith(".github/workflows/");
};

/**
 * Why a quote of the AI's reply cannot adopt for the AI, or null: it must be the AI choosing (decides on the same words), outside a turn
 * that ran a record tool, not about instruction or CI files, and for a "do" on code, after that code changed in the same turn.
 */
async function agentRefusal(
  db: Reads,
  u: UnitInput,
  x: Span,
  s: { external_id: string; session_id: string | null; turn_id: string | null } | undefined,
  evidence: EvidenceSpan[],
  anchors: Planned["anchors"],
): Promise<string | null> {
  if (!s) return "its source is not a reply of this project";
  if (/:ask:.*:q:/.test(s.external_id)) return "a question the AI asked is not its decision";
  if (!s.turn_id)
    return "the reply has no turn, so it cannot be told apart from a turn that ran a record tool";
  if (
    !evidence.some(
      (e) => e.role === "decides" && e.source === x.source && e.start === x.start && e.end === x.end,
    )
  )
    return "quote the same words as decides evidence: the AI choosing, not reporting, proposing, or asking";
  const governs = anchors.filter((a) => a.role === "applies_to").map((a) => a.path);
  // Any anchor counts here, not only where it applies: the record is about that file either way
  const bound = anchors.map((a) => a.path).find((path) => instructionFile(path) || ciPath(path));
  if (bound) return `${bound} holds rules or CI agents follow; only the owner adopts decisions about it`;
  if (
    await db
      .selectFrom("agent_ineligible_source")
      .select("source_id")
      .where("source_id", "=", x.source)
      .executeTakeFirst()
  )
    return "the reply comes from a turn that ran a record tool (or one no call can be placed away from)";
  if (u.stance === "do" && governs.length) {
    const edited =
      s.session_id && s.turn_id
        ? await db
            .selectFrom("edit_observation")
            .select("path")
            .where("session_id", "=", s.session_id)
            .where("turn_id", "=", s.turn_id)
            .where("path", "in", governs)
            .executeTakeFirst()
        : undefined;
    if (!edited) return `the AI did not change ${governs.join(", ")} in the turn it decided it`;
  }
  return null;
}

/** The hash of what a unit says: its text and options. Alias sets are bound to it, so words written for other text are never used. */
const contentHash = (u: UnitInput): Buffer =>
  sha256(
    JSON.stringify([
      u.text,
      u.why ?? null,
      u.scope_note ?? null,
      u.revisit_when ?? null,
      // A condition joins the hash only when there is one, so records without one keep the hash they always had
      u.options.map((o) =>
        o.reconsider_when === undefined
          ? [o.text, o.outcome, o.why ?? null]
          : [o.text, o.outcome, o.why ?? null, o.reconsider_when],
      ),
    ]),
  );

/**
 * Judges what a save wrote, with everything its intents reach, and reports it. A successor this save wrote or adopted that the judge leaves
 * waiting for a place another successor holds is refused by name, so the batch rolls back; one that cannot stand waits as a candidate.
 */
export async function settleSaved(
  trx: Kysely<DB>,
  runId: number,
  saved: Saved,
  more: { seeds?: number[]; withdraw?: Map<number, Hint>; adopted?: Set<number> } = {},
): Promise<Reconciled> {
  const written = new Map(saved.written.map((w) => [w.id, w]));
  const settled = await reconcile(
    trx,
    [...written.keys(), ...(more.seeds ?? [])],
    { runId },
    {
      hints: new Map(saved.written.map((w) => [w.id, w.hint])),
      withdraw: more.withdraw,
    },
  );
  // Only a successor that could stand on its own waits for a held place, so every one of them is a choice the save made that cannot take effect
  const mine = new Set([...written.keys(), ...(more.adopted ?? [])]);
  const key = (id: number) => settled.keys.get(id) ?? `u${id}`;
  for (const [id, [to, holder]] of settled.held)
    if (mine.has(id))
      throw new Error(
        mine.has(holder)
          ? `${key(id)}: another record in this save already supersedes ${key(to)}`
          : `${key(id)}: ${key(to)} already has a successor, ${key(holder)} (in effect); withdraw it first, or supersede it instead`,
      );
  const now = new Map(settled.changes.map((c) => [c.id, c.after]));
  for (const w of saved.written) {
    if (saved.quarantined.some((q) => q.startsWith(`${w.key} (`))) continue;
    if (now.get(w.id) === "active") saved.active.push(w.key);
    else saved.candidates.push({ key: w.key, why: settled.waits.get(w.id) ?? "its support is not complete" });
  }
  for (const c of settled.changes) if (c.after === "superseded") saved.superseded.push(c.key);
  return settled;
}

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
  { settle = true }: { settle?: boolean } = {},
): Promise<Saved> {
  if (checked.errors.length)
    throw new Error(`The record is not valid:\n${checked.errors.map((e) => `  ${e}`).join("\n")}`);
  const now = iso(Date.now());
  const saved: Saved = {
    active: [],
    candidates: [],
    quarantined: [],
    superseded: [],
    anchorProblems: [],
    written: [],
  };
  const cited = new Set<number>();
  for (const d of checked.fieldDefs) {
    cited.add(d.source);
    await trx
      .insertInto("field_def")
      .values({
        project_id: target.projectId,
        name: d.name,
        type: d.type,
        label: d.label,
        description: d.description,
        enum_values: d.enum ? JSON.stringify(d.enum) : null,
        kinds: JSON.stringify(d.kinds),
        source_id: d.source,
        span_start: d.start,
        span_end: d.end,
        run_id: runId,
        added_at: now,
      })
      .execute();
  }
  const fieldIds = new Map(
    (checked.units.some((p) => p.fields.length)
      ? await trx
          .selectFrom("field_def")
          .select(["id", "name"])
          .where("project_id", "=", target.projectId)
          .execute()
      : []
    ).map((d) => [d.name, d.id]),
  );
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
          reconsider_when: o.input.reconsider_when ?? null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await evidence(o.evidence, option.id);
      if (o.reconsider) await evidence([{ ...o.reconsider, role: "reconsiders", reported: null }], option.id);
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
      // The file may have changed since the check: a symbol that is now text Sphica masks is not stored
      refresh(checked.facts, a.path);
      const symbol = a.symbol && !symbolMasked(checked.facts, a.path, a.symbol) ? a.symbol : undefined;
      const wrong = anchorProblem(checked.facts, {
        path: a.path,
        symbol,
        role: a.role,
        held: Boolean(a.commit),
        observed: a.observation !== null,
      });
      if (wrong) saved.anchorProblems.push(`${p.key}: ${wrong}`);
      const at = a.lines ? null : symbol ? symbolAt(checked.facts, a.path, symbol) : null;
      const lines = a.lines ?? (at ? [at.line, at.line] : null);
      await trx
        .insertInto("unit_anchor")
        .values({
          unit_id: id,
          path: a.path,
          symbol: symbol ?? null,
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
    // Values are sealed with the unit, before its first state
    for (const f of p.fields) {
      const field = fieldIds.get(f.name);
      if (field === undefined) throw new Error(`${p.key}: field ${f.name} is not defined`);
      await trx
        .insertInto("unit_field")
        .values({
          unit_id: id,
          field_def_id: field,
          value: f.value,
          source_id: f.source,
          span_start: f.start,
          span_end: f.end,
          run_id: runId,
          added_at: now,
        })
        .execute();
    }
    await firstState(trx, id, `${target.origin} extracted`, runId, now);
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

    if (p.quarantine.length) saved.quarantined.push(`${p.key} (${p.quarantine.join("; ")})`);
    saved.written.push({
      id,
      key: p.key,
      hint: {
        reason: p.adoption.length ? "evidence and adoption found" : "evidence found",
        source: p.adoption[0]?.source ?? p.evidence[0]?.source ?? null,
      },
    });
  }
  if (settle) await settleSaved(trx, runId, saved);
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
  return saved;
}

/**
 * Marks the run saved. Called once, after every write of the save: a saved run changes no more.
 * The clock can step back after begin, so the run finishes no earlier than it started.
 */
export async function finishRun(trx: Kysely<DB>, runId: number): Promise<void> {
  await trx
    .updateTable("extraction_run")
    .set((eb) => ({
      status: "saved",
      finished_at: eb.fn<string>("max", [eb.val(iso(Date.now())), eb.ref("started_at")]),
    }))
    .where("id", "=", runId)
    .execute();
}
