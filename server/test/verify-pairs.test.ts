// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The check that CI runs what verify runs, fed edited copies of the real files: each way of dropping a check from CI must fail it.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { chain, verifyProblems } from "../../scripts/lib/verify-pairs.mjs";

const ROOT = path.join(import.meta.dirname, "..", "..");
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");
const real = () => ({
  pkg: read("package.json"),
  check: read(".github/workflows/check.yml"),
  release: read(".github/workflows/release.yml"),
  lychee: /^"github:lycheeverse\/lychee" = \{ version = "([^"]+)"/m.exec(read("mise.toml"))?.[1] ?? null,
});
/** The real files with one text replaced, which must be there */
const edit = (file: "pkg" | "check" | "release", from: string | RegExp, to: string) => {
  const files = real();
  const before = files[file];
  files[file] = before.replace(from, to);
  assert.notEqual(files[file], before, `${String(from)} is not in ${file}`);
  return files;
};
const scripts = (files: ReturnType<typeof real>, change: (s: Record<string, string>) => void) => {
  const pkg = JSON.parse(files.pkg);
  change(pkg.scripts);
  return { ...files, pkg: JSON.stringify(pkg) };
};
const fails = (files: ReturnType<typeof real>, want: RegExp) => {
  const problems = verifyProblems(files);
  assert.ok(
    problems.some((p) => want.test(p)),
    `expected a problem matching ${want}, got:\n${problems.join("\n")}`,
  );
};

test("the repository's files pass", () => {
  assert.deepEqual(verifyProblems(real()), []);
});

test("chain reads only `bun run <script>` joined by &&", () => {
  assert.deepEqual(chain("bun run a && bun run b:c"), ["a", "b:c"]);
  for (const bad of [
    "bun run a; bun run b",
    "bun run a || bun run b",
    "node x.mjs",
    "bun run a &&bun run b",
    "",
    undefined,
  ])
    assert.equal(chain(bad), null, String(bad));
});

test("a check verify runs but no part runs, or one run twice or outside verify, fails", () => {
  fails(
    scripts(real(), (s) => {
      s["ci:static"] = String(s["ci:static"]).replace("bun run hooks:live && ", "");
    }),
    /no ci:<part> script runs hooks:live/,
  );
  fails(
    scripts(real(), (s) => {
      s["ci:unit"] = "bun run unit && bun run acceptance";
    }),
    /more than one ci:<part> script runs acceptance/,
  );
  fails(
    scripts(real(), (s) => {
      s["ci:unit"] = "bun run unit && bun run notices";
    }),
    /runs notices, which verify does not/,
  );
  fails(
    scripts(real(), (s) => {
      s["ci:unit"] = "bun run unit; true";
    }),
    /ci:unit is not a chain/,
  );
  fails(
    scripts(real(), (s) => {
      s.verify = `${s.verify}; true`;
    }),
    /verify is not a chain/,
  );
});

test("a part left out of the matrix, a condition on the verify step, or a matrix it cannot read fails", () => {
  fails(
    edit("check", "part: [static, unit, acceptance]", "part: [static, unit]"),
    /part matrix \[static, unit\] differs/,
  );
  fails(
    edit("check", "part: [static, unit, acceptance]", "part:\n          - static"),
    /cannot read its `part: \[\.\.\.\]` matrix/,
  );
  fails(
    edit(
      "check",
      "        part: [static, unit, acceptance]\n",
      "        part: [static, unit, acceptance]\n        exclude:\n",
    ),
    /include and exclude are not read/,
  );
  fails(
    edit(
      "check",
      "      - name: This part of verify\n",
      "      - name: This part of verify\n        if: matrix.node == '26'\n",
    ),
    /verify step runs only under a condition/,
  );
  fails(edit("check", 'run: bun run "ci:$PART"', "run: bun run ci:static"), /no step with/);
  fails(
    edit(
      "check",
      '      fail-fast: false\n      matrix:\n        node: ["24.15", "26"]\n        part:',
      '      matrix:\n        node: ["24.15", "26"]\n        part:',
    ),
    /fail-fast is not false/,
  );
});

test("a check job that can be skipped or does not look at the parts fails", () => {
  fails(edit("check", "    if: always()\n", ""), /check job does not run always/);
  fails(
    edit("check", "run: node scripts/check-parts.mjs part macos", "run: true"),
    /check job does not run always/,
  );
});

test("lychee missing, late, conditional, unchecked, or at another version fails", () => {
  const check = real().check;
  const step = / {6}- name: Install lychee\n(?: {8}.*\n| {10}.*\n)+/.exec(check)?.[0];
  assert.ok(step);
  fails(edit("check", step, ""), /check.yml part job: no Install lychee step/);
  fails(
    edit(
      "check",
      "      - name: Install lychee\n",
      "      - name: Install lychee\n        if: matrix.part == 'static'\n",
    ),
    /runs only under a condition/,
  );
  fails(edit("check", "| sha256sum -c -", "| true"), /check its SHA-256/);
  fails({ ...real(), lychee: "0.0.1" }, /LYCHEE .* differs from mise.toml lychee 0\.0\.1/);
  const release = real().release;
  const releaseStep = / {6}- name: Install lychee\n(?: {8}.*\n| {10}.*\n)+/.exec(release)?.[0];
  assert.ok(releaseStep);
  fails(edit("release", releaseStep, ""), /release.yml prepare job: no Install lychee step/);
});

test("a setup-bun step without no-cache fails, in either workflow", () => {
  fails(
    edit("check", /bun-version: 1\.4\.0\n {10}no-cache: true\n/, "bun-version: 1.4.0\n"),
    /check.yml: a setup-bun step restores Bun/,
  );
  fails(
    edit("release", /bun-version: 1\.4\.0\n {10}no-cache: true\n/, "bun-version: 1.4.0\n"),
    /release.yml: a setup-bun step restores Bun/,
  );
});

test("a verify step cut off from matrix.part, or skipped by an if written as its first key, fails", () => {
  // oxlint-disable-next-line no-template-curly-in-string -- the workflow line under edit holds an expression
  fails(edit("check", "PART: ${{ matrix.part }}", "PART: static"), /does not take PART from matrix.part/);
  fails(
    edit(
      "check",
      "      - name: This part of verify\n",
      "      - if: matrix.part == 'static'\n        name: This part of verify\n",
    ),
    /verify step runs only under a condition/,
  );
});

test("a part job on fewer Node lines than the required checks, or a judge step that can be skipped, fails", () => {
  fails(
    edit("check", '        node: ["24.15", "26"]\n        part:', '        node: ["24.15"]\n        part:'),
    /part job runs on Node \[24\.15\], the check job on \[24\.15, 26\]/,
  );
  fails(
    edit(
      "check",
      "      - name: Did every part succeed\n",
      "      - name: Did every part succeed\n        if: github.event_name == 'push'\n",
    ),
    /check job does not run always/,
  );
});

test("a part that runs a check verify runs after the bundle, without bundling first, fails", () => {
  for (const [part, check] of [
    ["unit", "unit"],
    ["acceptance", "acceptance"],
    ["static", "sql:live"],
  ] as const) {
    fails(
      scripts(real(), (s) => {
        s[`ci:${part}`] = String(s[`ci:${part}`]).replace("bun run bundle && ", "");
      }),
      new RegExp(`ci:${part} runs ${check} without running bundle before it`),
    );
  }
  fails(
    scripts(real(), (s) => {
      s["ci:unit"] = "bun run unit && bun run bundle";
    }),
    /ci:unit runs unit without running bundle before it/,
  );
});

test("a unit mode that skips reach on another line, on every line, or on none fails", () => {
  // oxlint-disable-next-line no-template-curly-in-string -- the workflow line under check holds an expression
  const line = "          SPHICA_UNIT_MODE: ${{ matrix.node == '24.15' && 'tests-only' || 'full' }}\n";
  const want = /does not set SPHICA_UNIT_MODE to tests-only on the first Node line \(24\.15\) alone/;
  fails(edit("check", line, ""), want);
  fails(edit("check", line, line.replace("'24.15'", "'26'")), want);
  fails(edit("check", line, line.replace("'tests-only' || 'full'", "'full' || 'tests-only'")), want);
  fails(edit("check", line, "          SPHICA_UNIT_MODE: tests-only\n"), want);
  fails(
    edit(
      "check",
      '        node: ["24.15", "26"]\n        part:',
      '        node: ["26", "24.15"]\n        part:',
    ),
    /tests-only on the first Node line \(26\) alone/,
  );
});

test("a part matrix with only the floor line, once or repeated, where nothing counts SQL reach, fails", () => {
  for (const only of ['["24.15"]', '["24.15", "24.15"]']) {
    const files = real();
    files.check = files.check.replaceAll('        node: ["24.15", "26"]\n', `        node: ${only}\n`);
    fails(files, /has no line other than the first, so SQL reach and coverage are counted nowhere/);
  }
});

test("a part matrix entry that is not a plain version, which could hide a repeated floor, fails", () => {
  for (const only of ['["24.15",]', '["24.15", "24.\\x31\\x35"]']) {
    const files = real();
    files.check = files.check.replaceAll('        node: ["24.15", "26"]\n', `        node: ${only}\n`);
    fails(files, /holds an entry that is not a plain version/);
  }
});

test("a push to main that could skip the heavy jobs without same-tree's evidence, or a pull request that could skip them, fails", () => {
  const skipIf =
    // oxlint-disable-next-line no-template-curly-in-string -- the workflow line under check holds an expression
    "    if: ${{ !cancelled() && !(needs.same-tree.result == 'success' && needs.same-tree.outputs.tested == 'true') }}\n";
  const trigger = /does not run on pushes to main and on pull requests into main only/;
  fails(edit("check", "  pull_request:\n    branches: [main]\n", "  pull_request:\n"), trigger);
  fails(edit("check", "  push:\n    branches: [main]\n", "  push:\n"), trigger);
  const detector = /same-tree job does not run only on push/;
  fails(edit("check", "    if: github.event_name == 'push'\n", ""), detector);
  fails(edit("check", "      actions: read\n", ""), detector);
  fails(edit("check", "        id: decide\n", ""), detector);
  fails(
    edit(
      "check",
      "        run: node scripts/same-tree.mjs\n",
      "        run: node scripts/same-tree.mjs || true\n",
    ),
    detector,
  );
  fails(
    edit(
      "check",
      /( {6}- name: commit message\n)( {8}env:\n {10}RANGE: \$\{\{ format)/,
      "$1        if: false\n$2",
    ),
    detector,
  );
  fails(
    edit(
      "check",
      /( {8}env:\n {10}BASE: \$\{\{ github\.event\.before \}\}\n {8}run: node scripts\/check-mcp-version\.mjs --base "\$BASE"\n)/,
      "",
    ),
    detector,
  );
  fails(edit("check", /\n {2}same-tree:\n[\s\S]*?\n\n/, "\n"), /has no same-tree job/);
  for (const name of ["part", "macos", "windows", "git-2-34"]) {
    const at = new RegExp(
      `(\\n {2}${name}:\\n(?: {4}name: .*\\n)?) {4}needs: same-tree\\n${skipIf.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&")}`,
    );
    const want = new RegExp(
      `${name} job is not skipped exactly when same-tree found the tree already passed`,
    );
    fails(edit("check", at, "$1"), want);
    fails(edit("check", at, `$1    needs: same-tree\n${skipIf.replace("!cancelled() && ", "")}`), want);
    fails(edit("check", at, `$1    needs: same-tree\n${skipIf.replace("== 'true'", "!= 'false'")}`), want);
    fails(edit("check", at, `$1    needs: same-tree\n    if: always()\n`), want);
  }
  const gate = /check job does not run always after same-tree, part, and macos and check, by event/;
  fails(edit("check", "    needs: [same-tree, part, macos]\n", "    needs: part\n"), gate);
  // A macOS failure must block the required checks too
  fails(edit("check", "    needs: [same-tree, part, macos]\n", "    needs: [same-tree, part]\n"), gate);
  fails(
    edit(
      "check",
      "run: node scripts/check-parts.mjs part macos\n",
      "run: node scripts/check-parts.mjs part\n",
    ),
    gate,
  );
  // oxlint-disable-next-line no-template-curly-in-string -- the workflow line under check holds an expression
  fails(edit("check", "          EVENT: ${{ github.event_name }}\n", ""), gate);
});

test("a version check that defers dependency changes without the tarball verdict and the check reading it after the pack fails", () => {
  const final =
    'node scripts/check-mcp-version.mjs --base "$BASE" --verdict "$RUNNER_TEMP/release-verdict.json"';
  fails(edit("check", final, "true"), /no tarball verdict after the pack/);
  fails(
    edit("check", "run: node scripts/release-verdict.mjs", "run: true"),
    /no tarball verdict after the pack/,
  );
  const only =
    // oxlint-disable-next-line no-template-curly-in-string -- the workflow lines under edit hold an expression
    "        if: matrix.part == 'static' && matrix.node == '24.15'\n        env:\n          BASE: ${{ github.event_name == 'pull_request' && 'HEAD^1' || github.event.before }}\n        run: node scripts/release-verdict.mjs";
  fails(
    edit("check", only, only.replace("'24.15'", "'26'")),
    /do not both run on the static part of Node 24\.15/,
  );
});
