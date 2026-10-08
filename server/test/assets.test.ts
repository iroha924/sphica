import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { dbDir } from "../src/assets.ts";
import { tempDir } from "./temp-dir.ts";

/**
 * Builds the shipped layout in a temp directory. **Build it outside the repository.**
 * Inside it, lookups would walk up to the repository's db even with candidates removed, and a broken layout would pass.
 */
function packaged(): { pkg: string; dist: string } {
  const pkg = tempDir("sphica-assets-");
  fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
  fs.mkdirSync(path.join(pkg, "db"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "db", "schema.sql"), "-- schema");
  return { pkg, dist: path.join(pkg, "dist") };
}

test("in the shipped layout, db resolves from the package root", () => {
  const { pkg, dist } = packaged();
  // npm files puts db at <package>/db, so go up one level from dist.
  assert.equal(dbDir(dist), path.join(pkg, "db"));
});

test("throws instead of falling back when the package has no db", () => {
  const { pkg, dist } = packaged();
  fs.rmSync(path.join(pkg, "db"), { recursive: true });
  assert.throws(() => dbDir(dist), /db\/schema\.sql/);
});

test("in the working tree, db resolves from the repository root", () => {
  const dir = dbDir();
  assert.ok(fs.existsSync(path.join(dir, "schema.sql")), `${dir} has no schema.sql`);
});
