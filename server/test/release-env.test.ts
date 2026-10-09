import "./isolate-home.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { envProblems } from "../../scripts/lib/release-env.mjs";
import { tmpEnv } from "./temp-dir.ts";

const OWNER_ID = 85755290;
const owner = { type: "User", reviewer: { id: OWNER_ID, login: "iroha924" } };
// The shape the live API returned for npm-release on 2026-09-28, with admin bypass off
const environment = {
  can_admins_bypass: false,
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  protection_rules: [
    { type: "required_reviewers", prevent_self_review: false, reviewers: [owner] },
    { type: "branch_policy" },
  ],
};
const policies = [{ name: "v*", type: "tag" }];
const ok = { environment, policies, ownerId: String(OWNER_ID) };
const withRule = (patch: object) => ({
  ...ok,
  environment: { ...environment, protection_rules: [{ ...environment.protection_rules[0], ...patch }] },
});

test("release-env passes when only the owner approves, admins cannot bypass, and only v* tags deploy", () => {
  assert.deepEqual(envProblems(ok), []);
});

test("release-env rejects a second reviewer", () => {
  const other = { type: "User", reviewer: { id: 1, login: "someone" } };
  assert.match(
    envProblems(withRule({ reviewers: [owner, other] })).join("\n"),
    /one required reviewer, found 2/,
  );
});

test("release-env rejects a reviewer who is not the owner, or a team", () => {
  assert.match(
    envProblems(withRule({ reviewers: [{ type: "User", reviewer: { id: 1, login: "someone" } }] })).join(
      "\n",
    ),
    /not the repository owner \(someone\)/,
  );
  assert.match(
    envProblems(withRule({ reviewers: [{ type: "Team", reviewer: { id: OWNER_ID } }] })).join("\n"),
    /not the repository owner/,
  );
});

test("release-env rejects no reviewer rule at all", () => {
  assert.match(
    envProblems({ ...ok, environment: { ...environment, protection_rules: [] } }).join("\n"),
    /one required_reviewers rule, found 0/,
  );
});

test("release-env rejects prevent_self_review, which locks the owner out", () => {
  assert.match(envProblems(withRule({ prevent_self_review: true })).join("\n"), /prevent_self_review/);
});

test("release-env rejects admin bypass", () => {
  assert.match(
    envProblems({ ...ok, environment: { ...environment, can_admins_bypass: true } }).join("\n"),
    /admin bypass/,
  );
});

test("release-env rejects any deployment policy other than exactly the v* tag", () => {
  const cases = [
    [],
    [{ name: "v*", type: "branch" }],
    [{ name: "*", type: "tag" }],
    [...policies, { name: "main", type: "branch" }],
  ];
  for (const list of cases) {
    assert.match(envProblems({ ...ok, policies: list }).join("\n"), /only the tag pattern v\*/);
  }
  assert.match(
    envProblems({
      ...ok,
      environment: {
        ...environment,
        deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
      },
    }).join("\n"),
    /limited to selected tags/,
  );
});

// The script as release.yml runs it, with a fake gh first on PATH
function runScript(ghBody: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-release-env-"));
  try {
    fs.writeFileSync(path.join(dir, "gh.cjs"), ghBody);
    fs.writeFileSync(path.join(dir, "gh"), `#!/bin/sh\nexec "${process.execPath}" "${dir}/gh.cjs" "$@"\n`, {
      mode: 0o755,
    });
    return spawnSync(
      process.execPath,
      [path.resolve(import.meta.dirname, "..", "..", "scripts/release-env.mjs")],
      {
        encoding: "utf8",
        env: {
          ...tmpEnv(),
          PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
          // A temporary HOME, so nothing a child runs can reach the owner's home (USERPROFILE on Windows)
          HOME: dir,
          USERPROFILE: dir,
          GITHUB_REPOSITORY: "iroha924/sphica",
          GITHUB_REPOSITORY_OWNER_ID: String(OWNER_ID),
        },
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("release-env script passes on the live-shaped API answers", () => {
  const result = runScript(`
const endpoint = process.argv[3];
if (endpoint.endsWith("/environments/npm-release")) process.stdout.write(${JSON.stringify(JSON.stringify(environment))});
else if (endpoint.includes("deployment-branch-policies")) process.stdout.write(${JSON.stringify(JSON.stringify({ branch_policies: policies }))});
else process.exit(1);
`);
  assert.equal(result.status, 0, result.stderr);
});

test("release-env script fails when the API call fails", () => {
  const result = runScript(`process.stderr.write("HTTP 403"); process.exit(1);`);
  assert.notEqual(result.status, 0);
});
