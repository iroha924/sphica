// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Checks that CI runs exactly what verify runs, and that the jobs running the checks have what they need. It reads the files' texts, so
// tests can feed edited copies; a shape it cannot read is a problem, never a pass.

// Builds whose output later checks read (tests run plugin/dist). Each part runs on its own runner, so a part that runs a check verify runs
// after a build runs that build first; builds alone may run in several parts.
const BUILDS = ["bundle"];
const CI_RUN = '        run: bun run "ci:$PART"';
const TARBALL_RUN = /node (\.\.\/)?scripts\/check-tarball\.mjs/;

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
  if (at === -1) return [`${where}: no Install lychee step`];
  if (at > before) return [`${where}: Install lychee comes after the step that needs it`];
  const step = all[at];
  if (conditional(step)) return [`${where}: Install lychee runs only under a condition`];
  if (
    !step.some((l) => /\/lychee-v\$\{LYCHEE\}\//.test(l)) ||
    !step.some((l) => l.includes("sha256sum -c -")) ||
    !step.some((l) => l.includes('>> "$GITHUB_PATH"'))
  )
    return [`${where}: Install lychee does not download LYCHEE, check its SHA-256, and put it on PATH`];
  const pin = step.map((l) => /^ {10}LYCHEE: "([^"]+)"$/.exec(l)?.[1]).find(Boolean);
  if (version && pin !== version) return [`${where}: LYCHEE ${pin} differs from mise.toml lychee ${version}`];
  return [];
}

/**
 * pkg is package.json, check and release the workflows, lychee the version mise.toml pins. Returns the problems, empty when CI runs every
 * part of verify once on each Node line, lychee is installed before what needs it, and no job takes Bun from a cache.
 */
export function verifyProblems({ pkg, check, release, lychee }) {
  const problems = [];
  const scripts = JSON.parse(pkg).scripts ?? {};
  const verify = chain(scripts.verify);
  if (!verify) return ["package.json verify is not a chain of `bun run <script>`"];

  const parts = Object.keys(scripts)
    .filter((k) => k.startsWith("ci:"))
    .map((k) => k.slice(3));
  if (!parts.length) problems.push("package.json has no ci:<part> scripts");
  const ran = [];
  for (const p of parts) {
    const c = chain(scripts[`ci:${p}`]);
    if (!c) {
      problems.push(`package.json ci:${p} is not a chain of \`bun run <script>\``);
      continue;
    }
    ran.push(...c);
    for (const build of BUILDS) {
      const after = c.find((s) => verify.indexOf(s) > verify.indexOf(build) && verify.includes(build));
      if (after && !(c.includes(build) && c.indexOf(build) < c.indexOf(after)))
        problems.push(`ci:${p} runs ${after} without running ${build} before it, as verify does`);
    }
  }
  for (const s of verify)
    if (!ran.includes(s)) problems.push(`no ci:<part> script runs ${s}, which verify runs`);
  for (const s of new Set(ran)) {
    if (!verify.includes(s)) problems.push(`ci:<part> runs ${s}, which verify does not`);
    else if (!BUILDS.includes(s) && ran.filter((r) => r === s).length > 1)
      problems.push(`more than one ci:<part> script runs ${s}`);
  }

  const part = job(check, "part");
  if (!part) problems.push("check.yml has no part job");
  else {
    const listed = matrixOf(part, "part");
    if (!listed) problems.push("check.yml part job: cannot read its `part: [...]` matrix");
    else if ([...listed].sort().join() !== [...parts].sort().join())
      problems.push(
        `check.yml part matrix [${listed.join(", ")}] differs from package.json ci:<part> [${parts.join(", ")}]`,
      );
    if (part.some((l) => /^ {8}(include|exclude):/.test(l)))
      problems.push(
        "check.yml part job: include and exclude are not read, so every node must run every part",
      );
    if (!part.includes("      fail-fast: false")) problems.push("check.yml part job: fail-fast is not false");
    const all = steps(part);
    const at = all.findIndex((s) => s.includes(CI_RUN));
    if (at === -1) problems.push(`check.yml part job: no step with \`${CI_RUN.trim()}\``);
    else {
      if (conditional(all[at]))
        problems.push("check.yml part job: the verify step runs only under a condition");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow line under check holds an expression
      if (!all[at].includes("          PART: ${{ matrix.part }}"))
        problems.push("check.yml part job: the verify step does not take PART from matrix.part");
      // Reach is counted on every line but the first (the engines floor), and nowhere else is it skipped
      const nodes = matrixOf(part, "node") ?? [];
      const floor = nodes[0];
      if (nodes.length < 2)
        problems.push(
          `check.yml part job: Node [${nodes.join(", ")}] leaves no line after the first, so SQL reach and coverage are counted nowhere`,
        );
      const unitMode = `          SPHICA_UNIT_MODE: \${{ matrix.node == '${floor}' && 'tests-only' || 'full' }}`;
      if (!floor || !all[at].includes(unitMode))
        problems.push(
          `check.yml part job: the verify step does not set SPHICA_UNIT_MODE to tests-only on the first Node line (${floor ?? "?"}) alone`,
        );
      problems.push(...lycheeProblems("check.yml part job", all, at, lychee));
    }
  }
  const gate = job(check, "check");
  if (!gate) problems.push("check.yml has no check job");
  else {
    const judge = steps(gate).find((s) => s.includes("        run: node scripts/check-parts.mjs part"));
    if (
      !gate.includes("    needs: part") ||
      !gate.includes("    if: always()") ||
      !judge ||
      conditional(judge)
    )
      problems.push("check.yml check job does not run always after part and check that every part succeeded");
    // Each required check stands for every Node line, so the part job must run on the same lines
    const lines = matrixOf(gate, "node");
    const partLines = part && matrixOf(part, "node");
    if (!lines?.length || !partLines || [...lines].sort().join() !== [...partLines].sort().join())
      problems.push(
        `check.yml part job runs on Node [${partLines?.join(", ") ?? "?"}], the check job on [${lines?.join(", ") ?? "?"}]`,
      );
  }

  const prepare = job(release, "prepare");
  if (!prepare) problems.push("release.yml has no prepare job");
  else {
    const all = steps(prepare);
    const at = all.findIndex((s) => s.some((l) => TARBALL_RUN.test(l)));
    if (at === -1) problems.push("release.yml prepare job: no step runs check-tarball.mjs");
    else problems.push(...lycheeProblems("release.yml prepare job", all, at, lychee));
  }

  for (const [file, text] of [
    ["check.yml", check],
    ["release.yml", release],
  ]) {
    const all = text.split("\n");
    const bun = steps(all.filter((l) => !/^\s*#/.test(l))).filter((s) =>
      /uses: oven-sh\/setup-bun@/.test(s[0]),
    );
    if (!bun.length) problems.push(`${file}: no setup-bun step`);
    for (const s of bun)
      if (!s.includes("          no-cache: true"))
        problems.push(`${file}: a setup-bun step restores Bun from a cache (no no-cache: true)`);
  }
  return problems;
}
