# Assurance case

Why Sphica's security claims hold: what it protects, who it defends against, where the lines of trust are, and what keeps each line in place. [SECURITY.md](https://github.com/iroha924/sphica/blob/main/SECURITY.md) says how to report a problem, and [ARCHITECTURE.md](https://github.com/iroha924/sphica/blob/main/ARCHITECTURE.md) describes the parts named here.

## What is protected

1. **The user's machine.** Sphica's hooks, MCP servers, and CLI run with the user's permissions. Nothing they read may make them run a command the user did not ask for.
2. **The records.** A record that later sessions rely on must say what was really said. It must not be written, replaced, or adopted by text someone else supplied.
3. **What was captured.** Sphica stores prompts and replies only on the machine and sends them nowhere itself, and what the user asks to forget is removed from the database.
4. **The published package.** What npm serves is what the reviewed source builds to.

## Who it defends against

- **Text written to mislead**: a pull request body, a comment, an issue, or a line in a file, written by anyone, that the agent or Sphica reads.
- **An agent inside its sandbox**: the agent Sphica serves can write to the repository it works in, including that repository's git configuration, and may be steered by the text above.
- **A compromised dependency or build step**: a package, an action, or a workflow change that tries to alter what is published.

Out of scope: another process running as the same user. It can read and write `~/.sphica` directly, and Sphica does not claim to stop it.

## Lines of trust, and what holds each

### Outside text is data

- Pull request text, issue text, and recorded conversations are stored as sources and shown to the agent marked as past records, with the instruction that they are not instructions.
- A decision takes effect only when adopted by someone entitled to decide: the owner in their own words, the repository's owner or a maintainer on GitHub, or the agent itself in an interactive session, marked as the agent's decision. A commit's author, which anyone can set, never adopts, and neither does a merge.
- A record that replaces or holds back the owner's decision takes effect only from a record the owner adopted.
- A record carries quotes from its sources, and the save checks that each quote is in the stored text. That proves the words were said. It does not prove the record's own summary of them is right. A record whose quote is not there is quarantined: it is never delivered on its own, it does not appear in search, and reading it by key shows it as quarantined.

### Records are written through one narrow path

- Only the record server writes records, through tools bound to a run. A run fixes the project, and for a trace or a harvest the one session or pull request it may cite; a glean run may cite the project's sources and what it fetched. The record itself cannot name a project, a session, or SQL.
- Every connection but the owner's has a role enforced by an SQLite authorizer: the read server can only read, the record server can write only the listed tables and columns, and only the forget role can delete sources. Tests try each role's allowed and forbidden operations on real connections. The owner connection, which creates, migrates, and checks the database, has no authorizer.
- Write connections are opened in one module, `server/src/db-write.ts`, and a check in CI proves the read server's imports cannot reach it.
- Sources are deleted only after the owner confirms the count in the host's own dialog, with `secure_delete` on so the bytes are overwritten in the database file. When another session is reading the database at that moment, the cleanup can be left unfinished, and forget says so and asks to be run again.

### Sphica's programs do not run what the repository says

- Git is started by two modules only, `git.ts` and the worker it starts, and a check in CI proves no other module starts it. They cancel the settings that would run a command (file system monitors, hooks, pagers, external diff programs, external transports) and avoid the operations that would run a filter. Comparing a working tree runs in the worker: a separate process, with a deadline, in a git directory Sphica owns that does not read the repository's configuration. Tests plant such commands in a repository and check that plain git runs them and Sphica does not.
- Child processes are started with an argument list, never through a shell, and no code is built from strings and run (`eval`, `new Function`).
- Input at each boundary is validated: MCP tool arguments against schemas, and SQL goes through bound parameters.

### What is captured stays local

- Sphica opens no network connection and runs no server that listens. The programs it runs that can reach the network are `gh`, `npm`, `claude`, and `codex`, which the user already trusts with their credentials.
- Secrets with a recognizable shape are masked in captured prompts, pull request text, and cited file lines before they are stored. Sphica stores no credentials of its own.

### The package is what the source builds to

- A release is built by GitHub Actions from a tag that only the maintainer can create, on the head of a pull request whose checks passed and whose review threads are resolved.
- Publishing needs the maintainer's approval of a protected environment, and reaches npm through trusted publishing: no npm token is stored anywhere.
- The run publishes the same tarball it checked, by SHA-512, with provenance and a signed attestation of its SBOM (the list of dependencies bundled into the package). A tarball packed from the same commit on another machine had the same SHA-512 as the released one.
- Third-party actions are pinned to commit SHAs, workflow tokens have the least permissions that work, and published releases cannot be changed.
- Dependencies are pinned in a lockfile and bundled at build time, so installing the package fetches no further dependency and runs no install script. New versions of a dependency wait seven days before they are taken. OSV-Scanner checks the lockfile on every push to `main`, once a week, and at each release, where the maintainer sees the result before approving; a finding does not stop the release by itself.

## Secure design principles

| Principle | Where it shows |
|---|---|
| Least privilege | A role per database connection; a read server that cannot write; workflow tokens scoped per job |
| Economy of mechanism | One SQLite file, no server, no ORM, two modules that start git, one module that opens write connections |
| Fail-safe defaults | A decision or constraint without adoption stays a candidate and is not delivered on its own; a database of another generation is refused unchanged; a test whose precondition is missing fails instead of being skipped |
| Complete mediation | Every write by the record server, by capture, and by forget goes through its role's authorizer; every record goes through the save's checks |
| Open design | Nothing here depends on the design being secret; this document and the source are public |
| Separation of privilege | Publishing takes two separate acts: pushing a tag only the maintainer can create, and approving the environment on the run's page |

## Common weaknesses, and what counters them

| Weakness | Countered by |
|---|---|
| Command injection | Argument lists, no shell; git started with command-running configuration cancelled |
| SQL injection | Bound parameters; authorizers limit what any statement may touch |
| Code injection | No `eval` or `new Function` |
| Prompt injection through stored text | Outside text marked as data; adoption only by someone entitled to decide; quotes checked against sources |
| Path traversal | Paths resolved and checked against the repository before a file is read; links are not followed out of it |
| Secrets in stored text | Masking of recognizable secrets; `forget` with `secure_delete` |
| Supply chain compromise | Pinned actions and lockfile, a waiting period for new versions, bundled dependencies, trusted publishing, provenance |
| Denial of service by input | Deadlines on git and on hooks; budgets on what delivery reads and returns |

## What this does not claim

- Showing a record does not make the agent follow it, and Sphica does not block the agent.
- Sphica sends nothing itself, but what it hands to the host (records and the quotes in them) becomes part of the host's context, and goes wherever the host sends that.
- Masking catches secrets with a known shape only, and only in the text Sphica takes in. Anything else is stored as typed, and a record's own text is stored as the agent wrote it.
- Forgetting removes sources from the database. It does not touch copies outside it: files still waiting in the capture queue, and backups of the database made before a migration. A record that repeated the text keeps its own words.
- The database roles guard against Sphica's own mistakes, not against another program of the same user.
- Reviewing a pull request from a fork follows written steps that keep its code from running before the maintainer approves it. The reviewer still reads text a stranger wrote.
