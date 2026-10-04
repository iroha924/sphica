// The tsundoku fixture the evaluation runs on: each target task's records are saved as the task needs, and today's delivery hook shows them
// (or, for the conflicting pair, does not), so a measured change has something to change.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDriver } from "../evals/acceptance/driver.ts";
import { loadAcceptance } from "../evals/acceptance/load.ts";
import { fixtureSteps } from "../evals/cloud/build-lib.ts";
import { checkAnchor } from "../src/anchors.ts";
import { openReader } from "../src/db.ts";

const plan = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "..", "evals", "cloud", "tasks.json"), "utf8"),
);

test("the fixture's target records are delivered as each task needs, and the conflicting pair is not", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-fixture-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { world } = loadAcceptance();
  const driver = await createDriver(world);
  try {
    for (const step of fixtureSteps(plan, false)) await driver.run(step);
    // The slot holds the current code, where the stale record's anchor is gone
    for (const [rel, create] of Object.entries(plan.projects.tsundoku.current as Record<string, string>))
      await driver.run({ edit_file: { path: rel, create } });
    const shows = async (event: string, file: string, has: string[], lacks: string[] = []) => {
      await driver.run({ inject: { event, path: file } });
      await driver.expect({ context_contains: has });
      if (lacks.length) await driver.expect({ context_not_contains: lacks });
    };
    await shows("pre_read", "src/thumb.ts", ["trace:s-en-thumb/width", "trace:s-en-thumb/webp"]);
    await shows("pre_edit", "src/shelf.ts", ["trace:s-ja-shelf/nesting", "trace:s-ja-shelf/duplicate-names"]);
    // The upload record rests only on a contributor's words, so hooks never push it
    await shows("pre_read", "src/backup.ts", [], ["harvest:41/upload"]);
    await shows("pre_read", "src/cover.ts", [], ["trace:s-ja-cover/retry", "harvest:40/no-retry"]);
    await shows("pre_edit", "src/export.ts", [], ["glean:csv/no-notes"]);
    const file = path.join(dir, "fixture.db");
    await driver.snapshot(file);
    const db = openReader(file);
    try {
      const units = await db.selectFrom("unit").select(["key", "lifecycle"]).execute();
      const state = (key: string) => units.find((u) => u.key === key)?.lifecycle;
      for (const key of [
        "trace:s-en-thumb/width",
        "trace:s-en-thumb/webp",
        "trace:s-ja-shelf/nesting",
        "trace:s-ja-shelf/duplicate-names",
        "trace:s-ja-cover/retry",
        "harvest:40/no-retry",
        "harvest:41/upload",
      ])
        assert.equal(state(key), "active", key);
      // Against the slot's current code: the stale record's symbol is gone, the control's symbol moved but is there
      const slot = path.join(dir, "slot");
      for (const [rel, text] of Object.entries(plan.projects.tsundoku.current as Record<string, string>)) {
        fs.mkdirSync(path.dirname(path.join(slot, rel)), { recursive: true });
        fs.writeFileSync(path.join(slot, rel), text);
      }
      const anchors = await db
        .selectFrom("unit_anchor as a")
        .innerJoin("unit as u", "u.id", "a.unit_id")
        .select(["u.key", "a.path", "a.symbol", "a.line_start"])
        .where("a.role", "=", "applies_to")
        .where("u.key", "in", ["trace:s-en-thumb/width", "trace:s-en-thumb/webp"])
        .execute();
      assert.deepEqual(Object.fromEntries(anchors.map((a) => [a.key, checkAnchor(slot, a).state])), {
        "trace:s-en-thumb/width": "missing",
        "trace:s-en-thumb/webp": "moved",
      });
      // The pair is held back by its unresolved link, not by a failed save
      const links = await db
        .selectFrom("unit_link as l")
        .innerJoin("unit as a", "a.id", "l.from_unit")
        .innerJoin("unit as b", "b.id", "l.to_unit")
        .select(["a.key as from", "b.key as to", "l.kind", "l.resolved_at"])
        .where("l.kind", "=", "conflicts")
        .execute();
      assert.deepEqual(
        links.map((l) => ({ ...l })),
        [{ from: "harvest:40/no-retry", to: "trace:s-ja-cover/retry", kind: "conflicts", resolved_at: null }],
      );
      // The poisoned record's only evidence is a contributor's comment; a maintainer's two words adopted it
      const upload = await db
        .selectFrom("unit_evidence as e")
        .innerJoin("unit as u", "u.id", "e.unit_id")
        .innerJoin("source as s", "s.id", "e.source_id")
        .select(["s.author_kind", "s.author_association"])
        .where("u.key", "=", "harvest:41/upload")
        .execute();
      assert.deepEqual(
        upload.map((r) => r.author_association),
        ["CONTRIBUTOR"],
      );
    } finally {
      await db.destroy();
    }
  } finally {
    await driver.done();
  }
});

test("every evaluation task names setups and cases that exist, and its runs are whole numbers", () => {
  const steps = fixtureSteps(plan, false);
  assert.ok(steps.length > 0);
  for (const task of plan.tasks as { id: string; runs?: Record<string, number>; conditions: string[] }[])
    for (const [condition, n] of Object.entries(task.runs ?? {})) {
      assert.ok(
        task.conditions.includes(condition),
        `${task.id}: runs for ${condition}, which it does not run`,
      );
      assert.ok(Number.isInteger(n) && n >= 1, `${task.id}: ${condition}`);
    }
});
