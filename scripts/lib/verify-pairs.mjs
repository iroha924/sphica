// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Checks that CI runs exactly what verify runs, and that the jobs running the checks have what they need. It reads the files' texts, so
// tests can feed edited copies; a shape it cannot read is a problem, never a pass.

import { limitsPullRequestsToMain } from "./same-tree.mjs";

// Builds whose output later checks read (tests run plugin/dist). Each part runs on its own runner, so a part that runs a check verify runs
// after a build runs that build first; builds alone may run in several parts.
const BUILDS = ["bundle"];
// The part runs in the sandbox runtime, so a test that writes outside the checkout and the temp directory fails CI
const CI_RUN = '        run: node scripts/sandboxed.mjs bun run "ci:$PART"';
const TARBALL_RUN = /node (\.\.\/)?scripts\/check-tarball\.mjs/;
// Jobs a push to main skips when its pull request already passed the same tree; each must run on anything else
const HEAVY = ["part", "macos", "windows", "git-2-34"];
const CHECK = ".github/workflows/check.yml";
const RELEASE = ".github/workflows/release.yml";
const inJob = (file, name) => `${file} (${name} job)`;
const SAME_RUN = "CI must run exactly what verify runs, or a check added to verify passes CI without running";
const READ = "a workflow shape this check cannot read would pass while checking nothing";
const LYCHEE =
  "the link checks need lychee at mise.toml's pin, downloaded and checked against its SHA-256 before they run";
const SKIP =
  "a push to main may skip a heavy job only when its pull request already passed the same tree, as scripts/same-tree.mjs decides";
const SKIP_IF =
  // oxlint-disable-next-line no-template-curly-in-string -- the workflow line under check holds an expression
  "    if: ${{ !cancelled() && !(needs.same-tree.result == 'success' && needs.same-tree.outputs.tested == 'true') }}";

/** The script names of a `bun run a && bun run b` line, or null for anything else */
export function chain(line) {
  if (typeof line !== "string") return null;
  const names = line.split(" && ").map((p) => /^bun run ([a-z][a-z0-9:-]*)$/.exec(p)?.[1]);
  return names.every(Boolean) ? names : null;
}

/** The uncommented lines of a top-level job, from its key to the next job key */
function job(workflow, name) {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^ {2}\S/.test(lines[end])) end++;
  return lines.slice(start + 1, end).filter((l) => !/^\s*#/.test(l));
}

/** A job's steps, each the lines from its `      - ` to the next */
function steps(lines) {
  const out = [];
  for (const l of lines) {
    if (l.startsWith("      - ")) out.push([l]);
    else if (out.length && (l.startsWith("        ") || l === "")) out.at(-1).push(l);
  }
  return out;
}

const isLychee = (step) => step[0] === "      - name: Install lychee";
/** Whether a step has an if, as its first key or a later one */
const conditional = (step) => step.some((l) => /^ {6}- if:|^ {8}if:/.test(l));
/** The values of a job's `<key>: [...]` matrix line, or null when it has none in that form */
const matrixOf = (lines, key) => {
  const m = lines
    .map((l) => new RegExp(`^ {8}${key}: \\[([^\\]]*)\\]$`).exec(l)?.[1])
    .find((v) => v !== undefined);
  return m === undefined ? null : m.split(",").map((v) => v.trim().replace(/^"(.*)"$/, "$1"));
};

/** What is wrong with the Install lychee step a job needs before the step at index `before` */
function lycheeProblems(where, all, before, version) {
  const at = all.findIndex(isLychee);
  const lychee = (what, fix) => [{ where, what, why: LYCHEE, fix }];
  if (at === -1) return lychee("no Install lychee step", "add the Install lychee step the other job has");
  if (at > before)
    return lychee(
      "Install lychee comes after the step that needs it",
      "move Install lychee before that step",
    );
  const step = all[at];
  if (conditional(step))
    return lychee("Install lychee runs only under a condition", "remove the if from Install lychee");
  if (
    !step.some((l) => /\/lychee-v\$\{LYCHEE\}\//.test(l)) ||
    !step.some((l) => l.includes("sha256sum -c -")) ||
    !step.some((l) => l.includes('>> "$GITHUB_PATH"'))
  )
    return lychee(
      "Install lychee does not download LYCHEE, check its SHA-256, and put it on PATH",
      "download lychee-v$LYCHEE, check it with sha256sum -c -, and append its directory to $GITHUB_PATH",
    );
  const pin = step.map((l) => /^ {10}LYCHEE: "([^"]+)"$/.exec(l)?.[1]).find(Boolean);
  if (version && pin !== version)
    return lychee(
      `LYCHEE is ${pin}, but mise.toml pins lychee ${version}`,
      `set LYCHEE to ${version} with its SHA-256`,
    );
  return [];
}

/**
 * pkg is package.json, check and release the workflows, lychee the version mise.toml pins. Returns the problems, each with where, what,
 * why, and the fix, empty when CI runs every part of verify once on each Node line, lychee is installed before what needs it, and no job
 * takes Bun from a cache.
 */
export function verifyProblems({ pkg, check, release, lychee }) {
  const problems = [];
  const scripts = JSON.parse(pkg).scripts ?? {};
  const verify = chain(scripts.verify);
  const CHAIN = "this check reads the scripts as `bun run a && bun run b` to compare what CI and verify run";
  if (!verify)
    return [
      {
        where: "package.json",
        what: "verify is not a chain of `bun run <script>`",
        why: CHAIN,
        fix: "write verify as `bun run <script>` steps joined by &&",
      },
    ];

  const parts = Object.keys(scripts)
    .filter((k) => k.startsWith("ci:"))
    .map((k) => k.slice(3));
  if (!parts.length)
    problems.push({
      where: "package.json",
      what: "no ci:<part> scripts",
      why: SAME_RUN,
      fix: "split verify into ci:<part> scripts that CI's part matrix runs",
    });
  const ran = [];
  for (const p of parts) {
    const c = chain(scripts[`ci:${p}`]);
    if (!c) {
      problems.push({
        where: "package.json",
        what: `ci:${p} is not a chain of \`bun run <script>\``,
        why: CHAIN,
        fix: `write ci:${p} as \`bun run <script>\` steps joined by &&`,
      });
      continue;
    }
    ran.push(...c);
    for (const build of BUILDS) {
      const after = c.find((s) => verify.indexOf(s) > verify.indexOf(build) && verify.includes(build));
      if (after && !(c.includes(build) && c.indexOf(build) < c.indexOf(after)))
        problems.push({
          where: "package.json",
          what: `ci:${p} runs ${after} without running ${build} before it, as verify does`,
          why: "each part runs on its own runner, so a check that reads a build's output finds nothing unless the part builds first",
          fix: `run bun run ${build} before ${after} in ci:${p}`,
        });
    }
  }
  for (const s of verify)
    if (!ran.includes(s))
      problems.push({
        where: "package.json",
        what: `no ci:<part> script runs ${s}, which verify runs`,
        why: SAME_RUN,
        fix: `add bun run ${s} to one ci:<part> script`,
      });
  for (const s of new Set(ran)) {
    if (!verify.includes(s))
      problems.push({
        where: "package.json",
        what: `a ci:<part> script runs ${s}, which verify does not`,
        why: SAME_RUN,
        fix: `add bun run ${s} to verify, or remove it from the ci:<part> script`,
      });
    else if (!BUILDS.includes(s) && ran.filter((r) => r === s).length > 1)
      problems.push({
        where: "package.json",
        what: `more than one ci:<part> script runs ${s}`,
        why: "verify runs each check once, and running one twice in CI only costs time",
        fix: `keep bun run ${s} in one ci:<part> script`,
      });
  }

  const part = job(check, "part");
  const partJob = inJob(CHECK, "part");
  if (!part)
    problems.push({
      where: CHECK,
      what: "no part job",
      why: SAME_RUN,
      fix: "restore the part job that runs ci:$PART",
    });
  else {
    const listed = matrixOf(part, "part");
    if (!listed)
      problems.push({
        where: partJob,
        what: "the `part: [...]` matrix cannot be read",
        why: READ,
        fix: "write the matrix on one line as part: [a, b, c]",
      });
    else if ([...listed].sort().join() !== [...parts].sort().join())
      problems.push({
        where: partJob,
        what: `the part matrix [${listed.join(", ")}] differs from package.json's ci:<part> [${parts.join(", ")}]`,
        why: SAME_RUN,
        fix: "list every ci:<part> script in the part matrix, and nothing else",
      });
    if (part.some((l) => /^ {8}(include|exclude):/.test(l)))
      problems.push({
        where: partJob,
        what: "the matrix has include or exclude",
        why: "this check does not read them, so a part left out of a Node line would go unseen; every Node line runs every part",
        fix: "remove include and exclude from the matrix",
      });
    if (!part.includes("      fail-fast: false"))
      problems.push({
        where: partJob,
        what: "fail-fast is not false",
        why: "with fail-fast, one failing part cancels the others, and their results are lost",
        fix: "set strategy.fail-fast: false",
      });
    const all = steps(part);
    const at = all.findIndex((s) => s.includes(CI_RUN));
    if (at === -1)
      problems.push({
        where: partJob,
        what: `no step with \`${CI_RUN.trim()}\``,
        why: SAME_RUN,
        fix: `run the part with \`${CI_RUN.trim()}\``,
      });
    else {
      if (conditional(all[at]))
        problems.push({
          where: partJob,
          what: "the verify step runs only under a condition",
          why: SAME_RUN,
          fix: "remove the if from the verify step",
        });
      // oxlint-disable-next-line no-template-curly-in-string -- the workflow line under check holds an expression
      if (!all[at].includes("          PART: ${{ matrix.part }}"))
        problems.push({
          where: partJob,
          what: "the verify step does not take PART from matrix.part",
          why: SAME_RUN,
          // oxlint-disable-next-line no-template-curly-in-string -- the workflow line to write holds an expression
          fix: "set env PART: ${{ matrix.part }} on the verify step",
        });
      // Reach is counted on every line but the first (the engines floor), and nowhere else is it skipped
      const nodes = matrixOf(part, "node") ?? [];
      const floor = nodes[0];
      // Read as plain versions only: YAML spellings the reader does not decode (a trailing comma, escapes) could hide a repeated floor
      if (!nodes.every((n) => /^\d+(\.\d+)*$/.test(n)))
        problems.push({
          where: partJob,
          what: `the Node matrix [${nodes.join(", ")}] holds an entry that is not a plain version`,
          why: READ,
          fix: 'write each Node line as a plain version, like node: ["24.15", "26"]',
        });
      else if (!nodes.some((n) => n !== floor))
        problems.push({
          where: partJob,
          what: `the Node matrix [${nodes.join(", ")}] has no line other than the first`,
          why: "SQL reach and coverage are counted on every line but the first, so with one line they are counted nowhere",
          fix: "add a Node line after the engines floor",
        });
      const unitMode = `          SPHICA_UNIT_MODE: \${{ matrix.node == '${floor}' && 'tests-only' || 'full' }}`;
      if (!floor || !all[at].includes(unitMode))
        problems.push({
          where: partJob,
          what: `the verify step does not set SPHICA_UNIT_MODE to tests-only on the first Node line (${floor ?? "?"}) alone`,
          why: "the first line only runs the tests, so SQL reach and coverage are counted once, on the other lines",
          fix: `set env ${unitMode.trim()} on the verify step`,
        });
      problems.push(...lycheeProblems(partJob, all, at, lychee));
      problems.push(...deferredProblems(all, floor));
    }
  }
  const gate = job(check, "check");
  const GATE =
    "the required checks are this job, and a required check passes when skipped, so it must run always and judge every part";
  if (!gate)
    problems.push({
      where: CHECK,
      what: "no check job",
      why: GATE,
      fix: "restore the check job that runs scripts/check-parts.mjs",
    });
  else {
    const judge = steps(gate).find((s) => s.includes("        run: node scripts/check-parts.mjs part macos"));
    if (
      !gate.includes("    needs: [same-tree, part, macos]") ||
      !gate.includes("    if: always()") ||
      !judge ||
      conditional(judge) ||
      // oxlint-disable-next-line no-template-curly-in-string -- the workflow line under check holds an expression
      !judge.includes("          EVENT: ${{ github.event_name }}")
    )
      problems.push({
        where: inJob(CHECK, "check"),
        what: "the check job does not run always after same-tree, part, and macos and check, by event, that each succeeded",
        why: GATE,
        fix: "give it needs: [same-tree, part, macos], if: always(), and a step running node scripts/check-parts.mjs part macos with EVENT",
      });
    // Each required check stands for every Node line, so the part job must run on the same lines
    const lines = matrixOf(gate, "node");
    const partLines = part && matrixOf(part, "node");
    if (!lines?.length || !partLines || [...lines].sort().join() !== [...partLines].sort().join())
      problems.push({
        where: CHECK,
        what: `the part job runs on Node [${partLines?.join(", ") ?? "?"}], the check job on [${lines?.join(", ") ?? "?"}]`,
        why: "each required check stands for its Node line, so the parts must run on the same lines",
        fix: "give the part and check jobs the same node matrix",
      });
  }

  problems.push(...sameTreeProblems(check));

  const prepare = job(release, "prepare");
  const TARBALL =
    "the release publishes only a tarball check-tarball.mjs started and checked the way users receive it";
  if (!prepare)
    problems.push({
      where: RELEASE,
      what: "no prepare job",
      why: TARBALL,
      fix: "restore the prepare job that packs and checks the tarball",
    });
  else {
    const all = steps(prepare);
    const at = all.findIndex((s) => s.some((l) => TARBALL_RUN.test(l)));
    if (at === -1)
      problems.push({
        where: inJob(RELEASE, "prepare"),
        what: "no step runs check-tarball.mjs",
        why: TARBALL,
        fix: "run node scripts/check-tarball.mjs on the packed tarball",
      });
    else problems.push(...lycheeProblems(inJob(RELEASE, "prepare"), all, at, lychee));
  }

  for (const [file, text] of [
    [CHECK, check],
    [RELEASE, release],
  ]) {
    const all = text.split("\n");
    const bun = steps(all.filter((l) => !/^\s*#/.test(l))).filter((s) =>
      /uses: oven-sh\/setup-bun@/.test(s[0]),
    );
    if (!bun.length)
      problems.push({
        where: file,
        what: "no setup-bun step",
        why: READ,
        fix: "install Bun with the pinned oven-sh/setup-bun step and no-cache: true",
      });
    for (const s of bun)
      if (!s.includes("          no-cache: true"))
        problems.push({
          where: file,
          what: "a setup-bun step restores Bun from a cache (no no-cache: true)",
          why: "the release relies on these checks, so no job runs a Bun another run cached",
          fix: "set no-cache: true on the setup-bun step",
        });
  }
  return problems;
}

/**
 * A version check that defers the server's dependency files needs, later in the same job, the tarball verdict and the check that reads it,
 * both on one line (the engines floor's static part) so a run has one verdict: without them a dependency change would pass unchecked.
 */
function deferredProblems(all, floor) {
  const runs = (step, text) => step.some((l) => l.includes(text));
  const early = all.findIndex((st) => runs(st, "scripts/check-mcp-version.mjs") && runs(st, "--defer-deps"));
  if (early === -1) return [];
  const only = `        if: matrix.part == 'static' && matrix.node == '${floor}'`;
  const verdict = all.findIndex((st, i) => i > early && runs(st, "node scripts/release-verdict.mjs"));
  const final = all.findIndex(
    (st, i) =>
      i > verdict &&
      runs(
        st,
        'node scripts/check-mcp-version.mjs --base "$BASE" --verdict "$RUNNER_TEMP/release-verdict.json"',
      ),
  );
  const tarball = all.findIndex((st) => st.some((l) => TARBALL_RUN.test(l)));
  const DEFER =
    "a version check that defers dependency changes lets them through unchecked unless a tarball verdict decides them";
  if (verdict === -1 || final === -1 || tarball === -1 || tarball > verdict)
    return [
      {
        where: inJob(CHECK, "part"),
        what: "the version check defers dependency changes, but no tarball verdict after the pack and no version check reading it follow",
        why: DEFER,
        fix: "after the pack, run node scripts/release-verdict.mjs and then check-mcp-version.mjs --verdict on its output",
      },
    ];
  if (!all[verdict].includes(only) || !all[final].includes(only))
    return [
      {
        where: inJob(CHECK, "part"),
        what: `the tarball verdict and the check reading it do not both run on the static part of Node ${floor} alone`,
        why: `${DEFER}, and a run has one verdict`,
        fix: `put ${only.trim()} on both steps`,
      },
    ];
  return [];
}

/** What lets a push to main skip the heavy jobs without the evidence scripts/same-tree.mjs requires, or a pull request skip them */
function sameTreeProblems(check) {
  const problems = [];
  // The reuse holds only for runs that tested a merge into main
  if (!check.includes(`on:\n  push:\n    branches: [main]\n`) || !limitsPullRequestsToMain(check))
    problems.push({
      where: CHECK,
      what: "the workflow does not run on pushes to main and on pull requests into main only",
      why: `${SKIP}, and that holds only for runs that tested a merge into main`,
      fix: "trigger on push with branches: [main] and on pull_request with branches: [main]",
    });
  const detector = job(check, "same-tree");
  if (!detector)
    problems.push({
      where: CHECK,
      what: "no same-tree job",
      why: SKIP,
      fix: "restore the same-tree job that decides with scripts/same-tree.mjs",
    });
  else {
    const all = steps(detector);
    const has = (run) =>
      all.some((st) => st.some((l) => l.startsWith(`        run: ${run}`)) && !conditional(st));
    if (
      !detector.includes("    if: github.event_name == 'push'") ||
      !detector.includes("      actions: read") ||
      // oxlint-disable-next-line no-template-curly-in-string -- the workflow line under check holds an expression
      !detector.includes("      tested: ${{ steps.decide.outputs.tested }}") ||
      !all.some(
        (st) => st.includes("        id: decide") && st.includes("        run: node scripts/same-tree.mjs"),
      ) ||
      !has('node scripts/check-commit-msg.mjs --range "$RANGE"') ||
      !has("node scripts/main-version-check.mjs")
    )
      problems.push({
        where: inJob(CHECK, "same-tree"),
        what: "the job does not run only on push, check the push's messages and version, and decide with scripts/same-tree.mjs",
        why: SKIP,
        fix: "run it if: github.event_name == 'push' with actions: read, run the commit message and main version checks unconditionally, and output tested from the step id: decide",
      });
    // The version check reads the decision, so it comes after it and takes its outputs
    const decide = all.findIndex((st) => st.includes("        id: decide"));
    const version = all.findIndex((st) => st.some((l) => l.includes("node scripts/main-version-check.mjs")));
    const reads = (key) =>
      // oxlint-disable-next-line no-template-curly-in-string -- the workflow line under check holds an expression
      all[version]?.includes(`          ${key}: \${{ steps.decide.outputs.${key.toLowerCase()} }}`);
    if (version !== -1 && (decide === -1 || version < decide || !["TESTED", "RUN", "ATTEMPT"].every(reads)))
      problems.push({
        where: inJob(CHECK, "same-tree"),
        what: "the version check does not run after the decision with its tested, run, and attempt",
        why: "the version check reuses the verdict of the run the decision named, so it needs the decision first",
        fix: "run scripts/main-version-check.mjs after the decide step with TESTED, RUN, and ATTEMPT from its outputs",
      });
  }
  for (const name of HEAVY) {
    const lines = job(check, name);
    if (!lines)
      problems.push({ where: CHECK, what: `no ${name} job`, why: SKIP, fix: `restore the ${name} job` });
    else if (!lines.includes("    needs: same-tree") || !lines.includes(SKIP_IF))
      problems.push({
        where: inJob(CHECK, name),
        what: "the job is not skipped exactly when same-tree found the tree already passed",
        why: SKIP,
        fix: `give it needs: same-tree and ${SKIP_IF.trim()}`,
      });
  }
  return problems;
}
