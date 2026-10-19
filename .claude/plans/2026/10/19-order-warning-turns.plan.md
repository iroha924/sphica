---
kind: plan
status: approved
codex_session: 01a153be-b88b-7a23-a017-2189c20fc0e5
codex_rounds: 2
approved_at: 2026-10-19
---

# #360 と #361: trace の順序の警告を同じターンの途中の発言で出さず、release:plan が stage していない変更を知らせる

## 要点

- #361: trace の check の順序の警告（0.6.62）を、前後が推し量れる組み合わせだけに絞る。採用がターンの途中の持ち主の発言（途中で送ったメッセージ、AskUserQuestion の答え）で、提案が同じターンの AI の返事なら比べない。ターンを始めた発言と、別のターンどうしは今どおり比べる
- #360: `release:plan` が、stage していない package の変更と未追跡の package のファイルを件数とパスで知らせ、`compared:` の行に比べたもの（index）を出す。`--json` にもキーを足す
- 0.6.63 として plugin をリリースする（record.ts が package に入る。release-plan.mjs は入らない）
- 変えないもの: 保存の結果、DB の schema、capture、別のターンどうしの比べ方、release:plan の分類と終了コード

## 持ち主の決定

- #360 と #361 を 1 つの PR で進める（2026-10-19、「それで進めて欲しい」）
- #361 を issue にする（2026-10-19、「issueに残した方が良いと思う？思うならissueにして」）、#360 を issue にする（2026-10-19、「2」と文面の「OK」）

## 目的

- 採用がターンの途中の持ち主の発言で、`proposes` が同じターンの AI の返事のとき、trace の check と save に順序の警告が出ない
- 採用がターンを始めた発言で、同じターンの AI の返事が `proposes` のとき（u670 の形）は、今どおり警告が出る
- stage していない package の変更があるとき、`release:plan` の表示と `--json` の両方でそれが分かる

## 対象外

- ターンの開始を確かに示す capture の情報を足すこと（schema と capture の変更になり、警告にとどめる機能に見合わない）。そのため、通知で始まるターンの最初の途中の発言と、forget で先の発言が消えたターンでは、途中の発言を開始とみなして警告が残る
- 遅れて届いた Stop で、前のターンの返事が後の時刻で記録される形（`server/test/capture.test.ts:676`）。別のターンどうしは今どおり時刻で比べ、警告が出る
- acceptance の driver に、ターンの途中で送るメッセージの入力を足すこと（その形は record.test で見る）
- release:plan の分類の仕方と終了コード

## 前提

- 0.6.62 の判定: `server/src/record.ts` の `checkRecord`、`target.origin === "trace"` のブロック。人の採用の最新の `created_at` と unit-level の `proposes` の最新の `created_at` を厳密な不等号で比べる（事実）
- 持ち主の DB の読み取りのみの確認（2026-10-19、事実）:
  - u670: 採用 s3573 は turn 3daa1840 の最初の source（owner）、proposes s3574 は同じ turn の assistant → 新しい判定でも警告（正しい）
  - u147 の元の採用 s713 は turn 4d4bf4fb の最初の source、proposes s715 は同じ turn の assistant → 警告（正しい）。同じ turn の s714（途中の owner の発言）を引くと、今は警告が出て、新しい判定では出ない
  - u655: 採用 s3507 は AskUserQuestion の答え（external_id に `:ask:`。同じ turn に先に s3505 と質問 s3506）、proposes s3508 は同じ turn の Stop の返事 → 今は警告（誤検出）、新しい判定では出ない
  - 生きた owner_statement の採用（trace の決定と制約、session_message）354 行のうち、ターンの途中の発言は 73 行、そのうち AskUserQuestion の答えは 56 行
- capture は持ち主の発言を UserPromptSubmit の時刻で、AI の返事を Stop の時刻で記録し、ターンの途中に届いたメッセージは同じ turn id で記録する（`server/src/capture.ts:576`、`:604`、`server/test/capture.test.ts:1036`）。通知は保存しないがターンを始める（`server/src/capture.ts:595`、`:599`）（事実。Codex も確認）
- `proposes` の話者は制限されていない（`server/src/record.ts:466`、`db/schema.sql:975`）（Codex が確認）
- acceptance の driver は AskUserQuestion を再生するが、owner の参照は `:ask:` の source を除く。答えを引用する参照は無い（`server/evals/acceptance/driver.ts:370`、`:420`、`server/evals/acceptance/load.ts:75`）（Codex が確認）
- `release-plan.mjs` は `git diff --name-only <base> --cached` で比べ、`compared:` は `<base>..<HEAD>` を出す。テストは無く、JSON を読むリポジトリ内の利用者は無い。`kind` が plugin のとき `gh repo view` と 2 つの設定 API を呼ぶ。`root` は `import.meta.dirname` から決まる（`scripts/release-plan.mjs:12`、`:44`、`:83`、`:90`、`:113`）（事実。Codex も確認）
- `scripts/release-plan.mjs` は package に入らず、`server/src/record.ts` は入る（`isPackageInput`、実測）

## 方針

- #361 の判定（`checkRecord` の trace のブロック）
  - a: 人の採用（route が agent 以外）の session_message のうち `created_at` が最新のもの。p: unit-level の `proposes` の session_message のうち `created_at` が最新のもの（今と同じ選び方）
  - a と p が同じ source なら警告しない
  - p が assistant で、a と同じ `session_id` と `turn_id`（どちらも null でない）なら、a がそのターンに残る source のうち `created_at` が最も早いもの（ターンを始めた発言と推し量る）のときだけ、今どおり比べる。そうでなければ（途中の発言）比べない
  - それ以外は今どおり `p.created_at > a.created_at` で警告
  - 「最も早い残存 source か」は、同じ (session_id, turn_id) で a より `created_at` が早い source があるかを読む 1 つのクエリで見る（引用していない source も対象。ingest の読み取りで足り、権限は変えない。SQL の到達は新しいテストで満たす）
  - コメント 1〜2 行: 途中の発言と同じターンの返事は前後が分からないこと、開始の判定は残っている source からの推測であること
- #361 のテスト
  - driver: 参照 `session:<id>#<n>.answer` を AskUserQuestion の答え（owner の `:ask:` の source）に解決し、`acceptance-cases.test.ts` の引用の静的な検査（`load.ts` の `sourceTexts`）にも通す
  - acceptance case（capture 層、20 → 21）: 質問 → 答えを採用に引く → 同じターンの Stop の返事を `proposes` にしても、check に警告が出ない（`check_problem_absent`）。fixture が正しい source を指すことを先に確かめ、修正前のコードで「check reported "is older than the proposal it cites"」で落ちることを確かめる。capture-19 は今どおり警告
  - `server/test/record.test.ts` に turn_id を持つ source を明示的に作り: 途中の owner の発言と同じターンの assistant（警告なし）、ターンの最初の owner と同じターンの assistant（警告）、同じターンの assistant が 2 件（最新で比べる）、引用していない先の source があるときは途中とみなす、同じ時刻（警告なし）、turn_id が null どうし（同じターンとみなさず時刻で比べる）、別 session の同じ turn_id（同じターンとみなさない）、owner の `proposes`（同じターンの特別扱いをしない）、同一 source（警告なし）
- #360（`scripts/release-plan.mjs`）
  - 比べるパスを `-z` で取る
  - stage していない package の変更（`git diff --name-only -z`）と未追跡の package のファイル（`git ls-files --others --exclude-standard -z`）を集める
  - 表示: `compared: <base>..index (HEAD <sha>)`。stage していないものがあれば `not staged, not counted (git add them first): <件数>` とパス
  - `--json`: `compared: "index"` と `unstaged: [paths]` を足す。既存のキーと終了コードは変えない
  - テスト: スクリプトと `scripts/lib/release-scope.mjs`・`scripts/lib/repo-settings.mjs`・マニフェストを一時の git リポジトリに写して子プロセスで流し、`repo view` と 2 つの設定 API に答える専用の偽の gh を PATH の先頭に置く。変更なし、stage 済み、stage していない、未追跡、部分 stage、package 外の変更、日本語のパス、JSON、終了コードを見る
- リリース: package を変える最初のコミット（#361）に 0.6.63 を入れる。その前に変更を `git add` してから `release:plan` を流し、`plugin` を確かめてから版を上げる

## 採った案と棄却した案

- 採用: ターンの途中の発言と同じターンの AI の返事は比べない。棄却: 同じターンは一切比べない（u670 の形、ターンを始めた発言への返事での取り違えを見逃す）
- 採用: ターンの開始を、残っている source のうち最も早いかで推し量る。棄却: 開始を示す情報を capture に足す（schema と capture の変更になる。警告にとどめる機能に見合わない）
- 採用: 同じターンの特別扱いは、提案が assistant の返事のときだけ。棄却: すべての `proposes` に当てはめる（持ち主の発言を `proposes` に引いたときや同一 source で、新しい誤警告になる）
- 採用: 遅れた Stop の形は今どおり警告し、限界として書く。棄却: 今回抑える（capture の起点の規則を読む必要があり、警告のためには重い）
- 採用: release:plan は index との比較を保ち、stage していないものを知らせる。棄却: 作業ツリーと比べるよう変える（stage した内容がコミットに入るものなので、index が正しい対象）
- 採用: `--json` にキーを足し、終了コードは変えない。棄却: stage していないものがあれば失敗にする（作業中の分類を止めてしまう）

## 手順

- S1: driver の `.answer` 参照、acceptance case（u655 の形）、件数、red
- S2: `checkRecord` の判定、判定のための読み取り、record.test の境界の例、コメント、0.6.63
- S3: release-plan.mjs の `-z`、stage していないものの検出、`compared` の表示、JSON のキー、テスト

## 完了条件

- A1: `bun run verify` → 0 で終わる
- A2: `rg -n "check reported" .claude/plans/2026/10/19-order-warning-turns.tasks.md` → S1 のタスクの結果欄に、修正前のコードで新しい acceptance case が警告のために落ちた記録がある
- A3: `git add` した状態で `bun run release:plan -- --base v0.6.62` → `plugin`。`rg -n '"version": "0.6.63"' plugin/package.json plugin/.claude-plugin/plugin.json plugin/.codex-plugin/plugin.json .claude-plugin/marketplace.json` → 4 ファイルすべて
- A4: 作業ツリーに package のファイルを 1 つ足して stage しないまま `bun run release:plan -- --base v0.6.62` → `not staged, not counted` の行とそのパスが出て、`compared:` が `index` を含む。`--json` の出力に `"unstaged"` と `"compared":"index"` がある
- A5: `cd plugin && npm pack --pack-destination <リポジトリの外>` → 展開した `dist/mcp-record.js` が一時の HOME で起動し、`initialize` に `sphica-record` 0.6.63 と返す
- A6: `gh pr checks <PR>` → 全ジョブが pass。未解決のスレッドが 0
- A7: 持ち主が npm-release を承認した後、`npm view sphica@0.6.63 version` → `0.6.63`、`bun run release:status` → `release ledger is consistent`。reload の後、Claude Code の実際のセッションで、ターンの途中の答えを採用に引き同じターンの返事を `proposes` にした `record_check` に警告が出ない

## リスク

- 判定のクエリが遅い → `source_session` が `(session_id, created_at)` の索引なので、session と a より早い時刻で絞ってから turn_id を見る形にする（turn_id を含む索引は無い、実測）
- 途中の発言を開始とみなす誤警告（通知で始まるターン、forget の後）が残る → 対象外に書いたとおり。PR の Decisions に書く
- 計測中の #353（10-26 ごろ）と #218（10-29 ごろ）に混ざる → 配信を変えないので混ざらない見込み（推測）。リリースの日付を PR に書く

## 未解決

なし

## 変更履歴
