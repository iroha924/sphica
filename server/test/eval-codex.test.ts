// The read fence every evaluation Codex starts with: the profile its CODEX_HOME selects, what it denies, the digest that tells one policy
// from another across machines, and the lock that keeps two fenced Codex processes from reading each other's checkout.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  codexLock,
  evalCache,
  fenceDigest,
  fencedCodexHome,
  requireInside,
} from "../evals/cloud/codex-home.ts";
import { RUNNER_FILES } from "../evals/review/runner.ts";
import { tempDir } from "./temp-dir.ts";

test("a fenced CODEX_HOME selects the profile before any table, denies its own login, and keeps the given settings", () => {
  const home = path.join(tempDir("codex-fence-"), "codex-home");
  const { denied } = fencedCodexHome(home, {
    base: ":workspace",
    deny: ["/evals", "/cache"],
    extraConfig: '\n[mcp_servers.sphica]\ncommand = "node"\n',
    settings: 'model = "m"',
    managed: [],
  });
  const config = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  assert.deepEqual(denied, ["/evals", "/cache", path.join(home, "auth.json")]);
  assert.ok(config.startsWith('model = "m"\n'), "the settings snapshot is written as given");
  assert.ok(config.indexOf("default_permissions") < config.indexOf("[permissions.eval]"));
  assert.ok(config.indexOf("[permissions.eval]") < config.indexOf("[mcp_servers.sphica]"));
  assert.match(config, new RegExp(`^${JSON.stringify(path.join(home, "auth.json"))} = "deny"$`, "m"));
  assert.match(config, /^extends = ":workspace"$/m);
  assert.throws(
    () =>
      fencedCodexHome(path.join(tempDir("codex-fence-"), "h"), {
        base: ":read-only",
        deny: [],
        settings: "",
        managed: ["/etc/codex/config.toml"],
      }),
    /administrator settings/,
  );
});

test("the fence digest names places by role, so the same policy elsewhere compares equal and another policy does not", () => {
  const profile = (home: string, cache: string) =>
    fencedCodexHome(path.join(home, "codex-home"), {
      base: ":workspace",
      deny: [cache, `${home}/.ssh`],
      settings: "",
      managed: [],
    }).profile;
  const a = tempDir("fence-a-");
  const b = tempDir("fence-b-");
  const roles = (home: string) => ({
    "<codex-home>": path.join(home, "codex-home"),
    "<cache>": `${home}/cache`,
    "<home>": home,
  });
  const da = fenceDigest(profile(a, `${a}/cache`), roles(a));
  assert.equal(da, fenceDigest(profile(b, `${b}/cache`), roles(b)));
  const c = tempDir("fence-c-");
  const readOnly = fencedCodexHome(path.join(c, "codex-home"), {
    base: ":read-only",
    deny: [`${c}/cache`, `${c}/.ssh`],
    settings: "",
    managed: [],
  }).profile;
  assert.notEqual(da, fenceDigest(readOnly, roles(c)));
});

test("only one fenced Codex evaluation runs at a time, and outputs must sit inside the denied cache", () => {
  const home = tempDir("fence-lock-");
  const cache = evalCache(home);
  const release = codexLock(cache);
  assert.throws(() => codexLock(cache), /another fenced Codex evaluation holds .*"pid":/);
  release();
  codexLock(cache)();
  const inside = path.join(cache, "codex-runs");
  fs.mkdirSync(inside);
  assert.equal(requireInside(cache, inside, "--out"), inside);
  assert.throws(() => requireInside(cache, home, "--out"), /must be inside/);
  assert.throws(() => requireInside(cache, cache, "--out"), /must be inside/);
  // A sibling that shares the cache's name as a prefix is outside it
  fs.mkdirSync(`${cache}-other`);
  assert.throws(() => requireInside(cache, `${cache}-other`, "--out"), /must be inside/);
  const link = path.join(cache, "link-out");
  fs.symlinkSync(home, link);
  assert.throws(() => requireInside(cache, link, "--out"), /must be inside/);
});

test("review's runner identity covers the shared fence", () => {
  assert.ok(RUNNER_FILES.includes("../cloud/codex-home.ts"));
});
