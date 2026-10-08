---
kind: plan
status: approved
codex_session: 01a118eb-73f0-7fe0-8db9-3e8b5b67615a
codex_rounds: 2
approved_at: 2026-10-08
---

# overview live と review_select の応答を 32 KiB に収め、MCP SDK を 1.31.0 に上げる（#289、code scanning #21）

## 要点

- overview live: id 順の先頭から 1 件ずつ足し、枠込みの応答全体が READ_BUDGET（32 KiB）を超える手前でページを切る。after で続けると全件が 1 回ずつ出る
- review_select: 1 バッチ 50 件のまま、各行に u<id> を付け、本文と理由（path・symbol・option）を表示のときだけ切って枠込みで 32 KiB に収める。キーの全文まで収まらないバッチは 50 件とも u<id> だけで出す
- review Skill の reviewer は u<id> で read して全文のキーを得る。review_check の契約（findings.unit はキー）は変えない
- @modelcontextprotocol/sdk を 1.30.0 から 1.31.0 に上げる（CVE-2026-104850）。Sphica は OAuth クライアントを使わない
- 変えないもの: バッチの件数・selection・境界、照合（全文のまま）、配信フックの出力、search など他の応答（別の issue）

## 持ち主の決定

- review_select は 1 バッチ 50 件のまま（review Skill の受け取りがこれに依る）。live はページの件数や切り詰めを変えてよいが、after のページ送りで記録を飛ばさない。全文は read で読める（#289）
- SDK の脆弱性（code scanning #21）も同じ PR で直す（2026-10-08、持ち主:「これも一緒の PR でできる？」）
- 今回は Claude が PdM として判断を任されている（2026-10-08、持ち主:「判断任せるよ。どんどん進めて欲しい」「今はあなたが pdm」）
- SDK v2 への移行（#279、作業ブランチ feat/h1-sdk-v2）は保留のまま

## 目的

overview live のどのページも、review_select のどの応答も、枠込みで READ_BUDGET 以下のバイト数になり、Codex が中ほどを黙って捨てる大きさ（約 40,000 バイト）に届かない。code scanning #21 が閉じる。

## 対象外

- search・review_check・export・fields・asked の応答の大きさ（それぞれ 32 KiB を超え得る。別の issue にする）
- overview look・delivery、status（既に予算がある。u293、u373）
- SDK v2 への移行、1.32.x（公開から 7 日たっていない。server/bunfig.toml の minimumReleaseAge）

## 前提

- READ_BUDGET = 32 KiB（server/src/read.ts:468）。Codex 0.160.0 は出力を bytes / 4 トークンと数え、10,000 トークンを超えると頭と尻を残して中ほどを捨てる（#289 本文）
- live は 50 件で各部分を切り、64 KiB 未満を目安にしている（server/src/overview.ts:14）。Codex の実測: キー 256 B・path 485 B・短い本文の 50 件で、枠込み 37,450 B
- review_select は本文だけ 300 B で切り、理由（anchor の path・symbol、選択肢の文）は切らない（server/src/review.ts:156-198、:269）。Codex の実測: symbol 200 B を含む 50 件で 50,552 B、40,000 B の選択肢 1 件で 40,462 B、500 文字の日本語の選択肢 50 件で 85,152 B
- キーは `<origin>:<target>/<slug>`。slug は 64 文字以下（server/src/record.ts:34）だが、prefix のセッションの external_id に上限が無い（server/src/extract.ts:359、db/schema.sql）。771 B のキー 50 件で 38,599 B になり、全文のキーと 50 件は両立しない
- read の refs は 1 つ 300 文字まで（server/src/mcp.ts:233）なので、長いキーは read に渡せない。u<id> なら読める（Codex の実測: 40,011 B のキーの記録を u<id> で 2 ページに読めた）
- 配信フックも selectForReview と because を使う（server/src/deliver.ts:755・764）。照合の前に選択肢を切ると、当たる記録が変わる（review.ts:188-198）
- head() は省略記号を付けない（server/src/text.ts:159）。read.ts:478 に、3 B を引いて「…」を付ける形がある
- SDK: server/src が読み込むのは sdk/server/mcp.js と sdk/server/stdio.js だけ。1.31.0 は 2026-09-28 公開（7 日を過ぎている）、公式リポジトリから SLSA provenance つき、メンテナーは同じ（npm view で確認）。脆弱な範囲は >=1.12.0 <1.31.0（GHSA-6qxp-vccf-f47h）。1.31.0 の依存・peer・Node の条件は 1.30.0 と同じ（Codex が上流の manifest で確認）。今の bundle の metafile に OAuth のコードは入っていない（Codex が確認。1.31.0 では未確認）

## 方針

### overview live

- id 順に取った最大 50 件（OVERVIEW_LIMITS.records は上限として残す）の先頭から 1 件ずつ足し、見出し・空行・締めの行・AI の注意書き・MCP の枠（mcp.ts:381）を含む候補の応答全体のバイト数を数える。入らない候補で止め、後ろの小さい行は拾わない
- after は採った id の最大。more は rows.length > 採った件数。1 件だけの応答が必ず収まることをテストで確かめる
- 64 KiB の条件のテスト（overview.test.ts:299）を、READ_BUDGET の条件に置き換える

### review_select

- Applicable に理由の構造（kind: anchor なら path・symbol、option なら path・option の文）を持たせる。照合は全文のまま。配信フックが出す because の文は今と同じにする
- MCP の表示のとき: 各行に u<id> を付ける。可変欄（本文・path・symbol・option）を空にした最終応答のバイト数 F から q = floor((READ_BUDGET - F) / n) を出し、各行の可変欄の合計を q 以下にする。初期上限は本文 300 B、path 160 B、symbol 80 B、option 160 B。各欄に省略記号の 3 B を予約し、本文と理由に半分ずつ配る。最後に枠込みの最終バイト数を確かめる
- 表示用の切り詰めは、超えたときだけ head(value, limit - 3) + "…" にする（inline() を先に通す）。head() は変えない
- 予約とキーの全文が収まらないバッチは、50 件とも「u<id>」だけで出し、「全文のキーは read u<id> で読み、findings.unit にはそのキーを渡す」と書く
- review Skill の reviewer（plugin/skills/review/reviewers/precedent.md の Step 2 ほか）を、u<id> で read する形に合わせる

### SDK

- server/package.json を `@modelcontextprotocol/sdk` 1.31.0 の完全一致にし、Bun 1.4.0 でその依存だけを更新する。lockfile は手で直さない。解決先が 1.31.0 で、ほかの依存が再解決されていないことを差分で確かめ、きれいな環境で frozen-lockfile の install を確かめる
- 再 bundle の後、両サーバーの metafile の inputs に OAuth（client/auth、providers、jose、pkce-challenge）が無いことと、bundle の大きさを確かめる。notices・SBOM を作り直し、SDK のバージョンが揃うことを確かめる
- 両サーバーで initialize、tools/list、ふつうの呼び出し、入力の拒否、_meta、text だけの応答を確かめる（既存のテストと #289 の子プロセスのテスト）

### テスト（直す前のコードで落ちることを先に確かめる）

- live: 長いキー・本文・パスの 50 件のページが READ_BUDGET を超える（今）→ 収まる。after で続けると全件が 1 回ずつ。id 順と表示順が違うグループ、全件が別グループ、AI の注意書き、最後のページ、境界の前後
- review_select: 位置の無い dont の記録で、選択肢の文が 40 KB（保存済みデータとして直接入れる）、追加した行がその文を含む → 今は超える。500 文字の日本語の選択肢 50 件、長いキー（u<id> だけの経路）、50 件と 51 件
- 配信フックの出力、selection、バッチの境界、next が変わらない
- MCP の子プロセスで、各 content.text の UTF-8 バイト数を測る

## 採った案と棄却した案

- 採用: 全文のキーが収まらないバッチは 50 件とも u<id> だけで出す。棄却: そのバッチで「not checked」と止める（そのデータではレビューが進まない）、キーを切る（review_check がキーで照合する）
- 採用: 切るのは表示のときだけ。棄却: 照合の前に選択肢を切る（当たる記録が変わる）
- 採用: live は候補の応答全体を数えて止める。棄却: 各部分の上限の和で見積もる（pathList の「more」や見出しを数え落とす）
- 採用: この PR は live と review_select と read の導線に絞る。棄却: 他の応答もまとめて直す（直し方が応答ごとに違う。export は全文を渡す契約）
- 採用: SDK 1.31.0。棄却: 1.32.x（公開から 7 日たっていない）、v2 への移行（#279 で保留）

## 手順

- S1: overview live の予算によるページ切り
- S2: review_select の理由の構造化、表示の切り詰め、u<id>、代替の経路、review Skill の手順
- S3: SDK 1.31.0 と、lockfile・bundle・notices の確認
- S4: リリースの準備（release:plan、バージョンを揃える、npm pack）

## 完了条件

- A1: `bun run verify` → 0 で終わる
- A2: `cd server && node --test test/overview.test.ts test/review.test.ts test/plugin.test.ts` → 全件 pass（live と review_select の予算、子プロセスでのバイト数を含む）
- A3: `cd server && bun pm ls 2>/dev/null | grep modelcontextprotocol` → `@modelcontextprotocol/sdk@1.31.0`
- A4: `bun run release:plan -- --base v0.6.41` → `plugin`、npm と 3 つのマニフェストが同じバージョン
- A5: `gh api repos/iroha924/sphica/code-scanning/alerts/21 -q .state` → main へのマージの後に `fixed`
- A6: `gh pr checks <PR>` → 全項目 pass

## リスク

- 1.31.0 で stdio の挙動が変わる → 既存のテストと子プロセスのテストで両サーバーを確かめ、落ちたら上流の差分を読む
- u<id> だけの経路で reviewer が全文のキーを取り違える → precedent.md の手順を変え、review_check がキーの誤りを名指しすることをテストで確かめる
- 1 件だけで予算を超える live の行 → 各部分の上限の和は約 1.2 KiB なので起きない。テストで確かめる

## 未解決

なし

## 変更履歴
