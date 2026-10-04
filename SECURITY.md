# Security Policy

## Supported versions

Only the latest release published to npm under the `latest` tag receives security fixes.
Older versions do not get backports, so please upgrade before reporting.

## Reporting a vulnerability

**Do not open a public issue for a security report.** Use GitHub's private vulnerability reporting instead:

1. Open <https://github.com/iroha924/sphica/security/advisories/new>.
2. Describe the problem, the affected version (`sphica --version`), the steps to reproduce it, and the impact you observed.
3. Submit the form. Only the maintainer is notified.

Sphica is maintained by one person. Reports are handled on a best-effort basis. Issues that expose credentials, run commands, or compromise the published package are handled before any other work.
After a fix is released, a GitHub Security Advisory is published and the reporter is credited unless they ask not to be.

## Scope

In scope:

- The `sphica` npm package: the CLI, the MCP server, and the recording hooks
- The Claude Code and Codex plugins published from this repository
- The release pipeline in `.github/workflows/`

Out of scope. Please report these to their own projects:

- Claude Code, Codex, Node.js, `git`, and the GitHub CLI
- The behavior of the model that reads Sphica's records

## What Sphica trusts

Sphica keeps its records in a local SQLite file (`~/.sphica/sphica.db`), with recordings that are not yet written and a few helper files elsewhere under `~/.sphica/`. It does not run a network server.
Pull request text read by the harvest Skill, as well as recorded conversations, may have been written by someone else.
Sphica treats that text as data. Sphica ships two MCP servers. The read server (status, search, read) opens the database read-only.
The record server writes records only through tools bound to one run (`trace_begin`, `harvest_begin`, or `glean_begin` starts it; `record_check` and `record_save` take its id), and removes sources only through `forget_apply` after the owner confirms. Capture writes recordings through its own connection.
A way to make Sphica write outside those paths, or to make recorded text act as instructions, is in scope.
