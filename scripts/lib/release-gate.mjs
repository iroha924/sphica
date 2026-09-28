// Decides whether a tag may be published to npm. prepare and publish in release.yml go through the same decision.
// The inputs are gathered from git and the GitHub API; this module only decides (tests cover every branch).

// release is the PR's dry run of publish and finish; every release PR bumps plugin/package.json, which triggers it
const REQUIRED_WORKFLOWS = ["check", "pr-body", "release"];

/** The failed conditions and the number of the PR whose head is the tag commit. Empty problems means it may be published. */
export function gateProblems({
  tag,
  commit,
  repo,
  versions,
  mainIsAncestor,
  tagCommit,
  published,
  pulls,
  runs,
}) {
  const problems = [];
  const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
  if (!match) problems.push(`tag ${tag} is not in the form v<version>`);
  else
    for (const [key, version] of Object.entries(versions))
      if (version !== match[1]) problems.push(`tag ${tag} does not match ${key} version ${version}`);

  // npm rejects publishing an existing version, but only after the owner approves. Stop an already published version here
  if (published) problems.push(`the version of tag ${tag} is already on npm. Bump the version and tag again`);

  // If main is an ancestor of the tag commit, the tree of the trial merge commit PR CI checked equals the tag commit's tree
  if (!mainIsAncestor)
    problems.push("the tag commit does not include the current main. Merge main into the PR branch again");

  // If the tag was deleted or moved after prepare, do not ship that artifact
  if (tagCommit !== commit)
    problems.push(`remote tag ${tag} does not point to ${commit} (${tagCommit ?? "missing"})`);

  const heads = pulls.filter(
    (pull) =>
      pull.state === "open" &&
      pull.base?.ref === "main" &&
      pull.head?.sha === commit &&
      pull.head?.repo?.full_name === repo,
  );
  if (heads.length !== 1)
    problems.push(
      `not exactly one open same-repository PR into main has the tag commit as head (${heads.length} found)`,
    );

  const number = heads.length === 1 ? heads[0].number : null;
  for (const name of REQUIRED_WORKFLOWS) {
    const latest = runs
      .filter(
        (run) =>
          run.name === name &&
          run.event === "pull_request" &&
          run.head_sha === commit &&
          (run.pull_requests ?? []).some((pr) => pr.number === number && pr.base?.ref === "main"),
      )
      .sort((a, b) => b.id - a.id)[0];
    if (!latest) problems.push(`${name} has not run on the PR for this commit`);
    else if (latest.status !== "completed" || latest.conclusion !== "success")
      problems.push(`the latest ${name} run did not succeed (${latest.status} / ${latest.conclusion})`);
  }
  return { problems, pull: number };
}

/**
 * The GitHub Codex connector's bot account, which posts one review summary per PR. Matched by id and type, never by login text:
 * anyone can comment on a public PR, and a comment carrying the same marker from any other author is ignored.
 * Observed on PR #183 (2026-09-28): login chatgpt-codex-connector[bot], type Bot, app chatgpt-codex-connector.
 */
const CODEX_BOT_ID = 199175422;
const MARKER = /<!-- codex-security-review:v1 (\{.*?\}) -->/;
const REVIEWS = ["Code Review", "Security Review"];

/**
 * Whether Codex finished reviewing the tag commit with nothing left open: the connector's summary names that head as completed,
 * and no review thread is unresolved. The PR body's own account of the review proves nothing, since the author writes it.
 */
export function reviewProblems({ commit, comments, threads }) {
  const problems = [];
  const summaries = comments.filter(
    (c) => c?.user?.type === "Bot" && c.user.id === CODEX_BOT_ID && MARKER.test(c.body ?? ""),
  );
  if (summaries.length !== 1)
    problems.push(`expected one Codex review summary on the PR, found ${summaries.length}`);
  else {
    let state = null;
    try {
      state = JSON.parse(MARKER.exec(summaries[0].body)?.[1] ?? "");
    } catch {
      problems.push("the Codex review summary's marker is not valid JSON");
    }
    if (state && state.headSha !== commit)
      problems.push(`the Codex review summary is for ${state.headSha}, not the tag commit ${commit}`);
    else if (state && state.status !== "completed")
      problems.push(`the Codex review of ${commit} is ${state.status}, not completed`);
    // Which review the marker follows is not documented, and each finishes on its own: both table rows must be done on this commit
    else if (state)
      for (const name of REVIEWS) {
        const found = new RegExp(
          `^\\|[^|\\n]*\\*\\*${name}\\*\\*[^|\\n]*\\|([^|\\n]*)\\|\\s*\`([0-9a-f]{7,40})\`\\s*\\|`,
          "m",
        ).exec(summaries[0].body);
        if (!found) problems.push(`the Codex review summary has no ${name} row`);
        else if (!found[1].includes("**Completed**") || !commit.startsWith(found[2]))
          problems.push(
            `the Codex ${name} is not completed on ${commit} (${found[1].trim().split(" <")[0]} on ${found[2]})`,
          );
      }
  }
  const open = threads.filter((t) => t?.isResolved !== true).length;
  if (open) problems.push(`${open} review thread${open === 1 ? " is" : "s are"} unresolved`);
  return problems;
}
