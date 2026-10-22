// Copyright (c) 2026 iroha924 and contributors
// SPDX-License-Identifier: MIT

// What the sphica-pane mod may hook and call, held against claude plugin validate --json, and where the marketplace installs it from.

const CLASSIC = [
  "classic.SessionStart",
  "classic.SubagentStart",
  "classic.UserPromptSubmit",
  "classic.UserPromptExpansion",
  "classic.PreToolUse",
];

/**
 * Every note validate prints for the reviewed mod, whole. A new hook, call, state key, or module adds or changes a note, so the check
 * compares the notes exactly instead of parsing them: a shape it does not know cannot slip past.
 */
export const EXPECTED_NOTES = [
  `./register.tsx hooks: session.start, command.run{command=sphica-pane}, ${CLASSIC.join(", ")}, ui.render{component=Pane, requestId=sphica-delivered}`,
  `./register.tsx hooks on ${CLASSIC.join(", ")} do not run in a plugin a person installs where an organization manages Claude Code: there, these events pass over the plugins you install, and only a plugin the organization lists in managed settings runs them`,
  "./register.tsx answers its own command: command.run{command=sphica-pane}",
  ...CLASSIC.map((event) => `./register.tsx gating hook with .catch: ${event}`),
  "./register.tsx calls: $.command.register, $.state.get, $.state.set, $.ui.open, $.ui.resolve",
  "./register.tsx state writes: sphica-pane.delivered",
  "./register.tsx state reads: sphica-pane.delivered",
];

/** How validate --json's report differs from the one hooks file with EXPECTED_NOTES, one line each */
export function noteProblems(report) {
  const contents = Array.isArray(report?.contents) ? report.contents : [];
  if (contents.length !== 1 || contents[0]?.type !== "hooks")
    return [`validate checked ${JSON.stringify(contents.map((c) => c?.type))}, not one hooks file`];
  const notes = Array.isArray(contents[0].notes) ? contents[0].notes : [];
  return [
    ...notes.filter((n) => !EXPECTED_NOTES.includes(n)).map((n) => `unexpected note: ${n}`),
    ...EXPECTED_NOTES.filter((n) => !notes.includes(n)).map((n) => `missing note: ${n}`),
  ];
}

export const PANE_SOURCE = {
  source: "git-subdir",
  url: "https://github.com/iroha924/sphica.git",
  path: "pane",
};

/** What is wrong with the marketplace's sphica-pane entry for a release of `version`, one line each */
export function entryProblems(marketplace, version) {
  const entry = Array.isArray(marketplace?.plugins)
    ? marketplace.plugins.find((p) => p?.name === "sphica-pane")
    : undefined;
  if (!entry) return ["no sphica-pane entry"];
  const source = entry.source ?? {};
  const lines = [];
  for (const [key, want] of Object.entries(PANE_SOURCE))
    if (source[key] !== want)
      lines.push(`source.${key} is ${JSON.stringify(source[key])}, not ${JSON.stringify(want)}`);
  if (source.ref !== `v${version}`)
    lines.push(`source.ref is ${JSON.stringify(source.ref)}, not "v${version}"`);
  // A sha would pin a commit the tag may not point to, and the release cannot write its own commit's sha
  if ("sha" in source) lines.push("source.sha is set");
  if ("version" in entry)
    lines.push("the entry sets a version, which Claude Code would prefer over the pane's plugin.json");
  return lines;
}
