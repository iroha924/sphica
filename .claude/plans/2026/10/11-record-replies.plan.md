---
kind: plan
status: approved
codex_session: 01a12ad8-db76-7f23-8629-ab25c09d2956
codex_rounds: 3
approved_at: 2026-10-11
---

# record サーバーの返答を、状態と持ち主の確認を失わずに 32 KiB に収める（#324）

## 要点

- record サーバーの 6 つのツール（`record_context`・`record_check`・`record_save`・`glean_fetch`・`forget_preview`・`forget_apply`）と、SDK が作るエラーの返答を、UTF-8 で 32,768 バイト以内にする。何を保存するか・断るかは、返答をどこまで見せたかで変わらない
- `record_context` は、ページを「できあがった返答のバイト数」で切る（今は UTF-16 で 20,000 文字、日本語だと約 60 KB）。最後の部分（編集・フィールド・有効な記録）が収まらないときは、その run に渡したカーソルで続きを読む
- `record_check`・`record_save`・`glean_fetch`・`forget_preview`・`forget_apply` は、結論と件数を先頭に出し、収まらない行は新しい読み取り専用ツール `record_more` で読む。続きを読むために、検査・保存・取得・削除をやり直さない
- forget の確認ダイアログは、消す source 全部・打つ件数・注意書きを必ず出す。影響を受ける記録は 4 種類の件数と、収まるだけの行
- 受信バッファが 10 MiB を超えてサーバーが黙って終わる件は、stderr の 1 行と終了コード 1 で終わるようにする（両サーバー）
- 自動の trace が 1 回に読むのは今と同じ 2 ページ。日本語のセッションでは 1 ページが小さくなるので、1 回に読む量は減る
- 1 つの PR、リリース 0.6.50。完了の確認に、確認ダイアログを持ち主に 1 回見てもらう手順が入る

## 持ち主の決定

- issue #324 の「What a fix must keep」と「Requirements carried over from the plan discussion」を満たす
- `record_context` のページ上限を超えて先頭だけ見せた 1 件の発言は、続きを read で読んだか確かめられなくても見た扱いにする（Sphica の記録 `trace:a2bb452f-9ad3-4652-bda5-6223fc6d665e/cut-message-counts-looked`）
- forget は、持ち主がホストの確認で件数を打ってからだけ消す（CLAUDE.md `record-writes`）
- 利用者に API キーや追加の課金を求めない。CLI は init・doctor・uninstall だけ
- 小さい関連の issue は 1 つの計画・PR・リリースにまとめる。#324 のコメントにある、10 MiB を超える要求でサーバーが返答なしに終わる件もこの計画で扱う

## 目的

- record サーバーのどの返答も 32,768 バイト以内（MCP 経由のテストで、ページごとに測る）
- 収まらなかった分は、返答が名指しする手段で全部読める。読むことで書き込みは増えない
- trace・harvest・glean・forget の Skill が、新しいカーソルと案内に沿って最後まで進める

## 対象外

- 読み取りサーバーの返答（0.6.49 で済み）。`fields` ツールがセルを 200 文字で切るのもそのまま
- `trace_pending`・`trace_begin`・`harvest_begin`・`glean_begin` の返答と、`tool()` が作る通常のエラー（Codex が最大側を組んで 17,080 バイトと 2,008 バイトで、予算内と確認）
- DB の schema の変更（結果のページは record サーバーのプロセスのメモリに持つ）
- 自動の trace が読むページ数（`AUTO_PAGES`）の変更

## 前提

- `server/src/extract.ts:60` `PAGE_CHARS = 20_000`（UTF-16）。`contextText`（388 行〜）は `used + text.length > PAGE_CHARS` でページを切る
- `server/src/extract.ts:67` `shownTo`: run ごとに、見せた source の id・渡したカーソル（`s<id>` → ページ番号）・auto かどうかを、プロセスのメモリに持つ。`SHOWN_RUNS = 100` を超えると古い run から忘れる。保存が commit したら消す
- `server/src/extract.ts:469-480`: 最後の部分は `PAGE_CHARS - 200` を超えると「and N more lines left out…」で切る。続きを読む手段は無い
- `server/src/extract.ts:482-489` `entry`: 長い発言は UTF-16 で切り、案内の `s<id>@<byte>` は残した本文の UTF-8 のバイト数（保存された本文の先頭からの位置）。`framed` は本文を `plain` に通すので、表示用に整えた後の長さを位置に使ってはいけない（`server/src/frame.ts:9`）
- `server/src/extract.ts:368`・`:372`・`:316`: 見出しに session の external_id（2 回）、turn、artifact、login、path が切らずに入る。Codex の実測（DB の応答をメモリで代用）で、external_id が 40,000 文字のとき枠込み 80,434 バイト
- `server/src/extract.ts:515`・`:523`: auto のページ数は対象の発言を含むページだけ数え、見た扱いに足すのは文脈でない id だけ
- `server/src/trace.ts:229`・`:237` `liveUnits`: 既定で最大 40 件。`sessionEdits`（`:219`）とフィールドの取得（`extract.ts:438`）には件数の上限が無い
- `server/src/extract.ts:684-768` `checkText`・`saveText`: 結果・警告・エラーの行を全部つないで返す。check は要約が最後、save は最後が「✓ saved」。save が検証で断るときは `throw new Error("The record is not valid:\n…")`、保存の途中で断るときは `SaveRefused`（`server/src/record.ts:866`、その前の `:852` で書き込みが走っている）。`server/src/db.ts:60` の `inTransaction` は、コールバックが正常に返ると commit する
- `server/src/mcp-record.ts:82` `tool()`: エラーを `head(reason(e), 2000)`（2,000 バイト）で切る
- Codex の実測: `checkRecord` に 40,000 文字の未知のキーを渡すと、エラー 1 行が 40,028 バイト。実際の record サーバーのプロセスで、40,000 文字の未知のツール名のエラーが 40,033 バイト、未知のプロパティが 40,102 バイト
- `server/src/extract.ts:243-273` `gleanFetch`: 1 つのトランザクションで保存し、保存した source を全部 1 行ずつ返す
- `server/src/forget.ts:286-322` `forgetText`: `forget_preview`・確認ダイアログの本文・`forget_apply` の結果の 3 か所で使う。`:211` は置き換え先など間接の状態の変化も足す（candidate → active になる記録がある。`server/test/forget.test.ts:248`）
- `server/src/mcp-record.ts:267-345`: `SOURCES` は 1〜50 件。`forget_apply` は `previewForget` の結果と `applyForget` の中の結果を `JSON.stringify` で比べ、違えば何も消さない（`forget.ts:257`）。Codex の実測で、50 件・artifact が日本語 120 文字のとき、必ず出す部分は 19,975 バイト
- `server/src/mcp.ts` の `withinBudget`、`server/src/read.ts` の `READ_BUDGET`・`fitCount`・`preview`・`keyShown`（0.6.49）。`fitCount` は「0 件の返答は呼び出し側が収める」前提（`read.ts:486`）
- SDK 1.31.0 の `StdioServerTransport`: 受信バッファ全体が 10 MiB を超えると `ReadBuffer` が `ReadBuffer exceeded maximum size…` を投げ、transport が自分で `close()` する。上限は 1 行の長さではなくバッファ全体（6 MiB の行 2 つを 1 つの chunk で送っても超える）。不正な JSON は `onerror` だけで close しない（`node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js:19`・`:49`、`shared/stdio.js:10`）。Codex が実際の record サーバーで、終了コード 0・stdout 0 バイト・stderr 空を再現
- `plugin/skills/{trace,harvest,glean}/SKILL.md` は「`call record_context with after: "s<N>"`」と、有効な記録のある最後のページを前提にした文を持つ。4 つの Skill の allowed-tools に `record_more` は無い
- 未検証: Claude Code の確認ダイアログ（elicitation）が、長い本文をどこまで表示するか。32 KiB にした後の自動の trace の消化の速さ。結果の置き場と末尾の写しの実際のメモリ使用量

## 方針

### 共通

- 予算は読み取りサーバーと同じ 32,768 バイト。`READ_BUDGET`・`fitCount`・`preview`・`keyShown`・エラーを切る `withinBudget` を、両サーバーが使う module `server/src/reply-budget.ts` に移す（`read.ts` から再 export しない。参照を全部直す）
- 行の規則: 行は、残りへたどる手段なしに切らない
  - 外から来た文字列（記録のキー、artifact、login、path、エラーに入る入力の一部）は、行を作る時点で個別に `preview` で短くする。エラーの位置と理由は残す
  - 記録のキーは `keyShown`（切ったら `[key cut: read u<id>]`）
  - それでも 1 行がページの空きより長いときは、UTF-8 の境目で分割して続きの行にする。どのページも必ず 1 行以上進む
- `mcp-record.ts` の transport の `send` を `withinBudget` で包む

### 結果の置き場と record_more

- 置き場（record サーバーのプロセスのメモリ）: `{ kind: "check" | "save" | "fetch" | "forget_preview" | "forget_apply", projectId, run: string | null, lines: string[] }`。行は登録するときに分割まで済ませて固定する
- 枠は 2 つ、それぞれ新しい結果 20 件まで: やり直せる結果（check・forget_preview・断られた save）と、commit 済みの結果（保存できた save・fetch・forget_apply）。20 は保持を保証する数ではない
- カーソルは `<結果ごとの乱数>.<行位置>`（行位置は分割後の配列の位置）
- `record_more { cursor, cwd }`（新しいツール、読み取り専用）: 置き場の行を予算に収まるページで返す。同じカーソルは同じページを返す。結果の project が cwd の project と違えば断る。保存済みの run でも読める（`bound` を通さない）。プロセスの再起動や押し出しの後は「この結果はもう残っていない」と返し、kind ごとに次の手を 1 行で言う（check・forget_preview・断られた save はやり直す、保存できた save・fetch・forget_apply は書き込みが済んでいるのでやり直さず `read` や `search` で確かめる）
- 収まらなかった返答の最後は「N more lines: call record_more with cursor: "<cursor>"」

### record_context

- ページは「できあがった返答（枠込み）の UTF-8 のバイト数 ≤ 32,768」で切る。部品を足すたびに測る
- 見出しに入る外から来た文字列（session の external_id、turn、artifact、login、association、path）は個別に `preview` で制限する。source の id と続きの参照は切らない。run の先頭の行の external_id は 200 バイトまで（キーの接頭辞は保存時にサーバーが付けるので、エージェントが組み立てる必要は無い）
- 1 件の発言が 1 ページに収まらないときは、UTF-8 の文字の境目で切る。枠・見出し・案内（次のページ、切った位置）の分を先に引く。案内の `s<id>@<byte>` は保存された本文のバイト位置。切った発言は見た扱い
- 文脈の発言（auto の先頭の 6 件）は 1 件 3,000 バイトまで
- 見た扱いに足す id は、できあがった返答に載せた対象の id だけ。足すのは返答を組み終えた後
- 最後の部分（編集・フィールド・有効な記録）
  - 最後の source のページに収まれば一緒に載せる。収まらなければ続きのページへ
  - 行の一覧は、その run で最初に最後の部分を作ったときに写しを固定し、`shownTo` に持つ（run 100 件まで、追加の上限は置かない）
  - カーソルは `t<run ごとの乱数 8 桁の hex>.<行位置>`。乱数が保持中の別の run と重なったら引き直す。その run が発行した集合に無ければ断る。同じカーソルは同じページを返す
  - `t` の読み取りは、run と発行済みを確かめた後、固定済みの写しから返す。未処理の発言の再検索を通らない。見た扱いの集合と auto のページ数は変えない
  - 有効な記録の行は `keyShown` を使い、切ったキーは supersedes・conflicts に使えない（`read u<id>` で完全なキーを取る）と 1 行で案内する
  - フィールドの定義は切らずに載せ、長い行は分割する。`fields` ツールは一覧を確かめる手段としてだけ案内する
- `after` の入力は `s<id>` か `t<hex8>.<n>`
- 文脈だけのページ・末尾だけのページは `AUTO_PAGES` を消費しない（今と同じ）

### record_check・record_save

- 先頭は必ず結論と件数。check: 「✓ N records can be saved」か「✗ N errors; fix the record and check again」。save: 「✓ saved」か「✗ N errors; nothing was saved」。続けて種類ごとの件数（active、superseded、candidate、quarantined、警告、変更）
- 続けて行を、エラー → 警告 → 結果の順に収まるだけ。残りは `record_more`
- save が断るとき（検証のエラーと `SaveRefused` の両方）も、その呼び出しで得た行を置き場に固定し、`isError: true` で返す。拒否は `inTransaction` の外まで例外として通し、ロールバックの後で `{ ok: false, text }` に変える。`saveText` は `{ ok, text }` を返し、`mcp-record.ts` が `isError` を付ける

### glean_fetch

- 全部保存する。先頭は「N sources kept」と、載せていない件数。続けて 1 件 1 行を収まるだけ、残りは `record_more`（commit 済みの枠）

### forget_preview・forget_apply

- 必ず出すもの: 消す source 全部（`s<id>`、種類、artifact は 80 バイトまで）、既に消した id、打つ件数、残るものと掃除の注意書き
- 影響を受ける記録: 4 種類の件数（active を離れる / active になる / その他の状態の変化 / 状態はそのまま）と、active を離れるものを先頭にした行を収まるだけ。並べ替えは表示用の写しで行い、照合に使う `ForgetOutcome` は変えない
- `forget_preview` の続きは `record_more`（やり直せる枠）。`after` は足さない
- 確認ダイアログの本文も同じ形で、全部の記録は `forget_preview` で読めると書く。確認の直前の preview と、削除の直前の全体の照合は今のまま
- `forget_apply` の結果は、消した source・件数・注意書き・掃除の成否を必ず出し、記録の行は収まるだけ、残りは `record_more`（commit 済みの枠）

### 受信バッファの上限

- 両サーバーで、transport の `onerror` に渡る例外が SDK の上限超過（`ReadBuffer exceeded maximum size`）のときだけ印を付け、その後の close で stderr に固定の 1 行（the receive buffer passed 10 MiB）を書いて終了コード 1。不正な JSON と通常の終了は今のまま

### Skill と文書

- trace・harvest・glean・forget の Skill: allowed-tools に `record_more` を足す。「最後のページ」は続きの案内が無いことで判定すると書く。結論が先頭に来る形、`t` のカーソル、`record_more` に合わせる
- README と README.ja.md に、該当の記述があれば合わせる

## 採った案と棄却した案

- 採用: 結果の続きを読む読み取り専用ツール `record_more`（カーソルと cwd だけ）。棄却: `record_check`・`record_save` に `after` を足す（保存をやり直す呼び出しに見える。保存済みの run は `bound` が断る）
- 採用: 結果のページをプロセスのメモリに持つ。棄却: DB に保存する（schema の変更が要る。失われても保存の結果は変わらない）
- 採用: save が断った結果も置き場に固定する。棄却: 続きは `record_check` のやり直しで見る（別の時点の判定で、保存時の拒否の理由の読み直しにならない）
- 採用: 末尾のカーソルに run ごとの乱数を入れる。棄却: `t<行位置>` だけ（2 つの run が同じ位置まで進むと区別できない）
- 採用: `record_context` の末尾は run ごとに写しを固定する。棄却: 毎回 DB から作り直して位置で切る（ページの間に記録が増減すると、同じカーソルで違うページになる）
- 採用: `forget_preview` の続きも置き場から読む。棄却: `after` で毎回計算し直す（ページの間に状態が変わると、並びが入れ替わって記録を飛ばす）
- 採用: フィールドの定義は末尾に切らずに載せて分割する。棄却: `fields` ツールを全文の取得先として案内する（`fields` はセルを 200 文字で切る）
- 採用: 置き場を 2 枠にする。棄却: 1 枠 20 件（check をやり直すだけで、読み直せない save や forget の結果が押し出される）
- 採用: `AUTO_PAGES` は 2 のまま。棄却: 読む量を保つために上げる（自動の trace は持ち主の依頼の後に走るので、1 回の量を増やす理由が無い。残りは次の run が続きから読む）

## 手順

- S1: 予算の部品を `reply-budget.ts` に移し、record サーバーのエラーの返答を予算に収める
- S2: 結果の置き場（2 枠、分割して固定）と `record_more`
- S3: `record_context` のページをバイトで切り、見出しの文字列を制限し、長い発言を UTF-8 の境目で切る
- S4: `record_context` の最後の部分を、run ごとの写しとカーソルでページにする
- S5: `record_check`・`record_save` の返答（結論と件数が先頭、拒否も固定、続きは `record_more`）
- S6: `glean_fetch` の返答
- S7: `forget_preview`・確認ダイアログ・`forget_apply` の返答
- S8: 受信バッファの上限超過で stderr の 1 行と終了コード 1（両サーバー）
- S9: Skill（trace・harvest・glean・forget）と README
- S10: バージョンを 0.6.50 に上げる

## 完了条件

- A1: `bun run verify` → 終了コード 0
- A2: `bun run release:plan -- --base v0.6.49` → `release kind: plugin`、4 か所とも 0.6.50
- A3: `(cd server && node --import ./test/isolate-home.ts --test test/record-replies.test.ts)` → 全部 pass。record サーバーを MCP 経由で呼び、6 つのツールの各ページと `record_more` の各ページが 32,768 バイト以内。直す前のコードで超えることは、タスクごとに先に確かめる
- A4: `(cd server && node --import ./test/isolate-home.ts --test test/record-state.test.ts)` → 全部 pass。状態を確かめる: ページの途中での保存、わざと切った 1 件の発言が見た扱いになる、auto の文脈、末尾が複数ページ、同じカーソルの読み直し、同じ行位置まで進んだ別の run のカーソルの拒否、バイト位置、最初の 1 行が大きすぎる結果、結果の読み直しで書き込みが増えない、save の 2 種類の拒否で何も増えず同じ run でやり直せる、置き場を空にした後と押し出された後のカーソル、別 project の拒否、fetch の読み直しで取得をやり直さない、forget は全 source の表示・違う件数・キャンセル・確認の後の変化・掃除の未完了
- A5: `(cd server && node --import ./test/isolate-home.ts --test test/stdio-limit.test.ts)` → 全部 pass。両サーバーで、上限ちょうどは通る、超えると stderr の 1 行と終了コード 1、分割した chunk でも同じ、不正な JSON の後に次の要求が通る、正常終了は 0
- A6: `(cd plugin && npm pack)` の tarball をリポジトリの外で展開し、一時の HOME で `node dist/mcp-record.js` → MCP で呼ぶと、サーバーが 0.6.50 を名乗り、`record_more` が答え、40 KB の未知のツール名のエラーが 32,768 バイト以内で `isError`
- A7: 50 件の source を入れた一時の DB を `SPHICA_DB` に指定した Claude Code で `/sphica:forget` → 確認ダイアログに全 source・打つ件数・注意書きが出ることを、持ち主が 1 回見る
- A8: PR の CI が全項目 pass し、リリース後に `bun run release:status` → `release ledger is consistent`

## リスク

- 自動の trace が 1 回に読む量が減り、溜まったセッションの消化が遅くなる → リリース後に `sphica doctor` の待ちの件数を見て、遅すぎれば `AUTO_PAGES` を上げる変更を別に出す
- `record_more` の結果がプロセスの再起動や押し出しで消える → 「残っていない」と次の手を返す。保存・取得・削除は済んでいるので、結果は変わらない
- 編集とフィールドの件数に上限が無く、末尾の写しが大きくなる → 実装の中で 1 run の写しの大きさを測って記録する。上限を置くときは写しだけを分けて期限切れにし、見た扱いの集合は消さない
- SDK が上限超過の文言を変えると、終了コード 1 にならなくなる → 入っている SDK で実際に起こすテストが落ちて気づく
- 確認ダイアログが長い本文を全部は表示しない → A7 で分かる。そのときは source の行をさらに短くするか、件数を分けて頼む案内にする（計画を直して Go を取り直す）
- Skill が古い形（要約が最後、有効な記録が最後のページ）を前提にした文を残す → S9 で全部直し、acceptance のケースで確かめる

## 未解決

なし

## 変更履歴
