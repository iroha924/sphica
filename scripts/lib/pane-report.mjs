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

/** The `./register.tsx <label>: a, b` notes of a validate --json report, as lists by label */
export function reported(report) {
  const notes = (report.contents ?? []).flatMap((c) => c.notes ?? []);
  const out = {};
  for (const note of notes) {
    const m = /^\.\/register\.tsx ([a-z .]+): (.+)$/.exec(note);
    if (!m) continue;
    // A matcher holds commas inside braces, so split only on commas outside them
    out[m[1]] = m[2].split(/, (?![^{]*\})/).map((s) => s.trim());
  }
  return out;
}

/** The differences between what validate reported and ALLOWED, one line each */
export function differences(got) {
  const lines = [];
  for (const [label, allowed] of Object.entries(ALLOWED)) {
    const seen = got[label];
    if (!seen) {
      lines.push(`${label}: validate reported none`);
      continue;
    }
    const extra = seen.filter((x) => !allowed.includes(x));
    const missing = allowed.filter((x) => !seen.includes(x));
    if (extra.length) lines.push(`${label}: not allowed ${extra.join(", ")}`);
    if (missing.length) lines.push(`${label}: missing ${missing.join(", ")}`);
  }
  for (const [label, seen] of Object.entries(got))
    if (label.startsWith("gating hook without")) lines.push(`${label}: ${seen.join(", ")}`);
  return lines;
}
