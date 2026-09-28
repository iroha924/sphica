---
kind: plan
status: approved
codex_session: 01a0e9ff-6932-7691-8c55-8500f1941e36
codex_rounds: 4
approved_at: 2026-09-29
---

# 検索と配信が、見ていないもの・省いたもの・trace 待ちを黙らずに伝える（W4 #189、W7 #190、W3 #191）

## 要点

- W4: 検索が FTS の上位 200 件で打ち切らず、候補を順に読み進める（記録は 2000 件まで、本文は 600 件か 64 MiB まで）。上限で止まったときは、結果の文で「ここまでしか見ていない」と言う
- W7: 自動の配信で件数や字数の上限から漏れた記録や作業があれば、何件あって、どこで見られるかを 1 行で添える。その行の字数は枠の外に足すので、今届いている記録は押し出さない。何も入りきらなかったときも、空にせずにその行を渡す
- W3: trace していないセッションがあれば、セッション開始時に件数と `/sphica:trace pending` を 1 行で知らせる。プロジェクトごとに 1 日 1 回まで
- 3 件を 1 つの PR、1 回のリリース（0.6.2）で出す
- 変えないもの: 検索の一致の判定（半分を超える語、アンカーの完全一致）、配信する記録の選び方と上限の件数、スキーマ（列と CHECK は同じ。`delivery.chars` に書く値の意味だけを決める）

## 持ち主の決定

- 選別の順序: W1 → W2 → W8 → W4 → W7 → W3 → C1a …（2026-09-28、u22）
- 1 issue = 1 PR は時間がかかるので、小さな issue はまとめる。W4・W7・W3 を 1 つの PR にする（2026-09-29）
- 各 issue の完了条件（issue 本文）: #189 は 200 件を超える弱い候補の後ろの強い一致が今のコードで見つからないテストが、直した後に通る。#190 は上限を超える記録で注記が文に出る。#191 は trace 待ちがあると行が出て、無いと出ない

## 目的

- 半分を超える語を持つ記録や本文が、FTS の順位によらず見つかる。見つからないときは、上限で止まったのか本当に無いのかが文から分かる
- 配信を受け取ったエージェントが、渡された記録が全部ではないことと、残りの見方を知る
- 持ち主が、trace を忘れているセッションがあることにセッション開始時に気づく

## 対象外

- 一致の判定規則と FTS のクエリの形。「半分を超える」を FTS のクエリで表すのは組み合わせが爆発し、別名とアンカーの規則も写す必要があるため採らない
- 配信の上限の件数と字数の見直し
- trace 待ちの通知をプロンプトごとに出すこと、status の表示の変更

## 前提

- 再現（2026-09-29、実 SQLite）: 4 語のうち 2 語だけを持つ短い本文 210 件と、3 語を持つ長い本文 1 件で `searchSources("retry budget cache warm")` → `hits: []`、`weaker: 200`
- `server/src/search.ts:10` の `POOL = 200`。`searchUnits` と `searchSources` は `orderBy rank limit POOL` の後に JS で一致を判定する（`search.ts:88, 242-264`）。記録の結果は lifecycle → 一致した語の数 → rank の順に並べ直す（`search.ts:192-198`）
- 実測（2026-09-29、この Mac）: `terms()` は 128 KiB で 5.2 ms、1 MiB で 48.5 ms。128 KiB の本文 200 件の `searchSources` は 1213 ms。glean の抜粋は最大 1 MiB（`server/src/glean.ts:15`）、capture の発言は最大 128 KiB（`server/src/capture.ts` の `fit`）
- MCP の検索の文は `server/src/mcp.ts:133-169` で「No ... holds most of ... N weaker matches left out.」と言い切る
- 配信: `server/src/deliver.ts` の `LIMITS` と `fit()`（127-151）。`omitted` はログ（`capture_delivery.omitted`）にだけ入る。何も入らないと文は空で、`outcome` は `nothing`
- `atStart()` は作業（3 件）と広い制約（3 件）を SQL で切ってから `fit` するので、その先の件数を数えていない（`deliver.ts:384-430`）。status が出す作業は更新が新しい 5 件まで（`server/src/status.ts:91-99`）
- 読み取りの予算は、その session の emitted な `pre_read` の `chars - ASK` の合計（`deliver.ts:224-249`）。`delivery.chars` を読むのは他に評価の `deliveries.json` だけ（`server/evals/cloud/build.ts:156`）
- trace 待ちの数え方は `status.ts` の `coverage()`（47-72）。`trace.ts` の `pendingSessions()` は一覧で 20 件まで
- `markOnce()` はユーザーごとの一時ディレクトリに印を置き、書けなければ表示する側に倒す（`deliver.ts:489-509`）
- acceptance のドライバーは `searchUnits` と `deliver` を直接呼ぶ（`server/evals/acceptance/driver.ts:143-184`）。MCP の文はそこを通らない

## 方針

### W4（`server/src/search.ts`、`server/src/mcp.ts`）

- 候補を `(rank, rowid)` の順でページごとに読む。記録は 1 ページ 200 件、本文は 1 ページ 50 件。各ページは 1 件多く頼み、その 1 件は「先に候補があるか」を見るだけで数えない
- 上限: `UNIT_SCAN_MAX = 2000` 件。本文は `SOURCE_SCAN_MAX = 600` 件か、読んだ本文が `SOURCE_SCAN_BYTES = 64 MiB`（UTF-8 のバイト数）に届くまで。上限は候補 1 件ごとに次を読む前に確かめる（上限を越えて読むのは最大 1 件、1 MiB・約 50 ms）
- `searchSources` は結果が rank 順なので、`limit` 件そろったら止める。`searchUnits` は並べ直すので、上限まで読んでから並べる。オプション・アンカー・別名の取得はページごと
- 返り値に `stopped: boolean` を足す。まだ見ていない候補が残っているときだけ true
- MCP の文: 止まって何も無いときは「No record among the first 2000 candidates by rank holds most of: …. Search with more specific words.」（本文は「No source among the first 600 candidates …」、バイトで止まったときも件数を書く）。結果があって止まったときは最後に「Stopped after N candidates by rank; more may match.」の 1 行
- `weaker` は実際に読んだ弱い候補の数のまま

### W7（`server/src/deliver.ts`）

- 各配信（session_start、pre_edit、pre_read、prompt、review）で、省いた記録があれば 1 行足す: `- N more record(s) apply here but were left out for space: find them with Sphica's search or read.`
- session_start の作業の省略は別の行: `- N more work item(s) not shown: Sphica's status lists the 5 most recently updated.`
- 注記の字数は、ASK と同じように各イベントの上限に足す（最も長い形で確保する）。session_start は記録の注記・作業の注記・trace 待ちの行（W3）の 3 つを別々に確保する。今届いている記録は 1 件も押し出さない
- 何も入らなかったが対象はあったときは、空にせず lead と注記を渡す（`outcome` は `emitted`）
- `atStart()` は作業（active・blocked・paused）と広い制約の全件数を count で数え、`omitted` をそれぞれ（全件 − 表示）で出す
- `Plan` に `note` を足す。ログの `delivery.chars` は「配信した長さから省略の注記（直前の改行を含む）を除いたもの」と決め、`text.length - note.length` を書く。`db/schema.sql` の列の横と書き込み箇所にコメントで書く（列と CHECK は変えないので schema の revision は上げない）。注記の無い古い行はこの定義でも同じ値
- 読み取りの予算は、emitted な `pre_read` のうち `delivery_unit` が 1 行以上ある配信（EXISTS）の `chars - ASK` だけを足す。注記だけの配信は予算を使わず、記録を複数渡した配信も 1 回だけ数える

### W3（`server/src/deliver.ts`、`server/src/status.ts`）

- trace 待ちの数え方を 1 つの関数にして export し、`status.ts` の `coverage()` と `atStart()` の両方が使う（2 か所でずれないように）
- 1 件以上なら session_start に 1 行: `- N session(s) waiting to be traced: run /sphica:trace pending.`（一覧の 20 件の上限ではなく件数そのもの）
- 作業も制約も無く trace 待ちだけでも、lead とこの行を渡す
- 出すのは 1 日 1 回: `markOnce("pending", <DB ファイルの絶対パス, project key, UTC の日付>)`。DB のパスを入れるのは、同じ project key の別のテスト用 DB どうしで印を取り合わないため。書けなければ表示する（今の `markOnce` と同じ向き）

### テスト（実 SQLite）

- W4: 上の再現を本文と記録の両方で（弱い候補 200 件超の後ろの強い一致）。上限で `stopped` が true、上限の手前で候補が尽きたら false。本文のバイトの上限。MCP の文は `server/test/plugin.test.ts` の実際の MCP クライアントで確かめる。acceptance case を 1 つ（ドライバーの `searchUnits` 経由）
- W7: 各イベントで上限を超える記録を置くと注記が出る。何も入らないと lead と注記。注記を足しても、足す前に届いていた記録はそのまま（既存の `deliver.test.ts:686-723` と同じ考え）。注記だけの読み取りは予算を使わない（ログの `chars` と、その後の読み取りで届く記録で確かめる）。`deliver.test.ts:258-265` は記録を渡した配信だけを数えるように直す。acceptance case を 1 つ（ドライバーの `deliver` 経由）
- W3: trace 待ちがあると行が出る、無いと出ない、trace 待ちだけでも出る、25 件なら 25 と出る、同じ日の 2 回目は出ない

### 出荷

パッケージに入る変更なので、バージョンを編集する前に `bun run release:plan -- --base 4567a93` を流し、`plugin` なら npm と 3 つの plugin manifest を 0.6.2 にそろえる。pre-commit のフックが、パッケージに入るファイルの変更と同じコミットでのバージョン上げを求めるので、最初の実装のコミットに入れる。

## 採った案と棄却した案

- 採用: 候補をページで読み進め、上限で止まったら言う。棄却: `POOL` を大きくする（黙った上限が残る）/ 「半分を超える」を FTS のクエリで表す（組み合わせの爆発、別名とアンカーの規則を写す必要）
- 採用: 本文は 600 件か 64 MiB、1 ページ 50 件で、上限は 1 件ごとに確かめる。棄却: 本文も 2000 件（最悪 12 秒）/ ページごとに確かめる（1 ページで最悪 200 MiB）
- 採用: 注記の字数を上限に足す。棄却: 今の上限から差し引く（今届いている記録を押し出す）
- 採用: 作業の省略と記録の省略で文を分ける。棄却: どちらも search か read で見られると書く（作業は search で見つからない）
- 採用: `delivery.chars` から注記を除き、予算は記録を渡した配信だけで数える。棄却: 注記の字数も予算に数える（注記が後の記録を押し出す）/ 課金用の列を足す（schema の revision が上がる）
- 採用: trace 待ちの通知は 1 日 1 回。棄却: 件数が変わったときだけ（前のセッション自身が trace 待ちになるので、ほぼ毎回変わる）/ 毎回

## 手順

- S1: 検索を候補のページ読みにし、上限と `stopped` を足す（W4）
- S2: MCP の検索の文で止まったことを言う（W4）
- S3: 配信に省略の注記を足し、字数を枠の外に確保し、何も入らないときも注記を渡す。session_start の省略を数える（W7）
- S4: `delivery.chars` から注記を除き、読み取りの予算を記録を渡した配信だけで数える（W7）
- S5: trace 待ちの数え方を共通にし、session_start で 1 日 1 回知らせる（W3）
- S6: acceptance case を足す
- S7: `release:plan` に従ってバージョンを 0.6.2 に上げる

## 完了条件

- A1: `cd server && node --test --test-timeout=60000 test/search.test.ts test/deliver.test.ts test/plugin.test.ts` → 全部 pass（W4・W7・W3 の追加テストを含む）
- A2: `git stash push server/src && (cd server && node --test --test-timeout=60000 test/search.test.ts test/deliver.test.ts); git stash pop` → 追加したテストが意図した理由で落ちる（強い一致が見つからない、注記が無い、trace 待ちの行が無い）
- A3: `bun run verify` → 0 で終わる（`sql:reach`、acceptance を含む）
- A4: `bun run release:plan -- --base 4567a93` → `plugin`。npm と 3 つの plugin manifest が 0.6.2
- A5: `gh pr checks <PR 番号> --watch` → 全項目 pass

## リスク

- 本文の検索が最悪 3 秒ほどかかる（全部が大きな抜粋で、強い一致が無いとき）→ 上限は定数なので、遅いと分かったら縮める
- 注記を足した分、配信の文が長くなる → 注記は 1〜3 行で、記録の枠は変えない
- 一時ディレクトリの印が消えると、同じ日に 2 回出る → 出すほうに倒すのが今の `markOnce` の方針

## 未解決

なし

## 変更履歴
