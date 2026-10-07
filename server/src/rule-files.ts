// The instruction files an owner may paste Sphica's draft rule lines into (CLAUDE.md, AGENTS.md, AGENTS.override.md, .claude/rules/**/*.md),
// read from the working tree with bounds, so a stale-marker check can look at every one it lists and say how many it could not.
import fs from "node:fs";
import path from "node:path";
import { leaves } from "./anchors.ts";
import { cleanGit } from "./git.ts";
import { sha256 } from "./text.ts";

export const RULE_LIMITS = { files: 200, bytes: 256 * 1024, depth: 8, entries: 5000 } as const;

const RULE_NAMES = new Set(["CLAUDE.md", "AGENTS.md", "AGENTS.override.md"]);
/** git pathspecs for the same set; `**` also matches the top directory. */
const PATHSPECS = [...RULE_NAMES, ".claude/rules/**/*.md"].map((p) => `:(glob)**/${p}`);

/** Whether a repository-relative path (forward slashes) is one of the instruction files. */
export function isRuleFile(rel: string): boolean {
  const parts = rel.split("/");
  const name = parts.at(-1) ?? "";
  if (RULE_NAMES.has(name)) return true;
  const i = parts.findIndex((p, k) => p === ".claude" && parts[k + 1] === "rules");
  return i >= 0 && parts.length > i + 2 && name.endsWith(".md");
}

export type RuleFiles = {
  files: { path: string; text: string }[];
  /** Files found but not read: past the file cap, too large, not a regular file, binary, or leading outside the repository */
  skipped: number;
  /** Why the listing itself may have missed files, or null when it looked everywhere it should */
  incomplete: string | null;
};

/** A short name for an instruction file's path that stays the same length however long the path is. */
export const pathHash = (rel: string): string => sha256(rel).toString("hex").slice(0, 16);

/**
 * The instruction files under root, in path order. In a git work tree, tracked and untracked files git does not ignore; elsewhere, a
 * bounded walk. With `from` (a pathHash), the files before that one are not read again.
 */
export function ruleFiles(root: string, from?: string): RuleFiles {
  const listed = gitList(root) ?? walk(root);
  const out: RuleFiles = { files: [], skipped: 0, incomplete: listed.incomplete };
  const realRoot = fs.realpathSync(root);
  const paths = [...new Set(listed.paths)].sort();
  const start = from
    ? Math.max(
        paths.findIndex((rel) => pathHash(rel) === from),
        0,
      )
    : 0;
  // The cap counts every file looked at, read or not, so it bounds the work
  for (const [i, rel] of paths.entries()) {
    if (i < start) continue;
    if (i >= RULE_LIMITS.files) {
      out.skipped++;
      continue;
    }
    const text = readBounded(root, realRoot, rel);
    if (text === null) continue;
    if (text === undefined) out.skipped++;
    else out.files.push({ path: rel, text });
  }
  return out;
}

/** The file's text; null when it is not there (a tracked file deleted in the working tree); undefined when it is there but not read. */
function readBounded(root: string, realRoot: string, rel: string): string | null | undefined {
  const abs = path.join(root, rel);
  if (leaves(path.relative(root, abs))) return undefined;
  try {
    const st = fs.lstatSync(abs, { throwIfNoEntry: false });
    if (!st) return null;
    if (!st.isFile() || st.size > RULE_LIMITS.bytes) return undefined;
    // A symlinked directory on the way can lead outside the repository
    if (leaves(path.relative(realRoot, fs.realpathSync(abs)))) return undefined;
    const buf = fs.readFileSync(abs);
    return buf.length > RULE_LIMITS.bytes || buf.includes(0) ? undefined : buf.toString("utf8");
  } catch {
    return undefined;
  }
}

function gitList(root: string): { paths: string[]; incomplete: string | null } | null {
  try {
    if (cleanGit(root, ["rev-parse", "--is-inside-work-tree"]).toString("utf8").trim() !== "true")
      return null;
  } catch {
    return null;
  }
  try {
    const out = cleanGit(
      root,
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...PATHSPECS],
      16 * 1024 * 1024,
    );
    return { paths: out.toString("utf8").split("\0").filter(isRuleFile), incomplete: null };
  } catch {
    return { paths: [], incomplete: "git could not list the files" };
  }
}

/** Outside git: every directory but node_modules and dot-directories other than .claude, never through a symlink, within the bounds. */
function walk(root: string): { paths: string[]; incomplete: string | null } {
  const paths: string[] = [];
  let entries = 0;
  let unread = 0;
  let tooDeep = false;
  // Only the entry budget stops the whole walk; a branch past the depth cap is skipped and its siblings are still read
  let stopped = false;
  const visit = (rel: string, depth: number) => {
    if (stopped) return;
    let list: fs.Dirent[];
    try {
      list = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      unread++;
      return;
    }
    for (const d of list) {
      if (++entries > RULE_LIMITS.entries) {
        stopped = true;
        return;
      }
      const child = rel ? `${rel}/${d.name}` : d.name;
      // A symlink with a rule file's name is listed so the read counts it as skipped rather than dropping it unseen
      if ((d.isFile() || d.isSymbolicLink()) && isRuleFile(child)) paths.push(child);
      else if (
        d.isDirectory() &&
        d.name !== "node_modules" &&
        (!d.name.startsWith(".") || d.name === ".claude")
      ) {
        if (depth >= RULE_LIMITS.depth) tooDeep = true;
        else visit(child, depth + 1);
      }
    }
  };
  visit("", 1);
  const why = [
    ...(stopped ? [`stopped after ${RULE_LIMITS.entries} directory entries`] : []),
    ...(tooDeep ? [`did not look deeper than ${RULE_LIMITS.depth} directories`] : []),
    ...(unread ? [`could not read ${unread} director${unread === 1 ? "y" : "ies"}`] : []),
  ];
  return { paths, incomplete: why.length ? why.join("; ") : null };
}

/**
 * Where coding agents load standing instructions, Skills, and settings from (the same places the review Skill treats as binding rules),
 * and the Skills and manifests a plugin ships for them, compared without case.
 */
const INSTRUCTION_DIRS = new Set([
  ".claude",
  ".agents",
  ".codex",
  ".cursor",
  "skills",
  ".claude-plugin",
  ".codex-plugin",
]);
export const instructionFile = (relative: string) => {
  const parts = relative.toLowerCase().split(/[\\/]/);
  const names = [...RULE_NAMES, "SKILL.md"].map((n) => n.toLowerCase());
  return (
    parts.some((p) => INSTRUCTION_DIRS.has(p)) ||
    names.includes(parts.at(-1) ?? "") ||
    parts.slice(-2).join("/") === ".github/copilot-instructions.md"
  );
};
