---
kind: plan
status: approved
codex_session: 01a113dc-1423-7362-a597-be21eae70921
codex_rounds: 3
approved_at: 2026-10-07
---

# 読み取りの MCP の overview に、配信のログを期間で見せるビュー delivery を足し、持ち主が PR ブランチで試してから採否を決める（#258）

## 要点

- `overview` に `view: "delivery"`（`days` 1〜90、既定 7）を足す。1 プロジェクト・1 期間の配信ログの集計、多く配信された記録、例のセッションを、32 KiB（`READ_BUDGET`）に収まる 1 回の返答で返す。読み取りの接続だけを使い、schema・配信・ログの書き方・保持期間は変えない
- 「言及」は、配信の後の同じセッションの assistant の返信（AskUserQuestion の質問を除く）に、記録の key がそのまま、前後の境界付きで書かれていること。「使われた」「役立った」とは書かない
- 返答には、ログに無いもの（空の read / edit、ロック待ちや書き込み失敗で残らなかった配信、90 日の保持）を毎回書く
- 実装の塊: ビューの本体とテスト → MCP の引数とテスト → 規模の計測 → README とバージョン → 持ち主の試用 → 採用なら merge と release、不採用なら PR を閉じる
- フラグは作らない。npm へ出すのは持ち主が採用した後だけ

## 持ち主の決定

- 次の作業は Phase 03 の O1 #258 にする（2026-10-07）
- 試用は PR ブランチで行う。フラグを作らず、採用までは npm へ出さない。採用ならフラグ無しで merge と release、不採用なら PR を閉じて #258 に結果を残す（2026-10-07、Codex との議論の後に持ち主が決定。#258 の本文の「既定で off にして出す」をこれで置き換える）
- #258 の本文: 期間とプロジェクトを指定する、overview の範囲を持つビュー。イベントと結果ごと・main と subagent ごとの配信、多く配信された記録、例のセッション（記録の key、イベント、時刻、今の記録への参照）、最後の返信が key を書いたときの狭い「言及」のラベル。「used」「unused」「helped」のラベルは付けない。読み取りの接続で既存のテーブルを読み、新しい集計・利用ログ・自動の削除を足さない

## 目的

- 持ち主が「Sphica は何を見せていたか」とエージェントに聞くと、指定した期間の配信が 1 回の返答で分かり、記録ごとに役立った / 関係ない / 分からないを判断して、key で記録を読みに行ける
- 返答は、framed の枠込みで `READ_BUDGET` 以内に収まり、ログの限界を毎回言う
- 持ち主の試用の結果（判定した例、かかった時間、レビューの手間に見合うかの判断）が #258 に残る

## 対象外

- 配信の中身・並び・出所の変更（#206）、subagent の compaction（#244）、衝突の検出（#213）。ビューはログにあるものを見せるだけ
- schema、ログの書き方、保持期間、削除の変更。新しいテーブル・集計・利用ログ
- CLI のコマンド（CLAUDE.md で CLI は init / doctor / uninstall だけ）、HTML やファイルへの書き出し（CLAUDE.md の no-progress-files）
- ページ送り（続きのカーソル）。例を見て判断するには、上限付きの 1 ページで足りる
- 採用前のリリースとフラグ（持ち主の決定）

## 前提

- `delivery` と `delivery_unit`: `db/schema.sql:1100-1126`。outcome の CHECK は emitted / nothing / unavailable / suppressed を許すが、書くのは `server/src/deliver.ts` の `write()` だけで、emitted か nothing しか書かない
- ログに残らないもの: 空の read / edit の結果（`deliver.ts:1041-1049` の `keep`）、書き込みロックが空かずに計画だけ返した配信と、ログの書き込みが失敗した配信（`deliver.ts` の `lockedPlan` と `log(...).catch`）
- 保持: 最後の配信が 90 日より前のセッションの行を消す（`deliver.ts` の `RETAIN_MS`、`db/schema.sql:1217-1226`）。期間は移動窓ではない
- session_start の `omitted` は作業項目と制約を足した数（`deliver.ts:692-720`）。emitted でも `delivery_unit` の行が無いことがある（作業項目だけ、または省略の注記だけ）
- subagent の判定: `agent_id` が null でも、`event = 'session_start'` かつ `reason = 'subagent'` は subagent の開始（`deliver.ts:973-974`、`:1026-1033`）
- 最後の返信は Stop の `last_assistant_message`。AskUserQuestion の質問も assistant の session_message として入り、external_id が `*:ask:*:q:*`（`server/src/capture.ts:539-559`、`db/schema.sql:904`）
- key は前後に文字を足した別の key があり得る（`trace:s/foo` と `trace:s/foo-bar`、`server/src/record.ts:34`）。`instr()` だけでは区別できない（Codex が SQLite で再現）
- 返答の上限: Codex 0.160.0 はツールの出力が約 40,000 バイトを超えると真ん中を落とす（#289）。`READ_BUDGET` = 32 KiB（`server/src/read.ts:423`）
- MCP の設定は両ホストとも server に env を渡していない（`plugin/mcp/claude.json`、`plugin/mcp/codex.json`）。フラグを作らないのでこの配線は要らない
- 持ち主の DB（2026-10-07、読み取りだけで数えた）: 2026-09-27 以降 8,159 行、直近 7 日で 343 セッション。pre_read の emitted 4,165 行のうち 2,847 行に記録が無い。assistant の session_message 1,451 件。プロジェクト 1 つ
- 未検証: 計測の前の、ビューの問い合わせの実際の時間

## 方針

新しいモジュール `server/src/delivery-view.ts` に `deliveryOverview(db: Reads, projectId: number, days: number, now: Date): Promise<string>`。期間は `[now - days 日, now)`、時刻は UTC の ISO。

返答の節（この順）:

1. 見出し: 期間、そのプロジェクトに残る最も古い配信の時刻
2. 件数: 「logged delivery rows」の表。event × outcome × main / subagent（最大 5 × 2 × 2）。event ごとに「emitted rows with no logged record key」の数と、「left out (sum of the counts each row logged; a session start also counts work items)」の合計。割合は出さない。subagent は `agent_id` があるか、session_start で reason が subagent の行。後者は「subagent, id unknown」と数え、それ以外の id の無い行は main に数える
3. 多く配信された記録: 期間内に配信されたセッションの数、次に配信の回数の順で最大 20 件。1 行に key（200 バイトで切る）、u<id>、kind、今の lifecycle、セッション数、配信回数、通ったイベント、「key named in a later captured reply in N of those sessions」
4. 例のセッション: 期間内に記録を配信した最も新しいセッション最大 5 件。各セッションの配信を時刻順に最大 15 件。1 行に時刻、event、main / subagent（agent id は 40 バイトで切る）、path（200 バイトで切る）、記録の key と u<id>（最大 8 件、超えたら「+N more」）、その配信の後に言及があった key の印
5. 限界（毎回出す）: 数えているのはログに残った行だけ、空の read / edit は残らない、ロック待ちと書き込み失敗の配信は残らない、90 日の保持はセッション単位、配信した文面は残らず key だけで記録は後で変わり得る、`suppressed` と `unavailable` は今は書かれない、id の無い行の main / subagent はホストが伝えたまま、言及は key をそのまま書いた場合だけで、書かずに使うこともあり、書いても役立ったとは限らず、capture の欠け・切り詰め・伏せ字があり得て、セッションのどのエージェントが書いたかは分からない
6. 締め: 頼る前に key で記録を読むこと、記録を変えるのは持ち主の言葉で /sphica:trace から

大きさ: 見出し・件数・限界・締めと、framed の枠と、各節の「N more not shown」の行のバイトを先に確保する。残りに、多く配信された記録の行、例のセッション、各セッションの配信の行の順で、行ごとに丸ごと入るときだけ足す。外から来る文字列（key、path、agent id）は `inline()` と `head()` を通す。

言及の判定:

- 候補の返信: 同じセッションの `source`（kind `session_message`、author_kind `assistant`、external_id が `*:ask:*:q:*` でない）、created_at が基準の時刻より後で期間の終わりより前（同じ時刻は後と言えないので数えない）、`instr(text, key) > 0`。`source_session (session_id, created_at)` の index を使い、セッションと時刻の順に取る
- TypeScript で、テキスト中の key の出現を全部見て、前の文字が文頭か `[A-Za-z0-9_./:-]` 以外、かつ後の文字が文末か同じ集合以外のものが 1 つあれば言及。候補を順に見て、見つかるか尽きるまで続ける
- 多く配信された記録: 表示する記録ごとに、期間内に配信された全セッションについて、そのセッションでの最初の配信の時刻を基準にする。例のセッション: 配信ごとにその時刻を基準にする。(記録, セッション) の組は重複させない
- u<id> と slug では照合しない（u35 が u350 に当たる）

MCP（`server/src/mcp.ts` の `overview`）:

- `view` の enum に `delivery`、引数に `days`（整数 1〜90、省略で 7）を足す。`days` を live / look と一緒に渡したら誤り、`after` を delivery と一緒に渡したら誤り。どちらも既存の after の誤りと同じ形で返す
- description に、配信のログを見せるビューで、ユーザーが Sphica が何を見せたかを聞いたときに使う、と足す

計測: `server/evals/scale/run.ts` に、bundle した `plugin/dist/mcp.js` を新しいプロセスで stdio の MCP クライアントから呼ぶケースを足す。生成した 90 日のログ（例: 500 セッション、delivery 20,000 行、assistant の返信 5,000 件、各数 KB）で、件数・多く配信された記録・例・候補の取得・境界の判定までの全経路を 5 回流し、最大が 1 秒以内。EXPLAIN QUERY PLAN をその実行で出して確かめる（テストでは見ない）。verify には入れない。

テスト `server/test/delivery-view.test.ts`（`temp-db.ts` の本物の SQLite）と、`server/test/overview.test.ts` と同じ形の stdio の MCP のテスト。`sql:reach` が新しい呼び出し箇所を全部通ること。

release: `bun run release:plan` で種別を確かめ（plugin）、パッケージの入力を変える最初のコミットで npm と 3 つの plugin manifest を同じバージョンに上げる。PR を作り、持ち主の試用を PR ブランチで行って結果を #258 に残し（文面は持ち主の承認の後）、採用なら Codex のレビューを経て tag で release、不採用なら PR を閉じる。これは実装の後の 12 段目で、完了条件 A5・A6 で確かめる。README.md:30 の overview の説明に delivery を足す。

同じ誤りを次に止めるもの: 返答の大きさと限界の行は、全節を長い多バイトの key と path で埋めたテストで、framed の後に `READ_BUDGET` 以内、限界と締めの行が残ることを見る。言及の境界はテストで見る。

## 採った案と棄却した案

- 採用: 既存の `overview` に view を足す。棄却: CLI のコマンド（CLI は 3 つだけ）、HTML やファイルの書き出し（no-progress-files）
- 採用: 上限付きの 1 ページ。棄却: カーソルでのページ送り（例を見るには不要で、カーソルの形式が増える）
- 採用: PR ブランチでの試用、フラグ無し、採用までは npm に出さない（持ち主の決定）。棄却: 既定 off のフラグ付きで出す（両ホストで MCP に env を渡す配線と確認が要り、不採用なら消すための release が要る）
- 採用: 「emitted rows with no logged record key」と「left out の合計」。棄却: 「省略の注記だけの行」「省略した記録の数」（作業項目や他の注記だけの行があり、session_start の omitted は作業項目も数える）
- 採用: session_start で reason が subagent の行も subagent に数える。棄却: `agent_id` の有無だけで分ける
- 採用: 言及は Stop の返信に限る（AskUserQuestion の質問を除く）、配信の後で期間の終わりの前、前後の境界付き。棄却: assistant の全メッセージ（質問の文が入る）、`instr()` だけ（前後に文字を足した別の key に当たる）、u<id> や slug での照合（誤検出）
- 採用: 先に固定の節のバイトを確保し、行ごとに入るだけ足す。棄却: 件数の上限（20 / 5 / 15 / 8）だけ（key 200 バイトで例の key だけで 120,000 バイトになり得る）

## 手順

- S1: `server/src/delivery-view.ts` の件数・多く配信された記録・例のセッション・限界と締め、バイトでの組み立て
- S2: 言及の判定（候補の取得と境界の判定）
- S3: `server/src/mcp.ts` の `overview` の view と `days`、引数の誤り、description
- S4: 規模の計測のケースを `server/evals/scale/run.ts` に足し、流す
- S5: README.md の overview の説明
- S6: npm と 3 つの plugin manifest を 0.6.40 に上げる。パッケージの入力を変える最初のコミットで（pre-commit の bundle の検査が同じコミットを求める）。上げても npm には出ず、出すのは採用の後の tag の release だけ

## 完了条件

- A1: `bun run verify` → 0 で終わる
- A2: `cd server && node --test --test-timeout=60000 test/delivery-view.test.ts` → 他のプロジェクトの行・期間の外の行が出ない、subagent の 2 つの判定、no logged record key の数、全節を埋めた返答が framed の後に `READ_BUDGET` 以内で限界と締めの行を含む、言及の境界（単独、バッククォート、前に足した key、後に足した key、最初の候補が不正で後の候補が正しい、配信より前の返信は数えない、AskUserQuestion の質問は数えない）が通る
- A3: `cd server && node --test --test-timeout=60000 --test-name-pattern=mcp test/delivery-view.test.ts` → `days` の省略・1・90 が通り、0・91・1.5・"7"・live や look との組み合わせ・delivery と after の組み合わせが誤りを返す
- A4: `node server/evals/scale/run.ts` → delivery のビューの行が 90 日のログで 5 回の最大 1,000 ms 以内、中身の確認が通る
- A5: `gh issue view 258 --comments` → 試用の結果（判定した例、時間、持ち主の判断）が、持ち主の承認した文面で載っている
- A6: 採用なら `npm view sphica version` → 上げたバージョン。不採用なら `gh pr view <PR> --json state` → CLOSED

## リスク

- 言及がほとんど 0 件になる（エージェントは key を書かずに記録を使う） → ラベルの限界として返答に書いてあるので、そのまま試用に出す。役に立たないと持ち主が判断したら、言及の節を外すかを試用の結果で決める
- 90 日のログで 1 秒を超える → EXPLAIN QUERY PLAN で原因を見て、問い合わせを直す。schema の index が要るなら、ここで止めて別の計画にする
- 試用で「レビューの手間に見合わない」となる → PR を閉じ、#258 に結果を残して不採用とする

## 未解決

なし

## 変更履歴

- 2026-10-07 / バージョンを上げるのを採用の後から最初のパッケージのコミットへ移し、試用・merge・release を手順から外して完了条件 A5・A6 だけで確かめる / pre-commit の bundle の検査がパッケージの入力を変えるコミットに同じコミットでのバージョンの更新を求め、試用と出荷はコードを変えるタスクにならないため / Go 不要（範囲・公開インターフェース・依存・データは変わらず、npm に出すのは採用の後のまま）
- 2026-10-07 / 言及の候補を「基準の時刻以上」から「基準の時刻より後」にした / Codex の全差分レビューで、同じ時刻の返信が「配信の後」の条件を満たさないと再現された / Go 不要（判定が厳しくなるだけで、範囲・公開インターフェース・データは変わらない）
