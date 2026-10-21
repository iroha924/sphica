// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// scripts/lib/release-verdict.mjs in a temp repository, against a stand-in registry: the verdict names the tree, base, and run it is for
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { writeVerdict } from "../../scripts/lib/release-verdict.mjs";
import { tempDir } from "./temp-dir.ts";
import { put, withRepo } from "./temp-repo.ts";

/** A .tgz holding package/package.json with the given version */
function packed(version: string) {
  const dir = tempDir("release-verdict-src-");
  fs.mkdirSync(path.join(dir, "package"));
  fs.writeFileSync(path.join(dir, "package", "package.json"), JSON.stringify({ name: "sphica", version }));
  const out = path.join(tempDir("release-verdict-tgz-"), "p.tgz");
  execFileSync("tar", ["czf", out, "-C", dir, "package"]);
  return out;
}

test("the verdict records the release it compared with and the checkout, tree, base, and run it belongs to", async () => {
  await withRepo(async (repo, git) => {
    put(repo, "plugin/package.json", JSON.stringify({ name: "sphica", version: "1.0.0" }));
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    put(repo, "server/package.json", "{}");
    git("add", ".");
    git("commit", "-qm", "dev dependency");
    const published = fs.readFileSync(packed("1.0.0"));
    const integrity = `sha512-${createHash("sha512").update(published).digest("base64")}`;
    const asked: string[] = [];
    const get = async (url: string) => {
      asked.push(url);
      return url.endsWith("/sphica/1.0.0")
        ? Response.json({
            dist: { tarball: "https://registry.npmjs.org/sphica/-/sphica-1.0.0.tgz", integrity },
          })
        : new Response(published);
    };
    const out = path.join(tempDir("release-verdict-out-"), "v.json");
    const v = await writeVerdict({
      packed: packed("1.0.1"),
      base,
      out,
      cwd: repo,
      get,
      env: { GITHUB_RUN_ID: "42", GITHUB_RUN_ATTEMPT: "2" },
    });
    assert.equal(v.verdict, "same", v.reason);
    assert.deepEqual(v.npm, { name: "sphica", version: "1.0.0", integrity });
    assert.equal(v.checkout, git("rev-parse", "HEAD"));
    assert.equal(v.tree, git("rev-parse", "HEAD^{tree}"));
    assert.equal(v.base, base);
    assert.deepEqual(v.run, { id: "42", attempt: "2" });
    assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), JSON.parse(JSON.stringify(v)));
    assert.equal(asked[0], "https://registry.npmjs.org/sphica/1.0.0");
  });
});
