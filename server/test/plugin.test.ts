import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  compareVersions,
  differingFiles,
  type Install,
  observe,
  packageVersionAt,
  parsePs,
  report,
  type Seen,
  versionAt,
} from "../src/plugin.ts";
import { tempDb } from "./temp-db.ts";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const REPO_PLUGIN = path.join(SRC, "..", "..", "plugin");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-plugin-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
/** Builds a package with a manifest and one content file. */
function plugin(where: string, version: string, body = "x"): Install {
  const root = path.join(tmp, where);
  fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "sphica", version }),
  );
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "sphica", version, type: "module" }),
  );
  fs.writeFileSync(path.join(root, "dist", "mcp.js"), body);
  return { version, packageVersion: version, root };
}

const seen = (over: Partial<Seen>): Seen => ({
  repository: null,
  cli: plugin("cli", "0.10.19"),
  global: null,
  claude: null,
  codex: [],
  codexCache: path.join(tmp, "codex", "plugins", "cache"),
  running: [],
  ...over,
});

test("an outdated npm i -g CLI shows in both the row and the update steps", () => {
  // It is separate from the plugin cache, so updating the host does not upgrade it.
  const { lines, issues, updates } = report(
    seen({ cli: plugin("cli", "0.33.12"), global: plugin("global", "0.32.0") }),
  );
  const row = lines.find((l) => l.includes("npm i -g CLI"));
  assert.ok(row?.includes("0.32.0"), row);
  assert.ok(row?.includes("older than"), row);
  assert.ok(issues.includes("npm i -g CLI"));
  // Fill in the target version so the command can be run as is
  assert.deepEqual(
    updates.find((u) => u.who === "npm CLI"),
    { who: "npm CLI", command: "npm i -g sphica@0.33.12", after: null },
  );
});

test("no npm i -g row when it is the same install as the running CLI", () => {
  const same = plugin("one", "0.33.12");
  const { lines } = report(seen({ cli: same, global: same }));
  assert.equal(lines.filter((l) => l.includes("npm i -g CLI")).length, 0, lines.join("\n"));
});

test("versions compare numerically (0.10.9 < 0.10.18)", () => {
  assert.equal(compareVersions("0.10.9", "0.10.18"), -1);
  assert.equal(compareVersions("0.10.18", "0.10.18"), 0);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
});

test("manifests other than sphica and missing roots have no version", () => {
  const other = path.join(tmp, "other");
  fs.mkdirSync(path.join(other, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(other, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "x", version: "1.0.0" }),
  );
  assert.equal(versionAt(other), null);
  assert.equal(versionAt(path.join(tmp, "missing")), null);
  assert.equal(versionAt(plugin("ok", "0.1.0").root), "0.1.0");
  assert.equal(packageVersionAt(plugin("package-ok", "0.2.0").root), "0.2.0");
});

test("content comparison ignores host markers in the cache and .DS_Store", () => {
  const a = plugin("same-a", "0.1.0");
  const b = plugin("same-b", "0.1.0");
  // Claude Code puts .orphaned_at in replaced versions and .in_use/<pid> in versions in use.
  fs.writeFileSync(path.join(b.root, ".orphaned_at"), "1");
  fs.mkdirSync(path.join(b.root, ".in_use"));
  fs.writeFileSync(path.join(b.root, ".in_use", "18278"), "");
  fs.writeFileSync(path.join(a.root, "dist", ".DS_Store"), "");
  assert.deepEqual(differingFiles(a.root, b.root), []);
  fs.writeFileSync(path.join(b.root, "dist", "mcp.js"), "y");
  fs.mkdirSync(path.join(a.root, "skills", "new"), { recursive: true });
  fs.writeFileSync(path.join(a.root, "skills", "new", "SKILL.md"), "s");
  // Unlike markers, shipped dotfiles directly under root count as differences.
  fs.writeFileSync(path.join(a.root, ".mcp.json"), "{}");
  assert.deepEqual(differingFiles(a.root, b.root), [".mcp.json", "dist/mcp.js", "skills/new/SKILL.md"]);
});

test("on the repository side, only files tracked by git are compared as shipped files", () => {
  // As in the real layout, put plugin/ under the git root.
  const repo = plugin("git-repo/plugin", "0.1.0");
  const cache = plugin("git-cache", "0.1.0");
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", path.dirname(repo.root), ...a], { stdio: "ignore" });
  git("init", "-q");
  git("add", ".");
  // Untracked files (ignored files and editor temp files) are not shipped.
  fs.writeFileSync(path.join(repo.root, "debug.log"), "");
  fs.writeFileSync(path.join(repo.root, "dist", ".mcp.js.swp"), "");
  assert.deepEqual(differingFiles(repo.root, cache.root, { tracked: true }), []);
  assert.deepEqual(differingFiles(repo.root, cache.root), ["debug.log", "dist/.mcp.js.swp"]);
  // Files that bundle builds and npm ships but git does not track exist on both sides
  for (const generated of ["THIRD_PARTY_NOTICES.md", "README.md"]) {
    fs.writeFileSync(path.join(repo.root, generated), generated);
    fs.writeFileSync(path.join(cache.root, generated), generated);
  }
  assert.deepEqual(differingFiles(repo.root, cache.root, { tracked: true }), []);
});

test("picks only node …/dist/mcp.js from ps output", () => {
  const out = [
    "18319 Fri Sep 11 09:07:27 2026     node /Users/me/Projects/sphica/plugin/dist/mcp.js",
    "29334 Fri Sep  4 14:10:31 2026     node ./dist/mcp.js",
    "  401 Fri Sep 11 09:00:00 2026     /opt/homebrew/bin/node /Users/me/Library/Application Support/x/dist/mcp.js",
    "  500 Fri Sep 11 09:00:00 2026     node /Users/me/other/dist/cli.js",
    "  501 Fri Sep 11 09:00:00 2026     vim dist/mcp.js",
  ].join("\n");
  const got = parsePs(out);
  assert.deepEqual(
    got.map((p) => [p.pid, p.script]),
    [
      [18319, "/Users/me/Projects/sphica/plugin/dist/mcp.js"],
      [29334, "./dist/mcp.js"],
      [401, "/Users/me/Library/Application Support/x/dist/mcp.js"],
    ],
  );
  assert.equal(got[1]?.started.getDate(), 4);
});

test("installs older than the repository show update steps for both hosts", () => {
  const repository = plugin("r1/plugin", "0.10.19");
  const r = report(
    seen({
      repository,
      cli: repository,
      claude: plugin("claude/plugins/cache/sphica/sphica/0.10.18", "0.10.18"),
      codex: [plugin("codex/plugins/cache/sphica/sphica/0.10.18", "0.10.18")],
    }),
  );
  // Running in-process on a terminal colors the markers. Strip them before comparing.
  const out = stripVTControlCharacters(r.lines.join("\n"));
  assert.match(out, /△ Claude Code [^\n]*\n +older than repository \(0\.10\.19\)/);
  assert.match(out, /△ Codex [^\n]*\n +older than repository \(0\.10\.19\)/);
  assert.match(out, /✓ repository /);
  assert.deepEqual(r.issues, ["Claude Code", "Codex"], "only the mismatched installs need fixing");
  assert.deepEqual(r.updates, [
    {
      who: "Claude Code",
      command: "claude plugin marketplace update sphica && claude plugin update sphica@sphica",
      after: "run /reload-plugins in open sessions",
    },
    {
      who: "Codex",
      command: "codex plugin marketplace upgrade sphica && codex plugin add sphica@sphica",
      after: "reopen Codex",
    },
  ]);
});

test("running from an old cached CLI does not call a newer install outdated", () => {
  // An old session's PATH still has bin/ from the replaced cache. Using the CLI as the baseline flips the direction.
  const repository = plugin("r2/plugin", "0.10.19");
  const out = report(
    seen({
      repository,
      cli: plugin("claude/plugins/cache/sphica/sphica/0.10.18b", "0.10.18"),
      claude: plugin("claude/plugins/cache/sphica/sphica/0.10.19", "0.10.19"),
    }),
  );
  assert.match(
    out.lines.find((l) => l.includes("Plugin in this CLI")) ?? "",
    /\n +older than repository \(0\.10\.19\)/,
  );
  // The reason goes on the next line, so no newline means no reason
  assert.doesNotMatch(out.lines.find((l) => l.includes("Claude Code")) ?? "", /\n/);
  assert.deepEqual(out.updates, []);
});

test("with the same version but different content, only the repository CLI shows as newer", () => {
  const repository = plugin("r3/plugin", "0.10.18", "new");
  const r = report(
    seen({
      repository,
      cli: repository,
      codex: [plugin("codex/plugins/cache/sphica/sphica/0.10.18c", "0.10.18", "old")],
    }),
  );
  const out = r.lines.join("\n");
  assert.match(
    out,
    /Codex [^\n]*\n +same version, different contents \(dist\/mcp\.js\)\. Repository changes do not arrive until the version is bumped and merged to main/,
  );
  // The cache is copied again only when the version changes, so updating the host changes nothing.
  assert.deepEqual(r.updates, []);
});

test("when the install is newer, says the checkout is outdated instead of showing update steps", () => {
  const r = report(
    seen({
      repository: plugin("r4/plugin", "0.10.18"),
      claude: plugin("claude4/plugins/cache/sphica/sphica/0.10.19", "0.10.19"),
    }),
  );
  assert.match(
    r.lines.join("\n"),
    /Claude Code [^\n]*\n +newer than the repository \(0\.10\.18\); the repository checkout is old/,
  );
  assert.deepEqual(r.updates, []);
});

test("does not crash without a repository and with a missing Claude install", () => {
  const out = report(
    seen({
      claude: { version: "0.10.18", root: path.join(tmp, "claude5", "missing") },
      codex: [plugin("codex5/plugins/cache/sphica/sphica/0.10.18", "0.10.18")],
    }),
  ).lines.join("\n");
  assert.match(out, /Claude Code [^\n]*\n +The install directory is gone/);
});

test("the running MCP is judged by its launch source and the installed version", () => {
  const installed = plugin("claude2/plugins/cache/sphica/sphica/0.10.19", "0.10.19");
  const older = plugin("claude2/plugins/cache/sphica/sphica/0.10.18", "0.10.18");
  const replaced = plugin("claude2/plugins/cache/sphica/sphica/0.10.17", "0.10.17");
  fs.writeFileSync(path.join(replaced.root, ".orphaned_at"), "1");
  const codexCache = path.join(tmp, "codex2", "plugins", "cache");
  const started = new Date("2026-09-11T00:07:27Z");
  const out = report(
    seen({
      claude: installed,
      codexCache,
      running: [
        { pid: 1, started, root: installed.root, version: "0.10.19" },
        { pid: 2, started, root: older.root, version: "0.10.18" },
        { pid: 3, started, root: replaced.root, version: "0.10.17" },
        {
          pid: 4,
          started,
          root: path.join(codexCache, "sphica", "sphica", "0.10.16"),
          version: "0.10.16",
        },
        { pid: 5, started, root: plugin("work/plugin", "0.10.19").root, version: "0.10.19" },
        // A cache recreated at the same path. The path exists, but the process runs the deleted old directory.
        {
          pid: 6,
          started,
          root: plugin("codex2/plugins/cache/sphica/sphica/0.10.15", "0.10.15").root,
          version: "0.10.15",
          replaced: true,
        },
      ],
    }),
  );
  const line = (pid: number) => out.lines.find((l) => l.includes(`MCP pid ${pid} `)) ?? "";
  assert.doesNotMatch(line(1), /←/);
  assert.match(
    line(2),
    /\n +older than the installed 0\.10\.19\. Fix with \/reload-plugins or a new session/,
  );
  assert.match(line(3), /\n +a version Claude Code replaced on update/);
  assert.match(
    line(4),
    /\n +The start directory is gone, and Skill paths are invalid too\. Fix with reopening Codex/,
  );
  assert.match(line(5), /\n +reads this location directly, not a distributed cache/);
  assert.match(
    line(6),
    /\n +The start directory was recreated in place, and it runs on the removed old version\. Fix with reopening Codex/,
  );
});

test("identifies the running MCP from its launch source and detects a cache recreated in place", async () => {
  // Like Codex, start with root as cwd and a relative path.
  const where = "obs/plugins/cache/sphica/sphica/0.0.1";
  const idle = "setInterval(() => {}, 1000);";
  const { root } = plugin(where, "0.0.1", idle);
  const child = spawn("node", ["./dist/mcp.js"], { cwd: root, stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 500));
    const mine = () => observe(tmp).running?.find((r) => r.pid === child.pid);
    assert.equal(mine()?.version, "0.0.1");
    assert.equal(mine()?.replaced, false);
    // Reinstalling the same version makes Codex recreate the same path. The process still holds the deleted old directory.
    fs.rmSync(root, { recursive: true });
    plugin(where, "0.0.1", idle);
    assert.equal(mine()?.replaced, true);
  } finally {
    child.kill();
  }
});

test("reports a missing install even without a repository", () => {
  const r = report(seen({ claude: { version: "0.10.18", root: path.join(tmp, "claude3", "missing") } }));
  assert.match(
    r.lines.join("\n"),
    /Claude Code [^\n]*\n +The install directory is gone\. Skill paths are invalid too/,
  );
  assert.ok(
    r.updates.some((u) => u.who === "Claude Code"),
    JSON.stringify(r.updates),
  );
});

test("reports unobservable things as unknown, not missing", () => {
  const r = report(seen({ claude: "unknown", running: null }));
  // Running in-process on a terminal colors the markers. Strip them before comparing.
  const out = stripVTControlCharacters(r.lines.join("\n"));
  assert.match(out, /○ Claude Code\s+unknown/);
  assert.match(out, /○ Running MCP\s+unknown/);
  assert.match(out, /○ repository\s+not visible/);
  assert.match(out, /○ Codex\s+not found/);
  assert.deepEqual(r.issues, [], "unobservable items are not counted as fixes");
});

test("sphica --version prints the npm package version", () => {
  const out = execFileSync(process.execPath, [path.join(SRC, "cli.ts"), "--version"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent" },
  });
  assert.equal(out.trim().split(/\s+/)[0], packageVersionAt(REPO_PLUGIN));
});

test("MCP serverInfo reports the manifest version", async () => {
  // Check only initialize, which needs no credentials. The next test connects to a database for tool responses.
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(SRC, "mcp.ts")],
      env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent" },
      stderr: "ignore",
    }),
  );
  try {
    assert.equal(client.getServerVersion()?.version, versionAt(REPO_PLUGIN));
  } finally {
    await client.close();
  }
});

test("MCP tools return failures with isError and a non-empty reason", async () => {
  // A thrown error makes the SDK return only error.message. Return failures with a reason (the same reason() as the CLI).
  // all_projects avoids depending on where it runs. The database points to a missing path (the owner's ~/.sphica stays untouched).
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(SRC, "mcp.ts")],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: "/nonexistent",
        SPHICA_DB: "/nonexistent/sphica.db",
      },
      stderr: "ignore",
    }),
  );
  try {
    const r = await client.callTool({ name: "status", arguments: { cwd: path.join(SRC, "..", "..") } });
    assert.equal(r.isError, true);
    assert.match(JSON.stringify(r.content), /Sphica unavailable: No database at/);
  } finally {
    await client.close();
  }
});

// Users who installed from npm have no repository. The CLI updates with `npm i -g` and the plugin with
// `claude plugin update`, separately, so **without a baseline nobody reports the version gap**.
test("reports a CLI and plugin version gap without a repository", () => {
  const older = report(
    seen({
      cli: plugin("npm-cli-new", "0.15.0"),
      claude: plugin("npm-claude-old/sphica/0.14.0", "0.14.0"),
      codex: [plugin("npm-codex-old/plugins/cache/sphica/sphica/0.14.0", "0.14.0")],
    }),
  ).lines.join("\n");
  assert.match(older, /Claude Code [^\n]*\n +older than this CLI \(0\.15\.0\)/);
  assert.match(older, /Codex [^\n]*\n +older than this CLI \(0\.15\.0\)/);

  // In the other direction (plugin newer), show the steps to upgrade the CLI.
  const newer = report(
    seen({
      cli: plugin("npm-cli-old", "0.14.0"),
      claude: plugin("npm-claude-new/sphica/0.16.0", "0.16.0"),
    }),
  ).lines.join("\n");
  assert.match(newer, /npm i -g sphica@0\.16\.0/);
});

// With the same version, compare content too. Without a repository, suggest reinstalling.
test("without a repository, same version with different content suggests reinstalling", () => {
  const out = report(
    seen({
      cli: plugin("same-cli", "0.15.0", "new"),
      claude: plugin("same-claude/sphica/0.15.0", "0.15.0", "old"),
    }),
  ).lines.join("\n");
  assert.match(out, /same version, different contents.*Reinstall to match/);
});

// Claude Code cuts server instructions and tool descriptions at 2,048 characters (mcp.md in 2.1.280). A cut would
// deliver the search guidance half missing, and nobody would notice.
test("MCP server instructions and tool descriptions fit in 2,048 characters", async () => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(SRC, "mcp.ts")],
      env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", SPHICA_DB: "/nonexistent/sphica.db" },
      stderr: "ignore",
    }),
  );
  try {
    const instructions = client.getInstructions() ?? "";
    assert.ok(instructions.length > 0, "no server instructions");
    assert.ok(
      [...instructions].length <= 2048,
      `server instructions are ${[...instructions].length} characters`,
    );
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["read", "search", "status"]);
    for (const t of tools)
      assert.ok([...(t.description ?? "")].length <= 2048, `${t.name} description is too long`);
  } finally {
    await client.close();
  }
});

// An unregistered project name comes from the remote spelling. Copying it without a length cap goes over the limit.
test("the response fits the limit even with a long unregistered project name", async () => {
  const db = tempDb();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sphica-unreg-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", `https://example.test/o/${"r".repeat(9000)}.git`], {
    cwd: repo,
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(SRC, "mcp.ts")],
      env: { PATH: process.env.PATH ?? "", HOME: "/nonexistent", SPHICA_DB: db.file },
      stderr: "ignore",
    }),
  );
  try {
    const r = await client.callTool({ name: "status", arguments: { cwd: repo } });
    const t = (r.content as { text: string }[])[0]?.text ?? "";
    assert.match(t, /is not registered with Sphica/);
    assert.ok(Buffer.byteLength(t) <= 4096, `${Buffer.byteLength(t)} bytes`);
  } finally {
    await client.close();
    await db.done();
  }
});
