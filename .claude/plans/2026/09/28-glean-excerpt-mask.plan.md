---
kind: plan
status: draft
codex_session: 01a0e761-7a81-75a2-b101-bb017ad51922
codex_rounds: 4
approved_at:
---

# glean が引いたファイルの抜粋と、記録のコード位置の抜粋を、保存の前に伏せ字にする（W1）

## 要点

- `/sphica:glean` がファイルの行を根拠に引くとき、抜粋を `mask()` に通してから `source` に保存する。セッションの取り込みや harvest と同じ扱いになり、全文検索のインデックスにも秘密が入らなくなる
- 引用（quote）が伏せ字になる部分に触れていたら、保存を断って「秘密を避けて引く」よう伝える。引用の位置は伏せ字の後の本文の上で決める
- 秘密鍵のブロックの一部だけを含む行の指定は断る（抜粋だけでは BEGIN と END が見えず、伏せ字にならないため）
- trace、harvest、glean が記録に付けるコード位置の抜粋（`unit_anchor.excerpt`）も、行全体を伏せ字にしてから 200 文字に切る
- 前のバージョンが伏せ字なしで保存した抜粋は書き換えない。同じ箇所を再び引くと、伏せ字にした本文を新しい revision として保存し、そちらを使う。古い行の削除は W2（個別の削除）で扱う
- 変えないもの: スキーマ、`mask()` の検出規則、セッションと GitHub の取り込み経路

## 持ち主の決定

- 今の機能の弱点のうち W1 を最初に直す。挙動を変える修正なので、今のコードで秘密が伏せ字にならずに入ることを先にテストで確かめる（2026-09-28）
- v1 前なので、ルール・既存のロジック・スキーマは変えてよい（2026-09-28）
- 選別の順序: W1 → W2 → W8 → W4 → W7 → W3 → C1a …（2026-09-28、Codex と合意し持ち主が同意）

## 目的

- 秘密を含むファイルを glean で引いても、`source.text` と `source_fts` に秘密の文字列が残らず、`redacted = 1` になる
- 秘密に触れる引用は、理由付きのエラーで保存を断られる。秘密を避けた引用は、伏せ字の後の本文上の正しい位置で保存される
- 記録のコード位置の抜粋にも、秘密の文字列が残らない

## 対象外

- 前のバージョンで保存済みの伏せ字なしの `source` 行と `unit_anchor` 行の書き換えと削除。`source` は書き換えない設計（`source_no_update` トリガー）で、根拠の位置が本文のバイト位置なので書き換えると壊れる。削除は W2 で扱う
- `mask()` が見つけられない形の秘密の検出。検出規則の拡張は別の作業
- GitHub の本文と diff hunk。すでに `fit()` を通っている（`server/src/github.ts:397-399, 439-448`）

## 前提

- glean の抜粋は伏せ字なしで保存している: `server/src/glean.ts:436-458` が `x.text` をそのまま入れ、`mask` を import していない（2026-09-28 に確認）
- セッションは `server/src/capture.ts:121-144` の `fit()`、GitHub は `server/src/github.ts:441-447` で伏せ字にしている
- `source_fts` は insert のトリガーで `text` を索引にする（`db/schema.sql:119-122`）。保存する本文を伏せ字にすれば、索引も伏せ字になる
- `source` の CHECK は `truncated = 1 or redacted = 1 or original_bytes = length(text)`（`db/schema.sql:97`）。`original_bytes` にはファイル全体のバイト数、`truncated` には「抜粋がファイル全体ではない」を入れている（`server/src/glean.ts:435`）
- 同じ抜粋は `external_id` = `file:<path>@<blob>#L<a>-<b>` の一致で再利用している（`server/src/glean.ts:425-433`）。一意の索引は `(project_id, kind, external_id, revision)`（`db/schema.sql:102-103`）
- コード位置の抜粋は `server/src/anchors.ts:32-37` の `findSymbol` だけが作り、`record.ts:515-529` と `glean.ts:569-583` が保存する
- `mask()` が出す置き換えは、どれも `[redacted` を含む（`server/src/text.ts:263, 298, 308-313`）
- 秘密鍵は、同じ入力の中に BEGIN と END の両方があるときだけ伏せ字になる（`server/src/text.ts:286-302`）
- 受け入れケースの `file_source` の検査は、部分文字列と truncated だけを見ている（`server/evals/acceptance/driver.ts:838-856`）

## 方針

- `server/src/text.ts`
  - 秘密鍵のブロック（BEGIN〜END）の範囲を返す関数を足し、`maskPrivateKeys` と走査を共有する。glean の行の境界に合わせて、範囲はバイト位置で返す
  - 引用の対応を判定する関数を足す。入力は、伏せ字の前の抜粋、伏せ字の後の抜粋、引用。伏せ字で本文が変わったときは次のとおり判定する
    - 伏せ字の後の本文から、置き換えの範囲を `/\[redacted(?:: [^\]]*)?\]/g` で探す
    - 引用の一致を、1 バイトずつ進めて重なりも含めて数える。伏せ字の後の本文では置き換えの範囲に重ならない一致だけを数え（M）、伏せ字の前の抜粋ではすべて数える（R）
    - M の件数と R の件数が等しく、1 件以上あるときだけ受け入れ、位置は M の最初の一致にする。それ以外は断る
    - 本文が変わらなかったときは、今と同じく最初の一致を使う
- `server/src/glean.ts`
  - `readExcerpt` の中でファイル全体の秘密鍵の範囲を求める。指定の行がブロックと重なるのに、ブロック全体を含んでいなければ、`lines a-b are inside a private key; cite lines outside it` で断る
  - 抜粋を `mask()` に通す
  - `truncated` は伏せ字の前のバイト数とファイルのサイズで決める
  - `redacted` は伏せ字で本文が変わったら 1 にする
  - `content_hash` は伏せ字の後の本文から作る
  - 引用の検査（今の `locate`、272-283 行あたり）は上の判定関数を使う。断るときの文面は `the quote also appears in text Sphica masks; quote a longer or different part`
- `excerptSource`
  - 同じ `external_id` の最新の revision を引く
  - その `content_hash` が伏せ字の後の本文と同じなら再利用し、違えば revision + 1 で新しく入れる
  - 根拠の位置は、実際に使った行の `text` の上で求める
- `server/src/anchors.ts` の `findSymbol`
  - その行がファイルの秘密鍵ブロックの中なら、抜粋を `[redacted: private key]` にする
  - それ以外は、行全体を `mask()` に通してから trim し、200 文字に切る
- `plugin/skills/glean/SKILL.md` に 1 行足す: 引用に秘密を含めない。含めると断られる
- 受け入れケース
  - `server/evals/acceptance/cases.json` に、秘密を含むファイルを glean で引くケースを足す
  - `driver.ts` の `file_source` に、`must_not_contain`（本文に含まれてはいけない文字列）と `redacted` の期待を足す
- バージョン: `bun run release:plan -- --base v0.5.6` の結果に従い、npm と 3 つのプラグインの manifest を同じバージョンに上げる（plugin-release スキル）

## 採った案と棄却した案

- 採用: 伏せ字は JS の保存経路で `mask()` を使う。棄却: DB のトリガーで伏せ字にする（SQLite から JS の規則を呼べない）
- 採用: 古い行は残し、伏せ字の後の本文が違えば新しい revision を作る。棄却: 古い行をそのまま再利用する（秘密が残るうえ、伏せ字で長さが変わると根拠の位置が別の箇所を指す）
- 棄却: 古い行を移行で書き換える（根拠のバイト位置が壊れる。`source_no_update` に反する）
- 採用: 引用の一致を、重なりも含めて数え、置き換えの範囲に重ならないものに絞って比べる。棄却: 「伏せ字の前にあって後に無ければ断る」（別の箇所の一致を拾う）、重ならない一致だけを数える（Codex の実測の反例: `AIza` + `a`×75 と、引用 `a`×40 で件数が等しくなる）
- 棄却: `mask()` に伏せ字の前と後の位置の対応表を返させる（`text.ts` の置き換えの全部を変えることになり、W1 に要る範囲より大きい）
- 採用: 秘密鍵のブロックの一部だけを含む行の指定は断る。棄却: 抜粋だけを `mask()` に通す（BEGIN と END が見えず、伏せ字にならない）
- 採用: コード位置の抜粋は、行全体を伏せ字にしてから切る。棄却: 切ってから伏せ字にする（閉じ引用符が 200 文字より後ろにあると、値が伏せ字にならない）

## 手順

- S1: 受け入れケースと単体テストで、今のコードで秘密が伏せ字にならずに保存されることを確かめる（red）
- S2: `text.ts` に秘密鍵の範囲と引用の対応の判定を足す
- S3: glean の抜粋の伏せ字、秘密鍵の行の指定の拒否、revision の扱い、引用の検査
- S4: コード位置の抜粋の伏せ字
- S5: glean スキルの 1 行と、バージョンの引き上げ

## 完了条件

- A1: `bun run --cwd server test` → 全件 pass。次のテストが含まれる
  - 秘密を含むファイルの抜粋が伏せ字で保存され、`redacted = 1` になり、`source_fts` を秘密の文字列で検索しても当たらない
  - 秘密に触れる引用が断られる。例: `TOKEN=redacted123` と引用 `redacted`、`API_KEY=abc123def456` と、別の行の `abc123def456` を引く引用、`AIza` + `a`×75 と引用 `a`×40
  - 秘密を避けた引用は、正しい位置で保存される
  - 秘密鍵のブロックの途中の行の指定は断られる
  - 長い `apiKey = "…"` の行のコード位置の抜粋が伏せ字になる
  - 古い伏せ字なしの行があるとき、新しい revision が作られて、そちらが使われる
- A2: `bun run acceptance` → 新しいケースを含めて全件 pass。新しいケースは直す前のコードで fail する（S1 で確かめる）
- A3: `bun run verify` → 0 で終わる
- A4: `npm pack` → 生成物をリポジトリの外で展開し、起動して `sphica --version` が新しいバージョンを返す（plugin-release スキルの確かめ方で、Claude と Codex の両方に届くことも確かめる）
- A5: `gh pr checks <PR>` → 全件 pass。GitHub の Codex の要約で、head の Code Review が Completed、未解決のスレッドが 0 件

## リスク

- 伏せ字の規則が、普通のコードの行を伏せ字にしてしまう（例: 長い英数字の定数）→ 伏せ字の後の本文で引用を探すので、glean は「別の部分を引く」エラーで知らせる。当たり方がひどければ、`mask()` の規則の見直しを別の作業に切り出す
- 古い伏せ字なしの行が残る → 対象外に書き、W2 で消せるようにする。リリースノートに書く

## 未解決

なし

## 変更履歴

- 2026-09-28 / glean は、抜粋の前後の文脈で伏せ字の結果が変わる行の指定も断り、コード位置の抜粋はその場合 `[redacted]` にする（T07） / T02 のレビューで、別の行にあるキー名で伏せ字になる値が抜粋だけでは残ると分かった / 目的（秘密を残さない）の内側なので Go は不要
- 2026-09-28 / anchor の symbol が秘密の形か、出現箇所のひとつでも伏せ字に飲まれる名前なら、trace・harvest は anchor を外し、glean は断る。鍵の中の名前はこれで外れるので、コード位置の抜粋を `[redacted: private key]` にする分岐は消した（T08, T09） / 全差分と T08 のレビューで、symbol 欄に秘密が残ると分かった / 目的（秘密を残さない）の内側なので Go は不要
- 2026-09-28 / コード位置の抜粋を `[redacted: private key]` にする分岐を戻した（T10） / 保存時の locate は検査の後にファイルを読み直すので、検査だけでは守れない / Go は不要
