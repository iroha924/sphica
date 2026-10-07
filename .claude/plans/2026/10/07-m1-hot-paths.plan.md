---
kind: plan
status: approved
codex_session: 01a111d0-33f9-7141-a617-92f4f98e6172
codex_rounds: 3
approved_at: 2026-10-07
---

# 記録数に比例して遅くなる配信（プロンプト・review・Bash）を計測で確かめて直し、計測を再現できる形で残す（#270）

## 要点

- 生成データで hook を本物どおり（bundle した `deliver.js` を新しいプロセスで）計測するスクリプト `server/evals/scale/run.ts` を足す。verify には入れない
- 試算では、記録 1 万件でプロンプト配信が 12〜13 秒かかり、5 秒の上限を超えた。配信できる記録が 32,767 件を超えると SQLite のパラメータ数の上限に当たり、プロンプト配信は何も言わずに空を返す。review の選び出しにも同じ形がある
- 直すのは `onPrompt`・`selectForReview`・（計測で 1 秒を超えたときだけ）`namedInCommand` の 3 関数。記録を unit id ごとに Map にまとめ、全件の id を `in` に並べるのをやめる
- 実装の塊: 計測スクリプトと main での計測 → 今の挙動を固定するテスト → 32,767 件の red → 3 関数の修正 → 計測し直し → Skill の確認項目 → 0.6.39 の release
- 変えないもの: 一致の規則（シンボル・パス・選択肢の文字列、NFKC、語の境界）、記録の並びと説明に出す anchor・選択肢の選び方、capture の吐き出し（試算で 5 万件 7.9 秒、30 秒の予算内）、schema と index

## 持ち主の決定

- 次の作業は Phase 03 の M1 #270 にする（H1 #279 は上流の fast-uri 待ちで保留のまま）
- #270 の本文: 生成データで、現実的な件数と増やした件数で、hook の時間の上限に照らして測る。直すのは計測で出たものだけで、完全一致・queue の順序・遅れて届くものの扱いは変えない。計測結果は #270 に残す

## 目的

- 記録 1 万件のプロジェクトで、プロンプト・review・Bash の配信が、計測した機械で 1 回 1 秒以内に返り、配信する記録の中身が今と同じ
- 配信できる記録が 32,767 件を超えても、プロンプト配信と review の選び出しが失敗しない
- 同じスクリプトを流せば、同じ表が作り直せる

## 対象外

- 他の経路（Read、Edit、SessionStart、SubagentStart、capture の吐き出し）の修正。計測して表に載せ、上限を超えたら発見として書き、持ち主が文面を承認してから別の issue にする
- schema・index の変更。要るとなったら別の計画と Go にする
- 検索の速さ（#204 で扱った）、live と review_select の返信の大きさ（#289）
- verify での時間の検査（機械と OS で揺れるので、CI で落ちたり見逃したりする）

## 前提

- 試算（2026-10-07、main 62794f28、Node 24.15.0、SQLite 3.51.3、macOS、Apple Silicon、scratchpad の使い捨てスクリプト。本物の保存経路で 50 件ずつ保存し、各記録は `constraint do`、`applies_to` の anchor 2 つ、rejected の選択肢 2 つ。`deliver()` を同じプロセスで呼んだ）
  - UserPromptSubmit: 300 件で最初の 1 回 380 ms、1,000 件で 865 ms、3,000 件で 3,796 ms、10,000 件で 12,000〜13,000 ms（5 回とも）
  - PreToolUse Bash（`cat src/modN/a.ts | head`）: 3,000 件で 330〜526 ms、10,000 件で 1,387〜1,685 ms
  - PreToolUse Read: 18〜19 ms、SessionStart: 19〜30 ms（件数によらない）
  - capture の `flush()`: queue 1,000 件で 118 ms、10,000 件で 1,199 ms、50,000 件で 7,875 ms（すべて送られて残り 0）
- 持ち主の今の DB: unit 359、unit_anchor 376、unit_option 295（2026-10-07、読み取りだけで数えた）
- hook の上限: Claude Code の `deliver.js` は 5 秒（`plugin/hooks/hooks.json`）、Codex は UserPromptSubmit・SessionStart 10 秒、PreToolUse 5 秒（`plugin/hooks/codex.json`）。hook は呼ぶたびに新しい `node` のプロセスなので、最初の 1 回の時間が実際の時間になる
- `node:sqlite`（SQLite 3.51.3）は 32,766 個の束縛パラメータまで通り、32,767 個で `too many SQL variables`（実測）。`onPrompt` は配信できる全記録の id を 2 つの `in` に入れ（`server/src/deliver.ts` の `onPrompt`）、`selectForReview` は場所の無い dont / defer の全記録の id を `in` に入れる（`server/src/review.ts:176-184`）。プロンプト配信の失敗は空を返して黙る（`deliver.ts` の `deliver` の catch）
- 今の並び: `onPrompt` の記録は index `unit_live (project_id, lifecycle, kind)` をたどるので kind、次に rowid の順。anchor は `unit_anchor_unit (unit_id, retired_at)`、選択肢は `unique (unit_id, id)` の自動 index をたどり、どちらも 1 つの記録の中では id 順（Codex が EXPLAIN QUERY PLAN と `index_xinfo` で確認、`db/schema.sql:337,372-374,680`）。順序を書いた `order by` は無い
- `selectForReview` の対象（`live` と、どの役割の anchor も持たない `free`）は配信の衝突の除外を通さない。配信は結果を `deliverable` で絞り直す（`deliver.ts` の `beforeReview`）。read サーバーの `review_select` も同じ関数を使う
- review の入口は 2 つ: UserPromptExpansion の slash command と PreToolUse の Skill（`server/src/review-bridge.ts:24`）。比べる ref と merge base が要る（同 `:73`）
- 未検証: Windows と Linux での時間（表は計測した機械のもの）

## 方針

計測スクリプト `server/evals/scale/run.ts`（`server/evals/retrieval/`・`server/evals/order/` と並べる。verify に入れない）:

- 流す前に `bun run bundle` で `plugin/dist` を作り、表の頭に commit、`node --version`、OS、CPU、fixture の件数を出す
- 一時ディレクトリに DB を作り、本物の保存経路（`checkRecord` と `saveRecord`、50 件ずつ）で記録を入れる。一時の git checkout は origin を project の key に合わせ、review 用に base のコミットと比べられる ref を用意して差分を作る
- 各イベントを、ホストと同じく `node plugin/dist/deliver.js` を新しい子プロセスで 5 回ずつ流し、中央値と最大を出す。子の env は親の `SPHICA_DB`・`SPHICA_HOME`・`CODEX_HOME`・`SPHICA_PARENT_SESSION`・`CLAUDE_CODE_ENTRYPOINT`・`CLAUDE_PLUGIN_OPTION_*`・`CODEX_THREAD_ID` を渡さず、`HOME` と `SPHICA_HOME` は一時ディレクトリにする。呼ぶたびに別の session id にする。各 hook に設定された上限で子を止め、timeout と出す
- 流すイベント: UserPromptSubmit（一致あり・一致なし・4 KB の一致しない文）、PreToolUse の Read・Edit・Bash、review の 2 つの入口、SessionStart、SubagentStart。同じ session で N 個のファイルを読む行は別に出す
- 中身を確かめる: 一致ありは期待する記録の key を含み「Sphica unavailable」を含まない、一致なしは何も出さない。timeout・出力が JSON でない・中身の誤りを時間とは別に出し、どれかがあれば 0 以外で終わる
- fixture は 2 系統
  - uniform（試算と同じ形）: 359、1,000、3,000、10,000、30,000 件。前後の比較に使う
  - stress（10,000 件だけ）: 5 % が同じ 1 つのパスに anchor を持つ、1 % が anchor 20 個と 500 文字の選択肢 12 個を持つ、10 % が場所の無い broad な constraint、10 % が場所の無い dont / defer（review 用）、いくつかの衝突の link、delivery 50,000 行と session 2,000 件の履歴
- capture の吐き出し: `SPHICA_HOME` を一時ディレクトリにして、queue 1,000・10,000・50,000 件を `flush()` で流し、時間、送った件数、残ったファイル、`source` の行数を出す
- 出力は #270 に貼れる Markdown の表

基準（直す前に決めておく。計測した機械に対して）:

- 10,000 件で、プロンプト・review（2 つの入口）・Bash の最大が 1 秒以内（一番短い上限 5 秒の 20 %）。uniform と stress の両方
- ほかの経路は両系統で中身の確認を通り、時間を表に出す。1 秒を超えたら発見として書き、別の issue にする（文面は持ち主の承認の後）
- uniform 30,000 件で、すべての経路が設定された上限の中で返る
- capture の吐き出し: 50,000 件が 30 秒の予算の中で全部送られる。満たすなら capture は変えない

修正:

- `onPrompt`: 記録を `order by u.kind, u.id` で取る（今 index をたどって出ている順を書き出したもの）。anchor と選択肢は、id を `in` に並べず、同じ `deliverable` の条件の部分問い合わせか join で取り、`order by id` にして unit id ごとの Map にまとめる。パスと選択肢の照合（正規表現）は、同じ文字列ごとに 1 回だけ作る。一致の規則、anchor を選択肢より先に見ること、説明に出す anchor・選択肢の選び方、3 件で切ることは変えない
- `selectForReview`: 選択肢は `free` と同じ条件（`live` の条件と、どの役割の anchor も持たない）の部分問い合わせで取り、unit id ごとの Map にまとめる。`deliverable` は使わない（`review_select` の結果が変わるため）。差分の追加行の走査は今のまま（差分の大きさで決まる）
- `namedInCommand`: 新しいプロセスで 1 秒を超えたときだけ直す。今の全部のパスの形（root からの相対、cwd からの相対、`./` の有無、絶対パス、両方の区切り文字）と境界の規則を変えない
- 直す前に、今のコードで緑になる特徴づけのテストを書く: kind の混ざった 4 件以上の一致の並び、anchor が選択肢より先、複数一致したときに説明に出す anchor と選択肢、position の順と id の順が違う選択肢、retired の anchor を見ないこと、衝突した記録を出さないこと、NFKC と Unicode、両方の区切り文字、境界の取りこぼし。review は `selectForReview` の結果と hook の結果を別々に、衝突した記録・evidence の anchor だけを持つ記録・retired の anchor・普通の場所の無い一致で確かめる。特徴づけのテストが上と違う並びを示したら、示された並びに合わせる。並びが変わるのを避けられなければ、そこで止めて持ち主に聞く
- 32,767 件の red: 一時 DB に、owner の接続で 1 つの transaction の中で、本物の候補 → active の遷移（evidence と adoption 付き）を踏んで入れる。一致させる記録だけに anchor か選択肢を付けて最後に置く。fixture の件数を `deliverable`（review は `free`）と同じ条件で数えて確かめ、今のコードでプロンプト配信が空を返す（review は選び出しが失敗する）ことを確かめてから直す。テストの時間を測り、この機械で 10 秒を超えたら報告する

同じ誤りを次に止めるもの:

- verify: 特徴づけのテストと、プロンプト・review の 32,767 件のテスト（時間ではなく結果を見る）
- `plugin-release` Skill の確認項目に 1 行: `server/src/deliver.ts` か `server/src/review.ts` の照合のコードを変える PR は `node server/evals/scale/run.ts` を前後で流し、表を PR 本文に載せる
- 配列を `in` に渡すことを機械で禁じる検査は入れない（少ない件数で正しく使っている所まで引っかかる）

release: `deliver.ts` と `review.ts` はパッケージに入るので、`bun run release:plan` で種別を確かめてから npm と 3 つの plugin manifest を 0.6.39 に上げ、release.yml で出す。#270 に貼る前後の表と文面は、持ち主の承認を受けてから投稿する。

## 採った案と棄却した案

- 採用: 合格の判定は bundle した hook を新しいプロセスで流した時間。棄却: 同じプロセスでの `deliver()` の時間（2 回目以降は温まって速くなり、実際の hook と違う。原因を探すときだけ使う）
- 採用: 時間だけでなく、出力の中身も確かめる。棄却: 終了コードと時間だけ（プロンプト配信は失敗すると空を返して黙るので、壊れていても速く見える）
- 採用: verify では結果を見るテストだけ。棄却: verify に時間の上限を置く（1 台の計測では根拠にならず、Windows の CI で揺れる）。棄却: SQL の文の数や正規表現を作った回数を数える（全件を探し直す今の遅さは、SQL の数にも正規表現の数にも出ない）
- 採用: 並びは今 index をたどって出ている順（kind、id）を `order by` で書く。棄却: id 順だけ（kind の混ざった一致で、今と並びが変わる）
- 採用: 修正の範囲は 3 関数。ほかの経路は計測と発見の記録まで。棄却: 基準を超えた経路を全部この PR で直す（範囲が計測の結果しだいで広がる）
- 採用: review の選択肢は `selectForReview` 自身の条件で取る。棄却: `deliverable` で取る（`review_select` の結果が変わる）
- 採用: 計測の基準は Skill の確認項目で守る。棄却: `in` に配列を渡すのを禁じる機械の検査（正しい使い方まで止める）

## 手順

- S1: 計測スクリプト `server/evals/scale/run.ts`（uniform と stress の fixture、子プロセスでの hook の実行、中身の確認、capture の吐き出し、表の出力）と、main での計測
- S2: プロンプト配信と review の特徴づけのテスト（今のコードで緑）
- S3: プロンプト配信と review の 32,767 件のテスト（今のコードで red）
- S4: `onPrompt` の修正
- S5: `selectForReview` の修正
- S6: 計測し直し。Bash が 1 秒を超えていたら `namedInCommand` の修正とそのテスト
- S7: `plugin-release` Skill の確認項目
- S8: バージョンを 0.6.39 に上げる、verify、PR、レビュー、release、#270 への投稿（文面は承認の後）

## 完了条件

- A1: `node server/evals/scale/run.ts` → 0 で終わり、中身の誤り・timeout・JSON でない出力が 0 件。10,000 件の uniform と stress の両方で、プロンプト・review の 2 つの入口・Bash の最大が 1,000 ms 以内。uniform 30,000 件ですべての経路が設定された上限の中で返る
- A2: `node server/evals/scale/run.ts` → capture の行が 50,000 件で 30,000 ms 以内、送った件数 50,000、残り 0、`source` の行数が一致
- A3: `bun run verify` → 0 で終わる。S3 のテストが修正前のコードで落ち、修正後に通ったことを tasks の記録で示せる
- A4: `gh issue view 270 --comments` → 修正前と後の表が、持ち主が承認した文面で載っている
- A5: `gh pr view --json body` → ほかの経路で 1 秒を超えたものが発見として書かれ、持ち主の承認を受けた別の issue の番号がある。無ければ「無し」と書かれている

## リスク

- 32,767 件の fixture を作るのに時間がかかり、verify が遅くなる → 時間を測って報告し、件数をぎりぎり（32,767）にする。60 秒の上限に近づくなら持ち主に聞く
- 特徴づけのテストが今の並びを捉えきれず、修正で並びが変わる → kind の混ざった fixture と position の違う選択肢で固定してから直す。避けられない変化は止めて聞く
- 計測の数字は機械で変わる → 表に機械を書き、基準は計測した機械に対するものだと書く
- `namedInCommand` を直すときにパスの形を取りこぼす → 今のパスの形ごとのテストを先に置く

## 未解決

なし

## 変更履歴
