// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// scripts/lib/tarball-diff.mjs on tarballs made with the system tar, against a stand-in registry
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { verdictFor } from "../../scripts/lib/tarball-diff.mjs";
import { tempDir } from "./temp-dir.ts";

const BASE: Record<string, string> = {
  "package.json": JSON.stringify({ name: "sphica", version: "1.0.0", bin: { sphica: "dist/cli.js" } }),
  ".claude-plugin/plugin.json": JSON.stringify({ name: "sphica", version: "1.0.0" }),
  ".codex-plugin/plugin.json": JSON.stringify({ name: "sphica", version: "1.0.0" }),
  "dist/cli.js": "console.log(1);\n",
  "THIRD_PARTY_NOTICES.md": "zod 4.6.5 MIT\n",
  "README.md": "# Sphica\n",
};

/** A .tgz with package/<file> entries, as npm pack lays them out */
function tgz(files: Record<string, string>, executable: string[] = ["dist/cli.js"]) {
  const dir = tempDir("tarball-diff-src-");
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, "package", rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    fs.chmodSync(file, executable.includes(rel) ? 0o755 : 0o644);
  }
  const out = path.join(tempDir("tarball-diff-tgz-"), "p.tgz");
  execFileSync("tar", ["czf", out, "-C", dir, "package"]);
  return out;
}

/** A stand-in registry serving one published tarball, recording the URLs asked */
function registry(published: string | null, integrity?: string) {
  const asked: string[] = [];
  const bytes = published ? fs.readFileSync(published) : Buffer.alloc(0);
  const sri = integrity ?? `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const get = async (url: string) => {
    asked.push(url);
    if (url === "https://registry.npmjs.org/sphica/1.0.0")
      return published
        ? Response.json({
            dist: { tarball: "https://registry.npmjs.org/sphica/-/sphica-1.0.0.tgz", integrity: sri },
          })
        : new Response("{}", { status: 404 });
    if (url === "https://registry.npmjs.org/sphica/-/sphica-1.0.0.tgz") return new Response(bytes);
    return new Response("", { status: 500 });
  };
  return { get, asked };
}

const verdict = (packed: string, get: Parameters<typeof verdictFor>[0]["get"]) =>
  verdictFor({ packed, name: "sphica", version: "1.0.0", work: tempDir("tarball-diff-work-"), get });

test("a tarball that differs from the release only in its versions and README is the same", async () => {
  const bumped = {
    ...BASE,
    "package.json": BASE["package.json"]?.replace("1.0.0", "1.0.1") ?? "",
    ".claude-plugin/plugin.json": BASE[".claude-plugin/plugin.json"]?.replace("1.0.0", "1.0.1") ?? "",
    ".codex-plugin/plugin.json": BASE[".codex-plugin/plugin.json"]?.replace("1.0.0", "1.0.1") ?? "",
    "README.md": "# Sphica, reworded\n",
  };
  const { get, asked } = registry(tgz(BASE));
  const v = await verdict(tgz(bumped), get);
  assert.equal(v.verdict, "same", v.reason);
  assert.deepEqual(v.npm?.version, "1.0.0");
  assert.equal(asked.length, 2);
});

test("bytes, the notices, a field beside the version, an added file, and the executable bit each make it differ", async () => {
  const { get } = registry(tgz(BASE));
  const cases: [Record<string, string>, string[] | undefined, string][] = [
    [{ ...BASE, "dist/cli.js": "console.log(2);\n" }, undefined, "dist/cli.js"],
    [{ ...BASE, "THIRD_PARTY_NOTICES.md": "zod 4.6.6 MIT\n" }, undefined, "THIRD_PARTY_NOTICES.md"],
    [
      {
        ...BASE,
        "package.json": JSON.stringify({
          name: "sphica",
          version: "1.0.0",
          bin: { sphica: "dist/other.js" },
        }),
      },
      undefined,
      "package.json",
    ],
    [{ ...BASE, "dist/extra.js": "" }, undefined, "dist/extra.js"],
    [BASE, [], "dist/cli.js"],
  ];
  for (const [files, executable, changed] of cases) {
    const v = await verdict(tgz(files, executable), get);
    assert.equal(v.verdict, "differs", changed);
    assert.deepEqual(v.paths, [changed]);
  }
});

test("a release the registry does not have, a tarball that fails its integrity, and an unreachable registry are unknown", async () => {
  const packed = tgz(BASE);
  assert.match((await verdict(packed, registry(null).get)).reason, /not published/);
  const wrong = registry(tgz(BASE), `sha512-${Buffer.alloc(64).toString("base64")}`);
  const v = await verdict(packed, wrong.get);
  assert.equal(v.verdict, "unknown");
  assert.match(v.reason, /does not match/);
  const down = await verdict(packed, async () => {
    throw new TypeError("fetch failed");
  });
  assert.equal(down.verdict, "unknown");
  assert.match(down.reason, /could not be read \(TypeError\)/);
});

test("a registry that points the tarball elsewhere is not followed", async () => {
  const get = async (url: string) =>
    url.endsWith("/sphica/1.0.0")
      ? Response.json({ dist: { tarball: "https://example.com/sphica.tgz", integrity: "sha512-x" } })
      : new Response("", { status: 500 });
  const v = await verdict(tgz(BASE), get);
  assert.equal(v.verdict, "unknown");
  assert.match(v.reason, /outside itself/);
});
