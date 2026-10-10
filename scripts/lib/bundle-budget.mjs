// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// Checks the shipped bundles against bun's metafiles: each entry built, its size within a reviewed budget, and zod kept out of
// the hooks, which start on every prompt and tool call.

/** Bytes per entry. Raise one only in a commit that says why the bundle grew. */
const BUDGETS = {
  mcp: 1_779_000,
  "mcp-record": 1_857_000,
  capture: 393_000,
  deliver: 445_000,
  cli: 625_000,
  "git-worker": 13_000,
};

/** Entries that start on every prompt and tool call: the hooks, and the git worker they start to compare the work tree */
const HOOKS = new Set(["capture", "deliver", "git-worker"]);

/**
 * Problems with the built bundles. metas maps each entry to its parsed metafile, or null when the file was missing or unreadable.
 * @param {Record<string, unknown>} metas
 * @param {Record<string, number>} budgets
 * @returns {string[]}
 */
export function checkBundles(metas, budgets = BUDGETS) {
  const problems = [];
  for (const [entry, budget] of Object.entries(budgets)) {
    const meta = metas[entry];
    const outputs = meta && typeof meta === "object" ? meta.outputs : undefined;
    if (!outputs || typeof outputs !== "object") {
      problems.push(`${entry}: no metafile with outputs`);
      continue;
    }
    const js = Object.entries(outputs).filter(
      ([name]) => name.replaceAll("\\", "/").split("/").pop() === `${entry}.js`,
    );
    if (!js.length) {
      problems.push(`${entry}: the metafile lists no ${entry}.js output`);
      continue;
    }
    for (const [name, out] of js) {
      const bytes = out?.bytes;
      if (typeof bytes !== "number" || !Number.isFinite(bytes))
        problems.push(`${entry}: ${name} has no byte count`);
      else if (bytes > budget)
        problems.push(`${entry}: ${name} is ${bytes} bytes, over its budget of ${budget}`);
      if (HOOKS.has(entry) && (!out?.inputs || typeof out.inputs !== "object"))
        problems.push(`${entry}: ${name} lists no inputs, so zod cannot be ruled out`);
      else if (HOOKS.has(entry)) {
        const zod = Object.keys(out.inputs).find((p) =>
          p.replaceAll("\\", "/").includes("node_modules/zod/"),
        );
        if (zod)
          problems.push(`${entry}: ${name} bundles zod (${zod}); hooks start on every prompt and tool call`);
      }
    }
  }
  for (const entry of Object.keys(metas))
    if (!(entry in budgets)) problems.push(`${entry}: built but has no budget`);
  return problems;
}
