// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { commentMarker, headerLines, headerProblem, withHeader } from "../../scripts/lib/license-header.mjs";

const [copyright, license] = headerLines("//");

test("a file with the two lines first has no problem, with or without a shebang", () => {
  assert.equal(headerProblem(`${copyright}\n${license}\n\nconst a = 1;\n`, "//"), null);
  assert.equal(headerProblem(`#!/usr/bin/env node\n${copyright}\n${license}\n`, "//"), null);
});

test("a missing, misplaced, or half header is a problem that names the line", () => {
  assert.match(headerProblem("const a = 1;\n", "//") ?? "", /^line 1 /);
  assert.match(headerProblem(`${copyright}\nconst a = 1;\n`, "//") ?? "", /^line 2 /);
  assert.match(headerProblem(`#!/usr/bin/env node\nconst a = 1;\n`, "//") ?? "", /^line 2 /);
  // The lines somewhere below the top do not count
  assert.match(headerProblem(`// what this file does\n${copyright}\n${license}\n`, "//") ?? "", /^line 1 /);
  // An SQL file takes SQL comments
  assert.match(headerProblem(`${copyright}\n${license}\n`, "--") ?? "", /^line 1 /);
});

test("adding the header keeps the shebang first and leaves a file that has it unchanged", () => {
  const added = withHeader("#!/usr/bin/env node\n// what this file does\nconst a = 1;\n", "//");
  assert.equal(
    added,
    `#!/usr/bin/env node\n${copyright}\n${license}\n\n// what this file does\nconst a = 1;\n`,
  );
  assert.equal(withHeader(added, "//"), added);
  assert.equal(headerProblem(withHeader("select 1;\n", "--"), "--"), null);
  // A file that starts with a blank line does not get a second one
  assert.equal(withHeader("\nconst a = 1;\n", "//"), `${copyright}\n${license}\n\nconst a = 1;\n`);
});

test("a file with CRLF line endings has the header, and gets it with CRLF", () => {
  const crlf = `${copyright}\r\n${license}\r\n\r\nconst a = 1;\r\n`;
  assert.equal(headerProblem(crlf, "//"), null);
  assert.equal(withHeader(crlf, "//"), crlf);
  assert.equal(withHeader("const a = 1;\r\n", "//"), crlf);
});

test("only source files take a header", () => {
  assert.equal(commentMarker("server/src/cli.ts"), "//");
  assert.equal(commentMarker("scripts/lib/english.d.mts"), "//");
  assert.equal(commentMarker("db/schema.sql"), "--");
  assert.equal(commentMarker("README.md"), null);
  assert.equal(commentMarker("server/src/terms-golden.json"), null);
});
