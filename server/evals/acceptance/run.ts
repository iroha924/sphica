// Runs the acceptance cases against the product through its public entry points. Not part of verify until each layer is implemented:
// `bun run acceptance` reports every case, and a layer joins verify once all its cases pass (plan step 1).
import { test } from "node:test";
import { createDriver } from "./driver.ts";
import { type Case, loadAcceptance, type Step } from "./load.ts";

const { world, cases, setups } = loadAcceptance();
const byId = new Map(cases.map((c) => [c.id, c]));
const only = process.env.SPHICA_ACCEPTANCE_LAYER;

/**
 * The steps that build a case's world: referenced cases first (their own setup and operation), then named setups, then inline steps.
 * A case reached twice (two setups sharing one) is arranged once; a case reached again along its own chain is a cycle.
 */
function arrange(c: Case, chain = new Set<string>(), done = new Set<string>()): Step[] {
  if (chain.has(c.id)) throw new Error(`${c.id} refers to itself through its setup`);
  const inner = new Set([...chain, c.id]);
  return c.given.flatMap((g): Step[] => {
    if (typeof g.case === "string") {
      const other = byId.get(g.case);
      if (!other) throw new Error(`${c.id} refers to unknown case ${g.case}`);
      if (done.has(other.id)) return [];
      const steps = [...arrange(other, inner, done), other.when];
      done.add(other.id);
      return steps;
    }
    const named = Object.keys(g).filter((k) => g[k] === true && k in setups);
    if (named.length) return named.flatMap((k) => expand(setups[k] as Step));
    return [g];
  });
}

/** A setup may bundle several steps (capture, then trace) in one object. */
const expand = (s: Step): Step[] => Object.entries(s).map(([k, v]) => ({ [k]: v }));

for (const c of cases.filter((x) => !only || x.layer === only)) {
  test(`${c.id} (${c.lang}) ${c.summary ?? ""}`.trim(), async () => {
    const driver = await createDriver(world);
    try {
      for (const step of arrange(c)) await driver.run(step);
      await driver.run(c.when);
      for (const expectation of c.then) await driver.expect(expectation);
    } finally {
      await driver.done();
    }
  });
}
