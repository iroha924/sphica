// The review evaluation's fixture and expected verdicts: every record a case expects is the set review_select selects for its diff, so a
// run is graded on the records it was asked about. The pinned Biome is checked on the fixture's files before any drafted check is judged by it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { restrictedImports } from "../evals/review/biome.ts";
import { buildReviewFixture, loadReviewCases } from "../evals/review/fixture.ts";
import {
  claudeArgs,
  claudeMcp,
  claudeSettings,
  codexArgs,
  codexMcp,
  READ_TOOLS,
  reviewPrompt,
} from "../evals/review/runner.ts";
import { openReader } from "../src/db.ts";
import { parseDiff, selectForReview } from "../src/review.ts";
import { tempDir } from "./temp-dir.ts";

const OUTCOMES = new Set(["violation", "complies", "unrelated", "undetermined"]);
const cases = loadReviewCases();
const built = buildReviewFixture(tempDir("review-eval-"), cases);

test("each review case expects exactly the records review_select selects for its diff", async () => {
  const fixture = await built;
  const db = openReader(fixture.db);
  try {
    const project = await db.selectFrom("project").select("id").executeTakeFirstOrThrow();
    const active = new Set(
      (await db.selectFrom("unit").select("key").where("lifecycle", "=", "active").execute()).map(
        (u) => u.key,
      ),
    );
    assert.equal(Object.keys(fixture.diffs).length, cases.diffs.length);
    for (const d of cases.diffs) {
      for (const [key, e] of Object.entries(d.expect)) {
        assert.ok(active.has(key), `${d.id}: ${key} is not an active record of the fixture`);
        assert.ok(e.outcomes.length && e.outcomes.every((o) => OUTCOMES.has(o)), `${d.id}: ${key} outcomes`);
        // A question is an undetermined verdict, and an undetermined one that needs no question is a note
        if (e.question) assert.deepEqual(e.outcomes, ["undetermined"], `${d.id}: ${key}`);
      }
      const text = fs.readFileSync(fixture.diffs[d.id] ?? "", "utf8");
      const selected = await selectForReview(db, project.id, parseDiff(text));
      assert.deepEqual(selected.map((u) => u.key).sort(), Object.keys(d.expect).sort(), d.id);
    }
  } finally {
    await db.destroy();
  }
});

const ban = (patterns: { group: string[]; message: string }[]) => ({
  level: "error",
  options: { patterns },
});
const LODASH = { group: ["lodash", "lodash/**"], message: "Use the standard library" };
const DB = { group: ["**/db.ts", "**/db"], message: "Go through src/library.ts" };
const config = (overrideBans: (typeof LODASH)[] | null) => ({
  linter: {
    enabled: true,
    rules: { preset: "none", style: { noRestrictedImports: ban([LODASH]) } },
  },
  ...(overrideBans
    ? {
        overrides: [
          {
            includes: ["src/ui/**"],
            linter: { rules: { style: { noRestrictedImports: ban(overrideBans) } } },
          },
        ],
      }
    : {}),
});

test("the pinned Biome enforces a direct import ban and a module ban on the fixture, real imports only", async () => {
  const fixture = await built;
  const dir = tempDir("review-biome-");
  fs.cpSync(fixture.repo, dir, { recursive: true, filter: (src) => path.basename(src) !== ".git" });
  const write = (rel: string, text: string) => fs.writeFileSync(path.join(dir, rel), text);
  write("src/lodash-real.ts", 'import debounce from "lodash/debounce";\nexport const d = debounce;\n');
  write("src/lodash-said.ts", '// lodash is not used here\nexport const s = "import _ from \\"lodash\\"";\n');
  write("src/ui/db-real.ts", 'import { open } from "../db.ts";\nexport const o = open;\n');
  write("src/ui/lodash-real.ts", 'import debounce from "lodash/debounce";\nexport const d = debounce;\n');
  fs.appendFileSync(
    path.join(dir, "docs", "storage.md"),
    '\nNever `import { open } from "../db.ts"` in src/ui.\n',
  );
  const flagged = () =>
    restrictedImports(dir)
      .map((r) => `${r.path}:${r.line}`)
      .sort();

  // Template 1 alone: lodash anywhere; a comment, a string, and the docs do not count
  write("biome.json", JSON.stringify(config(null)));
  assert.deepEqual(flagged(), ["src/lodash-real.ts:1", "src/ui/lodash-real.ts:1"]);

  // Template 2 repeats the project-wide bans: src/ui reaches src/db.ts only through src/library.ts, which may import it
  write("biome.json", JSON.stringify(config([LODASH, DB])));
  assert.deepEqual(flagged(), ["src/lodash-real.ts:1", "src/ui/db-real.ts:1", "src/ui/lodash-real.ts:1"]);

  // An override's options replace the project-wide ones, so a module ban that does not repeat them lets lodash into src/ui
  write("biome.json", JSON.stringify(config([DB])));
  assert.deepEqual(flagged(), ["src/lodash-real.ts:1", "src/ui/db-real.ts:1"]);

  // A config Biome cannot read is a failure, never an empty report
  write("biome.json", "{ not json");
  assert.throws(() => restrictedImports(dir), /biome/);
});

test("a lane starts with only the read tools, no hooks, its own database, and the reviewer cannot write", () => {
  const p = {
    work: "/w",
    diff: "/w/.git/review.diff",
    db: "/r/db/sphica.db",
    home: "/r/home",
    server: "/s/mcp.js",
  };
  const settings = claudeSettings() as {
    permissions: { blockReadsOutsideWorkingDirectories: boolean; allow: string[] };
    hooks: Record<string, unknown>;
  };
  assert.equal(settings.permissions.blockReadsOutsideWorkingDirectories, true);
  assert.deepEqual(settings.permissions.allow, READ_TOOLS);
  assert.deepEqual(settings.hooks, {});
  const args = claudeArgs({ settings: "/r/settings.json", mcp: "/r/mcp.json" }, "m");
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(after("--tools"), "Read,Grep,Glob");
  assert.equal(after("--setting-sources"), "project");
  assert.ok(args.includes("--strict-mcp-config") && args.includes("--no-session-persistence"));
  assert.ok(!args.includes("--permission-mode"), "no mode that accepts edits");
  // The database reaches the MCP child itself, never through the reviewer's environment
  assert.deepEqual(claudeMcp(p).mcpServers.sphica, {
    command: process.execPath,
    args: ["/s/mcp.js"],
    env: { SPHICA_DB: "/r/db/sphica.db", SPHICA_HOME: "/r/home", HOME: "/r/home" },
  });
  assert.match(codexMcp(p), /SPHICA_DB = "\/r\/db\/sphica\.db"/);
  const codex = codexArgs("/w", "/r/final.md");
  assert.equal(codex[codex.indexOf("-s") + 1], "read-only");
  assert.ok(codex.includes("--ephemeral") && codex.includes("--ignore-rules"));
  const prompt = reviewPrompt("BODY\n", p);
  assert.ok(prompt.startsWith("BODY\n"), "the aspect body comes first, in full");
  assert.match(prompt, /Read the file \/w\/\.git\/review\.diff/);
  assert.match(prompt, /\| Uncommitted, tracked \| empty \|\n\| Untracked \| empty \|/);
});
