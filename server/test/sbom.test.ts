// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Finding } from "../../scripts/lib/finding.mjs";
import { sbomProblems } from "../../scripts/lib/sbom.mjs";

// The same header as the table scripts/third-party-notices.mjs writes.
const notices = `# Third-party software included

| package | version | license |
|---|---|---|
| @clack/prompts | 1.8.1 | MIT |
| ajv | 8.20.0 | MIT |
| ajv | 8.20.0 | MIT |
| zod | 4.6.5 | MIT |
`;
const F = "sbom.cdx.json";
const whats = (found: Finding[]) => found.map((f) => f.what).join("\n");
const bom = (components: { name: string; group?: string; version: string; type?: string }[]) => ({
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  components: components.map((c) => ({ type: "library", ...c })),
});

test("passes when every bundled package is in the SBOM (scoped names included)", () => {
  assert.deepEqual(
    sbomProblems(
      notices,
      bom([
        { group: "@clack", name: "prompts", version: "1.8.1" },
        { name: "ajv", version: "8.20.0" },
        { name: "zod", version: "4.6.5" },
      ]),
      F,
    ),
    [],
  );
});

test("fails when a bundled package is missing from the SBOM or has a different version", () => {
  const got = sbomProblems(
    notices,
    bom([
      { name: "ajv", version: "8.20.0" },
      { name: "zod", version: "4.6.4" },
    ]),
    F,
  );
  assert.deepEqual(
    got.map((f) => f.what),
    [
      "the SBOM is missing @clack/prompts 1.8.1, which plugin/THIRD_PARTY_NOTICES.md lists as bundled",
      "the SBOM is missing zod 4.6.5, which plugin/THIRD_PARTY_NOTICES.md lists as bundled",
      "the SBOM lists zod 4.6.4, which plugin/THIRD_PARTY_NOTICES.md does not list as bundled",
    ],
  );
  assert.ok(got.every((f) => f.where === F));
});

test("fails on an unreadable SBOM and an empty list (so the comparison never passes vacuously)", () => {
  assert.match(whats(sbomProblems(notices, { bomFormat: "SPDX" }, F)), /CycloneDX/);
  assert.match(whats(sbomProblems("a document without a table", bom([]), F)), /no packages can be read/);
});

test("fails when the SBOM lists a package that is not bundled (a mismatched scope would be false)", () => {
  const got = sbomProblems(
    notices,
    bom([
      { group: "@clack", name: "prompts", version: "1.8.1" },
      { name: "ajv", version: "8.20.0" },
      { name: "zod", version: "4.6.5" },
      { name: "typescript", version: "7.0.2" },
    ]),
    F,
  );
  assert.deepEqual(
    got.map((f) => f.what),
    ["the SBOM lists typescript 7.0.2, which plugin/THIRD_PARTY_NOTICES.md does not list as bundled"],
  );
});

test("fails on a malformed row in the notices table instead of leaving it out of the comparison", () => {
  const broken = `${notices}| chalk | 5.6.2 (patched) | MIT |\n| marked | | MIT |\n`;
  const got = sbomProblems(
    broken,
    bom([
      { group: "@clack", name: "prompts", version: "1.8.1" },
      { name: "ajv", version: "8.20.0" },
      { name: "zod", version: "4.6.5" },
    ]),
    F,
  );
  assert.deepEqual(
    got.map((f) => [f.where, f.what]),
    [
      ["plugin/THIRD_PARTY_NOTICES.md", "a table row cannot be read: | chalk | 5.6.2 (patched) | MIT |"],
      ["plugin/THIRD_PARTY_NOTICES.md", "a table row cannot be read: | marked | | MIT |"],
    ],
  );
});
