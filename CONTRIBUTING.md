# Contributing to Sphica

Thanks for wanting to help. Small changes are as welcome as large ones, and you do not need to ask before fixing a typo or a broken example.

## Before you start

- For a larger change, or one that changes behavior, open an issue first and say what you have in mind. Agreeing on the direction early saves you from writing code that cannot go in.
- Report vulnerabilities privately, as [SECURITY.md](https://github.com/iroha924/sphica/blob/main/SECURITY.md) describes, not in an issue or a pull request.

## Setup

Fork the repository, clone your fork, and install the tools at the versions the repository pins. [mise](https://mise.jdx.dev/) reads them from `mise.toml`.

```bash
mise trust && mise install   # Node, Bun, actionlint, and lychee
bun run setup                # dependencies and the Git hooks (Lefthook)
```

## Checks

```bash
bun run verify   # lint, types, docs, bundle, and tests: the same checks pre-push and CI run
bun run fix      # format and apply the safe lint fixes
```

Tests run against a real SQLite database in a temporary directory and need no credentials or network access. A change that adds or changes behavior comes with tests in the same pull request.

## Commits

The commit hook checks every message, and CI checks them again:

- English, in [Conventional Commits](https://www.conventionalcommits.org/) form, such as `fix(capture): keep the last reply of a turn`
- One line with no body, at most 100 characters

Keep them tidy from the start. Your commits go into `main` as they are, with your name on them.

## Versions

A change to what ships (the MCP servers, the CLI, the hooks, the plugin Skills, `README.md`) has to raise the version in the same pull request. Bring these four to the same number, one patch above the current one:

- `plugin/package.json`
- `plugin/.claude-plugin/plugin.json`
- `plugin/.codex-plugin/plugin.json`
- the `version` of the npm source in `.claude-plugin/marketplace.json`

The commit hook and CI tell you when a change needs this. If `main` has released in the meantime, the maintainer adjusts the number when taking your change in.

Changes to docs that do not ship, tests, and development scripts need no version change.

## Pull requests

- Open the pull request from your fork into `main`, and fill in the template. Delete the sections you cannot fill.
- In the Verification section, paste the commands you ran and their output, and write `Codex review: pending maintainer review`. The maintainer runs that review and posts the result as a comment.
- On your first pull request, CI waits for the maintainer to approve the run.

## How review works

1. The maintainer reads the diff. Until then nothing from your branch is run on the maintainer's machine, so expect questions about changes to workflows, hooks, tool versions, dependencies, or agent instructions.
2. CI runs, and the maintainer has the change reviewed by Codex. You may be asked for changes.
3. The maintainer accepts it. Only the maintainer merges.
   - A change that does not ship is merged as soon as it is accepted.
   - A change that ships is released first: the maintainer takes your commits, unchanged, into a release branch in this repository, and the release run merges that branch after the maintainer approves the release. Releases are not cut from a fork's pull request, so yours may be closed with a link to the release pull request that carries your commits.

## Staying around

People who keep contributing may be invited as collaborators. That is an invitation from the maintainer, made one person at a time, so there is nothing to apply for: the way in is the pull requests themselves.
