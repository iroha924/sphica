// Decides whether the npm-release environment lets only the owner approve a publish. The owner's approval is the only gate before npm,
// so any drift (another reviewer, admin bypass, a looser deployment policy) stops the release. Inputs come from the GitHub API.

/** The failed conditions for `environment` (GET environments/npm-release) and `policies` (its deployment-branch-policies list). */
export function envProblems({ environment, policies, ownerId }) {
  const problems = [];
  const rules = environment?.protection_rules ?? [];
  const reviewerRules = rules.filter((rule) => rule.type === "required_reviewers");
  if (reviewerRules.length !== 1) {
    problems.push(`expected one required_reviewers rule, found ${reviewerRules.length}`);
  } else {
    const [rule] = reviewerRules;
    const reviewers = rule.reviewers ?? [];
    if (reviewers.length !== 1) problems.push(`expected one required reviewer, found ${reviewers.length}`);
    else if (reviewers[0].type !== "User" || String(reviewers[0].reviewer?.id) !== String(ownerId)) {
      problems.push(
        `the required reviewer is not the repository owner (${reviewers[0].reviewer?.login ?? "unknown"})`,
      );
    }
    // The owner pushes the tag and approves it, so self-review prevention would lock the owner out
    if (rule.prevent_self_review !== false) problems.push("prevent_self_review must be off");
  }
  if (environment?.can_admins_bypass !== false)
    problems.push("admins can bypass npm-release; turn admin bypass off");
  if (environment?.deployment_branch_policy?.custom_branch_policies !== true) {
    problems.push("npm-release must be limited to selected tags");
  }
  const entries = (policies ?? []).map((policy) => `${policy.type}:${policy.name}`);
  if (entries.length !== 1 || entries[0] !== "tag:v*") {
    problems.push(`npm-release must allow only the tag pattern v* (found ${entries.join(", ") || "none"})`);
  }
  return problems;
}
