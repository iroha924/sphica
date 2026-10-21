// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The repository's own lint rules, loaded by Oxlint through jsPlugins in .oxlintrc.json. Each message says what to write instead.
// SQL files are outside what Oxlint reads, so check-comments.mjs and check-sql.mjs keep those from the same tables.

import path from "node:path";
import { referenceProblems } from "./lib/comment-refs.mjs";
import { sqlStyleProblems } from "./lib/sql-style.mjs";

const lineLoc = (line) => ({ start: { line, column: 0 }, end: { line, column: 0 } });

/** @public Oxlint imports it; nothing in the repository does */
export default {
  meta: { name: "sphica" },
  rules: {
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
