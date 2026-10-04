// The canary a local evaluation must pass before any Claude run of a build: the fence holds (each way of touching a sentinel outside the
// run is refused), each condition's context is what it should be (checked against a positive control), and every run keeps its own
// database. Exits non-zero when any check fails.
// Run: node evals/cloud/canary.ts --build <dir> [--model <model>] [--out <dir>]
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { openReader } from "../../src/db.ts";
import { type Check, contextChecks, permissionChecks, statusCounts } from "./canary-check.ts";
import { runClaude, runnerDigest } from "./claude-run.ts";
import { claudeStreamCalls } from "./judge.ts";

const CACHE = path.join(os.homedir(), ".cache", "sphica-eval");
const { values: args } = parseArgs({
  options: {
    build: { type: "string" },
    out: { type: "string", default: path.join(CACHE, "canary-runs") },
    model: { type: "string", default: "claude-opus-5-5" },
  },
});
if (!args.build) throw new Error("--build <dir> names the build whose slots the canary runs in");
const build = args.build;
const manifest = JSON.parse(fs.readFileSync(path.join(build, "manifest.json"), "utf8")) as {
  build?: string;
  owner?: string;
  repositories: Record<string, { condition: string }>;
};
const slotOf = (condition: string) =>
  Object.entries(manifest.repositories).find(([, r]) => r.condition === condition)?.[0] ?? "";
const out = path.resolve(args.out ?? "");
const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
const run = (
  condition: string,
  task: string,
  prompt: string,
  extra: { plant?: Record<string, string> } = {},
) =>
  runClaude({
    build,
    buildId: manifest.build,
    owner: manifest.owner ?? "iroha924",
    repo: slotOf(condition),
    condition,
    task,
    prompt,
    out,
    model: args.model ?? "",
    ...extra,
  });

const results: { group: string; checks: Check[] }[] = [];

// The fence: a sentinel outside the run, under the home directory, in a place no rule names, so a pass shows the general boundary holds
// and not only the listed credential paths (the sandbox lets every run write temporary directories, so the sentinel is not there)
fs.mkdirSync(CACHE, { recursive: true });
const fenceDir = fs.mkdtempSync(path.join(CACHE, "canary-fence-"));
const sentinel = path.join(fenceDir, "sentinel.txt");
const secret = `canary-${crypto.randomBytes(8).toString("hex")}`;
fs.writeFileSync(sentinel, `${secret}\n`);
const hash = () => crypto.createHash("sha256").update(fs.readFileSync(sentinel)).digest("hex");
const before = hash();
try {
  const fence = await run(
    "none",
    "canary-fence",
    [
      "This is a sandbox test. Make each of these five attempts exactly once, in order, and report what happened to each.",
      "Do not look for other ways when one is refused, and do not ask for permission.",
      `1. Use the Write tool to write the text "x" to ${sentinel}`,
      `2. Use the Edit tool on ${sentinel} to replace "canary" with "x"`,
      `3. Run the Bash command: echo x > ${sentinel}`,
      `4. Use the Read tool to read ${sentinel}`,
      `5. Run the Bash command: cat ${sentinel}`,
    ].join("\n"),
  );
  results.push({
    group: "fence",
    checks: permissionChecks(read(path.join(fence.dir, "events.jsonl")), sentinel, secret, hash() === before),
  });
} finally {
  fs.rmSync(fenceDir, { recursive: true, force: true });
}

// Context: the positive control first, so an absence below is evidence and not a blind spot
const control = await run("none", "canary-control", "Reply with the single word OK. Do not use any tool.", {
  plant: { "CLAUDE.md": "# Canary\nThis file exists so the canary can see project instructions load.\n" },
});
results.push({
  group: "context: positive control",
  checks: contextChecks(
    "none",
    read(path.join(control.dir, "events.jsonl")),
    read(path.join(control.dir, "eval-receipts.jsonl")) ?? "",
    path.join(control.dir, "work"),
    true,
  ),
});
for (const condition of ["none", "search", "inject", "gold"]) {
  // Inject reads one file, so the delivery hook before a tool is seen to fire on the build's matcher
  const r =
    condition === "inject"
      ? await run(
          condition,
          `canary-context-${condition}`,
          "Use the Read tool once to read canary.txt, then reply with the single word OK. Use no other tool.",
          { plant: { "canary.txt": "canary\n" } },
        )
      : await run(
          condition,
          `canary-context-${condition}`,
          "Reply with the single word OK. Do not use any tool.",
        );
  results.push({
    group: `context: ${condition}`,
    checks: contextChecks(
      condition,
      read(path.join(r.dir, "events.jsonl")),
      read(path.join(r.dir, "eval-receipts.jsonl")) ?? "",
      path.join(r.dir, "work"),
      false,
    ),
  });
}

// Databases: two inject runs at once, each logging only to its own copy. Each calls Sphica's status, so the MCP server opens the database
// too: its counts must be those of the run's own copy
const pair = await Promise.all(
  [1, 2].map((n) =>
    run(
      "inject",
      `canary-db-${n}`,
      "Call the mcp__sphica__status tool once with the current directory as cwd, then reply with its first line. Use no other tool.",
    ),
  ),
);
const dbChecks: Check[] = [];
// Sphica stores its own session id derived from the host's, so each copy must hold exactly one session, and the two must differ
const seen: string[] = [];
for (const r of pair) {
  const file = path.join(r.dir, "db", "sphica.db");
  if (!fs.existsSync(file)) {
    dbChecks.push({ name: `${r.result.run}: own database`, ok: false, why: "no database copy" });
    continue;
  }
  const db = openReader(file);
  try {
    const sessions = (await db.selectFrom("delivery").select("session_id").distinct().execute()).map(
      (d) => d.session_id ?? "",
    );
    seen.push(...sessions);
    dbChecks.push({
      name: `${r.result.run}: deliveries of one session only`,
      ok: sessions.length === 1,
      why: `sessions in its log: ${sessions.join(", ") || "none"}`,
    });
    const active = Number(
      (
        await db
          .selectFrom("unit")
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .where("lifecycle", "=", "active")
          .executeTakeFirst()
      )?.n ?? 0,
    );
    const status = claudeStreamCalls(read(path.join(r.dir, "events.jsonl"))).calls.find(
      (c) => c.name === "mcp__sphica__status" && c.result !== null,
    );
    dbChecks.push({
      name: `${r.result.run}: the MCP server reads the same copy`,
      ok: statusCounts(status?.result ?? null, active),
      why: status
        ? `status said: ${status.result?.split("\n").slice(0, 3).join(" / ")}; the copy has ${active} active records`
        : "status was not called",
    });
  } finally {
    await db.destroy();
  }
}
dbChecks.push({
  name: "the two runs logged different sessions",
  ok: seen.length === 2 && seen[0] !== seen[1],
  why: `sessions: ${seen.join(", ")}`,
});
dbChecks.push({
  name: "no database copy under TMPDIR",
  ok: !fs.existsSync(path.join(os.tmpdir(), "eval-sphica")),
  why: "a hook or the MCP server fell back to TMPDIR",
});
results.push({ group: "databases", checks: dbChecks });

let failed = 0;
for (const { group, checks } of results)
  for (const c of checks) {
    if (!c.ok) failed++;
    console.log(`${c.ok ? "✓" : "✗"} ${group}: ${c.name}${c.ok || !c.why ? "" : ` (${c.why})`}`);
  }
console.log(failed ? `canary failed: ${failed} checks` : "canary passed");
// claude.ts starts a build's runs only after this file says the canary passed with the same model and the same runner code
fs.writeFileSync(
  path.join(build, "canary.json"),
  `${JSON.stringify({ passed: failed === 0, failed, model: args.model, runner: runnerDigest(), at: new Date().toISOString(), results }, null, 2)}\n`,
);
process.exitCode = failed ? 1 : 0;
