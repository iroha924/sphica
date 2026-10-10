# Architecture

How Sphica is put together: what runs, where the data lives, and where the lines of trust are. For what it does from a user's side, see the [README](https://github.com/iroha924/sphica#readme).

Two words are used throughout. The **owner** is the person using Sphica, whose machine and database it is. The **host** is the agent program Sphica plugs into: Claude Code or Codex.

## One package, five programs

Everything ships as one npm package. The Claude Code and Codex plugins point at that package, at an exact version, through the marketplace file in this repository. The package has no install scripts and no runtime dependencies to fetch: each program is one bundled file, and the database is `node:sqlite`, which is built into Node.

| Program | Started by | What it does |
|---|---|---|
| `capture.js` | The host's hooks, at session start, each prompt, each edit, each turn's end, and before a call to the record server | Records the owner's prompts, the agent's last reply of a turn, and the paths of changed files |
| `deliver.js` | The host's hooks, at session start and when a subagent starts, at each prompt, before a file is read or edited, and before and after a shell command | Finds the records that apply and hands them to the agent as context |
| `mcp.js` | The host, as an MCP server | The read server: status, search, read, overview, export, fields, and the review tools |
| `mcp-record.js` | The host, as an MCP server | The record server: the only way records are written, and the only way sources are removed |
| `cli.js` | The user, as `sphica` | `init`, `doctor`, and `uninstall` |

A sixth bundled file, `git-worker.js`, is a child process the others start when they need to compare the working tree: it runs git with a deadline, in a git directory of Sphica's own.

Nothing listens on a port. The MCP servers talk to the host over standard input and output.

## Data

- **The database** is one SQLite file, `~/.sphica/sphica.db`. `db/schema.sql` is its only definition; there is no ORM schema beside it. A generation number guards the record model and a revision number guards changes within it, and each revision ships with a migration that tests compare against a fresh database.
- **The queue** is `~/.sphica/spool`: capture writes there first, so recording never waits on the database, and the entries are written to the database afterwards.
- **Search** is SQLite's FTS5 with Sphica's own word splitting, so Japanese and English text are both found.
- **Other files** under `~/.sphica`: copies of the whole database made before each migration (`backups/`), the working tree baselines capture compares against (`worktree/`), Sphica's own git directory (`git/`), and, when delivery after shell commands is on, content hashes and its log (`shell-state/`).

Each machine has its own database, and Sphica sends nothing anywhere itself. The records it hands to the host become part of the host's context.

## The record model

- A **source** is something that was said or written: a captured message, an item of a pull request, a cited excerpt of a file.
- A **unit** is a record made from sources: a decision, a constraint, an implementation, a finding, a dead end, or a question. A unit carries quotes from the sources it came from, and each quote is checked against the stored source when the unit is saved.
- A decision or constraint takes effect when it is **adopted**: by the owner's words, by the words of the repository's owner or a maintainer in a pull request, or by the agent's own reply where it decided something itself, which is marked as such and never replaces the owner's decision.
- An **anchor** ties a unit to a file, and to a name in it when there is one. Delivery uses anchors to find what applies to the file the agent is about to touch.
- Units are never rewritten. A correction is a new unit that supersedes the old one, and both stay.

## How a record is written

Records are written only through the record server, and only through tools bound to one run. A Skill (a packaged set of steps the agent follows) begins a run with `trace_begin`, `harvest_begin`, or `glean_begin`. A run fixes the project, and for a trace or a harvest the one session or pull request it may cite; a glean run may cite the project's sources and what it fetched. `record_check` and `record_save` take that run's id and nothing else: no project, no session, no SQL. Sources are removed only by `forget_apply`, after the owner confirms the count in the host's own dialog.

## Database roles

Each connection is opened in a role, and an SQLite authorizer limits what every role but the owner may do. (This `owner` is the name of a database role, the one with no limits.)

| Role | May | Used by |
|---|---|---|
| owner | Everything | Creating and migrating the database, reindexing, `doctor`'s database check, and binding the owner's GitHub account in `init` |
| reader | Read | The read server, delivery, `doctor`'s reads |
| ingest | Write what the record server writes, and no more | The record server, registering a project |
| forget | Remove sources and what cites them | `forget_apply` |
| capture | Insert into the capture views | Capture, and the delivery log |

Write connections live in one module, and a check in CI proves the read server cannot reach it. These roles guard against Sphica's own code writing by mistake. They are not a boundary against another process of the same user, which can open the file directly.

## Lines of trust

- **Text from outside is data.** Pull request text, issue text, and recorded conversations may be written by anyone. They are stored as sources and handed to the agent marked as past records, never as instructions, and the words of someone who is not entitled to decide never adopt a decision.
- **The hooks run outside the agent's sandbox.** Capture, delivery, the MCP servers, and the CLI run with the user's permissions, in a repository the agent can write to. So Sphica starts git with settings that cannot run commands from that repository's configuration, and compares working trees in a separate process and a separate git directory.
- **The network is someone else's program.** Sphica makes no connections itself. It runs `gh` to read pull requests and issues, and `npm`, `claude`, and `codex` to read installed versions.

[ASSURANCE.md](https://github.com/iroha924/sphica/blob/main/ASSURANCE.md) argues why these hold.

## Release

A release is built by GitHub Actions from a tag on the head of a pull request whose checks passed. It is published to npm only after the maintainer approves the release environment, through trusted publishing with no stored token, and the same run then merges the pull request and creates the GitHub Release. Publishing comes before merging, so the marketplace file on `main` never names a version that has not been published.

## Where things are

| Path | What |
|---|---|
| `server/src/` | The five programs and what they share |
| `db/` | `schema.sql` and the migrations |
| `plugin/` | The package: manifests for both hosts, hooks, MCP configuration, Skills |
| `server/test/` | Tests, run against a real SQLite database in a temporary directory |
| `server/evals/` | Measurements run on real agents |
| `scripts/` | The checks `bun run verify` runs, and the release tooling |
