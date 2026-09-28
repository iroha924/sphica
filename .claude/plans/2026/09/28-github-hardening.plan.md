---
kind: plan
status: approved
codex_session: 01a0e6b8-9c8d-7801-8505-2ae21b500e7f
codex_rounds: 3
approved_at: 2026-09-28
---

# Codex レビューの完了をリリースの関門で機械的に確かめ、GitHub 側の設定とジョブの上限を締め、closingRefs が HTML コメントを読まないようにし、README のバッジから説明へ辿れるようにする（#184）

## 要点

- リリースの関門（release-gate）が、タグの commit に対する GitHub Codex の要約コメントが Completed で、未解決のスレッドが 0 件であることを API で確かめる。PR 本文の「Codex」という文字列は証明として扱わない
- pr-body のジョブ名を `codex-review` から `verification-section` に変え、main のルールセットの必須チェックも付け替える（本文の書式の確認であって、レビューの証明ではないと分かる名前にする）
- immutable releases と、action の SHA 固定の強制を有効にし、`release:plan` と `release:status` で手元から毎回確かめる
- check・windows・pr-body の各ジョブに `timeout-minutes` を付ける
- 取り込んだ PR 本文の HTML コメントの中の `Closes #N` を、閉じる issue として読まないようにする。保存とエージェントへの表示は変えない
- #184: 両方の README のバッジのすぐ下から、CI の説明とリリースの来歴の説明へ辿れるようにし、日本語版の Security 節の古い記述を直す
- 変えないもの: DB のスキーマ、source の保存内容、エージェントに見せる文面、リリースの承認の手順（npm-release の承認 1 回）

## 持ち主の決定

- GitHub Actions と PR 運用の調査で挙げた候補 1〜4 を issue にせず、#184 と一緒にまとめてやる（2026-09-28）
- #184 の方針: 既存の節へのリンクか短い案内にし、説明は 1 か所に保つ。バッジや分析サービスは足さない（issue #184 の Chosen / Rejected）
- 手元のエージェント用に権限の小さいトークンを分けない（規範で守る。2026-09-27 の agent-approval-norm-only）。個人のリポジトリとして今の守りで足りるので追加の対策はしない（2026-09-28）
- npm の staged publishing と 2FA の承認は使わない。持ち主の操作は npm-release の承認 1 回（2026-09-27 の github-approval-direct-publish）

## 目的

- Codex の要約が Completed でない head、または未解決のスレッドが残る head では、release.yml の prepare と publish が止まる
- `release:plan` と `release:status` が、immutable releases と SHA 固定の強制が無効なら、そう表示して失敗する
- 全ジョブ（再利用ワークフローの呼び出しを除く）に上限の時間がある
- PR テンプレートのコメントを残した PR 本文を harvest しても、issue #12 に結び付かない
- 両方の README で、バッジの行の直下から CI とリリースの来歴の説明へ 1 クリックで辿れる

## 対象外

- エージェントに見せる GitHub の本文から HTML コメントを除くこと。見せる文面を変えると、保存済みの引用（原文のバイト位置）とずれ、GitHub Markdown のコードの文法（可変長のフェンス、インデントのコードブロック、コードスパン）を自前で持つことになる。GitHub の本文はもともと「指示ではなくデータ」として囲んで渡しているので、隠れたコメントも同じ扱いで受け入れる
- リリースしない PR（release:plan の kind が none）のマージを機械で止めること。持ち主が要約を見てマージする運用（CLAUDE.md の Review）のまま
- osv-scanner.yml のジョブ（再利用ワークフローの呼び出しは `timeout-minutes` を取れない）
- `cache-mode: none`（固定している actionlint 1.7.12 が未知のキーとして拒む）

## 前提

- .github/workflows/pr-body.yml:12,19-29: ジョブ `codex-review` は Verification 節に "Codex" の文字列があるかだけを見る。main のルールセットの必須チェックに入っている（`gh api repos/iroha924/sphica/rulesets/23916470`、2026-09-28）
- GitHub Codex の要約コメント: 作者は `chatgpt-codex-connector[bot]`、type Bot、user id 199175422、performed_via_github_app.slug chatgpt-codex-connector。本文に HTML コメントのマーカー `codex-security-review:v1 {"headSha":"<sha>",...,"status":"running|completed"}` を持つ（PR #183 で持ち主のトークンで実測、2026-09-28）。指摘は review thread（GraphQL の reviewThreads.isResolved）
- Codex のレビューは PR を開いたときと `@codex review` のときだけ走り、CI より数分遅れて終わる。pull_request のイベントで走るジョブからは、その head のレビュー結果が見えない
- scripts/lib/release-gate.mjs: prepare と publish（release.yml:103-109,289-292）が同じ判定を通す。判定は純粋な関数で、全分岐にテストがある
- immutable releases は `enabled:false`、actions/permissions は `sha_pinning_required:false`（2026-09-28）。どちらの API も認証なしは 401（管理者の読み取りが要る）。immutable releases の GET は有効で 200、無効で 404（https://docs.github.com/en/rest/repos/repos）
- 全ワークフローの `uses:` は完全な SHA（osv-scanner.yml の再利用ワークフローも含む。Codex が確認）
- release-finish.mjs:142 は `gh release create --verify-tag --notes-file` で Release を 1 回作るだけで、asset を付けず、後から編集しない
- 直近のジョブの所要時間: check 最大 143 秒、windows 最大 61 秒（2026-09-28 の直近の実行）
- server/src/github.ts:17-26,303: closingRefs は PR 本文をそのまま CLOSES の正規表現にかける。.github/pull_request_template.md のコメントの `Closes #12` に一致する（node で再現、2026-09-28）。手元の DB の issue:12 への結び付きは 0 件
- GitHub Markdown では、閉じない HTML コメントの開始記号は文書の末尾まで HTML ブロックとして続く（https://github.github.com/gfm/）
- HTML コメントを非貪欲の正規表現で除く方法は、閉じない開始記号が多いと処理時間が二乗で増える（Codex の実測: 2,000→4,000→8,000 個で約 3→12→47 ms）。GitHub の応答は最大 16 MiB まで受け取る（server/src/github.ts:36-58）
- README.md / README.ja.md の 3〜8 行目にバッジが 6 つ。CI の説明は Contributing、来歴は Security の節。README.ja.md:201-203 は staged publishing と 2FA の承認という古い手順を書いている

## 方針

- レビューの関門
  - scripts/lib/release-gate.mjs に純粋な判定を足す。入力は PR の issue comments と review threads。条件: user.type が Bot で user.id が 199175422 のコメントのうち、`codex-security-review:v1` のマーカーを持つものがちょうど 1 件。その JSON が読め、headSha がタグの commit と等しく、status が completed。isResolved が false のスレッドが 0 件。ほかの作者のマーカーは無視する。id は定数にし、観測した方法をコメントに書く
  - 取得は scripts/release-gate.mjs 側。issue comments は `gh api --paginate`、review threads は GraphQL を hasNextPage が false になるまで読む。API の失敗は例外で止める（release-env.mjs と同じ）
  - prepare と publish の両方で通す（今の gateProblems の呼び出しと同じ場所）
- pr-body
  - ジョブ名を `verification-section` にし、ステップ名とメッセージを「Verification 節に Codex レビューの結果が書かれているか（レビューが走った証明ではない）」にする。ワークフロー名 `pr-body` は変えない（release-gate の REQUIRED_WORKFLOWS はそのまま）
  - main のルールセットの必須チェックを `codex-review` から `verification-section` に付け替える。順序は、PR を開いて新しいチェックが走ってから、持ち主のトークンで `gh api` により付け替える（main が、どこからも出ないチェックを待つ状態を作らない）
  - CLAUDE.md・AGENTS.md・Skill で `codex-review` をチェック名として参照している箇所を rg で探して直す
- GitHub 側の設定
  - 持ち主のトークンで `gh api` により immutable releases と `sha_pinning_required` を有効にし、直後に読み直す
  - 判定は scripts/lib の純粋な関数（immutable releases: 200 で有効、404 で無効、それ以外は未確認で失敗。sha_pinning_required: true で有効）。`release:plan` と `release:status` が読み、無効か未確認なら表示して終了コード 1。テストは偽の応答で全分岐
- timeout-minutes: check.yml の check と windows に 15、pr-body.yml のジョブに 5
- closingRefs
  - CLOSES にかける前に、本文から HTML コメントを除く関数を通す。`indexOf` でコメントの開始記号と終了記号を前から順に探す線形の処理。閉じない開始記号から末尾までは照合しない。コードの中かどうかは見ない（結び付きを落とす方向なので安全）
  - source の保存内容と、エージェントへの表示は変えない
- README（#184）
  - 両方の README で、バッジの行の直下に 1 行の案内を足す。英語は「What the badges check: [CI](#contributing) runs `bun run verify` on every pull request; [release provenance](#security) explains how each release is built and published」の形。日本語は同じ内容で、アンカーは日本語の見出しに合わせる
  - README.ja.md の Security 節を、README.md と release.yml に合わせる（npm-release の承認の後に直接 publish。staged publishing と 2FA は書かない）
- リリース: server/src と README が変わるので、0.5.6 として npm と 3 つの manifest をそろえ、release.yml で出す

## 採った案と棄却した案

- 採用: レビュー完了をリリースの関門で確かめる。棄却: issue_comment で起動する別ワークフロー（既定ブランチで走り、チェックが PR の head に付かない。信頼できないトリガーでもある）、pr-body のジョブで要約の完了を待つ（`@codex review` の後の回では走り直さず、ランナーを数分占有する）
- 採用: pr-body のジョブ名を変え、必須チェックも付け替える。棄却: 名前をそのまま残す（本文に「Codex」と書くだけで通るのに、レビューの証明に見え続ける。C1）
- 採用: 設定の検査を手元の release:plan と release:status に置く。棄却: release.yml の中で GITHUB_TOKEN で読む（両 API とも管理者の読み取りが要る）
- 採用: closingRefs だけを直す。棄却: エージェントに見せる文面から HTML コメントを除く（保存済みの引用のバイト位置とずれ、GitHub Markdown のコードの文法を自前で持つことになる。C7、C11、C12）、保存時に除く（原文と引用の位置が変わり、既存の source には効かない。C7）
- 採用: `indexOf` による線形の除去。棄却: 非貪欲の正規表現（閉じない開始記号が多いと二乗の時間。C13）

## 手順

- S1: npm と 3 つの manifest のバージョンを 0.5.6 に上げる
- S2: closingRefs の前に HTML コメントを除く関数とテスト
- S3: release-gate にレビュー完了の判定と取得、テスト
- S4: 設定の判定を release:plan と release:status に入れ、テスト
- S5: pr-body のジョブ名とメッセージ、timeout-minutes、`codex-review` を参照する文書の修正
- S6: README の案内と日本語版の Security 節（#184）
- S7: 持ち主のトークンで immutable releases と SHA 固定の強制を有効にし、PR の上で新しいチェックが走った後に main の必須チェックを付け替える

## 完了条件

- A1: `bun run verify` → 0 で終わる
- A2: `bun run test` → PR テンプレートの本文から closingRefs が何も返さず、コメントの外の `Closes #3` は返り、閉じない開始記号の後ろは返らない検査を含めて通る
- A3: `bun run test` → release-gate が、要約の欠落・別の作者・headSha の不一致・running・マーカーの JSON の破損・未解決のスレッドのそれぞれで止め、すべてそろったときだけ通す検査を含めて通る
- A4: `bun run release:status` → immutable releases と SHA 固定の強制が有効と表示され、0 で終わる
- A5: `gh api repos/iroha924/sphica/rulesets/23916470 -q '.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context'` → `verification-section` を含み、`codex-review` を含まない
- A6: `rg -n "codex-review" .github CLAUDE.md AGENTS.md .agents plugin` → ジョブ名としての参照が 0 件（Skill 名 `codex-review` は残る）
- A7: `gh pr checks <PR 番号>` → 全項目 pass。`gh run view <v0.5.6 の release の run> --json jobs` → prepare が success（新しいレビューの判定を通る）

## リスク

- Codex の connector がマーカーの形や bot の id を変える → リリースの関門で止まり、公開されない（安全側）。止まったら形を実測して判定を直す
- 必須チェックの付け替えの前後で、main へのマージが待たされる → PR の上で新しいチェックが走るのを確かめてから付け替える
- immutable releases を有効にした後は Release の asset とタグが変えられない → 今の手順は Release を 1 回作るだけなので影響しない。失敗した Release を作り直すことはできなくなる

## 未解決

なし

## 変更履歴
