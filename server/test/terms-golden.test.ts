// The full-text indexes hold terms() output from when each row was written. A change to its rules leaves every existing row indexed the old way,
// so a search with the new rules misses them until the index is rebuilt. This pins the output for fixed inputs, so the change is noticed.

import assert from "node:assert/strict";
import { test } from "node:test";
import { SAMPLES, splitDrift } from "../src/split-check.ts";

test("terms() gives the pinned output for every fixed input", () => {
  assert.ok(SAMPLES.length > 50, "the inputs are there");
  const changed = splitDrift();
  assert.deepEqual(
    changed.map((c) => c.text.slice(0, 80)),
    [],
    "terms() output changed, so indexed rows no longer match searches. If the change is meant, raise the schema revision, add a migration that rebuilds unit_fts and source_fts as reindex() in server/src/admin.ts does, then update server/src/terms-golden.json",
  );
});
