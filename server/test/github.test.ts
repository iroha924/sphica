// Harvest's read of a pull request and how it is stored: what each source keeps, new revisions for edited text, and the closed issues.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyForget, previewForget } from "../src/forget.ts";
import {
  type Get,
  gh,
  ghUser,
  linkIssues,
  pullSources,
  readPull,
  repoOf,
  storeItems,
} from "../src/github.ts";
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

// GitHub hides HTML comments, and our own PR template's comments say "put `Closes #12`": a reference inside one closes nothing
test("closing references inside HTML comments, or after one left open, are not read", async () => {
  const template = fs.readFileSync(
    path.join(import.meta.dirname, "..", "..", ".github", "pull_request_template.md"),
    "utf8",
  );
  assert.deepEqual((await readPull(fake(`${template}\nFixes #14.`), 7)).closes, [14]);
  assert.deepEqual((await readPull(fake("Fixes #14 <!-- Closes #15 --> and more."), 7)).closes, [14]);
  assert.deepEqual((await readPull(fake("Fixes #14. <!-- left open\nCloses #15"), 7)).closes, [14]);
  // Many openers that never close are read in one pass, not once per opener
  const started = Date.now();
  assert.deepEqual((await readPull(fake(`Fixes #14 ${"<!--".repeat(200_000)} Closes #15`), 7)).closes, [14]);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
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
    assert.deepEqual(kinds[6], ["pr_event", "person", null, 1, 1, 0]);
    // A commit's author comes from the git email, which anyone can write: a bound id there never makes the owner's words
    assert.deepEqual(
      kinds.filter((k) => k[0] === "commit_message").map((k) => k[1]),
      ["person"],
    );
    assert.deepEqual(await storeItems(db.ingest, p, first.items), ids, "unchanged text keeps its rows");
    const second = await readPull(fake("Fixes #14. Switch to pnpm. Edited."), 7);
    const again = await storeItems(db.ingest, p, second.items);
    assert.notEqual(again[0], ids[0]);
    assert.deepEqual(again.slice(1), ids.slice(1));
    // A body that was always empty is not kept, but keeps its place: the ids line up with the items
    const blank = [
      { ...(first.items[0] as (typeof first.items)[number]), externalId: "blank", text: "" },
      ...first.items.slice(1),
    ];
    const placed = await storeItems(db.ingest, p, blank);
    assert.deepEqual(placed, [null, ...ids.slice(1)]);
    // A review comment's diff hunk is masked like its body: a key in the changed code never lands in the database
    const withHunk = first.items.find((it) => it.hunk !== null) ?? first.items[0];
    const leaked = {
      ...(withHunk as (typeof first.items)[number]),
      externalId: "hunk-1",
      artifact: "pr:99",
      hunk: "+API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123",
    };
    await storeItems(db.ingest, p, [leaked]);
    const hunk = String(
      db.owner.prepare("select diff_hunk from source where external_id = 'hunk-1'").get()?.diff_hunk,
    );
    assert.ok(!hunk.includes("sk-proj-abc") && hunk.includes("[redacted"), hunk);
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

// Pull request data is written by anyone: a listing larger than the cap stops with a reason instead of filling memory
test("a gh listing over the size cap is refused with a reason", async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-fake-gh-"));
  const saved = process.env.PATH;
  try {
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/bin/sh\nexec "${process.execPath}" -e 'process.stdout.write("[[" + "\\"x\\",".repeat(6e6) + "\\"x\\"]]")'\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}${path.delimiter}${saved ?? ""}`;
    await assert.rejects(
      gh("o/r")("pulls/1/comments?per_page=100", true),
      /too large to read \(over 16 MB\)/,
    );
  } finally {
    process.env.PATH = saved;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

/** Puts a gh first on PATH that saves its arguments and answers with `out` and `status`, runs `body`, then restores PATH. */
async function withGh(
  out: string,
  status: number,
  body: (args: () => string[]) => Promise<void>,
): Promise<void> {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-fake-gh-"));
  const saved = process.env.PATH;
  const log = path.join(bin, "args.json");
  try {
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(${JSON.stringify(out)});\nprocess.exit(${status});\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}${path.delimiter}${saved ?? ""}`;
    await body(() => JSON.parse(fs.readFileSync(log, "utf8")) as string[]);
  } finally {
    process.env.PATH = saved;
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

// GH_HOST or an enterprise host must not answer for github.com: an id from another host would be taken as a github.com account
test("gh reads pull requests and the signed-in user from github.com only", async () => {
  await withGh("{}", 0, async (args) => {
    await gh("o/r")("pulls/1");
    assert.deepEqual(args(), ["api", "repos/o/r/pulls/1", "--hostname", "github.com"]);
  });
  await withGh(JSON.stringify({ id: 42, login: "hana-1", type: "User" }), 0, async (args) => {
    assert.deepEqual(await ghUser(), { ok: true, id: 42, login: "hana-1" });
    assert.deepEqual(args(), ["api", "user", "--hostname", "github.com"]);
  });
  // An Enterprise Managed User on github.com carries an underscore and a short code in the login
  await withGh(JSON.stringify({ id: 43, login: "mona-cat_octo" }), 0, async () => {
    assert.deepEqual(await ghUser(), { ok: true, id: 43, login: "mona-cat_octo" });
  });
  // 39 characters is GitHub's longest login; 40 is refused below
  await withGh(JSON.stringify({ id: 44, login: "a".repeat(39) }), 0, async () => {
    assert.deepEqual(await ghUser(), { ok: true, id: 44, login: "a".repeat(39) });
  });
});

// CLICOLOR_FORCE makes gh color its JSON even into a pipe (measured with gh 2.97), which no longer parses
test("gh is asked for plain JSON even when the owner forces color", async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-fake-gh-"));
  const saved = { PATH: process.env.PATH, CLICOLOR_FORCE: process.env.CLICOLOR_FORCE };
  try {
    const colors = "const f = process.env.CLICOLOR_FORCE; const c = f && f !== '0';";
    const out = (json: string) =>
      `process.stdout.write(c ? "\\u001b[1;37m" + ${JSON.stringify(json)} + "\\u001b[m" : ${JSON.stringify(json)});`;
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!${process.execPath}\n${colors}\nif (process.argv[3] === "user") ${out('{"id":42,"login":"hana"}')} else ${out("{}")}\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ""}`;
    process.env.CLICOLOR_FORCE = "1";
    assert.deepEqual(await ghUser(), { ok: true, id: 42, login: "hana" });
    assert.deepEqual(await gh("o/r")("pulls/1"), {});
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.CLICOLOR_FORCE === undefined) delete process.env.CLICOLOR_FORCE;
    else process.env.CLICOLOR_FORCE = saved.CLICOLOR_FORCE;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

// A gh stuck on the network must not hold init, even one that ignores SIGTERM: it gives up and init goes on to register the repository
test("a gh that never answers is given up on as failed", async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-fake-gh-"));
  const saved = process.env.PATH;
  try {
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!${process.execPath}\nprocess.on('SIGTERM', () => {}); setTimeout(() => {}, 20_000);\n`,
      {
        mode: 0o755,
      },
    );
    process.env.PATH = `${bin}${path.delimiter}${saved ?? ""}`;
    const started = Date.now();
    assert.deepEqual(await ghUser(500), { ok: false, reason: "failed" });
    assert.ok(Date.now() - started < 10_000);
  } finally {
    process.env.PATH = saved;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("a signed-out gh, a missing gh, and an answer that is not a user are told apart", async () => {
  await withGh("", 1, async () => {
    assert.deepEqual(await ghUser(), { ok: false, reason: "failed" });
  });
  // Ended by a signal, gh ran but gave no answer; an answer larger than a user can be is not one
  for (const [script, reason] of [
    ["process.kill(process.pid, 'SIGKILL');", "failed"],
    ["process.stdout.write('x'.repeat(2 * 1024 * 1024));", "unexpected"],
  ] as const) {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-fake-gh-"));
    const saved = process.env.PATH;
    try {
      fs.writeFileSync(path.join(bin, "gh"), `#!${process.execPath}\n${script}\n`, { mode: 0o755 });
      process.env.PATH = `${bin}${path.delimiter}${saved ?? ""}`;
      assert.deepEqual(await ghUser(), { ok: false, reason }, script);
    } finally {
      process.env.PATH = saved;
      fs.rmSync(bin, { recursive: true, force: true });
    }
  }
  for (const answer of [
    "not json",
    "null",
    JSON.stringify({ login: "hana" }),
    JSON.stringify({ id: 0, login: "hana" }),
    JSON.stringify({ id: "42", login: "hana" }),
    JSON.stringify({ id: 2 ** 60, login: "hana" }),
    JSON.stringify({ id: 42, login: "" }),
    JSON.stringify({ id: 42, login: "-hana" }),
    JSON.stringify({ id: 42, login: "hana\nok" }),
    JSON.stringify({ id: 42, login: "a".repeat(40) }),
  ])
    await withGh(answer, 0, async () => {
      assert.deepEqual(await ghUser(), { ok: false, reason: "unexpected" }, answer);
    });
  const saved = process.env.PATH;
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-no-gh-"));
  try {
    process.env.PATH = empty;
    assert.deepEqual(await ghUser(), { ok: false, reason: "missing" });
    // A gh that cannot be started never ran, so it is not reported as signed out
    fs.writeFileSync(path.join(empty, "gh"), "", { mode: 0o644 });
    assert.deepEqual(await ghUser(), { ok: false, reason: "missing" });
  } finally {
    process.env.PATH = saved;
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("tombstone: harvest does not store an item the owner forgot, and stores it again only with changed text", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    const first = await readPull(fake("Switch to pnpm."), 7);
    const ids = await storeItems(db.ingest, p, first.items);
    const body = ids[0] as number;
    await applyForget(db.file, p, [body], await previewForget(db.file, p, [body]));
    const again = await storeItems(db.ingest, p, first.items);
    assert.deepEqual(again, [null, ...ids.slice(1)]);
    assert.equal(db.owner.prepare("select count(*) as n from source where kind = 'pr_body'").get()?.n, 0);
    const edited = await storeItems(db.ingest, p, (await readPull(fake("Switch to pnpm. Edited."), 7)).items);
    assert.equal(typeof edited[0], "number");
    // An edit's time is not in the REST response, so a revision after a forgotten one has no known time it became visible
    assert.equal(
      db.owner.prepare("select available_at from source where kind = 'pr_body'").get()?.available_at,
      null,
    );
    assert.equal(
      db.owner.prepare("select text from source where kind = 'pr_body'").get()?.text,
      "Switch to pnpm. Edited.",
    );
  } finally {
    await db.done();
  }
});

test("tombstone: after the newest revision is forgotten, an older one is not shown as current, and the next text takes a new revision", async () => {
  const db = tempDb();
  try {
    const p = project(db);
    await storeItems(db.ingest, p, (await readPull(fake("Version A."), 7)).items);
    const b = (await storeItems(db.ingest, p, (await readPull(fake("Version B."), 7)).items))[0] as number;
    await applyForget(db.file, p, [b], await previewForget(db.file, p, [b]));
    await storeItems(db.ingest, p, (await readPull(fake("Version B."), 7)).items);
    const bodies = (await pullSources(db.reader, p, 7)).filter((s) => s.kind === "pr_body");
    assert.deepEqual(bodies, [], "version A is not the pull request's current body");
    await storeItems(db.ingest, p, (await readPull(fake("Version C."), 7)).items);
    assert.deepEqual(
      (await pullSources(db.reader, p, 7))
        .filter((s) => s.kind === "pr_body")
        .map((s) => [s.text, s.revision]),
      [["Version C.", 3]],
    );
  } finally {
    await db.done();
  }
});
