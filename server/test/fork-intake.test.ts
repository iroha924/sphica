// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// What guards a fork's pull request before the owner approves it stays in the shape the checks expect: each test breaks the tracked
// file one way and expects the check to say so
import "./isolate-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { settingsProblems } from "../../scripts/lib/fork-intake.mjs";

const REPO = path.join(import.meta.dirname, "..", "..");
const tracked = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

type Settings = { permissions: { deny: string[] } & Record<string, unknown> } & Record<string, unknown>;
const settings = () => JSON.parse(tracked(".claude/settings.json")) as Settings;
const withSettings = (change: (s: Settings) => void) => {
  const s = settings();
  change(s);
  return settingsProblems(JSON.stringify(s));
};

test("the project settings deny gh pr checkout and its two other names, and hold nothing else", () => {
  assert.deepEqual(settingsProblems(tracked(".claude/settings.json")), []);
  assert.deepEqual(settings().permissions.deny, [
    "Bash(gh pr checkout *)",
    "Bash(gh pr co *)",
    "Bash(gh co *)",
  ]);
});

test("a deny rule taken out of the project settings is named", () => {
  for (const rule of settings().permissions.deny)
    assert.deepEqual(
      withSettings((s) => {
        s.permissions.deny = s.permissions.deny.filter((r) => r !== rule);
      }),
      [`permissions.deny lacks ${rule}`],
    );
});

test("anything added to the project settings is named: a key, an allow rule, another deny rule, a repeated one", () => {
  assert.deepEqual(
    withSettings((s) => {
      s.hooks = {};
    }),
    ["the only key must be permissions (found permissions, hooks)"],
  );
  assert.deepEqual(
    withSettings((s) => {
      s.permissions.allow = ["Bash(gh *)"];
    }),
    ["the only key of permissions must be deny (found deny, allow)"],
  );
  assert.deepEqual(
    withSettings((s) => {
      s.permissions.deny.push("Bash(rm *)");
    }),
    ["permissions.deny holds a rule this check does not know: Bash(rm *)"],
  );
  assert.deepEqual(
    withSettings((s) => {
      s.permissions.deny.push("Bash(gh co *)");
    }),
    ["permissions.deny repeats a rule"],
  );
});

test("project settings that are not an object with a deny list are refused", () => {
  assert.deepEqual(settingsProblems(""), ["not JSON"]);
  assert.deepEqual(settingsProblems("[]"), ["not an object"]);
  assert.deepEqual(settingsProblems('{"permissions":[]}'), ["permissions is not an object"]);
  assert.deepEqual(settingsProblems('{"permissions":{"deny":"Bash(gh co *)"}}'), [
    "permissions.deny is not a list",
  ]);
});
