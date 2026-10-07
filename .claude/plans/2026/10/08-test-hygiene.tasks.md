---
kind: tasks
plan: 08-test-hygiene.plan.md
branch: fix/test-hygiene
base: main
---

# チェックの失敗の出力を捨てず、テストの一時ディレクトリの残骸を作らせない（#299、#300） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 失敗の出力を最後まで出す

テストやチェックが落ちたとき、失敗したテストの名前と詳細が切れずに出る。

- [x] T01: テストの起動・残骸の検査・後片付けを `scripts/lib/test-run.mjs` に切り出し、sql:reach から使う。失敗は出力してから exitCode = 1 で return し、maxBuffer と r.error・r.signal を出す
  - 種別: 修正
  - 計画: S1, S2
  - 依存: なし
  - 変更: `scripts/lib/test-run.mjs`, `scripts/lib/test-run.d.mts`, `scripts/check-sql-reach.mjs`, `server/test/test-run.test.ts`
  - red: `cd server && node --test test/test-run.test.ts` → 偽の bun が 200 KB の stdout と stderr を出して失敗すると、本物の check-sql-reach.mjs の出力の末尾が届かずに落ちる
  - 完了条件: `cd server && node --test test/test-run.test.ts` → pass（漏れなし、漏れあり、失敗と漏れ、出力の上限、後片付け、偽の bun での出力の末尾）
  - コミット: `fix(scripts): keep a failed test run's whole output and check its temp directory`
  - 結果: `cd server && node --test test/test-run.test.ts` → 直す前は sql:reach の 1 件が落ち（ 200 KB の出力の末尾 TAIL-OUT が届かない）、直した後 5 件 pass。npm の node-compile-cache はツールのキャッシュとして名前で除く（NODE_DISABLE_COMPILE_CACHE は環境を組み直した子に届かなかった）

- [x] T02: sql:live と hooks:live の失敗の経路を、出力してから exitCode = 1 で return する形にする
  - 種別: 修正
  - 計画: S1
  - 依存: なし
  - 変更: `scripts/check-sql-live.mjs`, `scripts/check-hooks-live.mjs`
  - red: `rg -n "process\.exit\(1\)" scripts/check-sql-live.mjs scripts/check-hooks-live.mjs` → 出力の直後の process.exit(1) がある
  - 完了条件: 同じ rg → 0 件、`bun run sql:live` と `bun run hooks:live` → 通る
  - コミット: `fix(scripts): let the live checks finish their output and cleanup before failing`
  - 結果: `rg -n "process\.exit\(1\)" scripts/check-sql-live.mjs scripts/check-hooks-live.mjs` → 直す前 2 件、直した後 0 件。`bun run sql:live` と `bun run hooks:live` → 通った

## P2: テストに残骸を作らせない

テストの実行が一時ディレクトリに何も残さない。

- [x] T03: 一時ディレクトリを残すテストを、作成の直後に削除を登録する形に直し、子の環境を組み直すテストに TMPDIR・TMP・TEMP を渡す
  - 種別: 修正
  - 計画: S3
  - 依存: T01（残骸の検査で、直したことを確かめる）
  - 変更: `server/test/temp-dir.ts`, `server/test/admin.test.ts`, `server/test/file-lock.test.ts`, `server/test/assets.test.ts`, `server/test/fake-gh.ts`, `server/test/fake-codex.ts`, `server/test/plugin.test.ts`, `server/test/db.test.ts`, `server/test/deliver.test.ts`, `server/test/review-bridge.test.ts`, `server/test/eval-grade.test.ts`, 環境を組み直す子があるテスト
  - red: `bun run sql:reach` → 実行用の TMPDIR に残骸が残り、名前つきで落ちる
  - 完了条件: `bun run sql:reach` → 残骸 0 で通る、`bun run verify` → 0
  - コミット: `fix(test): remove every temp directory a test makes`
  - 結果: `bun run sql:reach` → 直す前は残骸 99 個を名前つきで出して落ち、直した後は残骸 0 で通った（37 秒。持ち主の TMPDIR では 15 分を超えても終わらなかった）。作り手は admin・file-lock・assets・fake-gh・fake-codex・db・plugin と、deliver の印（deliver・review-bridge のテスト）、強制終了される grade.ts（eval-grade）。共有のヘルパーは server/test/temp-dir.ts の tempDir（プロセスの終了時に消す）と ownTmpdir、環境を組み直す子 33 か所に tmpEnv

- [x] T04: review-shipping の指摘 2 件を直す。テストが残したプロセスが書き続けて削除が失敗したら、例外にせず problems に出す。#299 の回帰テストを CI の macos ジョブでも流す（Linux のパイプは同期で書かれ、直す前の形でも落ちない）
  - 種別: 修正
  - 計画: S1, S2
  - 依存: T01（直すのは T01 で足した runTestsIsolated とその回帰テスト）
  - 変更: `scripts/lib/test-run.mjs`, `server/test/test-run.test.ts`, `.github/workflows/check.yml`
  - red: `cd server && node --test --test-name-pattern="left writing" test/test-run.test.ts` → 直す前の runTestsIsolated は ENOTEMPTY を投げて落ちる（review-shipping が書き続ける孫プロセスで 5 回中 5 回再現）
  - 完了条件: `cd server && node --test test/test-run.test.ts` → 6 件 pass、`actionlint .github/workflows/check.yml` → 0
  - コミット: `fix(scripts): report a temp directory a leftover process keeps busy, and run the output test on macOS CI`
  - 結果: `node --test --test-name-pattern="left writing" test/test-run.test.ts` → 8 回とも pass、TMPDIR に増えたもの 0。`actionlint` → 0。`bun run verify` → 0、前後で TMPDIR に増えたもの 0

- [x] T05: Codex のレビューの指摘 3 件を直す。live の 3 本の子の TMPDIR・TMP・TEMP を自分の一時ディレクトリの下に向ける（hooks:live の印が共有の TMPDIR に残り、名前の決まったディレクトリの中なので前後の比較に出なかった）。残骸を調べる読み取りの失敗も problems に出し、出力を捨てない。削除の失敗のテストを、削除を差し替えて確実に起こす形にする
  - 種別: 修正
  - 計画: S1, S2
  - 依存: T04（直すのは T04 で変えた削除の失敗の扱いとそのテスト）
  - 変更: `scripts/lib/test-run.mjs`, `scripts/lib/test-run.d.mts`, `server/test/test-run.test.ts`, `scripts/lib/live-harness.mjs`, `scripts/check-hooks-live.mjs`, `scripts/check-codex-trust-live.mjs`, `server/evals/acceptance/driver.ts`
  - red: `TMPDIR=<空のディレクトリ> node <直す前の check-hooks-live.mjs>` → そのディレクトリに sphica-5b0718b022fa が残る。直す前の runTestsIsolated に、自分の TMPDIR を読めなくする子を渡す → EACCES で例外になり出力が失われる
  - 完了条件: `cd server && node --test test/test-run.test.ts` → 6 件 pass。`TMPDIR=<空のディレクトリ> node scripts/check-hooks-live.mjs` → そのディレクトリが空のまま
  - コミット: `fix(scripts): keep the live checks' temp files in their own directory and report an unreadable run directory`
  - 結果: red は 2 つとも確認。`node --test test/test-run.test.ts` → 6 件 pass。hooks:live・sql:live・codex-trust:live を空の TMPDIR で流す → 何も残らない。hooks:live は Bash ツールの前景で流すと 3 回止まり（record tool hook が 30 秒と 930 秒、直す前の版でも Codex SubagentStart が ETIMEDOUT）、裏で流した 6 回はすべて 8 秒で通った。原因は未検証。verify の後に共有の TMPDIR の印が 6 個増えたので追い、acceptance の driver も同じ形に直した（空の TMPDIR で acceptance → 直す前は印 6 個、直した後は 0 個、132 件 pass）。ケースが止まっても次のケースが入れ子にならないよう、置き場は読み込み時の os.tmpdir() に固定

- [x] T06: CI と GitHub の Codex の指摘を直す。rename limit のテストの git で自動メンテナンスを止める（1001 個の commit の後に裏で repack が動き、リポジトリに書き続ける）。読めない TMPDIR のテストを、権限ではなくファイルへの置き換えで起こす（root では権限 000 でも読める）
  - 種別: 修正
  - 計画: S2, S3
  - 依存: T05（直すのは T05 で変えたテストと、T03 の残骸の検査が CI で見つけたもの）
  - 変更: `server/test/record.test.ts`, `server/test/test-run.test.ts`
  - red: `gh run view 37687086693 --log-failed` → check (26) で `the tests left 1 entry in their temp directory: sphica-limit-88uZVS`。同じジョブを流し直すと通り、手元でも 8 回中 0 回で再現しなかった。`GIT_TRACE=1 git commit`（1001 個）→ `git maintenance run --auto --quiet --detach` が起動し、約 1 秒 pack-objects と multi-pack-index を書く
  - 完了条件: `GIT_TRACE=1 git -c maintenance.auto=false commit` → maintenance を起動しない。`cd server && node --test test/test-run.test.ts` → 6 件 pass
  - コミット: `fix(test): stop git's background repack in the rename limit test and fail the scan without permissions`
  - 結果: maintenance の起動 0 件。test-run.test.ts 6 件 pass。CI の残骸の原因が裏の repack だというのは推測（Linux では確かめていない）

## 記録
