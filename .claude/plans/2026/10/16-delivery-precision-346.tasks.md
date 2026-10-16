---
kind: tasks
plan: 16-delivery-precision-346.plan.md
branch: feat/delivery-precision-346
base: main
---

# #346 の手順 1: 自動配信の当たる率を抜き取りで測り、終わった計画を外す計画に進むかを決める のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 抜き取りのスクリプト

母集団を保存して同じ 80 組を出し直せ、ラベル用のシートが出て、ラベルから判定が出るスクリプトができる。

- [x] T01: 母集団を抽出して保存し、保存したものと照合する（`--db`）
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `server/evals/delivery/sample.ts`, `server/test/delivery-sample.test.ts`, `knip.json`
  - 完了条件: `node --test server/test/delivery-sample.test.ts` → 一時 DB から窓・project・outcome で絞った (delivery.id, unit_id) の一覧と sha256 が保存され、行を消した DB で抽出し直すと違いを報告して 0 以外で終わる
  - コミット: `feat(eval): extract and pin the delivery population for the #346 sample (T01)`
  - 結果: `node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts`（server/）→ 4 件 pass（窓・project・outcome の絞り込みと並び、照合の 4 種の違い、子プロセスで 2 回目は同じと報告・行を消した DB では 0 以外で終わり保存ファイルは変わらない、足りない引数の名指し）。`bun run check` → 0

- [x] T06: 窓の時刻を正規化し、プロジェクトを一意な key で選ぶ
  - 種別: 修正
  - 計画: S1
  - 依存: T01（直す対象の抽出と保存）
  - 変更: `server/evals/delivery/sample.ts`, `server/test/delivery-sample.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts` → ミリ秒なしの from で境界の行が抜ける、同じ名前の 2 プロジェクトで片方を黙って選ぶ、の 2 件が落ちる
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts` → 全件 pass。ミリ秒の有無で同じ組が出て、日時でない値は名指しで止まり、`--project` は key で選ぶ
  - コミット: `fix(eval): normalize the window and pick the project by key (T06)`
  - 結果: red: `cd server && node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts` に直す前のコードで流した → ミリ秒なしの from で境界の行が 0 件（expected 1）、key を渡すと `no project named git:gitlab.com/o/r` で落ちた。直した後 `cd server && node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts` → 9 件 pass（ミリ秒なしでも 4 組・窓は正規化して保存、`yesterday` は名指しで止まる、gitlab の key でそちらの組だけ）。T02 と同じコミット

- [x] T02: 保存した母集団から seed で 80 組を抜き取り、ラベル用のシートを出す（`--sample`）
  - 種別: 追加
  - 計画: S1
  - 依存: T01（保存した母集団の形が要る）
  - 変更: `server/evals/delivery/sample.ts`, `server/test/delivery-sample.test.ts`
  - 完了条件: `node --test server/test/delivery-sample.test.ts` → 同じ母集団と seed で 2 回流すと同じ組が同じ順に出る。一時の Claude Code と Codex の会話の記録から依頼と動きがシートに入り、記録の無い組は「記録なし」で残る
  - コミット: `feat(eval): sample delivered records and write labelling sheets (T02)`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts` → 9 件 pass（同じ seed で同じ 80 組・同じ順、2 回の `--sample` の出力が一致、sha256 を書き換えた母集団で止まる、Claude Code の main とサブエージェント・Codex の会話から依頼と動きがシートに入り、記録の無い組は no transcript found）

- [ ] T03: ラベルから判定を出す（`--decide`）
  - 種別: 追加
  - 計画: S1
  - 依存: T01（sample.ts の引数の受け方が要る）
  - 変更: `server/evals/delivery/sample.ts`, `server/test/delivery-sample.test.ts`
  - 完了条件: `node --test server/test/delivery-sample.test.ts` → (8,7,1,0) は進む、(10,8,2,0) と (8,0,8,0) は undecided、F < 8 は判定できない、R >= 2 は進まない
  - コミット: `feat(eval): decide the finished-plan gate from settled labels (T03)`

## P2: 測定と報告

持ち主の DB の直近 7 日から 80 組を抜き取ってラベルを付け、判定と防げた例を #346 に出す。

- [ ] T04: 持ち主の DB から母集団を保存し、80 組を抜き取ってシートを作る
  - 種別: 追加
  - 計画: S2
  - 依存: T02（抜き取りとシートが要る）
  - 変更: `server/evals/delivery/population-2026-10-16.json`
  - 完了条件: `node server/evals/delivery/sample.ts --sample --population server/evals/delivery/population-2026-10-16.json --seed 20261016 --size 80 --out <scratchpad>/drawn.json` → 2 回流して同じ 80 組が同じ順に出る。`--sheet` でシートを scratchpad に書き、コミットしない
  - コミット: `test(eval): pin the 2026-10-09..16 delivery population (T04)`

- [ ] T05: 2 者のラベルと原因の分類を付けて判定し、結果を #346 に書く
  - 種別: 追加
  - 計画: S2, S3
  - 依存: T03（判定が要る）, T04（抜き取った 80 組が要る）
  - 変更: `server/evals/delivery/precision-baseline.json`
  - 完了条件: `jq '[.sample[] | select(.claude and .codex and .settled and .class and .class_reason)] | length' server/evals/delivery/precision-baseline.json` → 80。#346 のコメント（文面は持ち主の承認の後）の URL が JSON の note にある
  - コミット: `test(eval): record the #346 delivery precision baseline and its gate (T05)`

## 記録

- 2026-10-16 / T04 / 完了条件のコマンドに `--out` が無かった（`--sample` は書き出し先が要る）。前: `--size 80` まで、新: `--out <scratchpad>/drawn.json` を足し、シートは `--sheet` で書く / 欄を直した
- 2026-10-16 / T06 / T01 の Codex のレビューで P2 が 2 件（窓の時刻を文字列のまま比べる、一意でない名前でプロジェクトを選ぶ）。どちらも再現できる指摘として採る / 修正タスク T06 を T02 の前に足した
