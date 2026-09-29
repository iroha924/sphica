---
kind: plan
status: approved
codex_session: 01a0ebcc-093f-7193-8df3-df5d39da8fd3
codex_rounds: 3
approved_at: 2026-09-29
---

# Add an on-request overview of live records and of records that need a look, per-option reconsider conditions, and a rules draft Skill (#193, #194, #195)

## 要点

- 読み取りの MCP サーバーに `overview` ツールを 1 つ足す。`view: "live"` は有効な決定と制約を全件、ディレクトリごとにまとめて出す（#195）。`view: "look"` は確認が要る記録を出す（#193・#194）
- `look` に出すもの: 紐付いたファイルが消えた記録、ファイルはあるが関数名などが見つからない記録、見直し条件（却下案ごとの条件と defer の `revisit_when`）、規約ファイルのマーカーのうち元の記録が superseded・withdrawn・見つからないもの
- schema を revision 3 に上げる。`unit_option.reconsider_when` と evidence の role `reconsiders` を足し、持ち主の引用を必須にする。migration `0003.sql` と移行テストを付ける
- trace が、持ち主が実際に言った見直し条件だけを引用付きで保存できるようにする（record_check / record_save / trace Skill / read の表示）
- 規約の下書きを作る `/sphica:rules` Skill を足す。持ち主が選んだ制約だけを、行末に `<!-- sphica: <key> -->` を付けて出す。ファイルには書かない
- 変えないもの: 自動で失効させたり状態を変えたりしない、読み取りサーバーは書かない、CLI は変えない、セッション開始時の配信は変えない、却下案を採り直す流れは今のまま
- 0.6.4 として 1 つの PR で出す

## 持ち主の決定

- #193・#194・#195 を 1 つの計画・1 つの PR・1 つのリリースで出す（ロードマップ u22 の順、2026-09-28 に持ち主が合意）
- 範囲と棄却案は各 issue の本文のとおり。保存済みの発言から覆しの承認を推定しない（#193）。Sphica が規約ファイルを生成・書き換えしない（#194）
- 自動では何も失効させず、何も適用しない（#193）

## 目的

- 頼まれたとき、プロジェクトの有効な決定と制約を、superseded・withdrawn を含めずに漏れなく一覧でき、各行から `read` で本文と引用へたどれる
- 頼まれたとき、紐付いたファイルが消えた記録、見直し条件の付いた記録、置き換えられた記録を指す規約の行を一覧できる
- trace が、却下案ごとに持ち主の言った見直し条件をその引用と一緒に保存でき、`read` で見える
- 持ち主が選んだ制約から、記録のキー付きの規約の下書きを受け取れる

## 対象外

- セッション開始時に `look` の件数を知らせる 1 行（#193 が許す形）。走査の費用が測れていないので、このリリースでは入れない。入れるなら、先に走査の費用を測り、件数を正確に出すか不完全と明示する形にする
- 条件が満たされたかの判定と、状態の自動変更
- 規約ファイルへの書き込み

## 前提

- `checkAnchor` はファイルが無いときも関数名が無いときも `missing` を返す（`server/src/anchors.ts:114-120`）。ファイルの有無は別に調べる必要がある
- `readText` は非公開で、ファイルの列挙はしない（`server/src/anchors.ts:19-29`）
- `unit_option` は unit と一緒に書かれ、以後は書き換えも削除もできない（`db/schema.sql:261-282`）。evidence は `option_id` で案に紐付けられる（`db/schema.sql:284-309`）
- `revisit_when` は defer の unit にだけ付く（`db/schema.sql:238`）
- 有効にするときの検査は `unit_state_rules` トリガーにある（`db/schema.sql:393-414`）
- 最後の evidence を取り消すのを止めるトリガーは、案に付いた evidence も含めて数える（`db/schema.sql:521-525`）
- `forget_apply` は、有効な記録をいったん candidate に戻し、`forget_id` を付けて active に戻し直す（`server/src/forget.ts:162-185`）
- git の外のプロジェクトにも対応している（`server/src/project.ts:98-104`）
- 今の schema は revision 2（`server/src/sqlite.ts:14-16`）。移行テストは、移行した DB と新規の DB を比べる（`server/test/migrate.test.ts`）
- release の分類に schema 用の種別は無く、`db/`・`server/src/`・`plugin/` は `plugin` になる（`scripts/lib/release-scope.mjs:16-25`）
- 検索に、返事のバイト数の上限は無い（64 MiB は読む source のバイト数の上限）
- Claude で明示的に呼んだときだけ動くスキルにする設定と、Codex の policy ファイルは対で置く（`.agents/skills/plugin-release/SKILL.md:165-172`）

## 方針

### schema revision 3

- `unit_option.reconsider_when text`、`check (reconsider_when is null or outcome = 'rejected')`
- `unit_evidence.role` に `reconsiders` を足す。挿入時のトリガーで、`reconsiders` は `option_id` があり、その案が `rejected` で `reconsider_when` を持つときだけ許す
- `unit_state_rules` に足す検査: `new.to_state = 'active' and new.forget_id is null` のとき、`reconsider_when` を持つ案それぞれに、`reconsiders` evidence があり（取り消し済みでもよい）、その source の `author_kind = 'owner'` であること。forget のやり直し（`forget_id` あり）では検査しない
- `content_hash` と unit の検索本文（FTS）に `reconsider_when` を入れる
- `db/migrations/0003.sql` で `unit_option` と `unit_evidence` を作り直し、それらを参照するトリガー・インデックス・ビューも作り直す。`SCHEMA_REVISION` を 3 に上げ、db-types を生成し直す。revision 2 の schema を `server/test/fixtures/` に置き、移行で案と evidence の行と id が残ることを確かめる

### 保存と表示

- record_check / record_save の `options[]` に `reconsider_when`（1000 文字まで）と `reconsider_quote`（`{source, quote}`）を足す。片方だけは拒否する。引用は source の収集と span の検証に通し、owner の source でなければ拒否する
- trace Skill: 持ち主が言った見直し条件だけを、持ち主の言葉を引用して書く。推測で書かない
- `read`: 却下案の下に `Reconsider when: <条件>` と引用を出す。引用が取り消されたか forget されたときは `unsupported: its owner quote was retracted or forgotten` と付け、持ち主の条件としては出さない

### `overview` ツール（読み取りの MCP サーバー、reader 接続）

- 入力: `cwd`、`view: "live" | "look"`、`after`（live のみ、unit id）
- 返事の上限: 50 件と UTF-8 で 64 KiB のうち先に来たほう。各行は切り詰め、最低 1 件は出す。記録の本文と規約ファイル由来のものは `inline`・`head` を通し、一覧全体を `framed` で過去の記録として包む

`live`:

- 有効な決定と制約を unit id の昇順で取り、`after` より大きい id から 1 ページ分出す
- ページ内では、最初の生きた `applies_to` anchor（anchor id が最小のもの）のディレクトリでまとめ、anchor の無いものは最後に「Project-wide」にまとめる。1 件は 1 回だけ出し、その行に全部のパスを並べる
- 行: `- <key> (<kind> <stance>): <text> [<paths>]`
- 末尾: 今の総数、次の `after`（実際に出した中で最大の unit id）、ページどうしは 1 つの時点の写しではないこと

`look`（見出しごとに分けて出す）:

- Files gone: 有効な記録の生きた anchor のうち、ファイルが無いもの。パスの親を 1 つずつ lstat し、root の外へ出る symlink があれば「確かめられなかった」として数える
- Symbol not found: ファイルはあるが `checkAnchor` が関数名を見つけられないもの
- Reconsider conditions: 有効な決定の却下案の `reconsider_when` と、有効な defer の `revisit_when`。条件の文面を出すだけで、満たされたかは判定しない。引用を失った条件は unsupported と付ける
- Rule markers: 規約ファイルの `<!-- sphica: <key> -->`。キーは `trace:` `harvest:` `glean:` で始まる形。記録が superseded なら後継のキー、withdrawn、このプロジェクトに無い、のどれかを出す。出すのは `path:line` とキーだけで、行の本文は出さない
- 確かめられなかったもの（上限超え、読めない、外へ出る）の件数を最後に出す

規約ファイルの走査:

- 対象: どの深さの `CLAUDE.md`・`AGENTS.md`・`AGENTS.override.md` と、`.claude/rules/**/*.md`
- git のプロジェクト: `git ls-files --cached --others --exclude-standard -z` を対象の名前で絞る
- git の外: root からたどる。symlink はたどらず、`node_modules` と `.claude` 以外のドットディレクトリを飛ばし、深さ 8 か 5,000 エントリで止めて「不完全」と出す
- どちらも、通常のファイルだけ、実パスが root の中、200 ファイルまで、1 つ 256 KiB まで。超えた分は件数で出す
- Windows では execFile で `git` を直接呼び、シェルを通さない

### `/sphica:rules` Skill

- `plugin/skills/rules/SKILL.md`。持ち主が制約を名指しするか、`overview` の live から選ぶ。Skill は `read` で各記録を読み、貼り付け用の下書き行を出す。各行の末尾に `<!-- sphica: <key> -->` を付ける。ファイルは編集しない
- Claude は明示的に呼んだときだけ動く設定、Codex は対の policy ファイルを置く

### テストとリリース

- 実 SQLite のテスト: ファイルを消した anchor と関数名だけ消えた anchor の区別、引用付きで保存された条件、両方が look に出ること、マーカー付きの行の記録を supersede すると look に出ること、live が fixture の有効な決定と制約を全件出し superseded・withdrawn を出さないこと、ページの間に 1 件が superseded になっても取りこぼさないこと、引用だけを含む source を forget しても決定が active のままで look に unsupported と出ること、引用の evidence の取り消しで決定が落ちないこと、引用の無い条件・owner 以外の引用・rejected 以外の案への条件が拒否されること
- acceptance に `overview` の live と look を足す
- 新しい SQL の呼び出し箇所はすべてテストで通し、`sql:reach` の台帳は例外を足さない
- `bun run release:plan -- --base <v0.6.3 のコミット>` で種別を確かめ、npm と 3 つの plugin manifest を 0.6.4 に揃える。`npm pack` を展開して中身を数えて起動し、Claude と Codex の両方で `overview` と `/sphica:rules`（Codex は `$sphica:rules`）が届くことを確かめる

## 採った案と棄却した案

- 採用: 読み取りツール 1 つに `view` で live と look。棄却: ツールを 2 つに分ける（権限の境目が同じで、インターフェースが増えるだけ）／`status` に足す（`status` は短い要約で、一覧は長い）
- 採用: 見直し条件は案の欄と、案に紐付けた `reconsiders` evidence。棄却: 別テーブル（evidence と同じ引用の仕組みを二重に持つ）／条件を別の unit にする（条件は案の本文の一部で、案と一緒に固定されるのが合う）
- 採用: 有効にするときだけ DB で引用を必須にし、その後に失ったら unsupported と表示する。棄却: 引用を失ったら決定を candidate に戻す（任意の補足のせいで決定そのものが落ち、forget のやり直しでも決定が落ちる）
- 採用: ファイルの有無を別に調べ、関数名が見つからないものは別の見出しにする。棄却: `checkAnchor` の `missing` をそのまま「ファイルが消えた」とする（関数名だけ消えたものも混ざる）
- 採用: git では未追跡の ignore されていないファイルも走査する。棄却: 追跡済みだけ（貼ってコミットする前の規約ファイルを見落とし、git の外のプロジェクトを見られない）
- 採用: live は unit id を目印にページを送る。棄却: 件数で飛ばす（ページの間に記録が変わると取りこぼす）
- 採用: look は頼まれたときだけ。棄却: セッション開始時に 1 日 1 回知らせる（毎回の全件走査と、同じ日の後から出たものを隠す）
- 採用: 条件の文面を見せるだけ。棄却: 条件を自動で判定する（issue が自動の適用を禁じていて、文章の条件は機械では決まらない）

## 手順

- S1: schema revision 3（`reconsider_when`、role `reconsiders`、トリガー、FTS と content_hash）、migration `0003.sql`、db-types、revision 2 の fixture、移行テスト
- S2: record_check / record_save の `reconsider_when` と `reconsider_quote`、trace Skill の説明、保存と拒否のテスト
- S3: `read` に見直し条件と引用、unsupported の表示
- S4: ファイルの有無の検査（親の symlink を含む）と規約ファイルの列挙（git と git の外）を anchors.ts かその隣に足す
- S5: `overview` の live（ページ送り、まとめ方、上限）とテスト
- S6: `overview` の look（4 つの見出しと確かめられなかった件数）とテスト、forget と取り消しの回帰テスト
- S7: `/sphica:rules` Skill と Claude・Codex の呼び出し設定
- S8: acceptance の case、`sql:reach` の確認
- S9: release:plan、0.6.4 へのバージョン揃え、パッケージの中身と両ホストへの届き方の確認

## 完了条件

- A1: `bun run verify` → 0 で終わる
- A2: `cd server && node --test --test-timeout=60000 test/migrate.test.ts` → revision 2 から 3 への移行が新規の DB と一致し、案と evidence の行と id が残る
- A3: `cd server && node --test --test-timeout=60000 test/overview.test.ts` → live が fixture の有効な決定と制約を全件出し、superseded と withdrawn を 1 件も出さない。ページの間に supersede された記録があっても残りを取りこぼさない
- A4: `cd server && node --test --test-timeout=60000 test/overview.test.ts` → look の Files gone に消したファイルの記録、Symbol not found に関数名だけ消えた記録、Reconsider conditions に引用付きで保存した条件が出る
- A5: `cd server && node --test --test-timeout=60000 test/overview.test.ts` → マーカー付きの行の記録を supersede すると、look の Rule markers にその `path:line` と後継のキーが出る
- A6: `cd server && node --test --test-timeout=60000 test/forget.test.ts` → 見直し条件の引用だけを含む source を forget しても決定は active のままで、look と read に unsupported と出る
- A7: `bun run release:plan -- --base <v0.6.3 のコミット>` → `plugin`。npm と 3 つの manifest が 0.6.4
- A8: `npm pack --pack-destination <一時ディレクトリ>` → 展開した中に `overview` ツールと `rules` Skill が入っている。plugin-release Skill の手順で起動し、Claude と Codex の両方で `overview` が呼べ、`/sphica:rules` と `$sphica:rules` が明示的な呼び出しで動く
- A9: `gh pr checks <PR 番号> --watch` → 全ジョブが pass

## リスク

- 規約ファイルやアンカーが多いプロジェクトで look が遅い → 上限で止めて件数を出す。遅さが問題になったら、セッション開始時の通知を入れる前に費用を測る
- migration でテーブルを作り直すときに、参照するトリガーやビューを消し忘れて rename が失敗する → 移行テストが新規の DB と比べるので落ちる。落ちたら依存を洗い直す
- `reconsiders` を足した role の対の値（`server/src/knowledge.ts:26` など）を直し忘れる → `rg reconsiders` と `rg "'explains'"` で対を全部当たる
- 規約ファイル由来の文字列で行を偽造される → 行の本文は出さず、`path:line` とキーだけを出す

## 未解決

なし

## 変更履歴
2026-09-29 / 有効化の検査は取り消し済みの引用でも通す / glean が引用だけを取り消して判定し直すと、決定が candidate に落ちていた（PR #225 の Codex review）。「引用を失っても決定は active のまま、条件は unsupported と出す」という合意に合わせた / Go 不要（合意した方針の中の直し）
