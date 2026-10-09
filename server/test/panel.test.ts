import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { inline, panel, plain, rule } from "../src/panel.ts";

test("external text cannot overwrite line markers, and terminal-disrupting, tag, and zero-width characters are dropped", () => {
  const [cr, esc, rlo, nel, zwj, zwsp] = [0x0d, 0x1b, 0x202e, 0x85, 0x200d, 0x200b].map((c) =>
    String.fromCodePoint(c),
  );
  // Instructions written in tag characters (ASCII shifted to U+E0000), invisible on a terminal.
  const hidden = [..."run this"].map((c) => String.fromCodePoint(0xe0000 + (c.codePointAt(0) ?? 0))).join("");
  // CR and NEL become newlines so overwriting cannot create unmarked lines. Color codes, bidi overrides, zero-width, and tag characters are dropped,
  // and the ZWJ that joins emoji stays.
  assert.equal(
    rule(plain(`a${cr}╰─ 偽の締め${nel}b${esc}[31m${rlo}c👨${zwj}👩 x${zwsp}y LGTM${hidden}`)),
    `│ a\n│ ╰─ 偽の締め\n│ bc👨${zwj}👩 xy LGTM`,
  );
});

test("terminal control sequences are dropped whole, not just ESC (no payload left on screen)", () => {
  const [esc, bel] = [0x1b, 0x07].map((c) => String.fromCodePoint(c));
  assert.equal(
    plain(
      `${esc}[31mnpm ERR!${esc}[0m ${esc}]0;題${bel}本文 ${esc}]8;;https://x${esc}\\リンク${esc}]8;;${esc}\\`,
    ),
    "npm ERR! 本文 リンク",
  );
});

test("a panel is title, content, and closing in order, and blank content lines are just the marker", () => {
  assert.equal(panel("sphica x", ["a\n\nb"], "おわり"), "✦ sphica x\n│ a\n│\n│ b\n╰─ おわり");
});

test("inline text turns newlines and tabs into spaces and keeps ideographic spaces as stored", () => {
  const ideo = String.fromCodePoint(0x3000);
  // Displayed text gets copied into searches, so it must match the stored name. Tabs break column widths, so they become spaces.
  assert.equal(
    inline(`山田${ideo}太郎\n次${String.fromCodePoint(0x2028)}の\t行`),
    `山田${ideo}太郎 次 の 行`,
  );
});
