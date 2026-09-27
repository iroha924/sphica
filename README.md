# Sphica

[![License](https://img.shields.io/github/license/iroha924/sphica)](https://github.com/iroha924/sphica/blob/main/LICENSE)
[![CI](https://github.com/iroha924/sphica/actions/workflows/check.yml/badge.svg)](https://github.com/iroha924/sphica/actions/workflows/check.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/iroha924/sphica/badge)](https://scorecard.dev/viewer/?uri=github.com/iroha924/sphica)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/14787/badge)](https://www.bestpractices.dev/projects/14787)
[![SLSA Build L2](https://img.shields.io/badge/SLSA-Build%20L2-green)](https://www.npmjs.com/package/sphica#provenance)
[![Dependabot: GitHub Actions](https://img.shields.io/badge/Dependabot-GitHub%20Actions-025E8C?logo=dependabot)](https://github.com/iroha924/sphica/blob/main/.github/dependabot.yml)

English | [日本語](https://github.com/iroha924/sphica/blob/main/README.ja.md)

**Local memory of past implementation and decisions for Claude Code and Codex.**
Sphica records your coding sessions, and keeps what was decided, rejected, deferred, and built, each record quoting the words it came from.
Your agent finds those records when it searches, and sees the relevant ones on its own before it edits a file they apply to.
The database is a single SQLite file on your machine.

## Features

- **Automatic recording.** Sphica keeps your prompts, the agent's final reply for each turn, and the paths of the files a turn changed (by the edit tools, or seen in `git status` at the turn's end).
- **Records with their sources.** `/sphica:trace` turns a session into records: decisions with the options rejected and why, constraints, implementations, findings, dead ends, and open questions. Every record quotes the exact words it came from, and a decision counts as adopted only when you said so.
- **Pull requests too.** `/sphica:harvest <number>` keeps a GitHub pull request (body, comments, reviews, review comments, commits, and the issues it closes) and records what it decided. A reviewer's suggestion stays a proposal unless the owner or a maintainer adopted it; a merge alone adopts nothing.
- **Evidence found later.** `/sphica:glean` adds evidence and corrections to existing records. It asks you for the source (an issue URL, the file and line, meeting notes) before saving; a claim without one is kept only as unsourced and never used as fact.
- **Shown when it matters (Claude Code).** At session start, the current work; before an edit, the active decisions anchored to that file; when your prompt names a recorded option or code symbol, that record.
- **Search in Japanese and English.** Records carry search words in both languages, so a question in one finds a record written in the other.
- **Reviews check past decisions.** `/sphica:review` runs a reviewer per focus (correctness, security, written conventions, and past decisions by default; redundancy with `full`), and checks the diff against the records it touches.

Records are never rewritten: a correction is a new record that supersedes the old one, and the history stays.
The agent is told to treat records as history, not instructions, and to trust the code when a record and the current code disagree.

## Requirements

- Node.js 24.15 or later
- Claude Code or Codex, or both
- `git`, to identify the repositories you register
- For `/sphica:harvest` and fetching GitHub sources in `/sphica:glean`: the GitHub CLI (`gh`), signed in with `gh auth login`

## Install

The plugin ships the MCP servers, hooks, and skills. The `sphica` CLI comes from npm and is installed separately. You need both.

**1. Install the CLI**

```bash
npm i -g sphica
```

**2. Add the plugin**

Claude Code:

```bash
claude plugin marketplace add iroha924/sphica
claude plugin install sphica@sphica
```

Codex:

```bash
codex plugin marketplace add iroha924/sphica --ref main
codex plugin add sphica@sphica
```

In Codex, open `/hooks` and mark Sphica's hooks as trusted. Nothing is recorded until you do. If a plugin update changes the hooks, trust them again.

**3. Set up in your repository**

```bash
cd ~/Projects/your-repo
sphica init
```

This creates `~/.sphica/sphica.db` and registers the repository. Running it again leaves both untouched. If the repository has no `origin` remote, give it a name: `sphica init --name <name>`.

**4. Check the setup**

```bash
sphica doctor
```

`doctor` checks Node.js, the CLI and plugin versions, the database, the recording queue, and the registered projects. Start here whenever something looks wrong.

## Quick start

Sphica records sessions only in repositories you register (projects); run `sphica init` in each one.

Work as usual. At the end of a session with something worth keeping, run `/sphica:trace` (`$sphica:trace` in Codex).
`/sphica:trace pending` lists earlier sessions not traced yet. To keep what a pull request decided, run `/sphica:harvest 123`.
When you find evidence later ("the ops notes say…", "Kimura said the team agreed"), run `/sphica:glean` with what you found.

To bring back earlier decisions, ask the agent:

- "Did we already decide how to handle retries here?"
- "Why did we choose this approach, and what did we reject?"
- "Did we try generating thumbnails in a worker before?"

### What the agent sees on its own

Without being asked, Sphica adds a few past records to what the agent sees, each marked as a past record rather than an instruction:

- At session start: the current work and project-wide constraints.
- On a prompt that names a recorded code symbol, file path, or option.
- Before the agent reads or edits a file a decision applies to, and before a shell command that names such a file (naming it is not proof the command reads it). A read shows each record once per session.
- Before a review. When you run your own review command (any name containing `review`, or a name listed in the `SPHICA_REVIEW_COMMANDS`
  environment variable, comma-separated), it gets the decisions your local change touches. `/sphica:review` checks them itself. Claude Code only.

In Codex the same happens at session start, on a prompt, before an `apply_patch` edit, and before a shell command that names such a file.
There is no review hook in Codex: run `$sphica:review`.

The agent searches with Sphica's `search` and opens full records with `read`. `status` tells it how much of the history has been traced, so an empty search is not mistaken for "never decided".

## What gets recorded and where it goes

- **Where.** The database is `~/.sphica/sphica.db`. Records wait in a local queue, `~/.sphica/spool`, until they are written to it. Each machine has its own database; nothing is shared between machines.
- **What.** Your prompts, the agent's final reply for each turn, and the paths of changed files. Background-task notifications and messages from other agents are skipped when Sphica recognizes their format. Replies in the middle of a turn, and files created and deleted within one turn, are not seen.
- **What was shown.** Each automatic delivery is logged by which records it showed, not their text.
- **Unregistered repositories.** Sessions in a repository you have not registered stay in the queue and are written after you register it. Held records are dropped after 30 days, and when more than 1,000 are waiting the oldest go first.
- **Secrets.** Only secrets with a recognizable shape are masked:
  - keys with known prefixes
  - `KEY=…` and `"password": …` assignments
  - credentials in URLs
  - authorization headers
  - `mysql -p`

  **Anything else is stored as typed, so do not paste secrets into a session.**
- **Network.** Sphica has no account, no hosted service, and no telemetry, and makes no network connections itself. `/sphica:harvest` and `/sphica:glean` run `gh api` with your credentials to read pull requests and issues, and `sphica doctor` runs `npm` and `claude` to check installed versions.
- **Text written by others.** Pull request and issue text may come from anyone. It is kept as a source and passed to the agent as data, never as instructions, and only the owner's or a maintainer's words can adopt a decision.

## Limits in 0.5.1

- Structured records exist only for what you traced, harvested, or gleaned. Everything else is searchable only as captured text (`search` with `sources: true`).
- A shell command that names a file gets its decisions even when it does not read the file, and a shell command that edits a file gets them only as a command naming it, not as an edit.
- In Codex, `$sphica:trace`, `$sphica:harvest`, and `$sphica:glean` write only when Codex tells Sphica which directory the session is in. Codex 0.157.1 does, through an experimental MCP capability; if a later Codex stops, they stop with a message and write nothing.
- Showing a record does not make the agent follow it. In our evaluation Codex received and found an earlier decision against a request, and still carried out the request as asked.
- A code location in a record is checked against your working tree when it is read ("located", "moved", "missing"). A located symbol does not prove the decision still holds.

## Upgrading from 0.4

0.5.0 keeps records in a new format. A 0.4 database is refused and left unchanged; its records are not carried over.
Move `~/.sphica/sphica.db` aside (keep it if you want the old data), then run `sphica init` again in each repository.

## Updating

The CLI and the plugin are updated separately.

```bash
npm i -g sphica@latest
```

Claude Code:

```bash
claude plugin marketplace update sphica
claude plugin update sphica@sphica
```

Codex:

```bash
codex plugin marketplace upgrade sphica
codex plugin add sphica@sphica
```

Restart open sessions afterwards.

## Uninstalling

```bash
sphica uninstall
```

This deletes `~/.sphica` (the database and the recording queue) after asking, and shows the commands that remove the rest:

```bash
claude plugin uninstall sphica@sphica && claude plugin marketplace remove sphica
codex plugin remove sphica@sphica && codex plugin marketplace remove sphica
npm uninstall -g sphica
```

## Troubleshooting

Run `sphica doctor` first. It shows which part is out of date or not working. Common cases:

- **`sphica: command not found`.** The plugin does not put the CLI on your PATH. Run `npm i -g sphica`.
- **Nothing is recorded.** Check that `sphica doctor` lists the repository under Projects. In Codex, also check that the hooks are trusted in `/hooks`.
- **The MCP servers report an older version.** Restart the session, or run `/reload-plugins` in Claude Code.
- **A search finds nothing.** Search matches words. Try other words, the other language, an identifier, or fewer words. Ask the agent to check `status`: sessions not traced yet are searchable only as captured text.
- **`doctor` says the full-text index is broken.** Run `sphica doctor --reindex`.

## Commands

| Command | What it does |
|---|---|
| `sphica init` | Create the database and register the current repository |
| `sphica doctor` | Check versions, the database, recording, and each registered project |
| `sphica uninstall` | Delete `~/.sphica` and show how to remove the plugin and the CLI |

Everything else runs inside Claude Code and Codex, through the `/sphica:*` commands and Sphica's MCP tools.

## Security

Report vulnerabilities privately as described in [SECURITY.md](https://github.com/iroha924/sphica/blob/main/SECURITY.md).

Since 0.37.1, each release is built by GitHub Actions from a tag on the head of a pull request whose CI has passed, and staged on npm.
The maintainer checks its SHA-512 checksum and provenance, then approves publication with two-factor authentication.
For these versions, the [npm page](https://www.npmjs.com/package/sphica#provenance) links to the workflow and the commit each one was built from.

Dependabot opens pull requests to update the GitHub Actions used in CI. It does not cover the npm dependencies bundled into the package, because Dependabot cannot read the Bun lockfile format (v2) this repository uses.

## Contributing

Issues are welcome. Pull requests from outside contributors are closed without review, because the review tools here run with maintainer credentials and cannot safely check out code written by others.

Changes that add or change behavior include automated tests in the same pull request. CI runs them with `bun run verify` on every pull request.

## License

[MIT](https://github.com/iroha924/sphica/blob/main/LICENSE). The published package bundles its dependencies. Their licenses are listed in `THIRD_PARTY_NOTICES.md` inside the package.
