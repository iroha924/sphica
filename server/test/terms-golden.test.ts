// The full-text indexes hold terms() output from when each row was written. A change to its rules leaves every existing row indexed the old way,
// so a search with the new rules misses them until the index is rebuilt. This pins the output for fixed inputs, so the change is noticed.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { terms } from "../src/text.ts";

const golden = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "fixtures", "terms-golden.json"), "utf8"),
) as { cases: { text: string; terms: string[] }[] };

test("terms() gives the pinned output for every fixed input", () => {
  assert.ok(golden.cases.length > 50, "the inputs are there");
  const changed = golden.cases.filter((c) => JSON.stringify(terms(c.text)) !== JSON.stringify(c.terms));
  assert.deepEqual(
    changed.map((c) => c.text.slice(0, 80)),
    [],
    "terms() output changed, so indexed rows no longer match searches. If the change is meant, raise the schema revision, add a migration that rebuilds unit_fts and source_fts as reindex() in server/src/admin.ts does, then update server/test/fixtures/terms-golden.json",
  );
});
