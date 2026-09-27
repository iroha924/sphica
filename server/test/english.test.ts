import assert from "node:assert/strict";
import { test } from "node:test";
import { englishProblems } from "../../scripts/lib/english.mjs";

const lines = (source: string, mode: "all" | "comments" = "all") =>
  englishProblems(source, mode).map((p) => [p.line, p.reason]);

test("finds Japanese in strings, templates, and comments", () => {
  const src = [
    'const a = "決定";',
    "const b = `x$" + "{y}です`;",
    "// コメント",
    "/* 複数\n行 */",
    'const ok = "ok";',
  ].join("\n");
  assert.deepEqual(
    lines(src).map(([l]) => l),
    [1, 2, 3, 4],
  );
});

test("reads a // inside a string as part of the string", () => {
  assert.deepEqual(lines('const url = "https://example.com"; // fine'), []);
  assert.deepEqual(lines('const s = "// 日本語";').length, 1);
});

test("counts lines inside multi-line templates", () => {
  const src = "const t = `line one\nline two\n$" + "{a}`;\nconst j = '日本';";
  assert.deepEqual(lines(src), [[4, "Japanese text"]]);
});

test("catches full-width punctuation", () => {
  assert.equal(lines('const s = "a、b";').length, 1);
});

test("comments mode ignores strings", () => {
  const src = 'const label = "【採用した決定】";\n// english comment';
  assert.deepEqual(lines(src, "comments"), []);
  assert.deepEqual(lines("// 日本語のコメント", "comments").length, 1);
});

test("an exemption allows the next line only, and must be used", () => {
  const src = [
    "// english-exempt: stored in the database",
    'const key = "本文";',
    'const other = "本文";',
  ].join("\n");
  assert.deepEqual(lines(src), [[3, "Japanese text"]]);
  const unused = ["// english-exempt: no longer needed", 'const key = "body";'].join("\n");
  assert.deepEqual(lines(unused), [[1, "exemption with no Japanese on the next line"]]);
});

test("an exemption needs a reason", () => {
  const src = ["// english-exempt:", 'const key = "本文";'].join("\n");
  assert.equal(lines(src).length, 1);
});

test("catches the middle dot and long vowel mark, which Unicode assigns to no single script", () => {
  assert.equal(lines('const s = "PR・issue";').length, 1);
  assert.equal(lines('const s = "ソート";').length, 1);
  assert.equal(lines('const s = "ー";').length, 1);
});
