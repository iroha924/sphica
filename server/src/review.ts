// The decision lane of a code review: which active records a diff touches (review-findings.ts checks the verdicts about them).
// A record applies when the diff changes a path it is anchored to, or, for a record with no code location that says not to do something
// (or to defer it), when an added line names one of its options. Candidates and superseded records never apply.
import { authorityOf } from "./authority.ts";
import type { Reads } from "./db.ts";
import { inline } from "./panel.ts";
import { head } from "./text.ts";

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
  key: string;
  kind: string;
  stance: string | null;
  text: string;
  because: string;
};

/** Active, supported, sourced records the diff touches, each with why it applies. */
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
        .select(["u.id", "u.key", "u.kind", "u.stance", "u.text", "a.path", "a.symbol"])
        .orderBy("u.id")
        .execute()
    : [];
  const out = new Map<number, Applicable>();
  for (const a of anchored)
    if (!out.has(a.id))
      out.set(a.id, {
        id: a.id,
        key: a.key,
        kind: a.kind,
        stance: a.stance,
        text: a.text,
        because: `anchored to ${a.path}${a.symbol ? ` ${a.symbol}` : ""}`,
      });
  // Location-free don't and defer records: an added line naming one of their options (inside an identifier too: sendTelemetry)
  const added = files.flatMap((f) =>
    f.added.map((l) => ({ path: f.path, text: l.normalize("NFKC").toLowerCase() })),
  );
  const free = await live
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
    )
    .select(["u.id", "u.key", "u.kind", "u.stance", "u.text"])
    .execute();
  const options = free.length
    ? await db
        .selectFrom("unit_option")
        .select(["unit_id", "text"])
        .where(
          "unit_id",
          "in",
          free.map((u) => u.id),
        )
        .execute()
    : [];
  for (const u of free) {
    if (out.has(u.id)) continue;
    for (const o of options.filter((x) => x.unit_id === u.id && x.text.trim().length >= 3)) {
      const name = o.text.normalize("NFKC").toLowerCase();
      const hit = added.find((l) => l.text.includes(name));
      if (hit) {
        out.set(u.id, {
          id: u.id,
          key: u.key,
          kind: u.kind,
          stance: u.stance,
          text: u.text,
          because: `an added line in ${hit.path} names the option ${o.text}`,
        });
        break;
      }
    }
  }
  return [...out.values()];
}

/** Sphica's own words for a reviewer about an AI's decision, never taken from a record: shown only beside one */
export const AI_DEPARTURE =
  "A record marked decided by an AI was decided by an AI in an earlier session, not by the owner: a change that departs from it is a violation only when the change gives no reason for departing.";

/** The records review_select returns, one line each, with the AI's decisions marked */
export async function selectedText(db: Reads, hits: Applicable[]): Promise<string> {
  const whose = await authorityOf(
    db,
    hits.map((u) => u.id),
  );
  const ai = hits.some((u) => whose.get(u.id) === "agent");
  return [
    ...hits.map(
      (u) =>
        `- ${u.key} (${u.kind}${u.stance ? ` ${u.stance}` : ""}${whose.get(u.id) === "agent" ? ", decided by an AI" : ""}): ${head(inline(u.text), 300)} [${u.because}]`,
    ),
    ...(ai ? [AI_DEPARTURE] : []),
  ].join("\n");
}
