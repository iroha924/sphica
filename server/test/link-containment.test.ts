import "./isolate-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { linksOutside } from "../../scripts/lib/link-containment.mjs";

/** A package root with two Skills, and a file beside the package */
function layout() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-links-")));
  const pkg = path.join(dir, "package");
  for (const skill of ["a", "trace"]) {
    fs.mkdirSync(path.join(pkg, "skills", skill), { recursive: true });
    fs.writeFileSync(path.join(pkg, "skills", skill, "SKILL.md"), "# S\n");
  }
  fs.writeFileSync(path.join(dir, "outside.md"), "x\n");
  const url = (file: string, hash = "") => `${pathToFileURL(file).href}${hash}`;
  return { dir, pkg, url, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("a link that resolves to an existing file outside the package is reported; ../ inside the package is not", () => {
  const l = layout();
  try {
    const report = {
      successful: 3,
      errors: 1,
      success_map: {
        "skills/a/SKILL.md": [
          { url: l.url(path.join(l.pkg, "skills", "trace", "SKILL.md")) },
          { url: l.url(path.join(l.pkg, "skills", "a", "SKILL.md"), "#s") },
          { url: l.url(path.join(l.dir, "outside.md")) },
          { url: "https://example.com/x" },
        ],
      },
      error_map: { "skills/a/SKILL.md": [{ url: l.url(path.join(l.pkg, "missing.md")) }] },
    };
    assert.deepEqual(linksOutside(report, l.pkg), [
      { source: "skills/a/SKILL.md", url: l.url(path.join(l.dir, "outside.md")) },
    ]);
  } finally {
    l.done();
  }
});

test("a symlink inside the package that leads outside counts as outside", () => {
  const l = layout();
  try {
    fs.symlinkSync(path.join(l.dir, "outside.md"), path.join(l.pkg, "linked.md"));
    const report = {
      successful: 1,
      success_map: { "README.md": [{ url: l.url(path.join(l.pkg, "linked.md")) }] },
    };
    assert.equal(linksOutside(report, l.pkg).length, 1);
  } finally {
    l.done();
  }
});

test("a report that counts successful links but lists none is refused (lychee ran without --verbose)", () => {
  assert.throws(() => linksOutside({ successful: 2, success_map: {} }, os.tmpdir()), /--verbose/);
  assert.deepEqual(linksOutside({ successful: 0, success_map: {} }, os.tmpdir()), []);
});
