// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Registers the acceptance cases as tests. run.ts registers all of them; each shard-<k>.ts registers its share, and node --test runs the
// shard files in separate processes at once. A case rewrites process.env while it runs, so two cases must never share a process at once.
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createDriver } from "./driver.ts";
import { type Case, loadAcceptance, type Step } from "./load.ts";

const SHARD = /^shard-([1-9]\d*)\.ts$/;

/** The shard number k a file named shard-<k>.ts runs. */
export function shardOf(file: string): number {
  const m = SHARD.exec(path.basename(file));
  if (!m) throw new Error(`${path.basename(file)} is not named shard-<k>.ts`);
  return Number(m[1]);
}

/** How many shard files the directory holds, numbered 1 to n without gaps, so every case runs in exactly one of them. */
export function shardCount(dir = import.meta.dirname): number {
  const ks = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("shard-"))
    .map(shardOf)
    .sort((a, b) => a - b);
  if (!ks.length || ks.some((k, i) => k !== i + 1))
    throw new Error(`the shard files must be numbered 1 to n without gaps, found [${ks.join(", ")}]`);
  return ks.length;
}

/** Whether the case at index belongs to shard k of n. */
export const inShard = (index: number, k: number, n: number): boolean => index % n === k - 1;

/** The cases a run takes: those pick keeps, in the layer named (all layers when none is). */
export function selectCases(
  pick: (index: number) => boolean,
  layer = process.env.SPHICA_ACCEPTANCE_LAYER,
): Case[] {
  return loadAcceptance().cases.filter((c, i) => pick(i) && (!layer || c.layer === layer));
}

/**
 * The steps that build a case's world: referenced cases first (their own setup and operation), then named setups, then inline steps.
 * A case reached twice (two setups sharing one) is arranged once; a case reached again along its own chain is a cycle.
 */
function arrange(
  c: Case,
  byId: Map<string, Case>,
  setups: Record<string, Step>,
  chain = new Set<string>(),
  done = new Set<string>(),
): Step[] {
  if (chain.has(c.id)) throw new Error(`${c.id} refers to itself through its setup`);
  const inner = new Set([...chain, c.id]);
  return c.given.flatMap((g): Step[] => {
    if (typeof g.case === "string") {
      const other = byId.get(g.case);
      if (!other) throw new Error(`${c.id} refers to unknown case ${g.case}`);
      if (done.has(other.id)) return [];
      const steps = [...arrange(other, byId, setups, inner, done), other.when];
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

/** Registers one test per selected case. References resolve against every case, also those another shard runs. */
export function registerCases(pick: (index: number) => boolean = () => true): void {
  const { world, cases, setups } = loadAcceptance();
  const byId = new Map(cases.map((c) => [c.id, c]));
  for (const c of selectCases(pick)) {
    test(`${c.id} (${c.lang}) ${c.summary ?? ""}`.trim(), async () => {
      const driver = await createDriver(world);
      try {
        for (const step of arrange(c, byId, setups)) await driver.run(step);
        await driver.run(c.when);
        for (const expectation of c.then) await driver.expect(expectation);
      } finally {
        await driver.done();
      }
    });
  }
}
