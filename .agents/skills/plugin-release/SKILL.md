---
name: plugin-release
description: Ships changes to Sphica's MCP servers, CLI, capture and delivery hooks, or plugin Skills and Agents to npm. Covers bundle entry points and the modules they depend on, matching versions, and confirming delivery to both Claude and Codex. For DB schema or role changes, use knowledge-schema first, then this Skill to ship.
---

# Ship the package

## Triggers

- Changing `server/src/mcp.ts`, `server/src/cli.ts`, `server/src/capture.ts`, or modules they import
- Changing `plugin/hooks/hooks.json`
- Changing `plugin/skills/`
- Bumping the shipped version, or publishing to npm
- Investigating why local changes do not reach Claude Code or Codex

## Does not trigger

- Changing the DB schema or roles. Use `knowledge-schema` first for that (the schema ships in the package, so the release uses this Skill)

## Distribution path

**The source of truth is a single npm package**, and the Claude Code and Codex plugins point to it through the marketplace's `npm` source.
Claude Code resolves the package with the npm client and unpacks the tarball into the plugin cache.

- **No install scripts run, and no dependencies are installed.** The tarball must be self-contained
  (it ships one file each, bundled with `bun build`). The DB is `node:sqlite` (built into Node), so there are no native dependencies
- `sphica init` reads the bundled `db/schema.sql`. CI checks it by running `init` in a temporary HOME with the CLI from the unpacked tarball
- `dist/` holds 5 entries: `cli.js` (init, doctor, uninstall), `mcp.js` (the read MCP server), `mcp-record.js` (the record MCP server the
  trace, harvest, and glean Skills write through), `capture.js` (recording hooks), and `deliver.js` (delivery hooks)
- The cache updates only when the version changes. `bun run bundle` or a commit alone does not deliver anything; nothing arrives until publish
- The CLI reads `dist/cli.js` where it is run, so working in the CLI is no proof that it works in MCP
- The hooks call `${CLAUDE_PLUGIN_ROOT}/dist/capture.js` and `dist/deliver.js`, so they too run at the cache's version
- The hook entries run only when their own path matches `capture.(ts|js)` / `deliver.(ts|js)`. Renaming a bundle (to `.mjs`, say) turns the hook into a silent no-op: it exits 0 and prints nothing
- **`plugin/dist` is not tracked by git.** The build is made at publish time

### How Skills do their work

Plugin Skills do not call the CLI. They use MCP tools: the read server (`sphica`) and the record server (`record`). In Claude Code a plugin's tool is
named `mcp__plugin_sphica_<server>__<tool>`, and a Skill's `allowed-tools` lists the ones it uses. Codex uses the same servers from
`plugin/mcp/codex.json`.

npm's `bin` is for the `sphica` command users get from `npm i -g`; **there is no contract that exposes it on the PATH inside the plugin**.

## Adding dependencies

`dist/` contains dependency code as is, so **bundling to 0 npm dependencies does not remove the duty to include notices**.
MIT requires the copyright notice and license text; Apache-2.0 section 4 requires a copy of the License and the contents of NOTICE (if any).

- After adding a dependency to `server/`, pass `bun run notices`. It fails if a package's SPDX cannot be read
- `bun run bundle` rebuilds `plugin/THIRD_PARTY_NOTICES.md` from `node_modules`. It is untracked and ships in what is published
- For packages that do not include their license text, supply a copy in `scripts/licenses/<SPDX>.txt`. Where there is no copy, cite the source
- **Do not add GPL / AGPL / SSPL dependencies.** They would stop us from shipping under MIT

## Shipping

First, classify the change with `bun run release:plan -- --base <previous release commit>`. For a `plugin` release it also reads, with the owner's gh, the settings only an admin can see (immutable releases, SHA pinning required for actions) and fails unless both are on.

**The owner does only one thing per release: approve the `npm-release` environment on the run page, plus `/reload-plugins` in open sessions after arrival.**
That approval is the only gate before npm. Claude does not do it in the owner's place, neither on the page nor through the API (`gh api .../pending_deployments`), even though this machine's `gh` could.
Claude runs every other command exactly as written in the steps below.

| Step | What the owner does | Why |
|---|---|---|
| 6 | Open the run from the link the run comments on the PR, read the PR (including its Release notes) and the OSV scan in the run summary, and approve `npm-release` with Review deployments | The owner is the only reviewer, and the release publishes, merges, and creates the GitHub Release without asking again |

Do not merge Renovate's dependency PRs (1 a month) or lockfile maintenance PRs directly. Dependencies are package inputs, so a PR
that does not bump the version fails CI's version gate. Pull them into a release PR, bump the version, ship it, and close the original PR after pulling it in
(closed first, Renovate may ignore that update). Ship vulnerability fixes without waiting for the monthly one.

| Kind | Changes | Versions to move |
|---|---|---|
| `none` | Dev docs that do not ship, repository dev Skills, tests only (the root `README.md` goes into npm, so it is `plugin`) | None |
| `plugin` | MCP, CLI, capture, hooks, plugin Skills and Agents, shared modules | The npm package and the 3 places of the plugin channel |

The source of truth for the classification is `scripts/lib/release-scope.mjs`; the version gate and
the release command read the same file.

1. Decide the release version. For `plugin`, bring all of these to it
   - npm's `package.json`
   - `plugin/.claude-plugin/plugin.json`
   - `plugin/.codex-plugin/plugin.json`
   - The **exact version** of the marketplace's `npm` source (no ranges or `latest`: the same commit would resolve
     different tarballs over time)
   - The git tag
2. Do not put `version` directly under the marketplace entry. `plugin.json` silently wins, and a stale value hides updates
Once, before the first release, the owner sets these up in the web UI (without them, the release stops or goes ahead unprotected).

- GitHub: the `npm-release` environment: the owner as the only required reviewer, self-review prevention off (the owner's account pushes the tag),
  admin bypass off, deployments allowed only from tags `v*`. `scripts/release-env.mjs` stops the release in `prepare` and again in `publish` if any of this drifts
- GitHub: a ruleset limiting creating, updating, and deleting tags `v*` to the owner
- npm: trusted publisher (repository `iroha924/sphica`, workflow `release.yml`, environment `npm-release`, direct `npm publish` allowed),
  2FA required, publishing with tokens disallowed. A connection cannot be edited: to change one, delete it and create it again

3. Open a PR with the "Release notes" section filled in, and pass CI (`check`, `pr-body`, and `release`, the dry run). Keep main merged into the PR branch
   (if main has moved ahead, the tree CI checked and the tag's tree do not match). The owner checks the Codex review of the last head and shares its findings;
   fix or decline each and resolve every thread before tagging
4. Run `git tag v<version> <head>` on **the PR head** and push it. Tagging the head, not main, lets the candidate be checked before the merge.
   Only the owner's account can create tags (the ruleset limits it). Claude pushes with the owner's credentials on this machine
5. `.github/workflows/release.yml` runs. `prepare` checks that the tag matches every version, that the tag's commit is the head of an open PR into main,
   that `check`, `pr-body`, and `release` succeeded on that head, and that no review thread is left open (`scripts/release-gate.mjs`), and that only the owner can approve `npm-release` (`scripts/release-env.mjs`);
   after `verify`, it runs `npm pack` and checks the result with `scripts/check-tarball.mjs` (the file list, starting outside the repository, `init` in a temporary HOME).
   It also stops when the PR has no Release notes, and records a digest of the notes the owner is about to read.
   The SHA-512 appears in the job summary, and the run comments on the PR with its URL. Claude hands that URL to the owner.
   Beside `prepare`, `osv` scans the tag commit's dependencies with osv-scanner (`scripts/osv-summary.mjs`): the run summary shows the scanned SHA and
   `found` (with a table of packages and IDs), `none`, or `unavailable` (the scan left no readable results), and the PR comment carries the same one line.
   Neither findings nor a failed scan stop the release; `publish` waits only for the scan to finish. When the job fails before it can scan
   (the scanner image is pulled while the job is set up), the comment says how the `osv` job ended instead. Claude tells the owner the line when handing over the URL
6. The owner approves the `npm-release` environment on the run page. `publish` then runs both checks again, compares the SHA-512 of the same tarball,
   attests the SBOM, and runs `npm publish <tgz> --tag latest --provenance` (trusted publishing, no token). The version is the default install from here
7. `merge` merges the PR with `gh pr merge <PR> --merge --match-head-commit <head>` using the run's token. A merge by that token starts no other workflow,
   so `refresh-scans` then starts `osv-scanner.yml` and `scorecard.yml` on main with `gh workflow run` (a dispatch by the token does start them)
   and lists each run's URL in its summary. A failed dispatch only warns; the release does not fail for it
8. `finish` runs `scripts/release-finish.mjs`. npm serves a published version a few minutes later (2 min 15 s for 0.5.4, about 6 min for 0.5.5 and 0.5.6), so it first waits up to 12 minutes for it. Then: the merge commit's tree equals the tag's (`git diff --exit-code <head> <merge commit>`), the tarball npm serves
   has the SBOM attestation from this tag (`gh attestation verify <tgz> --repo iroha924/sphica --predicate-type https://cyclonedx.org/bom --signer-workflow iroha924/sphica/.github/workflows/release.yml --source-ref refs/tags/v<version>`),
   and npm `latest` is the version. It then creates the GitHub Release from the PR body's "Release notes" section as is, only if the notes still match the digest from step 5
   (`gh release create v<version> --verify-tag --title v<version> --notes-file <file>`; not git log, which OpenSSF Best Practices' `release_notes` does not accept) closes the issues the PR closes that are still open (a merge by the run's token does not close them), and comments the result on the PR
9. Claude follows the run with `gh run watch <run-id> --exit-status`. When it succeeds, list npm's dist-tags, the remote tag, the global CLI, the marketplace,
   and the Claude/Codex caches with `bun run release:status`, and confirm no step remains. Items it failed to observe show as `unknown`, not `none` or `not found`.
   Then watch the two scan runs `refresh-scans` listed (`gh run view <release run-id> --log --job <refresh-scans job id>` shows the URLs) with
   `gh run watch <id> --exit-status`. A line without a URL is reported as not observed; do not take an earlier run of the same workflow in its place

**Do not re-tag the same `v<version>`.** A published version can never be published again, and provenance's references could no longer be followed.

When a job fails, `report-failure` comments on the PR with the failed jobs and whether npm has the version (`yes`, `no`, or `unknown`; for `unknown`, check `npm view sphica@<version> version` by hand).

- `prepare` stopped only because review threads are open: nothing shipped and the tag still points at the head. Resolve each (decline it in the PR body's "Declined findings"), then run `gh run rerun <run-id> --failed`, without bumping the version. If a finding needs a fix, the fix is a new head the tag does not point to: bump the version and tag again
- npm does not have it (failed in `prepare` or `publish` for any other reason): nothing shipped. Fix it, bump the version, and ship again with a new tag
- npm has it but `merge` failed: the version is already `latest` while main lacks it. The owner decides whether to put `latest` back by running
  `npm dist-tag add sphica@<previous good version> latest` in their own terminal (the `!` prefix is only for this session's input box; in a shell, `!` inverts the exit code).
  That command asks for an OTP, which fails in a shell without a TTY such as Claude's. Fix the PR and ship a new version; never reuse the published one
- `finish` failed after the merge: nothing is published again. If npm still did not serve the version after finish's wait, wait a few more minutes,
  then rerun the failed job with `gh run rerun <run-id> --failed` (creating the Release is skipped when it exists),
  or run the failed check by hand with the commands in step 8
- Do not rerun `publish` after it succeeded
- `refresh-scans` warned that a dispatch failed, or a scan run it started failed: npm and the merge are done, so nothing is released again.
  Start the scan on main by hand with `gh workflow run <osv-scanner.yml or scorecard.yml> --repo iroha924/sphica --ref main` and watch that run

So that the marketplace never points to an unpublished version, the run publishes before it merges (steps 6 then 7).

## Confirming it arrived

**Claude runs every step here on the owner's machine**, including the backup and moving an old-generation DB aside. Do not hand the owner a list of
commands (measured 2026-09-26: handed over, the owner answered that only `/reload-plugins` is theirs). The owner runs only `/reload-plugins`
in open sessions. `sphica doctor` shows "npm package versions" and "Plugin channel versions" separately.

1. **Run `npm i -g sphica@<version>`.** The CLI installed with `npm i -g` is a separate path from the plugin cache,
   and host updates do not upgrade it. **In a release that raised the DB revision, forgetting this leaves only the old CLI
   failing with "expects revision N"** (measured: after moving to revision 5, the global CLI stayed at 0.32.0).
   Run it from the home directory too (`cd ~ && npm i -g sphica@<version>`): with a per-directory Node (mise), `npm i -g` inside
   this repository installs only into the Node its `mise.toml` pins, and `sphica` is then "command not found" everywhere else (measured 2026-09-28)
2. If the release changed the DB generation, copy `~/.sphica/sphica.db` (with `-wal` and `-shm`) to a dated backup, move it aside, and run
   `sphica init` in each registered repository (the old records are not carried over; say so in the report). A revision change within a
   generation needs the migration `knowledge-schema` says to design first
3. Claude Code: `claude plugin marketplace update sphica && claude plugin update sphica@sphica`. Codex:
   `codex plugin marketplace upgrade sphica && codex plugin add sphica@sphica`. Then ask the owner to run `/reload-plugins` in open sessions.
   In sessions without an interactive terminal, MCP stays at the old version until the next session.
   In Codex, ask the owner to open `/hooks` and trust Sphica's hooks: Codex records trust per hook, so a hook added or changed by the update
   stays skipped until trusted (capture keeps running, which hides it)
4. In `sphica doctor`, check that the npm package matches between the repository and the global CLI, that the plugin channel matches between the repository
   and both hosts' caches, and that no reconnect instruction remains for the running MCP
5. From a session after the update, call `status` and `search`, and check the contents of the changed MCP tools, Skills, and Agents. If capture
   changed, also check that this session's messages are found by `search` with `sources: true`, and that the "Recording" line in `sphica doctor`
   has nothing waiting. If delivery changed, read and then edit a file with an anchored record and check the hook's context arrived (a read shows each record once per session)
6. Claude also runs the installed plugin headless, pointing `SPHICA_DB` at a temporary database so the owner's `~/.sphica` is untouched: in a scratch
   repository with one anchored record, `claude -p` (a prompt that reads the file, and the user's own review command) and `codex exec` (the same, after
   the owner trusted the hooks in `/hooks`; `--dangerously-bypass-hook-trust` shows only that the hooks work, not that they are trusted). Check the
   delivery rows, the first Sphica tool call, and the final answer. Report how many runs showed the behavior, not one run as proof
   For `codex exec`, `SPHICA_DB` is not enough: Codex starts MCP servers without it, so `read` and `search` hit the owner's `~/.sphica` (measured 2026-09-27).
   Put the database at `<tmp>/.sphica/sphica.db` and run with `HOME=<tmp>`, `CODEX_HOME=$HOME/.codex` (the installed plugin and its trust), and the real
   Node directory first on `PATH` (mise shims look under `HOME`)

`plugin/skills/review/reviewers/` also goes through the cache, so saving or restarting a session does not give the new text.
When changing aspects, read `plugin-agent-authoring` first too.

## Plugin Skills

- For a Skill that should start only when explicitly called, pair `disable-model-invocation: true` in SKILL.md (Claude Code) with
  `policy.allow_implicit_invocation: false` in the Skill directory's `agents/openai.yaml` (Codex). Codex does not read the former.
  `verify:ai` checks that Codex is never looser than Claude Code (it may be stricter, as trace is), and that the description says "Use only when the user explicitly asks" exactly for such a Skill (an agent decides
  from the description whether to start it)
- Pre-approval of MCP tools in `allowed-tools` is unverified on a real host for the record server's tools. Check it after delivery with
  `claude -p "/sphica:<skill>" --plugin-dir <plugin> --permission-mode default --output-format json` and an empty `permission_denials`
- When checking after delivery, confirm in Codex that the body is read when explicitly started with `$sphica:<skill>` too

Check the human-facing CLI output and the AI-facing MCP replies separately.
