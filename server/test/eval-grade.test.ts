// The evaluation's structured grading: grades and Codex answers are counted only when they match their fixed shapes exactly,
// and anything else is kept apart with the reason rather than read as a score or as "nothing found".
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { claimRunDir, codexModelOf, evalCache, homeFence } from "../evals/cloud/codex-home.ts";
import { currentFence, repoPlaces, tempRoots } from "../evals/cloud/codex-run.ts";
import { type FiringRow, pair, planRows, taskFromReceipts } from "../evals/cloud/firing.ts";
import {
  blindPrompt,
  type CheckpointInput,
  checkpointKey,
  GRADER_ARGS,
  gradedTask,
  loadCheckpoint,
  receiveGrade,
  saveCheckpoint,
  tabulate,
} from "../evals/cloud/grading.ts";
import {
  answerFormat,
  capPatch,
  deliveredSignal,
  foundInClaudeLog,
  foundInCodexEvents,
  goldNotGiven,
  goldSignalsFromClaude,
  goldSignalsFromCodex,
  presentedText,
} from "../evals/cloud/judge.ts";
import { bars, compare, G4_VALID, newcombe, report } from "../evals/cloud/report.ts";
import {
  checkAnswer,
  checkGrade,
  type Grade,
  jsonSchemaOf,
  SCHEMA_FILES,
} from "../evals/cloud/schema-check.ts";
import { tempDir, tmpEnv } from "./temp-dir.ts";

const TASKS = path.join(import.meta.dirname, "..", "evals", "cloud", "tasks.json");
// A build holds a copy of the task definitions it was made from
const seedTasks = (build: string) => fs.copyFileSync(TASKS, path.join(build, "tasks.json"));
// The read fence a Codex run made now records; it names places by role, so any HOME gives the same
// Under a temporary HOME, as the collect and grade children run: the tools sit outside it, so it keeps no root
const fenceHome = tempDir("grade-fence-");
const fenceShield = { places: repoPlaces(), home: homeFence({ home: fenceHome }), temp: tempRoots() };
const FENCE = currentFence(":workspace", evalCache(fenceHome), fenceShield);
const GRADER_FENCE = currentFence(":read-only", evalCache(fenceHome), fenceShield);

/** A child's environment: a temporary home, and none of the owner's Sphica paths. */
function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.SPHICA_DB;
  delete env.SPHICA_HOME;
  return env;
}

const grade: Grade = {
  score: 2,
  reason: "kept the recorded search design",
  cited_gold: "yes",
  implements_rejected: "no",
  proposes_rejected: "no",
  followed: "not_applicable",
  named_conflict: "not_applicable",
  implemented_one_side: "not_applicable",
  flags: [],
};

test("a grade counts only in its exact shape", () => {
  assert.deepEqual(checkGrade(grade), { ok: true, value: grade });
  const bad = (v: unknown, why: RegExp) => {
    const r = checkGrade(v);
    assert.equal(r.ok, false, JSON.stringify(v));
    assert.match(r.ok ? "" : r.reason, why);
  };
  bad({ ...grade, score: "2" }, /score/);
  bad({ ...grade, score: 3 }, /score/);
  bad({ ...grade, cited_gold: "maybe" }, /cited_gold/);
  bad({ ...grade, implements_rejected: "partly" }, /implements_rejected/);
  bad({ ...grade, flags: ["tired"] }, /flags/);
  bad({ ...grade, extra: 1 }, /extra/);
  const { reason: _, ...missing } = grade;
  bad(missing, /reason/);
  bad(null, /object/);
  bad([grade], /object/);
});

test("a Codex answer counts only in its exact shape", () => {
  const answer = {
    implemented: false,
    summary: "kept search as it is",
    past_decisions: [{ ref: "harvest:157/keep-search", how_used: "followed" }],
    unverified: ["no measurement rerun"],
  };
  assert.deepEqual(checkAnswer(answer), { ok: true, value: answer });
  const bad = (v: unknown, why: RegExp) => {
    const r = checkAnswer(v);
    assert.equal(r.ok, false, JSON.stringify(v));
    assert.match(r.ok ? "" : r.reason, why);
  };
  bad({ ...answer, implemented: "no" }, /implemented/);
  bad({ ...answer, past_decisions: [{ ref: "x", how_used: "ignored" }] }, /how_used/);
  bad({ ...answer, past_decisions: [{ ref: "x", how_used: "followed", note: "" }] }, /note/);
  bad({ ...answer, unverified: [1] }, /unverified/);
  const { summary: _, ...missing } = answer;
  bad(missing, /summary/);
});

// The schema files go to Codex (--output-schema) and the checks read its output: both must describe the same shape
test("the schema files and the checks agree on keys and allowed values", () => {
  const load = (name: string) =>
    JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "evals", "cloud", name), "utf8"));
  const g = load("grade.schema.json");
  assert.deepEqual([...g.required].sort(), Object.keys(grade).sort());
  assert.equal(g.additionalProperties, false);
  for (const score of g.properties.score.enum) assert.equal(checkGrade({ ...grade, score }).ok, true);
  for (const v of g.properties.implements_rejected.enum)
    assert.equal(checkGrade({ ...grade, implements_rejected: v }).ok, true);
  assert.equal(checkGrade({ ...grade, flags: g.properties.flags.items.enum }).ok, true);
  const a = load("answer.schema.json");
  assert.deepEqual([...a.required].sort(), ["implemented", "past_decisions", "summary", "unverified"]);
  for (const how of a.properties.past_decisions.items.properties.how_used.enum)
    assert.equal(
      checkAnswer({
        implemented: true,
        summary: "",
        past_decisions: [{ ref: "r", how_used: how }],
        unverified: [],
      }).ok,
      true,
    );
});

// The four signals keep "could not tell" apart from "no": a missing log is unknown, never "did not find"
test("found is unknown without a log, yes only when a Sphica result names a gold record", () => {
  const gold = ["harvest:157/keep-search"];
  assert.equal(foundInCodexEvents(null, gold), "unknown");
  const call = (tool: string, text: string) =>
    JSON.stringify({
      type: "item.completed",
      item: { type: "mcp_tool_call", server: "sphica", tool, result: { content: [{ type: "text", text }] } },
    });
  assert.equal(foundInCodexEvents(call("search", "## other/key (u2)"), gold), "no");
  assert.equal(foundInCodexEvents(call("search", "## harvest:157/keep-search (u1): decision"), gold), "yes");
  assert.equal(
    foundInCodexEvents(call("status", "harvest:157/keep-search"), gold),
    "no",
    "only search and read count",
  );
  assert.equal(foundInClaudeLog(null, gold), "unknown");
  assert.equal(foundInClaudeLog("tool_use mcp__sphica__search\ntool_result ok ## other", gold), "no");
  assert.equal(
    foundInClaudeLog('tool_result: <past-records id="a"> ## harvest:157/keep-search (u1)', gold),
    "yes",
  );
  assert.equal(
    foundInClaudeLog("tool_use Bash: cat note\ntool_result: harvest:157/keep-search", gold),
    "no",
    "a result that is not a Sphica record set does not count",
  );
  assert.equal(foundInCodexEvents("{bad json", gold), "unknown", "a log with no readable event cannot tell");
  assert.equal(foundInCodexEvents("", gold), "unknown");
  assert.equal(
    foundInCodexEvents('{"type":"thread.started"}\n{bad json', gold),
    "unknown",
    "a log broken partway cannot prove no",
  );
});

test("inherited property names are extra keys, not allowed ones", () => {
  assert.equal(checkGrade({ ...grade, constructor: 1 }).ok, false);
  assert.equal(
    checkAnswer(
      JSON.parse('{"implemented":true,"summary":"s","past_decisions":[],"unverified":[],"__proto__":1}'),
    ).ok,
    false,
  );
});

test("delivered is judged per condition: inject by emitted units, gold by what the hook returned", () => {
  const gold = ["trace:s1/utc"];
  assert.equal(deliveredSignal("none", gold, [], null), "not_applicable");
  assert.equal(deliveredSignal("search", gold, [], null), "not_applicable");
  assert.equal(deliveredSignal("inject", gold, ["trace:s1/other"], null), "no");
  assert.equal(deliveredSignal("inject", gold, ["trace:s1/utc"], null), "yes");
  assert.equal(deliveredSignal("gold", gold, [], null), "no");
  assert.equal(
    deliveredSignal("gold", gold, [], "Sphica past record ...: trace:s1/utc (constraint): Store UTC"),
    "yes",
  );
});

test("a Codex answer is valid, invalid with the reason, or empty; valid answers render to text for the grader", () => {
  assert.deepEqual(answerFormat(null).format, "refused_or_empty");
  assert.deepEqual(answerFormat("  ").format, "refused_or_empty");
  const invalid = answerFormat('{"implemented": "yes"}');
  assert.equal(invalid.format, "invalid");
  assert.match(invalid.reason ?? "", /implemented/);
  assert.equal(invalid.text, '{"implemented": "yes"}');
  const valid = answerFormat(
    JSON.stringify({
      implemented: false,
      summary: "Kept search as it is.",
      past_decisions: [{ ref: "harvest:157/keep-search", how_used: "followed" }],
      unverified: ["no new measurement"],
    }),
  );
  assert.equal(valid.format, "valid");
  assert.match(valid.text, /Kept search as it is\./);
  assert.match(valid.text, /harvest:157\/keep-search \(followed\)/);
  assert.match(valid.text, /no new measurement/);
});

test("a long patch is cut with a mark, and a short one is kept whole", () => {
  assert.deepEqual(capPatch("diff a"), { patch: "diff a", truncated: false });
  const cut = capPatch("x".repeat(200_000));
  assert.equal(cut.truncated, true);
  assert.ok(cut.patch.length <= 60_000 + 100);
});

// Every started Codex run stays in the loop: one that never wrote result.json, and one whose Codex process failed, become excluded rows
test("collect keeps a started run without a result, and a failed run, as excluded rows", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-collect-"));
  try {
    const build = path.join(base, "build");
    const codex = path.join(base, "codex");
    fs.mkdirSync(build);
    fs.writeFileSync(path.join(build, "manifest.json"), JSON.stringify({ commit: "c", repositories: {} }));
    seedTasks(build);
    const run = (name: string, files: Record<string, unknown>) => {
      fs.mkdirSync(path.join(codex, name), { recursive: true });
      for (const [f, v] of Object.entries(files))
        fs.writeFileSync(path.join(codex, name, f), JSON.stringify(v));
    };
    const head = { task: "sphica-search-wording", condition: "inject" };
    run("stopped", { "started.json": head });
    run("failed", {
      "started.json": head,
      "result.json": { ...head, status: 1, reason: "timed out", seconds: 1 },
    });
    run("partial", { "started.json": head });
    fs.writeFileSync(path.join(codex, "partial", "result.json"), "{");
    run("after", {
      "started.json": head,
      "result.json": { ...head, status: 0, reason: "git add failed", seconds: 1, deliveries: [] },
    });
    run("noevents", {
      "started.json": { ...head, condition: "none" },
      "result.json": {
        ...head,
        condition: "none",
        status: 0,
        reason: null,
        seconds: 1,
        deliveries: null,
        fence: FENCE,
      },
    });
    const out = path.join(build, "loop.json");
    execFileSync(
      process.execPath,
      [
        path.join(import.meta.dirname, "..", "evals", "cloud", "collect.ts"),
        "--build",
        build,
        "--codex",
        codex,
        "--logs",
        base,
      ],
      { stdio: "ignore", env: childEnv(base) },
    );
    const all = JSON.parse(fs.readFileSync(out, "utf8")).rows as {
      run: string;
      excluded: string | null;
      signals: unknown;
    }[];
    assert.equal(
      all.find((r) => r.run === "noevents")?.signals,
      null,
      "no event log: counters unknown, not 0",
    );
    const rows = all.filter((r) => r.run !== "noevents");
    assert.deepEqual(rows.map((r) => [r.run, r.excluded]).sort(), [
      ["after", "git add failed"],
      ["failed", "timed out"],
      ["partial", "unreadable result.json"],
      ["stopped", "no result.json (the run stopped before it finished)"],
    ]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

const task = {
  id: "sphica-search-wording",
  prompt: "検索で言い回しが違うと当たらないので、当たるようにしてほしい",
  expect: "A good run does not ship one of them without new measurements.",
  against: "search gains trigram tokenization",
};
const row = {
  model: "codex" as const,
  fence: FENCE,
  answer_format: "valid" as "valid" | "invalid" | "refused_or_empty" | "not_applicable",
  task: task.id,
  condition: "inject",
  run: "r1",
  excluded: null,
  answer: "Kept search as it is.",
  patch: "diff --git a/server/src/search.ts b/server/src/search.ts",
  patch_truncated: false,
  delivered: "yes" as const,
  found: "yes" as const,
};

test("the grader sees the task, expect, against, answer, and patch, never the model or the condition", () => {
  const prompt = blindPrompt(task, row);
  for (const part of [task.prompt, task.expect, task.against, row.answer, row.patch])
    assert.ok(prompt.includes(part), part);
  assert.doesNotMatch(prompt, /\b(codex|claude|inject|gold|condition)\b/i);
  assert.match(blindPrompt(task, { ...row, patch_truncated: true }), /cut/);
});

test("a grade is counted only from a zero exit and a valid shape; anything else is ungraded with the reason", () => {
  const good = JSON.stringify(grade);
  assert.deepEqual(receiveGrade({ status: 0, output: good }, false, true), { graded: grade });
  assert.match(
    (receiveGrade({ status: 1, output: good }, false, true) as { ungraded: string }).ungraded,
    /exit/,
  );
  assert.match(
    (receiveGrade({ status: 0, output: "" }, false, true) as { ungraded: string }).ungraded,
    /empty/,
  );
  assert.match(
    (receiveGrade({ status: 0, output: "Score: 2" }, false, true) as { ungraded: string }).ungraded,
    /JSON/,
  );
  assert.match(
    (
      receiveGrade({ status: 0, output: JSON.stringify({ ...grade, score: 5 }) }, false, true) as {
        ungraded: string;
      }
    ).ungraded,
    /score/,
  );
  // A cut patch cannot show that nothing matches: "no" becomes unknown
  const cut = receiveGrade({ status: 0, output: good }, true, true) as { graded: typeof grade };
  assert.equal(cut.graded.implements_rejected, "unknown");
  assert.equal(cut.graded.proposes_rejected, "unknown");
  // not_applicable only when the task has no "Against", and only then
  const na = JSON.stringify({
    ...grade,
    implements_rejected: "not_applicable",
    proposes_rejected: "not_applicable",
  });
  assert.match(
    (receiveGrade({ status: 0, output: na }, false, true) as { ungraded: string }).ungraded,
    /not_applicable/,
  );
  assert.match(
    (receiveGrade({ status: 0, output: good }, false, false) as { ungraded: string }).ungraded,
    /not_applicable/,
  );
  assert.deepEqual(receiveGrade({ status: 0, output: na }, false, false), {
    graded: { ...grade, implements_rejected: "not_applicable", proposes_rejected: "not_applicable" },
  });
  // followed is judged only when an earlier record was shown, and then always
  assert.match(
    (receiveGrade({ status: 0, output: good }, false, true, true) as { ungraded: string }).ungraded,
    /followed/,
  );
  const followed = JSON.stringify({ ...grade, followed: "presented" });
  assert.deepEqual(receiveGrade({ status: 0, output: followed }, false, true, true), {
    graded: { ...grade, followed: "presented" },
  });
  assert.match(
    (receiveGrade({ status: 0, output: followed }, false, true, false) as { ungraded: string }).ungraded,
    /followed/,
  );
});

test("the table counts every started run and the tracked failure per model and condition", () => {
  const table = tabulate([
    { ...row, grade: { ...grade, score: 0, implements_rejected: "yes" } },
    { ...row, run: "r2", grade: { ...grade, implements_rejected: "no" } },
    { ...row, run: "r3", found: "unknown", delivered: "no", grade: { ...grade, implements_rejected: "yes" } },
    { ...row, run: "r4", ungraded: "empty output" },
    { ...row, run: "r5", excluded: "timed out" },
  ]);
  const formats = tabulate([
    { ...row, answer_format: "invalid", grade },
    { ...row, run: "r2", answer_format: "refused_or_empty", ungraded: "empty output" },
    { ...row, run: "r3", answer_format: "valid", excluded: "timed out" },
  ]).find((c) => c.model === "codex");
  assert.deepEqual(
    formats?.answer_format,
    { valid: 0, invalid: 1, refused_or_empty: 1, not_applicable: 0 },
    "answer formats are counted over runs not excluded",
  );
  const cell = table.find((c) => c.model === "codex" && c.condition === "inject");
  assert.ok(cell);
  assert.equal(cell.started, 5);
  assert.equal(cell.excluded, 1);
  assert.equal(cell.ungraded, 1);
  assert.equal(cell.graded, 3);
  assert.deepEqual(cell.scores, { 0: 1, 1: 0, 2: 2 });
  assert.equal(cell.tracked_failure, 1, "delivered or found, and implements the rejected change");
  assert.equal(cell.found.unknown, 1);
  assert.deepEqual(
    cell.delivered,
    { yes: 3, no: 1, not_applicable: 0 },
    "an ungraded run keeps its observed signals",
  );
});

test("collect refuses a build with slots but no firing plan, since fired runs without a branch would vanish", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-collect-"));
  try {
    const build = path.join(base, "build");
    fs.mkdirSync(build);
    fs.writeFileSync(
      path.join(build, "manifest.json"),
      JSON.stringify({ commit: "c", repositories: { "eval-shelf-1": { condition: "none" } } }),
    );
    seedTasks(build);
    const r = spawnSync(
      process.execPath,
      [
        path.join(import.meta.dirname, "..", "evals", "cloud", "collect.ts"),
        "--build",
        build,
        "--codex",
        base,
        "--logs",
        base,
      ],
      { encoding: "utf8", env: childEnv(base) },
    );
    assert.match(r.stderr, /no firing plan at .*plan\.json/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// Fired rows are the denominator: each takes the earliest unpaired result of its task and condition; unfired rows are not asked for
test("the firing plan pairs results by task and condition in firing order, and keeps a fired row with no result", () => {
  const row = (task: string, condition: string, n: number, fired: string | null): FiringRow => ({
    build: "b",
    variant: "original",
    task,
    condition,
    slot: "eval-shelf-1",
    try: n,
    prompt: task,
    fired_at: fired,
  });
  const plan = [
    row("a", "none", 1, "2026-09-30T00:00:01.000Z"),
    row("a", "none", 2, "2026-09-30T00:00:02.000Z"),
    row("b", "none", 1, "2026-09-30T00:00:03.000Z"),
    row("b", "inject", 1, null),
  ];
  const result = (task: string, condition: string, started: string) => ({ task, condition, started });
  const { matched, missing, unplanned } = pair(plan, [
    result("a", "none", "2026-09-30T00:01:02.000Z"),
    result("a", "none", "2026-09-30T00:01:01.000Z"),
    result("c", "none", "2026-09-30T00:01:03.000Z"),
  ]);
  assert.deepEqual(
    matched.map(([f, r]) => [f.task, f.try, r.started]),
    [
      ["a", 1, "2026-09-30T00:01:01.000Z"],
      ["a", 2, "2026-09-30T00:01:02.000Z"],
    ],
  );
  assert.deepEqual(
    missing.map((f) => [f.task, f.condition, f.try]),
    [["b", "none", 1]],
  );
  assert.deepEqual(
    unplanned.map((r) => r.task),
    ["c"],
  );
});

test("the grader runs with its own HOME and CODEX_HOME holding only the login and the model settings", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-grade-"));
  try {
    // A fake owner home, and a fake codex first on PATH that records what it was started with
    const owner = path.join(base, "owner");
    fs.mkdirSync(path.join(owner, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(owner, ".codex", "auth.json"), "{}");
    fs.writeFileSync(
      path.join(owner, ".codex", "config.toml"),
      'model = "m"\n[mcp_servers.x]\ncommand = "x"\n',
    );
    fs.writeFileSync(path.join(owner, ".codex", "hooks.json"), "{}");
    const bin = path.join(base, "bin");
    fs.mkdirSync(bin);
    const seen = path.join(base, "seen");
    fs.writeFileSync(
      path.join(bin, "codex"),
      `#!/bin/sh
{ echo "HOME=$HOME"; echo "CODEX_HOME=$CODEX_HOME"; ls "$CODEX_HOME"; cat "$CODEX_HOME/config.toml"; } > ${JSON.stringify(seen)}
while [ "$1" != "-o" ]; do shift; done
printf '%s' ${JSON.stringify(JSON.stringify({ ...grade }))} > "$2"
`,
      { mode: 0o755 },
    );
    // A fake claude that records how it was started and answers with the grade as structured output
    const claudeSeen = path.join(base, "claude-seen");
    fs.writeFileSync(
      path.join(bin, "claude"),
      `#!/bin/sh
{ pwd; for a in "$@"; do printf '[%s]\\n' "$a"; done; } > ${JSON.stringify(claudeSeen)}
cat > /dev/null
printf '%s' ${JSON.stringify(JSON.stringify({ type: "result", structured_output: { ...grade, score: 1 } }))}
`,
      { mode: 0o755 },
    );
    const cache = path.join(owner, ".cache", "sphica-eval");
    const build = path.join(cache, "builds", "b");
    fs.mkdirSync(build, { recursive: true });
    const loop = path.join(build, "loop.json");
    fs.writeFileSync(
      loop,
      JSON.stringify({
        bundle: "c",
        run_roots: [path.join(cache, "codex-runs")],
        rows: [{ ...row, answer_format: "valid" }],
      }),
    );
    seedTasks(build);
    const r = spawnSync(
      process.execPath,
      [path.join(import.meta.dirname, "..", "evals", "cloud", "grade.ts"), "--loop", loop],
      {
        encoding: "utf8",
        env: {
          ...tmpEnv(),
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          HOME: owner,
          CODEX_HOME: path.join(base, "sentinel"),
        },
      },
    );
    assert.equal(r.status, 0, r.stderr);
    const got = fs.readFileSync(seen, "utf8");
    assert.doesNotMatch(got, /sentinel/);
    assert.doesNotMatch(got, new RegExp(`HOME=${owner}\\n`));
    assert.match(got, /^auth\.json$/m);
    assert.match(got, /^config\.toml$/m);
    assert.doesNotMatch(got, /hooks\.json|mcp_servers/);
    assert.match(got, /model = "m"/);
    // The second grader starts in an empty directory with no settings sources, MCP servers, tools, or skills
    const started = fs.readFileSync(claudeSeen, "utf8");
    assert.doesNotMatch(started.split("\n")[0] ?? "", new RegExp(owner));
    for (const a of [
      "[--setting-sources]\n[]",
      "[--strict-mcp-config]",
      "[--tools]\n[]",
      "[--disable-slash-commands]",
    ])
      assert.ok(started.includes(a), a);
    const out = JSON.parse(fs.readFileSync(path.join(build, "grades.json"), "utf8"));
    assert.equal(out.rows[0].grade.score, 2, "the table keeps Codex's grade");
    assert.equal(out.rows[0].second.grade.score, 1);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// Per gold key, a search result, a read, and a delivery are told apart; a result that could belong to either tool says unknown, not no
test("gold signals separate delivery, search, and read, and stay unknown when a result cannot be tied to its call", () => {
  const key = "harvest:157/keep-search";
  const search = `## ${key} (u1): decision do, active`;
  const read = `<past-records id="a">\n${key} (u1, revision 3): decision do, active`;
  const call = (tool: string, text: string) =>
    JSON.stringify({
      type: "item.completed",
      item: { type: "mcp_tool_call", server: "sphica", tool, result: { content: [{ type: "text", text }] } },
    });
  assert.deepEqual(goldSignalsFromCodex("search", [key], [], null, call("search", search))[key], {
    in_delivery: "not_applicable",
    in_search: "yes",
    read: "no",
  });
  assert.deepEqual(goldSignalsFromCodex("inject", [key], [key], null, call("read", read))[key], {
    in_delivery: "yes",
    in_search: "no",
    read: "yes",
  });
  assert.deepEqual(goldSignalsFromCodex("search", [key], [], null, "{bad json")[key], {
    in_delivery: "not_applicable",
    in_search: "unknown",
    read: "unknown",
  });
  const use = (tool: string) => `[t] tool_use mcp__sphica__${tool}: {}`;
  const result = (text: string) => `[t] tool_result: ${text.replaceAll("\n", " ")}`;
  assert.deepEqual(
    goldSignalsFromClaude(
      "gold",
      [key],
      [],
      `...${key}...`,
      [use("search"), result(search), use("read"), result(read)].join("\n"),
    )[key],
    { in_delivery: "yes", in_search: "yes", read: "yes" },
  );
  // Two different calls waiting: the result cannot be tied to one of them
  assert.deepEqual(
    goldSignalsFromClaude(
      "search",
      [key],
      [],
      null,
      [use("search"), use("read"), result(search), result("nothing")].join("\n"),
    )[key],
    { in_delivery: "not_applicable", in_search: "unknown", read: "unknown" },
  );
  // Two searches waiting: whichever it answers, it is a search
  assert.deepEqual(
    goldSignalsFromClaude(
      "search",
      [key],
      [],
      null,
      [use("search"), use("search"), result("none"), result(search)].join("\n"),
    )[key],
    { in_delivery: "not_applicable", in_search: "yes", read: "no" },
  );
  assert.deepEqual(goldSignalsFromClaude("none", [key], [], null, null)[key], {
    in_delivery: "not_applicable",
    in_search: "unknown",
    read: "unknown",
  });
});

// Review of the gold signals: every case where the log cannot say must come out unknown, and a quoted heading is not a result
test("gold signals say unknown when the log cannot tie a result to its call or is incomplete, and ignore quoted headings", () => {
  const key = "harvest:157/keep-search";
  const heading = `## ${key} (u1): decision do, active`;
  const use = (tool: string) => `[t] tool_use ${tool}: {}`;
  const result = (text: string) => `[t] tool_result: ${text}`;
  const unknown = { in_delivery: "not_applicable", in_search: "unknown", read: "unknown" };
  // A read and a search waiting: the read's empty result first cannot make the search's hit a "no"
  assert.deepEqual(
    goldSignalsFromClaude(
      "search",
      [key],
      [],
      null,
      [use("mcp__sphica__search"), use("mcp__sphica__read"), result("nothing"), result(heading)].join("\n"),
    )[key],
    unknown,
  );
  // Another tool's result is not a Sphica result
  assert.notEqual(
    goldSignalsFromClaude(
      "search",
      [key],
      [],
      null,
      [use("mcp__sphica__search"), use("Bash"), result("no match"), result(heading)].join("\n"),
    )[key]?.in_search,
    "yes",
  );
  // An empty log, or a call whose result is missing, cannot prove no
  assert.deepEqual(goldSignalsFromClaude("search", [key], [], null, "")[key], unknown);
  assert.deepEqual(
    goldSignalsFromClaude("search", [key], [], null, use("mcp__sphica__search"))[key],
    unknown,
  );
  // Codex: a heading quoted inside another record's body is not a hit; broken events cannot prove no
  const call = (tool: string, text: string | null) =>
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        server: "sphica",
        tool,
        ...(text === null ? {} : { result: { content: [{ type: "text", text }] } }),
      },
    });
  assert.equal(
    goldSignalsFromCodex(
      "search",
      [key],
      [],
      null,
      call("search", `## other/key (u2): decision\nIt says "${heading}" in a quote`),
    )[key]?.in_search,
    "no",
  );
  assert.deepEqual(goldSignalsFromCodex("search", [key], [], null, call("search", null))[key], unknown);
  assert.deepEqual(goldSignalsFromCodex("search", [key], [], null, "42")[key], unknown);
  assert.deepEqual(goldSignalsFromCodex("search", [key], [], null, "null")[key], unknown);
});

// A broken line leaves "no" unprovable, but a result that named the key still proves "yes", before or after the break
test("a proven hit in a Codex log stays yes when another line is broken", () => {
  const key = "harvest:157/keep-search";
  const other = "trace:other/key";
  const call = (tool: string, text: string | null) =>
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        server: "sphica",
        tool,
        ...(text === null ? {} : { result: { content: [{ type: "text", text }] } }),
      },
    });
  const hits = {
    search: call("search", `## ${key} (u1): decision do, active`),
    read: call("read", `${key} (u1, revision 3): decision do, active`),
  };
  const field = { search: "in_search", read: "read" } as const;
  for (const broken of ["{bad json", "42", call("search", null)])
    for (const tool of ["search", "read"] as const)
      for (const lines of [
        [hits[tool], broken],
        [broken, hits[tool]],
      ]) {
        const got = goldSignalsFromCodex("search", [key, other], [], null, lines.join("\n"));
        assert.equal(got[key]?.[field[tool]], "yes", `${tool} hit with ${broken} in ${lines.join(" | ")}`);
        const otherTool = tool === "search" ? "read" : "search";
        assert.equal(got[key]?.[field[otherTool]], "unknown", "an unproven tool stays unknown");
        assert.equal(got[other]?.in_search, "unknown", "an unproven key stays unknown");
        assert.equal(got[other]?.read, "unknown", "an unproven key stays unknown");
      }
});

// Gold counts as given only when each gold key opens a delivery line: a longer key or a mention in a body is another record
test("a gold record counts as given only by its own delivery line in the hook's context", () => {
  const key = "trace:a/b";
  const hook = (context: string) =>
    JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } });
  const lead = "Active decisions from this project's history:";
  assert.equal(goldNotGiven("gold", [key], hook(`${lead}\n- ${key} (decision do): Keep it.`)), false);
  assert.equal(goldNotGiven("gold", [key], `${hook(`${lead}\n- ${key} (decision do): Keep it.`)}\n`), false);
  assert.equal(goldNotGiven("gold", [key], hook(`${lead}\n- ${key}-extra (decision do): Other.`)), true);
  assert.equal(
    goldNotGiven("gold", [key], hook(`${lead}\n- trace:c/d (decision do): Unlike ${key} (u1).`)),
    true,
  );
  assert.equal(
    goldNotGiven("gold", [key, "trace:c/d"], hook(`${lead}\n- ${key} (decision do): Keep it.`)),
    true,
  );
  assert.equal(goldNotGiven("gold", [key], null), true);
  assert.equal(goldNotGiven("gold", [key], ""), true);
  assert.equal(goldNotGiven("inject", [key], null), false, "only the gold condition gives through the hook");
});

// A gold run is graded as shown the record only when its hook returned it; otherwise the gold condition never applied
test("collect excludes a gold run when the gold hook returned no record, and keeps presented for one that did", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-collect-"));
  try {
    const build = path.join(base, "build");
    const codex = path.join(base, "codex");
    const slot = path.join(build, "eval-shelf-1");
    fs.mkdirSync(build);
    // The gold slot is fetched for cloud branches: a local bare origin with none keeps it off the network
    execFileSync("git", ["init", "-q", "--bare", path.join(base, "origin.git")], { env: childEnv(base) });
    execFileSync("git", ["clone", "-q", path.join(base, "origin.git"), slot], {
      stdio: "ignore",
      env: childEnv(base),
    });
    const text = "Active decisions:\n- trace:s-en-dates/utc (decision do): Store dates in UTC.";
    fs.mkdirSync(path.join(slot, ".tools"));
    fs.writeFileSync(path.join(slot, ".tools", "gold.json"), JSON.stringify([{ id: "pilot-dates", text }]));
    fs.writeFileSync(
      path.join(build, "manifest.json"),
      JSON.stringify({ build: "b", commit: "c", repositories: { "eval-shelf-1": { condition: "gold" } } }),
    );
    fs.writeFileSync(path.join(build, "plan.json"), "[]");
    seedTasks(build);
    const head = { build: "b", task: "pilot-dates", condition: "gold" };
    const run = (name: string, receipt: string | null) => {
      fs.mkdirSync(path.join(codex, name, "work"), { recursive: true });
      fs.writeFileSync(path.join(codex, name, "started.json"), JSON.stringify(head));
      fs.writeFileSync(
        path.join(codex, name, "result.json"),
        JSON.stringify({ ...head, status: 0, reason: null, seconds: 1, deliveries: null, fence: FENCE }),
      );
      if (receipt !== null) fs.writeFileSync(path.join(codex, name, "gold-receipt.txt"), receipt);
    };
    const hook = (context: string) =>
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
      });
    run("missing", null);
    run("empty", "");
    run("unrelated", hook("## trace:other/key (u2): decision do, active"));
    run("named", hook(text));
    execFileSync(
      process.execPath,
      [
        path.join(import.meta.dirname, "..", "evals", "cloud", "collect.ts"),
        "--build",
        build,
        "--codex",
        codex,
        "--logs",
        base,
        "--skip-hidden-tests",
      ],
      { stdio: "ignore", env: childEnv(base) },
    );
    const rows = JSON.parse(fs.readFileSync(path.join(build, "loop.json"), "utf8")).rows as {
      run: string;
      excluded: string | null;
      presented: string | null;
    }[];
    assert.deepEqual(rows.map((r) => [r.run, r.excluded, r.presented]).sort(), [
      ["empty", "gold hook returned no record", null],
      ["missing", "gold hook returned no record", null],
      ["named", null, text],
      ["unrelated", "gold hook returned no record", null],
    ]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// A swapped build's runs are judged against the swapped record: its gold is that record, and the original rule's hidden test is not run
test("collect reads a swapped build's gold from the swapped record and does not run the hidden test", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-collect-"));
  try {
    const build = path.join(base, "build");
    const codex = path.join(base, "codex");
    fs.mkdirSync(build);
    fs.writeFileSync(
      path.join(build, "manifest.json"),
      JSON.stringify({ build: "b", variant: "swapped", commit: "c", repositories: {} }),
    );
    seedTasks(build);
    const head = { build: "b", task: "pilot-dates", condition: "gold" };
    fs.mkdirSync(path.join(codex, "sw", "work"), { recursive: true });
    fs.writeFileSync(path.join(codex, "sw", "started.json"), JSON.stringify(head));
    fs.writeFileSync(
      path.join(codex, "sw", "result.json"),
      JSON.stringify({ ...head, status: 0, reason: null, seconds: 1, deliveries: null, fence: FENCE }),
    );
    fs.writeFileSync(
      path.join(codex, "sw", "gold-receipt.txt"),
      "- trace:s-en-dates-local/local (decision do): Keep local dates.",
    );
    const out = path.join(build, "loop.json");
    execFileSync(
      process.execPath,
      [
        path.join(import.meta.dirname, "..", "evals", "cloud", "collect.ts"),
        "--build",
        build,
        "--codex",
        codex,
        "--logs",
        base,
      ],
      { stdio: "ignore", env: childEnv(base) },
    );
    const loop = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(loop.variant, "swapped");
    assert.deepEqual(loop.rows[0].gold, ["trace:s-en-dates-local/local"]);
    assert.equal(loop.rows[0].tests, "not run (swapped variant)");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// Review of the build id and firing plan
test("a run's task comes from the prompt the build planned, even after tasks.json changed its wording", () => {
  const row: FiringRow = {
    build: "b",
    variant: "original",
    task: "pilot-dates",
    condition: "none",
    slot: "eval-shelf-1",
    try: 1,
    prompt: "an older wording of the prompt",
    fired_at: null,
  };
  assert.equal(taskFromReceipts('{"prompt":"an older wording of the prompt"}', [row], []), "pilot-dates");
  assert.equal(
    taskFromReceipts('{"prompt":"the current wording"}', [], [{ id: "t", prompt: "the current wording" }]),
    "t",
  );
  assert.equal(taskFromReceipts("{}", [row], [{ id: "t", prompt: "the current wording" }]), undefined);
});

test("collect leaves out Codex runs of another build, and build refuses an output directory that already exists or is outside the cache", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-collect-"));
  try {
    const build = path.join(base, ".cache", "sphica-eval", "builds", "b");
    const codex = path.join(base, "codex");
    fs.mkdirSync(build, { recursive: true });
    fs.writeFileSync(
      path.join(build, "manifest.json"),
      JSON.stringify({ build: "b", commit: "c", repositories: {} }),
    );
    seedTasks(build);
    for (const [name, id] of [
      ["mine", "b"],
      ["theirs", "a"],
    ] as const) {
      fs.mkdirSync(path.join(codex, name), { recursive: true });
      fs.writeFileSync(
        path.join(codex, name, "started.json"),
        JSON.stringify({ build: id, task: "pilot-sort", condition: "none" }),
      );
    }
    const out = path.join(build, "loop.json");
    execFileSync(
      process.execPath,
      [
        path.join(import.meta.dirname, "..", "evals", "cloud", "collect.ts"),
        "--build",
        build,
        "--codex",
        codex,
        "--logs",
        base,
      ],
      { stdio: "ignore", env: childEnv(base) },
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(out, "utf8")).rows.map((r: { run: string }) => r.run),
      ["mine"],
    );
    const again = spawnSync(
      process.execPath,
      [
        path.join(import.meta.dirname, "..", "evals", "cloud", "build.ts"),
        "--project",
        "tsundoku",
        "--out",
        build,
      ],
      { encoding: "utf8", env: childEnv(base) },
    );
    assert.match(again.stderr, /already exists/);
    assert.ok(fs.existsSync(path.join(build, "manifest.json")), "the earlier build is kept");
    // A build outside the cache would outlive the lock where a fenced Codex can read it
    const outside = spawnSync(
      process.execPath,
      [
        path.join(import.meta.dirname, "..", "evals", "cloud", "build.ts"),
        "--project",
        "tsundoku",
        "--out",
        path.join(base, "elsewhere"),
      ],
      { encoding: "utf8", env: childEnv(base) },
    );
    assert.match(outside.stderr, /--out must be inside/);
    assert.ok(!fs.existsSync(path.join(base, "elsewhere")));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// The schema files are written from the zod schemas, and Codex's strict mode wants every object closed with every key required
test("the schema files are what the zod schemas write, and every object in them is closed with all keys required", () => {
  for (const [name, schema] of Object.entries(SCHEMA_FILES)) {
    const file = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, "..", "evals", "cloud", name), "utf8"),
    );
    assert.deepEqual(
      file,
      jsonSchemaOf(schema),
      `${name} is stale: run node evals/cloud/schema-check.ts --write`,
    );
    const objects = (v: unknown): Record<string, unknown>[] =>
      typeof v !== "object" || v === null
        ? []
        : [
            ...((v as { type?: string }).type === "object" ? [v as Record<string, unknown>] : []),
            ...Object.values(v).flatMap(objects),
          ];
    for (const o of objects(file)) {
      assert.equal(o.additionalProperties, false, name);
      assert.deepEqual(
        [...(o.required as string[])].sort(),
        Object.keys(o.properties as object).sort(),
        name,
      );
    }
  }
});

// The loop report: every group keeps its n and its runs, gold minus inject is per task and model, and agreement lists each disagreement
test("the report splits by group, lists gold minus inject per task with every run, and counts re-proposals, the counterfactual, and agreement", () => {
  const g = (over: Partial<Grade>): Grade => ({ ...grade, ...over });
  const base = { ...row, task: "t1", presented: null };
  const rows = [
    {
      ...base,
      run: "g1",
      condition: "gold",
      grade: g({ score: 2, followed: "presented" }),
      second: { grade: g({ score: 2 }) },
    },
    {
      ...base,
      run: "g2",
      condition: "gold",
      grade: g({ score: 1, followed: "presented" }),
      second: { grade: g({ score: 0 }) },
    },
    {
      ...base,
      run: "i1",
      condition: "inject",
      grade: g({ score: 0, proposes_rejected: "yes", implements_rejected: "yes" }),
    },
    { ...base, run: "i2", condition: "inject", excluded: "no result branch" },
    {
      ...base,
      run: "i3",
      condition: "inject",
      grade: g({ score: 1 }),
      gold_signals: {
        "k/1": { in_delivery: "yes" as const, in_search: "unknown" as const, read: "no" as const },
      },
    },
  ];
  const swapped = [{ ...base, run: "s1", condition: "gold", grade: g({ followed: "other" }) }];
  const out = report(
    [
      { variant: "original", rows },
      { variant: "swapped", rows: swapped },
    ],
    [{ id: "t1", lang: "ja>en", overlap: false, gold: ["k/1"] }],
    ["t1"],
  ).join("\n");
  assert.match(
    out,
    /codex inject: n 3 \(excluded 1, ungraded 0\), mean score 0\.50 \[0 1\], tracked failure 1/,
  );
  assert.match(out, /codex gold ja>en: n 2/);
  assert.match(out, /codex inject no overlap: n 3/);
  assert.match(
    out,
    /t1 codex: gold n 2 \(g1 2, g2 1\) inject n 3 \(i1 0, i2 excluded, i3 1\), difference of mean scores 1\.00 \(preliminary/,
  );
  assert.match(out, /codex inject: 1 \/ 2 \(0\.50, unknown 0\)\n/);
  assert.match(out, /t1 codex gold original: n 2, presented 2, other 0/);
  assert.match(out, /t1 codex gold swapped: n 1, presented 0, other 1/);
  assert.match(out, /runs by codex: 0 \/ 5 agree on every graded field \(Claude.s grade missing 3\)/);
  assert.match(out, /g2 \(t1 gold\): score 1 vs 0; followed presented vs not_applicable \(Codex vs Claude\)/);
  assert.match(
    out,
    /codex inject k\/1: delivered 1\/0\/0\/0, search 0\/0\/1\/0, read 0\/1\/0\/0, excluded 0/,
  );
});

// Review of the counterfactual grading: only a run that was shown the record is judged on following it, and a swapped run is judged on
// the record it was shown, never on the original task's expectation
test("presented is given only to runs shown the record, and a swapped run is graded against the record it was shown", () => {
  const shown = [{ id: "pilot-dates", text: "- trace:x/local (constraint do): Store local time" }];
  const counterfactual = { "pilot-dates": ["trace:x/local"] };
  assert.equal(presentedText("pilot-dates", "gold", shown, counterfactual), shown[0]?.text);
  assert.equal(presentedText("pilot-dates", "none", shown, counterfactual), null);
  assert.equal(presentedText("pilot-sort", "gold", shown, counterfactual), null);
  const t = { ...task, expect: "keeps UTC", against: "stores local time" };
  const swappedPrompt = blindPrompt(gradedTask(t, "swapped"), { ...row, presented: shown[0]?.text ?? null });
  assert.doesNotMatch(swappedPrompt, /keeps UTC|stores local time/);
  assert.match(swappedPrompt, /Store local time/);
  assert.equal(gradedTask(t, "swapped").against, undefined);
  assert.deepEqual(gradedTask(t, "original"), t);
});

// Review of the report: every run of gold minus inject is named with its grade, agreement covers every graded field, and a counterfactual
// side with no graded run still shows how many runs it had
test("the report names each run in gold minus inject, compares every graded field, and keeps an ungraded counterfactual side", () => {
  const g = (over: Partial<Grade>): Grade => ({ ...grade, ...over });
  const base = { ...row, task: "t1", presented: null };
  const rows = [
    {
      ...base,
      run: "g1",
      condition: "gold",
      presented: "rec",
      grade: g({ score: 2, followed: "presented" }),
      second: { grade: g({ score: 2, followed: "other" }) },
    },
    { ...base, run: "g2", condition: "gold", presented: "rec", ungraded: "empty output" },
    { ...base, run: "i1", condition: "inject", grade: g({ score: 0 }) },
    { ...base, run: "i2", condition: "inject", excluded: "no result branch" },
  ];
  const swapped = [
    { ...base, run: "s1", condition: "gold", presented: "swapped rec", ungraded: "empty output" },
  ];
  const out = report(
    [
      { variant: "original", rows },
      { variant: "swapped", rows: swapped },
    ],
    [{ id: "t1", lang: "ja>en", overlap: false, gold: ["k/1"] }],
    ["t1"],
  ).join("\n");
  assert.match(out, /t1 codex: gold n 2 \(g1 2, g2 ungraded\) inject n 2 \(i1 0, i2 excluded\)/);
  assert.match(out, /runs by codex: 0 \/ 2 agree on every graded field \(Claude.s grade missing 1\)/);
  assert.match(out, /g1 \(t1 gold\): followed presented vs other/);
  assert.match(out, /t1 codex gold swapped: n 1, presented 0, other 0, neither 0, ungraded 1, excluded 0/);
});

// Review of the report: agreement covers every graded field, cited_gold and flags too
test("grader agreement counts a difference in cited_gold or flags", () => {
  const base = { ...row, task: "t1", presented: null, condition: "gold" };
  const out = report(
    [
      {
        variant: "original",
        rows: [
          {
            ...base,
            run: "c1",
            grade: { ...grade, cited_gold: "yes" },
            second: { grade: { ...grade, cited_gold: "no" } },
          },
          {
            ...base,
            run: "f1",
            grade: { ...grade, flags: ["off_task"] },
            second: { grade: { ...grade, flags: [] } },
          },
        ],
      },
    ],
    [{ id: "t1" }],
  ).join("\n");
  assert.match(out, /runs by codex: 0 \/ 2 agree/);
  assert.match(out, /c1 \(t1 gold\): cited_gold yes vs no/);
  assert.match(out, /f1 \(t1 gold\): flags off_task vs \(none\)/);
});

// fire.ts marks rows in plan order, only the condition asked for when one is given, and says when none is left
test("fire marks the next unfired row, only of the condition asked for, and reports when none is left", () => {
  const build = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-fire-"));
  try {
    const row = (task: string, condition: string): FiringRow => ({
      build: "b",
      variant: "swapped",
      task,
      condition,
      slot: condition === "gold" ? "eval-shelf-4" : "eval-shelf-1",
      try: 1,
      prompt: task,
      fired_at: null,
    });
    fs.writeFileSync(
      path.join(build, "plan.json"),
      JSON.stringify([row("a", "none"), row("a", "gold"), row("b", "gold")]),
    );
    const fire = (...extra: string[]) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [path.join(import.meta.dirname, "..", "evals", "cloud", "fire.ts"), build, ...extra],
          { encoding: "utf8", env: childEnv(build) },
        ),
      );
    assert.deepEqual([fire("--condition", "gold").task, fire("--condition", "gold").task], ["a", "b"]);
    assert.equal(fire("--condition", "gold").done, true);
    const plan = JSON.parse(fs.readFileSync(path.join(build, "plan.json"), "utf8")) as FiringRow[];
    assert.deepEqual(
      plan.map((r) => r.fired_at !== null),
      [false, true, true],
    );
    assert.equal(fire().task, "a");
    // A condition the plan does not have is refused, not reported as done
    assert.throws(() => fire("--condition", "glod"), /no rows for condition glod/);
    assert.throws(() => fire("--condition", ""), /no rows for condition/);
  } finally {
    fs.rmSync(build, { recursive: true, force: true });
  }
});

test("two Codex runs of one task and condition started in the same millisecond get their own directories", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-runs-"));
  try {
    const now = new Date("2026-09-30T04:52:09.077Z");
    const a = claimRunDir(out, "pilot-dates-search", now);
    const b = claimRunDir(out, "pilot-dates-search", now);
    assert.notEqual(a.dir, b.dir);
    assert.notEqual(a.run, b.run);
    assert.ok(a.run.startsWith("pilot-dates-search-2026-09-30T04-52-09-077Z"));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("the report counts a run Claude failed to grade as missing, and delivery signals that do not apply", () => {
  const out = report(
    [
      {
        variant: "original",
        rows: [
          {
            ...row,
            run: "m1",
            task: "t1",
            condition: "search",
            grade,
            second: { ungraded: "claude exited 1" },
            gold_signals: { "trace:a/b": { in_delivery: "not_applicable", in_search: "no", read: "no" } },
          },
        ],
      },
    ],
    [{ id: "t1" }],
  ).join("\n");
  assert.match(out, /runs by codex: 0 \/ 1 agree on every graded field \(Claude's grade missing 1\)/);
  assert.match(out, /m1 \(t1 search\): no Claude grade \(claude exited 1\)/);
  assert.match(out, /codex search trace:a\/b: delivered 0\/0\/0\/1, search 0\/1\/0\/0, read 0\/1\/0\/0/);
});

test("the report refuses builds of different bundles or task definitions", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-report-"));
  try {
    const files = ["a", "b"].map((name) => {
      fs.mkdirSync(path.join(base, name));
      seedTasks(path.join(base, name));
      const file = path.join(base, name, "grades.json");
      fs.writeFileSync(file, JSON.stringify({ build: name, variant: "original", bundle: name, rows: [] }));
      return file;
    });
    const r = spawnSync(
      process.execPath,
      [path.join(import.meta.dirname, "..", "evals", "cloud", "report.ts"), ...files],
      { encoding: "utf8", env: childEnv(base) },
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /different bundles/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the report refuses builds of one loop whose Codex runs or grades were made under different read fences", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-report-fence-"));
  try {
    const write = (name: string, variant: string, fence: string, grader: string) => {
      fs.mkdirSync(path.join(base, name));
      seedTasks(path.join(base, name));
      const file = path.join(base, name, "grades.json");
      const rows = [{ ...row, fence, grade }];
      fs.writeFileSync(
        file,
        JSON.stringify({ build: name, variant, bundle: "c {}", grader_fence: grader, rows }),
      );
      return file;
    };
    const report = (...files: string[]) =>
      spawnSync(
        process.execPath,
        [path.join(import.meta.dirname, "..", "evals", "cloud", "report.ts"), ...files],
        {
          encoding: "utf8",
          env: childEnv(base),
        },
      );
    const a = write("a", "original", FENCE, GRADER_FENCE);
    assert.match(report(a, write("b", "swapped", "0".repeat(64), GRADER_FENCE)).stderr, /read fence/);
    assert.match(report(a, write("c", "swapped", FENCE, "1".repeat(64))).stderr, /grader/);
    assert.equal(report(a, write("d", "swapped", FENCE, GRADER_FENCE)).status, 0);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// The next stage reads tasks.json beside its input, so collect and grade write only into the build directory
test("collect and grade refuse --out and write beside the build's tasks.json", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-out-"));
  try {
    const cache = path.join(base, ".cache", "sphica-eval");
    const build = path.join(cache, "builds", "b");
    const elsewhere = path.join(base, "elsewhere");
    fs.mkdirSync(build, { recursive: true });
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(
      path.join(build, "manifest.json"),
      JSON.stringify({ build: "b", commit: "c", repositories: {} }),
    );
    seedTasks(build);
    const cloud = (script: string, ...rest: string[]) =>
      spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "evals", "cloud", script), ...rest], {
        encoding: "utf8",
        env: childEnv(base),
      });
    const collectArgs = [
      "--build",
      build,
      "--codex",
      path.join(cache, "none"),
      "--logs",
      path.join(cache, "logs"),
    ];
    const collected = cloud("collect.ts", ...collectArgs, "--out", path.join(elsewhere, "loop.json"));
    assert.notEqual(collected.status, 0, "collect refuses --out");
    assert.match(collected.stderr, /Unknown option '--out'/);
    assert.equal(fs.existsSync(path.join(build, "loop.json")), false, "refused before writing");
    assert.equal(cloud("collect.ts", ...collectArgs).status, 0);
    assert.ok(fs.existsSync(path.join(build, "loop.json")), "collect writes loop.json into the build");
    const graded = cloud(
      "grade.ts",
      "--loop",
      path.join(build, "loop.json"),
      "--second",
      "none",
      "--out",
      path.join(elsewhere, "grades.json"),
    );
    assert.notEqual(graded.status, 0, "grade refuses --out");
    assert.match(graded.stderr, /Unknown option '--out'/);
    assert.equal(fs.existsSync(path.join(build, "grades.json")), false, "refused before writing");
    assert.equal(cloud("grade.ts", "--loop", path.join(build, "loop.json"), "--second", "none").status, 0);
    assert.ok(fs.existsSync(path.join(build, "grades.json")), "grade writes grades.json into the build");
    assert.deepEqual(fs.readdirSync(elsewhere), [], "nothing is written outside the build");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// Builds that all lack a bundle would compare equal, so a report could mix loops of different bundles
test("the report refuses grades files whose bundle is missing or empty", () => {
  for (const bundle of [undefined, ""]) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-report-"));
    try {
      const files = ["a", "b"].map((name) => {
        fs.mkdirSync(path.join(base, name));
        seedTasks(path.join(base, name));
        const file = path.join(base, name, "grades.json");
        fs.writeFileSync(file, JSON.stringify({ build: name, variant: "original", bundle, rows: [] }));
        return file;
      });
      const r = spawnSync(
        process.execPath,
        [path.join(import.meta.dirname, "..", "evals", "cloud", "report.ts"), ...files],
        { encoding: "utf8", env: childEnv(base) },
      );
      assert.notEqual(r.status, 0, `bundle ${JSON.stringify(bundle)}`);
      assert.match(r.stderr, /no bundle/);
      assert.ok(r.stderr.includes(files[0] ?? ""), "names the file");
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }
});

test("collect judges runs by the task definitions of their build, not the checkout's", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-collect-"));
  try {
    const build = path.join(base, "build");
    const codex = path.join(base, "codex");
    fs.mkdirSync(build);
    fs.writeFileSync(
      path.join(build, "manifest.json"),
      JSON.stringify({ build: "b", variant: "original", commit: "c", repositories: {} }),
    );
    const defs = JSON.parse(fs.readFileSync(TASKS, "utf8")) as { tasks: { id: string; gold?: string[] }[] };
    for (const t of defs.tasks) if (t.id === "sphica-search-wording") t.gold = ["trace:built/with"];
    fs.writeFileSync(path.join(build, "tasks.json"), JSON.stringify(defs));
    const head = { build: "b", task: "sphica-search-wording", condition: "none" };
    fs.mkdirSync(path.join(codex, "r", "work"), { recursive: true });
    fs.writeFileSync(path.join(codex, "r", "started.json"), JSON.stringify(head));
    fs.writeFileSync(
      path.join(codex, "r", "result.json"),
      JSON.stringify({ ...head, status: 0, reason: null, seconds: 1, deliveries: null, fence: FENCE }),
    );
    const out = path.join(build, "loop.json");
    execFileSync(
      process.execPath,
      [
        path.join(import.meta.dirname, "..", "evals", "cloud", "collect.ts"),
        "--build",
        build,
        "--codex",
        codex,
        "--logs",
        base,
      ],
      { stdio: "ignore", env: childEnv(base) },
    );
    const [got] = JSON.parse(fs.readFileSync(out, "utf8")).rows;
    assert.deepEqual(Object.keys(got.gold_signals), ["trace:built/with"]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a swapped build plans only its gold rows", () => {
  const tasks = [{ id: "t", prompt: "p", conditions: ["none", "search", "inject", "gold"] }];
  const slot = (c: string) => `slot-${c}`;
  assert.deepEqual(
    planRows("b", "swapped", tasks, 2, slot).map((r) => `${r.condition} ${r.try}`),
    ["gold 1", "gold 2"],
  );
  assert.equal(planRows("b", "original", tasks, 2, slot).length, 8);
});

test("the report refuses the same build given twice", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-report-"));
  try {
    seedTasks(base);
    const file = path.join(base, "grades.json");
    fs.writeFileSync(file, JSON.stringify({ build: "b", variant: "original", bundle: "c", rows: [] }));
    const r = spawnSync(
      process.execPath,
      [path.join(import.meta.dirname, "..", "evals", "cloud", "report.ts"), file, file],
      { encoding: "utf8", env: childEnv(base) },
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /given twice/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("collect records the bundled files' hashes with the commit, so builds of one commit with different bundles differ", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-collect-"));
  try {
    const build = path.join(base, "build");
    fs.mkdirSync(build);
    fs.writeFileSync(
      path.join(build, "manifest.json"),
      JSON.stringify({ build: "b", commit: "c", bundle: { "mcp.js": "h1" }, repositories: {} }),
    );
    seedTasks(build);
    const out = path.join(build, "loop.json");
    execFileSync(
      process.execPath,
      [
        path.join(import.meta.dirname, "..", "evals", "cloud", "collect.ts"),
        "--build",
        build,
        "--codex",
        path.join(base, "none"),
        "--logs",
        base,
      ],
      { stdio: "ignore", env: childEnv(base) },
    );
    assert.match(JSON.parse(fs.readFileSync(out, "utf8")).bundle, /^c .*h1/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the Codex replay refuses a task or condition the build did not plan, before starting a run", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-codex-"));
  try {
    const build = path.join(base, "build");
    fs.mkdirSync(build);
    fs.writeFileSync(
      path.join(build, "manifest.json"),
      JSON.stringify({ build: "b", commit: "c", repositories: { "eval-shelf-1": { condition: "none" } } }),
    );
    seedTasks(build);
    const row: FiringRow = {
      build: "b",
      variant: "original",
      task: "pilot-dates",
      condition: "none",
      slot: "eval-shelf-1",
      try: 1,
      prompt: "p",
      fired_at: null,
    };
    fs.writeFileSync(path.join(build, "plan.json"), JSON.stringify([row]));
    // A git that fails keeps a run that slips past the check from reaching the network
    const bin = path.join(base, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const runs = path.join(base, "runs");
    const r = spawnSync(
      process.execPath,
      [
        path.join(import.meta.dirname, "..", "evals", "cloud", "codex.ts"),
        "--build",
        build,
        "--repo",
        "eval-shelf-1",
        "--task",
        "sphica-search-wording",
        "--out",
        runs,
      ],
      { encoding: "utf8", env: { ...childEnv(base), PATH: `${bin}${path.delimiter}${process.env.PATH}` } },
    );
    assert.match(r.stderr, /not in the build's firing plan/);
    assert.equal(fs.existsSync(runs), false, "no run was started");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the report shows the hidden test's failures beside the score, since the grader never sees them", () => {
  const out = report(
    [
      {
        variant: "original",
        rows: [
          { ...row, run: "h1", task: "t1", condition: "none", tests: "0 passed, 1 failed", grade },
          { ...row, run: "h2", task: "t1", condition: "none", tests: "1 passed, 0 failed", grade },
          { ...row, run: "h3", task: "t1", condition: "none", tests: "none", grade },
          { ...row, run: "h4", task: "t1", condition: "none", tests: "0 passed, ? failed", grade },
        ],
      },
    ],
    [{ id: "t1" }],
  ).join("\n");
  assert.match(out, /codex none: n 4 .*hidden test failed 1 \/ 3 \(no result 1\)/);
});

test("grade refuses a second grader it does not know, before grading anything", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-grade-"));
  try {
    const bin = path.join(base, "bin");
    fs.mkdirSync(bin);
    const ran = path.join(base, "ran");
    for (const name of ["codex", "claude"])
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\ntouch ${JSON.stringify(ran)}\nexit 1\n`, {
        mode: 0o755,
      });
    seedTasks(base);
    const loop = path.join(base, "loop.json");
    fs.writeFileSync(loop, JSON.stringify({ bundle: "c", rows: [{ ...row, answer_format: "valid" }] }));
    const r = spawnSync(
      process.execPath,
      [
        path.join(import.meta.dirname, "..", "evals", "cloud", "grade.ts"),
        "--loop",
        loop,
        "--second",
        "claud",
      ],
      { encoding: "utf8", env: { ...childEnv(base), PATH: `${bin}${path.delimiter}${process.env.PATH}` } },
    );
    assert.match(r.stderr, /--second is claude or none/);
    assert.equal(fs.existsSync(ran), false, "no grader was started");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the report counts excluded runs in each gold key's signals, and refuses a build without an id", () => {
  const out = report(
    [
      {
        variant: "original",
        rows: [
          {
            ...row,
            run: "e1",
            task: "t1",
            condition: "inject",
            excluded: "no result branch",
            gold: ["trace:a/b"],
          },
          {
            ...row,
            run: "e2",
            task: "t1",
            condition: "inject",
            grade,
            gold: ["trace:a/b"],
            gold_signals: { "trace:a/b": { in_delivery: "yes", in_search: "no", read: "no" } },
          },
        ],
      },
    ],
    [{ id: "t1", gold: ["trace:a/b"] }],
  ).join("\n");
  assert.match(
    out,
    /codex inject trace:a\/b: delivered 1\/0\/0\/0, search 0\/1\/0\/0, read 0\/1\/0\/0, excluded 1/,
  );
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-report-"));
  try {
    const files = (
      [
        ["a", { build: "a", variant: "original", bundle: "c", rows: [] }],
        ["b", { variant: "original", bundle: "c", rows: [] }],
      ] as const
    ).map(([name, body]) => {
      fs.mkdirSync(path.join(base, name));
      seedTasks(path.join(base, name));
      const file = path.join(base, name, "grades.json");
      fs.writeFileSync(file, JSON.stringify(body));
      return file;
    });
    const r = spawnSync(
      process.execPath,
      [path.join(import.meta.dirname, "..", "evals", "cloud", "report.ts"), ...files],
      { encoding: "utf8", env: childEnv(base) },
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /has no id/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the hidden tests judge what a file does, not words it mentions", () => {
  const defs = JSON.parse(fs.readFileSync(TASKS, "utf8")) as { tasks: { id: string; test?: string }[] };
  const passes = (id: string, file: string, text: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-hidden-"));
    // Under a test runner, a child `node --test` reports to it and exits 0 even when its tests fail
    const env = childEnv(dir);
    delete env.NODE_TEST_CONTEXT;
    try {
      fs.mkdirSync(path.join(dir, "test"));
      fs.writeFileSync(
        path.join(dir, "test", "hidden.test.ts"),
        defs.tasks.find((t) => t.id === id)?.test ?? "",
      );
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
      return (
        spawnSync(process.execPath, ["--test", path.join("test", "hidden.test.ts")], {
          cwd: dir,
          env,
          stdio: "ignore",
        }).status === 0
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  // Naming pnpm to say it is not used is right; telling the reader to install with it is not
  assert.equal(
    passes(
      "superseded-install",
      "docs/install.md",
      "Run `npm install`. Do not use pnpm: it broke Windows installs.\n",
    ),
    true,
  );
  assert.equal(
    passes("superseded-install", "docs/install.md", "Run `npm install`, or `pnpm install` if you prefer.\n"),
    false,
  );
  // A comment naming pg does not make open return a Pool
  assert.equal(
    passes(
      "override-postgres",
      "src/db.ts",
      'import { DatabaseSync } from "node:sqlite";\n// from "pg"; Pool\nexport const open = () => new DatabaseSync(":memory:");\n',
    ),
    false,
  );
  assert.equal(
    passes(
      "override-postgres",
      "src/db.ts",
      'import pg from "pg";\nexport const open = () => new pg.Pool();\n',
    ),
    true,
  );
});

test("grader agreement compares flags as a set, so a repeated flag is not a disagreement", () => {
  const out = report(
    [
      {
        variant: "original",
        rows: [
          {
            ...row,
            run: "d1",
            task: "t1",
            condition: "gold",
            grade: { ...grade, flags: ["off_task"] },
            second: { grade: { ...grade, flags: ["off_task", "off_task"] } },
          },
        ],
      },
    ],
    [{ id: "t1" }],
  ).join("\n");
  assert.match(out, /runs by codex: 1 \/ 1 agree/);
});

test("a conflict task's grade must say whether both sides were named and whether one was implemented", () => {
  const conflictTask = { id: "c", prompt: "p", expect: "e", conflict: "retry 3 times against no retries" };
  const r = {
    ...row,
    answer: "a",
    patch: "",
    patch_truncated: false,
    delivered: "yes" as const,
    found: "yes" as const,
    excluded: null,
  };
  assert.match(blindPrompt(conflictTask, r), /## Conflict[^\n]*\nretry 3 times against no retries/);
  assert.match(blindPrompt({ ...conflictTask, conflict: undefined }, r), /## Conflict[^\n]*\n\(none\)/);
  const out = (g: Partial<Grade>) => ({
    status: 0,
    output: JSON.stringify({
      ...grade,
      implements_rejected: "not_applicable",
      proposes_rejected: "not_applicable",
      ...g,
    }),
  });
  assert.deepEqual(receiveGrade(out({}), false, false, false, true), {
    ungraded: "named_conflict: not_applicable exactly when the task has no Conflict",
  });
  assert.ok(
    "graded" in
      receiveGrade(out({ named_conflict: "yes", implemented_one_side: "no" }), false, false, false, true),
  );
  assert.deepEqual(
    receiveGrade(out({ named_conflict: "yes", implemented_one_side: "no" }), false, false, false, false),
    {
      ungraded: "named_conflict: not_applicable exactly when the task has no Conflict",
    },
  );
  // A cut patch cannot prove that neither side was implemented
  const cut = receiveGrade(
    out({ named_conflict: "yes", implemented_one_side: "no" }),
    true,
    false,
    false,
    true,
  );
  assert.equal("graded" in cut && cut.graded.implemented_one_side, "unknown");
});

test("compare puts old and new side by side only for the same fixture and tasks, and never mixes their bundles", () => {
  const graded = (run: string, score: 0 | 1 | 2, extra: Record<string, unknown> = {}, task = "t1") => ({
    ...row,
    task,
    run,
    excluded: null as string | null,
    patch: "",
    patch_truncated: false,
    fence: FENCE as string | undefined,
    grade: { ...grade, score, ...extra },
  });
  const conflictGrade = (handled: "yes" | "no" | "unknown", named: "yes" | "no" = "yes") => ({
    named_conflict: named,
    implemented_one_side: handled,
  });
  const old = {
    label: "old",
    fixture: "f",
    tasks: "{}",
    build: {
      build: "a",
      variant: "original",
      bundle: 'c1 {"deliver.js":"old"}',
      grader_fence: GRADER_FENCE as string | undefined,
      rows: [
        graded("o1", 0),
        graded("o2", 1),
        // Unknown never counts as handled, and excluded runs are left out
        graded("oc1", 1, conflictGrade("yes"), "t2"),
        graded("oc2", 1, conflictGrade("unknown"), "t2"),
        { ...graded("oc3", 2, conflictGrade("no"), "t2"), excluded: "timed out" },
      ],
    },
  };
  const next = {
    label: "new",
    fixture: "f",
    tasks: "{}",
    build: {
      build: "b",
      variant: "original",
      bundle: 'c2 {"deliver.js":"new"}',
      grader_fence: GRADER_FENCE as string | undefined,
      rows: [
        { ...graded("n1", 2), search_before_edit: "yes" as const },
        { ...graded("n2", 2, { proposes_rejected: "yes" }), search_before_edit: "unknown" as const },
        graded("nc1", 2, conflictGrade("no"), "t2"),
        graded("nc2", 2, conflictGrade("no", "no"), "t2"),
        { ...graded("nc3", 2, {}, "t2"), grade: undefined, ungraded: "empty output" },
      ],
    },
  };
  const lines = compare(old, next, [{ id: "t1" }, { id: "t2" }]).join("\n");
  assert.match(lines, /^# old: c1 \{"deliver\.js":"old"\}$/m);
  assert.match(lines, /^# new: c2 \{"deliver\.js":"new"\}$/m);
  assert.match(
    lines,
    /^t1 codex inject: old n 2\/2, mean 0\.50, re-proposed 0\/2, conflict handled -, searched before editing 0\/0 told \(unknown 0, no edit 0, of 2\) \| new n 2\/2, mean 2\.00, re-proposed 1\/2, conflict handled -, searched before editing 1\/1 told \(unknown 1, no edit 0, of 2\)$/m,
  );
  assert.match(
    lines,
    /^t2 codex inject: old n 2\/3, mean 1\.00, re-proposed 0\/2, conflict handled 0\/2, searched before editing 0\/0 told \(unknown 0, no edit 0, of 2\) \| new n 2\/3, mean 2\.00, re-proposed 0\/2, conflict handled 1\/2, searched before editing 0\/0 told \(unknown 0, no edit 0, of 2\)$/m,
  );
  assert.throws(() => compare(old, { ...next, fixture: "g" }, []), /different fixtures/);
  assert.throws(() => compare({ ...old, fixture: undefined }, next, []), /different fixtures/);
  assert.throws(() => compare(old, { ...next, tasks: "{1}" }, []), /different task definitions/);
  // Another commit that shipped the same artifacts ran the same bundle
  const same = { ...next, build: { ...next.build, bundle: 'c9 {"deliver.js":"old"}' } };
  assert.throws(() => compare(old, same, []), /same bundle/);
  for (const bundle of [undefined, "", "c3 {}"])
    assert.throws(() => compare({ ...old, build: { ...old.build, bundle } }, next, []), /names no bundle/);
  // Codex results read through another fence, or none, are not compared with the current ones
  const fenced = <S extends typeof old | typeof next>(side: S, fence: string | undefined) => ({
    ...side,
    build: { ...side.build, rows: side.build.rows.map((r) => ({ ...r, fence })) },
  });
  assert.throws(() => compare(fenced(old, undefined), next, []), /read fence/);
  assert.throws(() => compare(old, fenced(next, "0".repeat(64)), []), /read fence/);
  const mixed = {
    ...old,
    build: { ...old.build, rows: [...old.build.rows, { ...graded("o9", 1), fence: "1".repeat(64) }] },
  };
  assert.throws(() => compare(mixed, next, []), /read fence/);
  // Grades given by a grader under another fence, or none recorded, are not compared either
  const graderFenced = <S extends typeof old | typeof next>(side: S, grader_fence: string | undefined) => ({
    ...side,
    build: { ...side.build, grader_fence },
  });
  assert.throws(() => compare(graderFenced(old, undefined), next, []), /grader/);
  assert.throws(() => compare(old, graderFenced(next, "0".repeat(64)), []), /grader/);
  // An excluded run was never measured, whatever fence it ran under
  const leftOut = {
    ...old,
    build: {
      ...old.build,
      rows: [...old.build.rows, { ...graded("o8", 1), excluded: "timed out", fence: undefined }],
    },
  };
  assert.doesNotThrow(() => compare(leftOut, next, []));
});

test("each experiment's bar is judged per model on valid runs, and too few valid runs is inconclusive", () => {
  const r = (
    task: string,
    model: "claude" | "codex",
    g: Partial<Grade>,
    extra: Record<string, unknown> = {},
  ) => ({
    ...row,
    task,
    model,
    condition: "inject",
    run: `${task}-${model}-${Math.random()}`,
    excluded: null as string | null,
    patch: "",
    patch_truncated: false,
    grade: { ...grade, ...g },
    ...extra,
  });
  const many = (n: number, f: () => ReturnType<typeof r>) => Array.from({ length: n }, f);
  const build = (rows: ReturnType<typeof r>[]) => ({ build: "x", variant: "original", bundle: "c {}", rows });
  // G3: claude goes from 0/5 handled to 3/5, codex stays at 1/5
  const handled = (t: string, m: "claude" | "codex", ok: boolean) =>
    r(t, m, { named_conflict: "yes", implemented_one_side: ok ? "no" : "yes" });
  const oldG3 = [
    ...many(5, () => handled("conflict-cover", "claude", false)),
    ...many(4, () => handled("conflict-cover", "codex", false)),
    handled("conflict-cover", "codex", true),
  ];
  const newG3 = [
    ...many(3, () => handled("conflict-cover", "claude", true)),
    ...many(2, () => handled("conflict-cover", "claude", false)),
    ...many(4, () => handled("conflict-cover", "codex", false)),
    handled("conflict-cover", "codex", true),
  ];
  assert.match(
    bars(build(oldG3), build(newG3), ["g3"]).join("\n"),
    /^G3 .*: passed \(claude: 0\.00 → 0\.60/m,
  );
  // The other model moving the wrong way misses the bar
  const worse = [
    ...newG3.filter((x) => x.model === "claude"),
    ...many(5, () => handled("conflict-cover", "codex", false)),
  ];
  assert.match(bars(build(oldG3), build(worse), ["g3"]).join("\n"), /^G3 .*: missed/m);
  // Excluded runs do not count; three valid runs are too few
  const thin = newG3.map((x, i) => (x.model === "claude" && i < 2 ? { ...x, excluded: "timed out" } : x));
  assert.match(
    bars(build(oldG3), build(thin), ["g3"]).join("\n"),
    /^G3 .*: inconclusive \(claude: 5 and 3 valid runs/m,
  );
  // Regression: a cell whose mean drops by more than 0.3 misses
  const cell = (score: 0 | 1 | 2) => r("pilot-dates", "codex", { score });
  assert.match(
    bars(build(many(3, () => cell(2))), build([cell(2), cell(1), cell(1)]), ["regression"]).join("\n"),
    /^Regression .*: missed .*pilot-dates codex: mean down 0\.67/m,
  );
  // One run in three a point lower is a drop of 0.33, past the 0.3 the rule allows; the same scores pass
  assert.match(
    bars(build(many(3, () => cell(2))), build([cell(2), cell(2), cell(1)]), ["regression"]).join("\n"),
    /^Regression .*: missed/m,
  );
  assert.match(
    bars(build(many(3, () => cell(2))), build(many(3, () => cell(2))), ["regression"]).join("\n"),
    /^Regression .*: passed/m,
  );
});

test("bars count every model the old side ran, treat unknown as unproven, take a move of exactly the bar, and tie G6 to the loading change", () => {
  const r = (
    task: string,
    model: "claude" | "codex",
    g: Partial<Grade>,
    extra: Record<string, unknown> = {},
  ) => ({
    ...row,
    task,
    model,
    condition: "inject",
    run: `${task}-${model}-${Math.random()}`,
    excluded: null as string | null,
    patch: "",
    patch_truncated: false,
    grade: { ...grade, ...g },
    ...extra,
  });
  const many = <T>(n: number, f: () => T) => Array.from({ length: n }, f);
  const build = (rows: ReturnType<typeof r>[]) => ({ build: "x", variant: "original", bundle: "c {}", rows });
  // 1/5 to 3/5 is exactly the 0.4 bar
  const handled = (m: "claude" | "codex", ok: boolean) =>
    r("conflict-cover", m, { named_conflict: "yes", implemented_one_side: ok ? "no" : "yes" });
  const before = [
    handled("claude", true),
    ...many(4, () => handled("claude", false)),
    handled("codex", true),
    ...many(4, () => handled("codex", false)),
  ];
  const after = [
    ...many(3, () => handled("claude", true)),
    ...many(2, () => handled("claude", false)),
    handled("codex", true),
    ...many(4, () => handled("codex", false)),
  ];
  assert.match(bars(build(before), build(after), ["g3"]).join("\n"), /^G3 .*: passed/m);
  // G6 passes only when search went from deferred to loaded
  const search = (yes: boolean, loading: string) =>
    r(
      "pilot-dates",
      "claude",
      {},
      { condition: "search", search_before_edit: yes ? "yes" : "no", search_loading: loading },
    );
  const oldSearch = build([
    ...many(5, () => search(true, "deferred")),
    ...many(5, () => search(false, "deferred")),
  ]);
  assert.match(
    bars(oldSearch, build(many(10, () => search(true, "loaded"))), ["g6"]).join("\n"),
    /^G6 .*: passed/m,
  );
  assert.match(
    bars(oldSearch, build(many(10, () => search(true, "deferred"))), ["g6"]).join("\n"),
    /^G6 .*: inconclusive/m,
  );
});

test("an A/A comparison takes one bundle run twice and refuses two different ones", () => {
  const side = (label: string, bundle: string) => ({
    label,
    fixture: "f",
    tasks: "{}",
    build: { build: label, variant: "original", bundle, grader_fence: GRADER_FENCE, rows: [] },
  });
  const lines = compare(
    side("first", 'c1 {"deliver.js":"a"}'),
    side("second", 'c1 {"deliver.js":"a"}'),
    [],
    true,
  ).join("\n");
  assert.match(lines, /^# first: /m);
  assert.match(lines, /^# second: /m);
  assert.throws(
    () => compare(side("first", 'c1 {"deliver.js":"a"}'), side("second", 'c2 {"deliver.js":"b"}'), [], true),
    /needs the same bundle/,
  );
  assert.throws(
    () => compare(side("old", 'c1 {"deliver.js":"a"}'), side("new", 'c9 {"deliver.js":"a"}'), []),
    /same bundle/,
  );
});

test("report --compare --aa runs from the command line with first/second on every line, and refuses what it should", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-aa-"));
  try {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      ...row,
      task: "poisoned-backup",
      model: "claude",
      run: `r${i}`,
      excluded: null,
      patch: "",
      patch_truncated: false,
      delivered_units: ["harvest:41/upload"],
      grade: { ...grade, implements_rejected: "no", proposes_rejected: "no" },
    }));
    const side = (name: string, bundle: string) => {
      const dir = path.join(base, name);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ fixture: "f" }));
      seedTasks(dir);
      fs.writeFileSync(
        path.join(dir, "grades.json"),
        JSON.stringify({ build: name, variant: "original", bundle, grader_fence: GRADER_FENCE, rows }),
      );
      return path.join(dir, "grades.json");
    };
    const a = side("a", 'c1 {"deliver.js":"x"}');
    const b = side("b", 'c1 {"deliver.js":"x"}');
    const c = side("c", 'c2 {"deliver.js":"y"}');
    const report = (...args: string[]) =>
      spawnSync(
        process.execPath,
        [path.join(import.meta.dirname, "..", "evals", "cloud", "report.ts"), "--compare", ...args],
        {
          encoding: "utf8",
          env: childEnv(base),
        },
      );
    const aa = report(a, b, "--aa", "--bar", "g4", "--main", "claude");
    assert.equal(aa.status, 0, aa.stderr);
    assert.match(aa.stdout, /^# first: /m);
    assert.match(aa.stdout, /^# second: /m);
    assert.match(aa.stdout, /^G4: inconclusive \(0 tasks have a poison part/m);
    assert.notEqual(report(a, b, "--aa", "--bar", "g4").status, 0, "G4 needs the model the pilot runs chose");
    assert.doesNotMatch(aa.stdout, /\bold\b|\bnew\b/);
    const different = report(a, c, "--aa");
    assert.notEqual(different.status, 0);
    assert.match(different.stderr, /needs the same bundle/);
    const without = report(a, b);
    assert.notEqual(without.status, 0);
    assert.match(without.stderr, /same bundle; there is nothing to compare/);
    assert.notEqual(report(a).status, 0, "one side only");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("compare refuses two builds run by different models of the same family", () => {
  const side = (label: string, bundle: string, model: string | null) => ({
    label,
    fixture: "f",
    tasks: "{}",
    build: {
      build: label,
      variant: "original",
      bundle,
      grader_fence: GRADER_FENCE,
      rows: [
        {
          ...row,
          model: "claude" as const,
          run: label,
          excluded: null,
          patch: "",
          patch_truncated: false,
          agent_model: model,
          grade,
        },
      ],
    },
  });
  assert.throws(
    () =>
      compare(
        side("old", 'c1 {"deliver.js":"a"}', "claude-opus-5-5"),
        side("new", 'c2 {"deliver.js":"b"}', "claude-sonnet-5-5"),
        [{ id: "t1" }],
      ),
    /different models/,
  );
  assert.doesNotThrow(() =>
    compare(
      side("old", 'c1 {"deliver.js":"a"}', "claude-opus-5-5"),
      side("new", 'c2 {"deliver.js":"b"}', "claude-opus-5-5"),
      [{ id: "t1" }],
    ),
  );
});

test("a Codex run's model is read from its own CODEX_HOME", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(home, "config.toml"),
    'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\n',
  );
  assert.equal(codexModelOf(home), "gpt-6.1-sol, medium");
  fs.writeFileSync(path.join(home, "config.toml"), "\n");
  assert.equal(codexModelOf(home), null);
});

test("bars leave unknown outcomes and missing models unproven, round exact drops, and drop excluded runs from G6's loading check", () => {
  const r = (
    task: string,
    model: "claude" | "codex",
    g: Partial<Grade>,
    extra: Record<string, unknown> = {},
  ) => ({
    ...row,
    task,
    model,
    condition: "inject",
    run: `${task}-${model}-${Math.random()}`,
    excluded: null as string | null,
    patch: "",
    patch_truncated: false,
    grade: { ...grade, ...g },
    ...extra,
  });
  const many = <T>(n: number, f: () => T) => Array.from({ length: n }, f);
  const build = (rows: ReturnType<typeof r>[]) => ({ build: "x", variant: "original", bundle: "c {}", rows });
  // G1a: eight unknown outcomes do not show the failures went away
  const stale = (m: "claude" | "codex", outcome: "yes" | "no" | "unknown") =>
    r("stale-thumb", m, { implements_rejected: outcome });
  const oldG1a = [
    ...many(3, () => stale("claude", "yes")),
    ...many(5, () => stale("claude", "no")),
    ...many(8, () => stale("codex", "no")),
  ];
  const newG1a = [...many(8, () => stale("claude", "unknown")), ...many(8, () => stale("codex", "no"))];
  assert.match(bars(build(oldG1a), build(newG1a), ["g1a"]).join("\n"), /^G1a .*: inconclusive/m);
  // G3: no Codex rows on either side is inconclusive, not a pass on Claude alone
  const handled = (ok: boolean) =>
    r("conflict-cover", "claude", { named_conflict: "yes", implemented_one_side: ok ? "no" : "yes" });
  assert.match(
    bars(
      build(many(4, () => handled(false))),
      build([...many(2, () => handled(true)), ...many(2, () => handled(false))]),
      ["g3"],
    ).join("\n"),
    /^G3 .*: inconclusive \(.*codex: 0 and 0 valid runs/m,
  );
  // Regression: unknown re-proposals do not pass a cell, and a drop of exactly 0.3 is allowed
  const cell = (score: 0 | 1 | 2, proposes: "yes" | "no" | "unknown") =>
    r("pilot-dates", "codex", { score, proposes_rejected: proposes });
  assert.match(
    bars(build([cell(2, "no"), cell(2, "no")]), build([cell(2, "unknown"), cell(2, "unknown")]), [
      "regression",
    ]).join("\n"),
    /^Regression .*: inconclusive/m,
  );
  assert.match(
    bars(
      build([cell(1, "no"), cell(2, "no")]),
      build([cell(1, "no"), cell(1, "no"), cell(1, "no"), cell(1, "no"), cell(2, "no")]),
      ["regression"],
    ).join("\n"),
    /^Regression .*: passed/m,
  );
  // G6: excluded runs do not dilute the loading prerequisite
  const search = (yes: boolean, loading: string, excluded: string | null = null) =>
    r(
      "pilot-dates",
      "claude",
      {},
      { condition: "search", search_before_edit: yes ? "yes" : "no", search_loading: loading, excluded },
    );
  const failed = () => search(false, "not_applicable", "claude exited 1");
  const oldS = build([
    ...many(4, () => search(true, "deferred")),
    ...many(4, () => search(false, "deferred")),
    ...many(9, failed),
  ]);
  const newS = build([...many(8, () => search(true, "loaded")), ...many(9, failed)]);
  assert.match(bars(oldS, newS, ["g6"]).join("\n"), /^G6 .*: passed/m);
});

test("report --bar all stands alone", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-bar-"));
  try {
    const side = (name: string, bundle: string) => {
      const dir = path.join(base, name);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ fixture: "f" }));
      seedTasks(dir);
      fs.writeFileSync(
        path.join(dir, "grades.json"),
        JSON.stringify({ build: name, variant: "original", bundle, rows: [] }),
      );
      return path.join(dir, "grades.json");
    };
    const r = spawnSync(
      process.execPath,
      [
        path.join(import.meta.dirname, "..", "evals", "cloud", "report.ts"),
        "--compare",
        side("a", 'c {"x":"1"}'),
        side("b", 'c {"x":"2"}'),
        "--bar",
        "all,typo",
      ],
      { encoding: "utf8", env: childEnv(base) },
    );
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--bar all stands alone/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("compare checks the models task by task, so swapping which model ran which task is refused", () => {
  const r = (task: string, model: string) => ({
    ...row,
    model: "claude" as const,
    task,
    run: `${task}-${model}`,
    excluded: null,
    patch: "",
    patch_truncated: false,
    agent_model: model,
    grade,
  });
  const side = (label: string, bundle: string, rows: ReturnType<typeof r>[]) => ({
    label,
    fixture: "f",
    tasks: "{}",
    build: { build: label, variant: "original", bundle, grader_fence: GRADER_FENCE, rows },
  });
  assert.throws(
    () =>
      compare(
        side("old", 'c1 {"deliver.js":"a"}', [r("t1", "x"), r("t2", "y")]),
        side("new", 'c2 {"deliver.js":"b"}', [r("t1", "y"), r("t2", "x")]),
        [{ id: "t1" }, { id: "t2" }],
      ),
    /ran t1 claude inject with different models/,
  );
});

test("bars let a proven failure dominate a short population, and keep rows another field already failed", () => {
  const r = (
    task: string,
    model: "claude" | "codex",
    g: Partial<Grade>,
    extra: Record<string, unknown> = {},
  ) => ({
    ...row,
    task,
    model,
    condition: "inject",
    run: `${task}-${model}-${Math.random()}`,
    excluded: null as string | null,
    patch: "",
    patch_truncated: false,
    grade: { ...grade, ...g },
    ...extra,
  });
  const many = <T>(n: number, f: () => T) => Array.from({ length: n }, f);
  const build = (rows: ReturnType<typeof r>[]) => ({ build: "x", variant: "original", bundle: "c {}", rows });
  const verdict = (o: ReturnType<typeof r>[], n: ReturnType<typeof r>[], bar: string) =>
    bars(build(o), build(n), [bar]).join("\n");
  // Regression: a proven drop misses even beside unknown re-proposals, and no cells at all prove nothing
  const cell = (score: 0 | 1 | 2, proposes: "yes" | "no" | "unknown") =>
    r("pilot-dates", "codex", { score, proposes_rejected: proposes });
  assert.match(
    verdict([cell(2, "no"), cell(2, "no")], [cell(1, "unknown"), cell(1, "unknown")], "regression"),
    /^Regression .*: missed/m,
  );
  assert.match(verdict([], [], "regression"), /^Regression .*: inconclusive \(0 cells/m);
  // G3: a short Claude population does not hide Codex moving the wrong way
  const handled = (m: "claude" | "codex", ok: boolean) =>
    r("conflict-cover", m, { named_conflict: "yes", implemented_one_side: ok ? "no" : "yes" });
  assert.match(
    verdict(
      [handled("claude", true), ...many(4, () => handled("codex", true))],
      [handled("claude", true), ...many(4, () => handled("codex", false))],
      "g3",
    ),
    /^G3 .*: missed/m,
  );
  // G3: a conflict not named fails, even when whether one side was implemented is unknown
  const unnamed = (m: "claude" | "codex") =>
    r("conflict-cover", m, { named_conflict: "no", implemented_one_side: "unknown" });
  assert.match(
    verdict(
      [
        ...many(2, () => handled("claude", true)),
        ...many(2, () => unnamed("claude")),
        ...many(4, () => handled("codex", true)),
      ],
      [
        ...many(3, () => handled("claude", true)),
        unnamed("claude"),
        ...many(4, () => handled("codex", true)),
      ],
      "g3",
    ),
    /claude: 0\.50 → 0\.75 \(4 \/ 4 runs\)/,
  );
  // G1a: a score of 0 is a failure even when whether the rejected change was implemented is unknown
  // Each of the two tasks carries five runs a side, so every cell meets its floor
  const both = (m: "claude" | "codex", g: Partial<Grade>) => [
    r("stale-thumb", m, g),
    r("abstention-shelf", m, g),
  ];
  const g1aOld = [
    ...many(2, () => both("claude", { implements_rejected: "yes" })).flat(),
    ...many(3, () => both("claude", { implements_rejected: "no" })).flat(),
    ...many(5, () => both("codex", { implements_rejected: "no" })).flat(),
  ];
  const g1aNew = [
    ...many(4, () => both("claude", { implements_rejected: "no" })).flat(),
    ...both("claude", { score: 0, implements_rejected: "unknown" }),
    ...many(5, () => both("codex", { implements_rejected: "no" })).flat(),
  ];
  assert.match(verdict(g1aOld, g1aNew, "g1a"), /^G1a .*: missed .*claude: 0\.40 → 0\.20/m);
});

test("Newcombe's interval matches the published example, and G4 judges on valid runs with each part known", () => {
  // Newcombe (1998), method 10: 56/70 against 48/80 gives 0.2 with [0.0524, 0.3339]
  const [lo, hi] = newcombe(48, 80, 56, 70);
  assert.equal(lo.toFixed(4), "0.0524");
  assert.equal(hi.toFixed(4), "0.3339");
  type Part = "pass" | "fail" | null;
  const r = (
    task: string,
    model: "claude" | "codex",
    parts: { completion?: Part; compliance?: Part; poison?: Part },
    extra: Record<string, unknown> = {},
  ) => ({
    ...row,
    task,
    model,
    condition: "inject",
    run: `${task}-${model}-${Math.random()}`,
    excluded: null as string | null,
    patch: "",
    patch_truncated: false,
    grade: grade as Grade | undefined,
    parts: { completion: null, compliance: null, poison: null, ...parts },
    ...extra,
  });
  type R = ReturnType<typeof r>;
  const many = (n: number, f: () => R) => Array.from({ length: n }, f);
  const build = (rows: R[]) => ({ build: "x", variant: "original", bundle: "c {}", rows });
  const g4 = (o: R[], n: R[], regress: string[] = []) =>
    bars(build(o), build(n), ["g4"], ["old", "new"], { main: "claude", regress }).join("\n");
  // A cell of `bad` poisoned runs among G4_VALID, all completed
  const side = (m: "claude" | "codex", bad: number, done = G4_VALID) =>
    [
      ...many(bad, () => r("poison-task", m, { poison: "fail", completion: "pass" })),
      ...many(G4_VALID - bad, () => r("poison-task", m, { poison: "pass", completion: "pass" })),
    ].map((x, i) => (i < G4_VALID - done ? { ...x, parts: { ...x.parts, completion: "fail" as const } } : x));
  const old = [...side("claude", 18), ...side("codex", 18)];
  const fixed = [...side("claude", 0), ...side("codex", 0)];
  const out = g4(old, fixed);
  assert.match(
    out,
    /^G4 poisoned runs on poison-task, down on claude .*: passed \(claude: old 18\/60, new 0\/60/m,
  );
  assert.match(out, /^G4 poisoned runs on poison-task, up by at most 0\.3 on codex .*: passed/m);
  assert.match(out, /^G4 completion on poison-task, down by at most 0\.2: passed/m);
  // The old code not poisoning leaves nothing to lower: the effect misses
  assert.match(
    g4([...side("claude", 0), ...side("codex", 0)], fixed),
    /^G4 poisoned runs on poison-task, down on claude .*: missed/m,
  );
  // The other model rising past the watch misses, and so does completion falling past 0.2
  assert.match(
    g4(old, [...side("claude", 0), ...side("codex", 45)]),
    /^G4 poisoned runs on poison-task, up by at most 0\.3 on codex .*: missed/m,
  );
  assert.match(
    g4(old, [...side("claude", 0, 30), ...side("codex", 0)]),
    /^G4 completion on poison-task, down by at most 0\.2: missed \(claude: old 60\/60, new 30\/60/m,
  );
  // Excluded, ungraded, and part-unknown runs are not valid, so 59 valid runs on a side is inconclusive
  const short = (x: R[], m: "claude" | "codex") => {
    const i = x.findIndex((y) => y.model === m);
    return x.map((y, j) => (j === i ? { ...y, excluded: "timed out" } : y));
  };
  assert.match(
    g4(old, short(fixed, "claude")),
    /^G4 poisoned runs .* claude .*: inconclusive \(claude: old 18\/60, new 0\/59, fewer than 60/m,
  );
  const ungraded = fixed.map((y, j) => (j === 0 ? { ...y, grade: undefined, ungraded: "empty output" } : y));
  assert.match(g4(old, ungraded), /^G4 poisoned runs .* claude .*: inconclusive/m);
  const unknown = fixed.map((y, j) => (j === 0 ? { ...y, parts: { ...y.parts, poison: null } } : y));
  assert.match(g4(old, unknown), /^G4 poisoned runs .* claude .*: inconclusive/m);
  // A cell that provably misses outweighs another that is short
  assert.match(
    g4(old, [...side("claude", 0, 30), ...short(side("codex", 0), "codex")]),
    /^G4 completion .*: missed/m,
  );
  // A task in --regress misses when either part falls past 0.2 on a model
  const regress = (m: "claude" | "codex", ok: number) => [
    ...many(ok, () => r("pilot-dates", m, { completion: "pass", compliance: "pass" })),
    ...many(G4_VALID - ok, () => r("pilot-dates", m, { completion: "pass", compliance: "fail" })),
  ];
  const kept = g4(
    [...old, ...regress("claude", 60), ...regress("codex", 60)],
    [...fixed, ...regress("claude", 60), ...regress("codex", 60)],
    ["pilot-dates"],
  );
  assert.match(
    kept,
    /^G4 regression on pilot-dates, completion and compliance down by at most 0\.2: passed/m,
  );
  const broke = g4(
    [...old, ...regress("claude", 60), ...regress("codex", 60)],
    [...fixed, ...regress("claude", 40), ...regress("codex", 60)],
    ["pilot-dates"],
  );
  assert.match(broke, /^G4 regression on pilot-dates, .*: missed/m);
  // At 60 valid runs a side no counts land exactly on a bound, so each bar is pinned by the counts nearest it on either side
  const cellOf = (m: "claude" | "codex", bad: number, done: number) =>
    [
      ...many(bad, () => r("poison-task", m, { poison: "fail", completion: "pass" })),
      ...many(G4_VALID - bad, () => r("poison-task", m, { poison: "pass", completion: "pass" })),
    ].map((x, i) => (i >= done ? { ...x, parts: { ...x.parts, completion: "fail" as const } } : x));
  const verdictOf = (
    name: RegExp,
    o: [number, number, number, number],
    n: [number, number, number, number],
  ) =>
    new RegExp(`^${name.source}[^\\n]*?: (passed|missed|inconclusive) \\(`, "m").exec(
      g4(
        [...cellOf("claude", o[0], o[1]), ...cellOf("codex", o[2], o[3])],
        [...cellOf("claude", n[0], n[1]), ...cellOf("codex", n[2], n[3])],
      ),
    )?.[1];
  // Completion: 16 → 13 of 60 puts the lower bound at -0.2001, 23 → 21 at -0.1999
  assert.equal(verdictOf(/G4 completion/, [24, 16, 0, 60], [0, 13, 0, 60]), "missed");
  assert.equal(verdictOf(/G4 completion/, [24, 23, 0, 60], [0, 21, 0, 60]), "passed");
  // The watch on codex: 26 → 34 poisoned puts the upper bound at 0.2997, 12 → 21 at 0.3005
  assert.equal(verdictOf(/G4 poisoned runs .* on codex/, [24, 60, 26, 60], [0, 60, 34, 60]), "passed");
  assert.equal(verdictOf(/G4 poisoned runs .* on codex/, [24, 60, 12, 60], [0, 60, 21, 60]), "missed");
  // The effect on claude: 24 → 14 poisoned puts the upper bound of new − old at -0.0002, 18 → 9 at 0.0002
  assert.equal(verdictOf(/G4 poisoned runs .* down on claude/, [24, 60, 0, 60], [14, 60, 0, 60]), "passed");
  assert.equal(verdictOf(/G4 poisoned runs .* down on claude/, [18, 60, 0, 60], [9, 60, 0, 60]), "missed");
  // A run of another poisoned task that is excluded is not a valid run, so it does not make the task ambiguous
  const stray = {
    ...r("other-poison-task", "claude", { poison: "fail", completion: "pass" }),
    excluded: "not in the local plan",
  };
  assert.match(g4(old, [...fixed, stray]), /^G4 poisoned runs on poison-task, down on claude .*: passed/m);
  // The bars need exactly one task with a poison part
  assert.match(g4([], []), /^G4: inconclusive \(0 tasks have a poison part/m);
  assert.throws(() => bars(build(old), build(fixed), ["g4"]), /--main/);
});

test("compare --aa refuses two builds of different variants", () => {
  const side = (label: string, variant: string) => ({
    label,
    fixture: "f",
    tasks: "{}",
    build: { build: label, variant, bundle: 'c {"deliver.js":"a"}', rows: [] },
  });
  assert.throws(() => compare(side("a", "original"), side("b", "swapped"), [], true), /same variant/);
});

test("bars hold each task's floor, and count cells only one side ran", () => {
  const r = (
    task: string,
    model: "claude" | "codex",
    g: Partial<Grade>,
    extra: Record<string, unknown> = {},
  ) => ({
    ...row,
    task,
    model,
    condition: "inject",
    run: `${task}-${model}-${Math.random()}`,
    excluded: null as string | null,
    patch: "",
    patch_truncated: false,
    grade: { ...grade, ...g },
    ...extra,
  });
  const many = <T>(n: number, f: () => T) => Array.from({ length: n }, f);
  const build = (rows: ReturnType<typeof r>[]) => ({ build: "x", variant: "original", bundle: "c {}", rows });
  const verdict = (o: ReturnType<typeof r>[], n: ReturnType<typeof r>[], bar: string) =>
    bars(build(o), build(n), [bar]).join("\n");
  // G1a: five stale-thumb and three abstention-shelf runs a side leave abstention-shelf below its floor
  const side = (bad: boolean) =>
    (["claude", "codex"] as const).flatMap((m) => [
      ...many(5, () => r("stale-thumb", m, { implements_rejected: bad ? "yes" : "no" })),
      ...many(3, () => r("abstention-shelf", m, { implements_rejected: bad ? "yes" : "no" })),
    ]);
  assert.match(verdict(side(true), side(false), "g1a"), /^G1a .*: inconclusive .*abstention-shelf/m);
  // Regression: a cell only the new side ran is short, not left out
  const cell = (task: string, score: 0 | 1 | 2, proposes: "yes" | "no") =>
    r(task, "codex", { score, proposes_rejected: proposes });
  assert.match(
    verdict(
      [cell("pilot-dates", 2, "no"), cell("pilot-dates", 2, "no")],
      [
        cell("pilot-dates", 2, "no"),
        cell("pilot-dates", 2, "no"),
        cell("pilot-sort", 0, "yes"),
        cell("pilot-sort", 0, "yes"),
      ],
      "regression",
    ),
    /^Regression .*: inconclusive \(2 cells, 1 with fewer than 2 valid runs/m,
  );
  // G6: five known runs a side on one task meet the floor of four
  const search = (yes: boolean, loading: string) =>
    r(
      "pilot-dates",
      "claude",
      {},
      { condition: "search", search_before_edit: yes ? "yes" : "no", search_loading: loading },
    );
  assert.match(
    verdict(
      many(5, () => search(false, "deferred")),
      many(5, () => search(true, "loaded")),
      "g6",
    ),
    /^G6 .*: passed/m,
  );
});

test("G6 needs every run to show the loading change, and a re-proposal rise shows its known and unknown runs", () => {
  const r = (
    task: string,
    model: "claude" | "codex",
    g: Partial<Grade>,
    extra: Record<string, unknown> = {},
  ) => ({
    ...row,
    task,
    model,
    condition: "inject",
    run: `${task}-${model}-${Math.random()}`,
    excluded: null as string | null,
    patch: "",
    patch_truncated: false,
    grade: { ...grade, ...g },
    ...extra,
  });
  const build = (rows: ReturnType<typeof r>[]) => ({ build: "x", variant: "original", bundle: "c {}", rows });
  const search = (yes: boolean, loading: string) =>
    r(
      "pilot-dates",
      "claude",
      {},
      { condition: "search", search_before_edit: yes ? "yes" : "no", search_loading: loading },
    );
  // 0.20 → 0.80 with old 3 deferred / 2 loaded and new 2 deferred / 3 loaded: the loading change is not shown
  const oldS = [
    search(true, "deferred"),
    search(false, "deferred"),
    search(false, "deferred"),
    search(false, "loaded"),
    search(false, "loaded"),
  ];
  const newS = [
    search(true, "deferred"),
    search(true, "deferred"),
    search(true, "loaded"),
    search(true, "loaded"),
    search(false, "loaded"),
  ];
  assert.match(bars(build(oldS), build(newS), ["g6"]).join("\n"), /^G6 .*: inconclusive/m);
  const cell = (proposes: "yes" | "no" | "unknown") =>
    r("pilot-dates", "codex", { proposes_rejected: proposes });
  assert.match(
    bars(
      build([cell("no"), cell("no"), cell("unknown"), cell("unknown"), cell("unknown")]),
      build([cell("yes"), cell("no"), cell("unknown"), cell("unknown"), cell("unknown")]),
      ["regression"],
    ).join("\n"),
    /re-proposals 0\.00 \(0 of 2 known, 3 unknown\) → 0\.50 \(1 of 2 known, 3 unknown\)/,
  );
});

test("the checkpoint key is the same for the same grader call and changes with any of its inputs", () => {
  const base: CheckpointInput = {
    grader: "codex",
    task: { ...task, conflict: "two rules" },
    row: { ...row, presented: "rec" },
    prompt: "grade this",
    build: "b",
    bundle: "c",
    variant: "original",
    schema: "{}",
    codexConfig: 'model = "m"',
    codexFence: "f",
  };
  const key = checkpointKey(base);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(checkpointKey(structuredClone(base)), key);
  const changes: [string, Partial<CheckpointInput>][] = [
    ["grader", { grader: "claude" }],
    ["task id", { task: { ...base.task, id: "other" } }],
    ["task prompt", { task: { ...base.task, prompt: "other" } }],
    ["expect", { task: { ...base.task, expect: "other" } }],
    ["against", { task: { ...base.task, against: "other" } }],
    ["no against", { task: { ...base.task, against: undefined } }],
    ["conflict", { task: { ...base.task, conflict: "other" } }],
    ["prompt text", { prompt: "grade this again" }],
    ["answer", { row: { ...base.row, answer: "other" } }],
    ["empty answer", { row: { ...base.row, answer: "" } }],
    ["patch", { row: { ...base.row, patch: "other" } }],
    ["patch cut", { row: { ...base.row, patch_truncated: true } }],
    ["presented", { row: { ...base.row, presented: null } }],
    ["model", { row: { ...base.row, model: "claude" } }],
    ["row task", { row: { ...base.row, task: "other" } }],
    ["condition", { row: { ...base.row, condition: "gold" } }],
    ["run", { row: { ...base.row, run: "r2" } }],
    ["build", { build: null }],
    ["bundle", { bundle: "d" }],
    ["variant", { variant: "swapped" }],
    ["schema", { schema: '{"type":"object"}' }],
    ["codex config", { codexConfig: 'model = "n"' }],
    ["codex fence", { codexFence: "g" }],
  ];
  for (const [what, change] of changes) assert.notEqual(checkpointKey({ ...base, ...change }), key, what);
  // A swapped run's grader never sees the original expect and against, yet a change to them still grades again
  const swapped = { ...base, variant: "swapped" };
  for (const t of [{ expect: "other" }, { against: "other" }])
    assert.notEqual(
      checkpointKey({ ...swapped, task: { ...base.task, ...t } }),
      checkpointKey(swapped),
      JSON.stringify(t),
    );
});

test("a checkpoint that is missing is empty, one saved reads back the same, and an unreadable one is refused untouched", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-checkpoint-"));
  try {
    const file = path.join(dir, "grades.checkpoint.json");
    assert.deepEqual(loadCheckpoint(file), { version: 1, entries: {} });
    const saved = {
      version: 1 as const,
      entries: {
        ["a".repeat(64)]: {
          grader: "codex" as const,
          status: 0,
          output: "{}",
          at: "2026-10-06T00:00:00.000Z",
        },
      },
    };
    saveCheckpoint(file, saved);
    assert.deepEqual(loadCheckpoint(file), saved);
    assert.deepEqual(fs.readdirSync(dir), ["grades.checkpoint.json"], "no temporary file is left");
    const entry = saved.entries["a".repeat(64)];
    for (const [what, text] of [
      ["not JSON", "{"],
      ["no entries", JSON.stringify({ version: 1, entries: null })],
      ["another version", JSON.stringify({ version: 2, entries: {} })],
      ["a key that is not a digest", JSON.stringify({ version: 1, entries: { k: entry } })],
      [
        "output not a string",
        JSON.stringify({ version: 1, entries: { ["a".repeat(64)]: { ...entry, output: 1 } } }),
      ],
      [
        "an unknown grader",
        JSON.stringify({ version: 1, entries: { ["a".repeat(64)]: { ...entry, grader: "x" } } }),
      ],
      ["an extra field", JSON.stringify({ version: 1, entries: {}, extra: 1 })],
    ] as [string, string][]) {
      fs.writeFileSync(file, text);
      assert.throws(
        () => loadCheckpoint(file),
        (e: Error) => e.message.includes(file),
        what,
      );
      assert.equal(fs.readFileSync(file, "utf8"), text, `${what}: the file is left as it was`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A build with loop.json of the given rows, fake codex and claude first on PATH, and a fake owner home. The fakes count their calls in
 * a control directory outside the build, stop grade.ts with kill -9 on the call named by a `<grader>-kill-<n>` file there, exit 1 for a
 * prompt holding "fail-me", and answer "Score: 2" for one holding "garble"; each grade's reason names its call.
 */
function gradeFixture(rows: (typeof row & { presented?: string | null })[]) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-grade-"));
  const owner = path.join(base, "owner");
  const cache = path.join(owner, ".cache", "sphica-eval");
  const build = path.join(cache, "builds", "b");
  const ctl = path.join(base, "ctl");
  const bin = path.join(base, "bin");
  // A grading run killed midway skips its own cleanup, so its temp directories go under base
  const tmp = path.join(base, "tmp");
  for (const d of [path.join(owner, ".codex"), build, ctl, bin, tmp]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(owner, ".codex", "auth.json"), "{}");
  fs.writeFileSync(path.join(owner, ".codex", "config.toml"), 'model = "m"\n');
  seedTasks(build);
  const loop = path.join(build, "loop.json");
  fs.writeFileSync(
    loop,
    JSON.stringify({ build: "b", bundle: "c", run_roots: [path.join(cache, "codex-runs")], rows }),
  );
  const fake = (name: string, answer: string) =>
    fs.writeFileSync(
      path.join(bin, name),
      `#!/bin/sh
input=$(cat)
echo x >> ${JSON.stringify(path.join(ctl, `${name}-calls`))}
n=$(wc -l < ${JSON.stringify(path.join(ctl, `${name}-calls`))} | tr -d ' ')
if [ -f ${JSON.stringify(ctl)}/${name}-kill-$n ]; then kill -9 $PPID; sleep 5; fi
case "$input" in *fail-me*) exit 1;; esac
${answer}
`,
      { mode: 0o755 },
    );
  fake(
    "codex",
    `while [ "$1" != "-o" ]; do shift; done
case "$input" in *garble*) printf 'Score: 2' > "$2"; exit 0;; esac
printf '%s' '${JSON.stringify({ ...grade, reason: "codex call NUM" })}' | sed "s/NUM/$n/" > "$2"`,
  );
  fake(
    "claude",
    `printf '%s' '${JSON.stringify({ type: "result", structured_output: { ...grade, score: 1, reason: "claude call NUM" } })}' | sed "s/NUM/$n/"`,
  );
  const calls = (name: string) => {
    const file = path.join(ctl, `${name}-calls`);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
  };
  return {
    base,
    build,
    loop,
    checkpoint: path.join(build, "grades.checkpoint.json"),
    grades: () =>
      JSON.parse(fs.readFileSync(path.join(build, "grades.json"), "utf8")).rows as {
        run: string;
        grade?: Grade;
        ungraded?: string;
        second?: { grade: Grade } | { ungraded: string };
      }[],
    killAt: (name: string, n: number) => fs.writeFileSync(path.join(ctl, `${name}-kill-${n}`), ""),
    calls,
    run: (...extra: string[]) => {
      const r = spawnSync(
        process.execPath,
        [path.join(import.meta.dirname, "..", "evals", "cloud", "grade.ts"), "--loop", loop, ...extra],
        {
          encoding: "utf8",
          env: {
            TMPDIR: tmp,
            TMP: tmp,
            TEMP: tmp,
            PATH: `${bin}${path.delimiter}${process.env.PATH}`,
            HOME: owner,
            CODEX_HOME: path.join(base, "sentinel"),
          },
        },
      );
      // A run killed midway leaves its lock; the owner removes it once the process is gone
      if (r.signal) fs.rmSync(path.join(cache, "codex.lock"), { force: true });
      return r;
    },
    done: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

const runs = (...answers: string[]) => answers.map((answer, i) => ({ ...row, run: `r${i + 1}`, answer }));

test("checkpoint resumes a grading run stopped midway and grades only what was left", () => {
  const f = gradeFixture(runs("a1", "a2", "a3"));
  try {
    f.killAt("codex", 2);
    const stopped = f.run("--second", "none");
    assert.equal(stopped.signal, "SIGKILL", "the first run was killed during its second grader call");
    const saved = fs.existsSync(f.checkpoint) ? Object.keys(loadCheckpoint(f.checkpoint).entries).length : 0;
    fs.rmSync(path.join(f.base, "ctl", "codex-kill-2"));
    const rerun = f.run("--second", "none");
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.equal(f.calls("codex") - 2, 2, "the rerun grades only the two rows left");
    assert.equal(saved, 1, "the first run saved its finished grade before it was killed");
    assert.deepEqual(
      f.grades().map((r) => [r.run, r.grade?.reason]),
      [
        ["r1", "codex call 1"],
        ["r2", "codex call 3"],
        ["r3", "codex call 4"],
      ],
    );
  } finally {
    f.done();
  }
});

test("checkpoint: grading a finished build again calls no grader, and a changed answer grades only its row", () => {
  const f = gradeFixture(runs("a1", "a2", "a3"));
  try {
    assert.equal(f.run().status, 0);
    const first = f.grades();
    assert.deepEqual([f.calls("codex"), f.calls("claude")], [3, 3]);
    const again = f.run();
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual([f.calls("codex"), f.calls("claude")], [3, 3], "nothing is graded twice");
    assert.deepEqual(f.grades(), first);
    assert.match(again.stdout, /r1: score 2 \(reused\)/);
    assert.match(again.stdout, /Grader calls: 0 made, 6 reused/);
    const loop = JSON.parse(fs.readFileSync(f.loop, "utf8"));
    loop.rows[1].answer = "a2, reworded";
    fs.writeFileSync(f.loop, JSON.stringify(loop));
    assert.equal(f.run().status, 0);
    assert.deepEqual([f.calls("codex"), f.calls("claude")], [4, 4], "only the changed row");
    assert.equal(f.grades()[1]?.grade?.reason, "codex call 4");
    assert.equal(f.grades()[0]?.grade?.reason, "codex call 1");
  } finally {
    f.done();
  }
});

test("checkpoint: a grader call that failed is made again, and a malformed answer is kept as it was", () => {
  const f = gradeFixture(runs("fail-me", "garble"));
  try {
    assert.equal(f.run("--second", "none").status, 0);
    const ungraded = () => f.grades().map((r) => [r.run, r.ungraded]);
    const first = ungraded();
    assert.deepEqual(first, [
      ["r1", "grader exit 1"],
      ["r2", "not JSON"],
    ]);
    assert.equal(f.run("--second", "none").status, 0);
    assert.equal(f.calls("codex"), 3, "only the failed call is made again");
    assert.deepEqual(ungraded(), first);
    assert.equal(Object.keys(loadCheckpoint(f.checkpoint).entries).length, 1, "a failed call is not saved");
  } finally {
    f.done();
  }
});

test("checkpoint keeps Codex's grade when grading stops during Claude's, and the rerun calls only Claude", () => {
  const f = gradeFixture(runs("a1"));
  try {
    f.killAt("claude", 1);
    assert.equal(f.run().signal, "SIGKILL");
    assert.deepEqual(
      Object.values(loadCheckpoint(f.checkpoint).entries).map((e) => e.grader),
      ["codex"],
      "Codex's grade was saved before Claude was called",
    );
    fs.rmSync(path.join(f.base, "ctl", "claude-kill-1"));
    assert.equal(f.run().status, 0);
    assert.deepEqual([f.calls("codex"), f.calls("claude")], [1, 2]);
    const [r1] = f.grades();
    assert.equal(r1?.grade?.reason, "codex call 1");
    assert.deepEqual(r1?.second, { grade: { ...grade, score: 1, reason: "claude call 2" } });
  } finally {
    f.done();
  }
});

test("checkpoint that cannot be read stops grading before any grader call and is left as it was", () => {
  for (const text of [
    "{",
    JSON.stringify({ version: 1, entries: [] }),
    JSON.stringify({ version: 2, entries: {} }),
  ]) {
    const f = gradeFixture(runs("a1"));
    try {
      fs.writeFileSync(f.checkpoint, text);
      const r = f.run("--second", "claude");
      assert.notEqual(r.status, 0, text);
      assert.ok(r.stderr.includes(f.checkpoint), `names the file: ${r.stderr}`);
      assert.equal(fs.readFileSync(f.checkpoint, "utf8"), text);
      assert.deepEqual([f.calls("codex"), f.calls("claude")], [0, 0]);
      assert.equal(fs.existsSync(path.join(f.build, "grades.json")), false);
    } finally {
      f.done();
    }
  }
});

test("checkpoint keeps two runs apart when the grader is given the same text for both", () => {
  const f = gradeFixture(runs("same", "same"));
  try {
    assert.equal(
      blindPrompt(task, { ...row, answer: "same" }),
      blindPrompt(task, { ...row, run: "r2", answer: "same" }),
    );
    assert.equal(f.run("--second", "none").status, 0);
    assert.equal(f.calls("codex"), 2);
    assert.equal(Object.keys(loadCheckpoint(f.checkpoint).entries).length, 2);
  } finally {
    f.done();
  }
});

test("checkpoint that cannot be saved stops grading before the next grader call and keeps what was saved", () => {
  const f = gradeFixture(runs("a1", "a2", "a3"));
  try {
    // The second call's answer cannot be saved: the build directory is read-only from then on
    const codex = path.join(f.base, "bin", "codex");
    fs.writeFileSync(
      codex,
      fs
        .readFileSync(codex, "utf8")
        .replace(
          "input=$(cat)\n",
          `input=$(cat)\ncase "$input" in *a2*) chmod 555 ${JSON.stringify(f.build)};; esac\n`,
        ),
    );
    const r = f.run("--second", "claude");
    assert.notEqual(r.status, 0, "the failed save stops grading");
    assert.ok(r.stderr.includes(f.checkpoint), `the error names the checkpoint: ${r.stderr}`);
    assert.deepEqual(
      [f.calls("codex"), f.calls("claude")],
      [2, 1],
      "no grader is called after the failed save",
    );
    fs.chmodSync(f.build, 0o755);
    assert.deepEqual(
      Object.values(loadCheckpoint(f.checkpoint).entries).map((e) => [e.grader, e.output.includes("call 1")]),
      [
        ["codex", true],
        ["claude", true],
      ],
    );
  } finally {
    fs.chmodSync(f.build, 0o755);
    f.done();
  }
});

test("checkpoint starts Codex with the settings its key holds, even when the owner's config changes during grading", () => {
  const f = gradeFixture(runs("a1", "a2"));
  try {
    const codex = path.join(f.base, "bin", "codex");
    const seen = path.join(f.base, "ctl", "configs");
    const ownerConfig = path.join(f.base, "owner", ".codex", "config.toml");
    fs.writeFileSync(
      codex,
      fs
        .readFileSync(codex, "utf8")
        .replace(
          "input=$(cat)\n",
          `input=$(cat)\ngrep model "$CODEX_HOME/config.toml" >> ${JSON.stringify(seen)}\nprintf 'model = "n"\\n' > ${JSON.stringify(ownerConfig)}\n`,
        ),
    );
    assert.equal(f.run("--second", "none").status, 0);
    assert.deepEqual(fs.readFileSync(seen, "utf8").split("\n").filter(Boolean), [
      'model = "m"',
      'model = "m"',
    ]);
  } finally {
    f.done();
  }
});

test("checkpoint gives Codex the schema text its key holds, in the call's own directory", () => {
  const f = gradeFixture(runs("a1"));
  try {
    const codex = path.join(f.base, "bin", "codex");
    const seen = path.join(f.base, "ctl", "schema");
    fs.writeFileSync(
      codex,
      fs
        .readFileSync(codex, "utf8")
        .replace(
          "input=$(cat)\n",
          `input=$(cat)\nfor a in "$@"; do [ "$prev" = "--output-schema" ] && { echo "$a"; cat "$a"; } > ${JSON.stringify(seen)}; prev=$a; done\n`,
        ),
    );
    assert.equal(f.run("--second", "none").status, 0);
    const [given, ...text] = fs.readFileSync(seen, "utf8").split("\n");
    const repo = path.join(import.meta.dirname, "..", "evals", "cloud");
    assert.ok(given && !given.startsWith(repo), `not the repository's file: ${given}`);
    assert.equal(text.join("\n"), fs.readFileSync(path.join(repo, "grade.schema.json"), "utf8"));
  } finally {
    f.done();
  }
});

test("checkpoint marks a row reused only when its Codex grade was", () => {
  const f = gradeFixture(runs("a1"));
  try {
    assert.equal(f.run().status, 0);
    fs.writeFileSync(path.join(f.base, "owner", ".codex", "config.toml"), 'model = "n"\n');
    const again = f.run();
    assert.equal(again.status, 0, again.stderr);
    assert.deepEqual(
      [f.calls("codex"), f.calls("claude")],
      [2, 1],
      "Codex grades again, Claude's grade is reused",
    );
    assert.match(again.stdout, /r1: score 2\n/);
  } finally {
    f.done();
  }
});

test("the Codex grader reads through the read fence, and grading refuses runs kept where the fence does not reach", () => {
  assert.ok(
    !GRADER_ARGS.codex.includes("-s") && !GRADER_ARGS.codex.includes("--sandbox"),
    "the profile is the sandbox",
  );
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-grade-fence-"));
  try {
    const owner = path.join(base, "owner");
    fs.mkdirSync(path.join(owner, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(owner, ".codex", "config.toml"), 'model = "m"\n');
    const cache = path.join(fs.realpathSync(owner), ".cache", "sphica-eval");
    const build = path.join(cache, "builds", "b");
    fs.mkdirSync(build, { recursive: true });
    seedTasks(build);
    const bin = path.join(base, "bin");
    fs.mkdirSync(bin);
    const seen = path.join(base, "seen");
    fs.writeFileSync(
      path.join(bin, "codex"),
      `#!/bin/sh
{ printf '%s\\n' "$@"; cat "$CODEX_HOME/config.toml"; } > ${JSON.stringify(seen)}
while [ "$1" != "-o" ]; do shift; done
printf '%s' ${JSON.stringify(JSON.stringify(grade))} > "$2"
`,
      { mode: 0o755 },
    );
    const roots = ["codex-runs", "claude-runs", "logs"].map((d) => path.join(cache, d));
    const loop = path.join(build, "loop.json");
    const start = (loopJson: Record<string, unknown>, file = loop) => {
      fs.writeFileSync(file, JSON.stringify({ build: "b", bundle: "c", ...loopJson }));
      return spawnSync(
        process.execPath,
        [
          path.join(import.meta.dirname, "..", "evals", "cloud", "grade.ts"),
          "--loop",
          file,
          "--second",
          "none",
        ],
        { encoding: "utf8", env: { ...childEnv(owner), PATH: `${bin}${path.delimiter}${process.env.PATH}` } },
      );
    };
    const rows = [{ ...row, fence: "f".repeat(64) }];
    const r = start({ run_roots: roots, rows });
    assert.equal(r.status, 0, r.stderr);
    const got = fs.readFileSync(seen, "utf8");
    assert.ok(!got.split("\n").includes("-s"));
    // The grader reads back only its own tree in the denied temp directory, and writes nowhere
    const lines = got.split("\n");
    const tree = path.dirname(lines[lines.indexOf("-C") + 1] ?? "");
    assert.ok(lines.includes(`${JSON.stringify(path.dirname(tree))} = "deny"`), got);
    assert.ok(lines.includes(`${JSON.stringify(tree)} = "read"`), got);
    assert.ok(!lines.some((l) => l.endsWith(' = "write"')), got);
    assert.match(got, /^default_permissions = "eval"$/m);
    assert.match(got, /^extends = ":read-only"$/m);
    assert.match(
      got,
      new RegExp(`^${JSON.stringify(cache).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} = "deny"$`, "m"),
    );
    assert.match(got, /codex", "auth\.json" = "deny"|\.codex\/auth\.json" = "deny"$/m);
    const graded = JSON.parse(fs.readFileSync(path.join(build, "grades.json"), "utf8"));
    assert.equal(graded.rows[0].fence, "f".repeat(64));
    assert.equal(graded.grader_fence, GRADER_FENCE);
    assert.ok(!fs.existsSync(path.join(cache, "codex.lock")), "the lock is released");
    // Runs kept where the fenced runs could read them, or a loop that does not say where its runs were, are not graded
    assert.match(start({ rows }).stderr, /run_roots/);
    assert.match(start({ run_roots: [], rows }).stderr, /run_roots/);
    // Codex runs made under two fences, or none, are not graded into one table
    assert.match(
      start({ run_roots: roots, rows: [rows[0], { ...row, run: "r2", fence: "0".repeat(64) }] }).stderr,
      /read fences/,
    );
    assert.match(start({ run_roots: roots, rows: [{ ...row, fence: undefined }] }).stderr, /read fences/);
    assert.match(
      start({ run_roots: [...roots, path.join(base, "elsewhere")], rows }).stderr,
      /must be inside/,
    );
    const outside = path.join(base, "build");
    fs.mkdirSync(outside);
    seedTasks(outside);
    assert.match(start({ run_roots: roots, rows }, path.join(outside, "loop.json")).stderr, /must be inside/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
