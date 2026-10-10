// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The decision lane of a code review: which active records a diff touches (review-findings.ts checks the verdicts about them).
// A record applies when the diff changes a path it is anchored to, or, for a record with no code location that says not to do something
// (or to defer it), when an added line names one of its options. Candidates and superseded records never apply.
import { authorityOf } from "./authority.ts";
import { byUnit, type Reads } from "./db.ts";
import { framed } from "./frame.ts";
import { inline } from "./panel.ts";
import { READ_BUDGET } from "./read.ts";
import { bytes, head, sha256 } from "./text.ts";

/** A changed path; gone when the file is no longer there (deleted, or renamed away), so it has no added lines to point at */
export type FileDiff = { path: string; added: string[]; lines: number[]; gone?: true };

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** A path as Git prints it in a diff: C-quoted when it holds special bytes, then without its a/ or b/ prefix. */
function gitPath(token: string, prefix: string): string {
  let out = token;
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
    const bytes: number[] = [];
    const body = token.slice(1, -1);
    for (let i = 0; i < body.length; i++) {
      const c = String.fromCodePoint(body.codePointAt(i) ?? 0);
      if (c !== "\\") {
        bytes.push(...Buffer.from(c, "utf8"));
        i += c.length - 1;
        continue;
      }
      const octal = /^[0-3][0-7]{2}/.exec(body.slice(i + 1));
      if (octal) {
        bytes.push(Number.parseInt(octal[0], 8));
        i += 3;
      } else {
        const next = body[++i] ?? "";
        bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
      }
    }
    out = Buffer.from(bytes).toString("utf8");
  }
  return prefix && out.startsWith(prefix) ? out.slice(prefix.length) : out;
}

/**
 * The changed files of a unified diff (`git diff` output), with each added line and its line number in the new file. A deleted file and
 * the old path of a rename are kept as gone.
 */
export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  const at = (path: string): FileDiff => {
    const found = files.find((f) => f.path === path);
    if (found) return found;
    const f: FileDiff = { path, added: [], lines: [] };
    files.push(f);
    return f;
  };
  let cur: FileDiff | null = null;
  let line = 0;
  // Lines left in the current hunk, old and new side: inside it, "--- x" and "+++ x" are a removed or added line, not a file header
  let oldLeft = 0;
  let newLeft = 0;
  // A mode-only or binary change prints only its "diff --git" line: its path counts when nothing else in the block named a file
  let block: string | null = null;
  const closeBlock = () => {
    if (block) at(block);
    block = null;
  };
  const rows = text.split(/\r?\n/);
  for (const [i, raw] of rows.entries()) {
    if (cur && (oldLeft > 0 || newLeft > 0)) {
      if (raw.startsWith("+")) {
        cur.added.push(raw.slice(1));
        cur.lines.push(line++);
        newLeft--;
      } else if (raw.startsWith("-")) oldLeft--;
      else if (!raw.startsWith("\\")) {
        line++;
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    const header = /^diff --git (?:"(?:[^"\\]|\\.)*"|a\/.+) ("(?:[^"\\]|\\.)*"|b\/.+)$/.exec(raw);
    if (header?.[1]) {
      closeBlock();
      block = gitPath(header[1], "b/");
      continue;
    }
    // A rename prints its paths as metadata, with no ---/+++ header or hunk when the content is unchanged
    const renamed = /^rename (from|to) (.+)$/.exec(raw);
    if (renamed?.[2]) {
      block = null;
      const f = at(gitPath(renamed[2], ""));
      if (renamed[1] === "from") f.gone = true;
      continue;
    }
    const to = /^\+\+\+ (.+?)\t?$/.exec(raw);
    if (to) {
      block = null;
      // The old path is the header line just before; it names a deleted file
      const was = /^--- (.+?)\t?$/.exec(rows[i - 1] ?? "")?.[1];
      cur = to[1] === "/dev/null" ? null : at(gitPath(to[1] ?? "", "b/"));
      if (!cur && was && was !== "/dev/null") at(gitPath(was, "a/")).gone = true;
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (hunk) {
      oldLeft = Number(hunk[1] ?? 1);
      line = Number(hunk[2]);
      newLeft = Number(hunk[3] ?? 1);
    }
  }
  closeBlock();
  return files;
}

export type Applicable = {
  id: number;
  revision: number;
  key: string;
  kind: string;
  stance: string | null;
  text: string;
  /** Why it applies, as delivery shows it */
  because: string;
  /** The same reason in parts, so a reply can clip each: the anchor, or the added line's file and the option it names */
  why: { path: string; symbol: string | null } | { path: string; option: string };
};

/** Active, supported, sourced records the diff touches, each with why it applies, in id order. */
export async function selectForReview(
  db: Reads,
  projectId: number,
  files: FileDiff[],
): Promise<Applicable[]> {
  const paths = files.map((f) => f.path);
  const live = db
    .selectFrom("unit as u")
    .where("u.project_id", "=", projectId)
    .where("u.lifecycle", "=", "active")
    .where("u.extraction", "=", "supported")
    .where("u.unsourced", "=", 0);
  const anchored = paths.length
    ? await live
        .innerJoin("unit_anchor as a", "a.unit_id", "u.id")
        .where("a.path", "in", paths)
        .where("a.retired_at", "is", null)
        .select(["u.id", "u.revision", "u.key", "u.kind", "u.stance", "u.text", "a.path", "a.symbol"])
        .orderBy("u.id")
        .execute()
    : [];
  const out = new Map<number, Applicable>();
  for (const a of anchored)
    if (!out.has(a.id))
      out.set(a.id, {
        id: a.id,
        revision: a.revision,
        key: a.key,
        kind: a.kind,
        stance: a.stance,
        text: a.text,
        because: `anchored to ${a.path}${a.symbol ? ` ${a.symbol}` : ""}`,
        why: { path: a.path, symbol: a.symbol },
      });
  // Location-free don't and defer records: an added line naming one of their options (inside an identifier too: sendTelemetry)
  const added = files.flatMap((f) =>
    f.added.map((l) => ({ path: f.path, text: l.normalize("NFKC").toLowerCase() })),
  );
  const locationFree = live
    .where("u.stance", "in", ["dont", "defer"])
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("unit_anchor as a")
            .select("a.id")
            .whereRef("a.unit_id", "=", "u.id")
            .where("a.retired_at", "is", null),
        ),
      ),
    );
  // Their options by subquery, grouped per record: a list of every location-free id would pass SQLite's limit on bound values
  const [free, options] = await Promise.all([
    locationFree.select(["u.id", "u.revision", "u.key", "u.kind", "u.stance", "u.text"]).execute(),
    db
      .selectFrom("unit_option")
      .select(["unit_id", "text"])
      .where("unit_id", "in", locationFree.select("u.id"))
      .orderBy("id")
      .execute()
      .then(byUnit),
  ]);
  for (const u of free) {
    if (out.has(u.id)) continue;
    for (const o of (options.get(u.id) ?? []).filter((x) => x.text.trim().length >= 3)) {
      const name = o.text.normalize("NFKC").toLowerCase();
      const hit = added.find((l) => l.text.includes(name));
      if (hit) {
        out.set(u.id, {
          id: u.id,
          revision: u.revision,
          key: u.key,
          kind: u.kind,
          stance: u.stance,
          text: u.text,
          because: `an added line in ${hit.path} names the option ${o.text}`,
          why: { path: hit.path, option: o.text },
        });
        break;
      }
    }
  }
  return [...out.values()].sort((a, b) => a.id - b.id);
}

/** Records one review_select reply and one review_check call cover: a reviewer judges a batch at a time. */
export const REVIEW_BATCH = 50;

export type Batch = {
  /** Every record the diff touches, in id order */
  all: Applicable[];
  /** The records of this batch: the first REVIEW_BATCH after `after` */
  records: Applicable[];
  k: number;
  n: number;
  /** Ties the batches of one review together: the diff, and each selected record's id and revision */
  selection: string;
  /** The id to pass as after for the next batch, or null on the last */
  next: number | null;
  /** Whether after is where a batch ends (or absent): any other start would let receipts skip the records before it */
  aligned: boolean;
};

/** The batch of a review after the record id `after` (null for the first). `diff` is the text `files` was read from. */
export async function reviewBatch(
  db: Reads,
  projectId: number,
  files: FileDiff[],
  after: number | null,
  diff: string,
): Promise<Batch> {
  const all = await selectForReview(db, projectId, files);
  const rest = all.filter((u) => u.id > (after ?? 0));
  const records = rest.slice(0, REVIEW_BATCH);
  const n = Math.max(1, Math.ceil(all.length / REVIEW_BATCH));
  const k = Math.min(n, Math.floor((all.length - rest.length) / REVIEW_BATCH) + 1);
  // The whole text: parsed files keep only added lines, so two changes that remove different lines would share one selection
  const selection = sha256(JSON.stringify([diff, all.map((u) => `${u.id}:${u.revision}`)]))
    .toString("hex")
    .slice(0, 16);
  const last = records.at(-1);
  const ends = all.filter((_, i) => (i + 1) % REVIEW_BATCH === 0).map((u) => u.id);
  return {
    all,
    records,
    k,
    n,
    selection,
    next: rest.length > records.length && last ? last.id : null,
    aligned: after === null || ends.includes(after),
  };
}

/** Sphica's own words for a reviewer about an AI's decision, never taken from a record: shown only beside one */
export const AI_DEPARTURE =
  "A record marked decided by an AI was decided by an AI in an earlier session, not by the owner: a change that departs from it is a violation only when the change gives no reason for departing.";

/** Bytes each part of a review_select line shows at most; a batch whose records leave less room shows less */
const SHOWN = { text: 300, path: 160, symbol: 80, option: 160 } as const;
/** Bytes a line's clipped parts need together; with less, the keys take the room and the records are named by u<id> alone */
const LEAST = 24;

type Caps = { text: number; path: number; symbol: number; option: number };
const NONE: Caps = { text: 0, path: 0, symbol: 0, option: 0 };

/** A part on one line within max bytes, its cut marked; 0 leaves it out, to count what the rest of the line takes */
const part = (value: string, max: number): string => {
  if (!max) return "";
  const v = inline(value);
  return bytes(v) <= max ? v : `${head(v, max - 3)}…`;
};

/** The records review_select returns, one line each and within room bytes, with the AI's decisions marked. byId when the keys left too
 * little room and each record is named by u<id> alone */
export async function selectedText(
  db: Reads,
  hits: Applicable[],
  room: number,
): Promise<{ text: string; byId: boolean }> {
  const whose = await authorityOf(
    db,
    hits.map((u) => u.id),
  );
  const marked = (u: Applicable) => (whose.get(u.id) === "agent" ? ", decided by an AI" : "");
  const tail = hits.some((u) => whose.get(u.id) === "agent") ? [AI_DEPARTURE] : [];
  const line = (u: Applicable, c: Caps) => {
    const why =
      "option" in u.why
        ? `an added line in ${part(u.why.path, c.path)} names the option ${part(u.why.option, c.option)}`
        : `anchored to ${part(u.why.path, c.path)}${u.why.symbol ? ` ${part(u.why.symbol, c.symbol)}` : ""}`;
    return `- ${inline(u.key)} (u${u.id}, ${u.kind}${u.stance ? ` ${u.stance}` : ""}${marked(u)}): ${part(u.text, c.text)} [${why}]`;
  };
  const join = (lines: string[]) => [...lines, ...tail].join("\n");
  // What each record may add to its line once the fixed parts of every line are counted: half to the text, the rest to the reason
  const each = Math.floor((room - bytes(join(hits.map((u) => line(u, NONE))))) / Math.max(1, hits.length));
  if (each >= LEAST) {
    const text = join(
      hits.map((u) => {
        const t = Math.min(SHOWN.text, Math.floor(each / 2));
        const rest = each - t;
        const two = "option" in u.why || u.why.symbol;
        const path = Math.min(SHOWN.path, two ? Math.floor(rest / 2) : rest);
        return line(u, {
          text: t,
          path,
          symbol: Math.min(SHOWN.symbol, rest - path),
          option: Math.min(SHOWN.option, rest - path),
        });
      }),
    );
    if (bytes(text) <= room) return { text, byId: false };
  }
  return {
    text: join(hits.map((u) => `- u${u.id}${marked(u) ? ` (${marked(u).slice(2)})` : ""}`)),
    byId: true,
  };
}

/** Sphica's own words when a batch names its records by u<id> alone */
const BY_ID =
  "The keys are too long to show here: read each by u<id>, and pass the key read shows as the finding's unit.";

/** review_select's whole reply for a batch, framed, within READ_BUDGET */
export async function selectReply(db: Reads, b: Batch, after: number | null): Promise<string> {
  const from = b.all.length - b.all.filter((u) => u.id > (after ?? 0)).length + 1;
  const lead = `Decision lane: checked. ${b.all.length} records apply. Batch ${b.k} of ${b.n} (records ${from}-${from + b.records.length - 1}), selection ${b.selection}; read each before judging it.`;
  const end =
    b.next === null
      ? "This is the last batch."
      : `Next batch: after checking this one, call review_select with after: ${b.next}.`;
  const room = READ_BUDGET - bytes(`${lead} ${BY_ID}\n${framed("")}\n${end}`);
  const s = await selectedText(db, b.records, room);
  return [s.byId ? `${lead} ${BY_ID}` : lead, framed(s.text), end].join("\n");
}
