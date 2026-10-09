// Compares a work tree with git in a git directory Sphica writes, started as a child process so a stalled read can be cut off. The
// agent writes the repository's config, attributes, and hooks; here git reads none of them, nor the owner's global or system config, so
// no filter, diff driver, or hook any of them names can run. Request on stdin, result on stdout, both JSON.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  commitOf,
  commonDir,
  configGet,
  DIFF_OPTIONS,
  gitEnv,
  gitOptions,
  gitPath,
  SAFE_KEYS,
  startDir,
  unbornHead,
} from "./git.ts";

export type WorktreeOp =
  | { kind: "status" }
  | { kind: "diff"; from: string }
  | { kind: "renames"; commit: string };
/** until: the time (ms since the epoch) by which every git the worker starts has ended or been killed */
export type WorkerRequest = { root: string; ops: WorktreeOp[]; max: number; until: number };
export type WorkerResult = { ok: true; out: string[] } | { ok: false; error: string };

const INDEX_LIMIT = 256 * 1024 * 1024;
const FILE_LIMIT = 1024 * 1024;
/** Isolated directories left by a worker that was cut off are removed by the next one after this long */
const STALE_MS = 60 * 60 * 1000;

const inside = (root: string, p: string) => {
  const rel = path.relative(root, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};
const overlap = (a: string, b: string) => inside(a, b) || inside(b, a);

/** A directory under parent that is a real directory, made when missing; a link there is refused, since git would follow it */
function ownDir(parent: string, name: string): string {
  const dir = path.join(parent, name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a plain directory`);
  return dir;
}

/**
 * The isolated directory and the empty hooks folder, under HOME's real path, each step a plain directory, and apart from the work tree
 * and the temp directory, both of which a sandboxed agent can write
 */
export function isolatedHome(root: string): { git: string; iso: string; hooks: string } {
  const home = fs.realpathSync(os.homedir());
  const git = ownDir(ownDir(home, ".sphica"), "git");
  const hooks = ownDir(git, "hooks");
  if (fs.readdirSync(hooks).length) throw new Error(`${hooks} is not empty`);
  const iso = fs.mkdtempSync(path.join(git, "iso-"));
  const st = fs.lstatSync(iso);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${iso} is not a plain directory`);
  const real = fs.realpathSync(iso);
  if (!inside(home, real) || real !== iso) throw new Error(`${iso} leads out of HOME`);
  for (const other of [root, os.tmpdir()]) {
    const otherReal = fs.realpathSync(other);
    if (overlap(real, otherReal) || overlap(git, otherReal))
      throw new Error(`${git} overlaps ${otherReal}, which an agent can write`);
  }
  return { git, iso, hooks };
}

/**
 * Removes isolated directories older than STALE_MS from git, the directory isolatedHome checked: a worker cut off at its deadline cannot
 * remove its own
 */
export function sweep(git: string, now = Date.now()): void {
  let names: string[];
  try {
    names = fs.readdirSync(git).filter((n) => n.startsWith("iso-"));
  } catch {
    return;
  }
  for (const name of names) {
    const dir = path.join(git, name);
    try {
      const st = fs.lstatSync(dir);
      if (st.isDirectory() && !st.isSymbolicLink() && now - st.mtimeMs > STALE_MS)
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // another worker removed it
    }
  }
}

const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NON_BLOCK = fs.constants.O_NONBLOCK ?? 0;

/**
 * A regular file's bytes up to limit, or null when it does not exist. A link, a FIFO, or a device is refused before anything blocks on it:
 * opened without following links and without waiting, then checked on the open descriptor. Where those flags do not exist (Windows),
 * the path is checked first and the descriptor is held to the same file.
 */
export function readLimited(file: string, limit: number): Buffer | null {
  return readStamped(file, limit)?.bytes ?? null;
}

/** readLimited, with the file's modification time */
function readStamped(file: string, limit: number): { bytes: Buffer; mtime: Date } | null {
  let before: fs.Stats | undefined;
  if (!NO_FOLLOW) {
    before = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!before) return null;
    if (!before.isFile()) throw new Error(`${file} is not a regular file`);
  }
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`${file} cannot be opened as a regular file`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`${file} is not a regular file`);
    if (before && (st.dev !== before.dev || st.ino !== before.ino))
      throw new Error(`${file} changed while opened`);
    if (st.size > limit) throw new Error(`${file} is over ${limit} bytes`);
    // Read one byte past the limit: a file that grew after fstat is caught, not read without end
    const buf = Buffer.alloc(limit + 1);
    let got = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, got, buf.length - got, null);
      if (n === 0) break;
      got += n;
      if (got > limit) throw new Error(`${file} is over ${limit} bytes`);
    }
    return { bytes: buf.subarray(0, got), mtime: st.mtime };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A value in the one spelling the isolated config writes: git reads these words in any letter case (booleans arrive already read as
 * true or false by git itself)
 */
const normalized = (value: string): string => value.trim().toLowerCase();

/** The config the isolated directory holds: the safe keys, each value checked against what its type allows and written in one fixed form */
export function isolatedConfig(values: Partial<Record<keyof typeof SAFE_KEYS, string | null>>): string {
  const lines = ["[core]", "\tbare = false", "\tquotePath = false"];
  const extensions: string[] = [];
  const allowed: Partial<Record<keyof typeof SAFE_KEYS, readonly string[]>> = {
    "core.autocrlf": ["true", "false", "input"],
    "core.eol": ["lf", "crlf", "native"],
    "core.checkStat": ["default", "minimal"],
    "extensions.objectFormat": ["sha1", "sha256"],
  };
  const sections: Record<string, string[]> = { core: lines, index: [] };
  for (const [key, type] of Object.entries(SAFE_KEYS) as [keyof typeof SAFE_KEYS, string][]) {
    const value = values[key];
    if (value === null || value === undefined || type === "path") continue;
    const normal = normalized(value);
    const ok = type === "bool" ? ["true", "false"] : (allowed[key] ?? []);
    if (!ok.includes(normal))
      throw new Error(`${key} has a value Sphica does not copy: ${JSON.stringify(value.slice(0, 40))}`);
    const [section, name] = key.split(".") as [string, string];
    if (section === "extensions") extensions.push(`\t${name} = ${normal}`);
    else sections[section]?.push(`\t${name} = ${normal}`);
  }
  const sha256 = values["extensions.objectFormat"] === "sha256";
  lines.splice(1, 0, `\trepositoryformatversion = ${sha256 ? 1 : 0}`);
  return [
    ...lines,
    ...(sections.index?.length ? ["[index]", ...sections.index] : []),
    ...(sha256 ? ["[extensions]", ...extensions] : []),
    "",
  ].join("\n");
}

/** The global ignore file git would read: core.excludesFile, else git/ignore under XDG_CONFIG_HOME or ~/.config */
function excludesFile(root: string, limits: { timeout: number }): string | null {
  const set = configGet(root, "core.excludesFile", limits);
  // Set but empty: git reads no global ignore file at all
  if (set === "") return null;
  if (set) return set.startsWith("~/") ? path.join(os.homedir(), set.slice(2)) : path.resolve(root, set);
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config"), "git", "ignore");
}

/** Writes the isolated git directory for root's work tree into iso and returns the environment and options git runs with there */
function prepare(
  root: string,
  iso: string,
  hooks: string,
  remaining: () => { timeout: number },
): { env: NodeJS.ProcessEnv; options: string[] } {
  for (const dir of ["refs", "objects", "info"]) fs.mkdirSync(path.join(iso, dir));
  let head: string;
  try {
    head = commitOf(root, "HEAD", remaining());
  } catch (e) {
    // A repository with no commit yet: HEAD names a branch that does not exist, as git's own unborn HEAD does. A HEAD that names a
    // missing or broken commit is a failure, not a new repository.
    if (!unbornHead(root, remaining())) throw e;
    head = "ref: refs/heads/sphica-unborn";
  }
  fs.writeFileSync(path.join(iso, "HEAD"), `${head}\n`);
  const values = Object.fromEntries(
    (Object.keys(SAFE_KEYS) as (keyof typeof SAFE_KEYS)[]).map((k) => [k, configGet(root, k, remaining())]),
  );
  fs.writeFileSync(path.join(iso, "config"), isolatedConfig(values));
  const index = gitPath(root, "index", remaining());
  // The copy keeps the index's modification time: git trusts an entry as unchanged only when the file is older than the index, and a
  // copy stamped now would hide a change made just before it
  const copyIndex = (from: string, name: string) => {
    const got = readStamped(from, INDEX_LIMIT);
    if (!got) return;
    fs.writeFileSync(path.join(iso, name), got.bytes);
    fs.utimesSync(path.join(iso, name), got.mtime, got.mtime);
  };
  copyIndex(index, "index");
  // A split index keeps its shared part beside the index
  for (const name of fs
    .readdirSync(path.dirname(index))
    .filter((n) => /^sharedindex\.[0-9a-f]{40,64}$/.test(n)))
    copyIndex(path.join(path.dirname(index), name), name);
  for (const name of ["info/exclude", "info/attributes", "info/sparse-checkout"] as const) {
    const bytes = readLimited(gitPath(root, name, remaining()), FILE_LIMIT);
    if (bytes) fs.writeFileSync(path.join(iso, name), bytes);
  }
  const ignore = path.join(iso, "global-ignore");
  const global = excludesFile(root, remaining());
  fs.writeFileSync(ignore, (global && readLimited(global, FILE_LIMIT)) ?? "");
  return {
    env: gitEnv({
      GIT_DIR: iso,
      GIT_WORK_TREE: root,
      GIT_OBJECT_DIRECTORY: path.join(commonDir(root, remaining()), "objects"),
      GIT_CONFIG_NOSYSTEM: "1",
      // Git for Windows opens /dev/null as nul but cannot open \\.\nul, what os.devNull gives there
      GIT_CONFIG_GLOBAL: "/dev/null",
    }),
    options: [...gitOptions(hooks), "-c", `core.excludesFile=${ignore}`],
  };
}

/** The git arguments for one operation */
function argsOf(op: WorktreeOp): string[] {
  const oid = (s: string) => {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s)) throw new Error(`not an object id: ${JSON.stringify(s)}`);
    return s;
  };
  if (op.kind === "status")
    return ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=dirty"];
  if (op.kind === "diff")
    return [
      "diff",
      ...DIFF_OPTIONS,
      "--no-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      oid(op.from),
      "--",
    ];
  return ["diff", ...DIFF_OPTIONS, "-M", "-l1000", "--name-status", "-z", oid(op.commit), "--"];
}

/** Runs the request's operations in one isolated directory, removed after */
function work(request: WorkerRequest): WorkerResult {
  try {
    const { git, iso, hooks } = isolatedHome(request.root);
    sweep(git);
    // Each git gets what is left of the deadline, so none outlives the worker the caller stopped waiting for
    const remaining = () => ({ timeout: Math.max(1, Math.floor(request.until - Date.now())) });
    try {
      const { env, options } = prepare(request.root, iso, hooks, remaining);
      const out = request.ops.flatMap((op) => {
        const run = (args: string[]) =>
          execFileSync("git", ["-C", request.root, ...options, ...args], {
            cwd: startDir(),
            env,
            ...remaining(),
            killSignal: "SIGKILL",
            encoding: "utf8",
            maxBuffer: request.max,
            stdio: ["ignore", "pipe", "ignore"],
          });
        // A work tree diff gives its patch and, separately, every changed path (binary and empty files print no ---/+++ lines)
        if (op.kind === "diff")
          return [
            run(argsOf(op)),
            run(["diff", ...DIFF_OPTIONS, "--no-renames", "--name-only", "-z", op.from, "--"]),
          ];
        return [run(argsOf(op))];
      });
      return { ok: true, out };
    } finally {
      fs.rmSync(iso, { recursive: true, force: true });
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? "")) {
  const chunks: Buffer[] = [];
  process.stdin.on("data", (c: Buffer) => chunks.push(c));
  process.stdin.on("end", () => {
    let request: WorkerRequest;
    try {
      request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WorkerRequest;
    } catch {
      process.stdout.write(JSON.stringify({ ok: false, error: "the request is not JSON" }));
      return;
    }
    process.stdout.write(JSON.stringify(work(request)));
  });
}
