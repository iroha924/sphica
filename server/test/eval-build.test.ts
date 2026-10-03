// The evaluation slots' scripts: where they put the database copy, the receipts, and the gold marker, for the cloud VM and the local runners.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { planRows } from "../evals/cloud/firing.ts";
import { GOLD_SH, HOOK_SH, NODE_SH, SPHICA_SH } from "../evals/cloud/slot-scripts.ts";

/** A slot's .tools directory with its scripts and a stand-in fixture, plus a scratch TMPDIR. */
function slot(t: { after: (fn: () => void) => void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eval-slot-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tools = path.join(root, "tools");
  const tmp = path.join(root, "tmp");
  fs.mkdirSync(tools);
  fs.mkdirSync(tmp);
  for (const [name, body] of [
    ["node.sh", NODE_SH],
    ["sphica.sh", SPHICA_SH],
    ["hook.sh", HOOK_SH],
    ["gold.sh", GOLD_SH],
  ] as const)
    fs.writeFileSync(path.join(tools, name), body, { mode: 0o755 });
  fs.writeFileSync(path.join(tools, "fixture.id"), "abc123\n");
  fs.writeFileSync(path.join(tools, "fixture.db"), "fixture bytes");
  fs.writeFileSync(
    path.join(tools, "gold.json"),
    JSON.stringify([{ id: "t", prompt: "do it", text: "gold text" }]),
  );
  // The parent's database and run settings never reach the scripts under test
  const parent = ["SPHICA_DB", "SPHICA_HOME", "EVAL_RUN_DIR", "EVAL_SPHICA_DB"];
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !parent.includes(k)));
  return { root, tools, tmp, env: { ...env, TMPDIR: tmp } };
}

const printDb = ["-e", "process.stdout.write(process.env.SPHICA_DB)"];

test("sphica.sh copies the fixture to the path a local runner names", (t) => {
  const s = slot(t);
  const copy = path.join(s.root, "run", "db", "sphica.db");
  const out = execFileSync("sh", [path.join(s.tools, "sphica.sh"), ...printDb], {
    env: { ...s.env, EVAL_SPHICA_DB: copy },
    encoding: "utf8",
  });
  assert.equal(out, copy);
  assert.equal(fs.readFileSync(copy, "utf8"), "fixture bytes");
  assert.equal(fs.existsSync(path.join(s.tmp, "eval-sphica")), false);
});

test("sphica.sh keys the copy by the fixture under TMPDIR when no path is named", (t) => {
  const s = slot(t);
  const out = execFileSync("sh", [path.join(s.tools, "sphica.sh"), ...printDb], {
    env: s.env,
    encoding: "utf8",
  });
  assert.equal(out, path.join(s.tmp, "eval-sphica", "abc123", "sphica.db"));
  assert.equal(fs.readFileSync(out, "utf8"), "fixture bytes");
});

test("hook.sh and gold.sh keep receipts and the gold marker in the run directory a local runner names", (t) => {
  const s = slot(t);
  const run = path.join(s.root, "run");
  fs.mkdirSync(run);
  const env = { ...s.env, EVAL_RUN_DIR: run };
  const input = JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "please do it now" });
  const first = execFileSync(
    "sh",
    [path.join(s.tools, "hook.sh"), "gold", "sh", path.join(s.tools, "gold.sh")],
    {
      env,
      input,
      encoding: "utf8",
    },
  );
  assert.match(first, /gold text/);
  // Given once per run: the marker in the run directory stops the second prompt
  const second = execFileSync(
    "sh",
    [path.join(s.tools, "hook.sh"), "gold", "sh", path.join(s.tools, "gold.sh")],
    {
      env,
      input,
      encoding: "utf8",
    },
  );
  assert.equal(second, "");
  assert.equal(fs.existsSync(path.join(run, "eval-gold-given")), true);
  const receipts = fs.readFileSync(path.join(run, "eval-receipts.jsonl"), "utf8").trim().split("\n");
  assert.equal(receipts.length, 2);
  assert.equal(fs.existsSync(path.join(s.tmp, "eval-receipts.jsonl")), false);
  assert.equal(fs.existsSync(path.join(s.tmp, "eval-gold-given")), false);
});

test("hook.sh falls back to TMPDIR for receipts on the cloud VM", (t) => {
  const s = slot(t);
  execFileSync("sh", [path.join(s.tools, "hook.sh"), "start"], {
    env: s.env,
    input: JSON.stringify({ hook_event_name: "SessionStart" }),
  });
  assert.equal(fs.existsSync(path.join(s.tmp, "eval-receipts.jsonl")), true);
});

test("a task's runs set its tries per condition, and the build's runs cover the rest", () => {
  const rows = planRows(
    "b",
    "original",
    [{ id: "t", prompt: "p", conditions: ["none", "inject", "gold"], runs: { inject: 5, gold: 3 } }],
    2,
    (c) => c,
  );
  assert.deepEqual(
    ["none", "inject", "gold"].map((c) => rows.filter((r) => r.condition === c).length),
    [2, 5, 3],
  );
});

test("gold.sh keeps its marker under TMPDIR on the cloud VM, and session start clears it", (t) => {
  const s = slot(t);
  const gold = () =>
    execFileSync("sh", [path.join(s.tools, "hook.sh"), "gold", "sh", path.join(s.tools, "gold.sh")], {
      env: s.env,
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "please do it now" }),
      encoding: "utf8",
    });
  assert.match(gold(), /gold text/);
  assert.equal(fs.existsSync(path.join(s.tmp, "eval-gold-given")), true);
  assert.equal(gold(), "");
  execFileSync("sh", [path.join(s.tools, "hook.sh"), "start"], {
    env: s.env,
    input: JSON.stringify({ hook_event_name: "SessionStart" }),
  });
  assert.match(gold(), /gold text/);
});
