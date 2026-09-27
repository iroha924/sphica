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

First, classify the change with `bun run release:plan -- --base <previous release commit>`.

**The owner does only these 3, plus `/reload-plugins` in open sessions after arrival, and Claude does not click or run them in the owner's place.** Claude runs every other command exactly as written in the steps below.
Before each of them, hand the owner what to approve (the run URL, the stage ID, the version) and wait.

| Step | What the owner does | Why |
|---|---|---|
| 6 | Approve the `npm-release` environment on the GitHub Actions run page | The owner is the only reviewer |
| 7 | Look at provenance in npmjs.com's Staged Packages and approve with 2FA (rejecting uses the same page) | 2FA is on the owner's device |
| 10 | Run `npm dist-tag add` in their own terminal (the `!` prefix is only for this session's input box; in a shell, `!` inverts the exit code) | npm commands that ask for an OTP fail with EOTP in Claude's shell, which has no TTY, because the auth URL is masked as `***` |

Local npm (11.12.1, bundled with mise's Node 24.15.0) has no `npm stage`, so use the same version as the release job's Node 24.21.0
through `npx -y npm@11.19.0`. Run other npm commands with local `npm`. If `npm stage download` asks for auth,
Claude runs `npm login --auth-type=web` and has the owner open the URL it prints (this command does not mask the URL).

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

- GitHub: the `npm-release` environment (reviewer is the owner, self-approval prevention off, deployments allowed from tags `v*`).
  `prepare` in `release.yml` rejects an environment with no approver
- GitHub: a ruleset limiting creating, updating, and deleting tags `v*` to the owner
- npm: trusted publisher (repository `iroha924/sphica`, workflow `release.yml`, environment `npm-release`,
  staging only, no direct publish), 2FA required, publishing with tokens disallowed

3. Open a PR and pass CI (`check`, `pr-body`) and the Codex review. Keep main merged into the PR branch
   (if main has moved ahead, the tree CI checked and the tag's tree do not match)
4. Run `git tag v<version> <head>` on **the PR head** and push it. Tagging the head, not main, lets the candidate be checked before the merge.
   Only the owner's account can create tags (the ruleset limits it). Claude pushes with the owner's credentials on this machine
5. `.github/workflows/release.yml` runs. `prepare` checks that the tag matches every version, that the tag's commit is the head of an open PR into main,
   and that `check` and `pr-body` succeeded on that head (`scripts/release-gate.mjs`); after `verify`, it runs
   `npm pack` and checks the result with `scripts/check-tarball.mjs` (the file list, starting outside the repository, `init` in a temporary HOME).
   The SHA-512 and integrity appear in the job summary
6. The owner approves the `npm-release` environment. `stage` then runs the same checks again, compares the SHA-512 of the same tarball, and
   runs `npm stage publish <tgz> --tag next --provenance`. The stage ID appears in the job summary
7. Claude runs `npx -y npm@11.19.0 stage download <stage-id>`, confirms that the `shasum -a 512` value matches the SHA-512 from step 5,
   and hands the stage ID and SHA-512 to the owner. The owner approves it in npmjs.com's Staged Packages (checking provenance and authenticating with 2FA).
   If it does not match or has no provenance, do not ask for approval; have the owner reject it on the same page
8. Right before merging, check that the PR's head and base have not moved, and merge with `gh pr merge <PR> --merge --match-head-commit <head>`.
   Confirm with `git diff --exit-code <head> <merge commit>` that the tree did not change. If there is a difference,
   do not promote to `latest`
9. In a clean temporary directory, run `npm pack sphica@<version> --silent`, and confirm that the SHA-512 matches step 5 and that the repository's
   `node <repository>/scripts/check-tarball.mjs <tgz>` passes. Also check the SBOM attestation with
   `gh attestation verify <tgz> --repo iroha924/sphica --predicate-type https://cyclonedx.org/bom --signer-workflow iroha924/sphica/.github/workflows/release.yml`
10. The owner runs `npm dist-tag add sphica@<version> latest` in their own terminal. This promotes it (OIDC cannot be used for dist-tags).
    Claude checks with `npm view sphica dist-tags --json` that `next` and `latest` both point to `<version>`
11. List npm's dist-tags, the remote tag, the global CLI, the marketplace, and the Claude/Codex caches with `bun run release:status`,
    and confirm no step remains. Items it failed to observe show as `unknown`, not `none` or `not found`
12. Use the PR body's "Release notes" section as is, and
    create the GitHub Release with `gh release create v<version> --verify-tag --title v<version> --notes-file <file>`.
    The owner checked the section in the PR's final review, so do not ask again before creating it. If the section is missing or empty, do not create it; go back to the owner.
    Do not paste git log (OpenSSF Best Practices' `release_notes` does not accept it)

**Do not re-tag the same `v<version>`.** The same version cannot be staged or published twice, and provenance's references could no longer be followed.

- Failed before or after staging: the owner rejects the stage in Staged Packages; fix it, bump the version, and ship again with a new tag
- Could not merge after approval: do not promote to `latest`; the owner runs `npm dist-tag add sphica@<previous good version> next` in their own terminal to put `next` back,
  and ship again with a new version
- Do not rerun the run after `stage` succeeded (a stage of the same version would collide)

So that the marketplace never points to an unpublished version between the merge and npm approval, finish the approval before the merge (steps 7 then 8).

## Confirming it arrived

**Claude runs every step here on the owner's machine**, including the backup and moving an old-generation DB aside. Do not hand the owner a list of
commands (measured 2026-09-26: handed over, the owner answered that only `/reload-plugins` is theirs). The owner runs only `/reload-plugins`
in open sessions. `sphica doctor` shows "npm package versions" and "Plugin channel versions" separately.

1. **Run `npm i -g sphica@<version>`.** The CLI installed with `npm i -g` is a separate path from the plugin cache,
   and host updates do not upgrade it. **In a release that raised the DB revision, forgetting this leaves only the old CLI
   failing with "expects revision N"** (measured: after moving to revision 5, the global CLI stayed at 0.32.0)
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

`plugin/skills/review/reviewers/` also goes through the cache, so saving or restarting a session does not give the new text.
When changing aspects, read `plugin-agent-authoring` first too.

## Plugin Skills

- For a Skill that should start only when explicitly called, pair `disable-model-invocation: true` in SKILL.md (Claude Code) with
  `policy.allow_implicit_invocation: false` in the Skill directory's `agents/openai.yaml` (Codex). Codex does not read the former.
  `verify:ai` checks the pair
- Pre-approval of MCP tools in `allowed-tools` is unverified on a real host for the record server's tools. Check it after delivery with
  `claude -p "/sphica:<skill>" --plugin-dir <plugin> --permission-mode default --output-format json` and an empty `permission_denials`
- When checking after delivery, confirm in Codex that the body is read when explicitly started with `$sphica:<skill>` too

Check the human-facing CLI output and the AI-facing MCP replies separately.
