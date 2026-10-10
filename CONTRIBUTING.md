# Contributing to Sphica

Thanks for wanting to help. Small changes are as welcome as large ones, and you do not need to ask before fixing a typo or a broken example.

Everyone taking part follows the [code of conduct](https://github.com/iroha924/sphica/blob/main/CODE_OF_CONDUCT.md).

## Before you start

- For a larger change, or one that changes behavior, open an issue first and say what you have in mind. Agreeing on the direction early saves you from writing code that cannot go in.
- Looking for somewhere to start? Issues labeled [good first issue](https://github.com/iroha924/sphica/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) are small and self-contained.
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

Your change goes into `main` as one new commit, with your GitHub account as its author.

## Versions

A change to what ships (the MCP servers, the CLI, the hooks, the plugin Skills, `README.md`) has to raise the version in the same pull request. Bring these four to the same number, one patch above the current one:

- `plugin/package.json`
- `plugin/.claude-plugin/plugin.json`
- `plugin/.codex-plugin/plugin.json`
- the `version` of the npm source in `.claude-plugin/marketplace.json`

The commit hook and CI tell you when a change needs this. If `main` releases while your pull request is open, CI stops at the version check: merge `main` into your branch and raise the four again, one patch above the new release.

Changes to docs that do not ship, tests, and development scripts need no version change.

## Pull requests

- Open the pull request from your fork into `main`, and fill in the template. Delete the sections you cannot fill.
- In the Verification section, paste the commands you ran and their output, and write `Codex review: pending maintainer review`. The maintainer runs that review when taking your change in.
- CI on a pull request from a fork waits for the maintainer to approve each run.

## How review works

1. The maintainer reads the diff. Until then nothing from your branch is run on the maintainer's machine, so expect questions about changes to workflows, hooks, tool versions, dependencies, or agent instructions.
2. CI runs, and the maintainer has the change reviewed by Codex. You may be asked for changes.
3. The maintainer accepts it. Only the maintainer merges, and not from your pull request directly: the files as your branch has them are taken, as one new commit with your GitHub account as its author, onto a branch in this repository, and that branch's pull request is the one that is reviewed once more and merged. A change that ships is released from it, after the maintainer approves the release.
4. Your pull request gets a link to that one, and is closed when the change reaches `main`.

## Staying around

People who keep contributing may be invited as collaborators. That is an invitation from the maintainer, made one person at a time, so there is nothing to apply for: the way in is the pull requests themselves.
