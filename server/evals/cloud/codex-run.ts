// One evaluation run with Codex on this machine (plan step 9, the second model under test). Each run gets a fresh clone of the condition's
// bootstrap repository, a temporary HOME, and a CODEX_HOME holding only a link to the owner's auth.json plus the model settings, so the
// owner's rules, memories, and MCP servers never reach it. The cost comes from the owner's ChatGPT plan, not the cloud credits.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openReader } from "../../src/db.ts";
import {
  checkoutGit,
  claimRunDir,
  codexLock,
  codexModelOf,
  codexOf,
  codexProfile,
  evalCache,
  fenceDigest,
  fencedCodexHome,
  type HomeFence,
  homeFence,
  isInside,
  pinCheckout,
  requireInside,
  volumeDenies,
} from "./codex-home.ts";

const HERE = import.meta.dirname;
/** The repository: the evaluations' tasks, gold, and hidden tests, in the working tree and in its git history alike */
export const REPO = fs.realpathSync(path.resolve(HERE, "..", "..", ".."));

/**
 * Every place that holds the repository's files or history: the repository, its other worktrees (an old/new comparison checks one out),
 * and the git directory they share, which sits outside a linked worktree. A place inside another is left to its parent's deny.
 */
/** Git's C-style quoted path (quote.c's unquote_c_style): a line it would read some other way stops the fence instead of passing it */
export function unquoteGit(quoted: string): string {
  const named: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  const bytes: number[] = [];
  let i = 1;
  for (; i < quoted.length && quoted[i] !== '"'; i++) {
    const c = quoted[i] ?? "";
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const next = quoted[++i] ?? "";
    const octal = /^[0-3][0-7]{2}$/.exec(quoted.slice(i, i + 3));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 2;
    } else if (next in named) bytes.push(named[next] as number);
    else throw new Error(`git alternates line not understood: ${quoted}`);
  }
  if (quoted[i] !== '"' || quoted.slice(i + 1).trim())
    throw new Error(`git alternates line not understood: ${quoted}`);
  return Buffer.from(bytes).toString("utf8");
}

export function repoPlaces(repo = REPO): string[] {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull },
    });
  // NUL-separated: a path may hold a line break
  const trees = git("worktree", "list", "--porcelain", "-z")
    .split("\0")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
  const common = path.resolve(repo, git("rev-parse", "--git-common-dir").trim());
  // Objects borrowed from elsewhere (alternates, and theirs in turn) hold the same history
  const borrowed: string[] = [];
  const follow = (objects: string) => {
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(path.join(objects, "info", "alternates"), "utf8").split("\n");
    } catch {
      return;
    }
    for (const line of lines.map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))) {
      const alt = path.resolve(objects, line.startsWith('"') ? unquoteGit(line) : line);
      if (!fs.existsSync(alt)) continue;
      const real = fs.realpathSync(alt);
      if (borrowed.includes(real)) continue;
      borrowed.push(real);
      follow(real);
    }
  };
  follow(path.join(common, "objects"));
  const places = [
    ...new Set(
      [repo, ...trees, common, ...borrowed].filter((p) => fs.existsSync(p)).map((p) => fs.realpathSync(p)),
    ),
  ];
  return places.filter((p) => !places.some((q) => q !== p && isInside(q, p)));
}

/** One shell word, quoted so nothing in it is expanded: a path may hold `$` or quotes */
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Where the repository lives and what HOME keeps: made once per run, and shared by its deny list, its PATH, and its fence */
export type Shield = { places: string[]; home: HomeFence; volumes?: string[]; temp?: string[] };

/**
 * The shared temp directories: anything else on this machine (the acceptance driver's worlds, a test's fixtures, other tools) may put
 * hidden material there, so they are denied whole and each run's own tree is read back
 */
export const tempRoots = (): string[] => [
  ...new Set(
    [os.tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp"])]
      .filter((d) => fs.existsSync(d))
      .map((d) => fs.realpathSync(d)),
  ),
];

export const shieldNow = (): Shield => ({
  places: repoPlaces(),
  home: homeFence(),
  volumes: volumeDenies(),
  temp: tempRoots(),
});

/** What the model may reach in its own temp tree: read all of it, and write only the checkout and TMPDIR where it may write at all */
export function treeAccess(
  base: ":read-only" | ":workspace",
  tree: string,
): { read: string[]; write: string[] } {
  return {
    read: [tree],
    write: base === ":workspace" ? [path.join(tree, "work"), path.join(tree, "tmp")] : [],
  };
}

/**
 * What no fenced Codex may read, whatever it runs: the repository wherever its files or history are, every evaluation output (builds,
 * other runs, logs), all of HOME but the tools' installs, and the shared temp directories. Each run works in its own temp tree, read back.
 */
export function codexDenies(cache: string, s: Shield = shieldNow()): string[] {
  return [...s.places, cache, ...s.home.denies, ...(s.volumes ?? []), ...(s.temp ?? [])];
}

/**
 * The fence as one digest that names each place by its role, comparable across machines and runs. Other worktrees count as the
 * repository; HOME is one denied line, and the roots read back under it are part of the profile, so another Node version is another fence.
 */
export function codexFence(
  profile: string,
  cache: string,
  codexHome: string,
  s: Shield = shieldNow(),
  /** More places named by role: the run's temp tree (`<tree>`) and a per-run copy read back (M2's Biome) are the same policy in every run */
  roles: Record<string, string> = {},
): string {
  const toml = (p: string) => JSON.stringify(p).slice(1, -1);
  let text = profile;
  for (const p of s.places.filter((p) => p !== REPO).sort((a, b) => b.length - a.length))
    text = text.split(toml(p)).join(toml(REPO));
  // Which mount roots exist differs by machine: they are one policy line
  for (const v of s.volumes ?? []) text = text.split(`${JSON.stringify(v)} = "deny"\n`).join("");
  const temp = Object.fromEntries((s.temp ?? []).map((t, i) => [`<temp-${i}>`, t]));
  return fenceDigest(
    text,
    { ...temp, ...roles, "<codex-home>": codexHome, "<repo>": REPO, "<cache>": cache, "<home>": s.home.home },
    (t) => [...new Set(t.split("\n")), "policy: volumes-denied"].join("\n"),
  );
}

/** The fence a fenced Codex started now records with this base: collect and grade count only what was made under it */
export function currentFence(
  base: ":read-only" | ":workspace",
  cache: string,
  s: Shield = shieldNow(),
): string {
  const codexHome = path.join(cache, "<run>", "codex-home");
  const tree = path.join(cache, "<run>", "tree");
  const access = treeAccess(base, tree);
  return codexFence(
    codexProfile(
      base,
      [...codexDenies(cache, s), path.join(codexHome, "auth.json")],
      [...s.home.roots, ...access.read],
      access.write,
    ),
    cache,
    codexHome,
    s,
    { "<tree>": tree },
  );
}

/** A temp tree for what the model must reach; under a denied place other than the temp directory it refuses to start */
export function outsideTree(prefix: string, denied: string[]): string {
  const tree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  // The shared temp directories are denied with the tree read back inside them
  const temp = tempRoots();
  const under = denied.filter((d) => !temp.includes(d)).find((d) => isInside(d, tree));
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
  /** A probe run: plants its files in the checkout before Codex starts and gives the prompt in place of the task's */
  probe?: (p: ProbePaths) => Promise<string>;
}): Promise<{ dir: string; result: Record<string, unknown> }> {
  // The task and condition name the run directory, and the repository the slot cloned from the build: anything but one plain name
  // could reach outside the output directory or the build
  for (const [what, name] of [
    ["task", o.task.id],
    ["condition", o.condition],
    ["repository", o.repo],
  ])
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name ?? ""))
      throw new Error(`the ${what} ${JSON.stringify(name)} is not one plain name`);
  const cache = evalCache();
  const build = requireInside(cache, o.build, "--build");
  // The slot itself, links followed: a slot that links to another build's would hand this run that build's material
  requireInside(build, path.join(build, o.repo), "the repository slot");
  // Checked before it is made: an --out outside the cache is refused without creating anything there
  const out = requireInside(cache, o.out, "--out");
  fs.mkdirSync(out, { recursive: true });
  const release = codexLock(cache);
  let tree = "";
  let run: Awaited<ReturnType<typeof fencedRun>>;
  try {
    const shield = shieldNow();
    tree = outsideTree("sphica-codex-", codexDenies(cache, shield));
    run = await fencedRun({ ...o, build, out }, cache, tree, shield);
  } finally {
    // A checkout left in the temp directory is readable to the next run: the lock stays until the owner clears it
    if (!tree || !fs.existsSync(tree)) release();
  }
  if (fs.existsSync(tree))
    throw new Error(
      `the run's files are still in ${tree}; move what is needed into ${run.dir}, remove the tree, then codex.lock in ${cache}`,
    );
  return run;
}

/** Where a run's pieces are while it runs: its directory, the checkout in the temp tree, the tools copy, and its database */
export type ProbePaths = { dir: string; work: string; tools: string; db: string; home: HomeFence };

async function fencedRun(
  o: Parameters<typeof runCodex>[0],
  cache: string,
  tree: string,
  shield: Shield,
): Promise<{ dir: string; result: Record<string, unknown> }> {
  const { run, dir } = claimRunDir(o.out, `${o.task.id}-${o.condition}`);
  requireInside(o.out, dir, "the run directory");
  const codexHome = path.join(dir, "codex-home");
  const db = path.join(dir, "db", "sphica.db");
  const denies = codexDenies(cache, shield);
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
    const prompt = o.probe ? await o.probe({ dir, work, tools, db, home: shield.home }) : o.task.prompt;
    const mcp =
      o.condition === "search" || o.condition === "inject"
        ? `\n[mcp_servers.sphica]\ncommand = "/bin/sh"\nargs = [${JSON.stringify(path.join(tools, "sphica.sh"))}, ${JSON.stringify(path.join(tools, "dist", "mcp.js"))}]\nenv = { TMPDIR = ${JSON.stringify(tmp)}, EVAL_SPHICA_DB = ${JSON.stringify(db)} }\n`
        : "";
    const access = treeAccess(":workspace", tree);
    const fence = fencedCodexHome(codexHome, {
      base: ":workspace",
      deny: denies,
      read: [...shield.home.roots, ...access.read],
      write: access.write,
      extraConfig: mcp,
    });
    result.fence = codexFence(fence.profile, cache, codexHome, shield, { "<tree>": tree });
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
      hooks: [{ type: "command", command: args.map(shellQuote).join(" "), timeout }],
    });
    // An absolute shell: the PATH the hooks inherit is the fenced Codex's
    const deliver = [
      "/bin/sh",
      path.join(tools, "sphica.sh"),
      path.join(tools, "dist", "deliver.js"),
      "codex",
    ];
    const hooks =
      o.condition === "inject"
        ? {
            SessionStart: [hook(deliver, 10)],
            UserPromptSubmit: [hook(deliver, 10)],
            PreToolUse: [{ matcher: matcherOf(), ...hook(deliver, 10) }],
          }
        : o.condition === "gold"
          ? { UserPromptSubmit: [hook(["/bin/sh", path.join(dir, "gold-hook.sh")], 10)] }
          : null;
    // The gold record arrives as hook context, not as a delivery row: keep what the hook returned as the run's receipt
    if (o.condition === "gold")
      fs.writeFileSync(
        path.join(dir, "gold-hook.sh"),
        `out=$(/bin/sh ${shellQuote(path.join(tools, "gold.sh"))})\ncode=$?\nprintf '%s' "$out" >> ${shellQuote(path.join(dir, "gold-receipt.txt"))}\nprintf '%s' "$out"\nexit $code\n`,
      );
    if (hooks)
      fs.writeFileSync(path.join(codexHome, "hooks.json"), `${JSON.stringify({ hooks }, null, 2)}\n`);

    const r = spawnSync(
      codexOf(shield.home),
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
        input: prompt,
        env: {
          // The tools' directories and what lies outside HOME: a PATH entry under HOME would point into what is denied
          PATH: shield.home.path,
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
    const back = bringBack(tree, dir);
    if (back.error) result.reason ??= `could not move the run's files back: ${back.error}`;
    result.seconds = Math.round((Date.now() - started) / 1000);
    fs.writeFileSync(path.join(dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  }
  return { dir, result };
}

/** Gives the owner back read and write on everything under `p`: a directory the run made unreadable would stop the copy and the removal */
function openUp(p: string): void {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return;
  fs.chmodSync(p, st.mode | (st.isDirectory() ? 0o700 : 0o600));
  if (st.isDirectory()) for (const name of fs.readdirSync(p)) openUp(path.join(p, name));
}

/** Points each absolute link under `p` that targets the temp tree at the same place under the run directory */
function retarget(p: string, tree: string, dir: string): void {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) {
    const target = fs.readlinkSync(p);
    if (path.isAbsolute(target) && isInside(tree, target)) {
      fs.unlinkSync(p);
      fs.symlinkSync(path.join(dir, path.relative(tree, target)), p);
    }
  } else if (st.isDirectory()) for (const name of fs.readdirSync(p)) retarget(path.join(p, name), tree, dir);
}

/**
 * Moves work, home, and tmp back into the run directory, where collect and the hidden tests look and every later run is denied. The temp
 * tree is removed only once every copy succeeded: otherwise it is the only whole copy of the run, and it stays (with the lock) for the owner.
 */
function bringBack(tree: string, dir: string): { error: string | null } {
  try {
    openUp(tree);
    for (const d of ["work", "home", "tmp"]) {
      if (!fs.existsSync(path.join(tree, d))) continue;
      fs.cpSync(path.join(tree, d), path.join(dir, d), { recursive: true, verbatimSymlinks: true });
      retarget(path.join(dir, d), tree, dir);
    }
  } catch (e) {
    return { error: (e as Error).message };
  }
  try {
    fs.rmSync(tree, { recursive: true, force: true });
    return { error: null };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
