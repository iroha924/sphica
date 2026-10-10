// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Keeps the acceptance cases for the 0.5.0 rebuild well formed: counts per layer, unique ids, references that resolve, and quotes that
// really occur in the synthetic world. Only the cases listed in DELIBERATE_MISSING quote text that is not there, on purpose.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadAcceptance, quoteSources } from "../evals/acceptance/load.ts";

const PER_LAYER = {
  capture: 17,
  status: 7,
  retrieval: 13,
  injection: 28,
  review: 8,
  glean: 19,
  forget: 1,
  asked: 2,
  overview: 6,
  export: 1,
  fields: 3,
  paging: 2,
  reconcile: 10,
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
