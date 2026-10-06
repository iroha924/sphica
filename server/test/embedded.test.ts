import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { embeddedPackages, embeddedProblems, markedPackages } from "../../scripts/lib/embedded.mjs";

const SDK = "server/node_modules/@modelcontextprotocol/server/dist/src-a.mjs";
const meta = (inputs: string[]) => ({
  outputs: {
    "plugin/dist/mcp.js": { inputs: Object.fromEntries(inputs.map((i) => [i, { bytesInOutput: 1 }])) },
  },
});
const dist = [
  "//#region ../../node_modules/.pnpm/ajv@8.18.0/node_modules/ajv/dist/compile/codegen/code.js",
  "//#region ../../node_modules/.pnpm/ajv-formats@3.0.1_ajv@8.18.0/node_modules/ajv-formats/dist/formats.js",
  "//#region ../../node_modules/.pnpm/@cfworker+json-schema@4.1.1/node_modules/@cfworker/json-schema/dist/esm/index.js",
  "//#region ../core-internal/src/shared/stdio.ts",
].join("\n");

test("region comments name each package once, with scoped names restored and pnpm's peer suffix left out", () => {
  assert.deepEqual([...markedPackages(dist)].sort(), [
    "@cfworker/json-schema 4.1.1",
    "ajv 8.18.0",
    "ajv-formats 3.0.1",
  ]);
});

test("the list passes only when it names exactly the packages the bundled SDK files carry", () => {
  const read = (input: string) =>
    input === SDK ? dist : "//#region ../../node_modules/.pnpm/zod@4.0.0/x.js";
  const listed = [
    { name: "ajv", version: "8.18.0" },
    { name: "ajv-formats", version: "3.0.1" },
    { name: "@cfworker/json-schema", version: "4.1.1" },
  ];
  // Files outside the SDK's dist are npm dependencies the notices already find
  assert.deepEqual(
    embeddedProblems({ mcp: meta([SDK, "server/node_modules/zod/index.js"]) }, read, listed),
    [],
  );
  assert.deepEqual(embeddedProblems({ mcp: meta([SDK]) }, read, listed.slice(1)), [
    "the bundles carry ajv 8.18.0 inside the MCP SDK, but scripts/licenses/embedded lacks it",
  ]);
  assert.deepEqual(
    embeddedProblems({ mcp: meta([SDK]) }, read, [...listed, { name: "fast-uri", version: "3.1.0" }]),
    ["scripts/licenses/embedded lists fast-uri 3.1.0, which no bundle carries"],
  );
});

test("a missing metafile fails instead of passing with nothing found", () => {
  assert.deepEqual(
    embeddedProblems({ mcp: null }, () => "", []),
    [
      "mcp: no metafile to find the SDK's embedded packages in",
      "no bundle includes the MCP SDK's dist files, so the packages it carries were not checked",
    ],
  );
});

test("a listed package without its license text is a problem, and the shipped list has a text for each", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-embedded-"));
  fs.writeFileSync(
    path.join(dir, "index.json"),
    JSON.stringify([
      { name: "@scope/a", version: "1.0.0", license: "MIT", source: "s", in: "x" },
      { name: "b", version: "2.0.0", license: "MIT", source: "s", in: "x" },
    ]),
  );
  fs.writeFileSync(path.join(dir, "@scope+a@1.0.0.txt"), "MIT License\n\nCopyright (c) A\n");
  const got = embeddedPackages(dir);
  assert.deepEqual(
    got.packages.map((p) => [p.name, p.text]),
    [["@scope/a", "MIT License\n\nCopyright (c) A"]],
  );
  assert.equal(got.problems.length, 1);
  assert.match(got.problems[0] ?? "", /^b 2\.0\.0 has no license text in /);
  const shipped = embeddedPackages();
  assert.deepEqual(shipped.problems, []);
  assert.ok(shipped.packages.length > 0);
});

test("a region naming node_modules in a form the check cannot read fails instead of being skipped", () => {
  const read = () => "//#region ./node_modules/.pnpm/punycode@2.3.1/node_modules/punycode/punycode.js";
  const got = embeddedProblems({ mcp: meta([SDK]) }, read, []);
  assert.equal(got.length, 1);
  assert.match(got[0] ?? "", /cannot read the package in .*punycode/);
});

test("bundles without any of the SDK's dist files fail, so an empty list never passes unread", () => {
  assert.deepEqual(
    embeddedProblems({ mcp: meta(["server/src/mcp.ts"]) }, () => "", []),
    ["no bundle includes the MCP SDK's dist files, so the packages it carries were not checked"],
  );
});

test("a package region written with backslashes is caught too", () => {
  const read = () =>
    "//#region ..\\..\\node_modules\\.pnpm\\punycode@2.3.1\\node_modules\\punycode\\punycode.js";
  const got = embeddedProblems({ mcp: meta([SDK]) }, read, []);
  assert.equal(got.length, 1);
  assert.match(got[0] ?? "", /cannot read the package in .*punycode/);
});
