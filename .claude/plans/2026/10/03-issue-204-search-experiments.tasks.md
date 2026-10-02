---
kind: tasks
plan: 03-issue-204-search-experiments.plan.md
branch: exp/issue-204-search-experiments
base: main
---

# #204 の残りの実験を、先に固定したベンチマークの基準で採否を決め、採用したものだけを出す のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: ベンチマークを固定する

実験の前に、並べ替えと識別子と日本語の分割の差が数字に出るコーパスと loader を作り、Codex のレビューで固定する。

- [ ] T01: loader に anchors・created_at・set を足し、set ごとに集計する
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `server/evals/retrieval/bench.ts`, `server/evals/retrieval/run.ts`, `server/test/retrieval-bench.test.ts`
  - 完了条件: `cd server && node --test test/retrieval-bench.test.ts` → pass。anchors と created_at を持つ記録が書いたとおりに保存されたことを確かめるテストと、違えば止まるテストを含む。`node evals/retrieval/run.ts` → 既存の 60 問の数値が main と同じで、`base` の行が出る
  - コミット: `test(bench): save anchors and fixed times in the retrieval benchmark and report by question set (T01)`

- [ ] T02: コーパスに ident・tie・ja-split の質問と記録を足して固定する
  - 種別: 追加
  - 計画: S1
  - 依存: T01（set・anchors・created_at を読む loader が要る）
  - 変更: `server/evals/retrieval/corpus.json`, `server/test/retrieval-bench.test.ts`
  - 完了条件: `cd server && node evals/retrieval/run.ts` → `ident` / `tie` / `ja-split` の行が出て、それぞれに gold ありと gold なしの質問がある。`base` の 60 問の数値は main と同じ。Codex のレビューで指摘を直し、残りが 0 件
  - コミット: `test(bench): add identifier, near-tie, and Japanese splitting questions to the retrieval corpus (T02)`

## P2: 実験を測って採否を決める

測るだけの E1 のあと、E2・E3a・E3b を 1 つずつ入れて直前の採用済みのコミットと比べ、基準に届かないものは revert する。

- [ ] T03: E1 日本語の取りこぼしを分類する `--misses` を足す
  - 種別: 追加
  - 計画: S2
  - 依存: T02（分類の対象の ja-split の質問が要る）
  - 変更: `server/evals/retrieval/run.ts`, `server/evals/retrieval/bench.ts`, `server/test/retrieval-bench.test.ts`
  - 完了条件: `cd server && node evals/retrieval/run.ts --misses` → ja>ja と ja>en の外れた質問ごとに、一致した語・足りない語・原因が出て、「分割だけを直せば過半数に届く質問」の数が出る。数値と bigram を別の計画にするかの判断を #204 のコメントの下書きにする（投稿は持ち主の承認の後）
  - コミット: `test(bench): classify missed Japanese questions by the cause of each missing term (T03)`

- [ ] T04: E2 `terms()` で camelCase と snake_case の部分も語にして測る
  - 種別: 変更
  - 計画: S3
  - 依存: T02（判定に使う ident の質問が要る）
  - 変更: `server/src/text.ts`, `server/src/terms-golden.json`, `server/test/text.test.ts`
  - 完了条件: `cd server && node --test test/text.test.ts test/terms-golden.test.ts` → pass。`node evals/retrieval/run.ts --compare <直前の採用済みのコミット>` の結果を結果行に残し、plan の基準で採否を決める。不採用なら、このタスクのチェックは実装を戻す revert のコミットで付ける
  - コミット: `feat(search): split camelCase and snake_case identifiers into search terms (T04)`

- [ ] T05: E2 を採用した場合、schema revision 9 で索引を作り直す
  - 種別: 追加
  - 計画: S3
  - 依存: T04（新しい terms() の規則が要る）
  - 変更: `db/schema.sql`, `db/migrations/0009.sql`, `server/src/sqlite.ts`, `server/test/migrate.test.ts`
  - 完了条件: `cd server && node --test test/migrate.test.ts` → revision 8 の fixture を 9 に移行した DB と新しく作った DB で、同じ質問の検索結果が一致する。T04 が不採用なら `[-]` にする
  - コミット: `feat(db): rebuild the search indexes for split identifiers in schema revision 9 (T05)`

- [ ] T06: E3a 帯の中だけ decision と constraint を前にして測る
  - 種別: 変更
  - 計画: S4
  - 依存: T02（判定に使う tie の質問が要る）
  - 変更: `server/src/search.ts`, `server/test/search.test.ts`
  - 完了条件: `cd server && node --test test/search.test.ts` → pass。3 件以上の行で入力の順をすべて並べ替えても同じ順になるテストを含む。`node evals/retrieval/run.ts --compare <直前の採用済みのコミット>` の結果を結果行に残し、plan の基準で採否を決める。不採用なら、このタスクのチェックは実装を戻す revert のコミットで付ける
  - コミット: `feat(search): order decisions and constraints first within a bm25 band (T06)`

- [ ] T07: E3b 帯の中だけ新しい記録を前にして測る
  - 種別: 変更
  - 計画: S5
  - 依存: T06（帯の作り方と、E3a の採否で決まる比べる相手が要る）
  - 変更: `server/src/search.ts`, `server/test/search.test.ts`
  - 完了条件: `cd server && node --test test/search.test.ts` → pass。入力の順によらない順のテストを含む。`node evals/retrieval/run.ts --compare <直前の採用済みのコミット>` の結果を結果行に残し、plan の基準で採否を決める。不採用なら、このタスクのチェックは実装を戻す revert のコミットで付ける
  - コミット: `feat(search): order newer records first within a bm25 band (T07)`

## P3: 結果を残して出す

全実験の結果と E4・E5 の不採用を #204 に残し、採用があればバージョンをそろえる。

- [ ] T08: 採用があればバージョンを 0.6.23 にそろえ、#204 への記録の下書きを作る
  - 種別: 変更
  - 計画: S6
  - 依存: T03（E1 の数値が要る）, T05（E2 の採否が要る）, T07（E3a / E3b の採否が要る）
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run release:plan -- --base v0.6.22` → `plugin` で、4 つのファイルが 0.6.23。E1〜E5 の結果（E4・E5 は不採用の理由と見直す条件）の #204 へのコメントの下書きがある（投稿は持ち主の承認の後）。採用が 1 つも無ければ `[-]` にし、下書きは記録節に書く
  - コミット: `chore(release): ship the adopted search experiments as 0.6.23 (T08)`

## 記録
