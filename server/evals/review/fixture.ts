// The review evaluation's fixture: the tsundoku fixture database with the records cases.json adds, the project's files as a git
// repository, and each case's diff against it, written where a run can read them and the expected verdicts cannot be.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createDriver } from "../acceptance/driver.ts";
import { loadAcceptance, type Step } from "../acceptance/load.ts";
import { fixtureSteps } from "../cloud/build-lib.ts";

const HERE = import.meta.dirname;
/** The origin the acceptance driver gives tsundoku: Sphica finds the records' project by it */
const ORIGIN = "https://github.com/example/tsundoku.git";

type Outcome = "violation" | "complies" | "unrelated" | "undetermined";
/** What counts as right for one record of one diff: any of the outcomes, and whether the diff leaves the record to a question */
type Expected = { outcomes: Outcome[]; question: boolean };
type Edit = { path: string; content?: string; replace?: [string, string] };
type ReviewDiff = { id: string; summary: string; edits: Edit[]; expect: Record<string, Expected> };
export type ReviewCases = { files: Record<string, string>; steps: Step[]; diffs: ReviewDiff[] };

export function loadReviewCases(): ReviewCases {
  return JSON.parse(fs.readFileSync(path.join(HERE, "cases.json"), "utf8")) as ReviewCases;
}

export type ReviewFixture = { db: string; repo: string; diffs: Record<string, string> };

const git = (repo: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "user.name=hana",
      "-c",
      "user.email=hana@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );

function write(root: string, rel: string, text: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** Builds the fixture under out: fixture.db, repo/ (origin set where the records' project is), and diffs/<id>.diff. */
export async function buildReviewFixture(
  out: string,
  cases: ReviewCases = loadReviewCases(),
): Promise<ReviewFixture> {
  const plan = JSON.parse(fs.readFileSync(path.join(HERE, "..", "cloud", "tasks.json"), "utf8"));
  const { world } = loadAcceptance();
  const files = { ...world.files, ...cases.files };
  const driver = await createDriver({ ...world, files });
  const db = path.join(out, "fixture.db");
  try {
    for (const step of [...fixtureSteps(plan, false), ...cases.steps]) await driver.run(step);
    await driver.snapshot(db);
  } finally {
    await driver.done();
  }

  const repo = path.join(out, "repo");
  fs.mkdirSync(repo, { recursive: true });
  for (const [rel, text] of Object.entries(files))
    if (text !== "BINARY" && text !== "OVERSIZED") write(repo, rel, text);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "remote", "add", "origin", ORIGIN);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "tsundoku");

  const diffs: Record<string, string> = {};
  fs.mkdirSync(path.join(out, "diffs"), { recursive: true });
  for (const d of cases.diffs) {
    for (const e of d.edits) {
      const file = path.join(repo, e.path);
      if (e.content !== undefined) write(repo, e.path, e.content);
      else if (e.replace) {
        const text = fs.readFileSync(file, "utf8");
        if (!text.includes(e.replace[0])) throw new Error(`${d.id}: ${e.path} has no ${e.replace[0]}`);
        fs.writeFileSync(file, text.replace(e.replace[0], e.replace[1]));
      } else throw new Error(`${d.id}: an edit of ${e.path} needs content or replace`);
    }
    git(repo, "add", "-A");
    const text = git(repo, "diff", "--cached", "--no-color", "--no-ext-diff");
    if (!text.trim()) throw new Error(`${d.id}: the edits change nothing`);
    diffs[d.id] = path.join(out, "diffs", `${d.id}.diff`);
    fs.writeFileSync(diffs[d.id] ?? "", text);
    git(repo, "reset", "-q", "--hard", "HEAD");
  }
  return { db, repo, diffs };
}
