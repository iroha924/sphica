// The offline order benchmark: a file crowded with more records than one delivery shows, delivered by this tree's hooks, and which of
// them land inside the limits. The records differ in kind, stance, who adopted them, and age, so an ordering rule shows what it brings in
// and what it pushes out.
import { createDriver } from "../acceptance/driver.ts";
import { loadAcceptance, type Step } from "../acceptance/load.ts";

const SETUPS = ["crowded_lib_1", "crowded_lib_2", "crowded_lib_3", "crowded_pr50", "crowded_lib_4"];
const FILE = "src/library.ts";
const EVENTS = ["pre_read", "pre_edit"] as const;

/**
 * The records an ordering by weight is meant to bring inside the limits (a constraint, a decision against something, the owner's own
 * decisions), and the ones it would push out to make room (findings, dead ends, a maintainer's decisions, a deferral).
 */
export const WEIGHTY = [
  "trace:s-lib-1/loan-days",
  "trace:s-lib-1/no-late-fees",
  "trace:s-lib-2/members-only",
  "trace:s-lib-4/renew-once",
];
export const LIGHT = [
  "trace:s-lib-2/holds-later",
  "trace:s-lib-3/linear-scan",
  "trace:s-lib-3/map-by-member",
  "harvest:50/local-due",
  "harvest:50/loan-log",
];

type EventResult = { event: string; shown: string[]; chars: number };
export type OrderResult = {
  events: EventResult[];
  /** Per record: in how many of the events it was shown */
  shown: Record<string, number>;
  weighty: { shown: number; of: number };
  light: { shown: number; of: number };
};

/** The keys a delivery shows, each from its own line `- <key> (`. */
export const keysIn = (context: string) => [...context.matchAll(/^- (\S+) \(/gm)].map((m) => m[1] ?? "");

export async function orderBench(): Promise<OrderResult> {
  const { world, setups } = loadAcceptance();
  const driver = await createDriver(world);
  try {
    for (const name of SETUPS) {
      const setup = setups[name] as Step | undefined;
      if (!setup) throw new Error(`no setup ${name}`);
      for (const [k, v] of Object.entries(setup)) await driver.run({ [k]: v });
    }
    const events: EventResult[] = [];
    for (const event of EVENTS) {
      // Each event runs in a fresh session, so nothing counts as already shown
      await driver.run({ inject: { event, path: FILE } });
      const context = driver.delivered().join("\n");
      events.push({ event, shown: keysIn(context), chars: context.length });
    }
    const shown = Object.fromEntries(
      [...WEIGHTY, ...LIGHT].map((k) => [k, events.filter((e) => e.shown.includes(k)).length]),
    );
    const tally = (keys: string[]) => ({
      shown: keys.reduce((n, k) => n + (shown[k] ?? 0), 0),
      of: keys.length * events.length,
    });
    return { events, shown, weighty: tally(WEIGHTY), light: tally(LIGHT) };
  } finally {
    await driver.done();
  }
}
