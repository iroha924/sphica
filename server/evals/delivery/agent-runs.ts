// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Which pairs of the labelled delivery sample the agent-run change would drop, by a proxy of its condition: the recipient's Codex session log
// (codex_exec or no log at all) and Claude Code's subagent starts. The hook's environment (the parent marker) is not in the log, so the proxy
// is not the shipped condition. The bar is fixed here, before the pairs are counted, and applies to each block on its own.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { codexThread } from "../../src/codex-log.ts";
import { openReader } from "../../src/db.ts";
import { walk } from "./sample.ts";

const LABELS = ["useful", "irrelevant", "unknown"] as const;
type Label = (typeof LABELS)[number];

/** Who received a pair, as far as the delivery row and the recipient's session log tell */
export type Recipient =
  | "claude-main"
  | "claude-subagent"
  | "codex-tui"
  | "codex-exec"
  | "codex-no-log"
  | "codex-other"
  | "codex-child";

export type Pair = {
  n: number;
  delivery: number;
  unit: number;
  event: string;
  reason: string | null;
  recipient: Recipient;
  settled: Label;
};

export type Block = "agent-run" | "subagent-start";
const BLOCKS: Block[] = ["agent-run", "subagent-start"];

/** A dead-end stop and the context it returns stay in agent-started runs, so their rows are never dropped */
const STOPS = new Set(["command", "command_context"]);

/** The block that would drop a pair, or null for one the change keeps */
export function blockOf(p: Pair): Block | null {
  if (p.recipient === "codex-exec" || p.recipient === "codex-no-log")
    return p.event === "session_start" || (p.event === "pre_read" && !STOPS.has(p.reason ?? ""))
      ? "agent-run"
      : null;
  return (p.recipient === "claude-subagent" || p.recipient === "codex-child") && p.event === "session_start"
    ? "subagent-start"
    : null;
}

export type Verdict = "adopted" | "not adopted" | "undecided";
export type Tally = Record<Label, number> & { verdict: Verdict };

/**
 * The bar: a block is adopted when none of the pairs it drops is known useful and at least 5 are irrelevant, and not adopted when any is
 * useful. Unknown pairs are reported, never counted as a loss, so "known useful 0" does not mean nothing was lost.
 */
export function judge(counts: Record<Label, number>): Verdict {
  if (counts.useful > 0) return "not adopted";
  return counts.irrelevant >= 5 ? "adopted" : "undecided";
}

export function tally(pairs: Pair[]): Record<Block, Tally> {
  return Object.fromEntries(
    BLOCKS.map((b) => {
      const mine = pairs.filter((p) => blockOf(p) === b);
      const counts = Object.fromEntries(
        LABELS.map((l) => [l, mine.filter((p) => p.settled === l).length]),
      ) as Record<Label, number>;
      return [b, { ...counts, verdict: judge(counts) }];
    }),
  ) as Record<Block, Tally>;
}

/** The recipient of one delivery row: Codex by the first line of the session log that ends in the row's thread id */
export function recipientOf(
  row: { host: string; external_id: string; agent_id: string | null },
  codexLog: (thread: string) => string | null,
): Recipient {
  if (row.host !== "codex") return row.agent_id ? "claude-subagent" : "claude-main";
  if (row.agent_id) return "codex-child";
  const file = codexLog(row.external_id);
  if (!file) return "codex-no-log";
  const thread = codexThread({ transcript_path: file });
  return thread?.originator === "codex_exec"
    ? "codex-exec"
    : thread?.originator === "codex-tui"
      ? "codex-tui"
      : "codex-other";
}

type Baseline = { sample: { n: number; delivery: number; unit: number; settled: Label }[] };

async function extract(db: string, codexRoot: string, baseline: Baseline): Promise<Pair[]> {
  const logs = walk(codexRoot);
  const codexLog = (thread: string) =>
    logs.find((f) => path.basename(f).endsWith(`-${thread}.jsonl`)) ?? null;
  const reader = openReader(db);
  try {
    const out: Pair[] = [];
    for (const s of baseline.sample) {
      const row = await reader
        .selectFrom("delivery as d")
        .innerJoin("session as s", "s.id", "d.session_id")
        .select(["d.event", "d.reason", "d.agent_id", "s.host", "s.external_id"])
        .where("d.id", "=", s.delivery)
        .executeTakeFirst();
      if (!row) throw new Error(`delivery ${s.delivery} (pair ${s.n}) is no longer in ${db}`);
      out.push({
        n: s.n,
        delivery: s.delivery,
        unit: s.unit,
        event: row.event,
        reason: row.reason,
        recipient: recipientOf(row, codexLog),
        settled: s.settled,
      });
    }
    return out;
  } finally {
    await reader.destroy();
  }
}

const NOTE =
  "Pairs of the #346 labelled sample the #353 change would drop, by a proxy: a Codex session whose log says codex_exec or that left no log stands for a run another agent started, and a subagent's start for a subagent's start. The shipped condition also needs the parent marker in the hook's environment, which no log keeps, so these counts are not what the change drops. The bar was fixed in the plan after the sample's breakdown by recipient was published on #353, so this is an exploratory call.";

/** Recounts the blocks from the pairs a file keeps and says where they differ from the counts it states */
export function check(file: { pairs: Pair[]; blocks: Record<Block, Tally> }): string[] {
  const now = tally(file.pairs);
  return BLOCKS.flatMap((b) =>
    JSON.stringify(now[b]) === JSON.stringify(file.blocks[b])
      ? []
      : [`${b}: the pairs give ${JSON.stringify(now[b])}, the file states ${JSON.stringify(file.blocks[b])}`],
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      codex: { type: "string" },
      baseline: { type: "string" },
      out: { type: "string" },
      check: { type: "string" },
    },
  });
  if (values.check) {
    const file = JSON.parse(fs.readFileSync(values.check, "utf8")) as {
      pairs: Pair[];
      blocks: Record<Block, Tally>;
    };
    const diff = check(file);
    for (const b of BLOCKS) console.log(`${b}: ${JSON.stringify(file.blocks[b])}`);
    if (diff.length) {
      console.error(diff.join("\n"));
      process.exitCode = 1;
    }
    return;
  }
  const missing = (["db", "codex", "baseline", "out"] as const).filter((k) => !values[k]);
  if (missing.length)
    throw new Error(`pass --check <file>, or ${missing.map((k) => `--${k}`).join(", ")} to extract`);
  const baseline = JSON.parse(fs.readFileSync(values.baseline as string, "utf8")) as Baseline;
  const pairs = await extract(values.db as string, values.codex as string, baseline);
  const out = {
    note: NOTE,
    baseline: values.baseline,
    extracted_at: new Date().toISOString(),
    blocks: tally(pairs),
    pairs,
  };
  fs.writeFileSync(values.out as string, `${JSON.stringify(out, null, 2)}\n`);
  for (const b of BLOCKS) console.log(`${b}: ${JSON.stringify(out.blocks[b])}`);
}

if (process.argv[1] && /agent-runs\.(ts|js)$/.test(process.argv[1])) await main();
