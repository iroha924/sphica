// Pure parts of release-finish: reading the Release notes out of a PR body and finding the merge commit of a released tag.

/** The body of the PR's `## Release notes` section without HTML comments, or null when it is missing or empty. */
export function releaseNotes(body) {
  // Remove comments until none is left, so nested markers cannot leave an opening `<!--` behind
  let text = String(body ?? "").replace(/\r/g, "");
  for (let previous = ""; previous !== text; ) {
    previous = text;
    text = text.replace(/<!--[\s\S]*?-->/g, "");
  }
  // An opening marker left anywhere hides what follows it on GitHub, heading included, so the owner could not have read it
  if (text.includes("<!--")) return null;
  const lines = text.split("\n");
  // A heading inside a code fence is text, not a section. A fence opens with 3 or more backticks or tildes
  // and closes only with the same character, at least as many, and nothing else on the line (CommonMark)
  let fence = null;
  const heading = lines.map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence === null) {
      if (marker && !(marker[1][0] === "`" && marker[2].includes("`"))) {
        fence = marker[1];
        return null;
      }
      return line;
    }
    if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && marker[2].trim() === "") {
      fence = null;
    }
    return null;
  });
  const start = heading.findIndex((line) => line !== null && /^## Release notes\s*$/.test(line));
  if (start === -1) return null;
  const end = heading.findIndex((line, index) => index > start && line !== null && /^## /.test(line));
  const notes = lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim();
  return notes === "" ? null : notes;
}

/** From `git log --merges --format='%H %P'` lines, the merge commit whose second parent is the tag commit, or null. */
export function releaseMerge(log, tagCommit) {
  for (const line of String(log).split("\n")) {
    const [merge, , second] = line.trim().split(" ");
    if (second === tagCommit) return merge;
  }
  return null;
}
