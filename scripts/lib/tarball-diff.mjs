// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Whether a packed tarball ships the same files as a published release: paths, bytes, and the executable bit, with the version fields
// set aside. README.md is left out, since a change to it alone ships with the next release. Anything that cannot be compared is unknown.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withoutReleaseVersion } from "./release-scope.mjs";

/** Files whose version fields are set aside before comparing (paths inside the tarball, without `package/`) */
const VERSIONED = new Set(["package.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]);
const IGNORED = new Set(["README.md"]);

/** Unpacks a .tgz into dir with the system tar, as check-tarball.mjs does, and returns the package root */
function unpack(tgz, dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("tar", ["xzf", tgz, "-C", dir]);
  return path.join(dir, "package");
}

/** Every regular file under dir, as forward-slash paths relative to it. A link or any other kind of entry is reported, never followed */
function files(dir) {
  const out = new Map();
  for (const rel of fs.readdirSync(dir, { recursive: true })) {
    const name = String(rel).split(path.sep).join("/");
    const stat = fs.lstatSync(path.join(dir, name));
    if (stat.isDirectory()) continue;
    out.set(name, stat.isFile() ? stat : null);
  }
  return out;
}

/** The paths that differ between two unpacked package roots, sorted. Empty means they ship the same files */
function differingPaths(aDir, bDir) {
  const [a, b] = [files(aDir), files(bDir)];
  const differs = [];
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    if (IGNORED.has(name)) continue;
    const [sa, sb] = [a.get(name), b.get(name)];
    if (!sa || !sb || (sa.mode & 0o111) !== (sb.mode & 0o111)) {
      differs.push(name);
      continue;
    }
    const [ta, tb] = [fs.readFileSync(path.join(aDir, name)), fs.readFileSync(path.join(bDir, name))];
    const same = VERSIONED.has(name)
      ? withoutReleaseVersion(ta.toString("utf8")) === withoutReleaseVersion(tb.toString("utf8"))
      : ta.equals(tb);
    if (!same) differs.push(name);
  }
  return differs.sort();
}

/**
 * Downloads name@version from the registry into dest/published.tgz and checks it against the integrity the registry lists. Returns the
 * file and that integrity, or a string saying why it could not. get is fetch, or a stand-in in tests.
 */
async function fetchPublished(name, version, dest, get = fetch) {
  const registry = "https://registry.npmjs.org";
  try {
    const meta = await get(`${registry}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (meta.status === 404) return `${name}@${version} is not published`;
    if (!meta.ok) return `the registry answered ${meta.status} for ${name}@${version}`;
    const dist = (await meta.json())?.dist;
    const integrity = dist?.integrity;
    if (
      typeof dist?.tarball !== "string" ||
      typeof integrity !== "string" ||
      !integrity.startsWith("sha512-")
    )
      return `the registry lists no sha512 tarball for ${name}@${version}`;
    if (!dist.tarball.startsWith(`${registry}/`)) return "the registry points the tarball outside itself";
    const res = await get(dist.tarball, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return `the tarball download answered ${res.status}`;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== integrity)
      return `the downloaded tarball does not match ${integrity}`;
    fs.mkdirSync(dest, { recursive: true });
    const file = path.join(dest, "published.tgz");
    fs.writeFileSync(file, bytes);
    return { file, integrity };
  } catch (e) {
    return `the registry could not be read (${e instanceof Error ? e.name : "unknown error"})`;
  }
}

/**
 * Compares the packed tarball with name@version on the registry. work is an empty directory for both unpacked trees.
 * Returns { verdict: "same" | "differs" | "unknown", paths, reason, npm }.
 */
export async function verdictFor({ packed, name, version, work, get = fetch }) {
  const published = await fetchPublished(name, version, path.join(work, "download"), get);
  if (typeof published === "string") return { verdict: "unknown", paths: [], reason: published, npm: null };
  const npm = { name, version, integrity: published.integrity };
  try {
    const paths = differingPaths(
      unpack(packed, path.join(work, "packed")),
      unpack(published.file, path.join(work, "published")),
    );
    return paths.length
      ? { verdict: "differs", paths, reason: `${paths.length} shipped file(s) differ`, npm }
      : { verdict: "same", paths, reason: "the shipped files match apart from the version", npm };
  } catch (e) {
    return {
      verdict: "unknown",
      paths: [],
      reason: `the tarballs could not be compared (${e instanceof Error ? e.message : e})`,
      npm,
    };
  }
}
