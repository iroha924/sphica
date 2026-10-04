// The evaluation's structured grading: grades and Codex answers are counted only when they match their fixed shapes exactly,
// and anything else is kept apart with the reason rather than read as a score or as "nothing found".
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { claimRunDir, codexModelOf } from "../evals/cloud/codex-home.ts";
import { type FiringRow, pair, planRows, taskFromReceipts } from "../evals/cloud/firing.ts";
import { blindPrompt, gradedTask, receiveGrade, tabulate } from "../evals/cloud/grading.ts";
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
import { compare, report } from "../evals/cloud/report.ts";
import {
  checkAnswer,
  checkGrade,
  type Grade,
  jsonSchemaOf,
  SCHEMA_FILES,
} from "../evals/cloud/schema-check.ts";

const TASKS = path.join(import.meta.dirname, "..", "evals", "cloud", "tasks.json");
// A build holds a copy of the task definitions it was made from
const seedTasks = (build: string) => fs.copyFileSync(TASKS, path.join(build, "tasks.json"));

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
      "result.json": { ...head, condition: "none", status: 0, reason: null, seconds: 1, deliveries: null },
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
    const loop = path.join(base, "loop.json");
    fs.writeFileSync(loop, JSON.stringify({ bundle: "c", rows: [{ ...row, answer_format: "valid" }] }));
    seedTasks(base);
    const r = spawnSync(
      process.execPath,
      [path.join(import.meta.dirname, "..", "evals", "cloud", "grade.ts"), "--loop", loop],
      {
        encoding: "utf8",
        env: {
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
    const out = JSON.parse(fs.readFileSync(path.join(base, "grades.json"), "utf8"));
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
        JSON.stringify({ ...head, status: 0, reason: null, seconds: 1, deliveries: null }),
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
      JSON.stringify({ ...head, status: 0, reason: null, seconds: 1, deliveries: null }),
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

test("collect leaves out Codex runs of another build, and build refuses an output directory that already exists", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-collect-"));
  try {
    const build = path.join(base, "build");
    const codex = path.join(base, "codex");
    fs.mkdirSync(build);
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

// The next stage reads tasks.json beside its input, so collect and grade write only into the build directory
test("collect and grade refuse --out and write beside the build's tasks.json", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-out-"));
  try {
    const build = path.join(base, "build");
    const elsewhere = path.join(base, "elsewhere");
    fs.mkdirSync(build);
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
    const collectArgs = ["--build", build, "--codex", path.join(base, "none"), "--logs", base];
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
      JSON.stringify({ ...head, status: 0, reason: null, seconds: 1, deliveries: null }),
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
    build: { build: label, variant: "original", bundle, rows },
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
