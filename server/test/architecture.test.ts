// check-architecture.mjs run on a copy of the sources, so a module that starts git on its own is shown to fail it
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { tempDir } from "./temp-dir.ts";

const REPO = path.join(import.meta.dirname, "..", "..");

/** A copy of the check and server/src, laid out as the repository is, with files put into server/src over the copied ones */
function copy(extra: Record<string, string>) {
  const root = tempDir("sphica-architecture-");
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(
    path.join(REPO, "scripts", "check-architecture.mjs"),
    path.join(root, "scripts", "check-architecture.mjs"),
  );
  fs.cpSync(path.join(REPO, "server", "src"), path.join(root, "server", "src"), { recursive: true });
  for (const [rel, text] of Object.entries(extra))
    fs.writeFileSync(path.join(root, "server", "src", rel), text);
  return spawnSync(process.execPath, [path.join(root, "scripts", "check-architecture.mjs")], {
    encoding: "utf8",
  });
}

test("only git.ts and the git worker start git", () => {
  assert.equal(copy({}).status, 0);
  for (const call of ['execFileSync("git", ["status"]);', "spawn('git', args);", "exec(`git`);"]) {
    const r = copy({ "stray.ts": `import { execFileSync, spawn } from "node:child_process";\n${call}\n` });
    assert.equal(r.status, 1, call);
    assert.match(r.stderr, /server\/src\/stray\.ts starts git/);
  }
  // A check that finds git started nowhere has stopped looking
  const r = copy({ "git.ts": "export {};\n" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no module starts git/);
});
