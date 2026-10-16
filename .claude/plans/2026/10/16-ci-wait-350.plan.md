---
kind: plan
status: approved
codex_session: 01a14319-5e81-7432-85b8-432a69b7abc9
codex_rounds: 4
approved_at: 2026-10-16
---

# Shorten the CI critical path, run pre-push verify only for main, skip the duplicate push run, and fix #350

## 要点

- Windows job: the "without node" launch-line case runs through cmd.exe only instead of all 5 outer shells (about 124 s less); the other cases still run through every shell
- Unit part: a new `unit` entry runs what `sql:reach` runs; CI sets `SPHICA_UNIT_MODE=tests-only` on Node 24.15 so that line runs the tests without coverage or SQL reach. Node 26 keeps both. Then a concurrency trial (3 vs 4, same tree and seed) decides whether `--test-concurrency=4` stays
- Pre-push: one script reads Git's lines once, checks commit messages, then runs `verify` only for an update of main and `check` (about 5 s) for any other push. The macOS-only test branches pre-push used to cover move into the `macos` CI job
- Push to main: a `same-tree` job runs the push-range commit-message and version checks, then lets the heavy jobs skip when the merged PR's last check.yml run on its head succeeded and the merged tree is the one that run tested. check.yml's pull_request trigger is limited to PRs into main
- #350: the runner's combined check accepts a refusal by either fence; a new probe checks the OS fence alone, with a connecting control; `macos` runs on Node 24.15 and 26
- Unchanged: required check names, `server/package.json` and everything in the package (release kind none), the part matrix

## 持ち主の決定

- Cut the CI wait further and stop running what need not run; put issue #350 in the same PR
- Unit: on Node 24.15 run tests without coverage and SQL reach, take both on Node 26 only; try test concurrency 4 and keep it only if it helps
- Review the triggers too (added mid-planning): pre-push runs verify only for main (lighter for other pushes); skip the push-to-main run that repeats the PR's run
- Not adopted: static on one Node line only; skipping CI for docs-only pushes; splitting unit into two jobs with merged coverage; skipping heavy jobs on docs-only PRs (dropped after the count below)

## 目的

- The time from a PR run's start until its last required check finishes is shorter than on main (baseline run 38843855408: `part (24.15, unit)` 6.1 min, `windows` 6.0 min, `part (26, unit)` 5.6 min)
- A push to a work branch waits for `check` (seconds), not `verify` (134-160 s)
- A push to main from a merged PR whose head passed check.yml runs only `same-tree` and the gates
- `server/test/hidden-runner.test.ts` passes on Node 24.15 and 26 on macOS, and CI runs it on both

## 対象外

- Skipping heavy jobs on docs-only PRs: 0 of the last 40 merged PRs would qualify (README is copied into the package and checked by `tarball.test.ts` and `plugin.test.ts`), and the decision job before the parts would add 15-20 s to every PR
- The gate jobs `check (24.15)` / `check (26)` setup (25-28 s; only setup-node's 5-6 s could go, with the judge then on the image's unpinned Node)
- Installing lychee only in static (0-1 s per job in 12 samples)
- The 24-50 s a Windows user without node waits per hook: changing `plugin/hooks/codex.json` is a release and users re-trust hooks
- osv-scanner, scorecard, zizmor push triggers (security scans, not a repeat of the PR run)
- The "Measure hook launch" step stays (22 s; evidence behind the exec-form decision, record u188)

## 前提

- Baseline timings: `gh run view 38843855408` / `38835012028` jobs and steps (2026-10-16). Required checks (ruleset "Main"): `check (24.15)`, `check (26)`, `windows`, `verification-section`; `macos` is not required. Ruleset: merge method `merge` only, strict required checks, non-fast-forward forbidden, bypass for the admin role. Repository is public
- Windows log of run 38843855408, step "Does the shipped tarball start on Windows" 243 s; "without node" 50387 / 24598 / 24422 / 24413 / 24188 ms through powershell.exe / pwsh / cmd.exe / COMSPEC / Git Bash. Every outer shell runs the same `powershell.exe -EncodedCommand` (`plugin/hooks/codex.json` commandWindows); cases at `scripts/check-hooks-live.mjs:517-547`
- `server/package.json:11` test script: coverage flags, then `$TEST_ORDER test/*.test.ts`. A later `--no-experimental-test-coverage` turns the coverage report off on Node 24.15 (measured). `server/package.json` is a package input (`scripts/lib/release-scope.mjs:9`); `scripts/`, `server/test/`, `server/evals/` are not (`:18`)
- `scripts/check-sql-reach.mjs:130` calls `main()` at import; `:41` sets `NODE_V8_COVERAGE`. `scripts/lib/test-run.mjs:52,65` return problems without setting the exit code
- `scripts/lib/verify-pairs.mjs` checks the part step (`PART: ${{ matrix.part }}`), that the ci:<part> chains add up to verify, the gate job, lychee, and setup-bun caching. `scripts/lib/check-parts.mjs:13` requires every expected need to succeed
- PR #349 body: local unit 109 s on 24.15 with coverage vs 90 s without; 95 s vs 91 s on 26; pre-push verify 134-160 s. Local unit at `--test-concurrency=3`: 159 s wall, 429 s summed
- lefthook v2.1.14 `docs/configuration/use_stdin.md`: with several `use_stdin: true` jobs only one receives the data. Git pre-push lines: `<local ref> <local oid> <remote ref> <remote oid>`; the local ref may be an expression or `(delete)` (https://git-scm.com/docs/githooks#_pre_push, 2026-10-16)
- macOS-only test branches that only pre-push verify runs today: `server/test/eval-claude.test.ts:1694,1774` (collection on Darwin), `server/test/review-eval.test.ts:204,496` (the real sandbox runner on Darwin)
- PR run provenance, observed on PR #349: merge 1a92b342 has parents 5a837965 (main before) and 664e82cd (PR head); `actions/workflows/check.yml/runs?event=pull_request&head_sha=664e82cd…` returns run 38837546283 (completed, success, suite 105251160807); the check runs on 664e82cd belong to that suite. The run API's `pull_requests` is empty, so a run's base is not observable from it. 193 of 195 PRs targeted main
- Node 26.10.0 `--permission` without `--allow-net` refuses fetch with `ERR_ACCESS_DENIED` (#350). `hiddenProfile` is exported (`server/evals/cloud/hidden-test.ts:40`)
- Unverified: whether concurrency 4 helps on the 4-vCPU runner

## 方針

S1. `scripts/check-hooks-live.mjs`: the "without node" case runs only through cmd.exe on Windows (sh elsewhere, as now); "node exiting 0" and "node exiting 7" still run through every shell. The comment says why one shell is enough: every outer shell runs the same inner PowerShell, and "node exiting 7" shows each outer shell passes a non-zero code.

S2. Unit entry:
- Split `scripts/check-sql-reach.mjs` so the counting is an importable function that does not run at import; executing the file still runs it.
- New `scripts/run-unit.mjs`; root `package.json` gets `"unit": "node scripts/run-unit.mjs"`. `verify` and `ci:unit` run `unit` in place of `sql:reach`; the `sql:reach` script stays.
- `SPHICA_UNIT_MODE`: unset or `full` calls the shared reach function. `tests-only` runs `bun run --cwd server test` through `runTestsIsolated` with `--no-experimental-test-coverage` appended to the inherited `TEST_ORDER`, deletes `NODE_V8_COVERAGE` from the child environment, and prints that reach was not counted. Problems set exit code 1. Any other value fails, naming the allowed values.
- check.yml part step env: `SPHICA_UNIT_MODE: ${{ matrix.node == '24.15' && 'tests-only' || 'full' }}`.
- verify-pairs requires that exact line in the part step, with the floor Node being the first entry of the part matrix's node list.
- Tests through the real entry point with a fake bun: success; child failure → 1; leftover → 1; tests-only adds the flag, keeps an existing TEST_ORDER, and removes a pre-existing NODE_V8_COVERAGE; unknown mode → 1; full mode fails on missing reach. Each case sets or unsets SPHICA_UNIT_MODE explicitly.
- `.claude/rules/verification.md` and CLAUDE.md change only where they say verify runs `sql:reach` by name.

S3. Concurrency trial, after S1, S2 and S5 are on the branch:
- TEST_ORDER carries `--test-concurrency=3` on both lines, and a constant `--test-random-seed` on Node 26 (randomize kept). Run CI and rerun the part jobs once.
- Then the same with `--test-concurrency=4`.
- Keep 4 only if both lines' unit step medians drop by 10% or more against 3; otherwise remove the explicit flag. Either way, restore the seed to `github.run_number`. The 4 runs' unit step times go in the PR body.

S4. #350 in `server/test/hidden-runner.test.ts`:
- Rename the combined subtest to say one of the fences refused the network. Accept `cause.code` `EPERM` or `ERR_ACCESS_DENIED`; the zero-connection assertion stays.
- In the darwin branch, after the denied probes and their assertions, an OS-only probe: `sandbox-exec -p <hiddenProfile(...)> node -e "<fetch>"` with no `--permission`, as an async child with a timeout, expecting `EPERM` and no connection.
- A control runs the same `node -e` without sandbox-exec against a separate listener and asserts that listener accepted at least one connection (the fetch may reject: the listener destroys sockets).
- The probe is built in the test from the exported `hiddenProfile`.
- check.yml `macos`: `strategy.matrix.node: ["24.15", "26"]`, `node-version: ${{ matrix.node }}`.

S5. Pre-push:
- One lefthook pre-push job, `use_stdin: true`, running `scripts/pre-push.mjs` (the git variables removed from children as today).
- It reads all lines, validates four fields per line (local ref need not start with `refs/`; deletion is `(delete)` with a zero local oid), and fails on a malformed line.
- It runs the commit-message check on the same lines (shared function or the existing script with the lines on stdin) and stops on its failure.
- Then `bun run verify` if any line is a non-deletion update of `refs/heads/main`, else `bun run check`.
- Tests with faked children: main → verify; work branch → check; HEAD~1 as source; new ref (zero remote oid); tag; deletion of main → check; mixed main + branch → verify; malformed trailing line → fail; commit-message failure → stops before any check.
- check.yml `macos` job also runs `server/test/eval-claude.test.ts` and `server/test/review-eval.test.ts` whole, TAP, `# fail 0`, and a grep for one named Darwin-branch test of each passing.
- CLAUDE.md command list and lefthook.yml comments: CI runs verify; pre-push runs verify before a push to main and `check` before any other push.

S6. Skip the push run that repeats the PR's run (check.yml):
- `pull_request: branches: [main]`.
- New job `same-tree`, `if: github.event_name == 'push'`, `permissions: { contents: read, actions: read }`, checkout with full history. First it runs `check-commit-msg.mjs --range <before>..HEAD` and `check-mcp-version.mjs --base <before>`; either failing fails the job.
- Then a script `scripts/same-tree.mjs` (logic in `scripts/lib/`, tested) sets output `tested=true` only when all hold:
  - HEAD has two parents; HEAD^1 equals `github.event.before`; `git merge-base --is-ancestor HEAD^1 HEAD^2`; `HEAD^{tree}` equals `HEAD^2^{tree}`.
  - HEAD^2's `.github/workflows/check.yml` limits pull_request to main.
  - The latest check.yml `pull_request` run with head_sha HEAD^2, chosen over all statuses (by created_at, then run_attempt), is completed with conclusion success.
  - Anything else (no run, a newer unfinished run, a tie, an API error) gives `tested=false` with the reason printed.
- `part`, `macos`, `windows`, `git-2-34`: `needs: same-tree`, `if: ${{ !cancelled() && !(needs.same-tree.result == 'success' && needs.same-tree.outputs.tested == 'true') }}`.
- Gate `check`: `needs: [same-tree, part]`, `if: always()`, `EVENT: ${{ github.event_name }}`. `check-parts` table:
  - push: same-tree must be success; with tested == 'true' a skipped part passes, otherwise every part must succeed.
  - pull_request: same-tree must be skipped and every part must succeed.
  - A failed, cancelled or missing part fails; a missing or other EVENT fails.
- verify-pairs: rules for the pull_request branch filter, every heavy job's needs and exact predicate, and the gate's needs and EVENT; tests for each mutation and for the valid configuration (which main's verify-pairs rejects).

## 採った案と棄却した案

- 採用: "without node" through cmd.exe only。棄却: all 5 shells (124 s for the same inner script)
- 採用: one `unit` entry with `SPHICA_UNIT_MODE`, checked by verify-pairs as one exact line。棄却: a `ci:unit-floor` variant script (variant discovery, matrix exclusion, chain substitution rules)
- 採用: the coverage switch in root scripts and the workflow。棄却: editing `server/package.json` (package input: bump and release)
- 採用: concurrency 3 vs 4 on the same tree, one seed, 2 samples each。棄却: 4 against main's historical runs (coverage and seed confound it)
- 採用: combined check accepts either fence, plus an OS-only probe without `--permission`。棄却: accept either code only (OS fence unchecked on Node 26)。棄却: `--allow-net` on the probe (only on Nodes that have it)
- 採用: one pre-push script that reads stdin once。棄却: two `use_stdin` jobs (only one receives the data)
- 採用: Darwin test files in the `macos` job。棄却: keep them covered by pre-push only (lost once work-branch pushes run check)
- 採用: reuse evidence = whole-workflow success of the latest PR run on HEAD^2 plus ancestry and tree equality, PRs limited to main。棄却: three named check runs (other runs or attempts, misses macos and git-2-34)。棄却: storing each run's tested tree as an artifact (more moving parts; the ancestry argument covers it except an admin force-push)
- 採用: push-range commit-message and version checks always run on push。棄却: skipping them with the heavy jobs (the merge commit's own message is checked only on push)
- 採用: lychee in every part, gate setup unchanged。棄却: static-only lychee (0-1 s), dropping setup-node from gates (about 6 s, unpinned Node)

## 手順

- S1: Windows "without node" through one shell
- S2: `unit` entry, mode env, verify chain, check.yml env line, verify-pairs rule, docs
- S3: concurrency trial and its outcome
- S4: #350 test fix and macOS on both Node lines
- S5: pre-push script, lefthook, Darwin files in macos, docs
- S6: same-tree job, pull_request filter, job predicates, gate table, verify-pairs

## 完了条件

- A1: `caffeinate -i bun run verify` → exit 0, `SQL: tests ran N / N sites`
- A2: on Node 26.10.0 and 24.15.0 locally, `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern="on macOS the sandbox" test/hidden-runner.test.ts` → pass 1, fail 0
- A3: `node --test server/test/verify-pairs.test.ts server/test/check-parts.test.ts server/test/same-tree.test.ts server/test/run-unit.test.ts server/test/pre-push.test.ts` → all pass; with main's `scripts/lib/verify-pairs.mjs` and `scripts/lib/check-parts.mjs` restored in a temporary worktree, the tests for the valid new configuration fail
- A4: `git push origin <work branch>` → the hook output shows the commit-message check and `bun run check`, not verify; `printf 'refs/heads/main <oid> refs/heads/main <oid>\n' | node scripts/pre-push.mjs` in a throwaway clone with a fake bun → runs verify
- A5: `gh pr checks <PR>` → on the final head, every check passes, including `macos (24.15)` and `macos (26)` with the eval-claude and review-eval steps; the PR body reports, against run 38843855408, the `windows` job time, both unit step times, and the time until the last required check finished
- A6: `gh run view <push run on main after the merge> --json jobs` → `same-tree` success with `tested=true` in its log, part, macos, windows, git-2-34 skipped, both gates success; on `tested=false`, its printed reason is reported to the owner
- A7: `bun run release:plan -- --base <main>` → release kind none

## リスク

- An admin force-pushes main between a PR run and its merge → the reuse can trust a run whose base is gone; not detected, accepted (the ruleset forbids it for everyone else)
- The OS-only probe passes for the wrong reason → it asserts `cause.code === "EPERM"` from fetch, and the control shows the same code connects without the sandbox
- Node 26 unit becomes the critical path and the total barely moves → reported in A5; any further step is its own issue
- CI noise hides the concurrency effect → 2 samples per setting and the 10% rule; when in doubt, keep the runner default
- `SPHICA_UNIT_MODE=tests-only` set locally turns off reach → only that exact value does it, and the run says reach was not counted
- A failing commit reaches the PR's CI because pre-push ran only `check` → CI still blocks the merge; the push to main still runs verify
- A PR into another branch gets no check run → it lands in main only through a PR into main, which runs check

## 未解決

なし

## 変更履歴
- 2026-10-16 / the gate jobs also need and judge `macos` (Node 24.15 and 26), skipped only on a tested push like the parts / the full-diff review found a macOS failure did not block the required checks, which weighs more once pre-push no longer runs the suite on macOS for work branches / the owner chose this option (Go given in the conversation)
