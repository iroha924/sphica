// The evaluation's structured grading: grades and Codex answers are counted only when they match their fixed shapes exactly,
// and anything else is kept apart with the reason rather than read as a score or as "nothing found".
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { blindPrompt, receiveGrade, tabulate } from "../evals/cloud/grading.ts";
import {
  answerFormat,
  capPatch,
  deliveredSignal,
  foundInClaudeLog,
  foundInCodexEvents,
  goldSignalsFromClaude,
  goldSignalsFromCodex,
} from "../evals/cloud/judge.ts";
import { checkAnswer, checkGrade, type Grade } from "../evals/cloud/schema-check.ts";

const grade: Grade = {
  score: 2,
  reason: "kept the recorded search design",
  cited_gold: "yes",
  implements_rejected: "no",
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
    const out = path.join(base, "loop.json");
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
        "--out",
        out,
      ],
      { stdio: "ignore" },
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
  // not_applicable only when the task has no "Against", and only then
  const na = JSON.stringify({ ...grade, implements_rejected: "not_applicable" });
  assert.match(
    (receiveGrade({ status: 0, output: na }, false, true) as { ungraded: string }).ungraded,
    /not_applicable/,
  );
  assert.match(
    (receiveGrade({ status: 0, output: good }, false, false) as { ungraded: string }).ungraded,
    /not_applicable/,
  );
  assert.deepEqual(receiveGrade({ status: 0, output: na }, false, false), {
    graded: { ...grade, implements_rejected: "not_applicable" },
  });
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

test("collect needs a fired count for every slot and refuses unknown slot names", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-collect-"));
  try {
    const build = path.join(base, "build");
    fs.mkdirSync(build);
    fs.writeFileSync(
      path.join(build, "manifest.json"),
      JSON.stringify({ commit: "c", repositories: { "eval-shelf-1": { condition: "none" } } }),
    );
    const collect = (...extra: string[]) =>
      spawnSync(
        process.execPath,
        [
          path.join(import.meta.dirname, "..", "evals", "cloud", "collect.ts"),
          "--build",
          build,
          "--codex",
          path.join(base, "codex"),
          "--logs",
          base,
          "--out",
          path.join(base, "loop.json"),
          ...extra,
        ],
        { encoding: "utf8" },
      );
    assert.match(collect().stderr, /--fired eval-shelf-1=<n>/);
    assert.match(
      collect("--fired", "eval-shelf-1=1", "--fired", "eval-shelf-9=1").stderr,
      /unknown slot eval-shelf-9/,
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
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
    const loop = path.join(base, "loop.json");
    fs.writeFileSync(loop, JSON.stringify({ bundle: "c", rows: [{ ...row, answer_format: "valid" }] }));
    const r = spawnSync(
      process.execPath,
      [
        path.join(import.meta.dirname, "..", "evals", "cloud", "grade.ts"),
        "--loop",
        loop,
        "--out",
        path.join(base, "grades.json"),
      ],
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
