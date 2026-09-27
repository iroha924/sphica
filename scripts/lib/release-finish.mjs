// Pure parts of release-finish: reading the Release notes out of a PR body and finding the merge commit of a released tag.

/** The body of the PR's `## Release notes` section without HTML comments, or null when it is missing or empty. */
export function releaseNotes(body) {
  // Remove comments until none is left, so nested markers cannot leave an opening `<!--` behind
  let text = String(body ?? "").replace(/\r/g, "");
  for (let previous = ""; previous !== text; ) {
    previous = text;
    text = text.replace(/<!--[\s\S]*?-->/g, "");
  }
  const lines = text.split("\n");
  // A heading inside a code fence is text, not a section
  let fenced = false;
  const heading = lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    return fenced || /^\s*(```|~~~)/.test(line) ? null : line;
  });
  const start = heading.findIndex((line) => line !== null && /^## Release notes\s*$/.test(line));
  if (start === -1) return null;
  const end = heading.findIndex((line, index) => index > start && line !== null && /^## /.test(line));
  const notes = lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim();
  // An unclosed comment would hide the rest of the notes in the Release, so such notes go back to the owner
  return notes === "" || notes.includes("<!--") ? null : notes;
}

/** From `git log --merges --format='%H %P'` lines, the merge commit whose second parent is the tag commit, or null. */
export function releaseMerge(log, tagCommit) {
  for (const line of String(log).split("\n")) {
    const [merge, , second] = line.trim().split(" ");
    if (second === tagCommit) return merge;
  }
  return null;
}
