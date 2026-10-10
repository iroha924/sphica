// Does the shipped deliver.js bring a record in after a real shell command changed its file, and only then? Each case runs a fixed
// command between the hook's Pre and Post, in fresh processes, in the input shapes of both hosts, against a temporary checkout and
// database. It checks hook output only: whether the host put that output before its next model request is the real-host check's job.
// node server/evals/post-write/shell-write-harness.ts [--plugin <package dir>] [--compare <git ref> | --no-compare]
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { inTransaction } from "../../src/db.ts";
import { checkRecord, saveRecord, type Target } from "../../src/record.ts";
import { openRun } from "../../src/trace.ts";
import { message, project, type TempDb, tempDb } from "../../test/temp-db.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const LEAD = "files whose content changed between before and after this call";
const KEY_RE = /trace:ext-b\d+\/f[\w-]+/g;
const PER_SAVE = 50;
const windows = process.platform === "win32";

type Kind = "positive" | "negative" | "separate" | "limit";
type Shell = "sh" | "powershell";
type Ctx = { repo: string; py: string; biome: string };

export type Case = {
  id: string;
  kind: Kind;
  shell: Shell;
  what: string;
  /** The anchored files this case is about, written with their base content before the call (absent ones are removed) */
  files: string[];
  /** Files left absent before the call (a create) */
  absent?: string[];
  /** Records whose delivery a positive expects; the case's files when unset */
  expect?: string[];
  /** Extra setup after the base content (a helper script, a dirty file) */
  setup?: (c: Ctx) => void;
  command: (c: Ctx) => string;
};

const BASE = (rel: string) => `// ${rel}\nexport const value = 1;\n`;
const helper = (c: Ctx, rel: string, text: string) => {
  fs.mkdirSync(path.join(c.repo, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(c.repo, rel), text);
};
// A node script that appends to a file whose name it builds, so the command never names it
const gen = (c: Ctx, rel: string, target: string) =>
  helper(
    c,
    rel,
    `require("fs").appendFileSync(${JSON.stringify(target.split("/"))}.join("/"), "// gen\\n");\n`,
  );

const sh = (
  id: string,
  what: string,
  files: string[],
  command: Case["command"],
  extra: Partial<Case> = {},
): Case => ({
  id,
  kind: "positive",
  shell: "sh",
  what,
  files,
  command,
  ...extra,
});

/** 40 shell writes of different shapes, each changing an anchored file */
const POSITIVES: Case[] = [
  sh(
    "p01",
    "python write-back",
    ["src/p01.ts"],
    (c) =>
      `${c.py} -c "import pathlib; p = pathlib.Path('src/p01.ts'); p.write_text(p.read_text() + 'x = 1\\n')"`,
  ),
  sh(
    "p02",
    "sed -i",
    ["src/p02.ts"],
    () => "sed -i.bak 's/value = 1/value = 2/' src/p02.ts && rm src/p02.ts.bak",
  ),
  sh("p03", "perl -i", ["src/p03.ts"], () => "perl -pi -e 's/value = 1/value = 3/' src/p03.ts"),
  sh("p04", "append redirect", ["src/p04.ts"], () => "echo '// more' >> src/p04.ts"),
  sh("p05", "overwrite redirect", ["src/p05.ts"], () => "echo 'export {};' > src/p05.ts"),
  sh("p06", "tee", ["src/p06.ts"], () => "printf 'export {};\\n' | tee src/p06.ts > /dev/null"),
  sh("p07", "tee -a", ["src/p07.ts"], () => "printf '// more\\n' | tee -a src/p07.ts > /dev/null"),
  sh("p08", "cat heredoc", ["src/p08.ts"], () => "cat > src/p08.ts <<'EOF'\nexport const value = 8;\nEOF"),
  sh(
    "p09",
    "cp from its own temp file",
    ["src/p09.ts"],
    () => "printf 'export const v = 9;\\n' > .tmp09 && cp .tmp09 src/p09.ts && rm .tmp09",
  ),
  sh(
    "p10",
    "mv from its own temp file (atomic replace)",
    ["src/p10.ts"],
    () => "printf 'export const v = 10;\\n' > .tmp10 && mv .tmp10 src/p10.ts",
  ),
  sh("p11", "generator script that names no file", ["src/p11.ts"], () => "node tools/gen11.cjs", {
    setup: (c) => gen(c, "tools/gen11.cjs", "src/p11.ts"),
  }),
  sh("p12", "cd, then a relative path", ["src/p12.ts"], () => "cd src && echo '// more' >> p12.ts"),
  sh("p13", "write, then exit non-zero", ["src/p13.ts"], () => "echo '// more' >> src/p13.ts; exit 3"),
  sh("p14", "create", ["src/p14.ts"], () => "printf 'export const v = 14;\\n' > src/p14.ts", {
    absent: ["src/p14.ts"],
  }),
  sh("p15", "delete", ["src/p15.ts"], () => "rm src/p15.ts"),
  sh(
    "p16",
    "same size, other content, mtime put back",
    ["src/p16.ts"],
    () =>
      `node -e "const fs=require('fs');const f='src/p16.ts';const s=fs.statSync(f);fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace('value = 1','value = 7'));fs.utimesSync(f,s.atime,s.mtime)"`,
  ),
  sh("p17", "shell script that names no file", ["src/p17.ts"], () => "sh tools/gen17.sh", {
    setup: (c) => helper(c, "tools/gen17.sh", 'd=src; f=p17; echo "// gen" >> "$d/$f.ts"\n'),
  }),
  sh(
    "p18",
    "awk to a temp file, then mv",
    ["src/p18.ts"],
    () => "awk '{print} END {print \"// awk\"}' src/p18.ts > .tmp18 && mv .tmp18 src/p18.ts",
  ),
  sh("p19", "truncate by redirect", ["src/p19.ts"], () => ": > src/p19.ts"),
  sh("p20", "git apply", ["src/p20.ts"], () => "git apply tools/p20.patch", {
    setup: (c) =>
      helper(
        c,
        "tools/p20.patch",
        "--- a/src/p20.ts\n+++ b/src/p20.ts\n@@ -1,2 +1,2 @@\n // src/p20.ts\n-export const value = 1;\n+export const value = 20;\n",
      ),
  }),
  sh(
    "p21",
    "inline node",
    ["src/p21.ts"],
    () => `node -e "require('fs').appendFileSync('src/p21.ts', '// node\\n')"`,
  ),
  sh("p22", "python script that names no file", ["src/p22.ts"], (c) => `${c.py} tools/gen22.py`, {
    setup: (c) =>
      helper(c, "tools/gen22.py", 'p = "/".join(["src", "p22.ts"])\nopen(p, "a").write("# gen\\n")\n'),
  }),
  sh("p23", "xargs", ["src/p23.ts"], () => "echo src/p23.ts | xargs -I{} sh -c 'echo \"// x\" >> {}'"),
  sh(
    "p24",
    "find -exec",
    ["src/p24.ts"],
    () => "find src -name 'p24.ts' -exec sh -c 'echo \"// f\" >> \"$1\"' _ {} \\;",
  ),
  sh("p25", "a path in a variable", ["src/p25.ts"], () => 'd=src; n=p25; echo "// v" >> "$d/$n.ts"'),
  sh("p26", "a glob", ["src/p26-one.ts"], () => 'for f in src/p26-*.ts; do echo "// g" >> "$f"; done'),
  sh(
    "p27",
    "subshell in a deep directory",
    ["lib/deep/p27.ts"],
    () => "(cd lib/deep && echo '// s' >> p27.ts)",
  ),
  sh("p28", "background job it waits for", ["src/p28.ts"], () => "(echo '// b' >> src/p28.ts) & wait"),
  sh("p29", "sort -o in place", ["src/p29.ts"], () => "sort src/p29.ts -o src/p29.ts"),
  sh(
    "p30",
    "sed -n to a temp file, then mv",
    ["src/p30.ts"],
    () => "sed -n '2p' src/p30.ts > .tmp30 && mv .tmp30 src/p30.ts",
  ),
  sh("p31", "cp over it from an unanchored file", ["src/p31.ts"], () => "cp src/plain.txt src/p31.ts"),
  sh("p32", "a name with a space", ["src/p 32.ts"], () => "echo '// sp' >> 'src/p 32.ts'"),
  sh("p33", "a Japanese name", ["src/日本語33.ts"], () => "echo '// ja' >> src/日本語33.ts"),
  sh(
    "p34",
    "two files in one call",
    ["src/p34a.ts", "src/p34b.ts"],
    () => "echo '// a' >> src/p34a.ts; echo '// b' >> src/p34b.ts",
  ),
  sh("p35", "write, then a failing command", ["src/p35.ts"], () => "echo '// f' >> src/p35.ts && false"),
  sh("p36", "node script that names no file", ["src/p36.ts"], () => "node tools/gen36.cjs", {
    setup: (c) => gen(c, "tools/gen36.cjs", "src/p36.ts"),
  }),
  sh("p37", "mv another file over it", ["src/p37.ts"], () => "mv src/other37.txt src/p37.ts", {
    setup: (c) => helper(c, "src/other37.txt", "export const v = 37;\n"),
  }),
  sh("p38", "python script that rewrites it whole", ["src/p38.ts"], (c) => `${c.py} tools/gen38.py`, {
    setup: (c) =>
      helper(
        c,
        "tools/gen38.py",
        'p = "src/" + "p38.ts"\nt = open(p).read().upper()\nopen(p, "w").write(t)\n',
      ),
  }),
  sh("p39", "perl -0 multi-line rewrite", ["src/p39.ts"], () => "perl -0pi -e 's/\\n/\\n\\n/g' src/p39.ts"),
  sh(
    "p40",
    "printf through a here-string",
    ["src/p40.ts"],
    () => "cat <<< 'export const v = 40;' > src/p40.ts",
  ),
];

/** On Windows, the same through PowerShell (Claude Code's PowerShell tool, and Codex's shell there) */
const PS_POSITIVES: Case[] = [
  ["w01", "Set-Content", "Set-Content -Path src/w01.ts -Value 'export const v = 1;'"],
  ["w02", "Add-Content", "Add-Content -Path src/w02.ts -Value '// more'"],
  ["w03", "Out-File", "'export const v = 3;' | Out-File -FilePath src/w03.ts -Encoding utf8"],
  [
    "w04",
    "WriteAllText",
    "[IO.File]::WriteAllText((Join-Path (Get-Location) 'src/w04.ts'), 'export const v = 4;')",
  ],
  ["w05", "Copy-Item over it", "Copy-Item src/plain.txt src/w05.ts -Force"],
  ["w06", "Move-Item over it", "Set-Content .tmpw06 'x'; Move-Item .tmpw06 src/w06.ts -Force"],
  ["w07", "Remove-Item", "Remove-Item src/w07.ts"],
  ["w08", "New-Item (create)", "New-Item -ItemType File -Path src/w08.ts -Value 'export {};' | Out-Null"],
].map(([id, what, command]) => ({
  id: String(id),
  kind: "positive" as const,
  shell: "powershell" as const,
  what: String(what),
  files: [`src/${id}.ts`],
  ...(id === "w08" ? { absent: ["src/w08.ts"] } : {}),
  command: () => String(command),
}));

const neg = (id: string, what: string, command: Case["command"], extra: Partial<Case> = {}): Case => ({
  id,
  kind: "negative",
  shell: "sh",
  what,
  files: [`src/${id}.ts`],
  command,
  ...extra,
});

/** Calls that change no anchored file's content: Post must add nothing */
const NEGATIVES: Case[] = [
  neg("n01", "cat", () => "cat src/n01.ts"),
  neg("n02", "grep", () => "grep -n value src/n02.ts"),
  neg("n03", "sed -n", () => "sed -n '1p' src/n03.ts"),
  neg("n04", "write a file with no record", () => "echo '// x' >> src/plain-n04.txt"),
  neg("n05", "do nothing", () => "true"),
  neg("n06", "chmod", () => "chmod +x src/n06.ts"),
  neg("n07", "touch", () => "touch src/n07.ts"),
  neg("n08", "utimes", () => `node -e "require('fs').utimesSync('src/n08.ts', new Date(0), new Date(0))"`),
  neg(
    "n09",
    "write the same content back",
    () => "cat src/n09.ts > .tmpn09 && cat .tmpn09 > src/n09.ts && rm .tmpn09",
  ),
  neg(
    "n10",
    "write, then put it back in the same call",
    () => "cp src/n10.ts .bakn10 && echo '// x' >> src/n10.ts && mv .bakn10 src/n10.ts",
  ),
];

/** Content changes the trial counts apart (git and formatters), and the plan's limits */
const SEPARATE: Case[] = [
  {
    id: "s01",
    kind: "separate",
    shell: "sh",
    what: "git checkout -- (puts back an uncommitted change)",
    files: ["src/s01.ts"],
    setup: (c) => fs.appendFileSync(path.join(c.repo, "src/s01.ts"), "// dirty\n"),
    command: () => "git checkout -- src/s01.ts",
  },
  {
    id: "s02",
    kind: "separate",
    shell: "sh",
    what: "git stash",
    files: ["src/s02.ts"],
    setup: (c) => fs.appendFileSync(path.join(c.repo, "src/s02.ts"), "// dirty\n"),
    command: () => "git stash -q && git stash drop -q",
  },
  {
    id: "s03",
    kind: "separate",
    shell: "sh",
    what: "git restore",
    files: ["src/s03.ts"],
    setup: (c) => fs.appendFileSync(path.join(c.repo, "src/s03.ts"), "// dirty\n"),
    command: () => "git restore src/s03.ts",
  },
  {
    id: "s04",
    kind: "separate",
    shell: "sh",
    what: "a formatter (Biome)",
    files: ["src/s04.ts"],
    setup: (c) => fs.writeFileSync(path.join(c.repo, "src/s04.ts"), "export   const value=1\n"),
    command: (c) => `node "${c.biome}" format --write src/s04.ts`,
  },
  {
    id: "l01",
    kind: "limit",
    shell: "sh",
    what: "a background write that lands after Post",
    files: ["src/l01.ts"],
    command: () => "(sleep 2; echo '// late' >> src/l01.ts) > /dev/null 2>&1 &",
  },
];

export const CASES: Case[] = [...POSITIVES, ...PS_POSITIVES, ...NEGATIVES, ...SEPARATE];

type Host = "claude-code" | "codex";

/** One case on one host with one bundle: what Pre and Post returned, and the trial log's line for the call */
export type Result = {
  case: string;
  kind: Kind;
  host: Host;
  plugin: string;
  session: string;
  exit: number | null;
  pre: string;
  post: string;
  /** Whether the bundle's hooks run anything after the call (an old one does not) */
  posted: boolean;
  trial?: {
    changed?: string[];
    unknown?: string[];
    delivered?: string[];
    logged?: boolean | null;
    event?: string;
  };
};

export const keysIn = (text: string) => [...new Set(text.match(KEY_RE) ?? [])];

/**
 * What is wrong with one result, or null. Post must see each anchored file a positive changed (whether or not Pre already showed its
 * record, which the conversation then does not get again) and bring in the records the call has not shown; a negative's files must not
 * count as changed, and Post must add nothing. Rows counted apart are only reported.
 */
export function judge(r: Result, expected: string[], files: string[]): string | null {
  const pre = keysIn(r.pre);
  const post = keysIn(r.post);
  const changed = r.trial?.changed ?? [];
  if (r.post && !r.post.includes(LEAD)) return "Post replied without the shell-write lead";
  if (r.kind === "positive") {
    if (r.posted && r.trial?.event !== "post_shell")
      return `no comparison logged (${r.trial?.event ?? "no trial line"})`;
    const unseen = r.posted ? files.filter((f) => !changed.includes(f)) : [];
    if (unseen.length) return `not seen as changed: ${unseen.join(", ")}`;
    const missing = expected.filter((k) => !pre.includes(k) && !post.includes(k));
    return missing.length ? `missing ${missing.join(", ")}` : null;
  }
  if (r.kind === "negative") {
    const moved = files.filter((f) => changed.includes(f));
    if (moved.length) return `seen as changed: ${moved.join(", ")}`;
    return post.length ? `Post added ${post.join(", ")}` : null;
  }
  return null;
}

/** Where a positive's records came in: "pre", "post", "both", or "-" */
export function via(r: Result, expected: string[]): string {
  const pre = expected.some((k) => keysIn(r.pre).includes(k));
  const post = expected.some((k) => keysIn(r.post).includes(k));
  return pre && post ? "both" : pre ? "pre" : post ? "post" : "-";
}

/** Each conversation's records shown more than once across its Pre and Post */
export function duplicates(results: Result[]): number {
  const seen = new Map<string, number>();
  for (const r of results)
    for (const k of [...keysIn(r.pre), ...keysIn(r.post)])
      seen.set(`${r.session}\0${k}`, (seen.get(`${r.session}\0${k}`) ?? 0) + 1);
  return [...seen.values()].filter((n) => n > 1).length;
}

export type Tally = {
  positive: { pass: number; total: number };
  negative: { pass: number; total: number };
  separate: { changed: number; delivered: number; total: number };
  limit: { changed: number; delivered: number; total: number };
  failures: string[];
};

export function tally(
  results: Result[],
  expectOf: (r: Result) => string[],
  filesOf: (r: Result) => string[],
): Tally {
  const t: Tally = {
    positive: { pass: 0, total: 0 },
    negative: { pass: 0, total: 0 },
    separate: { changed: 0, delivered: 0, total: 0 },
    limit: { changed: 0, delivered: 0, total: 0 },
    failures: [],
  };
  for (const r of results) {
    const problem = judge(r, expectOf(r), filesOf(r));
    if (r.kind === "positive" || r.kind === "negative") {
      t[r.kind].total++;
      if (problem) t.failures.push(`${r.case} ${r.host}: ${problem}`);
      else t[r.kind].pass++;
    } else {
      t[r.kind].total++;
      if (filesOf(r).some((f) => r.trial?.changed?.includes(f))) t[r.kind].changed++;
      if (keysIn(r.post).length) t[r.kind].delivered++;
      if (problem) t.failures.push(`${r.case} ${r.host}: ${problem}`);
    }
  }
  return t;
}

type Plugin = { name: string; dir: string; claude: Groups; codex: Groups };
type Groups = Record<string, { matcher?: string; hooks: { command: string; args?: string[] }[] }[]>;

function loadPlugin(name: string, dir: string): Plugin {
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, "hooks", f), "utf8")).hooks as Groups;
  return { name, dir, claude: read("hooks.json"), codex: read("codex.json") };
}

/** Whether the bundle's hooks run deliver.js for this event and tool, as each host matches its groups */
function delivers(p: Plugin, host: Host, event: string, tool: string): boolean {
  const groups = (host === "codex" ? p.codex : p.claude)[event] ?? [];
  return groups.some(
    (g) =>
      (!g.matcher ||
        (host === "codex" ? new RegExp(g.matcher) : new RegExp(`^(?:${g.matcher})$`)).test(tool)) &&
      g.hooks.some((h) => [h.command, ...(h.args ?? [])].some((a) => a.includes("dist/deliver.js"))),
  );
}

type Env = { home: string; db: string };

function hookEnv(e: Env, p: Plugin, host: Host): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env))
    if (!/^(SPHICA_|CODEX_|CLAUDE_)/.test(k) && k !== "HOME" && k !== "USERPROFILE") out[k] = v;
  return {
    ...out,
    HOME: e.home,
    USERPROFILE: e.home,
    SPHICA_HOME: path.join(e.home, ".sphica"),
    SPHICA_DB: e.db,
    ...(host === "codex"
      ? { PLUGIN_ROOT: p.dir, SPHICA_SHELL_WRITE_DELIVERY: "on" }
      : { CLAUDE_PLUGIN_ROOT: p.dir, CLAUDE_PLUGIN_OPTION_SHELL_WRITE_DELIVERY: "true" }),
  };
}

/** One hook call in a fresh process, as the host would start it; the additional context it returned */
function fire(
  e: Env,
  p: Plugin,
  host: Host,
  input: Record<string, unknown>,
): Promise<{ text: string; ms: number }> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const args = [path.join(p.dir, "dist", "deliver.js"), ...(host === "codex" ? ["codex"] : [])];
    const child = spawn(process.execPath, args, {
      cwd: String(input.cwd),
      env: hookEnv(e, p, host),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    // The host's own limit: a hook past it is killed, and that is a failure here
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const ms = performance.now() - start;
      if (signal || code !== 0)
        return reject(new Error(`${host} ${input.hook_event_name} exited ${code ?? signal}: ${err}`));
      try {
        resolve({
          text: out ? String(JSON.parse(out)?.hookSpecificOutput?.additionalContext ?? "") : "",
          ms,
        });
      } catch {
        reject(new Error(`${host} ${input.hook_event_name} printed something that is not JSON: ${out}`));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function runCommand(c: Ctx, shell: Shell, command: string, cwd = c.repo): number | null {
  const r =
    shell === "powershell"
      ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
          cwd,
          encoding: "utf8",
        })
      : spawnSync(bash(), ["-c", command], { cwd, encoding: "utf8" });
  if (r.error) throw r.error;
  return r.status;
}

/** Claude Code runs Bash through Git Bash on Windows */
const bash = () =>
  windows
    ? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
    : "/bin/bash";

/** A Python that runs, or a failure: a missing one must not quietly drop its cases */
function python(): string {
  for (const py of ["python3", "python"]) {
    const r = spawnSync(bash(), ["-c", `${py} -c "print(6 * 7)"`], { encoding: "utf8" });
    if (r.stdout?.trim() === "42") return py;
  }
  throw new Error("no python3 or python runs here");
}

type Trial = Record<string, unknown>;
function trialLines(home: string): Trial[] {
  const file = path.join(home, ".sphica", "shell-state", "trial.jsonl");
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Trial);
}

type Fixture = { env: Env; ctx: Ctx; db: TempDb; keys: Map<string, string> };

/** Saves one constraint anchored to each file, through the real check and save path */
async function seed(db: TempDb, projectId: number, files: string[]): Promise<Map<string, string>> {
  const keys = new Map<string, string>();
  for (let b = 0; b * PER_SAVE < files.length; b++) {
    const units: Record<string, unknown>[] = [];
    for (const [j, rel] of files.slice(b * PER_SAVE, (b + 1) * PER_SAVE).entries()) {
      const i = b * PER_SAVE + j;
      const quote = `Rule ${i}: keep ${rel} small.`;
      const m = message(db, projectId, { id: `m${i}`, text: `${quote} That is settled.` });
      const key = `f${i}`;
      keys.set(rel, `trace:ext-b${b}/${key}`);
      units.push({
        key,
        kind: "constraint",
        stance: "do",
        text: quote,
        aliases: ["harness"],
        anchors: [{ path: rel, role: "applies_to" }],
        evidence: [{ source: `s${m}`, quote, role: "states" }],
        adoption: [{ source: `s${m}`, quote }],
      });
    }
    const target: Target = {
      projectId,
      origin: "trace",
      prefix: `trace:ext-b${b}/`,
      sessionId: "s1",
      root: null,
      sources: null,
    };
    await inTransaction(db.ingest, async (trx) => {
      const run = await openRun(trx, {
        projectId,
        origin: "trace",
        target: "session:s1",
        sessionId: "s1",
        draftId: `d${b}`,
      });
      return saveRecord(trx, target, run, await checkRecord(trx, target, { units }), []);
    });
  }
  return keys;
}

/** A checkout whose origin is the project, with every anchored file committed at its base content */
function checkout(files: string[], origin: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sphica-shell-repo-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("remote", "add", "origin", origin);
  git("config", "user.email", "harness@example.invalid");
  git("config", "user.name", "harness");
  git("config", "core.autocrlf", "false");
  for (const rel of files) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), BASE(rel));
  }
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "plain.txt"), "export const plain = true;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return dir;
}

/** Puts a case's files back to their base content (or absent), and runs its setup */
function prepare(f: Fixture, c: Case): void {
  for (const rel of c.files) {
    const file = path.join(f.ctx.repo, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (c.absent?.includes(rel)) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, rel === "src/p29.ts" ? "zeta\nalpha\n" : BASE(rel));
  }
  c.setup?.(f.ctx);
}

let calls = 0;
const callId = () => `toolu_h${++calls}`;

/** Pre, the command, then Post (PostToolUseFailure in Claude Code when the command failed), as the bundle's hooks define them */
async function runCase(f: Fixture, p: Plugin, host: Host, c: Case): Promise<Result> {
  prepare(f, c);
  const session = `${p.name}-${host}-${c.id}`;
  const tool = host === "claude-code" && c.shell === "powershell" ? "PowerShell" : "Bash";
  const command = c.command(f.ctx);
  const base = {
    session_id: session,
    cwd: f.ctx.repo,
    tool_name: tool,
    tool_input: { command },
    tool_use_id: callId(),
    ...(host === "codex" ? { turn_id: `t-${session}` } : {}),
  };
  const pre = delivers(p, host, "PreToolUse", tool)
    ? (await fire(f.env, p, host, { ...base, hook_event_name: "PreToolUse" })).text
    : "";
  const exit = runCommand(f.ctx, c.shell, command);
  const event = host === "claude-code" && exit !== 0 ? "PostToolUseFailure" : "PostToolUse";
  const posted = delivers(p, host, event, tool);
  const post = posted
    ? (await fire(f.env, p, host, { ...base, hook_event_name: event, tool_response: { exit_code: exit } }))
        .text
    : "";
  const trial = trialLines(f.env.home).find((l) => l.call === base.tool_use_id) as Result["trial"];
  return {
    case: c.id,
    kind: c.kind,
    host,
    plugin: p.name,
    session,
    exit,
    pre,
    post,
    posted,
    ...(trial ? { trial } : {}),
  };
}

type Row = { name: string; ok: boolean; detail: string };

/** The rows the plan holds apart from the fixed cases: parallel calls, missing and expired snapshots, locks, paths, and deadlines */
async function extraRows(f: Fixture, p: Plugin): Promise<Row[]> {
  const rows: Row[] = [];
  const key = (rel: string) => f.keys.get(rel) ?? "";
  const call = (session: string, command: string, cwd = f.ctx.repo) => {
    const base = {
      session_id: session,
      cwd,
      tool_name: "Bash",
      tool_input: { command },
      tool_use_id: callId(),
    };
    return {
      id: base.tool_use_id,
      pre: () => fire(f.env, p, "claude-code", { ...base, hook_event_name: "PreToolUse" }),
      post: () => fire(f.env, p, "claude-code", { ...base, hook_event_name: "PostToolUse" }),
    };
  };
  const reset = (...rels: string[]) => {
    for (const rel of rels) fs.writeFileSync(path.join(f.ctx.repo, rel), BASE(rel));
  };
  const count = (texts: string[], k: string) => texts.filter((t) => keysIn(t).includes(k)).length;

  {
    reset("src/c1.ts");
    gen(f.ctx, "tools/genc1.cjs", "src/c1.ts");
    const a = call("x-read-write", "cat src/c1.ts");
    const b = call("x-read-write", "node tools/genc1.cjs");
    const pa = await a.pre();
    const pb = await b.pre();
    runCommand(f.ctx, "sh", "node tools/genc1.cjs");
    const posts = await Promise.all([a.post(), b.post()]);
    const n = count([pa.text, pb.text, ...posts.map((x) => x.text)], key("src/c1.ts"));
    rows.push({ name: "parallel read and write of one file", ok: n === 1, detail: `shown ${n} time(s)` });
  }
  {
    reset("src/c2.ts");
    gen(f.ctx, "tools/genc2.cjs", "src/c2.ts");
    const a = call("x-write-write", "node tools/genc2.cjs");
    const b = call("x-write-write", "node tools/genc2.cjs");
    await a.pre();
    await b.pre();
    runCommand(f.ctx, "sh", "node tools/genc2.cjs; node tools/genc2.cjs");
    const posts = await Promise.all([a.post(), b.post()]);
    const n = count(
      posts.map((x) => x.text),
      key("src/c2.ts"),
    );
    rows.push({ name: "parallel writes of one file", ok: n === 1, detail: `shown ${n} time(s)` });
  }
  {
    reset("src/c3a.ts", "src/c3b.ts");
    gen(f.ctx, "tools/genc3a.cjs", "src/c3a.ts");
    gen(f.ctx, "tools/genc3b.cjs", "src/c3b.ts");
    const a = call("x-two-files", "node tools/genc3a.cjs");
    const b = call("x-two-files", "node tools/genc3b.cjs");
    await a.pre();
    await b.pre();
    runCommand(f.ctx, "sh", "node tools/genc3a.cjs; node tools/genc3b.cjs");
    // Both writes land inside both calls, so whichever Post plans first brings both records, and the other has nothing left to bring
    const texts = (await Promise.all([a.post(), b.post()])).map((x) => x.text);
    const na = count(texts, key("src/c3a.ts"));
    const nb = count(texts, key("src/c3b.ts"));
    rows.push({
      name: "parallel writes of two files",
      ok: na === 1 && nb === 1,
      detail: `shown ${na} and ${nb} time(s)`,
    });
  }
  {
    reset("src/m1.ts");
    const a = call("x-missing", "echo x >> src/m1.ts");
    runCommand(f.ctx, "sh", "echo '// m' >> src/m1.ts");
    const r = await a.post();
    const line = trialLines(f.env.home).find((l) => l.call === a.id);
    const ok = !r.text && line?.event === "snapshot_missing";
    rows.push({
      name: "Post with no snapshot",
      ok,
      detail: `reply ${r.text ? "not empty" : "empty"}, trial ${String(line?.event)}`,
    });
  }
  {
    reset("src/e1.ts");
    const a = call("x-expired", "node tools/gene1.cjs");
    gen(f.ctx, "tools/gene1.cjs", "src/e1.ts");
    await a.pre();
    const calls = path.join(f.env.home, ".sphica", "shell-state", "calls");
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    for (const n of fs.readdirSync(calls)) fs.utimesSync(path.join(calls, n), old, old);
    const b = call("x-expired-other", "true");
    await b.pre();
    runCommand(f.ctx, "sh", "node tools/gene1.cjs");
    const r = await a.post();
    await b.post();
    const lines = trialLines(f.env.home);
    const expired = lines.some((l) => l.event === "snapshot_expired");
    const missing = lines.find((l) => l.call === a.id)?.event === "snapshot_missing";
    const ok = !r.text && expired && missing;
    rows.push({
      name: "a snapshot past its life",
      ok,
      detail: `removed and logged as expired: ${expired}, its Post logged missing: ${missing}, reply ${r.text ? "not empty" : "empty"}`,
    });
  }
  {
    reset("src/k1.ts");
    gen(f.ctx, "tools/genk1.cjs", "src/k1.ts");
    const a = call("x-locked", "node tools/genk1.cjs");
    await a.pre();
    runCommand(f.ctx, "sh", "node tools/genk1.cjs");
    f.db.owner.exec("begin immediate");
    let r: { text: string; ms: number };
    try {
      r = await a.post();
    } finally {
      f.db.owner.exec("rollback");
    }
    const line = trialLines(f.env.home).find((l) => l.call === a.id);
    const ok = keysIn(r.text).includes(key("src/k1.ts")) && line?.logged === false;
    rows.push({
      name: "another connection holds the write lock",
      ok,
      detail: `delivered ${keysIn(r.text).length}, logged ${String(line?.logged)}, ${Math.round(r.ms)} ms`,
    });
  }
  {
    reset("src/t1.ts");
    gen(f.ctx, "tools/gent1.cjs", "src/t1.ts");
    const trial = path.join(f.env.home, ".sphica", "shell-state", "trial.jsonl");
    const aside = `${trial}.aside`;
    fs.renameSync(trial, aside);
    fs.mkdirSync(trial);
    try {
      const a = call("x-trial-fails", "node tools/gent1.cjs");
      await a.pre();
      runCommand(f.ctx, "sh", "node tools/gent1.cjs");
      const r = await a.post();
      const ok = keysIn(r.text).includes(key("src/t1.ts"));
      rows.push({
        name: "the trial log cannot be written",
        ok,
        detail: `delivered ${keysIn(r.text).length}`,
      });
    } finally {
      fs.rmSync(trial, { recursive: true, force: true });
      fs.renameSync(aside, trial);
    }
  }
  {
    reset("src/d1.ts");
    // A helper that names no file, run from a subdirectory: Post must find the checkout from that cwd
    gen(f.ctx, "tools/gend1.cjs", "src/d1.ts");
    const a = call("x-cwd", "cd .. && node tools/gend1.cjs", path.join(f.ctx.repo, "src"));
    const pre = await a.pre();
    runCommand(f.ctx, "sh", "cd .. && node tools/gend1.cjs", path.join(f.ctx.repo, "src"));
    const r = await a.post();
    const ok = !keysIn(pre.text).length && keysIn(r.text).includes(key("src/d1.ts"));
    rows.push({
      name: "cwd in a subdirectory",
      ok,
      detail: `Pre ${keysIn(pre.text).length}, Post ${keysIn(r.text).length}`,
    });
  }
  {
    reset("src/Case1.ts");
    const upper = path.join(f.ctx.repo, "SRC", "CASE1.TS");
    const insensitive = fs.existsSync(upper);
    const a = call("x-case", "echo '// c' >> SRC/CASE1.TS");
    await a.pre();
    runCommand(f.ctx, "sh", "echo '// c' >> SRC/CASE1.TS");
    const r = await a.post();
    const got = keysIn(r.text).includes(key("src/Case1.ts"));
    rows.push({
      name: `a write through other letter case (${insensitive ? "case-insensitive" : "case-sensitive"} file system)`,
      ok: got === insensitive,
      detail: `delivered ${got}, expected ${insensitive}`,
    });
    // On a case-insensitive file system SRC is src itself
    if (!insensitive) fs.rmSync(path.join(f.ctx.repo, "SRC"), { recursive: true, force: true });
    else reset("src/Case1.ts");
  }
  {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-shell-out-"));
    fs.writeFileSync(path.join(outside, "o1.ts"), "export {};\n");
    const link = path.join(f.ctx.repo, "linked");
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(outside, link, windows ? "junction" : "dir");
    const a = call("x-link-out", "echo '// o' >> linked/o1.ts");
    await a.pre();
    runCommand(f.ctx, "sh", "echo '// o' >> linked/o1.ts");
    const r = await a.post();
    const line = trialLines(f.env.home).find((l) => l.call === a.id);
    const unknown = (line?.unknown as string[] | undefined)?.includes("linked/o1.ts") ?? false;
    const ok = !r.text && unknown;
    rows.push({
      name: `a write through a ${windows ? "junction" : "symlink"} out of the checkout`,
      ok,
      detail: `reply ${r.text ? "not empty" : "empty"}, counted unknown: ${unknown}`,
    });
    fs.rmSync(link, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
  if (windows) {
    const repo = f.ctx.repo;
    const forms: [string, string][] = [
      ["a lower-case drive letter", repo.replace(/^[A-Z]:/, (d) => d.toLowerCase())],
      ["forward slashes", repo.replaceAll("\\", "/")],
      ["a \\\\?\\ path", `\\\\?\\${repo}`],
      ["an administrative share (UNC)", `\\\\localhost\\${repo.replace(/^([A-Za-z]):/, "$1$")}`],
    ];
    for (const [i, [what, cwd]] of forms.entries()) {
      const rel = `src/u${i}.ts`;
      reset(rel);
      const a = call(`x-win-${i}`, `echo '// u' >> ${rel}`, cwd);
      let detail: string;
      let ok = false;
      try {
        await a.pre();
        runCommand(f.ctx, "sh", `echo '// u' >> ${rel}`);
        const r = await a.post();
        ok = keysIn(r.text).includes(key(rel));
        detail = `delivered ${keysIn(r.text).length}`;
      } catch (e) {
        detail = e instanceof Error ? e.message : String(e);
      }
      rows.push({ name: `cwd as ${what}`, ok, detail });
    }
  } else
    rows.push({
      name: "cwd as Windows path forms (drive case, slashes, \\\\?\\, UNC)",
      ok: true,
      detail: "Windows only: not run on this OS",
    });
  return rows;
}

/** The deadline rows: a cold cache over many files, and a call that changes them all */
async function deadlineRows(p: Plugin, home: string, n: number, kb: number): Promise<Row[]> {
  const db = tempDb();
  try {
    const pid = project(db, "git:github.com/o/bulk", "o/bulk");
    const files = Array.from({ length: n }, (_, i) => `bulk/f${String(i).padStart(5, "0")}.ts`);
    const keys = await seed(db, pid, files);
    const repo = checkout(files, "https://github.com/o/bulk.git");
    const body = "x".repeat(kb * 1024);
    for (const rel of files) fs.writeFileSync(path.join(repo, rel), body);
    const f: Fixture = { env: { home, db: db.file }, ctx: { repo, py: "", biome: "" }, db, keys };
    const rows: Row[] = [];
    const cache = path.join(home, ".sphica", "shell-state", "cache");
    const measure = async (session: string, command: string, write: () => void) => {
      const id = callId();
      const base = {
        session_id: session,
        cwd: repo,
        tool_name: "Bash",
        tool_input: { command },
        tool_use_id: id,
      };
      const pre = await fire(f.env, p, "claude-code", { ...base, hook_event_name: "PreToolUse" });
      write();
      const post = await fire(f.env, p, "claude-code", { ...base, hook_event_name: "PostToolUse" });
      const line = trialLines(home).find((l) => l.call === id);
      return { pre, post, line };
    };
    fs.rmSync(cache, { recursive: true, force: true });
    const cold = await measure("bulk-cold", "node gen.mjs", () =>
      fs.appendFileSync(path.join(repo, files[0] ?? ""), "y"),
    );
    const unknownCold = (cold.line?.unknown as string[] | undefined)?.length ?? 0;
    rows.push({
      name: `${n} files of ${kb} KB (${Math.round((n * kb) / 1024)} MB), cold cache`,
      ok:
        Boolean(cold.line) &&
        (unknownCold > 0 || keysIn(cold.post.text).includes(keys.get(files[0] ?? "") ?? "")),
      detail: `Pre ${Math.round(cold.pre.ms)} ms, Post ${Math.round(cold.post.ms)} ms, unknown ${unknownCold}, delivered ${keysIn(cold.post.text).length}`,
    });
    const all = await measure("bulk-all", "node gen.mjs", () => {
      for (const rel of files) fs.appendFileSync(path.join(repo, rel), "z");
    });
    const changed = (all.line?.changed as string[] | undefined)?.length ?? 0;
    const unknownAll = (all.line?.unknown as string[] | undefined)?.length ?? 0;
    rows.push({
      name: `a call that changes all ${n} files`,
      ok: Boolean(all.line) && changed + unknownAll === n && keysIn(all.post.text).length > 0,
      detail: `Pre ${Math.round(all.pre.ms)} ms, Post ${Math.round(all.post.ms)} ms, changed ${changed}, unknown ${unknownAll}, delivered ${keysIn(all.post.text).length}`,
    });
    fs.rmSync(repo, { recursive: true, force: true });
    return rows;
  } finally {
    await db.done();
  }
}

/** The deliver.js and hooks of an earlier commit, built beside this checkout's dependencies */
function buildOld(ref: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-shell-old-"));
  const tar = path.join(dir, "src.tar");
  execFileSync("git", [
    "-C",
    ROOT,
    "archive",
    "--format=tar",
    "-o",
    tar,
    ref,
    "server/src",
    "plugin/hooks",
    "db",
  ]);
  execFileSync("tar", ["-xf", tar, "-C", dir]);
  fs.symlinkSync(
    path.join(ROOT, "server", "node_modules"),
    path.join(dir, "server", "node_modules"),
    windows ? "junction" : "dir",
  );
  execFileSync(
    "bun",
    [
      "build",
      path.join(dir, "server", "src", "deliver.ts"),
      "--target=node",
      "--outfile",
      path.join(dir, "plugin", "dist", "deliver.js"),
    ],
    { stdio: "ignore" },
  );
  return path.join(dir, "plugin");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      plugin: { type: "string" },
      compare: { type: "string", default: "main" },
      "no-compare": { type: "boolean", default: false },
    },
  });
  if (!values.plugin)
    execFileSync(process.execPath, [path.join(ROOT, "scripts", "bundle.mjs")], {
      cwd: ROOT,
      stdio: "ignore",
    });
  const plugins = [loadPlugin("new", path.resolve(values.plugin ?? path.join(ROOT, "plugin")))];
  if (!values["no-compare"]) plugins.unshift(loadPlugin("old", buildOld(values.compare)));

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-shell-home-"));
  const db = tempDb();
  const cases = CASES.filter((c) => c.shell === "sh" || windows);
  const extraFiles = [
    "src/c1.ts",
    "src/c2.ts",
    "src/c3a.ts",
    "src/c3b.ts",
    "src/m1.ts",
    "src/e1.ts",
    "src/k1.ts",
    "src/t1.ts",
  ]
    .concat(["src/d1.ts", "src/Case1.ts", "linked/o1.ts", "src/u0.ts", "src/u1.ts", "src/u2.ts", "src/u3.ts"])
    .concat(CASES.filter((c) => c.id === "p26").map(() => "src/p26-two.txt"));
  const files = [...new Set([...CASES.flatMap((c) => c.files), ...extraFiles])];
  let failed = false;
  try {
    const pid = project(db, "git:github.com/o/r", "o/r");
    const keys = await seed(db, pid, files);
    const repo = checkout(
      files.filter((f) => !f.startsWith("linked/")),
      "https://github.com/o/r.git",
    );
    const biome = path.join(ROOT, "server", "node_modules", "@biomejs", "biome", "bin", "biome");
    const f: Fixture = { env: { home, db: db.file }, ctx: { repo, py: python(), biome }, db, keys };
    const filesOf = (r: Result) => CASES.find((x) => x.id === r.case)?.files ?? [];
    const expectOf = (r: Result) => filesOf(r).map((rel) => keys.get(rel) ?? rel);

    console.log(
      `${os.type()} ${os.release()} ${os.arch()}, node ${process.version}, ${plugins.map((p) => `${p.name}: ${p.dir}`).join(", ")}`,
    );
    const results: Result[] = [];
    for (const p of plugins)
      for (const c of cases)
        for (const host of ["claude-code", "codex"] as Host[]) results.push(await runCase(f, p, host, c));

    const now = results.filter((r) => r.plugin === "new");
    console.log("\n| case | kind | what | Claude Code | Codex |\n|---|---|---|---|---|");
    for (const c of cases) {
      const cell = (host: Host) => {
        const r = now.find((x) => x.case === c.id && x.host === host);
        if (!r) return "not run";
        const problem = judge(r, expectOf(r), filesOf(r));
        const seen = filesOf(r).filter((f) => r.trial?.changed?.includes(f)).length;
        const how =
          c.kind === "positive"
            ? `${via(r, expectOf(r))}, changed ${seen}/${filesOf(r).length}`
            : `changed ${seen}, pre ${keysIn(r.pre).length}, post ${keysIn(r.post).length}`;
        const mark = c.kind === "positive" || c.kind === "negative" ? (problem ? "✗ " : "✓ ") : "";
        return `${mark}${how}${r.exit ? ` (exit ${r.exit})` : ""}${problem ? `: ${problem}` : ""}`;
      };
      console.log(`| ${c.id} | ${c.kind} | ${c.what} | ${cell("claude-code")} | ${cell("codex")} |`);
    }
    // The limit row: whether a later call picks up the background write
    await new Promise((r) => setTimeout(r, 2500));
    const late = await runCase(f, plugins.at(-1) as Plugin, "claude-code", {
      ...(SEPARATE.find((c) => c.id === "l01") as Case),
      id: "l01-next",
      setup: undefined,
      files: [],
      command: () => "true",
    });
    console.log(
      `\nl01, the background write, on the next call: Post ${keysIn(late.post).length ? "delivered it" : "delivered nothing"} (the write landed between calls, so neither call saw it change)`,
    );
    console.log(
      "A change that keeps the whole lstat signature is not reproduced here: every write from user space moves ctime, which no call can set back.",
    );

    const t = tally(now, expectOf, filesOf);
    const sh = now.filter((r) => CASES.find((c) => c.id === r.case)?.shell === "sh");
    const shPositive = tally(sh, expectOf, filesOf).positive;
    console.log(
      `\nPositives: ${t.positive.pass} of ${t.positive.total} (shell cases ${shPositive.pass} of ${shPositive.total}, ${POSITIVES.length} per host). Negatives with nothing added: ${t.negative.pass} of ${t.negative.total}. Counted apart: ${t.separate.changed} of ${t.separate.total} seen as changed, ${t.separate.delivered} with records brought by Post. Limits: ${t.limit.changed} of ${t.limit.total} seen as changed, ${t.limit.delivered} brought by Post.`,
    );
    if (t.failures.length) {
      failed = true;
      console.log(`Failures:\n${t.failures.map((x) => `- ${x}`).join("\n")}`);
    }

    const extra = await extraRows(f, plugins.at(-1) as Plugin);
    const bulk = await deadlineRows(plugins.at(-1) as Plugin, home, 1000, 64);
    console.log("\n| row | result | detail |\n|---|---|---|");
    for (const r of [...extra, ...bulk]) {
      console.log(`| ${r.name} | ${r.ok ? "✓" : "✗"} | ${r.detail} |`);
      if (!r.ok) failed = true;
    }

    if (plugins.length > 1) {
      console.log(
        "\n| bundle | positives reached | records shown | characters | shown again in one conversation | Post replies |\n|---|---|---|---|---|---|",
      );
      for (const p of plugins) {
        const mine = results.filter(
          (r) => r.plugin === p.name && (r.kind === "positive" || r.kind === "negative"),
        );
        const reached = mine.filter(
          (r) =>
            r.kind === "positive" &&
            expectOf(r).every((k) => [...keysIn(r.pre), ...keysIn(r.post)].includes(k)),
        ).length;
        const shown = mine.reduce((n, r) => n + keysIn(r.pre).length + keysIn(r.post).length, 0);
        const chars = mine.reduce((n, r) => n + r.pre.length + r.post.length, 0);
        const posts = mine.filter((r) => r.post).length;
        console.log(
          `| ${p.name} | ${reached} of ${mine.filter((r) => r.kind === "positive").length} | ${shown} | ${chars} | ${duplicates(mine)} | ${posts} |`,
        );
      }
    }
    fs.rmSync(repo, { recursive: true, force: true });
  } finally {
    await db.done();
    fs.rmSync(home, { recursive: true, force: true });
  }
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && /shell-write-harness\.(ts|js)$/.test(process.argv[1])) await main();
