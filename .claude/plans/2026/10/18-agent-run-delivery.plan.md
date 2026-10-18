---
kind: plan
status: approved
codex_session: 01a14d05-3fc5-7143-b5c8-c44453599747
codex_rounds: 4
approved_at: 2026-10-18
---

# エージェントが起動した実行と、サブエージェント・子スレッドの起動への自動配信を減らす（#353）

## 要点

- 別のエージェントがシェルから起動した非対話の実行（Claude Code の Bash からの `codex exec` / `claude -p`、Codex のシェルからの Codex）には、セッション開始と通常の読み取り配信を出さない。開始は outcome `suppressed` の行だけ書く
- サブエージェントと Codex の子スレッドの起動では、work と constraints を出さず検索の 1 行（SEARCH_FIRST）だけにする
- 判定は呼び出しごとに、親の印の不一致と、非対話を肯定的に確かめた条件の両方で行う。対話と確かめられないものは今どおり配信する
- 塊ごとの採否は、固定した #346 標本で代理の条件で数え、既知の useful が 0 かつ irrelevant が 5 件以上なら採用する。実機で親の印とログのパスの有無を確かめてから出す
- 変えないもの: 持ち主の対話セッションへの配信、編集の前の配信、review の配信と review_select / review_check、#218 のコマンド停止とその context、サブエージェントの読み・編集の配信、評価ループ（親の印を渡さない）、schema

## 持ち主の決定

- #353 を進める（2026-10-18）
- Claude Code と Codex は各ホストが許す範囲で同じ機能を持つ。レビューは今までどおり記録を受け取り、変えるのは自動配信だけ。持ち主の対話セッションは今と同じものを受け取る（#353 の Invariants）
- 計測はマージ前に #346 の固定標本で数え、基準は数える前に計画で固定する。変更の後に新しい期間で `sample.ts` を使ってもう一度測る（#353 の Experiment）
- ログのパスを渡さない Codex の実行（`--ephemeral`）も、親の印の不一致があれば止める。親の環境を引き継いだ常駐サーバー経由の対話セッションでパスの取得がエラーになると配信が落ちる経路は受け入れる（Codex との議論の後に持ち主が追加。2026-10-18、Codex の推奨はこれを外す案だった）

## 目的

- 持ち主のレビュー用の `codex exec`（ログあり・ephemeral）と `claude -p` に、セッション開始の constraints と読むファイルごとの記録が届かない
- サブエージェントと Codex の子スレッドの起動時に、work と constraints が届かず検索の 1 行だけが届く
- 持ち主の対話セッション（両ホスト）と評価ループの inject スロットには、今と同じ配信が届く

## 対象外

- 対話の判定を `originator` や `CLAUDE_CODE_ENTRYPOINT` だけで行うこと（評価ループと手で走らせる実行を落とす）
- サブエージェントの読み・編集の配信を減らすこと（標本で pre_read が useful 4/12）
- 抑制した読み取りを delivery の行に残すこと（最も多い呼び出しで、行ごとに書き込みのロックを取る）
- 親の印が無いまま起動された非対話の実行（持ち主が手で走らせた `codex exec`、`cli` を継承した SDK 実行）。今どおり配信し、リリース後の計測で取りこぼしとして数える
- 新しい期間の標本の結果で採否をやり直すこと。採否はマージ前の標本で決め、新しい期間は記録として残す

## 前提

- #346 標本 80 件を Codex のセッションログ（`~/.codex/sessions` と `archived_sessions`、ファイル名の末尾が `session.external_id`）の 1 行目で分けた代理の内訳（2026-10-18 に Claude が sqlite3 -readonly と python で手で集計。T05 で再現できる形にする）:
  - Codex の originator `codex_exec` または ログ無しの session_start と pre_read: 39 件、useful 0 / irrelevant 17 / unknown 22
  - Claude Code のサブエージェントの session_start: 7 件、useful 0 / irrelevant 5 / unknown 2
  - Codex の `codex-tui` の session_start 1 件（irrelevant）と、`codex_exec` の review 2 件（useful 1）は外さない
- 母集団 3,093 件のうち Codex の `codex_exec` が 806 件、ログ無しが 719 件、`codex-tui` が 13 件。Claude Code はすべて entrypoint `cli`。母集団の Codex セッション 169 件のうち、ログのある `codex_exec` 75 件とログ無し 91 件は capture されていない。所有者の判定（親の印など）で除外された可能性があるが、env はログに無く、どの照合で落ちたかは未確認
- 親の印: Claude Code の SessionStart が `SPHICA_PARENT_SESSION` を CLAUDE_ENV_FILE に書く（`server/src/capture.ts:555`）。Codex のシェルから起動した Codex は親の `CODEX_THREAD_ID` を受け継ぐ（`capture.ts:17`）。`codex exec` のフックは起動元の環境を見る（`README.md:142`）。フックまで届くことは実機で未確認（T06 で確かめる）
- Codex のフック入力の `transcript_path` は `hook_transcript_path()` が返し、ライブスレッドかローカルの rollout が無いとき、または取得がエラーのときだけ None（openai/codex main 8c076942cb70、2026-10-18 取得、`codex-rs/core/src/session/mod.rs:5364-5383`）。入力スキーマでも NullableString
- `codexInteractive`（`server/src/deliver.ts:862`）はログの 1 行目が自スレッドで originator `codex-tui` のときだけ真。Codex Desktop などは偽（`server/test/deliver.test.ts:2389-2400`）
- delivery の outcome の CHECK は `suppressed` を許すが、今は書かれていない（`db/schema.sql:1217`、`server/src/delivery-view.ts:49`）。`sinceRestart`（`deliver.ts:371`）は outcome を見ずに compact / clear の開始行を境界にし、resume の判定（`deliver.ts:1343`）は emitted だけを見る。`sample.ts:40` は emitted と delivery_unit の結合だけを抽出する
- 評価ループの Codex（`server/evals/cloud/codex-run.ts:427`）と Claude（`claude-run.ts` の RUN_ENV）は親の印を渡さない。`scripts/lib/live-harness.mjs:75,79` と `server/evals/acceptance/driver.ts:86` も両方の印を外す
- SubagentStart で開始の一式と検索の 1 行を出すのは 0.6.17 の実装（Sphica u139）。これを禁じる決定の記録は無い

## 方針

「エージェントが起動した実行」の判定（呼び出しごと、両方を満たすとき）:
- 親の印の不一致: `SPHICA_PARENT_SESSION` が在ってフック入力の session_id と違う、または（Codex のとき）`CODEX_THREAD_ID` が在ってフック入力の session_id と違う。capture の `isOwnerTurn` からこの照合だけを関数に切り出し、capture と deliver の両方から使う。isOwnerTurn 全体（agent_id、sdk-）は流用しない
- 非対話の肯定的な確認:
  - Codex: (a) ログの 1 行目が自スレッド（`ownThread`）で originator `codex_exec`、または (b) フック入力の `transcript_path` が文字列でない。パスがあって読めない・形が違う・別の originator は対話扱い
  - Claude Code: `CLAUDE_CODE_ENTRYPOINT` が `sdk-` で始まる

呼び出しごとの扱い:

| 呼び出し | 起動時 | 通常の読み取り | 編集 | review | コマンド停止と context |
|---|---|---|---|---|---|
| 対話の本体（両ホスト）、判定を満たさない実行 | 今どおり | 今どおり | 今どおり | 今どおり | 今どおり |
| Claude の SubagentStart（agent_id 付き） | SEARCH_FIRST だけ、reason `subagent` の emitted 行 | 今どおり | 今どおり | 今どおり | 今どおり |
| Codex のログで確かめた子スレッドの SessionStart | SEARCH_FIRST だけ、reason は今どおり | 今どおり | 今どおり | 今どおり | 今どおり |
| エージェントが起動した実行（その中のサブエージェント・子スレッドも、判定を満たせば同じ） | 出力無し・unit 無しで outcome `suppressed`、reason は開始の種類のまま | 出力も行も無し | 今どおり | 今どおり | 今どおり |

- 「通常の読み取り」は Read と、シェルが名指ししたパスの `beforeRead`。`beforeCommand` の停止と、停止できないときに返すコマンドの記録の context は残す（#218 は 2026-10-29 ごろまで持ち主の実利用で停止を数えていて、条件を途中で変えないため）。イベント全体の早期 return は使わない
- 子への継承はしない。判定は呼び出しごとに環境とその呼び出しのログで行う。ログ付きの Codex 子スレッドは (a) を満たさない（threadSource が subagent）ので SEARCH_FIRST だけを受け取る
- writer（`deliver.ts` の `write`）は outcome を引数で受け取る。delivery-view の「suppressed は書かれない」の文言を直し、suppressed の行を表に出す
- README の配信の節に、エージェントが起動した実行とサブエージェント・子スレッドの起動に何が届かないか、ホストごとの判定（Codex はログか ephemeral、Claude Code は sdk-）と、常駐サーバー経由の例外を書く
- パッケージに入る変更なので、`release:plan` の結果に従い npm と 3 つのプラグインマニフェストを同じバージョンに上げる（最初のパッケージ入力のコミットで上げる）

計測（集計の後に基準を変えない。#353 に内訳が出た後の探索的な判断であることを明記する）:
- マージ前: `server/evals/delivery/` に、固定標本の各ペアへ代理の分類（Codex の `codex_exec` / ログ無し / `codex-tui`、Claude のサブエージェント起動、本体）と、塊（実行の抑制 / 起動の縮小）ごとの外れる判定を付けて書き出すスクリプトと結果の JSON を足す。コマンド停止の行（reason `command` / `command_context`）は外れる側に数えない。代理の条件は実装の条件と同じではない（env はログに無い）と JSON に書く
- 基準（塊ごと）: 外れるペアの既知の useful が 0 かつ irrelevant が 5 件以上で採用、useful が 1 件以上で不採用（その塊を最終の差分から外す）、それ以外は採否保留で持ち主に聞く。unknown は損失に数えず件数を報告し、「既知の useful が 0」であって「損失 0」ではないと書く
- リリース後（この PR の完了条件の外、#353 に残す）: 公開日の翌日 0 時（UTC）から 7 日。(a) 抑制を記録できたセッション数（本体の suppressed の開始行を持つセッション、ホスト別。実行の総数ではない）、10 件未満なら未確認。(b) 判定漏れ: emitted の開始か通常の読み取りの行を持つ `codex_exec` / ログ無しの Codex セッションのうち、親の呼び出し（Claude Code のトランスクリプトの Bash、Codex のセッションログの shell）と時刻・cwd・プロンプトで具体的に対応できたもの。対応できないものは不明。(c) 本体の対話セッション 1 件あたりの emitted ペア数（分母は owner の発言を capture したセッション、配信 0 件も含む）を #346 の期間と同じ式で並べる。(d) `sample.ts` で新しい期間を固定し、80 件を #346 と同じ方法でラベルして受け手ごとに出す

## 採った案と棄却した案

- 採用: 親の印の不一致 AND 非対話の肯定的な確認。棄却: 親の印だけ（常駐サーバー経由の対話を落とす）、originator / entrypoint だけ（評価ループの inject と手で走らせる実行を落とす）、対話と確かめられないものを止める（パスが読めない TUI や別クライアントを落とす）
- 採用: ephemeral（パス無し）も止める（持ち主の判断）。棄却: ログで確かめた `codex_exec` だけ（Codex の配信の約半分の ephemeral のレビューが手つかず）
- 採用: 読み取りの記録の配信だけ止め、コマンド停止と編集の前は残す。棄却: 自動配信をすべて止める（#218 の計測条件が変わり、編集の前の制約も落ちる）
- 採用: 抑制した開始を `suppressed` の行で残す。棄却: 行を書かない（compact / clear の境界が消え、停止の数え方が変わる）
- 採用: サブエージェント・子スレッドの起動だけを縮める。棄却: サブエージェントへの配信をすべて止める（読みで useful 4/12）
- 採用: 判定は呼び出しごとに独立。棄却: 親の抑制を子へ継承する（ログ付きの子スレッドは親の状態を知る手段が無い）
- 棄却: Codex は pre_read を残し session_start だけ外す（外れるのは 39 件中 7 件）

## 手順

- S1: 親の印の照合を capture から切り出し、deliver に「エージェントが起動した実行」の判定を足す（両ホスト）
- S2: 判定を満たす実行で、開始を suppressed の行にし、通常の読み取り配信を止める。コマンド停止と編集・review は残す。writer に outcome を渡す
- S3: サブエージェントと Codex の子スレッドの起動を SEARCH_FIRST だけにする
- S4: delivery-view の suppressed の扱いと文言、README の配信の節、バージョンを揃える
- S5: 固定標本の代理の内訳を出すスクリプトと結果の JSON を足し、基準で塊ごとの採否を決める（実装より前に流す。不採用の塊は実装しない）

## 完了条件

- A1: `bun run verify` → 0 で終わる
- A2: `cd server && node --test test/deliver.test.ts` → 両ホストの 親の印なし / 一致 / 不一致 × Read・シェルの読み・シェルの停止・編集・review、Codex のログ無し・`codex_exec`・`codex-tui` で印が不一致・子スレッド、Claude の `sdk-cli` と `cli`、停止 → compact → 同じコマンド、suppressed の行が unit 無しで sample.ts の抽出と delivery-view の keyless に入らない、の各ケースが通る
- A3: `node server/evals/delivery/agent-runs.ts --check` → 結果の JSON と同じ件数が出て 0 で終わり、塊ごとの判定が基準どおり（叩き台の手集計では、実行の抑制 39 件 useful 0 / irrelevant 17、起動の縮小 7 件 useful 0 / irrelevant 5）
- A4: `sqlite3 -readonly <使い捨ての DB> "select s.host, s.external_id, d.agent_id, d.event, d.outcome, d.reason from delivery d join session s on s.id = d.session_id order by d.id"` → 使い捨ての HOME / CODEX_HOME で、Claude Code の Bash から `codex exec`（ログあり）・`codex exec --ephemeral`・`claude -p` を、Codex のシェルから `codex exec` を走らせた後、それぞれの子のセッションで開始が outcome suppressed の行だけ、読み取りの emitted 行が無く、編集の前は emitted。フックの入力を控える一時の hook で、非 ephemeral の exec と TUI が transcript_path を渡し、ephemeral の exec が渡さず、子のフックに親の印が届くことも確かめる。コマンドと観測を PR 本文に残す
- A5: `sqlite3 -readonly <使い捨ての DB> "<A4 と同じ select>"` → 同じ環境で持ち主の対話セッション（Claude Code の端末、Codex の TUI）を開いた後、開始と読み取りの行が main の deliver.js で同じ操作をしたときと同じ件数・同じ outcome・同じ記録
- A6: `npm pack` を外に展開し、`grep -c suppressed package/plugin/dist/deliver.js` → 1 以上。`node -e` で package.json と 3 つのマニフェストの version を出す → すべて同じ
- A7: `gh issue view 353 --comments` → 塊ごとの useful / irrelevant / unknown と採否のコメントがある（文面は持ち主の承認を受けてから投稿）

## リスク

- `codex exec --ephemeral` のフックに親の印かパス無しが届かない版の Codex → A4 で分かる。届かなければ (b) を外し、ephemeral を未解決として #353 に残してから Go を取り直す
- 常駐サーバー経由の対話セッションでパスの取得がエラーになると配信が落ちる → 持ち主が受け入れた。README に書く
- `cli` を継承した SDK 実行や、親の印を持たない非対話の実行は配信され続ける → リリース後の (b) で数える
- サブエージェントの起動から constraints を外したことで、constraints を読まずに進むサブエージェントが出る → 標本では useful 0。新しい期間の (d) で見る

## 未解決

なし

## 変更履歴
