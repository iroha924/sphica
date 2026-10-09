---
kind: tasks
plan: 09-e4-post-write.plan.md
branch: feat/e4-post-write
base: main
---

# 書いた本文が名指しした記録を書いた直後に配る実験（#213）と、shell で変わったファイルの取りこぼしの測定（#219）（E4）のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 入口の検査（モデルを回さない）

過去の書き込みと shell の変更に今の記録を当てて、post_write を作る価値があるかと、#219 の取りこぼしを数字で決める。

- [ ] T01: onPrompt の照合を関数に切り出す（挙動は変えない）
  - 種別: 変更
  - 計画: S3
  - 依存: なし
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/deliver.test.ts test/deliver-codex.test.ts` → 既存のプロンプトの照合のテストが全部 pass し、切り出した関数を任意の本文に当てるテストが pass
  - コミット: `refactor(deliver): match records named in any text with the prompt's rules`
- [ ] T02: M0 の再生スクリプト（Claude Code の会話記録と Codex のセッションの書き込みに、今の記録を当てる）
  - 種別: 追加
  - 計画: S1
  - 依存: T01（post_write と同じ照合を使う）
  - 変更: `server/evals/post-write/replay.ts`, `server/test/post-write-replay.test.ts`, `knip.json`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/post-write-replay.test.ts` → 合成の会話記録（Edit・Write・NotebookEdit・apply_patch、読めない行、compact）で、書き込みの前に emitted になった記録だけが除かれ、組が host・文書／コード・symbol／path／option 別に数えられ、読めなかった件数が出る
  - コミット: `feat(eval): replay past writes against current records for the post_write entry check`
- [ ] T03: M0 を持ち主のデータで流し、持ち主のラベルで作るかどうかを決める
  - 種別: 追加
  - 計画: S1
  - 依存: T02（再生スクリプトが要る）
  - 変更: `server/evals/post-write/m0.json`
  - 完了条件: `cat server/evals/post-write/m0.json` → seed、標本（session・tool_use_id・記録の key・ラベルだけで本文を含まない）、集計、基準の判定（作る / 作らない）が入っている。会話ごとの予算の値を plan の変更履歴に書いた
  - コミット: `test(eval): record the post_write entry check and the owner's labels`
- [ ] T04: M0' の抽出スクリプト（原因の内訳の 30 ターンと、組の母集団の無作為な並び）
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `server/evals/post-write/shell-miss.ts`, `server/test/post-write-shell-miss.test.ts`, `knip.json`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/post-write-shell-miss.test.ts` → 一時 DB で、via=status だけの anchor 付きの組が列挙され、同じ seed で同じ並び・同じ 30 ターンになり、次の持ち主のプロンプトまでの emitted の判定と Wilson 区間の判定（進む / 不採用 / 決まらない）が期待どおり
  - コミット: `feat(eval): sample shell-changed files to measure undelivered records`
- [ ] T05: M0' を流して Claude と Codex でラベルを付け、#219 を判定する
  - 種別: 追加
  - 計画: S1, S6
  - 依存: T04（抽出スクリプトが要る）
  - 変更: `server/evals/post-write/m0-shell.json`
  - 完了条件: `cat server/evals/post-write/m0-shell.json` → seed、原因の内訳、引いた組と確かめられた組の数、取りこぼしの区間、Claude と Codex の食い違いの決着、判定が入っている。#219 へのコメントの文面を持ち主に見せた
  - コミット: `test(eval): record the shell-change miss rate for #219`

## P2: 今のバンドルでの基準

今の配信では記録が届かない評価タスクと、post_write の hook を流せる runner を用意し、作る前に基準値と揺れを測る。

- [ ] T06: M1 の評価タスクと fixture（今の配信経路で届かない記録、docs/ に書く違反のタスク 3 つ、should_not_block と should_stay_quiet、隠しテスト）
  - 種別: 追加
  - 計画: S2
  - 依存: T03（M0 で作らないと決まれば M1 も要らない）
  - 変更: `server/evals/cloud/tasks.json`, `server/evals/acceptance/world.json`, `server/test/eval-fixture.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/eval-fixture.test.ts` → 新しいタスクの記録が、プロンプトの照合・pre_edit・pre_read・session_start のどれでも配られない（deliver() を直接呼んで確かめる）
  - コミット: `test(eval): add tasks whose records no current delivery path reaches`
- [ ] T07: runner の PostToolUse 配信の対応、配信の結果の reason・時刻・tool_use_id、書き込みの本文の記録
  - 種別: 追加
  - 計画: S2
  - 依存: なし
  - 変更: `server/evals/cloud/build-lib.ts`, `server/evals/cloud/build.ts`, `server/evals/cloud/claude-run.ts`, `server/evals/cloud/codex-run.ts`, `server/evals/cloud/collect.ts`, `server/test/eval-build.test.ts`, `server/test/eval-claude.test.ts`, `server/test/eval-codex.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/eval-build.test.ts test/eval-claude.test.ts test/eval-codex.test.ts` → hooks.json / codex.json に PostToolUse の配信の entry があるときだけ inject に PostToolUse の hook が入り、matcher が manifest に残る。無いとき（main のバンドル）の設定は今と同じ
  - コミット: `feat(eval): wire the shipped post-tool delivery hook into inject runs`
- [ ] T08: 流す前の確認（docs/ の既知の違反が両ホストで違反と採点される、compare が既知の結果で期待どおり）
  - 種別: 追加
  - 計画: S2
  - 依存: T06（タスクが要る）, T07（runner が要る）
  - 変更: `server/test/eval-grade.test.ts`, `server/evals/cloud/report.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/eval-grade.test.ts` → 良くなる・悪くなる・同じの既知の grades で compare がそのとおりに出る。両ホストの docs/ の違反の文書が patch に入り implements_rejected=yes と採点される（1 run ずつの実走の結果を結果行に残す）
  - コミット: `test(eval): check grading of plan documents and the compare on known results`
- [ ] T09: main のバンドルで baseline と A/A（モデル別 k=5 × 2）を流し、測れるモデルと M1 の k・改善幅を決める
  - 種別: 追加
  - 計画: S2
  - 依存: T08（流す前の確認が要る）
  - 変更: `server/evals/post-write/m1.json`
  - 完了条件: `cat server/evals/post-write/m1.json` → バンドルの hash、モデル別の違反の run 数（2 組）、測れるかの判定、決めた k と改善幅が入っている。両モデルとも測れなければ打ち切りを plan の変更履歴に書いた
  - コミット: `test(eval): record the post_write baseline and fix the main run`

## P3: post_write の実装

M0 と M1a を通ったときだけ、書いた直後の配信を両ホストに入れる。

- [ ] T10: deliver.ts の post_write（本文の取り出し、照合、emitted の除外、予算と上限、lockedPlan、文面、`pre_edit`＋`reason='post_write'` での記録）
  - 種別: 追加
  - 計画: S3
  - 依存: T01（照合の関数が要る）, T09（M1a で打ち切りなら作らない）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`, `server/test/deliver-codex.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/deliver.test.ts test/deliver-codex.test.ts` → 候補 6 件以上、先頭だけ配信済み、ログの失敗、compact の後、別の agent、NotebookEdit の delete、複数ファイルの patch、old_string だけに出る名前で、配る記録と記録した行が期待どおり
  - コミット: `feat(deliver): deliver records that a write names, right after the write`
- [ ] T11: 両ホストの hook の登録と、scale の計測への post_write の追加
  - 種別: 追加
  - 計画: S3
  - 依存: T10（配信の処理が要る）
  - 変更: `plugin/hooks/hooks.json`, `plugin/hooks/codex.json`, `server/test/plugin.test.ts`, `server/evals/scale/run.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/plugin.test.ts` → Claude Code の同期の PostToolUse（`Edit|Write|MultiEdit|NotebookEdit`）と Codex の `^apply_patch$` の配信の entry があり、Windows の形も既存と同じ。`node evals/scale/run.ts` → post_write の行が出る
  - コミット: `feat(plugin): register the post-write delivery hook on both hosts`

## P4: 本測定と採否

- [ ] T12: M1 の本測定（main と作業ブランチのバンドルの比較）と #213 の採否
  - 種別: 追加
  - 計画: S4
  - 依存: T11（作業ブランチのバンドルが要る）
  - 変更: `server/evals/post-write/m1.json`
  - 完了条件: `cat server/evals/post-write/m1.json` → モデル別の最終の違反・完了・不要な停止・誤配の old と new、途中の違反（報告だけ）、採否が入っている。#213 へのコメントの文面を持ち主に見せた
  - コミット: `test(eval): record the post_write measurement and the decision on #213`

## P5: 出荷か撤去

- [ ] T13: 採用したとき: revision 13（delivery.event に post_write、移行、旧 revision の fixture、型の生成）と、記録する event の切り替え
  - 種別: 変更
  - 計画: S5
  - 依存: T12（採用のときだけ）
  - 変更: `db/schema.sql`, `db/migrations`, `server/src/sqlite.ts`, `server/src/db-types.ts`, `server/src/deliver.ts`, `server/test/migrate.test.ts`, `server/test/schema.test.ts`, `server/test/deliver.test.ts`
  - 完了条件: `bun run verify` → 0 で終わる。`cd server && node --import ./test/isolate-home.ts --test test/migrate.test.ts` → revision 12 の DB の `reason='post_write'` の行が `event='post_write'` に移り、delivery と delivery_unit と採番が保たれる
  - コミット: `feat(schema): log post-write deliveries as their own event (revision 13)`
- [ ] T14: 採用したとき: バージョンの同期と出荷の準備
  - 種別: 変更
  - 計画: S5
  - 依存: T13（出荷する schema が要る）
  - 変更: `plugin/package.json`, `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`
  - 完了条件: `bun run release:plan -- --base <前の release のコミット>` → `plugin`、npm と 3 つの plugin manifest が同じバージョン
  - コミット: `chore(release): bump to <version>`
- [ ] T15: 採用しないとき: post_write の実装と hook を外す（照合の切り出しと評価の仕組み・結果は残す）
  - 種別: 削除
  - 計画: S5
  - 依存: T12（不採用のときだけ）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`, `server/test/deliver-codex.test.ts`, `plugin/hooks/hooks.json`, `plugin/hooks/codex.json`, `server/test/plugin.test.ts`, `server/evals/scale/run.ts`
  - 完了条件: `git diff main -- plugin/hooks db/schema.sql` → 空。`bun run verify` → 0 で終わる
  - コミット: `revert(deliver): drop post_write after the measurement`

## 記録
