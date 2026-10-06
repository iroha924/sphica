---
kind: plan
status: approved
codex_session: 01a1109e-b566-7611-9b02-48f72d156d09
codex_rounds: 2
approved_at: 2026-10-06
---

# review コマンド名と自動 trace の停止を Claude Code plugin の userConfig で設定できるようにする（#280）

## 要点

- Claude Code の plugin に `userConfig` を 2 つ足す: `review_commands`（文字列）と `auto_trace`（真偽値）。/config（2.1.269 以上）や有効化時の dialog で設定でき、settings.json の env を手で書かなくてよくなる
- review: userConfig に名前が 1 つ以上あればそれだけを使い、無ければ今までどおり `SPHICA_REVIEW_COMMANDS` を使う
- 自動 trace: userConfig と `SPHICA_AUTO_TRACE` のどちらかが off なら止める。env で止めている人は、userConfig を変えても止まったまま
- 実装の塊: 読む側 2 か所とテスト → manifest と README、対話の dialog の実測 → バージョンを 0.6.38 に上げて release
- その release run で #268（承認前の OSV スキャン、merge 後の main のスキャンの再実行）を初めて実地で確かめ、見届けてから #268 を閉じる
- 変えないもの: Codex 側（userConfig 相当が無い）、hook の起動の形（hooks.json）、env の設定の効き方、最低バージョン 2.1.139

## 持ち主の決定

- 次の作業は H2 #280 を先にする（Project の並びの H1 → H2 を入れ替え、release run で #268 の確認も兼ねる）
- #280 の要求: review コマンド名を `userConfig` にし、`SPHICA_REVIEW_COMMANDS` にフォールバックする。`options` は使わない
- 自動 trace の停止設定を同じ仕組みに載せるかは計画で決める（#280 の本文）

## 目的

- Claude Code の利用者が、/config の行か有効化時の dialog で review コマンド名と自動 trace の停止を設定でき、hook がその値で動く
- settings.json の env で設定していた利用者の動きは変わらない
- 0.6.38 の release run の summary と承認を頼む PR コメントに、タグのコミットの OSV スキャン結果が出て、merge 後に main の OSV と Scorecard の run が成功する

## 対象外

- Codex（plugin に userConfig 相当が無く、review の hook も自動 trace も Claude Code だけ）
- `options`（2.1.271 未満で plugin が読み込めなくなる）、`multiple`（env への文字列化が文書に無い）、`sensitive`
- hook の `args` で `${user_config.KEY}` を渡す形（hooks.json と起動の形が変わる。env で足りる）
- `CLAUDE_PLUGIN_OPTION_<KEY>` を読む共通関数（読む所が 2 か所で判定も違う）

## 前提

- 公式（https://code.claude.com/docs/en/plugins-reference の User configuration、2026-10-06 取得）: `type` は string / number / boolean / directory / file、`title` と `description` が必須。値は有効化時に prompt され、非 sensitive は settings.json の `pluginConfigs."<name>@<marketplace>".options` に保存。hook のプロセスには `CLAUDE_PLUGIN_OPTION_<KEY>`（KEY は大文字化）で export。/config の行は 2.1.269 以上。userConfig 自体の最低バージョンの記述は無い
- 実測（2026-10-06、一時の `HOME` と `CLAUDE_CONFIG_DIR`、ダミーの API キー、`claude -p --plugin-dir <probe>`、SessionStart の exec form hook が env を書き出す）。2.1.139 は npm の `@anthropic-ai/claude-code@2.1.139`（2026-05-11 公開、anthropic.com の maintainers）の native binary、2.1.291 は手元の `claude`
  - 値を保存していないとき: 両バージョンで plugin が読み込まれ hook が走る。`CLAUDE_PLUGIN_OPTION_*` は出ない（`default` は export されない）
  - `pluginConfigs` に保存したとき: 両バージョンで `CLAUDE_PLUGIN_OPTION_REVIEW_COMMANDS="audit, check-pr"`、`CLAUDE_PLUGIN_OPTION_AUTO_TRACE="false"`
  - headless では dialog で止まらない
- 未検証: 対話の有効化・更新での dialog と、そこで確定・取消したときの動き（S3 で実測）、`true` の文字列化（"true" と推測。読む側は off 系だけを見るので結果は変わらない）
- 今の読み取り: `server/src/review-bridge.ts:36`（`SPHICA_REVIEW_COMMANDS`）、`server/src/deliver.ts:584,984`（`AUTO_TRACE_OFF` と `SPHICA_AUTO_TRACE`）
- 自動 trace の停止を env にしたのは、userConfig の真偽値が 2.1.139 で読めるかが確かめられなかったため（Sphica の記録 u234・u242）。上の実測でこの理由は無くなった

## 方針

- `plugin/.claude-plugin/plugin.json` に足す:
  - `review_commands`: `{"type": "string", "title": "Review commands", "description": "<名前に review を含まない自分の review コマンドを、カンマ区切りで>", "default": ""}`
  - `auto_trace`: `{"type": "boolean", "title": "Automatic trace", "description": "<新しいセッションの開始時に、trace されていない古いセッションを trace させるか>", "default": true}`
  - `required` は付けない
- review（`reviewCall`）: `CLAUDE_PLUGIN_OPTION_REVIEW_COMMANDS` を今と同じくカンマで分け、trim・小文字化し、空を除く。名前が 1 つ以上残ればそれだけを使い、残らなければ（未設定・空・空白・カンマだけ）`SPHICA_REVIEW_COMMANDS` を同じ手順で使う
- 自動 trace: `CLAUDE_PLUGIN_OPTION_AUTO_TRACE` と `SPHICA_AUTO_TRACE` のどちらかが `AUTO_TRACE_OFF`（off / 0 / false / no、trim・小文字化）に当たれば止める。既存の条件（新しい対話の Claude Code セッションだけ、headless・resume・subagent は対象外）は変えない
- 各所で `process.env` を直接読む
- README.md と README.ja.md:
  - 自動 trace の段落（README.md:23）: /config の `auto_trace`（2.1.269 以上）か settings.json の env で止められる。env で止めている間は /config で戻しても再開しない
  - review の段落（README.md:113-114）: /config の `review_commands`（2.1.269 以上）か `SPHICA_REVIEW_COMMANDS`。両方あれば /config の値を使う
  - S3 の実測で、dialog を取消すと plugin が無効になるなど今の動きを保たない操作が分かれば、保つ操作だけを書く
- テスト（`server/test/review-bridge.test.ts`、`server/test/deliver.test.ts`）。env はテストごとに保存・削除・復元する
  - review: UserPromptExpansion と PreToolUse/Skill の両経路で、option 未設定・空・空白・カンマだけ（→ env が効く）、非空（→ option の名前が効き、env だけにある名前は効かない）、大小文字と余白、複数名
  - 自動 trace: option 未設定、"true"、"false"、env の off/0/false/no、option off と env on、option on と env off、止めた後の 1 日 1 回の手動の案内。headless・resume・subagent では option が on でも自動 trace しない
  - option を読まない今のコードで、option のケースが意図した理由（option の名前が効かない、option の false で止まらない）で落ちることを先に確かめる
- バージョンは 0.6.38（npm と 3 つの manifest）。PR 本文は `Refs #268`（Closes を書かない。release-finish が閉じてしまうため）

## 採った案と棄却した案

- 採用: review は userConfig に名前があればそれだけ、無ければ env。棄却: 両方の和集合（#280 の要求はフォールバック）
- 採用: 自動 trace はどちらかが off なら止める。棄却: userConfig を優先（env で止めている人を userConfig の既定や誤操作で再開させない）
- 採用: auto_trace も同じ PR。棄却: review だけ（真偽値が 2.1.139 でも渡ると実測したので、分ける理由が無い）
- 採用: 各所で env を直接読む。棄却: 共通関数（2 か所で判定が違い、キーの変換しかしない）
- 採用: 対話の dialog は 2.1.291 だけで実測。棄却: 2.1.139 の対話も見る（値の受け渡しは headless で同じと確かめた。/config は 2.1.269 以上でしか出ない）
- 採用: dialog が出るだけでは止めない。棄却: dialog が出たら出さない（既存の設定が消えるか設定を終えられないときだけ止める）

## 手順

- S1: review コマンド名を userConfig から読み、env にフォールバックする（コードとテスト）
- S2: 自動 trace を userConfig と env のどちらかの off で止める（コードとテスト）
- S3: plugin.json に userConfig を足し、`claude plugin validate` を通し、2.1.291 の対話で dialog を実測する。一時の `CLAUDE_CONFIG_DIR` とローカルの marketplace で (a) 新規に入れて起動、(b) userConfig の無い版を入れてから新しい版へ更新して起動。それぞれで dialog を空・default のまま確定した後と取消した後に、plugin が有効か、hook が走るか、settings.json の既存の env が効くかを見る。既存の設定が消えるか設定を終えられないなら、release の前に止めて持ち主に戻す
- S4: README.md と README.ja.md を S3 の結果に合わせて直す
- S5: バージョンを 0.6.38 に上げる（`bun run release:plan -- --base v0.6.37` で kind が plugin になることを確かめる）
- S6: release。plugin-release Skill をその都度読み直し、そのとおりに進める。承認の前に、run の summary と PR コメントの OSV 結果がタグの SHA のものかを確かめる。merge 後に refresh-scans が dispatch した OSV と Scorecard の run の URL・main の SHA・結論を確かめ、両方成功なら #268 を閉じる。見られなければ #268 は開けたまま

## 完了条件

- A1: `bun run verify` → exit 0
- A2: `cd server && node --test test/review-bridge.test.ts test/deliver.test.ts` → 全件 pass
- A3: `claude plugin validate plugin` → `Validation passed`（警告なし）
- A4: `rg -n "確定|取消" .claude/plans/2026/10/06-h2-userconfig.tasks.md` → T03 の結果欄に、新規と更新のそれぞれで確定と取消の後の plugin の有効状態・hook・既存の env の効き方の行がある
- A5: `gh pr checks <PR 番号>` → 全件 pass
- A6: `gh pr view <PR 番号> --comments` → 承認を頼むコメントに、タグの SHA の OSV の結果（found / none / unavailable）の行がある
- A7: `npm view sphica version` → `0.6.38`。`bun run release:status` → `release ledger is consistent`
- A8: `node -e 'console.log(Object.keys(require(process.env.HOME + "/.claude/plugins/cache/sphica/sphica/0.6.38/.claude-plugin/plugin.json").userConfig))'` → `[ 'review_commands', 'auto_trace' ]`
- A9: `gh run list --workflow osv-scanner.yml --branch main -L 1` と `gh run list --workflow scorecard.yml --branch main -L 1` → release の merge コミットの run が success。`gh issue view 268 --json state` → `CLOSED`（確かめた後に手で閉じる）

## リスク

- 取消すと plugin が無効になる → README には確定する操作だけを書く。dialog が出るだけなら止めない
- 更新時に既存の settings.json の env が効かなくなる → release の前に止めて持ち主に戻す
- 承認前の OSV が unavailable、または refresh-scans の dispatch が失敗する → 公開済みの release はやり直さない。#268 を開けたまま原因を追う
- `claude plugin validate` が既存の manifest に警告を出す → 今の main で同じ警告が出るかを見て、userConfig 由来でなければこの PR では直さない

## 未解決

なし

## 変更履歴
