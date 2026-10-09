import "./isolate-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  EXACT_PACKAGE_INPUTS,
  PACKAGE_PREFIXES,
  releaseKind,
  withoutReleaseVersion,
} from "../../scripts/lib/release-scope.mjs";

test("separates no-release changes from plugin ones (the web UI is gone, so there are no npm-only releases)", () => {
  assert.equal(releaseKind(["README.ja.md", ".agents/skills/plugin-release/SKILL.md"]), "none");
  // bundle copies README.md into the tarball, and it shows on the npm package page
  assert.equal(releaseKind(["README.md"]), "plugin");
  assert.equal(releaseKind(["plugin/skills/trace/SKILL.md"]), "plugin");
  assert.equal(releaseKind(["server/src/mcp.ts"]), "plugin");
  assert.equal(releaseKind(["server/src/cli/view.ts"]), "plugin");
  assert.equal(releaseKind(["scripts/bundle.mjs"]), "plugin");
});

test("version-only changes can be left out of the release type input", () => {
  assert.equal(
    withoutReleaseVersion('{"name":"sphica","version":"1.1.0"}'),
    withoutReleaseVersion('{"name":"sphica","version":"1.0.0"}'),
  );
  assert.notEqual(
    withoutReleaseVersion('{"name":"sphica","version":"1.1.0","files":["dist"]}'),
    withoutReleaseVersion('{"name":"sphica","version":"1.0.0","files":["src"]}'),
  );
});

test("the pre-commit bundle glob covers every shipped input (stopping locally a commit that changes inputs without a version bump)", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const lefthook = fs.readFileSync(path.join(root, "lefthook.yml"), "utf8");
  const glob = /- name: bundle\n(?:\s+#.*\n)*\s+glob: "\{([^}]*)\}"/.exec(lefthook)?.[1]?.split(",") ?? [];
  assert.ok(glob.length > 0, "cannot read the bundle glob in lefthook.yml");
  const covers = (file: string) =>
    glob.some((g) => g === file || (g.endsWith("/**") && file.startsWith(g.slice(0, -2))));
  for (const file of EXACT_PACKAGE_INPUTS) assert.ok(covers(file), `${file} is not in the bundle glob`);
  // Prefix inputs need a glob that covers every file below them (narrowing to `*.ts` would miss JSON and others)
  for (const prefix of PACKAGE_PREFIXES)
    assert.ok(glob.includes(`${prefix}**`), `${prefix}** is not in the bundle glob`);
});
