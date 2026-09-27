// Harvest's read of a pull request and how it is stored: what each source keeps, new revisions for edited text, and the closed issues.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Get, linkIssues, pullSources, readPull, repoOf, storeItems } from "../src/github.ts";
import { at, insert, project, tempDb } from "./temp-db.ts";

const sha = (c: string) => c.repeat(40);
const user = (login: string, id: number, type = "User") => ({ login, id, type });

/** Answers from a table by path, as gh would (lists come back whole). */
const fake =
  (pullBody: string): Get =>
  async (p) => {
    const answers: Record<string, unknown> = {
      "pulls/7": {
        number: 7,
        title: "Switch to pnpm",
        body: pullBody,
        html_url: "https://github.com/o/r/pull/7",
        created_at: "2026-03-17T09:00:00Z",
        merged_at: "2026-03-17T15:00:00+09:00",
        merged_by: user("hana", 1),
        user: user("hana", 1),
        author_association: "OWNER",
      },
      "issues/7/comments": [
        {
          id: 70,
          body: "Why not yarn?",
          user: user("dev", 2),
          author_association: "CONTRIBUTOR",
          created_at: "2026-03-17T10:00:00Z",
          html_url: "u",
        },
        {
          id: 71,
          body: "  ",
          user: user("dev", 2),
          author_association: "CONTRIBUTOR",
          created_at: "2026-03-17T10:00:00Z",
          html_url: "u",
        },
      ],
      "pulls/7/reviews": [
        {
          id: 72,
          body: "Looks right",
          state: "APPROVED",
          submitted_at: null,
          user: user("renovate", 3, "Bot"),
          html_url: "u",
        },
        { id: 73, body: "", state: "APPROVED", submitted_at: null, user: user("dev", 2), html_url: "u" },
      ],
      "pulls/7/comments": [
        {
          id: 74,
          body: "Consider OFF",
          user: user("dev", 2),
          author_association: "CONTRIBUTOR",
          created_at: "2026-03-17T12:00:00Z",
          html_url: "u",
          path: "src/db.ts",
          start_line: 4,
          line: 6,
          commit_id: sha("a"),
          diff_hunk: "@@ -1 +1 @@",
          in_reply_to_id: 70,
        },
        {
          id: 75,
          body: "outside",
          user: user("dev", 2),
          created_at: "2026-03-17T12:00:00Z",
          html_url: "u",
          path: "../x",
          line: null,
          commit_id: "short",
        },
      ],
      "pulls/7/commits": [
        {
          sha: sha("b"),
          author: user("hana", 1),
          commit: { message: "chore: pnpm", author: { date: "2026-03-17T14:00:00Z" } },
        },
      ],
      "issues/14": {
        number: 14,
        body: "Notes leak",
        html_url: "u",
        created_at: "2026-03-16T00:00:00Z",
        user: user("kai", 4),
        author_association: "MEMBER",
      },
      "issues/14/comments": [
        {
          id: 76,
          body: "Confirmed",
          user: user("kai", 4),
          author_association: "MEMBER",
          created_at: "2026-03-16T01:00:00Z",
          html_url: "u",
        },
      ],
      "issues/15": {
        number: 15,
        body: "a PR",
        html_url: "u",
        created_at: "2026-03-16T00:00:00Z",
        pull_request: {},
      },
    };
    const key = p.split("?")[0] ?? "";
    if (!(key in answers)) throw new Error(`no answer for ${p}`);
    return answers[key];
  };

test("closing references in owner/repo#N and URL form count for this repository only", async () => {
  const pull = await readPull(
    fake("Fixes o/r#14, resolves https://github.com/O/R/issues/15, and fixes other/x#16. Switch to pnpm."),
    7,
    "o/r",
  );
  assert.deepEqual(pull.closes, [14, 15]);
});

test("reads the body, comments, reviews with text, review comments with their position, commits, the merge, and closed issues", async () => {
  const pull = await readPull(fake("Fixes #14, closes #15, and fixes #7. Switch to pnpm."), 7);
  assert.equal(pull.title, "Switch to pnpm");
  assert.deepEqual(pull.closes, [14, 15]);
  assert.deepEqual(
    pull.items.map((i) => [i.kind, i.externalId]),
    [
      ["pr_body", "pr:7"],
      ["pr_comment", "comment:70"],
      ["review", "review:72"],
      ["review_comment", "review_comment:74"],
      ["review_comment", "review_comment:75"],
      ["commit_message", `commit:${sha("b")}`],
      ["pr_event", "pr:7#merged"],
      ["issue_body", "issue:14"],
      ["issue_comment", "comment:76"],
    ],
  );
  const review = pull.items[3];
  assert.deepEqual(
    [review?.path, review?.lines, review?.commit, review?.parent],
    ["src/db.ts", [4, 6], sha("a"), "review_comment:70"],
  );
  const outside = pull.items[4];
  assert.deepEqual([outside?.path, outside?.lines, outside?.commit], [null, null, null]);
  assert.equal(repoOf("git:github.com/o/r"), "o/r");
  assert.equal(repoOf("git:gitlab.com/o/r"), null);
  assert.equal(repoOf("local:x"), null);
});

test("stores sources with who wrote them, adds a revision only when text changed, and lists the current revisions with closed issues", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    insert(db, "owner_identity", {
      provider: "github",
      external_id: "1",
      login: "hana",
      bound_at: at("2026-01-01T00:00:00Z"),
    });
    const first = await readPull(fake("Fixes #14. Switch to pnpm."), 7);
    const ids = await storeItems(db.ingest, p, first.items);
    await linkIssues(db.ingest, p, 7, first.closes);
    await linkIssues(db.ingest, p, 7, first.closes);
    const kinds = db.owner
      .prepare(
        "select kind, author_kind, author_association, revision, available_at is not null as known, indexed from source order by id",
      )
      .all()
      .map((r) => [r.kind, r.author_kind, r.author_association, r.revision, r.known, r.indexed]);
    assert.deepEqual(kinds[0], ["pr_body", "owner", "OWNER", 1, 1, 1]);
    assert.deepEqual(kinds[2], ["review", "bot", null, 1, 1, 1]);
    assert.deepEqual(kinds[6], ["pr_event", "owner", null, 1, 1, 0]);
    assert.deepEqual(await storeItems(db.ingest, p, first.items), ids, "unchanged text keeps its rows");
    const second = await readPull(fake("Fixes #14. Switch to pnpm. Edited."), 7);
    const again = await storeItems(db.ingest, p, second.items);
    assert.notEqual(again[0], ids[0]);
    assert.deepEqual(again.slice(1), ids.slice(1));
    const current = await pullSources(db.reader, p, 7);
    assert.equal(current.length, ids.length, "only the current revision of each source");
    assert.deepEqual(
      current.filter((s) => s.kind === "pr_body").map((s) => [s.revision, s.text]),
      [[2, "Fixes #14. Switch to pnpm. Edited."]],
    );
    assert.ok(current.some((s) => s.artifact === "issue:14"));
    // A cleared body becomes an empty current revision: the old text stays as history but is no longer what the pull request says
    await storeItems(db.ingest, p, (await readPull(fake("   "), 7)).items);
    assert.deepEqual(
      (await pullSources(db.reader, p, 7))
        .filter((s) => s.kind === "pr_body")
        .map((s) => [s.revision, s.text]),
      [[3, ""]],
    );
    // The body no longer closes #14: the next harvest drops the link, so the issue stops being part of the pull request
    await linkIssues(db.ingest, p, 7, []);
    assert.equal(
      (await pullSources(db.reader, p, 7)).some((s) => s.artifact === "issue:14"),
      false,
    );
  } finally {
    await db.done();
  }
});
