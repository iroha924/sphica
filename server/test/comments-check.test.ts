import assert from "node:assert/strict";
import { test } from "node:test";
import { referenceProblems } from "../../scripts/lib/comment-refs.mjs";

const reasons = (source: string, kind: "js" | "sql" = "js") =>
  referenceProblems(source, kind).map((p) => [p.line, p.reason]);

test("finds issue and pull request references and plan paths in comments", () => {
  const src = [
    "// see .claude/plans/2026/09/29-x.plan.md",
    "// the owner chose this in issue #187",
    "/* observed on PR #183 */",
    "// set aside, not dropped (#104)",
    "// Closes #12 once merged",
    "// tracked in iroha924/sphica#50",
    "// https://github.com/iroha924/sphica/pull/225 has the numbers",
  ].join("\n");
  assert.deepEqual(reasons(src), [
    [1, "a plan path"],
    [2, "an issue number"],
    [3, "a pull request number"],
    [4, "an issue or pull request number"],
    [5, "a closing reference"],
    [6, "an issue or pull request reference"],
    [7, "an issue or pull request URL"],
  ]);
});

test("reports the line inside a multi-line comment", () => {
  assert.deepEqual(reasons("const a = 1;\n/**\n * fine\n * from issue 12\n */"), [[4, "an issue number"]]);
});

test("leaves strings and terms that only look like references", () => {
  assert.deepEqual(reasons("// Identifiers such as OT-123 and #27 are kept whole"), []);
  assert.deepEqual(reasons('const body = "Fixes #14 and closes o/r#15"; // a pull request body'), []);
});

test("reads only whole-line -- comments in SQL", () => {
  assert.deepEqual(reasons("-- Revision 2 (issue #193)\nselect '-- issue #1';", "sql"), [
    [1, "an issue number"],
  ]);
  assert.deepEqual(reasons("select 1; -- fine\ninsert into t values ('(#5)');", "sql"), []);
  assert.deepEqual(reasons("-- a\r-- issue #2", "sql"), [[2, "an issue number"]]);
});
