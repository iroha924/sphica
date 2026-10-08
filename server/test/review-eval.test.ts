// The review evaluation's fixture and expected verdicts: every record a case expects is the set review_select selects for its diff, so a
// run is graded on the records it was asked about. The pinned Biome is checked on the fixture's files before any drafted check is judged by it.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  codexLock,
  codexProfile,
  evalCache,
  holdingLock,
  homeFence,
  managedCodexSettings,
} from "../evals/cloud/codex-home.ts";
import { REPO, repoPlaces } from "../evals/cloud/codex-run.ts";
import { hiddenEnv, hiddenNodeArgs, partsOf, runHiddenTest } from "../evals/cloud/hidden-test.ts";
import { restrictedImports } from "../evals/review/biome.ts";
import { buildReviewFixture, cachedFixture, loadReviewCases } from "../evals/review/fixture.ts";
import { gradeAll, gradeRun, lookedOutside, tally } from "../evals/review/grade.ts";
import { biomeChanged, copyBiome, judge, m2Rows, m2Tasks, prepare } from "../evals/review/m2.ts";
import { draftOf, gradeDraft, gradeRulesRun, loadRulesCases } from "../evals/review/rules-grade.ts";
import {
  claudeArgs,
  claudeMcp,
  claudeSettings,
  codexArgs,
  codexLaneDenies,
  codexMcp,
  drainLanes,
  evalDenies,
  outsideCheckout,
  READ_TOOLS,
  RULES_BODY,
  RUNNER_FILES,
  reviewPrompt,
  rulesPrompt,
  settleAll,
} from "../evals/review/runner.ts";
import { openReader } from "../src/db.ts";
import { parseDiff, selectForReview } from "../src/review.ts";
import { tempDir } from "./temp-dir.ts";

const OUTCOMES = new Set(["violation", "complies", "unrelated", "undetermined"]);
const cases = loadReviewCases();
// The home the deny lists were built from: building the fixture swaps HOME while it runs, and another test may run meanwhile
const HOME = os.homedir();
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
  // The permission profile is the sandbox: a --sandbox flag would select the old settings and drop its denies
  assert.ok(!codex.includes("-s") && !codex.includes("--sandbox"));
  assert.ok(codex.includes("--ephemeral") && codex.includes("--ignore-rules"));
  const profile = codexProfile(":read-only", ["/evals", "/r/codex-home/auth.json"]);
  assert.match(profile, /^default_permissions = "eval"$/m);
  assert.match(profile, /^extends = ":read-only"$/m);
  assert.match(profile, /^"\/evals" = "deny"\n"\/r\/codex-home\/auth\.json" = "deny"$/m);
  // Every run is denied the repository, the output directory, and the owner's Codex home, and works outside them
  const denies = evalDenies("/out");
  assert.ok(denies.includes(REPO) && denies.includes("/out"));
  assert.ok(denies.includes(path.join(HOME, ".codex")));
  const denyRead = (claudeSettings(READ_TOOLS, denies) as { sandbox: { filesystem: { denyRead: string[] } } })
    .sandbox.filesystem.denyRead;
  assert.ok(denies.every((d) => denyRead.includes(d)));
  // Codex's profiles read the whole disk unless told otherwise: the owner's other credentials are denied to it too
  for (const credential of [".aws", ".ssh", ".npmrc"])
    assert.ok(denies.includes(path.join(HOME, credential)), credential);
  const prompt = reviewPrompt("BODY\n", { ...p, model: "codex" });
  assert.ok(prompt.startsWith("BODY\n"), "the aspect body comes first, in full");
  assert.match(prompt, /Read the file \/w\/\.git\/review\.diff/);
  assert.match(prompt, /\| Uncommitted, tracked \| empty \|\n\| Untracked \| empty \|/);
  assert.match(prompt, /completion: lane=precedent model=codex coverage=/);
});

/** The hidden test as collect runs it: on macOS inside its sandbox, elsewhere (no sandbox-exec) with the same Node fence and scratch alone */
function hiddenHere(given: string, source: string) {
  if (process.platform === "darwin") return runHiddenTest(given, source, 60_000);
  // Node's fence compares real paths: a temp directory reached through a link would be outside it
  const work = fs.realpathSync(given);
  fs.mkdirSync(path.join(work, "test"), { recursive: true });
  fs.writeFileSync(path.join(work, "test", "hidden.test.ts"), source);
  const scratch = fs.realpathSync(tempDir("m2-hidden-"));
  const r = spawnSync(process.execPath, hiddenNodeArgs(work, scratch), {
    cwd: work,
    encoding: "utf8",
    env: hiddenEnv(work, scratch),
  });
  return { tests: r.stdout, parts: partsOf(source, r.stdout) };
}

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
    report: `verdict: changes_required\nfindings: 1\nquestions: 1\n- ${B}: whether the grid loads in 2 s\n\n1. [high] src/x.ts:1 — y\n\n\`\`\`\n${done("claude")}\n\`\`\``,
  });
  fakeRun(runs, {
    run: "flip-codex",
    host: "codex",
    checks: [{ findings: both("complies", "violation"), reply: ok() }],
    report: `findings: 1\n${done("codex")}`,
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
    report: `findings: 1\n${done("claude")}`,
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
    commands: ["/bin/zsh -lc 'cat /nowhere/sphica/server/evals/review/cases.json'"],
    report: `findings: 1\n${done("codex")}`,
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
  // A record any verdict fits is neither missed nor wrongly violated
  const loose = gradeRun(
    path.join(runs, "flip-codex"),
    { ...expect, [A]: { outcomes: ["violation", "complies"], question: false } },
    { forbidden: [], runs },
  );
  assert.deepEqual(loose.records[0] && [loose.records[0].falseViolation, loose.records[0].missed], [
    false,
    false,
  ]);
  assert.match(grade("short-claude").reason ?? "", /batch 2 of 2 not backed/);
  assert.match(grade("nolast-claude").reason ?? "", /completion line/);
  assert.equal(grade("exit-codex").state, "failed");
  const peek = grade("peek-codex");
  assert.equal(peek.state, "excluded");
  assert.match(peek.reason ?? "", /named \/nowhere\/sphica/);
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
      mismatches: 0,
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
      // A complies where a violation was expected, and a violation where undetermined was
      mismatches: 2,
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
  // Every way a file directly under src/ui writes the import of src/db.ts: the relative paths and the tsconfig alias
  const db =
    '// sphica: trace:s-rv-ui/ui-no-db\n    { "group": ["../db", "../db.ts", "@db"], "message": "Go through src/library.ts" }';
  const byName =
    '// sphica: trace:s-rv-ui/ui-no-db\n    { "group": ["**/db.ts", "**/db"], "message": "Go through src/library.ts" }';
  const pad = '"paths": { "left-pad": "Use String.prototype.padStart" }';
  const config = (overrides: string, extraMarker = "") => `{
  "linter": { "enabled": true, "rules": { "preset": "none", "style": { "noRestrictedImports": { "level": "error", "options": { ${pad}, "patterns": [
    ${lodash}
  ] } } } } },
  "overrides": [${overrides}]${extraMarker}
}`;
  const ui = (patterns: string, paths = `${pad}, `) =>
    `// sphica: trace:s-rl-admin/admin-db-exception
  { "includes": ["src/ui/*", "!src/ui/admin.ts"], "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": { ${paths}"patterns": [
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
  // An override that does not copy the project-wide options lets lodash and left-pad into src/ui
  const replaced = grade(draftOf(reply(config(ui(db, "")))));
  assert.deepEqual(replaced.missedViolations, ["src/ui/sort.ts", "src/ui/pad.ts"]);
  // A file-name glob bans another module named db and misses the alias
  const named = grade(draftOf(reply(config(ui(`${lodash},\n    ${byName}`)))));
  assert.deepEqual(
    [named.falseFailures, named.missedViolations],
    [["src/ui/legacy.ts"], ["src/ui/alias.ts"]],
  );
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

test("M2 judges a run's final patch: a forbidden import that stays is a violation, the exception is not, and the hidden test decides completion", async () => {
  const fixture = await built;
  const m1 = loadRulesCases();
  // The rules fixture's files on top of the review fixture: what M2's runs start from
  const repo = tempDir("m2-repo-");
  fs.cpSync(fixture.repo, repo, { recursive: true });
  for (const [rel, text] of Object.entries(m1.files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  }
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=e",
    "-c",
    "user.email=e@example.invalid",
    "commit",
    "-qm",
    "rules files",
  ]);
  const task = (id: string) => m2Tasks().find((t) => t.id === id) ?? assert.fail(id);
  const run = (condition: string, id: string, files: Record<string, string>) => {
    const dir = tempDir("m2-work-");
    const work = path.join(dir, "work");
    const { start, checkout } = prepare(repo, work, condition, path.join(dir, "git"));
    for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(work, rel), text);
    return judge(checkout, start, task(id), path.join(tempDir("m2-judged-"), "judged"), hiddenHere);
  };
  const direct =
    'import { open } from "../db.ts";\nexport function bookCount(file: string): number {\n  const db = open(file);\n  const n = (db.prepare("select count(*) as n from book").get() as { n: number }).n;\n  db.close();\n  return n;\n}\n';
  const viaLibrary = {
    "src/library.ts": `${fs.readFileSync(path.join(repo, "src", "library.ts"), "utf8")}\nimport { open } from "./db.ts";\nexport function countRows(file: string, table: "book" | "backup"): number {\n  const db = open(file);\n  const n = (db.prepare(\`select count(*) as n from \${table}\`).get() as { n: number }).n;\n  db.close();\n  return n;\n}\n`,
    "src/ui/detail.ts":
      'import { countRows } from "../library.ts";\nexport const bookCount = (file: string): number => countRows(file, "book");\n',
  };
  const wrong = run("rules", "count", { "src/ui/detail.ts": direct });
  assert.deepEqual([wrong.violations, wrong.completed], [["src/ui/detail.ts"], true], wrong.tests);
  const right = run("check", "count", viaLibrary);
  assert.deepEqual([right.violations, right.completed], [[], true], right.tests);
  // The admin screen may open the database itself: the installed check passes it
  const admin = run("check", "backups", {
    "src/ui/admin.ts": direct.replace("bookCount", "backupCount").replace("from book", "from backup"),
  });
  assert.deepEqual([admin.violations, admin.falseFailure, admin.completed], [[], false, true], admin.tests);
  const unfinished = run("rules", "debounce", {});
  assert.equal(unfinished.completed, false);
});

test("the grader fails a run whose completion line leaves scope unchecked, disagrees with its count, or comes twice, and counts a run with no result", () => {
  const runs = tempDir("review-grade2-");
  const A = "trace:s/a";
  const expect = { [A]: { outcomes: ["violation" as const], question: false } };
  const backed = [
    {
      findings: [{ outcome: "violation", unit: A }],
      reply: "Batch 1 of 1 backed (selection abc). This was the last batch (1 records in all).",
    },
  ];
  const line = (unfinished: string, n: number) =>
    `completion: lane=precedent model=claude coverage=COMPLETE unfinished=${unfinished} findings=${n}`;
  fakeRun(runs, {
    run: "left-claude",
    host: "claude",
    checks: backed,
    report: `findings: 1\n1. x\n${line("src/x.ts", 1)}`,
  });
  fakeRun(runs, {
    run: "count-claude",
    host: "claude",
    checks: backed,
    report: `findings: 1\n1. x\n${line("none", 99)}`,
  });
  fakeRun(runs, {
    run: "twice-claude",
    host: "claude",
    checks: backed,
    report: `findings: 1\n1. x\n${line("none", 1)}\n${line("none", 1)}`,
  });
  fakeRun(runs, {
    run: "fine-claude",
    host: "claude",
    checks: backed,
    report: `findings: 1\n1. x\n${line("none", 1)}`,
  });
  // The count may carry a note after it, as Codex writes it
  fakeRun(runs, {
    run: "noted-codex",
    host: "codex",
    checks: backed,
    report: `findings: 1 (informational)\n1. x\n${line("none", 1).replace("claude", "codex")}`,
  });
  const grade = (run: string) => gradeRun(path.join(runs, run), expect, { forbidden: [], runs });
  assert.match(grade("left-claude").reason ?? "", /unfinished/);
  assert.match(grade("count-claude").reason ?? "", /findings/);
  assert.match(grade("twice-claude").reason ?? "", /2 completion lines/);
  assert.equal(grade("fine-claude").state, "graded");
  assert.equal(grade("noted-codex").state, "graded");
  // A run directory that never got its result is a failed run in the count, not a missing one
  fs.mkdirSync(path.join(runs, "postgres-codex-2026-10-08T00-00-00-000Z-deadbeef"));
  assert.deepEqual(
    gradeAll(runs).map((g) => [g.run, g.state, g.reason]),
    [["postgres-codex-2026-10-08T00-00-00-000Z-deadbeef", "failed", "no result.json"]],
  );
});

test("M2 never writes through a link the run left in its checkout", async () => {
  const fixture = await built;
  const outside = path.join(tempDir("m2-outside-"), "owner.json");
  fs.writeFileSync(outside, "the owner's file\n");
  const dir = tempDir("m2-link-");
  const work = path.join(dir, "work");
  const { start, checkout } = prepare(fixture.repo, work, "rules", path.join(dir, "git"));
  fs.rmSync(path.join(work, "biome.json"), { force: true });
  fs.symlinkSync(outside, path.join(work, "biome.jsonc"));
  const task = m2Tasks()[0] ?? assert.fail("no task");
  assert.throws(() => judge(checkout, start, task, path.join(tempDir("m2-judged-"), "judged")), /outside/);
  assert.equal(fs.readFileSync(outside, "utf8"), "the owner's file\n");
});

test("M2 judges through a git directory the run cannot write, and a hidden test that never ran is a failed run", async () => {
  const fixture = await built;
  const dir = tempDir("m2-pin-");
  const work = path.join(dir, "work");
  const { start, checkout } = prepare(fixture.repo, work, "rules", path.join(dir, "git"));
  // What a run could leave: a clean filter in the checkout's own git config, and a file that uses it
  const marker = path.join(dir, "filter-ran");
  fs.appendFileSync(path.join(work, ".git", "config"), `[filter "escape"]\n\tclean = touch ${marker}\n`);
  fs.writeFileSync(path.join(work, ".gitattributes"), "*.ts filter=escape\n");
  fs.appendFileSync(path.join(work, "src", "ui", "list.ts"), "export const more = 1;\n");
  const task = m2Tasks()[0] ?? assert.fail("no task");
  judge(checkout, start, task, path.join(tempDir("m2-judged-"), "judged"), () => ({
    tests: "1 passed",
    parts: { completion: "fail" },
  }));
  assert.equal(fs.existsSync(marker), false, "the run's filter ran on the host");
  assert.throws(
    () =>
      judge(checkout, start, task, path.join(tempDir("m2-judged-"), "judged"), () => ({
        tests: "not run",
        parts: { completion: null },
      })),
    /hidden test/,
  );
});

test("the grader counts a verdict outside the expected ones and a backed violation the report leaves out, and grades only precedent runs", () => {
  const runs = tempDir("review-grade3-");
  const A = "trace:s/a";
  const B = "trace:s/b";
  const expect = {
    [A]: { outcomes: ["violation" as const], question: false },
    [B]: { outcomes: ["complies" as const, "unrelated" as const], question: false },
  };
  const backed = (b: string) => [
    {
      findings: [
        { outcome: "violation", unit: A },
        { outcome: b, unit: B },
      ],
      reply: "Batch 1 of 1 backed (selection abc). This was the last batch (2 records in all).",
    },
  ];
  const report = (n: number) =>
    `findings: ${n}\ncompletion: lane=precedent model=claude coverage=COMPLETE unfinished=none findings=${n}`;
  fakeRun(runs, {
    run: "postgres-claude-2026-10-08T00-00-01-000Z-aaaaaaaa",
    host: "claude",
    checks: backed("undetermined"),
    report: report(1),
  });
  fakeRun(runs, {
    run: "postgres-claude-2026-10-08T00-00-02-000Z-bbbbbbbb",
    host: "claude",
    checks: backed("complies"),
    report: report(0),
  });
  const g = gradeRun(path.join(runs, "postgres-claude-2026-10-08T00-00-01-000Z-aaaaaaaa"), expect, {
    forbidden: [],
    runs,
  });
  assert.deepEqual(
    g.records.map((r) => [r.key, r.mismatch]),
    [
      [A, false],
      [B, true],
    ],
  );
  assert.match(
    gradeRun(path.join(runs, "postgres-claude-2026-10-08T00-00-02-000Z-bbbbbbbb"), expect, {
      forbidden: [],
      runs,
    }).reason ?? "",
    /not reported/,
  );
  // Other runs and directories that share the output root are not precedent runs
  for (const other of ["rules-codex-2026-10-08T00-00-00-000Z-cccccccc", "m2", "preflight", "fixture"])
    fs.mkdirSync(path.join(runs, other));
  assert.deepEqual(
    gradeAll(runs).map((x) => x.run),
    [
      "postgres-claude-2026-10-08T00-00-01-000Z-aaaaaaaa",
      "postgres-claude-2026-10-08T00-00-02-000Z-bbbbbbbb",
    ],
  );
});

test("a rules run that names the repository holding the held-out cases is excluded", async () => {
  const fixture = await built;
  const runs = tempDir("rules-runs-");
  const dir = path.join(runs, "rules-codex-2026-10-08T00-00-00-000Z-dddddddd");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ host: "codex", status: 0, reason: null }));
  fs.writeFileSync(path.join(dir, "final.md"), "no draft");
  const root = path.resolve(import.meta.dirname, "..", "..");
  fs.writeFileSync(
    path.join(dir, "events.jsonl"),
    JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: `cat ${root}/server/evals/review/rules-cases.json` },
    }),
  );
  const g = gradeRulesRun(dir, fixture.repo, loadRulesCases(), runs);
  assert.equal(g.state, "excluded");
});

test("the runners refuse a command line that would run nothing", () => {
  const out = tempDir("review-cli-");
  const run = (script: string, ...args: string[]) =>
    spawnSync(
      process.execPath,
      [path.join(import.meta.dirname, "..", "evals", "review", script), ...args, "--out", out],
      { encoding: "utf8" },
    );
  assert.match(run("run.ts", "--host", "codex").stderr, /--diff/);
  assert.match(run("run.ts", "--host", "codex", "--diff", "nope").stderr, /--diff/);
  assert.match(run("run.ts", "--host", "codex", "--diff", "all", "--runs", "x").stderr, /--runs/);
  assert.match(run("m2.ts", "--host", "codex", "--condition", "rules", "--task", "nope").stderr, /--task/);
  assert.match(run("m2.ts", "--host", "codex", "--condition", "rules", "--jobs", "0").stderr, /--jobs/);
});

test("M2 judges with its own check only: a run's nested or extending Biome config is never read", async () => {
  const fixture = await built;
  const m1 = loadRulesCases();
  const repo = tempDir("m2-cfg-repo-");
  fs.cpSync(fixture.repo, repo, { recursive: true });
  for (const [rel, text] of Object.entries(m1.files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  }
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=e",
    "-c",
    "user.email=e@example.invalid",
    "commit",
    "-qm",
    "rules files",
  ]);
  const dir = tempDir("m2-cfg-");
  const work = path.join(dir, "work");
  const { start, checkout } = prepare(repo, work, "check", path.join(dir, "git"));
  // A file outside that Biome could not parse: reading it would fail the judge
  const outside = path.join(tempDir("m2-cfg-outside-"), "outside.json");
  fs.writeFileSync(outside, "{ not json");
  fs.writeFileSync(path.join(work, "biome.jsonc"), JSON.stringify({ extends: [outside] }));
  fs.writeFileSync(
    path.join(work, "src", "ui", "biome.json"),
    JSON.stringify({ root: false, linter: { enabled: false } }),
  );
  fs.writeFileSync(
    path.join(work, "src", "ui", "detail.ts"),
    'import { open } from "../db.ts";\nexport const bookCount = (file: string): number => (open(file).prepare("select count(*) as n from book").get() as { n: number }).n;\n',
  );
  const task = m2Tasks().find((t) => t.id === "count") ?? assert.fail("count");
  const j = judge(checkout, start, task, path.join(tempDir("m2-judged-"), "judged"), () => ({
    tests: "1 passed",
    parts: { completion: "pass" },
  }));
  assert.deepEqual(j.violations, ["src/ui/detail.ts"]);
});

test("a parent step in a command is no reason to exclude a run: the sandbox stops the read, not the spelling", () => {
  for (const command of ["rg 'from \"../db.ts\"' src/ui", "cd .. && cd .. && ls"])
    assert.equal(
      lookedOutside(
        JSON.stringify({ type: "item.completed", item: { type: "command_execution", command } }),
        {
          forbidden: ["/nowhere/sphica"],
          runs: "/r",
          run: "x",
        },
      ),
      null,
      command,
    );
});

test("a cached fixture is reused only for the inputs it was built from", async () => {
  const cases = loadReviewCases();
  const dir = path.join(tempDir("review-cache-"), "fixture");
  const first = await cachedFixture(dir, cases);
  assert.deepEqual(await cachedFixture(dir, cases), first);
  const changed = {
    ...cases,
    diffs: cases.diffs.map((d, i) => (i === 0 ? { ...d, summary: `${d.summary}.` } : d)),
  };
  await assert.rejects(cachedFixture(dir, changed), /built from other inputs/);
});

test("an M2 run that names the repository, which holds the hidden tests, is excluded from the counts", () => {
  const runs = tempDir("m2-runs-");
  const root = path.resolve(import.meta.dirname, "..", "..");
  const put = (name: string, events: string) => {
    fs.mkdirSync(path.join(runs, name));
    fs.writeFileSync(
      path.join(runs, name, "result.json"),
      JSON.stringify({
        host: "codex",
        condition: "rules",
        task: "count",
        status: 0,
        judgement: { violations: [], falseFailure: false, completed: true, tests: "1 passed" },
      }),
    );
    fs.writeFileSync(path.join(runs, name, "events.jsonl"), events);
  };
  put(
    "count-rules-codex-2026-10-08T00-00-00-000Z-aaaaaaaa",
    JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: `cat ${root}/server/evals/review/m2-cases.json` },
    }),
  );
  // The check script the condition installs runs the run's own Biome copy beside its checkout: that is not looking at the cases
  put(
    "count-rules-codex-2026-10-08T00-00-01-000Z-bbbbbbbb",
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "node /tmp/m2-work-x/biome/node_modules/@biomejs/biome/bin/biome lint .",
      },
    }),
  );
  // Reaching into the repository for its Biome is reaching into the repository
  put(
    "count-rules-codex-2026-10-08T00-00-02-000Z-cccccccc",
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: `node ${root}/server/node_modules/@biomejs/biome/bin/biome lint .`,
      },
    }),
  );
  const t = m2Rows(runs).get("codex rules");
  assert.deepEqual([t?.runs, t?.excluded, t?.completed], [3, 2, 1]);
});

test("the rules lane runs on the body M1 measured, which asks for a Biome check", () => {
  const prompt = rulesPrompt(fs.readFileSync(RULES_BODY, "utf8"), ["trace:s/k"]);
  assert.match(prompt, /noRestrictedImports/);
  assert.ok(!prompt.includes("$ARGUMENTS"));
});

test("M1 counts a marker only as the comment line the Skill asks for, never inside a message", async () => {
  const fixture = await built;
  const cases = loadRulesCases();
  const repo = tempDir("rules-msg-");
  fs.cpSync(fixture.repo, repo, { recursive: true });
  for (const [rel, text] of Object.entries(cases.files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  }
  const draft = `{ "linter": { "enabled": true, "rules": { "preset": "none", "style": { "noRestrictedImports": { "level": "error", "options": { "patterns": [
    { "group": ["lodash", "lodash/**"], "message": "sphica: trace:s-rv-ui/no-lodash" }
  ] } } } } } }`;
  const g = gradeDraft(draftOf(`\`\`\`jsonc\n${draft}\n\`\`\``), repo, cases, tempDir("rules-msg-graded-"));
  assert.deepEqual(g.unmarked, ["trace:s-rv-ui/no-lodash", "trace:s-rv-ui/ui-no-db"]);
});

test("a Codex lane does not start where an administrator's settings could replace its profile", () => {
  const etc = tempDir("codex-etc-");
  const prefs = tempDir("codex-prefs-");
  assert.deepEqual(managedCodexSettings({ etc, prefs }), []);
  fs.writeFileSync(path.join(etc, "requirements.toml"), "");
  fs.mkdirSync(path.join(prefs, "someone"));
  fs.writeFileSync(path.join(prefs, "someone", "com.openai.codex.plist"), "");
  assert.equal(managedCodexSettings({ etc, prefs }).length, 2);
});

test("a Codex lane does not start where the system config could select the old sandbox", () => {
  const etc = tempDir("codex-etc-");
  const prefs = tempDir("codex-prefs-");
  fs.writeFileSync(path.join(etc, "config.toml"), 'sandbox_mode = "danger-full-access"\n');
  assert.deepEqual(managedCodexSettings({ etc, prefs }), [path.join(etc, "config.toml")]);
});

test("runs made by different runner code are not tallied as one measurement, and shell lanes run one at a time", () => {
  const runs = tempDir("review-mixed-");
  const made: [string, string][] = [
    ["postgres-codex-2026-10-08T00-00-01-000Z-aaaaaaaa", "r1"],
    ["postgres-codex-2026-10-08T00-00-02-000Z-bbbbbbbb", "r2"],
  ];
  for (const [name, runner] of made) {
    fs.mkdirSync(path.join(runs, name));
    fs.writeFileSync(
      path.join(runs, name, "result.json"),
      JSON.stringify({ host: "codex", diff: "postgres", runner_sha256: runner }),
    );
  }
  assert.throws(() => gradeAll(runs), /2 settings/);
  const out = tempDir("review-cli2-");
  const run = (script: string, ...args: string[]) =>
    spawnSync(
      process.execPath,
      [path.join(import.meta.dirname, "..", "evals", "review", script), ...args, "--out", out],
      { encoding: "utf8" },
    );
  assert.match(
    run("run.ts", "--host", "codex", "--diff", "all", "--jobs", "2").stderr,
    /--jobs is 1 for Codex/,
  );
  assert.match(
    run("m2.ts", "--host", "claude", "--condition", "rules", "--jobs", "2").stderr,
    /--jobs is 1 for M2/,
  );
});

test("review lanes: both hosts are denied the repository wherever it lives, Codex's lanes all of HOME but the tools, and one lock holds", async () => {
  // A temporary HOME: the runner's own may hold links out of it, which the fence refuses
  const shield = { places: repoPlaces(), home: homeFence({ home: tempDir("review-lanes-home-") }) };
  const out = tempDir("review-out-");
  const cache = evalCache(tempDir("review-cache-home-"));
  // Claude keeps the owner's HOME for its login; the repository, not only the evaluations, is what it is denied
  for (const place of shield.places) assert.ok(evalDenies(out).includes(place), place);
  const codex = codexLaneDenies(out, cache, shield);
  assert.ok(codex.includes(out) && codex.includes(cache));
  for (const d of shield.home.denies) assert.ok(codex.includes(d), d);
  // A checkout, HOME, and TMPDIR outside everything denied, in one tree
  const work = outsideCheckout("review-work-", codex);
  assert.ok(!codex.some((d) => work.startsWith(`${d}${path.sep}`)));
  // The lock is held for the whole run and kept when a temp tree could not be removed
  await holdingLock(cache, async () => {
    assert.throws(() => codexLock(cache), /another fenced Codex evaluation/);
  });
  codexLock(cache)();
  await holdingLock(cache, async (leave) => leave(work));
  assert.throws(() => codexLock(cache), /another fenced Codex evaluation/);
  fs.rmSync(path.join(cache, "codex.lock"));
  fs.rmSync(path.dirname(work), { recursive: true, force: true });
  assert.ok(RUNNER_FILES.includes("../cloud/codex-run.ts"));
});

test("M2's check runs a Biome copy of the run's own, and a run that changed its copy is excluded", () => {
  const tree = fs.realpathSync(tempDir("m2-biome-"));
  const copy = copyBiome(tree);
  assert.ok(copy.bin.startsWith(`${tree}${path.sep}`), copy.bin);
  const version = execFileSync(process.execPath, [copy.bin, "--version"], { encoding: "utf8" });
  assert.match(version, /\d+\.\d+\.\d+/);
  const before = copy.digest();
  fs.appendFileSync(copy.bin, "\n// changed\n");
  assert.notEqual(copy.digest(), before);
  // The check script a run gets points at the copy, never into the repository
  const work = path.join(tree, "work");
  const fixtureRepo = path.join(tree, "repo");
  fs.mkdirSync(fixtureRepo);
  // None of the owner's git config (hooks, templates, signing) and none of the owner's Sphica paths
  const gitEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
  };
  delete gitEnv.SPHICA_DB;
  delete gitEnv.SPHICA_HOME;
  execFileSync("git", ["-C", fixtureRepo, "init", "-q"], { env: gitEnv });
  fs.writeFileSync(path.join(fixtureRepo, "biome.json"), "{}");
  execFileSync(
    "git",
    ["-C", fixtureRepo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "add", "-A"],
    { env: gitEnv },
  );
  execFileSync(
    "git",
    ["-C", fixtureRepo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "c"],
    { env: gitEnv },
  );
  prepare(fixtureRepo, work, "rules", path.join(tree, "git"), copy.bin);
  assert.ok(
    fs.readFileSync(path.join(work, "scripts", "check.mjs"), "utf8").includes(JSON.stringify(copy.bin)),
  );
  // Counted as excluded, whatever its judgement
  const runs = tempDir("m2-biome-runs-");
  const name = "count-check-codex-2026-10-08T00-00-00-000Z-aaaaaaaa";
  fs.mkdirSync(path.join(runs, name));
  const judgement = { violations: [], falseFailure: false, completed: true, tests: "" };
  fs.writeFileSync(
    path.join(runs, name, "result.json"),
    JSON.stringify({
      host: "codex",
      condition: "check",
      task: "count",
      status: 0,
      judgement,
      biome_changed: true,
      runner_sha256: "r",
      cases_sha256: "c",
    }),
  );
  const row = m2Rows(runs).get("codex check");
  assert.deepEqual([row?.runs, row?.excluded, row?.completed], [1, 1, 0]);
});

test("a lane that throws does not end the run while another lane still has its temp tree, and a deleted Biome copy counts as changed", async () => {
  const order: string[] = [];
  await assert.rejects(
    settleAll([
      async () => {
        throw new Error("first lane failed");
      },
      async () => {
        await new Promise((r) => setTimeout(r, 50));
        order.push("second lane finished");
      },
    ]),
    /first lane failed/,
  );
  assert.deepEqual(order, ["second lane finished"]);
  const tree = fs.realpathSync(tempDir("m2-biome-gone-"));
  const copy = copyBiome(tree);
  const pinned = copy.digest();
  assert.equal(biomeChanged(copy, pinned), false);
  fs.rmSync(path.join(tree, "biome"), { recursive: true, force: true });
  assert.equal(biomeChanged(copy, pinned), true);
});

test("a queue of lanes starts no lane once a temp tree was left behind", async () => {
  const started: number[] = [];
  let left = false;
  await assert.rejects(
    drainLanes(
      [1, 2, 3],
      1,
      async (n) => {
        started.push(n);
        if (n === 1) left = true;
      },
      () => left,
    ),
    /left behind/,
  );
  assert.deepEqual(started, [1]);
});
