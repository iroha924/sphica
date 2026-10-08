// The review evaluation's fixture and expected verdicts: every record a case expects is the set review_select selects for its diff, so a
// run is graded on the records it was asked about. The pinned Biome is checked on the fixture's files before any drafted check is judged by it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { restrictedImports } from "../evals/review/biome.ts";
import { buildReviewFixture, loadReviewCases } from "../evals/review/fixture.ts";
import { gradeRun, lookedOutside, tally } from "../evals/review/grade.ts";
import { draftOf, gradeDraft, loadRulesCases } from "../evals/review/rules-grade.ts";
import {
  claudeArgs,
  claudeMcp,
  claudeSettings,
  codexArgs,
  codexMcp,
  READ_TOOLS,
  reviewPrompt,
} from "../evals/review/runner.ts";
import { openReader } from "../src/db.ts";
import { parseDiff, selectForReview } from "../src/review.ts";
import { tempDir } from "./temp-dir.ts";

const OUTCOMES = new Set(["violation", "complies", "unrelated", "undetermined"]);
const cases = loadReviewCases();
const built = buildReviewFixture(tempDir("review-eval-"), cases);

test("each review case expects exactly the records review_select selects for its diff", async () => {
  const fixture = await built;
  const db = openReader(fixture.db);
  try {
    const project = await db.selectFrom("project").select("id").executeTakeFirstOrThrow();
    const active = new Set(
      (await db.selectFrom("unit").select("key").where("lifecycle", "=", "active").execute()).map(
        (u) => u.key,
      ),
    );
    assert.equal(Object.keys(fixture.diffs).length, cases.diffs.length);
    for (const d of cases.diffs) {
      for (const [key, e] of Object.entries(d.expect)) {
        assert.ok(active.has(key), `${d.id}: ${key} is not an active record of the fixture`);
        assert.ok(e.outcomes.length && e.outcomes.every((o) => OUTCOMES.has(o)), `${d.id}: ${key} outcomes`);
        // A question is an undetermined verdict, and an undetermined one that needs no question is a note
        if (e.question) assert.deepEqual(e.outcomes, ["undetermined"], `${d.id}: ${key}`);
      }
      const text = fs.readFileSync(fixture.diffs[d.id] ?? "", "utf8");
      const selected = await selectForReview(db, project.id, parseDiff(text));
      assert.deepEqual(selected.map((u) => u.key).sort(), Object.keys(d.expect).sort(), d.id);
    }
  } finally {
    await db.destroy();
  }
});

const ban = (patterns: { group: string[]; message: string }[]) => ({
  level: "error",
  options: { patterns },
});
const LODASH = { group: ["lodash", "lodash/**"], message: "Use the standard library" };
const DB = { group: ["**/db.ts", "**/db"], message: "Go through src/library.ts" };
const config = (overrideBans: (typeof LODASH)[] | null) => ({
  linter: {
    enabled: true,
    rules: { preset: "none", style: { noRestrictedImports: ban([LODASH]) } },
  },
  ...(overrideBans
    ? {
        overrides: [
          {
            includes: ["src/ui/**"],
            linter: { rules: { style: { noRestrictedImports: ban(overrideBans) } } },
          },
        ],
      }
    : {}),
});

test("the pinned Biome enforces a direct import ban and a module ban on the fixture, real imports only", async () => {
  const fixture = await built;
  const dir = tempDir("review-biome-");
  fs.cpSync(fixture.repo, dir, { recursive: true, filter: (src) => path.basename(src) !== ".git" });
  const write = (rel: string, text: string) => fs.writeFileSync(path.join(dir, rel), text);
  write("src/lodash-real.ts", 'import debounce from "lodash/debounce";\nexport const d = debounce;\n');
  write("src/lodash-said.ts", '// lodash is not used here\nexport const s = "import _ from \\"lodash\\"";\n');
  write("src/ui/db-real.ts", 'import { open } from "../db.ts";\nexport const o = open;\n');
  write("src/ui/lodash-real.ts", 'import debounce from "lodash/debounce";\nexport const d = debounce;\n');
  fs.appendFileSync(
    path.join(dir, "docs", "storage.md"),
    '\nNever `import { open } from "../db.ts"` in src/ui.\n',
  );
  const flagged = () =>
    restrictedImports(dir)
      .map((r) => `${r.path}:${r.line}`)
      .sort();

  // Template 1 alone: lodash anywhere; a comment, a string, and the docs do not count
  write("biome.json", JSON.stringify(config(null)));
  assert.deepEqual(flagged(), ["src/lodash-real.ts:1", "src/ui/lodash-real.ts:1"]);

  // Template 2 repeats the project-wide bans: src/ui reaches src/db.ts only through src/library.ts, which may import it
  write("biome.json", JSON.stringify(config([LODASH, DB])));
  assert.deepEqual(flagged(), ["src/lodash-real.ts:1", "src/ui/db-real.ts:1", "src/ui/lodash-real.ts:1"]);

  // An override's options replace the project-wide ones, so a module ban that does not repeat them lets lodash into src/ui
  write("biome.json", JSON.stringify(config([DB])));
  assert.deepEqual(flagged(), ["src/lodash-real.ts:1", "src/ui/db-real.ts:1"]);

  // A config Biome cannot read is a failure, never an empty report
  write("biome.json", "{ not json");
  assert.throws(() => restrictedImports(dir), /biome/);
});

test("a lane starts with only the read tools, no hooks, its own database, and the reviewer cannot write", () => {
  const p = {
    work: "/w",
    diff: "/w/.git/review.diff",
    db: "/r/db/sphica.db",
    home: "/r/home",
    server: "/s/mcp.js",
  };
  const settings = claudeSettings() as {
    permissions: { blockReadsOutsideWorkingDirectories: boolean; allow: string[] };
    hooks: Record<string, unknown>;
  };
  assert.equal(settings.permissions.blockReadsOutsideWorkingDirectories, true);
  assert.deepEqual(settings.permissions.allow, READ_TOOLS);
  assert.deepEqual(settings.hooks, {});
  const args = claudeArgs({ settings: "/r/settings.json", mcp: "/r/mcp.json" }, "m");
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(after("--tools"), "Read,Grep,Glob");
  assert.equal(after("--setting-sources"), "project");
  assert.ok(args.includes("--strict-mcp-config") && args.includes("--no-session-persistence"));
  assert.ok(!args.includes("--permission-mode"), "no mode that accepts edits");
  // The database reaches the MCP child itself, never through the reviewer's environment
  assert.deepEqual(claudeMcp(p).mcpServers.sphica, {
    command: process.execPath,
    args: ["/s/mcp.js"],
    env: { SPHICA_DB: "/r/db/sphica.db", SPHICA_HOME: "/r/home", HOME: "/r/home" },
  });
  assert.match(codexMcp(p), /SPHICA_DB = "\/r\/db\/sphica\.db"/);
  const codex = codexArgs("/w", "/r/final.md");
  assert.equal(codex[codex.indexOf("-s") + 1], "read-only");
  assert.ok(codex.includes("--ephemeral") && codex.includes("--ignore-rules"));
  const prompt = reviewPrompt("BODY\n", { ...p, model: "codex" });
  assert.ok(prompt.startsWith("BODY\n"), "the aspect body comes first, in full");
  assert.match(prompt, /Read the file \/w\/\.git\/review\.diff/);
  assert.match(prompt, /\| Uncommitted, tracked \| empty \|\n\| Untracked \| empty \|/);
  assert.match(prompt, /completion: lane=precedent model=codex coverage=/);
});

/** A run directory as runLane leaves it, with events in the host's own shape: review_check calls and their replies, and Codex's commands */
function fakeRun(
  runs: string,
  o: {
    run: string;
    host: "claude" | "codex";
    status?: number;
    checks: { findings: { outcome: string; unit: string }[]; reply: string }[];
    commands?: string[];
    report: string;
  },
): void {
  const dir = path.join(runs, o.run);
  fs.mkdirSync(dir, { recursive: true });
  const result = {
    run: o.run,
    host: o.host,
    diff: "d",
    status: o.status ?? 0,
    reason: o.status ? "exit 1" : null,
  };
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result));
  fs.writeFileSync(path.join(dir, "final.md"), o.report);
  const events: unknown[] = o.checks.flatMap((c, i): unknown[] =>
    o.host === "claude"
      ? [
          {
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: `t${i}`,
                  name: "mcp__sphica__review_check",
                  input: { findings: c.findings },
                },
              ],
            },
          },
          {
            type: "user",
            message: {
              content: [
                { type: "tool_result", tool_use_id: `t${i}`, content: [{ type: "text", text: c.reply }] },
              ],
            },
          },
        ]
      : [
          {
            type: "item.completed",
            item: {
              type: "mcp_tool_call",
              server: "sphica",
              tool: "review_check",
              arguments: { findings: c.findings },
              result: { content: [{ type: "text", text: c.reply }] },
            },
          },
        ],
  );
  for (const command of o.commands ?? [])
    events.push({ type: "item.completed", item: { type: "command_execution", command } });
  fs.writeFileSync(path.join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"));
}

test("the grader counts verdicts only from backed batches and a matching completion line, and never reads a failed run as clean", () => {
  const runs = tempDir("review-grade-");
  const A = "trace:s/a";
  const B = "trace:s/b";
  const expect = {
    [A]: { outcomes: ["violation" as const], question: false },
    [B]: { outcomes: ["undetermined" as const], question: true },
  };
  const ok = (n = 2) => `Batch 1 of 1 backed (selection abc). This was the last batch (${n} records in all).`;
  const done = (host: string) =>
    `completion: lane=precedent model=${host} coverage=COMPLETE unfinished=none findings=1`;
  const both = (a: string, b: string) => [
    { outcome: a, unit: A },
    { outcome: b, unit: B },
  ];
  // A rejected check is not a verdict: the later backed one is
  fakeRun(runs, {
    run: "good-claude",
    host: "claude",
    checks: [
      { findings: both("complies", "undetermined"), reply: "1 problems:\n- x" },
      { findings: both("violation", "undetermined"), reply: ok() },
    ],
    report: `verdict: changes_required\nquestions: 1\n- ${B}: whether the grid loads in 2 s\n\n1. [high] src/x.ts:1 — y\n\n\`\`\`\n${done("claude")}\n\`\`\``,
  });
  fakeRun(runs, {
    run: "flip-codex",
    host: "codex",
    checks: [{ findings: both("complies", "violation"), reply: ok() }],
    report: done("codex"),
  });
  fakeRun(runs, {
    run: "short-claude",
    host: "claude",
    checks: [
      {
        findings: both("violation", "undetermined"),
        reply: "Batch 1 of 2 backed (selection abc). Not judged in this call: 1 records",
      },
    ],
    report: done("claude"),
  });
  fakeRun(runs, {
    run: "nolast-claude",
    host: "claude",
    checks: [{ findings: both("violation", "undetermined"), reply: ok() }],
    report: "verdict: pass",
  });
  fakeRun(runs, { run: "exit-codex", host: "codex", status: 1, checks: [], report: "" });
  fakeRun(runs, {
    run: "peek-codex",
    host: "codex",
    checks: [{ findings: both("violation", "undetermined"), reply: ok() }],
    commands: ["/bin/zsh -lc 'cat ../../cases.json'"],
    report: done("codex"),
  });
  const grade = (run: string) =>
    gradeRun(path.join(runs, run), expect, { forbidden: ["/nowhere/sphica"], runs });

  const good = grade("good-claude");
  assert.equal(good.state, "graded", good.reason ?? "");
  assert.deepEqual(
    good.records.map((r) => [r.key, r.got, r.falseViolation, r.missed, r.asked]),
    [
      [A, "violation", false, false, false],
      [B, "undetermined", false, false, true],
    ],
  );
  const flip = grade("flip-codex");
  assert.deepEqual(
    flip.records.map((r) => [r.falseViolation, r.missed]),
    [
      [false, true],
      [true, false],
    ],
  );
  assert.match(grade("short-claude").reason ?? "", /batch 2 of 2 not backed/);
  assert.match(grade("nolast-claude").reason ?? "", /completion line/);
  assert.equal(grade("exit-codex").state, "failed");
  const peek = grade("peek-codex");
  assert.equal(peek.state, "excluded");
  assert.match(peek.reason ?? "", /climbed out/);
  // Naming another run of the same directory, or the repository the expected verdicts live in, excludes a run too
  assert.match(
    lookedOutside(`read ${runs}/good-claude/final.md`, { forbidden: [], runs, run: "flip-codex" }) ?? "",
    /named/,
  );
  assert.equal(
    lookedOutside(`read ${runs}/flip-codex/work/a.ts`, { forbidden: [], runs, run: "flip-codex" }),
    null,
  );
  assert.match(
    lookedOutside("cat /nowhere/sphica/server/evals/review/cases.json", {
      forbidden: ["/nowhere/sphica"],
      runs,
      run: "x",
    }) ?? "",
    /named/,
  );

  const t = tally(
    ["good-claude", "flip-codex", "short-claude", "nolast-claude", "exit-codex", "peek-codex"].map(grade),
  );
  assert.deepEqual(
    { ...t.get("claude") },
    {
      runs: 3,
      graded: 1,
      failed: 2,
      excluded: 0,
      falseViolations: 0,
      missed: 0,
      questionsAsked: 1,
      questionsExpected: 1,
      extraQuestions: 0,
    },
  );
  assert.deepEqual(
    { ...t.get("codex") },
    {
      runs: 3,
      graded: 1,
      failed: 1,
      excluded: 1,
      falseViolations: 1,
      missed: 1,
      questionsAsked: 0,
      questionsExpected: 1,
      extraQuestions: 0,
    },
  );
});

test("M1 grades a drafted Biome check on held-out files the run never saw, and counts unwanted drafts", async () => {
  const cases = loadRulesCases();
  const fixture = await built;
  const repo = tempDir("rules-repo-");
  fs.cpSync(fixture.repo, repo, { recursive: true });
  for (const [rel, text] of Object.entries(cases.files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  }
  const lodash =
    '// sphica: trace:s-rv-ui/no-lodash\n    { "group": ["lodash", "lodash/**"], "message": "Use the standard library" }';
  const db =
    '// sphica: trace:s-rv-ui/ui-no-db\n    { "group": ["**/db.ts", "**/db"], "message": "Go through src/library.ts" }';
  const config = (overrides: string, extraMarker = "") => `{
  "linter": { "enabled": true, "rules": { "preset": "none", "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
    ${lodash}
  ] } } } } },
  "overrides": [${overrides}]${extraMarker}
}`;
  const ui = (patterns: string) =>
    `// sphica: trace:s-rl-admin/admin-db-exception
  { "includes": ["src/ui/**", "!src/ui/admin.ts"], "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
    ${patterns}
  ] } } } } } }`;
  const reply = (draft: string) =>
    `Rule lines:\n\n\`\`\`markdown\n- x <!-- sphica: trace:s-rv-ui/no-lodash -->\n\`\`\`\n\nChecks:\n\n\`\`\`jsonc\n${draft}\n\`\`\`\n`;
  const grade = (draft: string | null) => gradeDraft(draft, repo, cases, tempDir("rules-graded-"));

  const right = grade(draftOf(reply(config(ui(`${lodash},\n    ${db}`)))));
  assert.deepEqual(right, {
    state: "graded",
    reason: null,
    unwanted: [],
    unmarked: [],
    falseFailures: [],
    missedViolations: [],
  });
  // An override that does not repeat the project-wide ban lets lodash into src/ui
  const replaced = grade(draftOf(reply(config(ui(db)))));
  assert.deepEqual(replaced.missedViolations, ["src/ui/sort.ts"]);
  // No exception for the admin screen: a false failure there
  const strict = grade(
    draftOf(reply(config(ui(`${lodash},\n    ${db}`).replace(', "!src/ui/admin.ts"', "")))),
  );
  assert.deepEqual(strict.falseFailures, ["src/ui/admin.ts"]);
  // A marker for a record Biome cannot check (reaching src/db.ts through other modules) is an unwanted draft
  const reach = grade(
    draftOf(
      reply(config(ui(`${lodash},\n    ${db}`), "\n  // sphica: trace:s-rl-admin/widgets-never-reach-db")),
    ),
  );
  assert.deepEqual(reach.unwanted, ["trace:s-rl-admin/widgets-never-reach-db"]);
  assert.match(grade(draftOf("Only rule lines.\n")).reason ?? "", /drafts no Biome check/);
  assert.equal(grade(draftOf(reply("{ not json noRestrictedImports"))).state, "failed");
});
