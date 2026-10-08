// Grades one evaluation loop blind: each row goes to Codex with only the task, answer, and patch, through grade.schema.json; finished
// calls are kept in grades.checkpoint.json so a rerun grades only what it lacks. --probe instead shows what the grader cannot read.
// Run: node evals/cloud/grade.ts --loop <build dir>/loop.json [--second claude|none] [--probe]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { replaceFile } from "../../src/file-lock.ts";
import { codexLock, evalCache, fencedCodexHome, ownerCodexSettings, requireInside } from "./codex-home.ts";
import { codexDenies, currentFence, outsideTree } from "./codex-run.ts";
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
import {
  cacheToken,
  type ProbeTarget,
  probeLines,
  probeProblems,
  probeScript,
  probeTargets,
} from "./probe.ts";
import type { Grade } from "./schema-check.ts";

const schema = fs.readFileSync(path.join(import.meta.dirname, "grade.schema.json"), "utf8");
const { values: args } = parseArgs({
  options: {
    // A build's loop.json (collect writes it in the build directory); the grades go beside it
    loop: { type: "string" },
    // The second grader: Claude grades the same runs with the same prompt and schema, for agreement only; "none" skips it
    second: { type: "string", default: "claude" },
    probe: { type: "boolean", default: false },
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
  run_roots?: unknown;
  rows: GradeRow[];
};
// The Codex runs were denied the evaluation cache as a whole; a build or run kept elsewhere may have been read by one of them
const cache = evalCache();
requireInside(cache, path.dirname(args.loop), "the build");
if (
  !Array.isArray(loop.run_roots) ||
  !loop.run_roots.length ||
  !loop.run_roots.every((r) => typeof r === "string" && path.isAbsolute(r))
)
  throw new Error(`${args.loop} does not say where its runs were (run_roots); collect it again`);
for (const root of loop.run_roots as string[]) requireInside(cache, root, "a run root");
const denies = codexDenies(cache);
const graderFence = currentFence(":read-only", cache);
const release = codexLock(cache);
process.on("exit", release);

/**
 * One grader run in a fresh empty directory, with its own HOME and CODEX_HOME: the prompt carries everything, so there is nothing of the
 * loop for it to read nearby, and none of the owner's hooks or plugins can add context to a blind grade.
 */
function gradeOne(
  prompt: string,
  settings: string,
  /** A probe: plants its files in the grader's directory, and the call answers freely with its events kept */
  plant?: (dir: string) => void,
): { status: number | null; output: string; events: string } {
  const dir = outsideTree("sphica-grade-", denies);
  const home = outsideTree("sphica-grade-home-", denies);
  try {
    fencedCodexHome(path.join(home, ".codex"), { base: ":read-only", deny: denies, settings });
    // The schema text the checkpoint key holds, not the file, which may change while grading runs
    const schemaFile = path.join(home, "grade.schema.json");
    fs.writeFileSync(schemaFile, schema);
    const out = path.join(dir, "grade.json");
    plant?.(dir);
    const r = spawnSync(
      "codex",
      plant
        ? [...GRADER_ARGS.codex, "--json", "-C", dir, "-o", out, "-"]
        : [...GRADER_ARGS.codex, "-C", dir, "--output-schema", schemaFile, "-o", out, "-"],
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
    return {
      status: r.status,
      output: fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "",
      events: r.stdout ?? "",
    };
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

if (args.probe) {
  const token = cacheToken(cache);
  const problems: string[] = [];
  try {
    let targets: ProbeTarget[] = [];
    const r = gradeOne(
      "Run ./probe.sh once and quote its whole output. Do nothing else.",
      ownerCodexSettings(),
      (dir) => {
        const control = path.join(dir, "probe-control.txt");
        fs.writeFileSync(control, "control\n");
        targets = probeTargets([
          token,
          {
            label: "build-tasks",
            path: path.join(path.dirname(args.loop ?? ""), "tasks.json"),
            expect: "DENIED",
          },
          { label: "control", path: control, expect: "READ" },
        ]);
        fs.writeFileSync(path.join(dir, "probe.sh"), probeScript(targets, null), { mode: 0o755 });
      },
    );
    console.log(probeLines(r.events));
    problems.push(...probeProblems(r.events, targets));
    if (r.status !== 0) problems.push(`the grader exited ${r.status}`);
  } finally {
    fs.rmSync(token.path, { force: true });
  }
  for (const p of problems) console.log(`✗ ${p}`);
  if (!problems.length) console.log("✓ probe passed: every fenced target was denied to the grader");
  // Nothing is graded and no checkpoint or grades file is read or written
  process.exit(problems.length ? 1 : 0);
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
    codexFence: grader === "codex" ? graderFence : null,
  });
  const saved = checkpoint.entries[key];
  if (saved) {
    reused++;
    return saved;
  }
  called++;
  const run = settings !== null ? gradeOne(prompt, settings) : gradeClaude(prompt);
  if (run.status === 0) {
    checkpoint.entries[key] = {
      grader,
      status: run.status,
      output: run.output,
      at: new Date().toISOString(),
    };
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
  const codexReused = reused > before;
  // The second grade is kept beside the first for agreement; the table's values stay Codex's
  const other = args.second === "claude" ? accept(graderRun("claude", task, row, prompt)) : null;
  const second = other && ("graded" in other ? { grade: other.graded } : { ungraded: other.ungraded });
  graded.push({
    ...row,
    ...("graded" in got ? { grade: got.graded } : { ungraded: got.ungraded }),
    ...(second ? { second } : {}),
  });
  console.log(
    `${row.model} ${row.condition} ${row.run}: ${"graded" in got ? `score ${got.graded.score}` : `ungraded (${got.ungraded})`}${codexReused ? " (reused)" : ""}`,
  );
}

const table = tabulate(graded);
replaceFile(
  out,
  `${JSON.stringify({ build: loop.build ?? null, variant, bundle: loop.bundle, grader_fence: graderFence, graded: new Date().toISOString(), rows: graded, table }, null, 2)}\n`,
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
