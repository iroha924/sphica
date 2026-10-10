// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

import "./isolate-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  commentMarker,
  headerLines,
  headerProblem,
  sourceFiles,
  withHeader,
} from "../../scripts/lib/license-header.mjs";

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

test("adding the header to a file with mixed line endings changes no other byte", () => {
  const mixed = "#!/usr/bin/env node\nconsole.log(1);\r\nconsole.log(2);\n";
  const added = withHeader(mixed, "//");
  assert.equal(
    added,
    `#!/usr/bin/env node\n${copyright}\n${license}\n\nconsole.log(1);\r\nconsole.log(2);\n`,
  );
  assert.equal(headerProblem(added, "//"), null);
  // A shebang with nothing after it still comes first
  assert.equal(withHeader("#!/usr/bin/env node", "//"), `#!/usr/bin/env node\n${copyright}\n${license}\n`);
});

test("source files are found by walking the whole checkout, and a symbolic link is never one", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-headers-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-headers-outside-"));
  try {
    fs.mkdirSync(path.join(root, "src", "deep"), { recursive: true });
    fs.mkdirSync(path.join(root, "src", "node_modules"));
    fs.mkdirSync(path.join(root, ".git"));
    fs.mkdirSync(path.join(root, "built"));
    fs.mkdirSync(path.join(root, "new-place"));
    fs.writeFileSync(path.join(root, "top.mjs"), "const t = 1;\n");
    fs.writeFileSync(path.join(root, "src", "a.ts"), "const a = 1;\n");
    fs.writeFileSync(path.join(root, "src", "deep", "b.sql"), "select 1;\n");
    fs.writeFileSync(path.join(root, "src", "deep", "frozen.sql"), "select 2;\n");
    fs.writeFileSync(path.join(root, "src", "notes.md"), "# notes\n");
    fs.writeFileSync(path.join(root, "src", "node_modules", "dep.ts"), "const d = 1;\n");
    fs.writeFileSync(path.join(root, ".git", "hook.js"), "const h = 1;\n");
    fs.writeFileSync(path.join(root, "built", "out.js"), "const o = 1;\n");
    // A directory nobody listed is walked too
    fs.writeFileSync(path.join(root, "new-place", "c.cjs"), "const c = 1;\n");
    fs.writeFileSync(path.join(outside, "target.ts"), "const secret = 1;\n");
    // A link to a file and links to a directory, in the walked tree and at its top, all leading out of the checkout
    fs.symlinkSync(path.join(outside, "target.ts"), path.join(root, "src", "escape.ts"));
    fs.symlinkSync(outside, path.join(root, "src", "linked"));
    fs.symlinkSync(outside, path.join(root, "db"));
    assert.deepEqual(sourceFiles(root, /^(?:built\/|src\/deep\/frozen\.sql$)/), [
      "new-place/c.cjs",
      "src/a.ts",
      "src/deep/b.sql",
      "top.mjs",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
