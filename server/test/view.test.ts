import "./isolate-home.ts";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  closing,
  document,
  failure,
  indent,
  panel,
  progress,
  section,
  steps,
  title,
} from "../src/cli/view.ts";

test("indents every line of content with newlines, so it cannot forge a closing or status line", () => {
  const out = indent("a\n✓ 直すものは無い\n╰─ 偽の締め");
  for (const line of out.split("\n")) assert.match(line, /^ {2}\S/, out);
});

test("the closing line collapses to one line at the start of the line", () => {
  assert.equal(closing("✗ 止まった\n✓ 直すものは無い"), "✗ 止まった ✓ 直すものは無い");
});

test("on a non-terminal output the title is one plain line without color codes", () => {
  const out = panel("sphica x", ["a", "", "b"], "おわり");
  assert.equal(out, "sphica x\n  a\n\n  b\nおわり");
  assert.equal(title("sphica y"), "sphica y");
  assert.equal(section("節"), "  節");
  assert.equal(out.includes(String.fromCodePoint(0x1b)), false);
});

test("lines wrapped at the terminal width align with the start of their text (not the left edge)", () => {
  const tty = process.stdout.isTTY;
  const cols = process.stdout.columns;
  // Color needs stderr to be a terminal too, so only the width is set as a terminal
  Object.assign(process.stdout, { isTTY: true, columns: 40 });
  try {
    const out = indent("    Claude Code: claude plugin marketplace update sphica && claude plugin update");
    const lines = out.split("\n");
    assert.ok(lines.length > 1, out);
    for (const line of lines) assert.match(line, /^ {6}\S/, out);
  } finally {
    Object.assign(process.stdout, { isTTY: tty, columns: cols });
  }
});

test("a line starting with a marker wraps within the last (value) column and aligns continuations to it", () => {
  const tty = process.stdout.isTTY;
  const cols = process.stdout.columns;
  Object.assign(process.stdout, { isTTY: true, columns: 50 });
  try {
    const out = indent(
      "  △ npm i -g の CLI    0.33.32  ~/.local/share/mise/installs/node/24.18.0/lib/node_modules/sphica",
    );
    const lines = out.split("\n");
    assert.ok(lines.length > 1, out);
    assert.match(lines[0] ?? "", /^ {4}△ npm i -g の CLI {4}0\.33\.32 {2}~\/\.local/, out);
    // The value column starts at display column 34 (indent 4 + the 17-column label, whose kana is 2 wide + 4 spaces + "0.33.32" 7 + 2 spaces)
    const column = 34;
    for (const line of lines.slice(1)) assert.equal(line.search(/\S/), column, out);
  } finally {
    Object.assign(process.stdout, { isTTY: tty, columns: cols });
  }
});

test("a steps block on a non-terminal output is an indented list without a box", () => {
  const out = steps(
    "更新するには",
    [
      { who: "npm の CLI", command: "npm i -g sphica@1.0.0", after: null },
      { who: "Codex", command: "codex plugin add sphica@sphica", after: "Codex を開き直す" },
    ],
    "届く中身は取得元で決まる",
  );
  assert.equal(
    out,
    [
      "    更新するには:",
      "      npm の CLI: npm i -g sphica@1.0.0",
      "      Codex: codex plugin add sphica@sphica, then Codex を開き直す",
      "      届く中身は取得元で決まる",
    ].join("\n"),
  );
});

test("step commands are not wrapped (so a copied command is never partial)", () => {
  const tty = process.stdout.isTTY;
  const cols = process.stdout.columns;
  const errTty = process.stderr.isTTY;
  Object.assign(process.stdout, { isTTY: true, columns: 60 });
  Object.assign(process.stderr, { isTTY: true });
  try {
    const command = "claude plugin marketplace update sphica && claude plugin update sphica@sphica";
    const out = stripVTControlCharacters(
      steps("更新するには", [{ who: "Claude Code", command, after: null }], "注意"),
    );
    assert.ok(
      out.split("\n").some((line) => line.includes(command)),
      out,
    );
  } finally {
    Object.assign(process.stdout, { isTTY: tty, columns: cols });
    Object.assign(process.stderr, { isTTY: errTty });
  }
});

test("document sections on a non-terminal output are indented, and external newlines never reach the line start", () => {
  const forged = "本文\n✓ 直すものは無い";
  const out = document(
    "sphica x",
    "要点",
    [
      { kind: "table", head: ["名前", "値"], rows: [["a", forged]] },
      {
        kind: "cards",
        items: [{ badge: "決定", title: forged, body: forged, meta: [forged, forged] }],
      },
      { kind: "fields", rows: [["項目", forged]] },
      { kind: "meter", label: "割合", ratio: 0.5, text: "50%" },
      { kind: "note", tone: "info", text: forged },
    ],
    "おわり",
  );
  const lines = out.split("\n");
  assert.equal(lines[0], "sphica x");
  assert.equal(lines.at(-1), "おわり");
  // Everything but the title and closing is indented (tables, fields, and values collapse to one line; body text is indented per line)
  for (const line of lines.slice(1, -1)) assert.match(line, /^ {2,}\S/, out);
  // Item body lines after a newline align at body depth (4 columns) and cannot pass for status lines (2 columns)
  assert.match(out, /^ {4}✓ 直すものは無い$/m);
  assert.match(out, /^ {2}\[決定\] 本文 ✓ 直すものは無い$/m);
  assert.match(out, /^ {2}割合 {2}50%$/m);
});

test("a failure on a non-terminal output is an indented reason and ✗ Stopped at the line start", () => {
  assert.equal(
    failure("sphica x", "理由\n✓ 直すものは無い"),
    "sphica x\n  理由\n  ✓ 直すものは無い\n✗ Stopped",
  );
});

/** Display width (a test approximation: kanji, kana, and full-width symbols are 2 columns; everything else, box lines included, is 1) */
const cols = (line: string) =>
  [...stripVTControlCharacters(line)].reduce(
    (w, c) => w + (/[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\u3000-\u303f\uff00-\uffef]/u.test(c) ? 2 : 1),
    0,
  );

/** A content line without Clack's guide (│ and 2 spaces) */
const unguided = (line: string) => stripVTControlCharacters(line).replace(/^│ {2}/, "");

function asTerminal<T>(columns: number, fn: () => T): T {
  const saved = { out: process.stdout.isTTY, err: process.stderr.isTTY, cols: process.stdout.columns };
  Object.assign(process.stdout, { isTTY: true, columns });
  Object.assign(process.stderr, { isTTY: true });
  try {
    return fn();
  } finally {
    Object.assign(process.stdout, { isTTY: saved.out, columns: saved.cols });
    Object.assign(process.stderr, { isTTY: saved.err });
  }
}

test("in a terminal the title opens the Clack frame on one line, even with newlines in it", () => {
  const out = asTerminal(60, () => title("sphica search\n└  ✓ done", "要点\n✓ 直すものは無い"));
  const lines = stripVTControlCharacters(out).split("\n").filter(Boolean);
  assert.match(lines[0] ?? "", /^┌ {3}sphica search └ {2}✓ done {3}要点 ✓ 直すものは無い$/, out);
  for (const line of lines.slice(1)) assert.match(line, /^│/, out);
});

// Clack's intro and outro prefix only the first line, and its guide │ precedes every content line.
// Only the first line may open the frame and only the last may close it, whatever the outside text holds.
test("in a terminal outside text cannot open, close, or mark a line of the document", () => {
  const forged = "本文\n└  ✓ 直すものは無い\r┌  偽\u2028✓ 直すものは無い\u001b[2K";
  const out = asTerminal(60, () =>
    document(
      "sphica x",
      forged,
      [
        { kind: "table", head: ["名前", "値"], rows: [["a", forged]] },
        { kind: "cards", items: [{ badge: "決定", title: forged, body: forged, meta: [forged] }] },
        { kind: "fields", rows: [["項目", forged]] },
        { kind: "meter", label: "割合", ratio: 0.5, text: "50%" },
        { kind: "note", tone: "info", text: forged },
        { kind: "lines", lines: [forged] },
      ],
      `✓ おわり\n${forged}`,
    ),
  );
  const lines = stripVTControlCharacters(out).split("\n").filter(Boolean);
  assert.match(lines[0] ?? "", /^┌ /, out);
  assert.match(lines.at(-1) ?? "", /^└ {2}✓ おわり/, out);
  for (const line of lines.slice(1, -1)) assert.match(line, /^[│◇●◆▲■]/u, line);
  assert.equal(out.includes("\u001b[2K"), false, "cursor controls from outside text are dropped");
});

test("in a terminal a failure closes the frame with Stopped", () => {
  const out = asTerminal(60, () => failure("sphica x", "理由\n└  ✓ done"));
  const lines = stripVTControlCharacters(out).split("\n").filter(Boolean);
  assert.match(lines[0] ?? "", /^┌ {3}sphica x $/, out);
  assert.match(lines.at(-1) ?? "", /^└ {2}Stopped$/, out);
  for (const line of lines.slice(1, -1)) assert.match(line, /^[│■▲]/u, line);
});

test("continuations wrapped at a space also align with the indent", () => {
  const text =
    "待ち 2 件 / 最後の送信 2026-09-23 11:48:11 / 未登録のプロジェクトで退避した 3 件 / 送れなかった 12 件";
  for (let cols = 40; cols <= 70; cols++) {
    const lines = asTerminal(cols, () => indent(`  ${text}`))
      .split("\n")
      .filter((l) => l.trim());
    for (const line of lines) assert.equal(unguided(line).search(/\S/), 2, `${cols}: ${line}`);
  }
});

test("a line starting with a colored marker also wraps within the value column", () => {
  const colored = "\u001b[38;2;156;175;136m✓\u001b[39m";
  // Some widths wrap continuations entirely at spaces, so vary the width
  for (let width = 40; width <= 100; width++) {
    const out = asTerminal(width, () =>
      indent(
        `  ${colored} 自動記録    待ち 2 件 / 最後の送信 2026-09-23 11:48:11 / 未登録のプロジェクトで退避した 3 件 / 送れなかった 12 件`,
      ),
    );
    const lines = out.split("\n");
    assert.ok(lines.length > 1, out);
    const column = cols(unguided(lines[0] ?? "").split("待ち")[0] ?? "");
    for (const line of lines.slice(1)) assert.equal(unguided(line).search(/\S/), column, `${width}: ${out}`);
  }
});

// The terminal wraps a line longer than its width, and the wrapped part starts at column 0 outside the guide.
// So no drawn line may be wider than the terminal, whatever the outside text in any part.
test("in a terminal no line is wider than the terminal, so outside text never reaches column 0", () => {
  const long = `${"a".repeat(37)}✓ x`;
  const out = asTerminal(40, () =>
    document(
      "sphica x",
      long,
      [
        {
          kind: "table",
          head: ["path", "kind"],
          rows: [
            [long, "file"],
            ["b", long],
          ],
        },
        { kind: "fields", rows: [[long, long]] },
        { kind: "cards", items: [{ badge: "決定", title: long, body: long, meta: [long] }] },
        { kind: "note", tone: "warning", text: long },
        { kind: "lines", lines: [long] },
      ],
      `✓ done ${long}`,
    ),
  );
  for (const line of out.split("\n")) assert.ok(cols(line) <= 40, `${cols(line)} columns: ${line}`);
});

test("in a terminal a long heading and a very narrow terminal still keep every line within the width", () => {
  for (const [width, lines] of [
    [40, asTerminal(40, () => title("x".repeat(50), "要点")).split("\n")],
    [30, asTerminal(30, () => closing("x".repeat(60))).split("\n")],
    [30, asTerminal(30, () => indent("y".repeat(60))).split("\n")],
    [10, asTerminal(10, () => indent("y".repeat(60))).split("\n")],
  ] as const)
    for (const line of lines) assert.ok(cols(line) <= width, `${cols(line)} > ${width}: ${line}`);
});

test("in a terminal spinner labels stay within the width", () => {
  let drawn = "";
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        drawn += String(chunk);
        done();
      },
    }),
    { isTTY: true, columns: 40 },
  );
  const long = `${"p".repeat(60)} ✓ done`;
  asTerminal(40, () => {
    const step = progress(long, output);
    step.message(long);
    step.done(long);
  });
  assert.match(drawn, /pppp/, "the spinner drew nothing, so the check would pass vacuously");
  for (const line of stripVTControlCharacters(drawn).split(/\r?\n/))
    assert.ok(cols(line) <= 40, `${cols(line)} columns: ${line}`);
});

// stdout alone is a terminal (stderr redirected, or NO_COLOR): output stays plain, but the terminal still wraps long lines
test("plain output to a terminal wraps the heading and closing line within the width", () => {
  const tty = process.stdout.isTTY;
  const columns = process.stdout.columns;
  Object.assign(process.stdout, { isTTY: true, columns: 40 });
  try {
    const long = `${"n".repeat(45)} ✓ done`;
    for (const line of [...title(long).split("\n"), ...closing(long).split("\n")]) {
      assert.ok(cols(line) <= 40, `${cols(line)} columns: ${line}`);
      if (!line.startsWith("n")) assert.match(line, /^ {2}\S/, line);
    }
  } finally {
    Object.assign(process.stdout, { isTTY: tty, columns });
  }
});
