// Grades one evaluation loop blind (step 5 of the eval-loop Skill): every result row of loop.json goes to Codex with only the task and the
// run's own answer and patch, in an empty directory, and comes back through grade.schema.json; the table counts every started run.
// Run: node evals/cloud/grade.ts --loop <build dir>/loop.json [--out <grades.json>] [--second claude|none]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { isolatedCodexHome } from "./codex-home.ts";
import { blindPrompt, type Cell, type GradeRow, type GradeTask, receiveGrade, tabulate } from "./grading.ts";
import type { Grade } from "./schema-check.ts";

const HERE = import.meta.dirname;
const { values: args } = parseArgs({
  options: {
    // A build's loop.json (collect writes it in the build directory); the grades go beside it
    loop: { type: "string" },
    out: { type: "string" },
    // The second grader: Claude grades the same runs with the same prompt and schema, for agreement only; "none" skips it
    second: { type: "string", default: "claude" },
  },
});

const plan = JSON.parse(fs.readFileSync(path.join(HERE, "tasks.json"), "utf8")) as { tasks: GradeTask[] };
if (!args.loop) throw new Error("--loop <build dir>/loop.json names what to grade");
const out = args.out ?? path.join(path.dirname(args.loop), "grades.json");
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
function gradeOne(prompt: string): { status: number | null; output: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-grade-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-grade-home-"));
  try {
    isolatedCodexHome(path.join(home, ".codex"));
    const out = path.join(dir, "grade.json");
    const r = spawnSync(
      "codex",
      [
        "exec",
        "-s",
        "read-only",
        "--ephemeral",
        "--ignore-rules",
        "--skip-git-repo-check",
        "-C",
        dir,
        "--output-schema",
        path.join(HERE, "grade.schema.json"),
        "-o",
        out,
        "-",
      ],
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
    const schema = fs.readFileSync(path.join(HERE, "grade.schema.json"), "utf8");
    const r = spawnSync(
      "claude",
      [
        "-p",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--tools",
        "",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--output-format",
        "json",
        "--json-schema",
        schema,
      ],
      { cwd: dir, input: prompt, encoding: "utf8", timeout: 15 * 60_000 },
    );
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
  const prompt = blindPrompt(task, row);
  const accept = (run: { status: number | null; output: string }) =>
    receiveGrade(run, row.patch_truncated, task.against !== undefined, Boolean(row.presented));
  const got = accept(gradeOne(prompt));
  // The second grade is kept beside the first for agreement; the table's values stay Codex's
  const other = args.second === "claude" ? accept(gradeClaude(prompt)) : null;
  const second = other && ("graded" in other ? { grade: other.graded } : { ungraded: other.ungraded });
  graded.push({
    ...row,
    ...("graded" in got ? { grade: got.graded } : { ungraded: got.ungraded }),
    ...(second ? { second } : {}),
  });
  console.log(
    `${row.model} ${row.condition} ${row.run}: ${"graded" in got ? `score ${got.graded.score}` : `ungraded (${got.ungraded})`}`,
  );
}

const table = tabulate(graded);
fs.writeFileSync(
  out,
  `${JSON.stringify({ build: loop.build ?? null, variant: loop.variant ?? "original", bundle: loop.bundle, graded: new Date().toISOString(), rows: graded, table }, null, 2)}\n`,
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
console.log("Graders run read-only in an empty directory; read-only does not stop them reading elsewhere.");
