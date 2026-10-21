// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The repository's own lint rules, loaded by Oxlint through jsPlugins in .oxlintrc.json. Each message says what to write instead.
// SQL files are outside what Oxlint reads, so check-comments.mjs and check-sql.mjs keep those from the same tables.

import path from "node:path";
import { referenceProblems } from "./lib/comment-refs.mjs";
import { sqlStyleProblems } from "./lib/sql-style.mjs";

const lineLoc = (line) => ({ start: { line, column: 0 }, end: { line, column: 0 } });

/** node:test's names: the jest plugin's rules see only globals, and the tests import these from node:test */
const TEST_CALLS = new Set(["test", "it", "describe", "suite"]);

/** A rule reporting `test.<modifier>(...)` and the like, with the message given */
const modifierRule = (modifier, message) => ({
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === "MemberExpression" &&
          callee.object.type === "Identifier" &&
          TEST_CALLS.has(callee.object.name) &&
          !callee.computed &&
          callee.property.name === modifier
        )
          context.report({ node: callee.property, message });
      },
    };
  },
});

/** Oxlint loads this through jsPlugins; the tests read its rule names */
export default {
  meta: { name: "sphica" },
  rules: {
    "no-skipped-tests": modifierRule(
      "skip",
      "A skipped test stays green in CI. Fix the test, or delete it and say why in the commit.",
    ),
    "no-focused-tests": modifierRule(
      "only",
      "`.only` leaves the other tests in the file unrun. Remove it before committing.",
    ),
    "comment-refs": {
      create(context) {
        return {
          Program() {
            for (const p of referenceProblems(context.sourceCode.text, "js")) {
              context.report({
                loc: lineLoc(p.line),
                message: `The comment points at ${p.reason}. Write the reason itself instead of where it was discussed.`,
              });
            }
          },
        };
      },
    },
    "sql-style": {
      create(context) {
        const file = path.relative(context.cwd, context.filename).split(path.sep).join("/");
        if (!file.startsWith("server/src/") && !file.startsWith("server/test/")) return {};
        return {
          Program() {
            for (const p of sqlStyleProblems(file, context.sourceCode.text)) {
              context.report({ loc: lineLoc(p.line), message: p.why });
            }
          },
        };
      },
    },
  },
};
