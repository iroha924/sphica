---
kind: plan
status: approved
codex_session: none
codex_rounds: 0
approved_at: 2026-10-21
---

# #365: lint と format の道具を、決めた上限の内側なら Oxc（Oxlint と tsgolint、Oxfmt）へ移し、カスタム検査の一部を lint ルールにする

## 要点

- 速さは理由にしない（今の `biome ci .` は 0.5 秒）。上限を超えなければ移る。持ち主が今話題の道具を試したいことが動機
- Vite+ は最初に足切りの条件だけ見る。外れたら見送り、理由を PR に書く
- Oxlint と tsgolint: 時間の上限、違反の仕分け、promise のルールが安定版で使えることを見て、満たせば Biome の lint を置き換える
- Oxfmt: 冪等で Windows の CI が通れば、一括 reformat の 1 コミットで Biome の format を置き換える
- 1 ファイルの中で判定できるカスタム検査を 2 つ、Oxlint の JS プラグインに移す。移せなければスクリプトに残し、一覧を PR に書く
- 変えないもの: 出荷するコード、DB、`--ignore-scripts` での install、7 日ルール、Windows の CI

## 持ち主の決定

- 「ここまで厳密にやる必要はないのでは」（2026-10-21）を受け、出荷物に入らないこの変更は軽い進め方にする: grill-codex は使わない、PR は 1 つ、merge 前に Codex レビューを 1 回、合格ラインは先に決める（「その進め方でいいよ」「GO」）
- 背景は、今話題の技術をどんどん試したい、実験的なものも歓迎（#365 を作ったセッション）。Oxfmt と Vite+ も比べる対象に入れる

## 目的

- lint と format が、下の上限の内側で Oxc の道具で動き、lefthook・CI・`bun run fix` / `lint` がそれを呼ぶ。または、移らなかった道具ごとに理由が PR にある
- promise のルール（`no-floating-promises`、`no-misused-promises` 相当）が nursery ではないルールで効いている
- 移したカスタム検査は、直し方を書いたメッセージで違反を示す

## 対象外

- 型チェック（tsc 7 のまま。0.5 秒で終わり、得るものが無い）
- テストランナー（#367）。Vite+ が Vitest を必須にするなら、その時点で Vite+ を見送る
- ファイルをまたぐ検査（`check-architecture`、`check-pairs`、`check-rule-scopes`）の移植
- Markdown の検査（markdownlint と自前のスクリプトのまま）

## 前提

- `biome ci . --error-on-warnings` はリポジトリ全体で 0.48〜0.61 秒（3 回、2026-10-21 実測、事実）
- Biome は `server/package.json` の devDependencies、設定は `biome.json`（recommended、`noUndeclaredDependencies`、nursery の promise 2 ルール、test の `noSkippedTests`、organizeImports、JSON も対象）（事実）
- 7 日ルールを満たす最新（2026-10-21 時点、npm の time で確認、事実）: `oxlint 1.88.0`（10/13）、`oxlint-tsgolint 7.0.2004`（10/10）、`oxfmt 0.73.0`（10/13）、`vite-plus 1.1.0`（10/07）。配布元のリポジトリは oxc-project / voidzero-dev。provenance の署名は未検証
- `vite-plus` は `vite`、`vitest`、`@vitest/browser` などに依存する（npm view、事実）
- `server/package.json` と `server/bun.lock` は package の入力（`scripts/lib/release-scope.mjs:8`）。devDependencies を変えると `release:plan` は `plugin` を返す見込み（未検証、S5 の前に流す）
- Oxlint に `noUndeclaredDependencies` と organizeImports に当たるものがあるか、Oxfmt が JSON を扱えるかは未検証（S2、S3 で確かめる）

## 方針

- 測定は使い捨ての worktree（scratchpad の下ではなく、リポジトリの外の一時ディレクトリ。tmp の下の clone は plugin.test が落ちるため）で行い、結果は tasks の結果欄に書く。採用が決まったものだけを作業ブランチにコミットする
- 依存は install の前に npm で来歴（配布元のリポジトリ、公開日、provenance）を確かめ、7 日ルールの内側のバージョンを完全一致で pin する
- 上限と条件（先に決めたもの。ここから変えない）:
  - Vite+: `bun install --ignore-scripts` で入り、独自のパッケージマネージャーとテストランナーの入れ替えを必須にしない。外れたら見送り
  - Oxlint: CI の lint 全体が 5 秒以下、pre-commit が最近 20 コミットの staged ファイルの組で各 2 秒以下。今のコードの違反は全部仕分け、本物は直し、誤検知はルールごとに切る。切るルールが 6 個を超えたら移らない（5 個から変更。変更履歴）。promise のルールが nursery ではないこと
  - Oxfmt: 2 回かけて差分が出ない、Windows の CI が通る。差分の大きさは記録だけ
  - カスタムルール: 今のコードとわざと違反させたテスト用ファイルの両方で、スクリプトと同じものを検出し、直し方をメッセージに書く。対象の候補は `check-comments` と `check-sql`（どちらも 1 ファイルの中で判定する）。スクリプトが JS/TS 以外も見ているなら、その部分はスクリプトに残す
- Oxlint だけ採用で Oxfmt を見送ったときは、format と organizeImports は Biome に残し、Biome の linter を切る

## 採った案と棄却した案

- 採用: 上限の内側なら移る。棄却: Biome より明らかに良いときだけ移る（今 0.5 秒で速さの差が出ず、持ち主の動機は試すこと）
- 採用: 依存は今の Biome と同じ `server/package.json` に置く。棄却: ルートに別の package.json と lockfile を足す（install の経路が増える）
- 採用: grill-codex を使わず merge 前の Codex レビュー 1 回。棄却: タスクごとの Codex レビュー（出荷物に入らず、持ち主が軽い進め方を選んだ）

## 手順

- S1: Vite+ の足切り
- S2: Oxlint と tsgolint の測定と違反の仕分け
- S3: Oxfmt の測定
- S4: カスタムルール 2 つの試作と照合
- S5: 採用したものを入れる（依存、設定、lefthook、CI、scripts、違反の修正、reformat、カスタムルール）
- S6: 置き換えた Biome の部分を抜く

## 完了条件

- A1: `bun run verify` → 0 で終わる
- A2: `gh pr checks <PR>` → Windows と macOS を含む全ジョブが pass
- A3: リポジトリの外の新しい clone で `bun run setup && bun run lint` → 0 で終わる（install は `--ignore-scripts`）
- A4: `server/src` にわざと promise を待たない 1 行を置いて `bun run lint` → promise のルールで落ち、消すと 0 で終わる
- A5: `bun run release:plan -- --base v0.6.63` → 報告された種別のとおりに扱われている（`plugin` ならバージョンが 4 か所そろっている）
- A6: `gh pr view <PR> --json body` → S1〜S4 の測定値、採用・見送りとその理由、スクリプトに残した検査の一覧がある

## リスク

- tsgolint の型情報 lint が上限を超える → Oxlint を型情報なしで入れるかは決めず、移らない側に倒して理由を書く
- JS プラグイン（アルファ）が壊れる → カスタムルールはスクリプトに残す
- Oxfmt（ベータ）の出力が Biome と大きく違う → 1 コミットで reformat する。blame は `.git-blame-ignore-revs` で避ける
- devDependencies の変更で `release:plan` が `plugin` を返す → バージョンを上げ、リリースは持ち主の承認を待つ

## 未解決

なし

## 変更履歴
- 2026-10-21 / Oxlint の切るルールの上限を 5 個から 6 個にした / `no-useless-spread` の 24 件がすべて意図したコード（コメントのための分割、反復前のコピー、コードポイント単位の分割）で、その自動修正が `record.ts` の動作を変え `text.ts` の `english-exempt` を消したため / 結果を見た後の変更なので持ち主が決めた（「1でいこう」）
