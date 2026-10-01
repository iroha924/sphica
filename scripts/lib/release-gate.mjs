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
 * Whether no review thread on the PR is left unresolved. The owner reads the Codex review and approves the release; this catches a
 * finding nobody fixed or declined.
 */
export function reviewProblems({ threads }) {
  const open = threads.filter((t) => t?.isResolved !== true).length;
  return open ? [`${open} review thread${open === 1 ? " is" : "s are"} unresolved`] : [];
}
