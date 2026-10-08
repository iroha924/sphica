// The review evaluation's fixture and expected verdicts: every record a case expects is the set review_select selects for its diff, so a
// run is graded on the records it was asked about.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { buildReviewFixture, loadReviewCases } from "../evals/review/fixture.ts";
import { openReader } from "../src/db.ts";
import { parseDiff, selectForReview } from "../src/review.ts";
import { tempDir } from "./temp-dir.ts";

const OUTCOMES = new Set(["violation", "complies", "unrelated", "undetermined"]);

test("each review case expects exactly the records review_select selects for its diff", async () => {
  const cases = loadReviewCases();
  const fixture = await buildReviewFixture(tempDir("review-eval-"), cases);
  const db = openReader(fixture.db);
  try {
    const project = await db.selectFrom("project").select("id").executeTakeFirstOrThrow();
    const active = new Set(
      (await db.selectFrom("unit").select("key").where("lifecycle", "=", "active").execute()).map(
        (u) => u.key,
      ),
    );
    assert.equal(Object.keys(fixture.diffs).length, cases.diffs.length);
    for (const d of cases.diffs) {
      for (const [key, e] of Object.entries(d.expect)) {
        assert.ok(active.has(key), `${d.id}: ${key} is not an active record of the fixture`);
        assert.ok(e.outcomes.length && e.outcomes.every((o) => OUTCOMES.has(o)), `${d.id}: ${key} outcomes`);
        // A question is an undetermined verdict, and an undetermined one that needs no question is a note
        if (e.question) assert.deepEqual(e.outcomes, ["undetermined"], `${d.id}: ${key}`);
      }
      const text = fs.readFileSync(fixture.diffs[d.id] ?? "", "utf8");
      const selected = await selectForReview(db, project.id, parseDiff(text));
      assert.deepEqual(selected.map((u) => u.key).sort(), Object.keys(d.expect).sort(), d.id);
    }
  } finally {
    await db.destroy();
  }
});
