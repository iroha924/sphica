// One evaluation run with Codex on this machine (plan step 9, the second model under test). Each run gets a fresh clone of the condition's
// bootstrap repository, a temporary HOME, and a CODEX_HOME holding only a link to the owner's auth.json plus the model settings, so the
// owner's rules, memories, and MCP servers never reach it. The cost comes from the owner's ChatGPT plan, not the cloud credits.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openReader } from "../../src/db.ts";
import { DENY_DIRS, DENY_FILES } from "./claude-run.ts";
import {
  checkoutGit,
  claimRunDir,
  codexLock,
  codexModelOf,
  evalCache,
  fenceDigest,
  fencedCodexHome,
  pinCheckout,
  requireInside,
} from "./codex-home.ts";

const HERE = import.meta.dirname;
/** The evaluations: tasks with their gold, hidden tests, fixtures */
export const EVALS = fs.realpathSync(path.resolve(HERE, ".."));

/**
 * What no fenced Codex may read, whatever it runs: the owner's credentials (Codex's login among them), the evaluations, and every
 * evaluation output (builds, other runs, logs). Each run works in a temp tree outside all of them.
 */
export function codexDenies(cache: string): string[] {
  return [EVALS, cache, ...DENY_DIRS, ...DENY_FILES];
}

/** The fence as one digest that names each place by its role, comparable across machines and runs */
export function codexFence(profile: string, cache: string, codexHome: string): string {
  return fenceDigest(profile, {
    "<codex-home>": codexHome,
    "<evals>": EVALS,
    "<cache>": cache,
    "<home>": os.homedir(),
  });
}

const inside = (root: string, p: string) => {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** A temp tree for what the model must reach; under a denied parent it would be unreadable, so that refuses to start */
export function outsideTree(prefix: string, denied: string[]): string {
  const tree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const under = denied.find((d) => inside(d, tree));
  if (under) {
    fs.rmSync(tree, { recursive: true, force: true });
    throw new Error(`the temp directory ${tree} is under ${under}, which the fence denies`);
  }
  return tree;
}

export async function runCodex(o: {
  build: string;
  buildId: string | undefined;
  owner: string;
  repo: string;
  condition: string;
  task: { id: string; prompt: string };
  out: string;
  /** The delivery matcher the build recorded for Codex, so old and new builds deliver on the tools each was built with */
  codexMatcher: string | undefined;
}): Promise<{ dir: string; result: Record<string, unknown> }> {
  const cache = evalCache();
  const build = requireInside(cache, o.build, "--build");
  fs.mkdirSync(o.out, { recursive: true });
  const out = requireInside(cache, o.out, "--out");
  const release = codexLock(cache);
  try {
    return await fencedRun({ ...o, build, out }, cache);
  } finally {
    release();
  }
}

async function fencedRun(
  o: Parameters<typeof runCodex>[0],
  cache: string,
): Promise<{ dir: string; result: Record<string, unknown> }> {
  const { run, dir } = claimRunDir(o.out, `${o.task.id}-${o.condition}`);
  const codexHome = path.join(dir, "codex-home");
  const db = path.join(dir, "db", "sphica.db");
  const denies = codexDenies(cache);
  const tree = outsideTree("sphica-codex-", denies);
  const work = path.join(tree, "work");
  const home = path.join(tree, "home");
  const tmp = path.join(tree, "tmp");
  for (const d of [home, codexHome, tmp]) fs.mkdirSync(d, { recursive: true });
  // The run counts from here: collect takes started.json as the denominator, and result.json is written whatever happens below
  fs.writeFileSync(
    path.join(dir, "started.json"),
    `${JSON.stringify({ run, build: o.buildId, model: "codex", repo: o.repo, condition: o.condition, task: o.task.id, at: new Date().toISOString() }, null, 2)}\n`,
  );
  const started = Date.now();
  const result: Record<string, unknown> = {
    run,
    build: o.buildId,
    model: "codex",
    repo: o.repo,
    condition: o.condition,
    task: o.task.id,
    status: null,
    reason: null,
  };
  try {
    execFileSync("git", ["clone", "-q", path.join(o.build, o.repo), work]);
    // Sphica identifies the project by origin, so the clone points where the cloud checkout does
    execFileSync("git", [
      "-C",
      work,
      "remote",
      "set-url",
      "origin",
      `https://github.com/${o.owner}/${o.repo}.git`,
    ]);
    // Hooks run without a trust prompt, so they run from a copy outside the checkout the agent can write (it could rewrite .tools)
    const tools = path.join(dir, "tools");
    fs.cpSync(path.join(work, ".tools"), tools, { recursive: true });
    // The patch is read through a git directory Codex cannot write, so the checkout's own .git config never runs here
    const checkout = pinCheckout(work, path.join(dir, "git"));
    const mcp =
      o.condition === "search" || o.condition === "inject"
        ? `\n[mcp_servers.sphica]\ncommand = "sh"\nargs = [${JSON.stringify(path.join(tools, "sphica.sh"))}, ${JSON.stringify(path.join(tools, "dist", "mcp.js"))}]\nenv = { TMPDIR = ${JSON.stringify(tmp)}, EVAL_SPHICA_DB = ${JSON.stringify(db)} }\n`
        : "";
    const fence = fencedCodexHome(codexHome, { base: ":workspace", deny: denies, extraConfig: mcp });
    result.fence = codexFence(fence.profile, cache, codexHome);
    result.fence_roots = fence.denied;
    // Recorded so a comparison can refuse two builds run by different Codex models
    result.codex_model = codexModelOf(codexHome);

    // Inject runs the shipped delivery hooks against the slot's database copy; gold goes through a prompt hook too, so both arrive as the
    // developer context a plugin hook gives (plugin/hooks/codex.json), not as part of the prompt
    const matcherOf = () => {
      if (!o.codexMatcher) throw new Error(`${o.build} records no Codex delivery matcher; build it again`);
      return o.codexMatcher;
    };
    const hook = (args: string[], timeout: number) => ({
      hooks: [{ type: "command", command: args.map((a) => JSON.stringify(a)).join(" "), timeout }],
    });
    const deliver = ["sh", path.join(tools, "sphica.sh"), path.join(tools, "dist", "deliver.js"), "codex"];
    const hooks =
      o.condition === "inject"
        ? {
            SessionStart: [hook(deliver, 10)],
            UserPromptSubmit: [hook(deliver, 10)],
            PreToolUse: [{ matcher: matcherOf(), ...hook(deliver, 10) }],
          }
        : o.condition === "gold"
          ? { UserPromptSubmit: [hook(["sh", path.join(dir, "gold-hook.sh")], 10)] }
          : null;
    // The gold record arrives as hook context, not as a delivery row: keep what the hook returned as the run's receipt
    if (o.condition === "gold")
      fs.writeFileSync(
        path.join(dir, "gold-hook.sh"),
        `out=$(sh ${JSON.stringify(path.join(tools, "gold.sh"))})\ncode=$?\nprintf '%s' "$out" >> ${JSON.stringify(path.join(dir, "gold-receipt.txt"))}\nprintf '%s' "$out"\nexit $code\n`,
      );
    if (hooks)
      fs.writeFileSync(path.join(codexHome, "hooks.json"), `${JSON.stringify({ hooks }, null, 2)}\n`);

    const r = spawnSync(
      "codex",
      [
        "exec",
        "--json",
        // Only the hooks written above, which this script vets, are in this CODEX_HOME
        ...(hooks ? ["--dangerously-bypass-hook-trust"] : []),
        "--ignore-rules",
        "-C",
        work,
        // The final answer comes back in a fixed shape (implemented, past decisions, unverified); collect checks it
        "--output-schema",
        path.join(HERE, "answer.schema.json"),
        "-o",
        path.join(dir, "answer.json"),
        "-",
      ],
      {
        input: o.task.prompt,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          CODEX_HOME: codexHome,
          TMPDIR: tmp,
          LANG: process.env.LANG ?? "",
          // The hooks read the run's database copy under the denied run directory, never in the temp the model writes
          EVAL_SPHICA_DB: db,
        },
        encoding: "utf8",
        timeout: 30 * 60_000,
        maxBuffer: 256 * 1024 * 1024,
      },
    );
    // Recorded now, so a failure in what follows still leaves Codex's own exit in result.json
    result.status = r.status;
    fs.writeFileSync(path.join(dir, "events.jsonl"), r.stdout ?? "");
    fs.writeFileSync(path.join(dir, "stderr.log"), r.stderr ?? "");
    checkoutGit(checkout, ["add", "-A"]);
    const patch = checkoutGit(checkout, ["diff", "--cached", "HEAD", "--", ".", ":!.tools", ":!.eval"]);
    fs.writeFileSync(path.join(dir, "patch.diff"), patch);
    const calls = (r.stdout ?? "").split("\n").flatMap((l) => {
      try {
        // Each call appears as item.started and item.completed; count the start only
        const e = JSON.parse(l) as {
          type?: string;
          item?: { type?: string; server?: string; tool?: string };
        };
        return e.type === "item.started" && e.item?.type === "mcp_tool_call"
          ? [`${e.item.server}.${e.item.tool}`]
          : [];
      } catch {
        return [];
      }
    });
    // What the delivery hooks logged, from the run's database copy
    let deliveries: { event: string; outcome: string; units: string[] }[] | null = null;
    if (o.condition === "inject") {
      const reader = openReader(db);
      try {
        const rows = await reader
          .selectFrom("delivery as d")
          .select(["d.id", "d.event", "d.outcome"])
          .orderBy("d.id")
          .execute();
        const units = await reader
          .selectFrom("delivery_unit as x")
          .innerJoin("unit as u", "u.id", "x.unit_id")
          .select(["x.delivery_id", "u.key"])
          .execute();
        deliveries = rows.map((d) => ({
          event: d.event,
          outcome: d.outcome,
          units: units.filter((u) => u.delivery_id === d.id).map((u) => u.key),
        }));
      } finally {
        await reader.destroy();
      }
    }
    Object.assign(result, {
      status: r.status,
      reason: r.status === 0 ? null : (r.error?.message ?? `codex exited ${r.status}`),
      mcp_calls: calls,
      deliveries,
    });
  } catch (e) {
    result.reason = (e as Error).message;
    throw e;
  } finally {
    // Back into the run directory, where collect and the hidden tests look and every later run is denied
    for (const d of ["work", "home", "tmp"])
      if (fs.existsSync(path.join(tree, d)))
        fs.cpSync(path.join(tree, d), path.join(dir, d), { recursive: true, verbatimSymlinks: true });
    fs.rmSync(tree, { recursive: true, force: true });
    result.seconds = Math.round((Date.now() - started) / 1000);
    fs.writeFileSync(path.join(dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  }
  return { dir, result };
}
