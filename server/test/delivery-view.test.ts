// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The delivery view against real SQLite: the logged rows of one project and period only, main and subagent told apart as the log allows,
// the records delivered most, example sessions, and a reply that keeps its limits and closing lines within READ_BUDGET however long the keys.
import "./isolate-home.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { iso } from "../src/db.ts";
import { DELIVERY_LIMITS, DELIVERY_LIMITS_TEXT, deliveryOverview, namesKey } from "../src/delivery-view.ts";
import { framed } from "../src/frame.ts";
import { READ_BUDGET } from "../src/read.ts";
import { bytes } from "../src/text.ts";
import { hash, insert, message, project, run, session, type TempDb, tempDb } from "./temp-db.ts";
import { tmpEnv } from "./temp-dir.ts";

const NOW = new Date("2026-10-07T00:00:00Z");
const ago = (hours: number) => iso(NOW.getTime() - hours * 60 * 60 * 1000);

const dbs: TempDb[] = [];
after(() => Promise.all(dbs.map((d) => d.done())));
const fresh = () => {
  const db = tempDb();
  dbs.push(db);
  return db;
};

let hashes = 0;
function unit(db: TempDb, p: number, key: string, kind = "finding"): number {
  return insert(db, "unit", {
    project_id: p,
    key,
    kind,
    stance: kind === "decision" || kind === "constraint" ? "do" : null,
    text: `Text of ${key}`,
    extraction: "supported",
    run_id: run(db, p),
    created_at: ago(1000),
    content_hash: hash(++hashes % 256),
  });
}

function delivery(
  db: TempDb,
  s: string,
  v: {
    at: string;
    event?: string;
    outcome?: string;
    reason?: string | null;
    agent?: string | null;
    path?: string | null;
    omitted?: number;
    units?: number[];
  },
): number {
  const id = insert(db, "delivery", {
    session_id: s,
    agent_id: v.agent ?? null,
    event: v.event ?? "pre_read",
    outcome: v.outcome ?? "emitted",
    reason: v.reason ?? null,
    path: v.path ?? null,
    eligible: v.omitted ?? 0,
    omitted: v.omitted ?? 0,
    at: v.at,
  });
  for (const u of v.units ?? []) insert(db, "delivery_unit", { delivery_id: id, unit_id: u });
  return id;
}

test("counts the project's logged rows in the period by event, outcome, and main or subagent", async () => {
  const db = fresh();
  const p = project(db);
  const q = project(db, "git:github.com/o/other", "o/other");
  const s1 = session(db, p, "s1");
  const a = unit(db, p, "trace:s1/a");
  const b = unit(db, p, "trace:s1/b");
  const other = session(db, q, "q1");
  const elsewhere = unit(db, q, "trace:q1/elsewhere");

  delivery(db, s1, { at: ago(1), units: [a] });
  delivery(db, s1, { at: ago(2), omitted: 3 });
  delivery(db, s1, { at: ago(3), agent: "agent-1", units: [a], omitted: 1 });
  delivery(db, s1, { at: ago(4), event: "session_start", reason: "subagent", units: [b] });
  delivery(db, s1, { at: ago(5), event: "session_start", reason: "startup", omitted: 2 });
  delivery(db, s1, { at: ago(6), event: "prompt", outcome: "nothing" });
  // Outside the period: before it, at its end (the end is open), and another project's
  delivery(db, s1, { at: ago(24 * 7 + 1), units: [b] });
  delivery(db, s1, { at: iso(NOW), units: [b] });
  delivery(db, other, { at: ago(1), units: [elsewhere] });

  const out = await deliveryOverview(db.reader, p, 7, NOW);
  assert.ok(out.includes(`Period: from ${ago(24 * 7)} up to ${iso(NOW)} (UTC).`), out);
  assert.ok(out.includes(`Oldest delivery still logged for this project: ${ago(24 * 7 + 1)}.`), out);
  const table = out.split("\n").filter((l) => /^\| [a-z_]+ \| [a-z]+ \|/.test(l) && !l.startsWith("| event"));
  assert.deepEqual(table, [
    "| pre_read | emitted | 2 | 1 | 0 | 1 | 4 |",
    "| prompt | nothing | 1 | 0 | 0 | - | 0 |",
    "| session_start | emitted | 1 | 0 | 1 | 1 | 2 |",
  ]);
  assert.ok(!out.includes("elsewhere"), out);
  // Versions before 0.6.16 logged empty reads and edits, so the limits say when that stopped
  assert.ok(
    out.includes(
      "- Counted are the logged delivery rows only: since 0.6.16 a read or edit that showed nothing is not logged (older rows show it as nothing), and a delivery answered while the write lock was busy, or whose log write failed, is not either.",
    ),
    out,
  );
  // The limits say how rows without an agent id were counted, the subagent start included
  assert.ok(
    out.includes(
      "- Rows without an agent id count as main, as the host reported them, except a subagent start logged without one: subagent, id unknown.",
    ),
    out,
  );
});

test("ranks records by sessions, then deliveries, and names the events they came through", async () => {
  const db = fresh();
  const p = project(db);
  const [s1, s2] = [session(db, p, "s1"), session(db, p, "s2")];
  const wide = unit(db, p, "trace:s1/wide", "decision");
  const often = unit(db, p, "trace:s1/often");
  const once = unit(db, p, "trace:s1/once");
  delivery(db, s1, { at: ago(1), units: [wide, often] });
  delivery(db, s2, { at: ago(2), event: "pre_edit", units: [wide] });
  delivery(db, s1, { at: ago(3), units: [often] });
  delivery(db, s1, { at: ago(4), event: "prompt", units: [often] });
  delivery(db, s1, { at: ago(5), units: [once] });

  const out = await deliveryOverview(db.reader, p, 7, NOW);
  const lines = out.split("\n").filter((l) => l.startsWith("- trace:"));
  assert.deepEqual(lines.slice(0, 3), [
    `- trace:s1/wide (u${wide}, decision, candidate now): 2 sessions, 2 deliveries, via pre_edit, pre_read; named later in 0 of those sessions`,
    `- trace:s1/often (u${often}, finding, candidate now): 1 session, 3 deliveries, via pre_read, prompt; named later in 0 of those sessions`,
    `- trace:s1/once (u${once}, finding, candidate now): 1 session, 1 delivery, via pre_read; named later in 0 of those sessions`,
  ]);
});

test("shows the most recent sessions with each delivery's time, event, agent, path, and keys", async () => {
  const db = fresh();
  const p = project(db);
  const [old, recent] = [session(db, p, "old"), session(db, p, "recent")];
  const units = Array.from({ length: DELIVERY_LIMITS.keys + 2 }, (_, i) => unit(db, p, `trace:s/k${i}`));
  delivery(db, old, { at: ago(30), units: [units[0] ?? 0] });
  delivery(db, recent, { at: ago(3), path: "src/a.ts", units });
  delivery(db, recent, {
    at: ago(2),
    agent: "agent-7",
    event: "session_start",
    reason: "subagent",
    units: [units[1] ?? 0],
  });
  delivery(db, recent, { at: ago(1), outcome: "emitted" });

  const out = await deliveryOverview(db.reader, p, 7, NOW);
  const examples = out.slice(out.indexOf("## Example sessions"), out.indexOf("## Limits"));
  assert.ok(
    examples.indexOf("### claude-code session ext-recent") <
      examples.indexOf("### claude-code session ext-old"),
    examples,
  );
  const named = units
    .slice(0, DELIVERY_LIMITS.keys)
    .map((u, i) => `trace:s/k${i} (u${u})`)
    .join(", ");
  assert.ok(examples.includes(`- ${ago(3)} pre_read, main src/a.ts: ${named} (+2 more)`), examples);
  assert.ok(
    examples.includes(`- ${ago(2)} session_start, subagent agent-7: trace:s/k1 (u${units[1]})`),
    examples,
  );
  // A delivery that logged no record is counted, not listed, so the time shown is the last delivery with a record
  assert.ok(!examples.includes(ago(1)), examples);
  assert.ok(
    examples.includes(`### claude-code session ext-recent, last delivery with a record ${ago(2)}`),
    examples,
  );
});

test("a key counts as named only when written whole, not inside a longer key or word", () => {
  const key = "trace:s/foo";
  assert.equal(namesKey("trace:s/foo", key), true);
  assert.equal(namesKey("See `trace:s/foo` first.", key), true);
  assert.equal(namesKey("It follows trace:s/foo.", key), true);
  assert.equal(namesKey("(trace:s/foo), and so on", key), true);
  assert.equal(namesKey("xtrace:s/foo", key), false);
  assert.equal(namesKey("trace:s/foo-bar", key), false);
  assert.equal(namesKey("trace:s/foo.bar", key), false);
  assert.equal(namesKey("trace:s/foo..bar", key), false);
  assert.equal(namesKey("trace:s/foo/bar", key), false);
  // A longer key first, then the key itself
  assert.equal(namesKey("trace:s/foo-bar, then trace:s/foo", key), true);
});

test("named later counts a session once, only from a captured reply after the delivery and before the period ends", async () => {
  const db = fresh();
  const p = project(db);
  const foo = unit(db, p, "trace:s/foo");
  // One session per case, each delivered the record once, so each exclusion is seen on its own
  const cases = [
    [
      "valid",
      [
        ["t1:assistant:a", 3, "`trace:s/foo` applies here."],
        ["t2:assistant:b", 2, "Again trace:s/foo."],
      ],
    ],
    ["before", [["t1:assistant:c", 6, "Before it: trace:s/foo."]]],
    ["question", [["t1:ask:tu1:q:d", 4, "Keep trace:s/foo?"]]],
    ["afterEnd", [["t1:assistant:e", -1, "After the period: trace:s/foo."]]],
    ["longer", [["t1:assistant:f", 4, "Per xtrace:s/foo, trace:s/foo-bar, and trace:s/foo..bar."]]],
  ] as const;
  const at = new Map<string, string>();
  for (const [i, [name, replies]] of cases.entries()) {
    const s = session(db, p, name);
    at.set(name, ago(5 + i / 10));
    delivery(db, s, { at: at.get(name) ?? "", units: [foo] });
    for (const [id, hours, text] of replies)
      message(db, p, { id, text, speaker: "assistant", sent: ago(hours), session: s });
  }

  const out = await deliveryOverview(db.reader, p, 7, NOW);
  assert.ok(
    out.includes(": 5 sessions, 5 deliveries, via pre_read; named later in 1 of those sessions"),
    out,
  );
  for (const [name] of cases)
    assert.ok(
      out.includes(
        `- ${at.get(name)} pre_read, main: trace:s/foo (u${foo}${name === "valid" ? ", named later" : ""})\n`,
      ),
      `${name}\n${out}`,
    );
});

test("a reply at the same time as the delivery is not after it, so it does not count as naming the record", async () => {
  const db = fresh();
  const p = project(db);
  const s1 = session(db, p, "s1");
  const foo = unit(db, p, "trace:s/foo");
  message(db, p, {
    id: "t1:assistant:a",
    text: "trace:s/foo holds.",
    speaker: "assistant",
    sent: ago(5),
    session: s1,
  });
  delivery(db, s1, { at: ago(5), units: [foo] });

  const out = await deliveryOverview(db.reader, p, 7, NOW);
  assert.ok(out.includes("; named later in 0 of those sessions"), out);
  assert.ok(out.includes(`- ${ago(5)} pre_read, main: trace:s/foo (u${foo})\n`), out);
});

test("an example delivery is marked only by replies after its own time", async () => {
  const db = fresh();
  const p = project(db);
  const s1 = session(db, p, "s1");
  const foo = unit(db, p, "trace:s/foo");
  delivery(db, s1, { at: ago(5), units: [foo] });
  delivery(db, s1, { at: ago(2), event: "pre_edit", units: [foo] });
  message(db, p, {
    id: "t1:assistant:a",
    text: "trace:s/foo holds.",
    speaker: "assistant",
    sent: ago(3),
    session: s1,
  });

  const out = await deliveryOverview(db.reader, p, 7, NOW);
  assert.ok(out.includes(`- ${ago(5)} pre_read, main: trace:s/foo (u${foo}, named later)`), out);
  assert.ok(out.includes(`- ${ago(2)} pre_edit, main: trace:s/foo (u${foo})`), out);
});

test("an empty period says so, with its limits", async () => {
  const db = fresh();
  const p = project(db);
  const out = await deliveryOverview(db.reader, p, 1, NOW);
  assert.ok(out.includes("No delivery was logged for this project in this period."), out);
  assert.ok(out.includes("No record was delivered in this period."), out);
  assert.ok(out.includes("Oldest delivery still logged for this project: none."), out);
  for (const l of DELIVERY_LIMITS_TEXT) assert.ok(out.includes(l), out);
});

test("long multibyte keys, paths, and agent ids in every section stay within READ_BUDGET, keeping the limits and closing", async () => {
  const db = fresh();
  const p = project(db);
  const long = (s: string) => `${s}${"決定".repeat(200)}`;
  const units = Array.from({ length: 40 }, (_, i) => unit(db, p, long(`trace:s/${i}-`)));
  for (let s = 0; s < 10; s++) {
    const id = session(db, p, long(`s${s}-`));
    for (let d = 0; d < 20; d++)
      delivery(db, id, {
        at: ago(s * 24 + d / 10),
        // 200 bytes, the most the schema takes
        agent: d % 2 ? `agent-${"決".repeat(64)}` : null,
        path: long("src/"),
        units: units.slice(d, d + 12),
      });
  }
  const out = await deliveryOverview(db.reader, p, 30, NOW);
  assert.ok(bytes(framed(out)) <= READ_BUDGET, `${bytes(framed(out))} bytes`);
  for (const l of DELIVERY_LIMITS_TEXT) assert.ok(out.includes(l), out);
  assert.ok(
    out.endsWith("Change a record only with the owner's words, through /sphica:trace or /sphica:glean."),
    out,
  );
  assert.match(out, /more delivered records? not shown/);
  assert.match(
    out,
    /more sessions? delivered records in this period, not shown|more deliver(y|ies) with records in this session not shown/,
  );
});

/** The read MCP server on db (none: a database that does not exist), with a home of its own, answering overview calls from a repository registered as git:github.com/o/r */
async function overviewServer(db: TempDb | null) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-delivery-")));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/o/r.git"]);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-delivery-home-"));
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "mcp.ts")],
      env: {
        ...tmpEnv(),
        PATH: process.env.PATH ?? "",
        HOME: home,
        SPHICA_DB: db?.file ?? path.join(home, "missing", "sphica.db"),
      },
      stderr: "ignore",
    }),
  );
  return {
    call: async (args: Record<string, unknown>) => {
      const r = await client.callTool({ name: "overview", arguments: { ...args, cwd: root } });
      return { error: r.isError === true, text: (r.content as { text: string }[])[0]?.text ?? "" };
    },
    close: async () => {
      await client.close();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test("mcp: overview refuses days outside 1 to 90 or with another view, and after with delivery, before reading anything", async () => {
  const s = await overviewServer(null);
  try {
    for (const days of [0, 91, 1.5, "7"]) {
      const r = await s.call({ view: "delivery", days });
      assert.equal(r.error, true, String(days));
      assert.match(r.text, /Input validation error: .* at days/, String(days));
    }
    // The same call within the bounds passes validation (it then finds no database), so the refusals above are the bounds'
    assert.doesNotMatch((await s.call({ view: "delivery", days: 7 })).text, /Input validation error/);
    assert.deepEqual(await s.call({ view: "live", days: 7 }), {
      error: true,
      text: "days: only with view delivery",
    });
    assert.deepEqual(await s.call({ view: "look", days: 7 }), {
      error: true,
      text: "days: only with view delivery",
    });
    assert.deepEqual(await s.call({ view: "delivery", after: 3 }), {
      error: true,
      text: "after: not with view delivery, which is one page",
    });
  } finally {
    await s.close();
  }
});

test("mcp: overview answers the delivery view for 1 and 90 days and 7 by default, framed", async () => {
  const db = fresh();
  const p = project(db);
  const foo = unit(db, p, "trace:s/foo");
  delivery(db, session(db, p, "s1"), { at: iso(Date.now() - 60 * 60 * 1000), units: [foo] });
  const s = await overviewServer(db);
  try {
    for (const [days, heading] of [
      [undefined, "last 7 days"],
      [1, "last 1 day"],
      [90, "last 90 days"],
    ] as const) {
      const r = await s.call({ view: "delivery", ...(days === undefined ? {} : { days }) });
      assert.equal(r.error, false, r.text);
      assert.ok(r.text.startsWith("<past-records id="), r.text);
      assert.ok(r.text.includes(`# Delivery log of the ${heading}`), r.text);
      assert.ok(
        r.text.includes(`- trace:s/foo (u${foo}, finding, candidate now): 1 session, 1 delivery`),
        r.text,
      );
    }
  } finally {
    await s.close();
  }
});
