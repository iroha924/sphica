import assert from "node:assert/strict";
import { test } from "node:test";
import { checkBundles } from "../../scripts/lib/bundle-budget.mjs";

const meta = (
  bytes: unknown,
  inputs: string[] = ["server/src/deliver.ts"],
  name = "plugin/dist/deliver.js",
) => ({
  outputs: { [name]: { bytes, inputs: Object.fromEntries(inputs.map((i) => [i, { bytesInOutput: 1 }])) } },
});
const budgets = { deliver: 1000, mcp: 5000 };

test("bundles within budget, with zod only outside the hooks, pass", () => {
  assert.deepEqual(
    checkBundles(
      {
        deliver: meta(900),
        mcp: meta(4000, ["server/node_modules/zod/v4/core/core.js"], "plugin/dist/mcp.js"),
      },
      budgets,
    ),
    [],
  );
});

test("a bundle over its budget fails", () => {
  assert.deepEqual(checkBundles({ deliver: meta(1001), mcp: meta(10, [], "plugin/dist/mcp.js") }, budgets), [
    "deliver: plugin/dist/deliver.js is 1001 bytes, over its budget of 1000",
  ]);
});

test("zod in a hook bundle fails, whichever path separator the metafile uses", () => {
  for (const zod of [
    "server/node_modules/zod/v4/classic/schemas.js",
    "server\\node_modules\\zod\\index.js",
  ]) {
    const problems = checkBundles(
      { deliver: meta(10, [zod]), mcp: meta(10, [], "plugin/dist/mcp.js") },
      budgets,
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? "", /^deliver: .* bundles zod/);
  }
});

test("a missing or empty metafile, a missing .js output, or a bad byte count fails", () => {
  const ok = meta(10, [], "plugin/dist/mcp.js");
  assert.deepEqual(checkBundles({ mcp: ok }, budgets), ["deliver: no metafile with outputs"]);
  assert.deepEqual(checkBundles({ deliver: null, mcp: ok }, budgets), ["deliver: no metafile with outputs"]);
  assert.deepEqual(checkBundles({ deliver: { outputs: {} }, mcp: ok }, budgets), [
    "deliver: the metafile lists no .js output",
  ]);
  assert.deepEqual(checkBundles({ deliver: meta(10, [], "plugin/dist/deliver.js.map"), mcp: ok }, budgets), [
    "deliver: the metafile lists no .js output",
  ]);
  for (const bytes of [undefined, Number.NaN, Number.POSITIVE_INFINITY, "10"])
    assert.deepEqual(checkBundles({ deliver: meta(bytes), mcp: ok }, budgets), [
      "deliver: plugin/dist/deliver.js has no byte count",
    ]);
});

test("an entry built without a budget fails", () => {
  assert.deepEqual(
    checkBundles({ deliver: meta(10), mcp: meta(10, [], "plugin/dist/mcp.js"), extra: meta(10) }, budgets),
    ["extra: built but has no budget"],
  );
});
