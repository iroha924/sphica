---
kind: plan
status: approved
codex_session: 01a13f52-796b-7dd1-bc07-798e362b795e
codex_rounds: 3
approved_at: 2026-10-15
---

# 基準に届かなかった shell_write_delivery の試用（#219）を、設定・hook・コードごと外す

## 要点

- シェルの呼び出しの後の配信を外す。Claude Code の PostToolUse / PostToolUseFailure（Bash|PowerShell）と Codex の PostToolUse（^Bash$）の deliver の登録、設定 `shell_write_delivery` と `SPHICA_SHELL_WRITE_DELIVERY`、Pre での hash の控え（`shell-state.ts`）、試用のログを消す
- 試用の結果を `server/evals/post-write/shell-write-trial.json` に、母集団・標本・両者のラベル・数え方つきで残す
- テスト・検査・CI・scale・README・ARCHITECTURE から、この機能の分だけを外す。外れたことは退行テストと、パックした hook の検査で確かめる
- 0.6.60 として出す。持ち主の手元で、設定をオンにしたまま更新しても後の配信が出ないことを確かめる
- 変えないもの: シェルの呼び出しの前の配信（ファイルの名指し、行き止まりのコマンドで止める）、読む前・編集の前・プロンプト・セッションの開始・review の配信、capture、schema、#219 の入口の測定（M0'）のデータとスクリプト、手元に残る `~/.sphica/shell-state/` と delivery の行

## 持ち主の決定

- 試用は基準に届かなかった（noise 37/40、基準は 1/3 以下。会話あたりの 90 パーセンタイルは 4 で基準内）。#308 の計画のとおり、設定とコードを外す（2026-10-15、「1」）
- #219 への結果のコメントは投稿済み（issuecomment-6190949685、文面は持ち主が承認）
- 試用は 0.6.59 のリリースの前（2026-10-15T07:04:29Z）で区切る（前のセッションで持ち主が決定）

## 目的

- 更新後、どちらのホストでもシェルの呼び出しの後に Sphica の hook が走らず、呼び出しの前に監視するファイルの控えを取らず、`~/.sphica/shell-state/` に何も書かない
- ほかの配信はすべて main と同じに動く
- 試用の結果を、後から同じ数を出し直せる形でリポジトリに残す

## 対象外

- 編集の前の配信の「ファイル単位で最大 5 件」の選び方。試用の noise の原因と同じ形だが、測っていない
- 持ち主の DB の reason `shell_write` の delivery の行（履歴。delivery-view は pre_edit のイベントとして出す）
- 手元に残る `~/.sphica/shell-state/`。何も読まず、既定の home なら uninstall が消す。init や doctor での片付けも移行も足さない
- #219 の入口の測定（`server/evals/post-write/m0*.json`、`replay.ts`、`shell-miss.ts`、`transcript.ts` とそのテスト）。試用の動機になった漏れの測定で、外す機能のものではない
- `CODEX_TRUST_VERIFIED` を広げること

## 前提

- 後の配信だけのための hook: `plugin/hooks/hooks.json` の PostToolUse `Bash|PowerShell` と PostToolUseFailure `Bash|PowerShell`（どちらも deliver.js）、`plugin/hooks/codex.json` の PostToolUse `^Bash$`（deliver.js、0c94b3ed で足した）
- hook の形を固定する検査: `scripts/check-ai-config.mjs:310-320`（Codex）と `:340-349`（Claude Code）。`server/test/codex-trust.test.ts:67-81` は `post_tool_use:1:0` の key を期待している
- Codex の hook の信頼は handler ごとに `event/group/handler` の key と hash で持つ（`server/src/codex-trust.ts:169-183`）。外すのは PostToolUse の最後の group なので、残る hook の key と hash は変わらない（Codex が darwin・linux・win32 で実測。確かめた Codex のバージョンは 0.160.0 のみ、`codex-trust.ts:4-11`）。公式は新しい・変わった hook の確認を求める（https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks）
- 設定: `plugin/.claude-plugin/plugin.json` の `userConfig.shell_write_delivery`、環境変数 `SPHICA_SHELL_WRITE_DELIVERY`、読むのは `shellWriteDelivery()`（`server/src/deliver.ts:941`）
- この機能だけが使うコード: `server/src/shell-state.ts`（deliver.ts とそのテストだけが import）、`anchoredRules`（`deliver.ts:329`、呼ぶのは `afterShellWrite` とテストだけ）、`afterShellWrite`、`afterShell`、`snapshotCall`、`trialLog`、`rotateTrial`、`TRIAL_CAP`、`SNAPSHOT_MS`、`SHELL_WRITE`、`SHELL_WRITE_ON`、`AFTER_CHANGE`、`deliver()` の `snap` の分岐と 2 つの `!snap`
- 残すもの: `deliverablePaths`（`namedInCommand` が使う、`deliver.ts:719`）、`SHELL_TOOLS`、`sinceRestart`、`anchoredTo`、`shellPatch`、`REVIEW_MS`、`AUTO_TRACE_OFF`、capture の PostToolUse の登録
- `deliverablePaths` のテストは `server/test/shell-state.test.ts:416-465` にある
- Windows の CI は `.github/workflows/check.yml:246-247` で `shell-write-harness.ts` を流している。`scripts/check-hooks-live.mjs:310-331` は後の配信を確かめ、`:540` の成功の文面がそれを言う。`:103-107` は当たる handler が無いと失敗にする
- 古いプラグインのキャッシュは古い bundle も持つので、更新して読み込み直すまでは、設定がオンなら古い動きが続く（`.agents/skills/plugin-release/SKILL.md:27-31`、`:171-177`）
- `sphica uninstall` は既定の home だけを消し、`SPHICA_HOME` があれば断る（`server/src/cli.ts:545-561`）
- 試用の数（2026-10-15 に持ち主の DB の外のファイルを読み取りだけで集計）: 期間 2026-10-12T04:11:00Z（試用のログの最初の行は 04:11:33.810Z）〜 2026-10-15T07:04:29Z。試用のログ 3,111 行（post_shell 2,976、snapshot_missing 135、セッションを持たない集計の行 0）。配信のあった post_shell の行 53 と、Claude Code の会話記録の差し込み 53 が host:tool_use_id で両方向に一致。Codex の行は 0。会話は 47（配信 0 の会話を含む）、90 パーセンタイル 4、最大 17
- Claude Code が manifest から消えた userConfig の key の保存値をどう扱うかは未検証（完了条件 A9 で確かめる）

## 方針

- hook: hooks.json から PostToolUse の `Bash|PowerShell` の group と PostToolUseFailure の項目ごと、codex.json から PostToolUse の `^Bash$` の group を消す。capture の PostToolUse（Edit 系と apply_patch）は残す
- 形の検査: check-ai-config.mjs の固定の形から同じ group を消す。codex-trust.test.ts の「0.6.30 以降に足した hook」のテストは、新しい key が無いこと（darwin・linux で SHIPPED の key が OLD の key に含まれ、hash も同じ）と、`post_tool_use:1:*` の key が無いことを確かめる形にする
- 設定: plugin.json の `shell_write_delivery` を消し、環境変数を読むコードを消す。持ち主や利用者の保存した設定は Sphica からは変えない
- コード: 前提に挙げた、この機能だけが使うものを消す。使わなくなった import（`sphicaHome` ほか）と、控えにだけ触れるコメント（`deliver.ts:158`、`:1517`、`:1591`）も消す。古い hook の定義から PostToolUse / PostToolUseFailure が来ても、新しい bundle は何も返さない（`deliver()` にその分岐が無い）
- テスト: `shell-state.test.ts` を消す前に、`deliverablePaths` のテスト（`:416-465`）を deliver.test.ts に移す。`shell-write-harness.test.ts`、`server/evals/post-write/shell-write-harness.ts`、`real-host.md`、deliver.test.ts と deliver-codex.test.ts の後の配信のテスト、`anchoredRules` のテストを消す
- 退行テスト（deliver.test.ts）: `CLAUDE_PLUGIN_OPTION_SHELL_WRITE_DELIVERY=true` と `SPHICA_SHELL_WRITE_DELIVERY=on` の下で、ファイルを名指さない PreToolUse の Bash、記録の付いたファイルへの書き込み、PostToolUse と PostToolUseFailure の順に流し、どれも "" で、一時の `SPHICA_HOME` に `shell-state` が無い
- check-hooks-live.mjs: (a) 形の検査: 読み込んだ hooks.json に Bash か PowerShell に当たる PostToolUse / PostToolUseFailure の group が無く、codex.json に `^Bash$` の PostToolUse の group が無い（fire を通さない）。(b) 古い呼び出しの検査: パックした `dist/deliver.js` を直接起動し、同じ 2 つの設定をオンにして、上と同じ流れで PostToolUse と PostToolUseFailure がどちらも何も出さずに 0 で終わり、一時の home に `shell-state` が無い。成功の文面から後の配信を外す。ふつうの fire の呼び出しは厳しいまま
- CI: check.yml から harness の手順とその注記の行を消す
- scale: `server/evals/scale/run.ts` から `shellRows` と試用のログのパスを消す
- 文書: README.md と README.ja.md の試用の項目（35 行目）、124 行目、表の行（138 行目）を消す。141 行目は `SPHICA_SHELL_WRITE_DELIVERY` の文だけ、148 行目は `shell-state` の文だけを消す。ARCHITECTURE.md:28 は `shell-state/` の句だけを消す。knip.json から harness の entry を消す
- 試用の記録 `server/evals/post-write/shell-write-trial.json`（会話記録のコマンドの文面は入れない）:
  - window: start と cut と、区切った理由（#218 のシェルの前の配信が混ざるため）
  - inputs: 読んだ trial.jsonl と、使った会話記録の各ファイルの sha256
  - population: Claude Code の会話記録の PostToolUse の hook の attachment で、additionalContext が後の配信の固定の lead で始まるもの。tool_use_id で重複を除く。照合の対象は、配信のある post_shell の行（53）と差し込み（53）で、host:tool_use_id で両方向に照らす。配信 0 の行と snapshot の行は件数だけを出す。Codex は試用のログに 0 行
  - sampling: 時刻、次に id で並べた母集団を mulberry32 で shuffle、seed 20261015、先頭の 40
  - labels: #308 の計画で固定した useful / noise / unknown の定義。標本ごとに session、tool_use_id、変わったパス、届いた key、Claude と Codex のラベル、決着
  - 結果: noise k/n と Wilson 95%、会話ごとの件数（セッションを持つ行だけで host:session:agent を key に、配信 0 の会話を含む）、セッションを持たない集計の行の数、90 パーセンタイルの取り方（nearest rank、ceil(0.9n)）、判定
- バージョン: `bun run release:plan` を流してから、npm と 3 つの plugin manifest を 0.6.60 に上げる（最初にパッケージの入力を変えるコミット）
- リリースノート: 試用の設定を外したこと。両ホストの更新のコマンドと、開いている Claude Code のセッションで `/reload-plugins`、Codex は開き直すこと（それまでは、設定がオンなら古い bundle が後の配信を続ける）。Codex では `/hooks` を開き、Sphica の hook に新しい・変わったものがあれば信頼すること（無い見込み）。手元に残る `~/.sphica/shell-state/` は何も読まず、消してよいこと

## 採った案と棄却した案

- 採用: 計画どおり設定とコードを外す。棄却: 既定オフのまま残し、届ける記録を絞る新しい実験にする（持ち主が 1 を選んだ）
- 採用: 手元の `shell-state/` と delivery の行は残す。棄却: init か doctor で消す、移行で消す（何も読まず、uninstall が消すので、書き込みの経路を増やす理由が無い）
- 採用: hook が無いことは読み込んだ JSON で、古い呼び出しは bundle の直接起動で確かめる。棄却: fire で確かめる（当たる handler が無いと失敗にする作りで、外したことを確かめられない）
- 採用: Codex の信頼は、doctor が確かめられるバージョンなら doctor、そうでなければ持ち主の `/hooks` で判定する。棄却: Codex のどのバージョンでも信頼のやり直しが要ると書く（key と hash が変わらないことを実測した）
- 採用: 完了の検索は `git grep` で隠しファイルも含め、許す箇所を挙げる。棄却: 隠しディレクトリを飛ばす `rg` だけ（check.yml を見落とした）

## 手順

- S1: hook の登録と、その形の検査（check-ai-config.mjs、codex-trust.test.ts）、設定、バージョン
- S2: deliver.ts と shell-state.ts からこの機能のコードを消し、`deliverablePaths` のテストを移し、退行テストを足す
- S3: harness・CI・check-hooks-live.mjs・scale・knip から、この機能の分を外し、check-hooks-live.mjs に 2 つの検査を足す
- S4: README.md・README.ja.md・ARCHITECTURE.md の記述
- S5: 試用の記録 `shell-write-trial.json`

## 完了条件

- A1: `git grep -n -i -E "shell_write|shellWrite|SHELL_WRITE|shell-state|shell-write|trialLog|afterShell|snapshotCall|anchoredRules|takeStates|post_shell"` → 当たるのは `server/evals/post-write/shell-write-trial.json`、退行テスト（`server/test/deliver.test.ts`、`scripts/check-hooks-live.mjs`）、M0' の測定のファイル（`server/evals/post-write/m0-shell.json` と、名前を出していれば `shell-miss.ts`）、`.claude/plans/` だけ
- A2: `bun run verify` → 終了コード 0
- A3: `bun run test` → 全件 pass（verify は全テストを含まない）
- A4: `bun run release:plan -- --base <v0.6.59 のコミット>` → release kind `plugin`、npm・plugin・marketplace・Codex がすべて 0.6.60
- A5: `npm pack` を リポジトリの外に展開して `node scripts/check-tarball.mjs` → 通る。展開した `dist/deliver.js` に `shell-state` も `shell_write` も無く、hooks.json に Bash|PowerShell の PostToolUse と PostToolUseFailure が無く、codex.json に `^Bash$` の PostToolUse が無い。CLI と MCP を別々に起動して答える
- A6: `claude -p --plugin-dir <展開したパッケージ>` → リリースの前の実機で、`codex exec` も合わせて、HOME・CLAUDE_CONFIG_DIR・SPHICA_HOME を一時のディレクトリに向け、パックした CLI の init で一時の DB を用意し、Codex は一時の CODEX_HOME のローカルの marketplace に展開したパッケージを入れて流したとき、正の確認（読む前・編集の前・ファイルを名指すシェル・行き止まりのコマンドで止めて再実行は通る・review の配信が出て、delivery の行もある）は、確認ごとに別の会話か別の記録を使う。負の確認: 名指さないシェルの書き込みの後に何も出ず、一時の home に `shell-state` が無い。使い捨ての Codex で信頼の bypass を使ったら、そう書く（信頼の証明にはしない）
- A7: scale: main と作業ブランチで `node server/evals/scale/run.ts` → 残るケースの before/after の表で、中央値が 5 ms を超えて遅くなるケースが無い
- A8: `gh pr checks <PR>` → Windows を含む全項目が pass。`gh api graphql` で数えた PR の未解決のレビュースレッドが 0
- A9: `wc -l ~/.sphica/shell-state/trial.jsonl` → リリースの後、持ち主の手元で更新の前後に流して、行が増えない。0.6.60 に更新して `/reload-plugins` の後、記録の付いたファイルを名指さずに書き換える Bash の呼び出しで、会話記録に後の配信が無く、更新の時刻より後に trial.jsonl の行が増えない。Claude Code の設定はオンのままで確かめる。Codex は試用を流していないので、該当なしと書く
- A10: `bun run release:status` → リリースの後に流して、一致を報告し、両ホストのキャッシュが 0.6.60。`sphica doctor` が入っている Codex のバージョンの信頼を確かめられるなら Sphica の hook が trusted、確かめられないなら doctor の行は unknown と記録し、持ち主の `/hooks` で Sphica の hook に新しい・変わったものが無い

## リスク

- 外し漏れで、古い経路が呼ばれずに残る → A1 の検索と A5 の bundle の検査で見つけ、同じ PR で消す
- 外しすぎで、シェルの前の配信や行き止まりの停止が壊れる → 既存の受け入れケースと A6 の正の確認で見つけ、戻す
- Codex で hook が新しい・変わったと出る → 持ち主に `/hooks` で信頼してもらい、key と hash が変わった理由を調べてリリースノートを直す
- 更新しても古いキャッシュが残り、後の配信が続く → リリースノートの手順で読み込み直してもらい、`release:status` で両ホストのバージョンを確かめる

## 未解決

なし

## 変更履歴
