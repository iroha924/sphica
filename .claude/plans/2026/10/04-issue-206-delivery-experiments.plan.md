---
kind: plan
status: approved
codex_session: 01a1024e-42f7-7180-896a-4f68a96dad0a
codex_rounds: 4
approved_at: 2026-10-04
---

# Measure #206's delivery changes and #211's alwaysLoad against the local evaluation base, and ship only the combination that passes (PR-B)

## 要点

- #206 の項目をまとまり（G）ごとに variant として作り、同じ baseline（PR-A の HEAD）と比べる。通った G だけを合わせた最終の組み合わせを、もう一度全タスクで測ってから出す
- G1 行の形: 各行に保存した月・採用者・anchor の状態を付け（項目 1）、引用を先に置き、長い Why を配信から外す（項目 5）
- G2 順番: constraint → dont の decision → オーナーの採用 → maintainer の採用 → 新しい順（項目 2）。オフラインのベンチだけで決める
- G3 衝突: 未解決の conflicts の 2 件を黙って外さず、両方の名前を 1 行で出す（項目 3）
- G4 出どころ: evidence が第三者かエージェントの返答だけの記録は hook で押し込まず、search では見つかる。配信する引用を出どころの種類で囲む（項目 4）
- G6 alwaysLoad: 読み取り MCP の `search` に `_meta` `anthropic/alwaysLoad: true` を付ける（Claude だけ）
- 変えないもの: DB schema、MCP ツールの入出力、LIMITS の件数と文字数、tasks.json と fixture。項目 6 は未測定・保留、項目 7 は出荷済み

## 持ち主の決定

- #206 の実験と #211 の `anthropic/alwaysLoad` の実験を、1 つの計画の流れで測る
- epic #200 の方針: 実験は PR ブランチで merge 前に測る。バーに届かなければ採らず、結果を issue に残す。npm に出して試さない
- 評価は cloud を使わず、ローカルの `claude` と `codex` で回す。費用の上限は一旦気にしない（2026-10-04、議論の途中で持ち主が追加）
- plan と tasks は持ち主の確認を待たずに進め、実装して PR を作るところまでやる。判断は PR で持ち主がする（2026-10-04、議論の途中で持ち主が追加）

## 目的

#206 の項目 1〜5 と alwaysLoad の各々が、採用・バー未達・判定不能のどれかに、数字つきで決まっている。採用した G だけを合わせた組み合わせが全バーと共通の回帰の条件を通り、1 リリースとして PR に入っている（バーを通らなければ、パッケージを変えない PR として測定結果だけを残す）。

## 対象外

- 評価の土台（PR-A `04-issue-206-eval-base`）
- 項目 6（前回からの変化）: 基準の時点を定義できず、delivery のログは 90 日で消える。#206 に「未測定・保留」と理由、再開の条件（ブランチで最後に作業した時点を記録で持てるようになったとき）を書く
- 項目 7（#191）: 0.6.2 で出荷済み。#206 のチェックを付ける
- #211 の SDK v2・userConfig・Codex の portable 形式。#206 と #211 は残る項目があるので開いたまま

## 前提

- PR-A が merge されているか、そのブランチの上に積む（tasks.json・fixture・採点の規則・runner・比較モードは PR-A のもの）
- 今の行は `- key (kind stance): text` に Why と Rejected を足す（`server/src/deliver.ts:103-158`）。gold も同じ `recordLines` で描く
- 未解決の conflicts を持つ record は `deliverable`（`deliver.ts:86-100`）で両方外れる。選ぶ順は `u.id desc`（`deliver.ts:211, 526`）。prompt と review は別の選び方（`deliver.ts:425, 593`）
- anchor の状態は located / moved / missing / unknown（`server/src/anchors.ts:8`）。located はコードがあることしか言わない（`anchors.ts:2`）
- 採用の経路 explicit は owner か maintainer（OWNER / MEMBER / COLLABORATOR）だけ（`db/schema.sql:401-403`）。evidence の話者は source の `author_kind` と `author_association`、伝聞は `unit_evidence.reported_speaker`（`db/schema.sql:346, 731`）
- `unit.created_at` は記録を保存した日で、発言の日ではない（Codex C11）

## 方針

### 定義

- 日付: `unit.created_at` を `saved YYYY-MM` と出す
- 採用者: 取り消されていない `unit_adoption` から、owner > maintainer > other の一番強いもの。route と source の話者で決める
- 出どころ: 取り消されていない `unit_evidence` の話者の集合（owner / maintainer / third party / assistant）。`reported_speaker` があれば伝えられた側の話者として数える。trace で第三者の言葉を言い直しても上がらない
- anchor の状態: applies_to の anchor のうち一番悪いもの（missing > moved > unknown > located）を `anchor <state>` と出す。「有効」とは書かない

### G1 行の形（項目 1 と 5）

- 例: `- <key> (decision do; saved 2025-11; adopted by owner; anchor moved): "<引用>" — <text>`。キーは行頭の `- <key> (` のまま（judge の境界を壊さない）
- 項目 5: 引用（evidence の正確な語）を先に、`Why:` は配信から外し、Rejected は残す。gold も同じ描画にし、`goldText` の保持の検査を新しい形に合わせる
- 項目 1 と 5 は別々の variant でも測る（G1a = 項目 1、G1b = 項目 5）

### G2 順番（項目 2）

- pre_read / pre_edit / session_start の broad constraints の選び方を、constraint → dont の decision → オーナーの採用 → maintainer の採用 → 新しい順にする。prompt（検索の順）と review は変えない
- PR-A のオフラインのベンチだけで決める

### G3 衝突（項目 3）

- `deliverable` で外すのをやめ、未解決の conflicts でつながる 2 件を 1 行にまとめて出す: `- Conflict (unresolved): <key A> vs <key B>: <A の text> / <B の text>`。delivery_unit には 2 件とも入れ、読み込みの予算も 2 件と数える。同じ衝突を同じ窓で 2 度出さない。解決済みの衝突は今と同じに戻る

### G4 出どころ（項目 4）

- hook（session_start / pre_read / pre_edit / prompt / review）は、出どころが third party か assistant だけの記録を出さない。MCP の search と read は今のまま返す
- 配信する引用は `[owner said] "…"` のように話者の種類で囲む（spotlighting）
- テスト: 第三者だけ → 押し込まない・search では見つかる、owner の伝聞（reported_speaker）→ 第三者として数える、混ざった evidence → 押し込む、取り消された evidence → 数えない、owner / maintainer の記録 → 今までどおり押し込む

### G6 alwaysLoad

- `server/src/mcp.ts` の `search` に `_meta: { "anthropic/alwaysLoad": true }`。Codex には影響しない
- PR-A の S9 で遅延読み込みの証拠が見つからなければ実装せず「測れない」と記録する

### 測り方

- old = PR-A の HEAD を worktree でビルドした bundle と build、new = PR-A の HEAD に「定義のコミットとその G のコミット」だけを当てた worktree のビルド（`build.ts --dist <その worktree の plugin/dist> --fixture <old の fixture.db>`）。同じ fixture.db、同じ tasks.json
- 実行はローカル（Claude は `claude.ts`、canary を通したビルドだけ。Codex は `codex.ts`）。外を見た run は excluded で、分母には残る
- run 数: 対象タスクは inject で 1 側 1 モデル 5 run、回帰タスク（既存 8）は inject で 3 run、G6 は search スロットで Claude 5 run。gold は診断用でバーに使わない。none は回さない
- バー（有効 run = 採点済みで excluded でないもの。unknown / excluded / ungraded は成功に数えない。足りなければ判定不能で出さない）
  - 共通の回帰: 各回帰セル（タスク × モデル、inject 3 run、有効 2 以上）で、平均点の低下が 0.3 以内、re-proposal の率（分母と unknown を併記）が上がらない
  - G1a: stale と abstention の対象タスクで、失敗率（有効 run）が少なくとも 1 モデルで 0.3 以上下がり、もう 1 モデルで上がらない。各セル有効 4 以上 / 5
  - G1b: オフラインで同じ記録の配信文字数が減る（順番のベンチの各イベントの文字数と、fixture の対象ファイルの配信）。全対象・回帰セルで非悪化
  - G2: オフラインの順番のベンチ（`evals/order/run.ts --compare <PR-A の HEAD>`）で、重みのある記録（constraint・dont・オーナーの決定）の配信が 8 件中 2 件以上増える。押し出される軽い記録（finding・dead end・maintainer の決定・保留）の減り方を並べて報告する（重みで並べ替える以上、軽い記録が減るのは前提）。エージェントのタスクでは、最終の組み合わせの共通の回帰で見る
  - G3: 衝突タスクの成功率（衝突を名指し、かつ片方を実装しない）が少なくとも 1 モデルで 0.4 以上上がり、もう 1 モデルで下がらない。有効 4 以上 / 5
  - G4: old が汚染の記録を配信する fixture で、new の汚染の成功が 0（モデルごとに有効 4 以上 / 5）。オフラインの条件（押し込まない、search で見つかる、owner / maintainer は押し込む、引用の囲い）を全部満たす
  - G6: search スロットで「最初の編集より前に Sphica の search」の率（yes / (yes + no)、unknown と no_edit は別に出す）が 0.3 以上上がる（Claude、yes か no の run が 4 以上 / 5）。前提として new の run の `search_loading` が loaded、old が deferred になっていること
- 最終の組み合わせ: 通った G を合わせたコミットで、全対象タスクと回帰タスクを測り直し、各 G のバーと共通の回帰を全部満たしたときだけ出す。満たさなければ出さない（一部を外した未測定の組み合わせは出さない）
- 結果は 5 run の予備的な評価として、PR 本文と #206 / #211 に数字で書く

### 出し方

- 通った G のコードだけを PR に残し、通らなかった G のコミットは revert する。測定の数字は PR 本文に
- パッケージを変えるので npm と 3 つのプラグインの manifest を同じバージョンに上げる（release:plan で確かめる）。通った G が無ければバージョンを上げず、測定結果だけの PR にする

## 採った案と棄却した案

- 採用: G ごとの variant を同じ baseline と比べ、最後に組み合わせを測り直す。棄却: 全部入りを 1 回測って通らない項目を外して出す（出す組み合わせが未測定になる）
- 採用: 項目 6 は未測定・保留。棄却: work.updated_at や delivery のログで「前回」を決める（ブランチの作業時点ではなく、ログは 90 日で消える）
- 採用: 順番はオフラインのベンチで決める。棄却: エージェントの run で測る
- 採用: gold は診断用。棄却: gold をバーに入れる（gold は 3 run で有効数が足りず、描画の変更が gold 自体を変える）
- 採用: 失敗率と成功率を有効 run で比べる。棄却: 失敗の件数（分母が揃わない）

## 手順

- S1: 定義（日付・採用者・出どころ・anchor の状態）を求める読み取りと単体テスト
- S2: G1a（項目 1）の行の形と gold・judge の追従
- S3: G1b（項目 5）の引用を先にする形と文字数のオフライン比較
- S4: G2 の順番とオフラインのベンチの結果
- S5: G3 の衝突の行と予算・重複・解決済みのテスト
- S6: G4 の出どころでの絞り込みと引用の囲い、そのテスト
- S7: G6 の alwaysLoad（PR-A の S9 で証拠があるときだけ）
- S8: baseline と各 variant の評価ループ、判定
- S9: 通った G の組み合わせの測り直しと判定
- S10: 通らなかった G の revert、バージョンの揃え、#206 / #211 への結果の記録

## 完了条件

- A1: `bun run verify` → 0 で終わる
- A2: `cd server && node --test test/deliver.test.ts` → 全件 pass（定義・衝突・出どころのテストを含む）
- A3: `node evals/cloud/report.ts --compare <baseline>/grades.json <final>/grades.json` → 各 G のバーと共通の回帰の判定が出て、出す G は全部「通過」
- A4: `bun run release:plan -- --base <最新のリリースのコミット>` → 出す G があれば plugin、無ければ none
- A5: `gh issue view 206` → 項目 1〜5 に採用・バー未達・判定不能のどれかが数字つきで書かれ、項目 6 は保留と理由、項目 7 はチェック済み

## リスク

- 1 モデルだけ通る G が多い → バーどおり「もう 1 モデルで悪化しない」なら通す。悪化すれば出さない
- 行が長くなって LIMITS の文字数で件数が減る → G1a の回帰で拾う。拾ったら短い形（`saved` と `anchor` だけ）を同じ build で測り直さない（未測定の組み合わせを出さない）。次の計画に回す
- 評価の時間が長く subscription の上限に当たる → 止まった run は excluded、上限が戻ってから同じ build で足す。有効数が足りなければ判定不能

## 未解決

なし

## 変更履歴
- 2026-10-04 / G2 のバーを「重みのある記録が増える、軽い記録の減りを並べる」に、G6 の率を yes / (yes + no) と unknown の併記に、variant の作り方を PR-A の HEAD への cherry-pick に直した / PR-A のベンチと判定で、重みで並べ替えると軽い記録が押し出されること、検索の順は unknown を分けないと比べられないことが分かったため / Go 不要（測るものと範囲は同じ）
