// glean: evidence and corrections added to existing records later, and records written from what the owner points to. Every change cites
// retained text: an owner message, a pull request or issue source, or a file excerpt the CLI reads from git itself. Nothing is rewritten:
// evidence and adoption are added or retracted, anchors are replaced, and a correction is a successor.
import type { Kysely } from "kysely";
import { z } from "zod";
import { iso, type Reads } from "./db.ts";
import type { DB } from "./db-types.ts";
import { cleanGit } from "./git.ts";
import { itemId } from "./github.ts";
import { EVIDENCE_ROLES } from "./knowledge.ts";
import { inline } from "./panel.ts";
import type { Hint } from "./reconcile.ts";
import {
  anchorProblem,
  type Checked,
  checkRecord,
  prepareRecord,
  repoPath,
  saveRecord,
  settleSaved,
  type Target,
} from "./record.ts";
import {
  commitHeld,
  listFilesIfGone,
  type Probe,
  type RepoFacts,
  refresh,
  repoFacts,
  symbolAt,
  symbolMasked,
} from "./repo-facts.ts";
import { bytes, head, mask, privateKeyRanges, quoteSpan, sha256 } from "./text.ts";

/** Files larger than this are not excerpted (a generated file or a data dump is not a statement). */
const MAX_FILE = 1024 * 1024;
const MAINTAINERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const SOURCE_REF = z.string().regex(/^s[1-9][0-9]{0,15}$/, "cite a source ref such as s12");
const unit = z.string().min(1).max(200);
/** The unit's revision as read printed it; a unit changed since is refused */
const revision = z.number().int().positive();
const quote = z.string().min(1).max(4000);
const File = z
  .object({
    path: z.string().min(1).max(500),
    commit: z.string().min(1).max(100).default("HEAD"),
    lines: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  })
  .strict();
const Op = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("add_evidence"),
      unit,
      revision,
      source: SOURCE_REF.optional(),
      file: File.optional(),
      quote,
      // A reconsider quote belongs to an option's condition, which only trace and harvest write; decides pairs with the AI's own
      // adoption, which only a trace adds
      role: z.enum(EVIDENCE_ROLES).exclude(["reconsiders", "decides"]),
      reported_speaker: z.string().trim().min(1).max(100).optional(),
    })
    .strict(),
  z.object({ op: z.literal("adopt"), unit, revision, source: SOURCE_REF, quote }).strict(),
  z
    .object({
      op: z.literal("anchor"),
      unit,
      revision,
      path: z.string().min(1).max(500),
      symbol: z.string().min(1).max(200).optional(),
      role: z.enum(["applies_to", "evidence"]),
      commit: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("replace_anchor"),
      unit,
      revision,
      from: z.object({ path: z.string().min(1), symbol: z.string().min(1).optional() }).strict(),
      to: z
        .object({
          path: z.string().min(1).max(500),
          symbol: z.string().min(1).max(200).optional(),
          role: z.enum(["applies_to", "evidence"]),
        })
        .strict(),
      source: SOURCE_REF,
      quote,
    })
    .strict(),
  z
    .object({
      op: z.literal("retract_evidence"),
      unit,
      revision,
      source: SOURCE_REF,
      // Which piece of evidence from that source, when it holds more than one
      quote: quote.optional(),
      reason_source: SOURCE_REF,
      reason_quote: quote,
    })
    .strict(),
  z
    .object({
      op: z.literal("retract_adoption"),
      unit,
      revision,
      source: SOURCE_REF,
      quote: quote.optional(),
      reason_source: SOURCE_REF,
      reason_quote: quote,
    })
    .strict(),
  z
    .object({ op: z.literal("withdraw"), unit, revision, reason_source: SOURCE_REF, reason_quote: quote })
    .strict(),
  // Search words only, never evidence, so no quote; an empty list clears them
  z
    .object({ op: z.literal("replace_aliases"), unit, revision, aliases: z.array(z.string()).max(12) })
    .strict(),
  // Ends an unresolved conflict between two records; until then automatic delivery holds both back
  z
    .object({
      op: z.literal("resolve_conflict"),
      unit,
      revision,
      with: unit,
      reason_source: SOURCE_REF,
      reason_quote: quote,
    })
    .strict(),
]);
const Glean = z
  .object({ units: z.array(z.unknown()).max(20).default([]), ops: z.array(Op).max(50).default([]) })
  .strict();
type OpInput = z.infer<typeof Op>;

/** A file excerpt read from a commit: the lines asked for, byte for byte (CRLF kept) in raw and masked in text, and where they came from. */
type Excerpt = {
  path: string;
  commit: string;
  blob: string;
  size: number;
  lines: [number, number];
  raw: string;
  text: string;
};

const git = (root: string, args: string[], max = MAX_FILE * 2) => cleanGit(root, args, max);

/** Reads lines of a committed file. Throws with the reason for paths outside the repository, links, submodules, binary, and oversized files. */
function readExcerpt(root: string, file: z.infer<typeof File>): Excerpt {
  const p = repoPath(file.path);
  if (!p) throw new Error(`${JSON.stringify(head(file.path, 80))} is not a path inside the repository`);
  let commit: string;
  try {
    commit = git(root, ["rev-parse", "--verify", "-q", `${file.commit}^{commit}`])
      .toString("utf8")
      .trim();
  } catch {
    throw new Error(`${JSON.stringify(head(file.commit, 40))} is not a commit of this repository`);
  }
  const entry = git(root, ["ls-tree", "-z", commit, "--", p]).toString("utf8").split("\0")[0] ?? "";
  const m = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.*)$/.exec(entry);
  if (!m || m[4] !== p) throw new Error(`${p} is not in commit ${commit.slice(0, 12)}`);
  const [, mode, type, blob = ""] = m;
  if (mode === "120000") throw new Error(`${p} is a symbolic link; cite the file it points to`);
  if (type !== "blob" || !["100644", "100755"].includes(mode ?? ""))
    throw new Error(`${p} is not a regular file (${type})`);
  const size = Number(git(root, ["cat-file", "-s", blob]).toString("utf8").trim());
  if (size > MAX_FILE) throw new Error(`${p} is ${size} bytes, over the ${MAX_FILE}-byte limit`);
  const buf = git(root, ["cat-file", "blob", blob]);
  if (buf.includes(0)) throw new Error(`${p} is binary`);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new Error(`${p} is not UTF-8 text`);
  }
  // Line starts in bytes; a line ends after its \n, so CRLF stays in the excerpt
  const starts = [0];
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a && i + 1 < buf.length) starts.push(i + 1);
  const [a, b] = file.lines;
  if (a > b || b > starts.length)
    throw new Error(`${p} has ${starts.length} lines; lines ${a}-${b} are not in it`);
  const from = starts[a - 1] ?? 0;
  const to = b < starts.length ? (starts[b] ?? buf.length) : buf.length;
  // A cut through a private key leaves BEGIN or END outside the excerpt, where mask() cannot see it
  if (privateKeyRanges(buf.toString("utf8")).some(([s, e]) => s < to && e > from && (s < from || e > to)))
    throw new Error(`${p} lines ${a}-${b} are inside a private key; cite lines outside it`);
  const raw = buf.subarray(from, to).toString("utf8");
  const text = mask(raw);
  // A key name on a line outside the excerpt can mark a value inside it: the text around must not change how the excerpt masks
  const before = buf.subarray(0, from).toString("utf8");
  const after = buf.subarray(to).toString("utf8");
  if (mask(before + raw) !== mask(before) + text || mask(raw + after) !== text + mask(after))
    throw new Error(`${p} lines ${a}-${b} cut through text Sphica masks; cite more lines around it`);
  return { path: p, commit, blob, size, lines: [a, b], raw, text };
}

const locate = (body: string, q: string): [number, number] | null => {
  const at = Buffer.from(body, "utf8").indexOf(Buffer.from(q, "utf8"));
  return at < 0 ? null : [at, at + Buffer.byteLength(q, "utf8")];
};

type Planned = {
  input: OpInput;
  unitId: number;
  lifecycle: string;
  excerpt: Excerpt | null;
  /** The span a retraction removes */
  retracts: [number, number] | null;
  /** The live anchor a replacement retires */
  replaces: number | null;
  /** The alias set a replacement writes, trimmed and without repeats */
  aliases: string[] | null;
};
export type GleanChecked = { errors: string[]; problems: string[]; units: Checked; ops: Planned[] };

/** What glean reads from the working tree and git: the units' anchors, and each cited file excerpt or why it cannot be read. */
export type GleanFacts = RepoFacts & { excerpts: Map<string, Excerpt | Error> };

const excerptKey = (file: z.infer<typeof File>) => JSON.stringify([file.path, file.commit, file.lines]);

function excerptOf(facts: GleanFacts, file: z.infer<typeof File>): Excerpt | Error {
  const key = excerptKey(file);
  let got = facts.excerpts.get(key);
  if (!got) {
    try {
      if (!facts.root) throw new Error("the repository is not known");
      got = readExcerpt(facts.root, file);
    } catch (e) {
      got = e as Error;
    }
    facts.excerpts.set(key, got);
  }
  return got;
}

/**
 * Reads what a glean record needs from the working tree and git, before the caller takes the write lock. A failed read is kept, not
 * thrown: checkGlean reports it only for an operation its database checks reach.
 */
export function prepareGlean(root: string | null, raw: unknown, probe?: Probe): GleanFacts {
  const parsed = Glean.safeParse(raw);
  const facts: GleanFacts = {
    ...(parsed.success ? prepareRecord(root, { units: parsed.data.units }, probe) : repoFacts(root, probe)),
    excerpts: new Map(),
  };
  for (const op of parsed.success ? parsed.data.ops : []) {
    if (op.op === "add_evidence" && op.file && !op.source) excerptOf(facts, op.file);
    const pinned = op.op === "anchor" ? op : op.op === "replace_anchor" ? op.to : null;
    const rel = pinned && repoPath(pinned.path);
    if (rel) listFilesIfGone(facts, rel);
    if (pinned?.symbol && rel && !symbolMasked(facts, rel, pinned.symbol))
      symbolAt(facts, rel, pinned.symbol);
    if (op.op === "anchor" && op.commit && rel) commitHeld(facts, op.commit, rel);
  }
  return facts;
}

/**
 * Checks a glean record. target.sessionId is the owner's current session: units whose only evidence is that session's owner messages,
 * with no adoption, are kept as unsourced (the owner remembering is not a source).
 */
export async function checkGlean(
  db: Reads,
  target: Target,
  raw: unknown,
  facts: GleanFacts = prepareGlean(target.root, raw),
): Promise<GleanChecked> {
  const parsed = Glean.safeParse(raw);
  if (!parsed.success)
    return {
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "record"}: ${i.message}`),
      problems: [],
      units: {
        errors: [],
        problems: [],
        units: [],
        work: null,
        fieldDefs: [],
        facts,
      },
      ops: [],
    };
  const units = await checkRecord(db, target, { units: parsed.data.units }, facts);
  const errors = [...units.errors];
  const problems = [...units.problems];
  if (parsed.data.units.length || units.units.length) {
    const sessionOwner = new Set(
      target.sessionId
        ? (
            await db
              .selectFrom("source")
              .select("id")
              .where("session_id", "=", target.sessionId)
              .where("author_kind", "=", "owner")
              .execute()
          ).map((s) => s.id)
        : [],
    );
    for (const u of units.units)
      if (u.adoption.length === 0 && u.evidence.every((e) => sessionOwner.has(e.source))) {
        u.unsourced = true;
        problems.push(
          `${u.key}: its only evidence is the owner's words in this session; ask the owner for a source (an issue or pull request URL, meeting notes, the file and line) before saving; saved without one it is marked unsourced and never used as fact`,
        );
      }
  }
  const ops: Planned[] = [];
  const source = async (ref: string) =>
    db
      .selectFrom("source")
      .select(["id", "kind", "author_kind", "author_association", "text"])
      .where("project_id", "=", target.projectId)
      .where("id", "=", Number(ref.slice(1)))
      .executeTakeFirst();
  const span = async (ref: string, q: string, what: string) => {
    const s = await source(ref);
    if (!s) {
      errors.push(`${what}: ${ref} is not a source of this project`);
      return null;
    }
    const at = locate(s.text, q);
    if (!at) {
      errors.push(`${what}: quote not found in ${ref}: "${head(q, 80)}"`);
      return null;
    }
    return { s, at };
  };
  // Anchors an operation in this batch replaces, and which operation: a second replacement would leave both new anchors live
  const replaced = new Map<number, number>();
  // Anchors added earlier in this batch, by unit, path, symbol, and role
  const anchored = new Set<string>();
  const places: {
    what: string;
    unit: number;
    rel: string;
    symbol: string | null;
    role: "applies_to" | "evidence";
    commit: string | null;
    name: string;
    /** The operation's index, for a replacement; a plain anchor lands after every replacement of the batch */
    replacing: number | null;
  }[] = [];
  const unsourcedSaid = new Set<number>();
  for (const [i, op] of parsed.data.ops.entries()) {
    const what = `ops.${i} ${op.op} ${op.unit}`;
    const u = await db
      .selectFrom("unit")
      .select(["id", "kind", "lifecycle", "revision", "unsourced"])
      .where("project_id", "=", target.projectId)
      .where("key", "=", op.unit)
      .executeTakeFirst();
    if (!u) {
      errors.push(`${what}: not a record of this project`);
      continue;
    }
    // The flag is frozen with what the record was saved with, so a source found later can only back a successor
    if ((op.op === "add_evidence" || op.op === "adopt") && u.unsourced && !unsourcedSaid.has(u.id)) {
      unsourcedSaid.add(u.id);
      problems.push(
        `${op.unit} is unsourced and cannot become active; adding evidence or adoption does not clear the flag${u.lifecycle === "candidate" ? ". To use this source, save a successor that supersedes it and cites the source" : ""}`,
      );
    }
    if (u.revision !== op.revision) {
      errors.push(
        `${what}: changed since you read it (revision ${op.revision}, now ${u.revision}); read it again`,
      );
      continue;
    }
    let excerpt: Excerpt | null = null;
    if (op.op === "add_evidence") {
      if (!op.source === !op.file) errors.push(`${what}: cite either a source or a file`);
      else if (op.file) {
        try {
          const read = excerptOf(facts, op.file);
          if (read instanceof Error) throw read;
          excerpt = read;
          if ((await forgottenExcerpt(db, target.projectId, excerpt)).same)
            errors.push(
              `${what}: the owner forgot ${excerpt.path} lines ${op.file.lines.join("-")}; cite something else`,
            );
          else if (!locate(excerpt.raw, op.quote))
            errors.push(`${what}: quote not found in ${excerpt.path} lines ${op.file.lines.join("-")}`);
          else if (!quoteSpan(excerpt.raw, excerpt.text, op.quote))
            errors.push(
              `${what}: the quote also appears in text Sphica masks; quote a longer or different part`,
            );
        } catch (e) {
          errors.push(`${what}: ${(e as Error).message}`);
        }
      } else if (op.source) {
        const got = await span(op.source, op.quote, what);
        if (
          got &&
          op.reported_speaker &&
          !(got.s.kind === "session_message" && got.s.author_kind === "owner")
        )
          errors.push(
            `${what}: reported_speaker is for the owner reporting someone else, so it must cite an owner message`,
          );
      }
    }
    if (op.op === "adopt") {
      if (!["decision", "constraint"].includes(u.kind))
        errors.push(`${what}: adoption applies to decisions and constraints`);
      const got = await span(op.source, op.quote, what);
      if (got && got.s.kind === "pr_event") errors.push(`${what}: the merge does not adopt a proposal`);
      else if (got && got.s.author_kind !== "owner" && !MAINTAINERS.has(got.s.author_association ?? ""))
        errors.push(`${what}: only the owner or a maintainer can adopt`);
    }
    if (op.op === "anchor" && !repoPath(op.path))
      errors.push(`${what}: the path is not inside the repository`);
    const pinned = op.op === "anchor" ? op : op.op === "replace_anchor" ? op.to : null;
    const pinnedPath = pinned && repoPath(pinned.path);
    if (pinned?.symbol && pinnedPath && symbolMasked(facts, pinnedPath, pinned.symbol))
      errors.push(`${what}: the symbol is text Sphica masks; anchor a name, not a key`);
    if (op.op === "anchor" && op.commit) {
      const rel = repoPath(op.path);
      if (rel && !commitHeld(facts, op.commit, rel))
        errors.push(`${what}: commit ${op.commit.slice(0, 12)} does not hold ${rel} in the repository`);
    }
    // A replacement retires exactly the one live anchor its from names
    let replaces: number | null = null;
    if (op.op === "replace_anchor") {
      if (!repoPath(op.to.path)) errors.push(`${what}: the path is not inside the repository`);
      // Moving a location redirects where the record is delivered, so third-party text cannot do it
      const said = await span(op.source, op.quote, what);
      if (said && said.s.author_kind !== "owner")
        errors.push(`${what}: only the owner's words can move an anchor`);
      const from = repoPath(op.from.path);
      if (!from) errors.push(`${what}: the from path is not inside the repository`);
      else {
        let q = db
          .selectFrom("unit_anchor")
          .select(["id", "path", "symbol", "role", "commit_sha"])
          .where("unit_id", "=", u.id)
          .where("path", "=", from)
          .where("retired_at", "is", null);
        if (op.from.symbol) q = q.where("symbol", "=", op.from.symbol);
        const live = await q.execute();
        const name = `${from}${op.from.symbol ? ` ${op.from.symbol}` : ""}`;
        if (live.length === 1) {
          replaces = live[0]?.id ?? null;
          // Two live anchors on one place cannot both exist, and replacing a place with itself moves nothing
          const held = live[0];
          if (
            held &&
            held.commit_sha === null &&
            held.path === repoPath(op.to.path) &&
            held.symbol === (op.to.symbol ?? null) &&
            held.role === op.to.role
          )
            errors.push(`${what}: the anchor on ${name} is already that place`);
          if (replaces !== null && replaced.has(replaces))
            errors.push(`${what}: another operation in this batch already replaces ${name}`);
          if (replaces !== null) replaced.set(replaces, i);
        } else if (!live.length) errors.push(`${what}: no live anchor on ${name}`);
        else errors.push(`${what}: ${live.length} live anchors on ${name}; give from.symbol`);
      }
    }
    // A second live anchor on the same place (and commit) could not be told apart from the first by replace_anchor
    const dest = op.op === "anchor" ? op : op.op === "replace_anchor" ? op.to : null;
    const rel = dest ? repoPath(dest.path) : null;
    if (dest && rel) {
      const commit = op.op === "anchor" ? (op.commit ?? null) : null;
      const name = `${rel}${dest.symbol ? ` ${dest.symbol}` : ""}`;
      const k = [u.id, rel, dest.symbol ?? "", dest.role, commit ?? ""].join("\0");
      if (anchored.has(k)) errors.push(`${what}: another operation in this batch already anchors ${name}`);
      anchored.add(k);
      const held = commit !== null && commitHeld(facts, commit, rel);
      const observed =
        dest.role === "evidence" && !held && target.sessionId
          ? (await db
              .selectFrom("edit_observation")
              .select("id")
              .where("session_id", "=", target.sessionId)
              .where("path", "=", rel)
              .executeTakeFirst()) !== undefined
          : false;
      const wrong = anchorProblem(facts, {
        path: rel,
        symbol: dest.symbol && !symbolMasked(facts, rel, dest.symbol) ? dest.symbol : null,
        role: dest.role,
        held,
        observed,
      });
      if (wrong) problems.push(`${what}: ${wrong}`);
      places.push({
        what,
        unit: u.id,
        rel,
        symbol: dest.symbol ?? null,
        role: dest.role,
        commit,
        name,
        replacing: op.op === "replace_anchor" ? i : null,
      });
    }
    if (
      op.op === "retract_evidence" ||
      op.op === "retract_adoption" ||
      op.op === "withdraw" ||
      op.op === "resolve_conflict"
    ) {
      const got = await span(op.reason_source, op.reason_quote, what);
      if (got && got.s.author_kind !== "owner")
        errors.push(`${what}: only the owner's words can retract, withdraw, or resolve`);
    }
    // A superseded record is no longer the live answer: only its successors' withdrawal brings it back, and nothing else moves it
    if (op.op === "withdraw") {
      if (u.lifecycle === "superseded")
        errors.push(
          `${what}: ${op.unit} is superseded, so there is nothing live to withdraw (withdraw the record that replaced it, if that one no longer holds)`,
        );
    }
    if (op.op === "resolve_conflict") {
      const open = await db
        .selectFrom("unit_link as l")
        .innerJoin("unit as a", "a.id", "l.from_unit")
        .innerJoin("unit as b", "b.id", "l.to_unit")
        .select("l.from_unit")
        .where("l.kind", "=", "conflicts")
        .where("l.resolved_at", "is", null)
        .where((eb) =>
          eb.or([
            eb.and([eb("a.id", "=", u.id), eb("b.key", "=", op.with)]),
            eb.and([eb("b.id", "=", u.id), eb("a.key", "=", op.with)]),
          ]),
        )
        .where("a.project_id", "=", target.projectId)
        .executeTakeFirst();
      if (!open) errors.push(`${what}: no unresolved conflict between ${op.unit} and ${op.with}`);
    }
    // A retraction names one span: the only live one from that source, or the one its quote cuts
    let retracts: [number, number] | null = null;
    if (op.op === "retract_evidence" || op.op === "retract_adoption") {
      const noun = op.op === "retract_evidence" ? "evidence" : "adoption";
      const live = await db
        .selectFrom(op.op === "retract_evidence" ? "unit_evidence" : "unit_adoption")
        .select(["span_start", "span_end"])
        .where("unit_id", "=", u.id)
        .where("source_id", "=", Number(op.source.slice(1)))
        .where("retracted_at", "is", null)
        .execute();
      const spans = [...new Map(live.map((l) => [`${l.span_start}:${l.span_end}`, l])).values()];
      if (op.quote !== undefined) {
        const got = await span(op.source, op.quote, what);
        const hit = got && spans.find((l) => l.span_start === got.at[0] && l.span_end === got.at[1]);
        if (hit) retracts = [hit.span_start, hit.span_end];
        else if (got) errors.push(`${what}: no live ${noun} of ${op.source} quotes that`);
      } else if (spans.length > 1)
        errors.push(`${what}: ${spans.length} pieces of ${noun} cite ${op.source}; add quote to say which`);
      else if (spans[0]) retracts = [spans[0].span_start, spans[0].span_end];
      else errors.push(`${what}: no live ${noun} cites ${op.source}`);
    }
    let aliases: string[] | null = null;
    if (op.op === "replace_aliases") {
      aliases = [...new Set(op.aliases.map((a) => a.trim()))];
      // Unlike trace, nothing is left out: dropping a bad word would write a smaller set than asked, or clear them all
      const bad = aliases.filter((a) => !a || [...a].length > 40 || inline(a) !== a);
      if (bad.length)
        errors.push(
          `${what}: aliases must be 1 to 40 characters; ${bad.map((a) => JSON.stringify(inline(head(a, 60)))).join(", ")}`,
        );
    }
    ops.push({ input: op, unitId: u.id, lifecycle: u.lifecycle, excerpt, retracts, replaces, aliases });
  }
  // Checked after every op is read. Replacements run first, in their order, each placing its new anchor before retiring the old one, and
  // plain anchors after them: an anchor retired by then no longer counts as live
  for (const x of places) {
    const gone = [...replaced].filter(([, by]) => x.replacing === null || by < x.replacing).map(([id]) => id);
    let q = db
      .selectFrom("unit_anchor")
      .select("id")
      .where("unit_id", "=", x.unit)
      .where("path", "=", x.rel)
      .where("role", "=", x.role)
      .where("retired_at", "is", null)
      .where("id", "not in", [...gone, -1]);
    q = x.symbol ? q.where("symbol", "=", x.symbol) : q.where("symbol", "is", null);
    q = x.commit ? q.where("commit_sha", "=", x.commit) : q.where("commit_sha", "is", null);
    const held = await q.executeTakeFirst();
    // A replacement onto its own place is refused above
    if (!held || (x.replacing !== null && replaced.get(held.id) === x.replacing)) continue;
    errors.push(
      replaced.has(held.id)
        ? `${x.what}: a later operation of this batch moves the anchor off ${x.name}; put that replacement before this one, or make the moves in two saves`
        : `${x.what}: the record already has a live anchor on ${x.name}`,
    );
  }
  return { errors, problems, units, ops };
}

/**
 * What the owner forgot of this excerpt (same file, blob, and lines): whether its masked text is among it, which is never stored again,
 * and the last forgotten revision, which new text numbers after.
 */
async function forgottenExcerpt(
  db: Reads,
  projectId: number,
  x: Excerpt,
): Promise<{ same: boolean; last: number }> {
  const rows = await db
    .selectFrom("source_forgotten")
    .select(["revision", "content_hash"])
    .where("project_id", "=", projectId)
    .where("kind", "=", "file_excerpt")
    .where("external_id", "=", `file:${x.path}@${x.blob}#L${x.lines[0]}-${x.lines[1]}`)
    .execute();
  const hash = sha256(x.text);
  return {
    same: rows.some((r) => Buffer.from(r.content_hash).equals(hash)),
    last: Math.max(0, ...rows.map((r) => r.revision)),
  };
}

/**
 * Stores a file excerpt as a source (once per blob, lines, and masked text) and returns its id. An excerpt stored unmasked by an older
 * version is kept as it was and a masked revision is added, since evidence spans are offsets into the text they were taken from.
 */
async function excerptSource(trx: Kysely<DB>, projectId: number, x: Excerpt): Promise<number> {
  const external = `file:${x.path}@${x.blob}#L${x.lines[0]}-${x.lines[1]}`;
  const hash = sha256(x.text);
  const found = await trx
    .selectFrom("source")
    .select(["id", "revision", "content_hash"])
    .where("project_id", "=", projectId)
    .where("kind", "=", "file_excerpt")
    .where("external_id", "=", external)
    .where("session_id", "is", null)
    .orderBy("revision", "desc")
    .executeTakeFirst();
  const forgotten = await forgottenExcerpt(trx, projectId, x);
  // A revision older than a forgotten one is not the current text, even when the same words come back
  if (found && found.revision > forgotten.last && found.content_hash.equals(hash)) return found.id;
  if (forgotten.same)
    throw new Error(`the owner forgot ${x.path} lines ${x.lines.join("-")}; cite something else`);
  const now = iso(Date.now());
  const revision = Math.max(found?.revision ?? 0, forgotten.last) + 1;
  await trx
    .insertInto("ingest_source")
    .values({
      project_id: projectId,
      kind: "file_excerpt",
      artifact: `file:${x.path}`,
      external_id: external,
      revision,
      author_kind: "person",
      created_at: now,
      captured_at: now,
      text: x.text,
      truncated: bytes(x.raw) !== x.size ? 1 : 0,
      redacted: x.text !== x.raw ? 1 : 0,
      original_bytes: x.size,
      content_hash: hash,
      path: x.path,
      line_start: x.lines[0],
      line_end: x.lines[1],
      commit_sha: x.commit,
      blob_sha: x.blob,
      indexed: 1,
    })
    .execute();
  return itemId(trx, projectId, "file_excerpt", external, revision);
}

export type GleanSaved = { units: Awaited<ReturnType<typeof saveRecord>>; changed: string[] };

export async function saveGlean(
  trx: Kysely<DB>,
  target: Target,
  runId: number,
  c: GleanChecked,
): Promise<GleanSaved> {
  if (c.errors.length)
    throw new Error(`The record is not valid:\n${c.errors.map((e) => `  ${e}`).join("\n")}`);
  const units = await saveRecord(trx, target, runId, c.units, [], { settle: false });
  const now = iso(Date.now());
  const changed: string[] = [];
  const spanOf = async (ref: string, q: string) => {
    const s = await trx
      .selectFrom("source")
      .select(["id", "text"])
      .where("id", "=", Number(ref.slice(1)))
      .executeTakeFirstOrThrow();
    const at = locate(s.text, q) ?? [0, 0];
    return { id: s.id, start: at[0], end: at[1] };
  };
  const touched = new Map<number, string>();
  const withdraw = new Map<number, Hint>();
  // Units the owner adopts in this batch
  const adopted = new Set<number>();
  // Replacements retire before new anchors land, so a batch that anchors a place another op moves off never holds two live anchors on it
  const ordered = [
    ...c.ops.filter((p) => p.input.op === "replace_anchor"),
    ...c.ops.filter((p) => p.input.op !== "replace_anchor"),
  ];
  for (const p of ordered) {
    const op = p.input;
    touched.set(p.unitId, op.unit);
    if (op.op === "add_evidence") {
      const s = p.excerpt
        ? { id: await excerptSource(trx, target.projectId, p.excerpt), text: p.excerpt.text }
        : await trx
            .selectFrom("source")
            .select(["id", "text"])
            .where("id", "=", Number(op.source?.slice(1)))
            .executeTakeFirstOrThrow();
      const at = (p.excerpt ? quoteSpan(p.excerpt.raw, s.text, op.quote) : locate(s.text, op.quote)) ?? [
        0, 0,
      ];
      await trx
        .insertInto("unit_evidence")
        .values({
          unit_id: p.unitId,
          source_id: s.id,
          span_start: at[0],
          span_end: at[1],
          role: op.role,
          reported_speaker: op.reported_speaker ?? null,
          run_id: runId,
          added_at: now,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
      changed.push(`${op.unit}: evidence added`);
    } else if (op.op === "adopt") {
      const s = await spanOf(op.source, op.quote);
      const author = await trx
        .selectFrom("source")
        .select("author_kind")
        .where("id", "=", s.id)
        .executeTakeFirstOrThrow();
      await trx
        .insertInto("unit_adoption")
        .values({
          unit_id: p.unitId,
          route: author.author_kind === "owner" ? "owner_statement" : "explicit",
          source_id: s.id,
          span_start: s.start,
          span_end: s.end,
          run_id: runId,
          added_at: now,
        })
        .onConflict((oc) => oc.doNothing())
        .execute();
      adopted.add(p.unitId);
      changed.push(`${op.unit}: adopted`);
    } else if (op.op === "anchor" || op.op === "replace_anchor") {
      const to = op.op === "anchor" ? op : op.to;
      const rel = repoPath(to.path) ?? to.path;
      // The file may have changed since the check: a symbol that is now text Sphica masks is not stored
      refresh(c.units.facts, rel);
      const symbol = to.symbol && !symbolMasked(c.units.facts, rel, to.symbol) ? to.symbol : null;
      const held = op.op === "anchor" && op.commit !== undefined;
      const observed =
        to.role === "evidence" && !held && target.sessionId
          ? (await trx
              .selectFrom("edit_observation")
              .select("id")
              .where("session_id", "=", target.sessionId)
              .where("path", "=", rel)
              .executeTakeFirst()) !== undefined
          : false;
      const wrong = anchorProblem(c.units.facts, { path: rel, symbol, role: to.role, held, observed });
      if (wrong) units.anchorProblems.push(`${op.unit}: ${wrong}`);
      const at = symbol ? symbolAt(c.units.facts, rel, symbol) : null;
      const added = await trx
        .insertInto("unit_anchor")
        .values({
          unit_id: p.unitId,
          path: rel,
          symbol,
          commit_sha: op.op === "anchor" ? (op.commit ?? null) : null,
          line_start: at?.line ?? null,
          line_end: at?.line ?? null,
          excerpt: at?.excerpt ?? null,
          role: to.role,
          run_id: runId,
          added_at: now,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      if (op.op === "replace_anchor")
        await trx
          .updateTable("unit_anchor")
          .set({ retired_at: now, replaced_by: added.id })
          .where("id", "=", p.replaces ?? -1)
          .where("retired_at", "is", null)
          .execute();
      changed.push(`${op.unit}: anchor ${op.op === "anchor" ? "added" : "replaced"}`);
    } else if (op.op === "replace_aliases") {
      const { content_hash } = await trx
        .selectFrom("unit")
        .select("content_hash")
        .where("id", "=", p.unitId)
        .executeTakeFirstOrThrow();
      await trx
        .insertInto("unit_alias")
        .values({
          unit_id: p.unitId,
          terms: JSON.stringify(p.aliases ?? []),
          content_hash,
          run_id: runId,
          added_at: now,
        })
        .execute();
      changed.push(`${op.unit}: aliases ${p.aliases?.length ? "replaced" : "cleared"}`);
    } else {
      const reason = await spanOf(op.reason_source, op.reason_quote);
      const retraction = {
        retracted_at: now,
        retraction_reason: op.reason_quote,
        retraction_source_id: reason.id,
        retraction_span_start: reason.start,
        retraction_span_end: reason.end,
      };
      if (op.op === "resolve_conflict") {
        const other = await trx
          .selectFrom("unit")
          .select("id")
          .where("project_id", "=", target.projectId)
          .where("key", "=", op.with)
          .executeTakeFirstOrThrow();
        await trx
          .updateTable("unit_link")
          .set({ resolved_at: now, resolution: `${head(op.reason_quote, 400)} (s${reason.id})` })
          .where("kind", "=", "conflicts")
          .where("resolved_at", "is", null)
          .where((eb) =>
            eb.or([
              eb.and([eb("from_unit", "=", p.unitId), eb("to_unit", "=", other.id)]),
              eb.and([eb("from_unit", "=", other.id), eb("to_unit", "=", p.unitId)]),
            ]),
          )
          .execute();
        changed.push(`${op.unit}: conflict with ${op.with} resolved`);
        continue;
      }
      if (op.op === "withdraw") {
        // Written by reconcile with the batch's other changes: one a record of this save replaces needs no withdrawal
        withdraw.set(p.unitId, { reason: `withdrawn: ${head(op.reason_quote, 200)}`, source: reason.id });
        continue;
      }
      const table = op.op === "retract_evidence" ? "unit_evidence" : "unit_adoption";
      // Every citation of the retracted words goes, the record's and its options'; the reply says how many
      const done = await trx
        .updateTable(table)
        .set(retraction)
        .where("unit_id", "=", p.unitId)
        .where("source_id", "=", Number(op.source.slice(1)))
        .where("span_start", "=", p.retracts?.[0] ?? -1)
        .where("span_end", "=", p.retracts?.[1] ?? -1)
        .where("retracted_at", "is", null)
        .executeTakeFirst();
      const n = Number(done.numUpdatedRows);
      changed.push(
        `${op.unit}: ${op.op === "retract_evidence" ? "evidence" : "adoption"} retracted${n > 1 ? ` (${n} citations of those words: the record's and its options')` : ""}`,
      );
    }
  }
  // Judged once, with the records this save wrote and everything their replacements reach, from the facts as the whole batch left them
  const settled = await settleSaved(trx, runId, units, {
    seeds: [...touched.keys(), ...withdraw.keys()],
    withdraw,
  });
  for (const id of settled.redundant)
    changed.push(`${settled.keys.get(id)}: superseded by a record of this save, so not withdrawn`);
  // An owner's adoption added here into a place another successor holds is refused by name, as a save with it would be
  // As do new records of this save the owner adopted: check sees each alone, judging sees them race
  for (const w of units.written) if (w.adopted) adopted.add(w.id);
  for (const [id, [to, holder]] of settled.held)
    if (adopted.has(id))
      throw new Error(
        `${settled.keys.get(id)}: ${settled.keys.get(to)} already has a successor, ${settled.keys.get(holder)} (in effect); withdraw it first, or supersede it instead`,
      );
  const written = new Set(units.written.map((w) => w.id));
  for (const ch of settled.changes) {
    if (written.has(ch.id)) continue;
    if (ch.before === "superseded") changed.push(`${ch.key}: no longer superseded`);
    if (ch.after === "candidate") {
      if (ch.before !== "superseded")
        changed.push(`${ch.key}: candidate (${settled.waits.get(ch.id) ?? "its support is not complete"})`);
    } else changed.push(`${ch.key}: ${ch.after}`);
  }
  for (const [id, key] of touched)
    if (
      !written.has(id) &&
      !settled.changes.some((ch) => ch.id === id) &&
      settled.waits.has(id) &&
      !withdraw.has(id)
    )
      changed.push(`${key}: candidate (${settled.waits.get(id)})`);
  return { units, changed };
}
