// Grades one evaluation loop blind (step 5 of the eval-loop Skill): every result row of loop.json goes to Codex with only the task and the
// run's own answer and patch, in an empty directory, and comes back through grade.schema.json; the table counts every started run.
// Each finished grader call is saved in grades.checkpoint.json beside it, and a rerun calls the graders only for what is not saved with the
// same inputs. Run: node evals/cloud/grade.ts --loop <build dir>/loop.json [--second claude|none]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { replaceFile } from "../../src/file-lock.ts";
import { isolatedCodexHome, ownerCodexSettings } from "./codex-home.ts";
import { readTasks } from "./firing.ts";
import {
  blindPrompt,
  type Cell,
  checkpointKey,
  GRADER_ARGS,
  type GradeRow,
  type Grader,
  type GradeTask,
  gradedTask,
  loadCheckpoint,
  receiveGrade,
  saveCheckpoint,
  tabulate,
} from "./grading.ts";
import type { Grade } from "./schema-check.ts";

const SCHEMA_FILE = path.join(import.meta.dirname, "grade.schema.json");
const schema = fs.readFileSync(SCHEMA_FILE, "utf8");
const { values: args } = parseArgs({
  options: {
    // A build's loop.json (collect writes it in the build directory); the grades go beside it
    loop: { type: "string" },
    // The second grader: Claude grades the same runs with the same prompt and schema, for agreement only; "none" skips it
    second: { type: "string", default: "claude" },
  },
});

if (!args.loop) throw new Error("--loop <build dir>/loop.json names what to grade");
if (args.second !== "claude" && args.second !== "none") throw new Error("--second is claude or none");
const plan = readTasks<{ tasks: GradeTask[] }>(path.dirname(args.loop));
// report reads tasks.json beside grades.json, so it is always written into the build
const out = path.join(path.dirname(args.loop), "grades.json");
const checkpointFile = path.join(path.dirname(args.loop), "grades.checkpoint.json");
const loop = JSON.parse(fs.readFileSync(args.loop, "utf8")) as {
  build?: string | null;
  variant?: string;
  bundle: string;
  rows: GradeRow[];
};

/**
 * One grader run in a fresh empty directory, with its own HOME and CODEX_HOME: the prompt carries everything, so there is nothing of the
 * loop for it to read nearby, and none of the owner's hooks or plugins can add context to a blind grade.
 */
function gradeOne(prompt: string, settings: string): { status: number | null; output: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-grade-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-grade-home-"));
  try {
    isolatedCodexHome(path.join(home, ".codex"), "", settings);
    const out = path.join(dir, "grade.json");
    const r = spawnSync(
      "codex",
      [...GRADER_ARGS.codex, "-C", dir, "--output-schema", SCHEMA_FILE, "-o", out, "-"],
      {
        input: prompt,
        encoding: "utf8",
        timeout: 15 * 60_000,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          CODEX_HOME: path.join(home, ".codex"),
          LANG: process.env.LANG ?? "",
        },
      },
    );
    return { status: r.status, output: fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "" };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/**
 * The second grader: Claude through the owner's subscription (--bare would need an API key), in an empty directory with no settings
 * sources, MCP servers, tools, or skills, so no CLAUDE.md, hook, or plugin adds context to the blind prompt.
 */
function gradeClaude(prompt: string): { status: number | null; output: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-grade-"));
  try {
    const r = spawnSync("claude", [...GRADER_ARGS.claude, "--json-schema", schema], {
      cwd: dir,
      input: prompt,
      encoding: "utf8",
      timeout: 15 * 60_000,
    });
    let output = "";
    try {
      const structured = (JSON.parse(r.stdout) as { structured_output?: unknown }).structured_output;
      output = structured === undefined ? "" : JSON.stringify(structured);
    } catch {}
    return { status: r.status, output };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const checkpoint = loadCheckpoint(checkpointFile);
// Read once, when the first row is graded: every Codex call of the run starts with the settings its key holds, and a build with nothing
// to grade needs no Codex config
let codexConfig: string | undefined;
const variant = loop.variant ?? "original";
let called = 0;
let reused = 0;

/** A saved call with the same inputs, else a new one, saved before anything else runs when it exited 0 (a failed call is tried again). */
function graderRun(
  grader: Grader,
  task: GradeTask,
  row: GradeRow,
  prompt: string,
): { status: number | null; output: string } {
  const settings = grader === "codex" ? (codexConfig ?? ownerCodexSettings()) : null;
  if (settings !== null) codexConfig = settings;
  const key = checkpointKey({
    grader,
    task,
    row,
    prompt,
    build: loop.build ?? null,
    bundle: loop.bundle,
    variant,
    schema,
    codexConfig: settings,
  });
  const saved = checkpoint.entries[key];
  if (saved) {
    reused++;
    return saved;
  }
  called++;
  const run = settings !== null ? gradeOne(prompt, settings) : gradeClaude(prompt);
  if (run.status === 0) {
    checkpoint.entries[key] = { grader, ...run, at: new Date().toISOString() };
    saveCheckpoint(checkpointFile, checkpoint);
  }
  return run;
}

const graded: (GradeRow & {
  grade?: Grade;
  ungraded?: string;
  second?: { grade: Grade } | { ungraded: string };
})[] = [];
for (const row of loop.rows) {
  if (row.excluded) {
    graded.push(row);
    continue;
  }
  const task = plan.tasks.find((t) => t.id === row.task);
  if (!task) {
    graded.push({ ...row, ungraded: `unknown task ${row.task}` });
    continue;
  }
  const prompt = blindPrompt(gradedTask(task, variant), row);
  const accept = (run: { status: number | null; output: string }) =>
    receiveGrade(
      run,
      row.patch_truncated,
      gradedTask(task, variant).against !== undefined,
      Boolean(row.presented),
      task.conflict !== undefined,
    );
  const before = reused;
  const got = accept(graderRun("codex", task, row, prompt));
  // The second grade is kept beside the first for agreement; the table's values stay Codex's
  const other = args.second === "claude" ? accept(graderRun("claude", task, row, prompt)) : null;
  const second = other && ("graded" in other ? { grade: other.graded } : { ungraded: other.ungraded });
  graded.push({
    ...row,
    ...("graded" in got ? { grade: got.graded } : { ungraded: got.ungraded }),
    ...(second ? { second } : {}),
  });
  console.log(
    `${row.model} ${row.condition} ${row.run}: ${"graded" in got ? `score ${got.graded.score}` : `ungraded (${got.ungraded})`}${reused > before ? " (reused)" : ""}`,
  );
}

const table = tabulate(graded);
replaceFile(
  out,
  `${JSON.stringify({ build: loop.build ?? null, variant, bundle: loop.bundle, graded: new Date().toISOString(), rows: graded, table }, null, 2)}\n`,
);

const fmt = (c: Cell) =>
  [
    `${c.model} ${c.condition}`,
    `started ${c.started}, excluded ${c.excluded}, ungraded ${c.ungraded}, graded ${c.graded}`,
    `scores 0/1/2: ${c.scores[0]}/${c.scores[1]}/${c.scores[2]}`,
    `delivered yes/no/na: ${c.delivered.yes}/${c.delivered.no}/${c.delivered.not_applicable}`,
    `found yes/no/unknown: ${c.found.yes}/${c.found.no}/${c.found.unknown}`,
    `answer valid/invalid/refused/na: ${c.answer_format.valid}/${c.answer_format.invalid}/${c.answer_format.refused_or_empty}/${c.answer_format.not_applicable}`,
    `cited ${c.cited_gold}`,
    `implements rejected yes/no/unknown/na: ${c.implements_rejected.yes}/${c.implements_rejected.no}/${c.implements_rejected.unknown}/${c.implements_rejected.not_applicable}`,
    `tracked failure ${c.tracked_failure}`,
  ].join("  |  ");
for (const c of table) console.log(fmt(c));
console.log(`Grader calls: ${called} made, ${reused} reused from ${checkpointFile}.`);
console.log("Graders run read-only in an empty directory; read-only does not stop them reading elsewhere.");
