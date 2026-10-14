---
kind: tasks
plan: 14-revision-recheck.plan.md
branch: fix/revision-recheck-342
base: main
---

# ingest と forget の接続は、開いた後に DB の revision が変わっていたら書き込みを拒否する（#342）のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 書き込みをトランザクションに寄せる

ingest と forget の接続の書き込みが、全部 `begin immediate` で始まるトランザクションの中で起きるようになる（挙動は変わらない）。

- [x] T01: トランザクションの外の書き込みを `inTransaction` に入れ、バージョンを上げる
  - 種別: 変更
  - 計画: S3, S5
  - 依存: なし
  - 変更: `server/src/trace.ts`, `server/src/extract.ts`, `server/src/cli.ts`, `server/src/forget.ts`, `plugin/package.json`, `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`
  - 完了条件: `bun run release:plan -- --base 94196c67` → plugin。`bun run test` → 全件通る
  - コミット: `refactor(record): write the call log, runs, registration, and forget cleanup in transactions`
  - 結果: `bun run test` → tests 1292 / pass 1292 / fail 0。`release:plan` は作業ツリーでは none（コミット間の比較のため）、コミット後に確かめる

## P2: revision の検査

開いた後に revision が変わった ingest / forget の接続が書き込みを拒否する。

- [x] T02: ingest と forget の接続に、検査付きの begin と、検査済みでない書き込みを拒否する authorizer を入れる
  - 種別: 修正
  - 計画: S1, S2
  - 依存: T01（トランザクションの外の書き込みが残っていると、authorizer の強制でそれらが拒否されてテストが落ちる）
  - 変更: `server/src/sqlite.ts`, `server/src/db-write.ts`, `server/test/db.test.ts`, `server/test/github.test.ts`, `server/test/reconcile.test.ts`, `server/test/record.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern=revision test/db.test.ts` → ingest と forget の「開いた後の移行」のテストが、書き込みが通ってしまい失敗する
  - 完了条件: 同じコマンド → 通る。`bun run test` → 全件通る
  - コミット: `fix(db): refuse an ingest or forget write when the revision changed after the connection opened`
  - 結果: red は修正前に 2 件とも失敗（`Missing expected rejection` / `Missing expected exception`）。修正後、同じコマンドで 2 件とも通る。`bun run test` → tests 1294 / pass 1294 / fail 0

- [x] T03: 移行窓・持ち越し・自動 rollback・FTS の正常系・既存の禁止・forget の preview / apply のテストを足す
  - 種別: 追加
  - 計画: S4
  - 依存: T02（検査付き begin と authorizer の `checked` が無いと、拒否を確かめるテストが書けない）
  - 変更: `server/test/db.test.ts`, `server/test/forget.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern=revision test/db.test.ts test/forget.test.ts` → plan の A2〜A9 に当たるテストが全部通る
  - コミット: `test(db): cover the revision check's lock, carry-over, rollback, FTS, and forget paths`
  - 結果: `--test-name-pattern=revision test/db.test.ts test/forget.test.ts` → tests 14 / pass 14。authorizer の拒否の 1 行を外すと、外の書き込みと forget の optimize の 2 件が落ちることを確かめて戻した。既存の禁止は `attempt` が検査済みトランザクションの中で流すので、checked が true のまま確かめている。shadow table の直接の書き込みの検査に forget を足した。`bun run test` → tests 1303 / pass 1303 / fail 0

- [x] T04: 受け入れテストのドライバーが前提のデータ（work）をトランザクションの中で書くようにし、足したテストの lint を直す
  - 種別: 修正
  - 計画: S4
  - 依存: T02（検査済みでない書き込みの拒否が入って、ドライバーの autocommit の書き込みが拒否された）
  - 変更: `server/evals/acceptance/driver.ts`, `server/test/db.test.ts`
  - red: `bun run acceptance` → injection-04、status-08、status-09 が `not authorized` で失敗する
  - 完了条件: `bun run acceptance` → 全件通る。`server/node_modules/.bin/biome ci . --error-on-warnings` → 0 で終わる
  - コミット: `test(acceptance): write the work fixture in a transaction`
  - 結果: red は verify の中で 3 件失敗（`not authorized`、`driver.ts:861`）。直した後、`bun run acceptance` → tests 142 / pass 142 / fail 0。biome ci → 0

- [x] T05: 評価用のフィクスチャのスクリプトが、プロジェクトの登録をトランザクションの中で書くようにする
  - 種別: 修正
  - 計画: S3
  - 依存: T02（検査済みでない書き込みの拒否が入って、スクリプトの autocommit の書き込みが拒否された）
  - 変更: `server/evals/cloud/fixture.ts`
  - red: `HOME=<一時> SPHICA_HOME=<一時> node evals/cloud/fixture.ts new <一時>/f.db o/r` → `Error: not authorized`
  - 完了条件: `node evals/cloud/fixture.ts new <一時ディレクトリ>/f.db o/r` → 0 で終わり、`project` に `git:github.com/o/r` の行が 1 つある
  - コミット: `fix(evals): register the fixture project in a transaction`
  - 結果: 直す前の `HOME=<一時> SPHICA_HOME=<一時> node evals/cloud/fixture.ts new <一時>/f.db o/r` → `Error: not authorized`。直した後、同じコマンド → exit 0、`project` の行は `git:github.com/o/r` の 1 件

- [x] T06: テストの `attempt` が、書き込みの接続で begin に失敗したら黙って進まずに投げるようにする
  - 種別: 修正
  - 計画: S4
  - 依存: T02（`attempt` を検査付きの begin の中で流す形にしたのは T02）
  - 変更: `server/test/db.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/db.test.ts` → 失敗しない（begin の失敗を握りつぶすので、拒否を期待するテストが表の規則によらず通りうる。コードを読んで確かめた欠陥で、落ちる入力は作っていない）
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/db.test.ts` → 全件通る
  - コミット: `test(db): throw when a writing connection cannot begin in attempt`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/db.test.ts` → tests 38 / pass 38 / fail 0

- [x] T07: CI の windows の手順が数えるテスト名に、足したテストが当たらないようにする
  - 種別: 修正
  - 計画: S4
  - 依存: T03（名前を変えるテストは T03 で足した）
  - 変更: `server/test/db.test.ts`
  - red: `cd server && node --test --test-reporter=tap --test-name-pattern="rolled-back|record_check waits" test/db.test.ts test/reconcile.test.ts` → `# pass 5`（CI の check.yml は `# pass 4` を求めて落ちた）
  - 完了条件: `cd server && node --test --test-reporter=tap --test-name-pattern="rolled-back|record_check waits" test/db.test.ts test/reconcile.test.ts` → `# pass 4`
  - コミット: `test(db): keep the record_check revision test out of the windows rollback count`
  - 結果: red は PR #343 の CI の windows で `# pass 5`（exit 1）。直した後、同じコマンド → `# pass 4`。`--test-name-pattern=revision test/db.test.ts` → pass 12 / fail 0

## 記録

- 2026-10-14 / T01 / Codex のタスクごとのレビュー（9b79166c）は指摘 0 件 / 対応なし
- 2026-10-14 / T02 / 内部の関数（`storeItems`、`linkIssues`、`openRun`、`finishRun`）をトランザクションの外から直接呼ぶテストと、生の ingest / forget 接続で autocommit の書き込みをするテストが拒否された。本番の呼び出しは全部トランザクションの中 / テストを `inTransaction`・`begin immediate` の中で呼ぶ形に直し、変更欄に `server/test/github.test.ts`, `server/test/reconcile.test.ts`, `server/test/record.test.ts` を足した（前の値: `server/src/sqlite.ts`, `server/src/db-write.ts`, `server/test/db.test.ts`）
- 2026-10-14 / T02 / テストの `statements()` は prototype の `prepare` を差し替えるので、接続を開いたときに bind したラッパーでは文が数えられなかった / ラッパーは呼ぶたびに prototype の `prepare` を引く
- 2026-10-14 / T02 / Codex のタスクごとのレビュー（f24d89b4）は指摘 0 件 / 対応なし
- 2026-10-14 / T03 / verify の lint（Biome）が、足したテストのカンマ演算子で止まった / ブロックに書き直した
- 2026-10-14 / T04 / verify の acceptance で、ドライバーが前提のデータの work を ingest 接続に autocommit で書いて拒否された / 修正タスク T04 を足して直した
- 2026-10-14 / T05 / verify が流さない評価用のスクリプトを探し、`evals/cloud/fixture.ts` の `new` が ingest 接続に autocommit で書いていた（`evals/cloud/build.ts` は読むだけ）/ 修正タスク T05 を足して直した
- 2026-10-14 / T05 / 完了条件の欄がコマンドの形でないまま検査が落ちたのに、検査の出力をパイプに通したためコミットが通った / 完了条件・red・結果の欄をコマンドの形に直した（前の値: 「同じコマンド → 0 で終わり、…」ほか）
- 2026-10-14 / T06 / review-shipping の全差分のレビュー: 出荷して壊れるものは無し、指摘 1 件（`attempt` が begin の失敗を握りつぶし、拒否のテストが空振りしうる）/ 採用して T06 で直した。reader は begin が `not authorized` になるので、reader だけ begin しない
- 2026-10-14 / 全体 / Codex の全差分のレビュー（b1b83f98）は指摘 0 件、T06 の再レビュー（8b09c13f）も指摘 0 件 / 対応なし
- 2026-10-14 / T07 / PR #343 の CI で windows が落ちた。テストは全部通っていて、`check.yml` が名前に rolled-back を含むテストをちょうど 4 件と数える手順に、足したテストが当たった（新規の失敗）/ テストの名前を変えた
