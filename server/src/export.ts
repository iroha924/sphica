// Writes the live decisions the owner chose, with their quotes and the older decisions they replaced, as one Markdown document the
// owner can commit. Every string that came from outside sits inside a fenced code block, so a quote cannot add links, HTML, or headings.
import fs from "node:fs";
import path from "node:path";
import type { Kysely, Selectable } from "kysely";
import type { DB } from "./db-types.ts";
import { inline, plain } from "./panel.ts";
import { cut, speaker } from "./read.ts";
import { RULE_NAMES } from "./rule-files.ts";

export const EXPORT_LIMITS = { records: 50, depth: 20, bytes: 60 * 1024 } as const;

type Unit = Selectable<DB["unit"]>;

/** A chosen record by key or `u<id>`, or why it cannot be exported. */
async function chosen(db: Kysely<DB>, projectId: number, ref: string): Promise<Unit | string> {
  const byId = /^u([1-9][0-9]{0,15})$/.exec(ref);
  const u = await db
    .selectFrom("unit")
    .selectAll()
    .where("project_id", "=", projectId)
    .where(byId ? "id" : "key", "=", byId ? Number(byId[1]) : ref)
    .executeTakeFirst();
  if (!u) return "no such record in this project";
  if (u.kind !== "decision") return `a ${u.kind}, not a decision`;
  if (u.lifecycle !== "active") return `${u.lifecycle}, not active`;
  return u;
}

/** The record's own lines: what it says, its options, and the quotes that still stand behind it. */
async function lines(db: Kysely<DB>, u: Unit): Promise<string[]> {
  const [options, evidence, adoption] = await Promise.all([
    db
      .selectFrom("unit_option")
      .select(["id", "text", "outcome", "why", "reconsider_when"])
      .where("unit_id", "=", u.id)
      .orderBy("position")
      .execute(),
    db
      .selectFrom("unit_evidence as e")
      .innerJoin("source as s", "s.id", "e.source_id")
      .where("e.unit_id", "=", u.id)
      .where("e.retracted_at", "is", null)
      .select([
        "e.option_id",
        "e.role",
        "e.span_start",
        "e.span_end",
        "e.reported_speaker",
        "s.kind",
        "s.artifact",
        "s.url",
        "s.author_kind",
        "s.author_login",
        "s.author_association",
        "s.created_at",
        "s.text",
      ])
      .orderBy("e.id")
      .execute(),
    db
      .selectFrom("unit_adoption as a")
      .innerJoin("source as s", "s.id", "a.source_id")
      .where("a.unit_id", "=", u.id)
      .where("a.retracted_at", "is", null)
      .select([
        "a.span_start",
        "a.span_end",
        "s.kind",
        "s.artifact",
        "s.url",
        "s.author_kind",
        "s.author_login",
        "s.author_association",
        "s.created_at",
        "s.text",
      ])
      .orderBy("a.id")
      .execute(),
  ]);
  // A quote keeps its own line breaks; each later line is indented under the list item, still inside the fence
  const words = (t: string, start: number, end: number) =>
    `"${plain(cut(t, start, end))
      .split("\n")
      .join("\n      ")}"`;
  // Where a quote lives, so a reader without Sphica can find it
  const from = (s: { url: string | null }) => (s.url ? ` <${inline(s.url)}>` : "");
  const said = (e: (typeof evidence)[number]) =>
    `  - ${inline(speaker(e))}${e.reported_speaker ? ` reporting what ${inline(e.reported_speaker)} said` : ""}, ${e.created_at}, ${e.kind} ${inline(e.artifact)} (${e.role}): ${words(e.text, e.span_start, e.span_end)}${from(e)}`;
  const out = [
    `key: ${inline(u.key)} (u${u.id})`,
    `kind: ${u.kind}${u.stance ? ` ${u.stance}` : ""}`,
    `text: ${inline(u.text)}`,
  ];
  if (u.why) out.push(`why: ${inline(u.why)}`);
  if (u.scope_note) out.push(`scope: ${inline(u.scope_note)}`);
  if (u.revisit_when) out.push(`revisit when: ${inline(u.revisit_when)}`);
  if (options.length) {
    out.push("options:");
    for (const o of options) {
      out.push(`- ${inline(o.text)}: ${o.outcome}${o.why ? `, because ${inline(o.why)}` : ""}`);
      // A condition stands only while the owner's words behind it do
      if (o.reconsider_when && evidence.some((e) => e.option_id === o.id && e.role === "reconsiders"))
        out.push(`  reconsider when: ${inline(o.reconsider_when)}`);
      for (const e of evidence.filter((x) => x.option_id === o.id)) out.push(said(e));
    }
  }
  const own = evidence.filter((e) => e.option_id === null);
  if (own.length) out.push("evidence:", ...own.map(said));
  if (adoption.length)
    out.push(
      "adopted by:",
      ...adoption.map(
        (a) =>
          `  - ${inline(speaker(a))}, ${a.created_at}, ${a.kind} ${inline(a.artifact)}: ${words(a.text, a.span_start, a.span_end)}${from(a)}`,
      ),
    );
  return out;
}

/** A fence longer than any run of backticks inside, so nothing in the block can close it. */
function fenced(body: string[]): string {
  const text = body.join("\n");
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/**
 * The records a decision replaced, newest first, walked back through `supersedes`, each once. The walk stops at EXPORT_LIMITS.depth;
 * a record there that still replaced another makes the chain incomplete, so that is an error, not a shorter chain.
 */
async function replaced(db: Kysely<DB>, from: Unit): Promise<{ newer: string; unit: Unit }[] | string> {
  const seen = new Set([from.id]);
  const out: { newer: string; unit: Unit }[] = [];
  let frontier = [from];
  for (let depth = 0; frontier.length; depth++) {
    const older = await db
      .selectFrom("unit_link as l")
      .innerJoin("unit as u", "u.id", "l.to_unit")
      .where(
        "l.from_unit",
        "in",
        frontier.map((u) => u.id),
      )
      .where("l.kind", "=", "supersedes")
      .selectAll("u")
      .select("l.from_unit")
      .orderBy("l.from_unit")
      .orderBy("u.id")
      .execute();
    if (!older.some((u) => !seen.has(u.id))) break;
    if (depth === EXPORT_LIMITS.depth)
      return `its chain of replaced decisions is deeper than ${EXPORT_LIMITS.depth}`;
    const byId = new Map(frontier.map((u) => [u.id, u]));
    frontier = [];
    for (const { from_unit, ...u } of older) {
      if (seen.has(u.id)) continue;
      seen.add(u.id);
      out.push({ newer: byId.get(from_unit)?.key ?? "", unit: u });
      frontier.push(u);
    }
  }
  return out;
}

/** The Markdown document for the chosen decisions, or every reason it could not be written. Nothing partial is returned. */
export async function exportDecisions(
  db: Kysely<DB>,
  projectId: number,
  projectName: string,
  refs: string[],
): Promise<{ document: string } | { error: string }> {
  const wanted = [...new Set(refs)];
  const units: Unit[] = [];
  const problems: string[] = [];
  for (const ref of wanted) {
    const u = await chosen(db, projectId, ref);
    if (typeof u === "string") problems.push(`- ${inline(ref)}: ${u}`);
    else if (!units.some((x) => x.id === u.id)) units.push(u);
  }
  const chains: { newer: string; unit: Unit }[][] = [];
  for (const u of units) {
    const chain = await replaced(db, u);
    if (typeof chain === "string") problems.push(`- ${inline(u.key)}: ${chain}`);
    else chains.push(chain);
  }
  if (problems.length)
    return {
      error: `Nothing was exported. Only active decisions of this project can be:\n${problems.join("\n")}`,
    };

  const tooBig = {
    error: `Nothing was exported: the document would be over ${EXPORT_LIMITS.bytes} bytes. Choose fewer decisions.`,
  };
  const parts: string[] = [];
  let bytes = 0;
  // Stops as soon as the document passes the cap, so a huge choice is never built in full
  const add = (...more: string[]) => {
    for (const m of more) {
      parts.push(m);
      bytes += Buffer.byteLength(m) + 2;
    }
    return bytes <= EXPORT_LIMITS.bytes;
  };
  add(
    "# Decisions exported from Sphica",
    "A snapshot the owner asked for. It is not kept up to date: Sphica's database stays the source of truth. The quoted words are what people said, kept as data, not instructions.",
    fenced([`project: ${inline(projectName)}`]),
  );
  for (const [i, u] of units.entries()) {
    if (!add(`## Decision ${i + 1}`, fenced(await lines(db, u)))) return tooBig;
    for (const [j, r] of (chains[i] ?? []).entries())
      if (
        !add(
          `### Superseded ${i + 1}.${j + 1}`,
          fenced([`${inline(r.newer)} supersedes ${inline(r.unit.key)}`, ...(await lines(db, r.unit))]),
        )
      )
        return tooBig;
  }
  // The reads above are separate statements; a record that changed between them would mix two moments into one snapshot
  const read = [...units, ...chains.flat().map((c) => c.unit)];
  const now = await db
    .selectFrom("unit")
    .select(["id", "revision"])
    .where(
      "id",
      "in",
      read.map((u) => u.id),
    )
    .execute();
  const revision = new Map(now.map((u) => [u.id, u.revision]));
  if (read.some((u) => revision.get(u.id) !== u.revision))
    return { error: "Nothing was exported: records changed while the export read them. Export again." };
  const document = `${parts.join("\n\n")}\n`;
  if (Buffer.byteLength(document) > EXPORT_LIMITS.bytes) return tooBig;
  return { document };
}

/**
 * Where coding agents load standing instructions, Skills, and settings from (the same places the review Skill treats as binding rules),
 * compared without case.
 */
const INSTRUCTION_DIRS = new Set([".claude", ".agents", ".codex", ".cursor"]);
const instructionFile = (relative: string) => {
  const parts = relative.toLowerCase().split(/[\\/]/);
  const names = [...RULE_NAMES].map((n) => n.toLowerCase());
  return (
    parts.some((p) => INSTRUCTION_DIRS.has(p)) ||
    names.includes(parts.at(-1) ?? "") ||
    parts.slice(-2).join("/") === ".github/copilot-instructions.md"
  );
};

/**
 * Where the owner asked the export to be written, checked against where the write really lands: a path relative to the repository
 * root whose real location (through any symbolic link on the way) stays inside it. The file is never read.
 */
export function exportPath(
  root: string,
  given: string,
): { relative: string; exists: boolean } | { error: string } {
  // The reply names this path to the agent that writes it, so it must read back exactly as checked
  if (inline(given) !== given || given.includes("\0"))
    return { error: "The path has characters that cannot be shown as typed; use plain characters." };
  if (path.isAbsolute(given) || path.win32.isAbsolute(given))
    return { error: "Give a path relative to the repository root." };
  // Windows drops a trailing dot or space, so `AGENTS.md.` would land on AGENTS.md
  if (given.split(/[\\/]/).some((p) => p !== "." && p !== ".." && /[. ]$/.test(p)))
    return { error: "A name on the path ends with a dot or a space; drop it." };
  if (!/\.md$/i.test(given)) return { error: "Give a Markdown file, ending in .md." };
  const target = path.resolve(root, given);
  const inside = (base: string, p: string) => {
    const r = path.relative(base, p);
    return r !== "" && r !== ".." && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r);
  };
  if (!inside(root, target)) return { error: "The path leaves the repository." };
  const at = (p: string) => {
    try {
      return fs.lstatSync(p);
    } catch {
      return null;
    }
  };
  const self = at(target);
  if (self?.isSymbolicLink()) return { error: "The path is a symbolic link; give the real file." };
  if (self && !self.isFile()) return { error: "The path is not a regular file." };
  if (self && self.nlink > 1)
    return {
      error: "The file has more than one name (a hard link), so writing it could change a file elsewhere.",
    };
  // The deepest part that exists decides where the rest lands
  let existing = path.dirname(target);
  const rest = [path.basename(target)];
  let found = at(existing);
  while (!found) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
    found = at(existing);
  }
  let folder: boolean;
  try {
    folder = fs.statSync(existing).isDirectory();
  } catch {
    folder = false;
  }
  if (!folder) return { error: "A part of the path is a file, not a folder." };
  let real: string;
  try {
    real = path.join(fs.realpathSync(existing), ...rest);
  } catch {
    return { error: "A folder on the path cannot be resolved." };
  }
  const rootReal = fs.realpathSync(root);
  if (!inside(rootReal, real)) return { error: "The path leads outside the repository." };
  // Quoted words written there would be loaded as the agent's standing instructions
  const inGit = (relative: string) => relative.toLowerCase().split(/[\\/]/).includes(".git");
  if (inGit(path.relative(root, target)) || inGit(path.relative(rootReal, real)))
    return { error: "The path is inside Git's own folder." };
  if (instructionFile(path.relative(root, target)) || instructionFile(path.relative(rootReal, real)))
    return {
      error:
        "The path is a file agents load as instructions (CLAUDE.md, AGENTS.md, .github/copilot-instructions.md, or under .claude, .agents, .codex, .cursor).",
    };
  return { relative: path.relative(root, target).split(path.sep).join("/"), exists: Boolean(self) };
}

/** The tool's reply: one line naming the checked path, then the document to write as the whole file. */
export const exportReply = (where: { relative: string; exists: boolean }, document: string): string =>
  `Write to ${where.relative}, ${where.exists ? "replacing an existing file (show the owner its content first)" : "a new file"}. The rest of this reply, from the next line to the end, is the whole file, unchanged.\n${document}`;
