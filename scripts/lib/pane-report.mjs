// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// What the sphica-pane mod may hook and call, held against the notes of claude plugin validate --json (scripts/check-pane.mjs).

/** What validate reports for ./register.tsx, line by line, as the reviewed mod has it */
export const ALLOWED = {
  hooks: [
    "session.start",
    "command.run{command=sphica-pane}",
    "classic.SessionStart",
    "classic.SubagentStart",
    "classic.UserPromptSubmit",
    "classic.UserPromptExpansion",
    "classic.PreToolUse",
    "ui.render{component=Pane, requestId=sphica-delivered}",
  ],
  calls: ["$.command.register", "$.state.get", "$.state.set", "$.ui.open", "$.ui.resolve"],
  "state writes": ["sphica-pane.delivered"],
  "state reads": ["sphica-pane.delivered"],
};

/**
 * The `./<module> <label>: a, b` notes of a validate --json report: register.tsx's as lists by label, and every other module's whole,
 * since the pane ships no other module and one added to hooks.json would otherwise go unchecked
 */
export function reported(report) {
  const notes = (report.contents ?? []).flatMap((c) => c.notes ?? []);
  const register = {};
  const others = [];
  for (const note of notes) {
    const m = /^(\.\/\S+) ([a-z .]+): (.+)$/.exec(note);
    if (!m) continue;
    if (m[1] !== "./register.tsx") {
      others.push(`${m[1]}: a module the pane does not ship (${m[2]}: ${m[3]})`);
      continue;
    }
    // A matcher holds commas inside braces, so split only on commas outside them
    register[m[2]] = m[3].split(/, (?![^{]*\})/).map((s) => s.trim());
  }
  return { register, others };
}

/** The differences between what validate reported and ALLOWED, one line each */
export function differences({ register, others }) {
  const lines = [];
  for (const [label, allowed] of Object.entries(ALLOWED)) {
    const seen = register[label];
    if (!seen) {
      lines.push(`${label}: validate reported none`);
      continue;
    }
    const extra = seen.filter((x) => !allowed.includes(x));
    const missing = allowed.filter((x) => !seen.includes(x));
    if (extra.length) lines.push(`${label}: not allowed ${extra.join(", ")}`);
    if (missing.length) lines.push(`${label}: missing ${missing.join(", ")}`);
  }
  for (const [label, seen] of Object.entries(register))
    if (label.startsWith("gating hook without")) lines.push(`${label}: ${seen.join(", ")}`);
  return [...lines, ...others];
}
