# Sphica

[![License](https://img.shields.io/github/license/iroha924/sphica)](https://github.com/iroha924/sphica/blob/main/LICENSE)
[![CI](https://github.com/iroha924/sphica/actions/workflows/check.yml/badge.svg)](https://github.com/iroha924/sphica/actions/workflows/check.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/iroha924/sphica/badge)](https://scorecard.dev/viewer/?uri=github.com/iroha924/sphica)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/14787/badge)](https://www.bestpractices.dev/projects/14787)
[![SLSA Build L2](https://img.shields.io/badge/SLSA-Build%20L2-green)](https://www.npmjs.com/package/sphica#provenance)
[![Dependabot: GitHub Actions](https://img.shields.io/badge/Dependabot-GitHub%20Actions-025E8C?logo=dependabot)](https://github.com/iroha924/sphica/blob/main/.github/dependabot.yml)

What the badges cover: CI runs the checks in [Contributing](https://github.com/iroha924/sphica#contributing), and how each release is built and published is in [Security](https://github.com/iroha924/sphica#security). A passing badge does not mean the code is free of bugs or vulnerabilities.

English | [日本語](https://github.com/iroha924/sphica/blob/main/README.ja.md)

**Local memory of past implementation and decisions for Claude Code and Codex.**
Sphica records your coding sessions, and keeps what was decided, rejected, deferred, and built, each record quoting the words it came from.
Your agent finds those records when it searches, and sees the relevant ones on its own when it reads or edits a file they apply to (in Codex, before a shell command that names the file and before `apply_patch`).
The database is a single SQLite file on your machine.

## Features

- **Automatic recording.** Sphica keeps your prompts, the agent's final reply for each turn, and the paths of the files a turn changed (by the edit tools, or seen in `git status` at the turn's end).
- **Records with their sources.** `/sphica:trace` turns a session into records: decisions with the options rejected and why, constraints, implementations, findings, dead ends, and open questions. Every record quotes the exact words it came from, and a decision counts as adopted only when you said so.
- **Pull requests too.** `/sphica:harvest <number>` keeps a GitHub pull request (body, comments, reviews, review comments, commits, and up to five issues the body says it closes) and records what it decided. A reviewer's suggestion stays a proposal unless the owner or a maintainer adopted it; a merge alone adopts nothing.
- **Evidence found later.** `/sphica:glean` adds evidence and corrections to existing records. It asks you for the source (an issue URL, the file and line, meeting notes) before saving; a claim without one is kept only as unsourced and never used as fact.
- **Forget what should not have been kept.** `/sphica:forget` removes the messages, pull request items, or file excerpts you pick, with their search entries and the bytes left in the database file, after you confirm in a dialog (if another session is reading the database, it asks you to run it again to finish clearing the bytes). Records that cited them are judged again and leave active when nothing else supports them; a record's own text stays as it was.
- **Shown when it matters.** At session start, the current work; before the agent reads or edits a file, or runs a shell command that names it, the decisions tied to that file; when your prompt names a recorded option or code symbol, that record. Works in both Claude Code and Codex.
- **Search in Japanese and English.** Records are made with search words in both languages, so a question in either language is more likely to find them.
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

In Codex, open `/hooks` and mark Sphica's hooks as trusted. Automatic recording does not start until you do. If a plugin update changes the hooks, trust them again.

**3. Set up in your repository**

```bash
cd ~/Projects/your-repo
sphica init
```

This creates `~/.sphica/sphica.db` and registers the repository. Running it again keeps the database and the registration as they are. If the repository has no `origin` remote, give it a name: `sphica init --name <name>`.

If `gh` is signed in, init also binds that GitHub account as yours, so your words adopt a decision even in someone else's repository where you are only a contributor. This applies to pull requests harvested after binding; ones harvested before keep your words as a contributor's. Only the first account is bound: if `gh` is later signed in to another one, init says so and adds nothing, and there is no command to change it (move the database aside and run init again). Without `gh`, init still sets up and says why nothing was bound; `sphica doctor` shows the bound account.

**4. Check the setup**

```bash
sphica doctor
```

`doctor` checks Node.js, the CLI and plugin versions, the database, the recording queue, and the registered projects. Start here whenever something looks wrong.

## Quick start

Only sessions in repositories you register (projects) go into Sphica's database; run `sphica init` in each one.

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
- Before a review (Claude Code only). When you run your own review command (any name containing `review`, or a name listed in the `SPHICA_REVIEW_COMMANDS`
  environment variable, comma-separated), it gets the decisions your local change touches. `/sphica:review` checks them itself.

In Codex the same happens at session start, on a prompt, before an `apply_patch` edit, and before a shell command that names such a file (Codex reads files through shell commands, so this covers reads).
There is no review hook in Codex: run `$sphica:review`.

The agent searches with Sphica's `search` and opens full records with `read`. `status` tells it how much of the history has been traced, so an empty search is less likely to be mistaken for "never decided".

## What gets recorded and where it goes

- **Where.** The database is `~/.sphica/sphica.db`. Captured sessions wait in a local queue, `~/.sphica/spool`, until they are written to it. Each machine has its own database; nothing is shared between machines.
- **What.** Your prompts, the agent's final reply for each turn, and the paths of changed files. Background-task notifications and messages from other agents are skipped when Sphica recognizes their format. Replies in the middle of a turn are not kept, nor are files created and deleted within one turn without the edit tools.
- **What was shown.** Each automatic delivery is logged by which records it showed, not their text.
- **Unregistered repositories.** Sessions in a repository you have not registered stay in the queue and are written after you register it. Held sessions are dropped after 30 days, and when more than 1,000 are waiting the oldest go first.
- **Secrets.** In your prompts, pull request text, and the file lines `/sphica:glean` cites, only secrets with a recognizable shape are masked (excerpts saved before 0.5.7 stay as they were until you forget them):
  - keys with known prefixes
  - `KEY=…` and `"password": …` assignments
  - credentials in URLs
  - authorization headers
  - `mysql -p`

  **Anything else is stored as typed, so do not paste secrets into a session.** If one got in, remove the source holding it with `/sphica:forget` (Claude Code; the confirmation dialog it needs may not appear in Codex). A record that repeated it keeps its own text.
- **Network.** Sphica has no account, no hosted service, and no telemetry, and makes no network connections itself. `/sphica:harvest` and `/sphica:glean` run `gh api` with your credentials to read pull requests and issues, `sphica init` runs `gh api user` to read which GitHub account is yours, and `sphica doctor` runs `npm` and `claude` to check installed versions. `gh api` is always sent to github.com.
- **Text written by others.** Pull request and issue text may come from anyone. It is kept as a source and passed to the agent as data, never as instructions, and only your words, or those of the repository's owner or a maintainer, can adopt a decision.

## What Sphica can't do yet

- Only what you traced, harvested, or gleaned becomes a structured record. The rest of a conversation is searchable as captured text (`search` with `sources: true`).
- For shell commands, Sphica only sees whether a command names a file. It may show decisions for a file the command never reads, and a shell command that edits a file is not treated as an edit (in Codex, a patch passed to `apply_patch` through the shell is treated as an edit).
- Commands run through Claude Code's PowerShell tool (Windows without Git Bash) do not get decisions yet.
- In Codex, `$sphica:trace`, `$sphica:harvest`, and `$sphica:glean` can write only when Codex tells Sphica which directory the session is in. Current Codex does. When it does not, they write nothing and tell you why.
- Showing a record does not make the agent follow it.
- A code location in a record is checked against your working tree when it is read. Finding the code name (a function name, say) the record points to does not mean the decision still holds.

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

Restart open sessions afterwards. When an update changes the database (0.6.0 does), update the CLI first, then run `sphica init` once: it migrates the database in place and keeps your records. Until then Sphica says it is unavailable and tells you so. An older CLI cannot read the migrated database: if one still says to move it aside, update that CLI instead.

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
| `sphica init` | Create the database, bind the GitHub account `gh` is signed in to, and register the current repository |
| `sphica doctor` | Check versions, the database, recording, and each registered project |
| `sphica uninstall` | Delete `~/.sphica` and show how to remove the plugin and the CLI |

Everything else runs inside Claude Code and Codex, through the `/sphica:*` commands and Sphica's MCP tools.

## Security

Report vulnerabilities privately as described in [SECURITY.md](https://github.com/iroha924/sphica/blob/main/SECURITY.md).

Each release is built by GitHub Actions from a tag on the head of a pull request whose CI has passed.
It is published only after the maintainer approves the release environment on GitHub, and it reaches npm through trusted publishing, with no stored token.
The [npm page](https://www.npmjs.com/package/sphica#provenance) links to the workflow and the commit each release was built from.

Dependabot opens weekly pull requests to update the GitHub Actions used in CI, and Renovate opens monthly ones for the npm dependencies bundled into the package.

## Contributing

Issues are welcome. Pull requests from outside contributors are closed without review, because the review tools here run with maintainer credentials and cannot safely check out code written by others.

Changes that add or change behavior include automated tests in the same pull request. CI runs them with `bun run verify` on every pull request.

## License

[MIT](https://github.com/iroha924/sphica/blob/main/LICENSE). The published package bundles its dependencies. Their licenses are listed in `THIRD_PARTY_NOTICES.md` inside the package.
