---
kind: tasks
plan: 16-ci-wait-350.plan.md
branch: ci/ci-wait-350
base: main
---

# Shorten the CI critical path, run pre-push verify only for main, skip the duplicate push run, and fix #350 のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: Windows の重複と #350

Windows job が約 2 分縮み、hidden runner の検査が Node 24.15 と 26 の macOS で通って CI でも両方流れる。

- [ ] T01: run the "without node" launch-line case through cmd.exe only on Windows
  - 種別: 変更
  - 計画: S1
  - 依存: なし
  - 変更: `scripts/check-hooks-live.mjs`
  - 完了条件: `bun run hooks:live` → exit 0 on macOS, the sh line still lists "without node"; the Windows job's log on this branch's CI lists "without node" for cmd.exe only
  - コミット: `ci(windows): check the missing-node launch line through one shell (T01)`

- [ ] T02: check both fences in the hidden runner test and the OS fence alone, on both Node lines in CI
  - 種別: 修正
  - 計画: S4
  - 依存: なし
  - 変更: `server/test/hidden-runner.test.ts`, `.github/workflows/check.yml`
  - red: `cd server && mise exec node@26.10.0 -- node --import ./test/isolate-home.ts --test --test-name-pattern="on macOS the sandbox" test/hidden-runner.test.ts` → fails with `'4 passed, 1 failed'` (#350)
  - 完了条件: `cd server && mise exec node@26.10.0 -- node --import ./test/isolate-home.ts --test --test-name-pattern="on macOS the sandbox" test/hidden-runner.test.ts` → pass 1, fail 0, and the same with node@24.15.0; with the OS-only probe's sandbox-exec removed, the test fails on the probe's EPERM assertion
  - コミット: `test(evals): check each sandbox fence on Node 24 and 26 (#350) (T02)`

## P2: unit の入口とカバレッジを片方の Node に

Node 24.15 の unit がカバレッジ無しで流れ、Node 26 と pre-push の verify は今どおり集計する。

- [ ] T03: add the `unit` entry with full and tests-only modes, run by verify and ci:unit
  - 種別: 変更
  - 計画: S2
  - 依存: なし
  - 変更: `scripts/check-sql-reach.mjs`, `scripts/run-unit.mjs`, `package.json`, `server/test/run-unit.test.ts`, `.claude/rules/verification.md`
  - 完了条件: `node --test server/test/run-unit.test.ts` → all pass (success, child failure, leftover, tests-only flags and cleared NODE_V8_COVERAGE, kept TEST_ORDER, unknown mode, missing reach in full mode); `bun run unit` → `SQL: tests ran N / N sites`
  - コミット: `ci: run the unit tests through one entry with a tests-only mode (T03)`

- [ ] T04: set tests-only on the Node 24.15 unit part and require that line in verify-pairs
  - 種別: 変更
  - 計画: S2
  - 依存: T03（the mode the env line selects is defined there）
  - 変更: `.github/workflows/check.yml`, `scripts/lib/verify-pairs.mjs`, `server/test/verify-pairs.test.ts`
  - 完了条件: `node --test server/test/verify-pairs.test.ts` → all pass, and the new valid-configuration test fails against main's `scripts/lib/verify-pairs.mjs`; `bun run pairs` → exit 0
  - コミット: `ci: take coverage and SQL reach on Node 26 only (T04)`

## P3: pre-push を main への push だけ verify に

作業ブランチへの push は数秒で終わり、pre-push だけが見ていた macOS の経路は CI の macos job が見る。

- [ ] T05: run verify in pre-push only for an update of main, and check otherwise
  - 種別: 変更
  - 計画: S5
  - 依存: なし
  - 変更: `scripts/pre-push.mjs`, `lefthook.yml`, `server/test/pre-push.test.ts`, `CLAUDE.md`
  - 完了条件: `node --test server/test/pre-push.test.ts` → all pass (main, work branch, HEAD~1 source, new ref, tag, deleting main, mixed, malformed line, commit-message failure first); `printf 'refs/heads/x <oid> refs/heads/x <zero oid>\n' | node scripts/pre-push.mjs` → runs check, not verify
  - コミット: `ci(hooks): run verify before a push to main and check before other pushes (T05)`

- [ ] T06: run the Darwin branches of eval-claude and review-eval in the macos job
  - 種別: 変更
  - 計画: S5
  - 依存: T02（the macos job's Node matrix is added there）
  - 変更: `.github/workflows/check.yml`
  - 完了条件: `cd server && node --test --test-reporter=tap test/eval-claude.test.ts test/review-eval.test.ts | tee t.tap; grep -qx "# fail 0" t.tap` → exit 0 locally, and the named Darwin tests show `ok`; `mise exec -- actionlint .github/workflows/check.yml` → exit 0
  - コミット: `ci(macos): run the Darwin-only evaluation tests (T06)`

## P4: main への push で PR の run を繰り返さない

merge 後の main への push は、push 専用の検査だけ流して重い job を省き、根拠が揃わなければ全部流す。

- [ ] T07: decide from git and the Actions API whether the pushed merge repeats a passed PR run
  - 種別: 追加
  - 計画: S6
  - 依存: なし
  - 変更: `scripts/lib/same-tree.mjs`, `scripts/same-tree.mjs`, `server/test/same-tree.test.ts`
  - 完了条件: `node --test server/test/same-tree.test.ts` → all pass (true case; one parent; HEAD^1 not before; not an ancestor; tree differs; no branch filter in HEAD^2's check.yml; no run; newer unfinished run over an older success; tie; non-success; API error)
  - コミット: `ci: tell whether a push to main repeats its pull request's passed run (T07)`

- [ ] T08: make check-parts event-aware for the same-tree job
  - 種別: 変更
  - 計画: S6
  - 依存: なし
  - 変更: `scripts/lib/check-parts.mjs`, `scripts/check-parts.mjs`, `server/test/check-parts.test.ts`
  - 完了条件: `node --test server/test/check-parts.test.ts` → all pass over the whole table (push with same-tree success and tested true/false, same-tree failed with tested true, pull_request with same-tree skipped, failed/cancelled/missing part, missing EVENT)
  - コミット: `ci: judge the parts by event and the same-tree result (T08)`

- [ ] T09: add the same-tree job, limit PR runs to main, and gate the heavy jobs on it
  - 種別: 変更
  - 計画: S6
  - 依存: T07（the job runs scripts/same-tree.mjs）, T08（the gate passes EVENT and the new needs to check-parts）
  - 変更: `.github/workflows/check.yml`, `scripts/lib/verify-pairs.mjs`, `server/test/verify-pairs.test.ts`
  - 完了条件: `node --test server/test/verify-pairs.test.ts` → all pass, including mutations of each heavy job's needs and predicate, the gate's needs and EVENT, and the pull_request filter; `bun run pairs` → exit 0; `mise exec -- actionlint .github/workflows/check.yml` → exit 0
  - コミット: `ci: skip the heavy jobs when a push to main repeats a passed pull request run (T09)`

## P5: 並列数の試し

同じコードと seed で並列数 3 と 4 を比べ、効いたときだけ 4 を残す。

- [ ] T10: pin test concurrency 3 and a fixed seed for the trial
  - 種別: 変更
  - 計画: S3
  - 依存: T04（the unit parts must already run in their new modes）, T09（the trial measures the final workflow）
  - 変更: `.github/workflows/check.yml`
  - 完了条件: `gh run view <run> --json jobs` → both unit part steps' times recorded for the run and one rerun of the part jobs
  - コミット: `ci: pin test concurrency 3 and a fixed seed for the trial (T10)`

- [ ] T11: try test concurrency 4 with the same seed
  - 種別: 変更
  - 計画: S3
  - 依存: T10（the baseline it is compared against）
  - 変更: `.github/workflows/check.yml`
  - 完了条件: `gh run view <run> --json jobs` → both unit part steps' times recorded for the run and one rerun of the part jobs
  - コミット: `ci: try test concurrency 4 (T11)`

- [ ] T12: keep or drop concurrency 4 by the 10% rule and restore the seed
  - 種別: 変更
  - 計画: S3
  - 依存: T11（the measurements the rule reads）
  - 変更: `.github/workflows/check.yml`
  - 完了条件: `rg -n "test-concurrency|test-random-seed" .github/workflows/check.yml` → the seed comes from `github.run_number`, and `--test-concurrency=4` is present only if both lines' medians dropped by 10% or more
  - コミット: `ci: settle the test concurrency and restore the per-run seed (T12)`

## 記録
