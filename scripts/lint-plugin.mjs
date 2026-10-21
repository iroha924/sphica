// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// The repository's own lint rules, loaded by Oxlint through jsPlugins in .oxlintrc.json. Each message says what broke, why, and the fix.
// SQL files are outside what Oxlint reads, so check-comments.mjs and check-sql.mjs keep those from the same tables.

import path from "node:path";
import { REFERENCE_RULE, referenceProblems } from "./lib/comment-refs.mjs";
import { ruleMessage } from "./lib/finding.mjs";
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
          (callee.computed ? callee.property.value : callee.property.name) === modifier
        )
          context.report({ node: callee.property, message });
      },
    };
  },
});

/** The checks whose failures go through scripts/lib/finding.mjs: every check script, and the unit runner that verify runs */
const CHECK_SCRIPT = /^scripts\/(?:check-[^/]+|run-unit)\.mjs$/;
const OUTSIDE_FINDING = ruleMessage({
  what: "the check prints, throws, or fails outside scripts/lib/finding.mjs",
  why: "every check failure names where, what broke, why, and the fix, so it can be fixed from the line alone",
  fix: "build it with finding() and print it with report(), or stop with fail()",
});
const GUARD_FIRST = ruleMessage({
  what: "the first statement after the imports is not guard()",
  why: "an error before guard() runs, argument parsing included, prints as a bare stack with no where, why, or fix",
  fix: 'call guard("<check name>") right after the imports',
});
/** `a.b` as written, for a member expression of two plain names */
const dotted = (node) =>
  node?.type === "MemberExpression" &&
  !node.computed &&
  node.object.type === "Identifier" &&
  node.property.type === "Identifier"
    ? `${node.object.name}.${node.property.name}`
    : null;

/** Oxlint loads this through jsPlugins; the tests read its rule names */
export default {
  meta: { name: "sphica" },
  rules: {
    "no-skipped-tests": modifierRule(
      "skip",
      ruleMessage({
        what: "the test is skipped",
        why: "a skipped test stays green in CI while checking nothing (invariant no-silent-skip)",
        fix: "fix the test, or delete it and say why in the commit",
      }),
    ),
    "no-focused-tests": modifierRule(
      "only",
      ruleMessage({
        what: "the test is focused with `.only`",
        why: "`.only` leaves the other tests in the file unrun",
        fix: "remove `.only` before committing",
      }),
    ),
    "comment-refs": {
      create(context) {
        return {
          Program() {
            for (const p of referenceProblems(context.sourceCode.text, "js")) {
              context.report({
                loc: lineLoc(p.line),
                message: ruleMessage({ what: `the comment points at ${p.reason}`, ...REFERENCE_RULE }),
              });
            }
          },
        };
      },
    },
    "check-findings": {
      create(context) {
        const file = path.relative(context.cwd, context.filename).split(path.sep).join("/");
        if (!CHECK_SCRIPT.test(file)) return {};
        const report = (node) => context.report({ node, message: OUTSIDE_FINDING });
        return {
          Program(node) {
            const first = node.body.find((st) => st.type !== "ImportDeclaration");
            const call = first?.type === "ExpressionStatement" ? first.expression : null;
            if (
              !(
                call?.type === "CallExpression" &&
                call.callee.type === "Identifier" &&
                call.callee.name === "guard"
              )
            )
              context.report({ node: first ?? node, message: GUARD_FIRST });
          },
          CallExpression(node) {
            const callee = dotted(node.callee);
            if (callee === "console.error" || callee === "console.warn") report(node);
            if (dotted(node.callee.object) === "process.stderr" && node.callee.property?.name === "write")
              report(node);
            // Exiting with a failure skips report(); 0 and no argument end a check that passed or had nothing to do
            if (
              callee === "process.exit" &&
              node.arguments.length &&
              !(node.arguments[0].type === "Literal" && node.arguments[0].value === 0)
            )
              report(node);
          },
          ThrowStatement: report,
          AssignmentExpression(node) {
            if (dotted(node.left) === "process.exitCode") report(node);
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
              context.report({ loc: lineLoc(p.line), message: ruleMessage(p) });
            }
          },
        };
      },
    },
  },
};
