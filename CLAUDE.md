<!--
For maintainers. Claude Code does not read AGENTS.md when CLAUDE.md exists, and Codex does not read CLAUDE.md.
Rules copied to both are tied by the invariant at the end of the line. When you change one, fix the line with the same name in AGENTS.md too (verify:ai compares the sets of names).
-->

# Sphica

## command

```bash
mise trust && mise install  # trust mise.toml and install Node, Bun, and actionlint at its versions
bun run setup             # install dependencies and Lefthook from the pinned lockfile
bun run verify            # lint, types, AI config, boundaries, bundle, tests, SQL reach, CLI child processes, acceptance cases. pre-push and CI run the same
bun run verify:ai         # static checks of CLAUDE.md, AGENTS.md, Skills, and Agents
bun run fix               # format and apply safe lint fixes with the pinned Biome (`bunx biome` runs an unrelated npm package)
bun run bundle            # build the MCP servers, CLI, and hook artifacts
```

Start troubleshooting with `sphica doctor`.

## Runtime boundaries

- `db/schema.sql` is the only source of truth for the DB. Do not add an ORM schema as a second source <!-- invariant: schema-single-source -->
- The read MCP server (`server/src/mcp.ts`: status, search, read) and `doctor`'s reads use the reader connection, the record MCP server (`server/src/mcp-record.ts`) and project registration in `init` use ingest, capture uses capture, and creating the database, `doctor`'s database check (the full-text index integrity check needs a writable connection), and `doctor --reindex` use owner. <!-- invariant: connection-roles -->
  Write connections live only in `server/src/db-write.ts` (`bun run architecture` checks it)
- Records are written only through the record MCP server's run-bound tools: `trace_begin`, `harvest_begin`, and `glean_begin` bind a run to one project and one target, and `record_check` and `record_save` take that run id, never a project, session, pull request, or SQL from the record. The CLI carries only `init`, `doctor`, and `uninstall`; trace, harvest, glean, and review run as slash commands <!-- invariant: record-writes -->
- No server that listens <!-- invariant: no-listen -->
- No HTML or Markdown progress files. The DB is the source of truth for records <!-- invariant: no-progress-files -->

## When changing things

- Check the CLI separately from MCP. One working does not mean the other works <!-- invariant: exits-separate -->
- When you change a value, category, or decision, find every reference with `rg` and fix the paired interface too. Add pairs you can list to a check <!-- invariant: rg-pairs -->
- A new ingestion source writes through the record server's run-bound tools or capture, never a bulk import <!-- invariant: harvest -->
- A change that goes into the package bumps npm and the 3 plugin manifests to the same version, in the same branch (PR) <!-- invariant: version-sync -->
- Validate external input at the system boundary. Do not write credentials to tracked files, command arguments, or logs <!-- invariant: boundary-validation -->
- What we ship runs on Windows too. Do not depend on a POSIX shell, `0600`, a fixed `/tmp`, or execFile of `.cmd` <!-- invariant: windows -->
- Write strings and comments in new or changed code, and commit messages, in English. Translate existing Japanese text into English stage by stage, and do not translate records users saved (`bun run english` checks the English-only files) <!-- invariant: english-code -->
- Print CLI output with the parts in `server/src/cli/view.ts` (Clack in a terminal, indented text in pipes). Only the heading and the closing line start a line, so text from outside cannot forge lines <!-- invariant: view-parts -->

## Skills by task

Read to the end before implementing.

- DB schema, connection roles, full-text search index, ingestion: `knowledge-schema`
- MCP servers, CLI, capture and delivery hooks, plugin distribution: `plugin-release`
- Shipped review aspects: `plugin-agent-authoring`
- Running the evaluation loop on Claude and Codex (cloud routines, local Codex, fixtures, grading): `eval-loop`
- Creating Skills, Agents, and rules: `docs-author`

## Branches and PRs

Only changes that alter none of runtime behavior, data, auth, secrets, dependencies, build, CI, or the package, and that one commit's revert undoes, go straight to main.
Everything else, and any change whose impact you cannot state right away, goes through a PR.

## Before implementing

For a change in behavior, work out the plan with Codex using the `grill-codex` Skill before implementing, and get the owner's Go on the plan in `.claude/plans/`.
The plan records the implementation plan as agreed; it is not a progress file (do not append progress).

## Review

Hand it over only after `bun run verify` passes.

- `review-shipping`: before a commit that changes the package, versions, bundle inputs, or check scripts
- Codex: before merging each PR. Ask by following the `codex-review` Skill
- GitHub's Codex (ChatGPT connector) reviews a PR automatically when it is created. Claude owns watching it and deciding on re-reviews; the owner only looks at finished PRs.
  The summary comment's table (Codex Review Summary) is the source of truth: when the head commit's Code Review is Completed, it is done (👀 in the PR body means running,
  👍 means everything finished with no findings). Findings are unresolved review threads, Security Review ones included; read each, decide whether to fix or decline it, then resolve it.
  One round, one request: fix every finding of the round, push once, confirm it reached the remote, then comment `@codex review` once (it posts under the owner's name, and a request on a head you are about to replace is a wasted round).
  Stop when a round has no P1 and every new P2 is an edge input; record those in the PR body's "Declined findings".
  File an issue for a declined finding only when it will really help later (you can say what would make it worth revisiting), and ask the owner first. If none is worth one, finish without mentioning it.
  Ask the owner for the final call only when the head's Code Review is Completed, there are 0 unresolved threads, and CI has fully passed

## Text that goes out

PRs follow `.github/pull_request_template.md` and issues follow `.github/ISSUE_TEMPLATE/`; delete sections you cannot fill. <!-- invariant: external-text -->
The body is ingested into the DB as is and quoted as something said, so do not write facts you have not checked.
