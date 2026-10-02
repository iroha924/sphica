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

- [x] T01: loader に anchors・created_at・set を足し、set ごとに集計する
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `server/evals/retrieval/bench.ts`, `server/evals/retrieval/run.ts`, `server/test/retrieval-bench.test.ts`
  - 完了条件: `cd server && node --test test/retrieval-bench.test.ts` → pass。anchors と created_at を持つ記録が書いたとおりに保存されたことを確かめるテストと、違えば止まるテストを含む。`node evals/retrieval/run.ts` → 既存の 60 問の数値が main と同じで、`base` の行が出る
  - コミット: `test(bench): save anchors and fixed times in the retrieval benchmark and report by set (T01)`
  - 結果: `node --test test/retrieval-bench.test.ts` → 5 pass（anchors・created_at・implementation の code 根拠が保存されて active になる、時計が戻る、set ごとに集計される、保存できない anchor で止まる）。`node evals/retrieval/run.ts` → all R@1 47.9% / MRR 0.479、言語の組ごとの値も main と同じで、`set base` の行が出る。`tsc --noEmit` → エラーなし

- [x] T02: コーパスに ident・tie・ja-split の質問と記録を足して固定する
  - 種別: 追加
  - 計画: S1
  - 依存: T01（set・anchors・created_at を読む loader が要る）
  - 変更: `server/evals/retrieval/corpus.json`, `server/test/retrieval-bench.test.ts`
  - 完了条件: `cd server && node evals/retrieval/run.ts` → `ident` / `tie` / `ja-split` の行が出て、それぞれに gold ありと gold なしの質問がある。`base` の 60 問の数値は main と同じ。Codex のレビューで指摘を直し、残りが 0 件
  - コミット: `test(bench): add identifier, near-tie, and Japanese split questions to the corpus (T02)`
  - 結果: 記録 82 件、質問 113 問（gold あり 93、なし 20）。`node --test test/retrieval-bench.test.ts` → 5 pass。`node evals/retrieval/run.ts` → all MRR 0.473、set ident 0.083 / tie 0.804 / ja-split 0.200 / base 0.469。Codex のレビュー 2 回: 1 回目 F1〜F7 を全部受けて直し、2 回目で F2〜F7 は解消、F1 は E3a で上がる例が無い点だけが残った（記録節）

## P2: 実験を測って採否を決める

測るだけの E1 のあと、E2・E3a・E3b を 1 つずつ入れて直前の採用済みのコミットと比べ、基準に届かないものは revert する。

- [x] T03: E1 日本語の取りこぼしを分類する `--misses` を足す
  - 種別: 追加
  - 計画: S2
  - 依存: T02（分類の対象の ja-split の質問が要る）
  - 変更: `server/evals/retrieval/run.ts`, `server/evals/retrieval/bench.ts`, `server/test/retrieval-bench.test.ts`
  - 完了条件: `cd server && node evals/retrieval/run.ts --misses` → ja>ja と ja>en の外れた質問ごとに、一致した語・足りない語・原因が出て、「分割だけを直せば過半数に届く質問」の数が出る。数値と bigram を別の計画にするかの判断を #204 のコメントの下書きにする（投稿は持ち主の承認の後）
  - コミット: `test(bench): classify missed Japanese questions by the cause of each missing term (T03)`
  - 結果: `node --test test/retrieval-bench.test.ts` → 6 pass。`node evals/retrieval/run.ts --misses` → ja>ja と ja>en の外れ 29 問: split 3、identifier 2、vocabulary 17、mixed 7、ranked 0。分割だけを直せば過半数に届くのは 6 問（20.7%）で、基準（20% 以上かつ 3 問以上）をぎりぎり満たす。ただし 6 問のうち 5 問は ja-split の set（分割の違いを含むように書いた質問）で、base の 60 問からは jj07（データ と データベース）の 1 問だけ。#204 への下書き: bigram 索引は別の計画の候補として書き、この内訳を添える（T08 でまとめる）

- [x] T04: E2 `terms()` で camelCase と snake_case の部分も語にして測る
  - 種別: 変更
  - 計画: S3, S6
  - 依存: T02（判定に使う ident の質問が要る）
  - 変更: `server/src/text.ts`, `server/src/terms-golden.json`, `server/test/text.test.ts`, `server/test/retrieval-bench.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `cd server && node --test test/text.test.ts test/terms-golden.test.ts` → pass。`node evals/retrieval/run.ts --compare <直前の採用済みのコミット>` の結果を結果行に残し、plan の基準で採否を決める。不採用なら、このタスクのチェックは実装を戻す revert のコミットで付ける
  - コミット: `feat(search): split camelCase and snake_case identifiers into search terms (T04)`
  - 結果: 採用。（T03 のテストに残った日本語のコメントを英語に直した）`node evals/retrieval/run.ts --compare 424606b4` → all MRR 0.473 → 0.591（R@1 43.0% → 54.8%、R@10 51.6% → 63.4%）、en>en 0.596 → 0.750、en>ja 0.567 → 0.767、ja>en 0.263 → 0.368、ja>ja 0.455 → 0.515、set ident 0.083 → 1.000、base・tie・ja-split は変わらず、returned anyway はどの行も変わらない。`node --test test/terms-golden.test.ts test/text.test.ts test/text-properties.test.ts test/search.test.ts test/retrieval-bench.test.ts` → 48 pass。golden は 8 件が変わった（connectWriter・journal_mode・fetchCover・OffscreenCanvas など、部分が増えただけ）。1 MiB の英字の並びは 4 ms

- [x] T05: E2 を採用した場合、schema revision 9 で索引を作り直す
  - 種別: 追加
  - 計画: S3
  - 依存: T04（新しい terms() の規則が要る）
  - 変更: `db/schema.sql`, `db/migrations/0009.sql`, `server/src/sqlite.ts`, `server/test/migrate.test.ts`, `server/test/fixtures/schema-rev8.sql`, `server/test/schema.test.ts`, `server/evals/retrieval/bench.ts`
  - 完了条件: `cd server && node --test test/migrate.test.ts` → revision 8 の fixture を 9 に移行した DB と新しく作った DB で、同じ質問の検索結果が一致する。T04 が不採用なら `[-]` にする
  - コミット: `feat(db): rebuild the search indexes for split identifiers in schema revision 9 (T05)`
  - 結果: red: 0009.sql を `pragma user_version = 9;` だけにすると `node --test --test-name-pattern="migrating revision 8 rebuilds" test/migrate.test.ts` → fail 1、戻すと pass 1。`node --test test/migrate.test.ts` → 43 pass（revision 8 の fixture から 9 へ移行した DB と新しい DB で、connect・reader・pool・connectreader・sqlite の当たりが unit_fts と source_fts の両方で一致する）。`bun run verify` → exit 0（acceptance 98 pass）

- [x] T06: E3a 帯の中だけ decision と constraint を前にして測る
  - 種別: 変更
  - 計画: S4
  - 依存: T02（判定に使う tie の質問が要る）
  - 変更: `server/src/search.ts`, `server/test/search.test.ts`
  - 完了条件: `cd server && node --test test/search.test.ts` → pass。3 件以上の行で入力の順をすべて並べ替えても同じ順になるテストを含む。`node evals/retrieval/run.ts --compare <直前の採用済みのコミット>` の結果を結果行に残し、plan の基準で採否を決める。不採用なら、このタスクのチェックは実装を戻す revert のコミットで付ける
  - コミット: `feat(search): order decisions and constraints first within a bm25 band (T06)`
  - 結果: 不採用。実験のコミット b26045cc で `node evals/retrieval/run.ts --compare 0b76e197` → all・言語の組・set のどの行も同じ（all MRR 0.591、tie 0.804）。対象の tie が改善しないので基準に届かない。kind の組ではどれも decision がすでに帯の先頭か、帯の外にある（T02 の記録のとおり）。`node --test test/search.test.ts` → 19 pass（入力の順 24 通りで同じ順）。このコミットで b26045cc を revert した

- [x] T07: E3b 帯の中だけ新しい記録を前にして測る
  - 種別: 変更
  - 計画: S5
  - 依存: T06（帯の作り方と、E3a の採否で決まる比べる相手が要る）
  - 変更: `server/src/search.ts`, `server/test/search.test.ts`
  - 完了条件: `cd server && node --test test/search.test.ts` → pass。入力の順によらない順のテストを含む。`node evals/retrieval/run.ts --compare <直前の採用済みのコミット>` の結果を結果行に残し、plan の基準で採否を決める。不採用なら、このタスクのチェックは実装を戻す revert のコミットで付ける
  - コミット: `feat(search): order newer records first within a bm25 band (T07)`
  - 結果: 不採用。E3a を採らなかったので比べる相手は 0b76e197。実験のコミット 7687ead1 で `node evals/retrieval/run.ts --compare 0b76e197` → all MRR 0.591 → 0.586（R@1 54.8% → 53.8%）、en>en 0.750 → 0.712、ja>ja 0.515 → 0.530、set tie 0.804 → 0.783、ほかは同じ。全体と en>en が下がり、対象の tie も下がる。kind の組で後から書いた finding が decision より前に出た（t12・t22・t24）。新しさの組で上がったのは t16・t18 など。`node --test test/search.test.ts` → 19 pass（入力の順 24 通りで同じ順）。このコミットで 7687ead1 を revert した

- [x] T09: Codex の T04 のレビュー F1〜F4 を直す（質問の識別子はまるごと 1 語、Unicode の語、先頭の _、SQLite の割れ、base64）
  - 種別: 修正
  - 計画: S3
  - 依存: T04（直す対象の分割の規則）
  - 変更: `server/src/text.ts`, `server/test/text.test.ts`, `server/test/search.test.ts`
  - red: `cd server && node --test --test-name-pattern="counts once, whole|names such as SQLite" test/search.test.ts test/text.test.ts` → 35fc18ab の text.ts で fail 2
  - 完了条件: 同じコマンド → pass 2。`node evals/retrieval/run.ts --compare 0b76e197` → どの行も同じ
  - コミット: `fix(search): count a question's identifier once and cut names only at _ and lower-to-upper (T09)`
  - 結果: red: 35fc18ab の text.ts（0b76e197 と同じ）で fail 2 を実測。直した後 pass 2。`node --test test/text.test.ts test/search.test.ts test/terms-golden.test.ts` → 36 pass、golden は 0 件変化。`--compare 0b76e197` → all MRR 0.591、set ident 1.000 で、どの行も同じ

- [x] T10: Codex の T09 のレビュー F1 を直す（日本語が続く名前も部分を出す）
  - 種別: 修正
  - 計画: S3
  - 依存: T09（直す対象の語の切り方）
  - 変更: `server/src/text.ts`, `server/test/text.test.ts`
  - red: `cd server && node --test --test-name-pattern="names such as SQLite" test/text.test.ts` → 2186b80a の text.ts で fail 1
  - 完了条件: 同じコマンド → pass 1。`node evals/retrieval/run.ts` → all MRR 0.591、set ident 1.000
  - コミット: `fix(search): end a name where Japanese text touches it, so its parts stay searchable (T10)`
  - 結果: red: 2186b80a の text.ts で fail 1 を実測。直した後 `node --test test/text.test.ts test/search.test.ts test/terms-golden.test.ts test/retrieval-bench.test.ts` → 42 pass、golden は 0 件変化。`node evals/retrieval/run.ts` → all MRR 0.591、set ident 1.000

## P3: 結果を残して出す

全実験の結果と E4・E5 の不採用を #204 に残し、採用があればバージョンをそろえる。

- [-] T08: 採用があればバージョンを 0.6.23 にそろえ、#204 への記録の下書きを作る
  - 種別: 変更
  - 計画: S6
  - 依存: T03（E1 の数値が要る）, T05（E2 の採否が要る）, T07（E3a / E3b の採否が要る）
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run release:plan -- --base v0.6.22` → `plugin` で、4 つのファイルが 0.6.23。E1〜E5 の結果（E4・E5 は不採用の理由と見直す条件）の #204 へのコメントの下書きがある（投稿は持ち主の承認の後）。採用が 1 つも無ければ `[-]` にし、下書きは記録節に書く
  - コミット: `chore(release): ship the adopted search experiments as 0.6.23 (T08)`

## 記録
2026-10-03 / T01 / 持ち主の指示で、済んだ #203 の plan と tasks を消す / T01 のコミットに入れた
2026-10-03 / T02 / 完了条件「base の 60 問の数値は main と同じ」は満たせない。追加した記録が base の質問と競合し、ej05 が 1 位から 2 位になった（MRR 0.479 → 0.469）。競合は意図したもの / 完了条件を「base の 60 問は変えない（質問と gold）」と読み替えた
2026-10-03 / T02 / Codex の F1 の残り: kind の組では decision の方が短く、すでに上にある。finding が上の組（lazy-images）も bm25 の差が 5.7% と 6.1% で帯の外。文の長さを調整して帯に入れるのは結果に合わせた作りになるのでしない / E3a は「上がる例が観測されない」ことも測定結果として扱う
2026-10-03 / T04 / 最初の規則では SQLite が sq と lite に割れ、base64 も細切れになった。さらに長い英字の並びで正規表現の試し直しが二乗に増え、テストが止まった / 大文字の連続の後ろは境目にしない、部分 7 つ以上は分けない、語を先に切り出して 100 文字以下だけを判定する形に直し、1 MiB の時間のテストを足した
2026-10-03 / T04 / 変更欄に `server/test/retrieval-bench.test.ts` を足した（前: text.ts・terms-golden.json・text.test.ts） / T03 のコメントの日本語を `bun run english` が落としたため
2026-10-03 / T04 / pre-commit の bundle の検査が、package に入る変更と同じコミットでのバージョンの更新を求めた / E2 の採用でリリースは決まったので、npm と 3 つの manifest を 0.6.23 にする作業を T04 に入れ、変更欄に 4 つのファイルを足した（`bun run release:plan -- --base v0.6.22` → plugin）
2026-10-03 / T08 / バージョンの更新を T04 に移したので取りやめ / #204 への記録の下書きは、全タスクの後（完了の確認の段）で作って見せる
2026-10-03 / T04 / 完了後に計画欄を S3 → S3, S6 に変えた。S6 のバージョンの更新は T04 のコミット（35fc18ab）が行い、T08 を取りやめたので S6 の担い手が無くなったため。S6 の残り（#204 への記録）は完了の確認の段で行う / 完了したタスクの欄は変えない決まりからの例外
2026-10-03 / T05 / 変更欄に fixtures/schema-rev8.sql・schema.test.ts（revision の値を直に持っていた）・bench.ts（T03 の MissCause の不要な export を knip が落とした）を足した（前: schema.sql・0009.sql・sqlite.ts・migrate.test.ts） / `bun run verify` を通すため
2026-10-03 / T04 / Codex のレビュー（35fc18ab、high）: F1 質問の識別子の部分が過半数の分母を増やし、全体が一致する記録を落とし、部分を共有する別の識別子を強いヒットにする（再現）。F2 naïveReader の ASCII の尾 veReader を名前として分ける（再現）。F3 先頭が _ の名前で部分が出ない（再現）。F4 SQLite_get・SQLiteVersion で SQLite が sq と lite に割れる（再現） / 4 件とも受けて T09 を足した。質問の側は部分を足さない（索引の側だけ）。語は Unicode の文字で切り、ASCII だけの語を分ける。区切りは _ と小文字か数字の後の大文字だけ。部分は英字に数字が続く形か数字だけ（base64 を除く）
2026-10-03 / T05 / Codex のレビュー（0b76e197、high）: F1 移行の後に更新前の capture（0.6.22）が古い terms() で書いた source は識別子の部分で見つからず、revision 9 のままなので init でも作り直されない（再現） / 直さない。capture は別のプロセスからも書くので、DB の 1 つの値では索引の状態を表せない（PR #246 の判断と同じ）。取りこぼすのは更新前のフックが書いた行を部分の語で探すときだけで、まるごとの識別子とほかの語では見つかる。リリースノートに、更新の前から開いていたセッションがあれば `sphica doctor --reindex` を流すと書き、PR の Declined findings に残す
2026-10-03 / T09 / Codex のレビュー（2186b80a、high）: F1 語を Unicode の文字で切ったため、日本語が続く名前（connectReaderを使う）が日本語ごと 1 語になり、部分が出なくなった（再現。searchUnits・searchSources・askedBefore で reader が当たらない） / 受けて T10 を足した。名前は Latin の文字・数字・_ の並びで切る
