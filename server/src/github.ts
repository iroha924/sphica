// Reads one pull request through `gh api` (read only) and stores what people wrote as sources: the body (a new revision when edited),
// comments, reviews, review comments with their code position, commits, the merge, and the issues the body closes.
// Each source keeps its author's GitHub association, which decides who can adopt a proposal; the text is someone else's and is never trusted.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Kysely } from "kysely";
import { fit } from "./capture.ts";
import { iso } from "./db.ts";
import type { DB } from "./db-types.ts";
import type { SOURCE_KINDS } from "./knowledge.ts";
import { sha256 } from "./text.ts";

const exec = promisify(execFile);

/** Linked issues read per pull request; a body naming more is cut, and the rest are only linked. */
const MAX_ISSUES = 5;
const CLOSES =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:([\w.-]+\/[\w.-]+)#|https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/|#)(\d{1,9})\b/gi;

/** Issue numbers a body closes in this repository: #N, and owner/repo#N or an issue URL when they name this repository. */
function closingRefs(body: string, repo: string | null): number[] {
  const here = repo?.toLowerCase();
  return [...body.matchAll(CLOSES)].flatMap((m) => {
    const named = (m[1] ?? m[2])?.toLowerCase();
    return !named || named === here ? [Number(m[3])] : [];
  });
}

/** `owner/repo` of a project key on github.com, or null (harvest reads only GitHub). */
export const repoOf = (key: string): string | null =>
  /^git:github\.com\/([^/]+\/[^/]+)$/.exec(key)?.[1] ?? null;

/** Reads one REST path of the repository; all follows every page. */
export type Get = (path: string, all?: boolean) => Promise<unknown>;

/** Pull request data is written by anyone: one listing stops at this size rather than filling memory (up to 4 run at once) */
const MAX_RESPONSE = 16 * 1024 * 1024;

/** Project keys and owner_identity name github.com only, so GH_HOST or a configured enterprise host must not answer instead */
const HOST = ["--hostname", "github.com"];

export const gh =
  (repo: string): Get =>
  async (path, all = false) => {
    const { stdout } = await exec(
      "gh",
      ["api", `repos/${repo}/${path}`, ...HOST, ...(all ? ["--paginate", "--slurp"] : [])],
      { encoding: "utf8", maxBuffer: MAX_RESPONSE },
    ).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
        throw new Error(`${path.split("?")[0]} is too large to read (over ${MAX_RESPONSE / 1024 / 1024} MB)`);
      throw e;
    });
    const parsed = JSON.parse(stdout) as unknown;
    return all ? (parsed as unknown[][]).flat() : parsed;
  };

export type SignedIn =
  | { ok: true; id: number; login: string }
  | { ok: false; reason: "missing" | "failed" | "unexpected" };

/** A login is printed and stored: up to 39 letters, digits, hyphens, and the underscore of an Enterprise Managed User (mona-cat_octo) */
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;

/**
 * The account gh is signed in to on github.com. A gh that cannot be started, a call that exited non-zero (signed out, offline),
 * and an answer that is not a user are told apart, so neither a broken gh nor a broken answer is reported as signed out.
 */
export async function ghUser(): Promise<SignedIn> {
  let stdout: string;
  try {
    ({ stdout } = await exec("gh", ["api", "user", ...HOST], { encoding: "utf8", maxBuffer: 1024 * 1024 }));
  } catch (e) {
    // Once gh ran, execFile gives its exit status (null when a signal ended it); when it never started, an error name
    const code: unknown = (e as { code?: unknown }).code;
    return {
      ok: false,
      reason:
        typeof code === "number" || code === null
          ? "failed"
          : code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            ? "unexpected"
            : "missing",
    };
  }
  let user: { id?: unknown; login?: unknown } | null;
  try {
    user = JSON.parse(stdout) as typeof user;
  } catch {
    return { ok: false, reason: "unexpected" };
  }
  const id = user?.id;
  const login = user?.login;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    typeof login !== "string" ||
    !LOGIN.test(login)
  )
    return { ok: false, reason: "unexpected" };
  return { ok: true, id, login };
}

type User = { login?: string; id?: number; type?: string } | null;
type Authored = { user?: User; author_association?: string };
type Pull = Authored & {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  created_at: string;
  merged_at: string | null;
  merged_by?: User;
};
type Comment = Authored & { id: number; body: string | null; created_at: string; html_url: string };
type Review = Authored & {
  id: number;
  body: string | null;
  state: string;
  submitted_at: string | null;
  html_url: string;
};
type ReviewComment = Comment & {
  path?: string;
  line?: number | null;
  start_line?: number | null;
  commit_id?: string;
  diff_hunk?: string;
  in_reply_to_id?: number;
};
type Commit = {
  sha: string;
  html_url?: string;
  author?: User;
  commit: { message: string; author?: { date?: string } | null };
};
type Issue = Authored & {
  number: number;
  body: string | null;
  html_url: string;
  created_at: string;
  pull_request?: unknown;
};

/** One source as read, before it is stored. */
export type Item = {
  kind: (typeof SOURCE_KINDS)[number];
  artifact: string;
  externalId: string;
  author: User;
  association: string | null;
  parent: string | null;
  event: "merged" | null;
  url: string | null;
  createdAt: string;
  text: string;
  path: string | null;
  lines: [number, number] | null;
  hunk: string | null;
  commit: string | null;
};

const item = (
  v: Partial<Item> & Pick<Item, "kind" | "artifact" | "externalId" | "createdAt" | "text">,
): Item => ({
  author: null,
  association: null,
  parent: null,
  event: null,
  url: null,
  path: null,
  lines: null,
  hunk: null,
  commit: null,
  ...v,
});

const sha = (s: string | undefined): string | null => (s && /^[0-9a-f]{40}$/.test(s) ? s : null);
const cleanPath = (p: string | undefined): string | null =>
  p &&
  !p.startsWith("/") &&
  !p.includes("\\") &&
  !p.split("/").some((x) => x === "" || x === "." || x === "..")
    ? p
    : null;

/** Everything harvest stores for one pull request, and the issues its body closes. */
export async function readPull(
  get: Get,
  number: number,
  repo: string | null = null,
): Promise<{ title: string; items: Item[]; closes: number[] }> {
  const p = (await get(`pulls/${number}`)) as Pull;
  const artifact = `pr:${number}`;
  const [comments, reviews, reviewComments, commits] = await Promise.all([
    get(`issues/${number}/comments?per_page=100`, true) as Promise<Comment[]>,
    get(`pulls/${number}/reviews?per_page=100`, true) as Promise<Review[]>,
    get(`pulls/${number}/comments?per_page=100`, true) as Promise<ReviewComment[]>,
    get(`pulls/${number}/commits?per_page=100`, true) as Promise<Commit[]>,
  ]);
  const items: Item[] = [];
  // An empty body is passed on too, so a body cleared after an earlier harvest becomes an empty current revision (storeItems keeps
  // no row for a body that was never there)
  items.push(
    item({
      kind: "pr_body",
      artifact,
      externalId: artifact,
      author: p.user ?? null,
      association: p.author_association ?? null,
      url: p.html_url,
      createdAt: p.created_at,
      text: p.body?.trim() ? p.body : "",
    }),
  );
  for (const c of comments)
    if (c.body?.trim())
      items.push(
        item({
          kind: "pr_comment",
          artifact,
          externalId: `comment:${c.id}`,
          author: c.user ?? null,
          association: c.author_association ?? null,
          url: c.html_url,
          createdAt: c.created_at,
          text: c.body,
        }),
      );
  for (const r of reviews)
    if (r.body?.trim())
      items.push(
        item({
          kind: "review",
          artifact,
          externalId: `review:${r.id}`,
          author: r.user ?? null,
          association: r.author_association ?? null,
          url: r.html_url,
          createdAt: r.submitted_at ?? p.created_at,
          text: r.body,
        }),
      );
  for (const c of reviewComments)
    if (c.body?.trim()) {
      const end = c.line ?? null;
      items.push(
        item({
          kind: "review_comment",
          artifact,
          externalId: `review_comment:${c.id}`,
          author: c.user ?? null,
          association: c.author_association ?? null,
          parent: c.in_reply_to_id ? `review_comment:${c.in_reply_to_id}` : null,
          url: c.html_url,
          createdAt: c.created_at,
          text: c.body,
          path: cleanPath(c.path),
          lines: end ? [c.start_line ?? end, end] : null,
          hunk: c.diff_hunk ?? null,
          commit: sha(c.commit_id),
        }),
      );
    }
  for (const c of commits)
    items.push(
      item({
        kind: "commit_message",
        artifact,
        externalId: `commit:${c.sha}`,
        author: c.author ?? null,
        url: c.html_url ?? null,
        createdAt: c.commit.author?.date ?? p.created_at,
        text: c.commit.message,
        commit: sha(c.sha),
      }),
    );
  if (p.merged_at)
    items.push(
      item({
        kind: "pr_event",
        artifact,
        externalId: `${artifact}#merged`,
        author: p.merged_by ?? null,
        event: "merged",
        url: p.html_url,
        createdAt: p.merged_at,
        text: `Merged by @${p.merged_by?.login ?? "unknown"}`,
      }),
    );
  const closes = [...new Set(closingRefs(p.body ?? "", repo))].filter((n) => n !== number);
  for (const n of closes.slice(0, MAX_ISSUES)) items.push(...(await readIssue(get, n)));
  return { title: p.title, items, closes };
}

/** An issue's body and comments; empty for a number that is a pull request. */
export async function readIssue(get: Get, n: number): Promise<Item[]> {
  const items: Item[] = [];
  const issue = (await get(`issues/${n}`)) as Issue;
  if (issue.pull_request) return items;
  if (issue.body?.trim())
    items.push(
      item({
        kind: "issue_body",
        artifact: `issue:${n}`,
        externalId: `issue:${n}`,
        author: issue.user ?? null,
        association: issue.author_association ?? null,
        url: issue.html_url,
        createdAt: issue.created_at,
        text: issue.body,
      }),
    );
  for (const c of (await get(`issues/${n}/comments?per_page=100`, true)) as Comment[])
    if (c.body?.trim())
      items.push(
        item({
          kind: "issue_comment",
          artifact: `issue:${n}`,
          externalId: `comment:${c.id}`,
          author: c.user ?? null,
          association: c.author_association ?? null,
          url: c.html_url,
          createdAt: c.created_at,
          text: c.body,
        }),
      );
  return items;
}

/** The pull request or issue a GitHub URL of this repository names, or null for any other URL. */
export function githubTarget(repo: string, url: string): { kind: "pull" | "issue"; number: number } | null {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(pull|issues)\/(\d{1,9})(?:[/?#].*)?$/.exec(url.trim());
  if (!m || m[1]?.toLowerCase() !== repo.toLowerCase()) return null;
  return { kind: m[2] === "pull" ? "pull" : "issue", number: Number(m[3]) };
}

/**
 * Stores items as sources and returns the id of each one's current revision. Unchanged text keeps its row; changed text becomes
 * a new revision, so units extracted earlier keep citing what they were extracted from.
 */
export async function storeItems(
  db: Kysely<DB>,
  projectId: number,
  items: Item[],
): Promise<(number | null)[]> {
  const owners = new Set(
    (
      await db.selectFrom("owner_identity").select("external_id").where("provider", "=", "github").execute()
    ).map((o) => o.external_id),
  );
  const now = iso(Date.now());
  // One entry per item, null for an empty text never kept, so callers can pair items with their ids
  const ids: (number | null)[] = [];
  for (const it of items) {
    const kept = fit(it.text);
    const hash = sha256(kept.body);
    const latest = await db
      .selectFrom("source")
      .select(["id", "revision", "content_hash"])
      .where("project_id", "=", projectId)
      .where("kind", "=", it.kind)
      .where("external_id", "=", it.externalId)
      .orderBy("revision", "desc")
      .executeTakeFirst();
    if (latest && Buffer.from(latest.content_hash).equals(hash)) {
      ids.push(latest.id);
      continue;
    }
    if (!latest && !kept.body.trim()) {
      ids.push(null);
      continue;
    }
    const authorId = it.author?.id === undefined ? null : String(it.author.id);
    const kind = authorId && owners.has(authorId) ? "owner" : it.author?.type === "Bot" ? "bot" : "person";
    const created = iso(it.createdAt);
    const row = await db
      .insertInto("source")
      .values({
        project_id: projectId,
        kind: it.kind,
        artifact: it.artifact,
        external_id: it.externalId,
        revision: (latest?.revision ?? 0) + 1,
        author_kind: kind,
        author_login: it.author?.login ?? null,
        author_external_id: authorId,
        author_association: it.association,
        parent_external_id: it.parent,
        event_kind: it.event,
        url: it.url,
        created_at: created,
        // Only the first revision's time is known to be when it became visible; an edit's time is not in the REST response
        available_at: latest ? null : created,
        captured_at: now,
        text: kept.body,
        truncated: kept.truncated ? 1 : 0,
        redacted: kept.redacted ? 1 : 0,
        original_bytes: kept.originalBytes,
        content_hash: hash,
        path: it.path,
        line_start: it.lines?.[0] ?? null,
        line_end: it.lines?.[1] ?? null,
        // Code under review can hold a key: the hunk is masked and bounded like the text
        diff_hunk: it.hunk === null ? null : fit(it.hunk).body,
        commit_sha: it.commit,
        indexed: it.kind === "pr_event" ? 0 : 1,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    ids.push(row.id);
  }
  return ids;
}

/** Records that a pull request closes issues, by artifact. */
export async function linkIssues(
  db: Kysely<DB>,
  projectId: number,
  number: number,
  closes: number[],
): Promise<void> {
  // The links follow the current body: an issue it no longer closes stops being part of the pull request
  let stale = db
    .deleteFrom("artifact_link")
    .where("project_id", "=", projectId)
    .where("from_artifact", "=", `pr:${number}`)
    .where("kind", "=", "closes");
  if (closes.length)
    stale = stale.where(
      "to_artifact",
      "not in",
      closes.map((n) => `issue:${n}`),
    );
  await stale.execute();
  for (const n of closes)
    await db
      .insertInto("artifact_link")
      .values({
        project_id: projectId,
        from_artifact: `pr:${number}`,
        to_artifact: `issue:${n}`,
        kind: "closes",
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
}

/** The current revision of every source of a pull request and the issues it closes, in time order. */
export async function pullSources(db: Kysely<DB>, projectId: number, number: number) {
  const artifacts = [
    `pr:${number}`,
    ...(
      await db
        .selectFrom("artifact_link")
        .select("to_artifact")
        .where("project_id", "=", projectId)
        .where("from_artifact", "=", `pr:${number}`)
        .execute()
    ).map((l) => l.to_artifact),
  ];
  return db
    .selectFrom("source as s")
    .where("s.project_id", "=", projectId)
    .where("s.artifact", "in", artifacts)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("source as n")
            .select("n.id")
            .whereRef("n.project_id", "=", "s.project_id")
            .whereRef("n.kind", "=", "s.kind")
            .whereRef("n.external_id", "=", "s.external_id")
            .whereRef("n.revision", ">", "s.revision"),
        ),
      ),
    )
    .select([
      "s.id",
      "s.kind",
      "s.artifact",
      "s.revision",
      "s.author_login",
      "s.author_association",
      "s.created_at",
      "s.captured_at",
      "s.path",
      "s.line_start",
      "s.text",
    ])
    .orderBy("s.created_at")
    .orderBy("s.id")
    .execute();
}
