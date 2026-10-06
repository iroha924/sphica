import assert from "node:assert/strict";
import { test } from "node:test";
import { embeddedBom, sbomProblems, withEmbedded } from "../../scripts/lib/sbom.mjs";

// The same header as the table scripts/third-party-notices.mjs writes.
const notices = `# Third-party software included

| package | version | license |
|---|---|---|
| @clack/prompts | 1.8.1 | MIT |
| ajv | 8.20.0 | MIT |
| ajv | 8.20.0 | MIT |
| zod | 4.6.5 | MIT |
`;
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
  );
  assert.deepEqual(got, [
    "SBOM is missing @clack/prompts 1.8.1",
    "SBOM is missing zod 4.6.5",
    "SBOM lists zod 4.6.4, which is not bundled",
  ]);
});

test("fails on an unreadable SBOM and an empty list (so the comparison never passes vacuously)", () => {
  assert.match(sbomProblems(notices, { bomFormat: "SPDX" }).join("\n"), /CycloneDX/);
  assert.match(sbomProblems("a document without a table", bom([])).join("\n"), /cannot read any packages/);
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
  );
  assert.deepEqual(got, ["SBOM lists typescript 7.0.2, which is not bundled"]);
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
  );
  assert.deepEqual(got, [
    "cannot read a THIRD_PARTY_NOTICES.md table row: | chalk | 5.6.2 (patched) | MIT |",
    "cannot read a THIRD_PARTY_NOTICES.md table row: | marked | | MIT |",
  ]);
});

const sdk = { name: "@modelcontextprotocol/server", version: "2.2.0", license: "MIT", in: "" };
const carried = [
  { name: "ajv", version: "8.18.0", license: "MIT", in: "@modelcontextprotocol/server" },
  { name: "fast-uri", version: "3.1.0", license: "BSD-3-Clause", in: "@modelcontextprotocol/server" },
];

test("the SDK's embedded packages join the SBOM as libraries the SDK depends on, and then match the notices", () => {
  const base = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    components: [
      {
        type: "library",
        "bom-ref": "sdk-ref",
        group: "@modelcontextprotocol",
        name: "server",
        version: sdk.version,
      },
    ],
    dependencies: [{ ref: "sdk-ref", dependsOn: ["zod-ref"] }],
  };
  const got = withEmbedded(base, carried);
  assert.deepEqual(got.dependencies, [
    { ref: "sdk-ref", dependsOn: ["zod-ref", "pkg:npm/ajv@8.18.0", "pkg:npm/fast-uri@3.1.0"] },
  ]);
  assert.deepEqual(got.components.at(-1), {
    type: "library",
    "bom-ref": "pkg:npm/fast-uri@3.1.0",
    name: "fast-uri",
    version: "3.1.0",
    purl: "pkg:npm/fast-uri@3.1.0",
    licenses: [{ license: { id: "BSD-3-Clause" } }],
  });
  const table = `| package | version | license |
|---|---|---|
| @modelcontextprotocol/server | 2.2.0 | MIT |
| ajv | 8.18.0 | MIT |
| fast-uri | 3.1.0 | BSD-3-Clause |
`;
  assert.deepEqual(sbomProblems(table, got), []);
  assert.equal(base.components.length, 1, "the input SBOM is left as it was");
});

test("adding embedded packages refuses an SBOM without the SDK or one that lists them already", () => {
  assert.throws(
    () => withEmbedded({ bomFormat: "CycloneDX", components: [] }, carried),
    /no @modelcontextprotocol\/server/,
  );
  const listed = {
    bomFormat: "CycloneDX",
    components: [
      { type: "library", "bom-ref": "s", group: "@modelcontextprotocol", name: "server", version: "2.2.0" },
      { type: "library", "bom-ref": "a", name: "ajv", version: "8.18.0" },
    ],
  };
  assert.throws(() => withEmbedded(listed, carried), /already lists ajv 8\.18\.0/);
  assert.throws(() => withEmbedded({ bomFormat: "SPDX" }, carried), /CycloneDX/);
});

test("the scan's SBOM of embedded packages names each by its npm purl", () => {
  const bom = embeddedBom([{ name: "@scope/a", version: "1.0.0", license: "MIT" }]);
  assert.deepEqual(bom.components, [
    {
      type: "library",
      "bom-ref": "pkg:npm/%40scope/a@1.0.0",
      group: "@scope",
      name: "a",
      version: "1.0.0",
      purl: "pkg:npm/%40scope/a@1.0.0",
      licenses: [{ license: { id: "MIT" } }],
    },
  ]);
});
