---
kind: plan
status: approved
codex_session: 01a0fd30-a095-7192-9f0f-273ddb34da00
codex_rounds: 3
approved_at: 2026-10-03
---

# #204 の残りの実験を、先に固定したベンチマークの基準で採否を決め、採用したものだけを出す

## 要点

- 実験のコードより先に、オフラインのベンチマーク（`server/evals/retrieval/`）のコーパスと loader を広げてコミットし、Codex のレビューを受けて固定する。今のコーパスでは「当たれば 1 位、外れれば全部外れ」なので、並べ替えの変化が数字に出ない
- E1: 日本語の取りこぼしの原因を測るだけ。bigram 索引はこの PR では作らない（条件を満たしたら別の計画）
- E2: `terms()` で camelCase と snake_case を分けた部分も語にする。採用したら schema revision 9 で両方の索引を作り直す
- E3a / E3b: bm25 の固定の帯の中だけで、kind と新しさで並べ替える。2 つは別々に測る
- E4（alias の整理の警告）と E5（`sources: true` の検査を安くする）は、コードを書かずに、不採用の理由と見直す条件を #204 に残す
- 変えないもの: ヒットの判定（語の過半数、または anchor の識別子とのまるごとの一致）、`identTerm()`、ツールの引数、source の検索
- 採用されたものがあれば npm と 3 つの manifest を次のパッチのバージョンにそろえて出す。1 つも採用されなければ package は出さない

## 持ち主の決定

- #204 の残りの実験項目（識別子の分割、新しさと kind の重み、alias の整理、日本語の分割による取りこぼしの測定、`sources: true` の負荷軽減）を、#212 のオフラインのベンチマークで判定する
- epic #200 の方針に従う: 実験は PR のブランチで測ってから採否を決める。基準に届かなければ出さず、結果を issue に残す。効くかどうかを知るために npm へ出さない

## 目的

- #204 の実験項目が、どれも「採用（merge）」か「不採用（数値か理由付きで #204 に記録）」のどちらかになり、#204 を閉じられる
- 採用した変更は、事前に固定した基準を、固定した main（bd81445c）と直前の採用済みのコミットの両方に対して満たしている

## 対象外

- embeddings、形態素解析器、tree-sitter（#200 の Not taken）
- bigram 索引の実装（E1 で条件を満たしても、候補の出し方・過半数の判定との関係・順位の統合・索引の作り直しを決める別の計画にする）
- 持ち主の DB（`~/.sphica`）を開く測定（AGENTS.md と `.claude/rules/verification.md` が禁じている）
- #244、#239（クラウドの評価ループ。オフラインのベンチマークは使わない）
- 索引を作った ICU を DB に記録すること（PR #246 で棄却済み）

## 前提

- main（bd81445c）のベンチマーク: all R@1 47.9%、R@5 47.9%、R@10 47.9%、MRR 0.479、returned anyway 0.0%。ja>en 25.0%、ja>ja 41.7%、en>en 50.0%、en>ja 75.0%。どのグループでも R@1 = R@10（2026-10-03 に `node evals/retrieval/run.ts` で実測）
- 並べ替えは lifecycle → matched の数 → bm25 の順（`server/src/search.ts:159`）。ヒットの判定は語の過半数か anchor の識別子（`server/src/search.ts:46`、`:304-309`）
- `terms()` は先に小文字にしてから分けるので、`connectReader` → `connectreader`、`snake_case_name` → `snake_case_name` のまま 1 語。`src/db-write.ts` は `src`, `db`, `write.ts` とまるごとに分かれる（2026-10-03 に実測）。規則を変えたら schema の revision を上げ、索引を作り直すマイグレーションが要る（`server/src/text.ts:41`）
- `SCHEMA_REVISION` は 8 で、`db/migrations/0008.sql` は使用済み（`server/src/sqlite.ts:17`）
- 保存は `Date.now()` を `unit.created_at` に使い（`server/src/record.ts:773`）、`created_at` は後から変えられない（`db/schema.sql:297`）。active な implementation には code か commit の根拠が要る（`db/schema.sql:570`）
- bench の corpus の記録には anchors も created_at も無い（`server/evals/retrieval/bench.ts:13`）。`run.ts --compare <ref>` は今の runner と corpus を ref の worktree にコピーして動かす（`run.ts:44`）
- source_fts の MATCH は `terms()` の照合と同じではない。保存した語を unicode61 がさらに分けるので、`src/db.ts`・`foo_bar`・`café` で結果が変わる（Codex が実 SQLite で再現）。同じ分割で作った索引なら必要条件にはなるが、capture は別の Node のプロセスからも索引に書き（`server/src/db-write.ts:334`）、分割が違う索引では強いヒットを落とす（Codex が模擬で再現）
- PR #246 で、合成 DB の source 検索は 16〜24 ms になった（PR #246 本文）

## 方針

- **Phase 0: コーパスと loader**（`server/evals/retrieval/corpus.json`、`bench.ts`、`run.ts`、`server/test/retrieval-bench.test.ts`）
  - 記録に `anchors`（`{ path, symbol }` の配列、省略可）と `created_at`（ISO、省略可）を足す。質問に `set` を足す（`base`（今の 60 問）/ `ident` / `tie` / `ja-split`）
  - 保存は記録ごとに `Date.now` を bench のプロセスの中だけで固定した時刻に差し替え、try/finally で必ず戻す。保存の経路と schema の制約は変えない。active な implementation など、kind に必要な根拠は fixture で用意する
  - 質問を流す前に、anchors・created_at・lifecycle が書いたとおりに保存されたことを確かめ、違えば止める
  - 追加の質問は #204 の記述から書き、gold は「その質問が求める答え」で決める（新しいから・decision だから、では決めない）
    - `ident`: camelCase / snake_case の symbol や path に anchor された記録と、その一部の語で聞く質問。gold なしの質問（識別子の一部が偶然重なるだけ）も入れる
    - `tie`: 質問の語を共有する記録の組（古い決定と新しい決定、decision と implementation / finding、置き換えの鎖）。gold が古い方や implementation / finding になる対照の質問と、gold なしの質問も入れる
    - `ja-split`: gold の本文や alias に、質問の言葉が分割の違う形で入っている日本語の質問。偶然の文字の重なりだけの gold なしの質問も入れる
  - run.ts の集計に set ごとの行を足す。既存の 60 問は変えない
  - テストの件数（`retrieval-bench.test.ts` の 48 / 12）を新しい件数に直す
  - このコミットを Codex にレビューさせ、指摘を直してから実験に入る。以後コーパスは変えない（変えたら全実験を測り直す）
- **採用の基準**（全実験で共通。結果を見る前にここで固定）
  - `all` の MRR が上がる
  - どの言語の組でも R@1・R@5・R@10・MRR が下がらない
  - returned anyway が、全体でもどの set でも上がらない
  - 実験の対象の set（E2 は `ident`、E3a / E3b は `tie`）が改善する
  - `base` の 60 問だけで見ても何も下がらない
  - 比べる相手は、直前の採用済みのコミット（`run.ts --compare <sha>`）。最後にブランチ全体を bd81445c と比べる
  - 不採用の実験はブランチで revert し、数値を #204 に残す
- **E1: 日本語の取りこぼしの測定**（`run.ts` に `--misses` を足す。検索のコードは変えない）
  - 対象は ja>ja と ja>en の gold ありの質問で外れたもの
  - 質問ごとに、一致した語・足りない語と、足りない語ごとの原因（分割 / 語彙の違い / 規則で除外（ひらがなだけ、疑問の言葉）/ その他）を出す。混在と分類できないものも残す
  - 判断に使う数: 分割だけを直せば過半数に届く質問の数。対象の外れの 20% 以上かつ 3 問以上なら、bigram を別の計画として #204 に書く。届かなければ数値を残して終える
- **E2: 識別子の分割**（`server/src/text.ts`、`db/schema.sql`、`db/migrations/0009.sql`、`server/src/sqlite.ts`、`server/src/terms-golden.json`）
  - `terms()` は、NFKC の後・小文字にする前の語から、`_` と camelCase の境目（小文字→大文字、大文字の連続→大文字＋小文字）で部分を取り出し、小文字にして語に足す。まるごとの識別子も今までどおり残す。部分にも今の除外（STOP、ひらがなだけ、MAX_TERM）と単数形化をかける
  - `identTerm()` と、anchor の識別子とのまるごとの一致の判定は変えない
  - 測って基準を満たしたら: schema revision 9。`0009.sql` は unit_fts と source_fts を `reindex()`（`server/src/admin.ts`）と同じやり方で作り直す。terms の golden を新しい規則で直し、doctor の分割の検査もそれを使う。revision 8 の fixture DB を移行した結果と、新しく作った DB の検索結果が一致することをテストで確かめる
- **E3a / E3b: 帯の中での並べ替え**（`server/src/search.ts` の最後の並べ替え）
  - lifecycle と matched の数が同じグループの中で、bm25 → id の順に並べる。グループの先頭の行から、|bm25| の差が先頭の |bm25| の 5% 以内の行を 1 つの帯にし、帯の外の最初の行から次の帯を始める（隣どうしでつないで帯を広げない）
  - E3a: 帯の中だけ、decision と constraint を他の kind より前にする。それ以外は bm25 → id
  - E3b: 帯の中だけ、`created_at` の新しい方を前にする（E3a を採用したなら kind の後）
  - テスト: 3 件以上の行で、入力の順をすべて並べ替えても同じ結果になる
- **E4・E5**: コードを書かない。#204 に不採用の理由と見直す条件を書く（下の「採った案と棄却した案」）
- **出すもの**: 採用があれば `bun run release:plan -- --base v0.6.22` で種類を確かめ、npm と 3 つの manifest を 0.6.23 にそろえる。E2 を採用したらリリースノートに、更新で索引を作り直すと書く

## 採った案と棄却した案

- 採用: 実験の前にコーパスを広げて固定する。棄却: 今の 60 問のまま測る（R@1 = R@10 で並べ替えの変化が出ない）
- 採用: 直前の採用済みのコミットと比べ、最後に main と比べる。棄却: main とだけ比べる（先に採用した変更の改善が、次の変更の悪化を隠す）
- 採用: kind と新しさは固定の帯の中だけ。棄却: lifecycle と matched の数が同じなら常に kind と新しさを優先（bm25 の大きな差を無視する）、隣どうしの 5% の比較（順位が循環し、入力の順で結果が変わる。Codex が再現）
- 採用: E1 は原因の測定まで。棄却: 同じ PR で bigram まで試す（過半数の判定と順位の統合の設計が決まっていない）
- 採用: E2 は revision 9 の新しいマイグレーション。棄却: revision 8 に足す（使用済み）
- 採用: E4 は不採用として記録する。棄却: 持ち主の DB を読んで alias の分布を測る（`~/.sphica` を開かない規範に反する）、コーパスで警告を測る（手書きのコーパスの alias は実データを表さず、警告の効果は後の書き込みにしか出ない）。見直す条件: alias から来た誤ヒットの報告、または持ち主が認めた匿名化した snapshot で測る手段ができたとき
- 採用: E5 は不採用として記録する。棄却: source_fts の MATCH での置き換え（`terms()` の照合と同じにならない）、MATCH を必要条件として前段で絞る（索引を書いた Node と分割が違うと強いヒットを落とし、今の仕組みでは防げない）、本文の一部だけを検査（取りこぼす）。見直す条件: 実データで `sources: true` が遅いと測れたとき、または索引とそれを書いた分割の規則を結び付ける手段ができたとき

## 手順

- S1: Phase 0。コーパスに set・anchors・created_at と追加の質問を足し、loader（固定した時計、根拠の fixture、保存後の確認）と run.ts の set ごとの集計を作る。Codex のレビューで固定する
- S2: E1。`run.ts --misses` で日本語の取りこぼしを分類し、結果を #204 に書く
- S3: E2。`terms()` の識別子の分割を入れて測る。基準を満たせば revision 9 のマイグレーション・golden・fixture のテストまで入れ、満たさなければ revert して数値を #204 に書く
- S4: E3a。帯の中の kind の並べ替えを入れて測り、採否を決める
- S5: E3b。帯の中の新しさの並べ替えを入れて測り、採否を決める
- S6: E4・E5 の不採用と、全実験の結果を #204 に書く。採用があればバージョンを 0.6.23 にそろえる

## 完了条件

- A1: `cd server && node evals/retrieval/run.ts` → `base` / `ident` / `tie` / `ja-split` の set ごとの行と、言語の組ごとの行が出る
- A2: `cd server && node evals/retrieval/run.ts --compare bd81445c` → 採用した実験がある場合、`all` の MRR が上がり、どの言語の組でも R@1・R@5・R@10・MRR が下がらず、returned anyway がどの行でも上がらない。採用が無い場合、検索のコード（`server/src`）に main からの差分が無い
- A3: `cd server && node evals/retrieval/run.ts --misses` → ja>ja と ja>en の外れた質問ごとに、足りない語と原因が出る
- A4: `gh issue view 204` → 5 つの実験項目すべてに、採用（この PR）か不採用（数値か理由と見直す条件）のコメントがある
- A5: E2 を採用した場合、`cd server && node --test test/migrate.test.ts` → revision 8 の fixture を 9 に移行した DB と新しく作った DB で検索結果が一致する
- A6: `bun run verify` → exit 0
- A7: 採用がある場合、`bun run release:plan -- --base v0.6.22` → `plugin`、npm と 3 つの manifest が 0.6.23。採用が無い場合 → `none`
- A8: `gh pr checks <PR 番号>` → すべて pass

## リスク

- 追加の質問を書く自分が、実装の中身を知っていて質問を寄せてしまう → #204 の記述から書き、実験の前に Codex にレビューさせて固定する。固定の後で直したら、全実験を測り直す
- 識別子の分割で語が増え、「語の過半数」の分母が変わって誤ヒットが出る → gold なしの `ident` の質問と、returned anyway の基準で落とす
- revision 9 の索引の作り直しで、大きな DB の更新が遅くなる → fixture のテストで時間を測り、リリースノートに書く
- `Date.now` の差し替えが戻らず、後の保存の時刻が狂う → try/finally で戻し、保存後に created_at を確かめる

## 未解決

なし

## 変更履歴
- 2026-10-03 / E2 の区切りを「_ と、小文字か数字の後の大文字」だけにした（計画の「大文字の連続→大文字＋小文字」は採らない。XMLHttpRequest は xmlhttp と request になる） / 大文字の連続の後で区切ると SQLite が sq と lite に割れ、短い base64 も細切れになる（T04 の実測と Codex の T04 のレビュー F4）。質問の側は名前を分けない（Codex の T04 のレビュー F1） / Go は要らない（E2 の中の規則の細部で、範囲・公開インターフェース・データは変わらない）
