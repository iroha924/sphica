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
    edit("check", "run: node scripts/check-parts.mjs part", "run: true"),
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
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow line under edit holds an expression
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
