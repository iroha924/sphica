// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Keeps the acceptance cases for the 0.5.0 rebuild well formed: counts per layer, unique ids, references that resolve, and quotes that
// really occur in the synthetic world. Only the cases listed in DELIBERATE_MISSING quote text that is not there, on purpose.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { inShard, selectCases, shardCount, shardOf } from "../evals/acceptance/cases-run.ts";
import { loadAcceptance, quoteSources } from "../evals/acceptance/load.ts";
import { tempDir } from "./temp-dir.ts";

const ROOT = path.join(import.meta.dirname, "..", "..");

const PER_LAYER = {
  capture: 21,
  status: 9,
  retrieval: 17,
  injection: 34,
  review: 8,
  glean: 19,
  forget: 1,
  asked: 2,
  overview: 6,
  export: 1,
  fields: 3,
  paging: 3,
  reconcile: 12,
  agent: 15,
};
const DELIBERATE_MISSING = new Set(["capture-04", "glean-03"]);

test("the acceptance set has the agreed number of cases per layer and unique ids", () => {
  const { cases } = loadAcceptance();
  const count: Record<string, number> = {};
  for (const c of cases) count[c.layer] = (count[c.layer] ?? 0) + 1;
  assert.deepEqual(count, PER_LAYER);
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
});

test("every language direction has answerable and unanswerable retrieval cases", () => {
  const { cases } = loadAcceptance();
  for (const lang of ["ja>ja", "en>en", "ja>en", "en>ja"]) {
    const these = cases.filter((c) => c.layer === "retrieval" && c.lang === lang);
    assert.ok(these.length >= 3, lang);
    assert.equal(these.filter((c) => JSON.stringify(c.then).includes("no_active_unit_hits")).length, 1, lang);
  }
});

test("case and setup references resolve", () => {
  const { cases, setups } = loadAcceptance();
  const ids = new Set(cases.map((c) => c.id));
  for (const c of cases)
    for (const g of c.given) {
      if (typeof g.case === "string") assert.ok(ids.has(g.case), `${c.id} → ${g.case}`);
      for (const key of Object.keys(g))
        if (g[key] === true) assert.ok(key in setups, `${c.id} → setup ${key}`);
    }
});

test("quoted evidence occurs in its source, except in the cases that test a missing quote", () => {
  const { cases, setups, world } = loadAcceptance();
  const missing = quoteSources(world, cases, setups).filter((q) => !q.found);
  assert.deepEqual([...new Set(missing.map((q) => q.caseId))].sort(), [...DELIBERATE_MISSING].sort());
});

test("the shard files together run every case exactly once, in every layer and in all of them", () => {
  const { cases } = loadAcceptance();
  const n = shardCount();
  assert.ok(n > 1, `${n} shard files`);
  // "" selects every layer, whatever SPHICA_ACCEPTANCE_LAYER the shell running the tests has set
  for (const layer of ["", ...Object.keys(PER_LAYER)]) {
    const ran = Array.from({ length: n }, (_, k) => selectCases((i) => inShard(i, k + 1, n), layer)).flat();
    const want = cases.filter((c) => !layer || c.layer === layer).map((c) => c.id);
    assert.deepEqual(ran.map((c) => c.id).sort(), want.sort(), layer || "all layers");
  }
});

test("a shard number comes only from a file named shard-<k>.ts, and the numbers run from 1 without gaps", () => {
  assert.equal(shardOf("/x/shard-12.ts"), 12);
  for (const bad of ["shard-0.ts", "shard-01.ts", "shard-a.ts", "shard-1.js", "run.ts"])
    assert.throws(() => shardOf(bad), /not named shard-<k>\.ts/, bad);
  const dir = tempDir("sphica-shards-");
  const files = (...names: string[]) => {
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
    for (const f of names) fs.writeFileSync(path.join(dir, f), "");
  };
  files("shard-1.ts", "shard-2.ts", "cases-run.ts");
  assert.equal(shardCount(dir), 2);
  files("shard-1.ts", "shard-3.ts");
  assert.throws(() => shardCount(dir), /without gaps, found \[1, 3\]/);
  files("shard-2.ts");
  assert.throws(() => shardCount(dir), /without gaps/);
  files("run.ts");
  assert.throws(() => shardCount(dir), /without gaps, found \[\]/);
  files("shard-1.ts", "shard-x.ts");
  assert.throws(() => shardCount(dir), /not named shard-<k>\.ts/);
});

test("bun run acceptance names every shard file, so a moved or missing one fails instead of running nothing", () => {
  const script = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts
    .acceptance as string;
  const named = script.split(" ").filter((a) => a.endsWith(".ts"));
  const want = Array.from({ length: shardCount() }, (_, k) => `server/evals/acceptance/shard-${k + 1}.ts`);
  assert.deepEqual(named, want);
  for (const f of named) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
});
