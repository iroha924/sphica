import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { type HookState, hookTrust, readHookStates, sha256, type TrustResult } from "../src/codex-trust.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "codex-trust");
const SHIPPED = fs.readFileSync(
  path.join(import.meta.dirname, "..", "..", "plugin", "hooks", "codex.json"),
  "utf8",
);
const OLD = fs.readFileSync(path.join(FIXTURES, "codex-0.6.30.json"), "utf8");
const ID = "sphica@sphica";
const REL = "hooks/codex.json";
// The placeholder as codex.json writes it, joined so the source holds no template-looking literal
const ROOT = ["$", "{PLUGIN_ROOT}"].join("");

const states = (toml: string | null): Map<string, HookState> => {
  const s = readHookStates(toml);
  assert.ok(s instanceof Map, JSON.stringify(s));
  return s;
};
const hooksOf = (r: TrustResult) => {
  assert.ok("hooks" in r, JSON.stringify(r));
  return r.hooks;
};
/** One event with the given groups, as a hooks file. */
const file = (event: string, groups: unknown[]) => JSON.stringify({ hooks: { [event]: groups } });
const hashOf = (json: string, platform: NodeJS.Platform = "darwin") =>
  hooksOf(hookTrust(json, ID, REL, platform, new Map()))[0]?.hash;

test("Codex 0.160.0's own trusted hashes for Sphica 0.6.30 all match: the rule here is Codex's", () => {
  const hooks = hooksOf(
    hookTrust(
      OLD,
      ID,
      REL,
      "darwin",
      states(fs.readFileSync(path.join(FIXTURES, "config-0.160.0.toml"), "utf8")),
    ),
  );
  assert.equal(hooks.length, 9);
  assert.deepEqual(
    hooks.filter((h) => h.trust !== "trusted" || !h.enabled).map((h) => h.key),
    [],
  );
});

test("hand-written canonical identities hash the same as the computed ones, on POSIX and on Windows", () => {
  const posix = `{"event_name":"user_prompt_submit","hooks":[{"async":false,"command":"node \\"${ROOT}/dist/capture.js\\" codex","timeout":10,"type":"command"}]}`;
  const old = hooksOf(hookTrust(OLD, ID, REL, "darwin", new Map()));
  assert.equal(old.find((h) => h.key === `${ID}:${REL}:user_prompt_submit:0:0`)?.hash, sha256(posix));
  const withMatcher = `{"event_name":"pre_tool_use","hooks":[{"async":false,"command":"node \\"${ROOT}/dist/deliver.js\\" codex","timeout":5,"type":"command"}],"matcher":"^apply_patch$|^Bash$"}`;
  assert.equal(old.find((h) => h.key === `${ID}:${REL}:pre_tool_use:0:0`)?.hash, sha256(withMatcher));

  // The Windows command as shipped: base64 of the fixed launch script for capture.js
  const windows =
    '{"event_name":"user_prompt_submit","hooks":[{"async":false,"command":"powershell.exe -NoProfile -NonInteractive -EncodedCommand JgAgAG4AbwBkAGUAIAAiACQAZQBuAHYAOgBQAEwAVQBHAEkATgBfAFIATwBPAFQALwBkAGkAcwB0AC8AYwBhAHAAdAB1AHIAZQAuAGoAcwAiACAAYwBvAGQAZQB4ADsAIABpAGYAIAAoACQAbgB1AGwAbAAgAC0AZQBxACAAJABMAEEAUwBUAEUAWABJAFQAQwBPAEQARQApACAAewAgAGUAeABpAHQAIAAxACAAfQA7ACAAZQB4AGkAdAAgACQATABBAFMAVABFAFgASQBUAEMATwBEAEUA","timeout":10,"type":"command"}]}';
  const shipped = hooksOf(hookTrust(SHIPPED, ID, REL, "win32", new Map()));
  assert.equal(shipped.find((h) => h.key === `${ID}:${REL}:user_prompt_submit:0:0`)?.hash, sha256(windows));
});

test("only Windows sees a different definition after the Windows hooks changed", () => {
  const before = (p: NodeJS.Platform) => hooksOf(hookTrust(OLD, ID, REL, p, new Map())).map((h) => h.hash);
  const after = (p: NodeJS.Platform) => hooksOf(hookTrust(SHIPPED, ID, REL, p, new Map())).map((h) => h.hash);
  assert.deepEqual(after("darwin"), before("darwin"));
  assert.deepEqual(after("linux"), before("linux"));
  assert.ok(after("win32").every((h, i) => h !== before("win32")[i]));
});

test("timeouts are normalized as Codex does before hashing", () => {
  const cmd = (extra: object) => ({ type: "command", command: "x", ...extra });
  const same = (event: string, a: object, b: object) =>
    assert.equal(
      hashOf(file(event, [{ hooks: [cmd(a)] }])),
      hashOf(file(event, [{ hooks: [cmd(b)] }])),
      `${event} ${JSON.stringify(a)}`,
    );
  const differ = (event: string, a: object, b: object) =>
    assert.notEqual(
      hashOf(file(event, [{ hooks: [cmd(a)] }])),
      hashOf(file(event, [{ hooks: [cmd(b)] }])),
      `${event} ${JSON.stringify(a)}`,
    );
  same("Stop", {}, { timeout: 600 });
  same("Stop", { timeout: 0 }, { timeout: 1 });
  same("Stop", { timeout: null }, { timeout: 600 });
  differ("Stop", { timeout: 5 }, { timeout: 600 });
  same("Interrupt", {}, { timeout: 1 });
  same("Interrupt", { timeout: 0 }, { timeout: 1 });
  same("Interrupt", { timeout: 5 }, { timeout: 3 });
  differ("Interrupt", { timeout: 2 }, { timeout: 3 });
  same("Stop", {}, { async: false });
  differ("Stop", {}, { async: true });
  differ("Stop", {}, { statusMessage: "saving" });
  same("Stop", {}, { statusMessage: null });
  // Only events that can return context keep the limit, and the default 2500 is dropped
  same("UserPromptSubmit", {}, { additionalContextLimit: 2500 });
  differ("UserPromptSubmit", {}, { additionalContextLimit: 100 });
  same("Stop", {}, { additionalContextLimit: 100 });
  // commandWindows is never part of the hash, only which command is chosen
  same("Stop", {}, { commandWindows: "other" });
});

test("matchers count only where Codex reads them, and keys carry group and handler positions", () => {
  const h = { type: "command", command: "x" };
  assert.equal(hashOf(file("Stop", [{ matcher: "a", hooks: [h] }])), hashOf(file("Stop", [{ hooks: [h] }])));
  assert.notEqual(
    hashOf(file("PreToolUse", [{ matcher: "a", hooks: [h] }])),
    hashOf(file("PreToolUse", [{ hooks: [h] }])),
  );
  const keys = hooksOf(
    hookTrust(file("PreToolUse", [{ hooks: [h] }, { hooks: [h, h] }]), ID, REL, "darwin", new Map()),
  ).map((x) => x.key);
  assert.deepEqual(
    keys,
    ["0:0", "1:0", "1:1"].map((at) => `${ID}:${REL}:pre_tool_use:${at}`),
  );
  // On Windows commandWindows is the command, else command
  assert.equal(
    hashOf(file("Stop", [{ hooks: [{ ...h, commandWindows: "y" }] }]), "win32"),
    hashOf(file("Stop", [{ hooks: [{ ...h, command: "y" }] }]), "win32"),
  );
});

test("states: a matching hash is trusted, another is modified, none is untrusted, and enabled is separate", () => {
  const json = file("Stop", [{ hooks: [{ type: "command", command: "x" }] }]);
  const key = `${ID}:${REL}:stop:0:0`;
  const hash = hashOf(json);
  const one = (toml: string) => hooksOf(hookTrust(json, ID, REL, "darwin", states(toml)))[0];
  assert.deepEqual(one(`[hooks.state."${key}"]\ntrusted_hash = "${hash}"\n`), {
    key,
    hash,
    trust: "trusted",
    enabled: true,
  });
  assert.equal(one(`[hooks.state."${key}"]\ntrusted_hash = "sha256:00"\n`)?.trust, "modified");
  assert.equal(one(`[hooks.state."${key}"]\ntrusted_hash = ""\n`)?.trust, "modified");
  assert.equal(one("")?.trust, "untrusted");
  assert.deepEqual(one(`[hooks.state."${key}"]\ntrusted_hash = "${hash}"\nenabled = false\n`), {
    key,
    hash,
    trust: "trusted",
    enabled: false,
  });
  // Keys are trimmed, dotted keys and inline tables are the same table, and an entry of the wrong type is skipped
  assert.equal(one(`[hooks.state." ${key} "]\ntrusted_hash = "${hash}"\n`)?.trust, "trusted");
  assert.equal(one(`hooks.state."${key}".trusted_hash = "${hash}"\n`)?.trust, "trusted");
  assert.equal(one(`[hooks]\nstate = { "${key}" = { trusted_hash = "${hash}" } }\n`)?.trust, "trusted");
  assert.equal(one(`[hooks.state."${key}"]\ntrusted_hash = 1\n`)?.trust, "untrusted");
  assert.deepEqual(readHookStates(null), new Map());
});

test("what Sphica does not ship, and config it cannot read, is unknown, never a count that leaves hooks out", () => {
  const unknown = (json: string) =>
    assert.ok("unknown" in hookTrust(json, ID, REL, "darwin", new Map()), json);
  unknown("not json");
  unknown(JSON.stringify({ hooks: {} }));
  unknown(JSON.stringify({}));
  unknown(file("Stop", [{ hooks: [{ type: "prompt" }] }]));
  unknown(file("Stop", [{ hooks: [{ type: "mcp_tool", server: "s", tool: "t" }] }]));
  unknown(file("Somewhere", [{ hooks: [{ type: "command", command: "x" }] }]));
  unknown(file("Stop", [{ hooks: [{ type: "command", command: "  " }] }]));
  unknown(file("Stop", [{ hooks: [{ type: "command", command: "x", timeout: "5" }] }]));
  unknown(file("Stop", [{ hooks: [{ type: "command", command: "x", async: null }] }]));
  assert.ok("unknown" in readHookStates("[hooks\nstate = 1"));
  assert.ok("unknown" in readHookStates("[hooks]\nstate = 1\n"));
});

test("a definition Codex cannot read, and a state key Codex trims differently, are never trusted", () => {
  const h = { type: "command", command: "x" };
  const json = file("Stop", [{ hooks: [h] }]);
  const key = `${ID}:${REL}:stop:0:0`;
  const hash = hashOf(json);
  const unknown = (text: string) =>
    assert.ok("unknown" in hookTrust(text, ID, REL, "darwin", new Map()), text);
  // Both names of the Windows command are one field to Codex, so naming it twice fails the whole file
  unknown(file("Stop", [{ hooks: [{ ...h, commandWindows: "y", command_windows: "y" }] }]));
  // Codex reads timeout as a whole number, and 600.0 is not one to it even though JSON.parse makes it 600
  unknown(json.replace('"command":"x"', '"command":"x","timeout":600.0'));
  unknown(json.replace('"command":"x"', '"command":"x","timeout":6e2'));
  // Codex trims keys with Rust's whitespace: U+FEFF stays part of the key, U+0085 goes
  const at = (k: string) =>
    hooksOf(hookTrust(json, ID, REL, "darwin", states(`[hooks.state."${k}"]\ntrusted_hash = "${hash}"\n`)))[0]
      ?.trust;
  assert.equal(at(`\\uFEFF${key}`), "untrusted");
  assert.equal(at(`\\u0085${key}`), "trusted");
});
