---
kind: tasks
plan: 21-lint-toolchain.plan.md
branch: chore/lint-toolchain-365
base: main
---

# #365: lint と format の道具を、決めた上限の内側なら Oxc（Oxlint と tsgolint、Oxfmt）へ移し、カスタム検査の一部を lint ルールにする のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 測定

使い捨ての worktree で、Vite+、Oxlint と tsgolint、Oxfmt、カスタムルールを plan の上限と条件に当て、移るものを決める。

- [x] T01: Vite+ を足切りの条件に当てる
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `.claude/plans/2026/10/21-lint-toolchain.tasks.md`
  - 完了条件: 使い捨ての worktree で `vite-plus@1.1.0` を `bun add -d --ignore-scripts` → 入ったパッケージ数、`vp check` が Bun と lefthook のそばで動くか、テストランナーの入れ替えが必須かを結果欄に書き、採用か見送りを決める
  - コミット: `chore(plans): record the Vite+ gate for the lint toolchain (T01)`
  - 結果: worktree（main + plan）で `bun add -d --exact --ignore-scripts vite-plus@1.1.0` → 80 パッケージ、node_modules は 169.7MB から 318.4MB。install スクリプトは無い（`npm view vite-plus@1.1.0 scripts`）。`vp check --no-fmt` は vite.config 無しで Bun の node_modules から動き、0 errors / 42 warnings、1.56 秒。独自のパッケージマネージャーとテストランナーの入れ替えは必須ではない → 足切りは通過。ただし同梱は oxlint 1.87.0 / tsgolint 7.0.2003 / oxfmt 0.72.0 と単体より古く、vite・vitest・rolldown・tsdown はこのリポジトリで使わない。単体の Oxc の道具を採り、Vite+ は入れない（記録節）

- [x] T02: Oxlint と tsgolint を今のコードで測り、違反を仕分ける
  - 種別: 追加
  - 計画: S2
  - 依存: なし
  - 変更: `.claude/plans/2026/10/21-lint-toolchain.tasks.md`
  - 完了条件: 使い捨ての worktree で、Biome の今のルールに当たる設定と型情報のルールで `oxlint --type-aware` → CI の全体の時間（3 回）、最近 20 コミットの staged の組での時間、違反の件数とルールごとの仕分け（本物 / 誤検知）、切るルールの数、promise のルールの段階、`noUndeclaredDependencies` と organizeImports に当たるものの有無を結果欄に書き、採用か見送りを決める
  - コミット: `chore(plans): record the Oxlint measurements for the lint toolchain (T02)`
  - 結果: `oxlint 1.88.0` + `oxlint-tsgolint 7.0.2004`（+7 パッケージ、+51MB）、categories correctness、plugins typescript / unicorn / oxc / import / node / promise、`no-floating-promises`（node:test の test / describe / hooks を allowForKnownSafeCalls）と `no-misused-promises`。`oxlint --type-aware server/src server/test server/evals scripts` → 0.53 / 0.55 / 0.56 秒（JS プラグイン込みで 0.97〜1.03 秒）。最近 20 コミットの staged の組（1〜6 ファイル）→ 0.11〜0.18 秒（Biome は 0.20〜0.35 秒）。promise の 2 ルールは correctness / pedantic で nursery ではない。違反 218 件・10 ルール: 切る 5 ルール（unbound-method 38 件は kysely の `({ exists, selectFrom })` と prototype の保存、no-misused-spread 25 件はコードポイント単位の意図した spread、no-base-to-string 41 件は unknown な入力の防御的な String()、restrict-template-expressions 43 件と require-array-sort-compare 27 件は文字列化と既定の sort に頼る意図したコード）。直す 34 件（no-useless-spread 24、prefer-string-starts-ends-with 8、no-useless-fallback-in-spread 2）、設定で済む 1 件（no-unused-vars の `_` 始まりの引数）、no-control-regex 4 件は Biome の抑止コメントと同じ 4 か所で、Oxlint の抑止に書き換える。`noUndeclaredDependencies` に当たるルールは無く、knip の unlisted が受け持つ。organizeImports は Oxfmt の sortImports が受け持つ。tsgolint はリポジトリのルートから起動すると見つからない（`server/node_modules/.bin` を PATH に入れると見つかる）。切るのは 5 個で上限の内側 → 採用

- [x] T03: Oxfmt を今のコードで測る
  - 種別: 追加
  - 計画: S3
  - 依存: なし
  - 変更: `.claude/plans/2026/10/21-lint-toolchain.tasks.md`
  - 完了条件: 使い捨ての worktree で、Biome の今の format 設定に寄せて 2 回流す `oxfmt .` → 1 回目の差分の行数とファイル数、2 回目の差分が 0 か、JSON を扱えるかを結果欄に書き、採用か見送りを決める（Windows は S5 の CI で確かめる）
  - コミット: `chore(plans): record the Oxfmt measurements for the lint toolchain (T03)`
  - 結果: `oxfmt --migrate=biome` で設定を写し、sortImports `{ newlinesBetween: false }`、sortPackageJson false。Biome と同じ範囲（server/src・test・evals と scripts、ルートと server/ の JSON、Markdown は除く）で `oxfmt` → 1 回目 45 ファイル +84 / −96 行（import の並べ替えと、メソッドチェーンの折り返し）、0.07 秒。2 回目の差分は 0 行。JSON も扱える。sortImports を切ると 15 ファイル、Biome の組み方（パッケージと相対の間に空行）に寄せると 214 ファイル。sqlite.ts の `biome-ignore format` の行は Oxfmt でも変わらない → 採用（Windows は T05 の CI で見る）

- [x] T04: `check-comments` と `check-sql` を Oxlint の JS プラグインで試作し、スクリプトと照合する
  - 種別: 追加
  - 計画: S4
  - 依存: T02（Oxlint を採らないなら JS プラグインに移す先が無い）
  - 変更: `.claude/plans/2026/10/21-lint-toolchain.tasks.md`
  - 完了条件: 使い捨ての worktree で、今のコードとわざと違反させたファイルの両方に `bun run comments`・`bun run sql` とプラグインを入れて流す `oxlint` → 検出の一致、メッセージ、スクリプトに残す部分を結果欄に書き、移すものを決める
  - コミット: `chore(plans): record the custom rule trials for the lint toolchain (T04)`
  - 結果: `scripts/lint-plugin.mjs` に `sphica/comment-refs`（`referenceProblems` をそのまま使う）と `sphica/sql-style`（check-sql の正規表現と許可リスト）を試作。わざと違反させた `server/src/zz/c.ts`・`s.ts` を置いて `oxlint` と `bun run comments`・`bun run sql` → 検出が 4 件とも同じ行で一致し、今のコードでは両方 0 件（`bun run comments`、`bun run sql` も通る）。JS/TS の部分をプラグインへ移し、スクリプトには SQL ファイルの部分（db/*.sql のコメント、db/schema.sql の REPLACE）だけを残す → 採用

## P2: 採用

P1 で採ると決めたものを作業ブランチに入れ、lefthook・CI・scripts から呼び、置き換えた Biome の部分を抜く。T05 以降の変更欄は P1 の結果で決め、記録節に書いてから着手する。

- [x] T05: lint を Oxlint と tsgolint に移し、カスタムルール 2 つを JS プラグインへ移す
  - 種別: 変更
  - 計画: S5
  - 依存: T02（Oxlint の設定と切るルール）, T04（移すカスタムルール）
  - 変更: `server/package.json`, `server/bun.lock`, `.oxlintrc.json`, `scripts/oxlint.mjs`, `scripts/lint-plugin.mjs`, `scripts/lib/sql-style.mjs`, `scripts/check-comments.mjs`, `scripts/check-sql.mjs`, `biome.json`, `lefthook.yml`, `package.json`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `knip.json`, `server/test/lint-plugin.test.ts`, `scripts/codegen.mjs`, `scripts/check-pairs.mjs`, `scripts/lib/english.mjs`, `scripts/lib/license-header.mjs`, `scripts/lib/release-finish.mjs`, `scripts/lib/sbom.mjs`, `scripts/lib/verify-pairs.mjs`, `server/evals/cloud/build.ts`, `server/src/capture.ts`, `server/src/cli/view.ts`, `server/src/panel.ts`, `server/src/read.ts`, `server/test/architecture.test.ts`, `server/test/capture.test.ts`, `server/test/extract.test.ts`, `server/test/migrate.test.ts`, `server/test/verify-pairs.test.ts`
  - 完了条件: `bun run lint` → 0 で終わる。`server/src` にわざと promise を待たない 1 行を置いた `bun run lint` → `no-floating-promises` で落ちる。`bun run verify` → 0 で終わる
  - コミット: `chore(lint): lint with Oxlint and its type-aware rules, and move two custom checks into rules (T05)`
  - 結果: `node scripts/oxlint.mjs` → 違反 0 件で exit 0（6 ルールを切り、prefer-string-starts-ends-with 8 件と no-useless-fallback-in-spread 2 件を直し、no-control-regex の 4 か所を Oxlint の抑止に書き換え）。`server/src/zz-float.ts` に待たない呼び出しを置いて `node scripts/oxlint.mjs` → `no-floating-promises` で exit 1、消すと exit 0。`node --test test/lint-plugin.test.ts` → 3 件 pass。`bun run knip` → 0 件。`bun run release:plan -- --base v0.6.63` → `plugin`（バージョンを上げる前）、4 か所を 0.6.64 に。`bun run verify` → exit 0（acceptance 151 件 pass）

- [x] T06: format を Oxfmt に移し、一括で reformat する
  - 種別: 変更
  - 計画: S5
  - 依存: T03（Oxfmt の設定）, T05（lint の差し替えと同じ lefthook の行を触る）
  - 変更: `.oxfmtrc.json`, `scripts/oxfmt.mjs`, `lefthook.yml`, `package.json`, `server/package.json`, `server/bun.lock`, `knip.json`, `server/src/sqlite.ts`
  - 完了条件: `bun run format:check` → 0 で終わる。2 回目の `bun run fix` → 差分 0。`bun run verify` → 0 で終わる
  - コミット: `chore(format): format with Oxfmt (T06)`
  - 結果: `oxfmt 0.73.0` を追加（+3 パッケージ）。`node scripts/oxfmt.mjs` → 50 ファイル（整形 47 と設定・依存）+172 / −69 行、2 回目と `bun run fix` の後は差分 0。`bun run format:check` → 337 ファイルで exit 0。範囲外のファイルだけを渡した `node scripts/oxfmt.mjs plugin/hooks/hooks.json README.md server/src/db-types.ts` → 0 ファイルで exit 0。`sqlite.ts` の `biome-ignore format` は、理由の行と `// oxfmt-ignore` の 2 行にした（`// oxfmt-ignore: 理由` の形は効かないことを試して確かめた）。最初の `bun run verify` は knip の Unlisted（`oxfmt/package.json`）で exit 1、`knip.json` を直して `bun run verify` → exit 0（acceptance 151 件 pass）

- [x] T07: lint と format から Biome を抜き、説明を Oxc の道具に合わせる
  - 種別: 削除
  - 計画: S6
  - 依存: T05（lint が Oxlint に移っている）, T06（format が Oxfmt に移っている）
  - 変更: `biome.json`, `CLAUDE.md`, `AGENTS.md`, `.github/workflows/check.yml`, `server/package.json`, `knip.json`, `.git-blame-ignore-revs`
  - 完了条件: `rg -n -i biome lefthook.yml package.json CLAUDE.md AGENTS.md .github` → 0 件。`bun run verify` → 0 で終わる
  - コミット: `chore(lint): drop Biome from linting and formatting (T07)`
  - 結果: `biome.json` と server の `check` / `fix`（Biome）を消し、CLAUDE.md・AGENTS.md・check.yml の説明を直し、`.git-blame-ignore-revs` に T06 の 4024b4c6 を入れた。`rg -n -i biome lefthook.yml package.json CLAUDE.md AGENTS.md .github` → 0 件。最初の `bun run verify` は knip が `@biomejs/biome` を未使用と判定して exit 1（評価が `createRequire` で読むため見えない）、server の ignoreDependencies に足して `bun run verify` → exit 0（acceptance 151 件 pass）

- [x] T08: レビューの指摘を直す（pre-commit の glob、Oxfmt の範囲、Biome の recommended の写し、node:test の skip と only、設定のガード、古いコメント）
  - 種別: 修正
  - 計画: S5
  - 依存: T07（Biome を抜いた後の構成を直す）
  - 変更: `lefthook.yml`, `scripts/oxfmt.mjs`, `.oxlintrc.json`, `scripts/lint-plugin.mjs`, `scripts/lint-plugin.d.mts`, `server/test/lint-plugin.test.ts`, `server/src/db-write.ts`, `scripts/lib/verify-pairs.mjs`, `server/test/verify-pairs.test.ts`, `server/test/architecture.test.ts`, `server/test/capture.test.ts`
  - red: 未追跡の `server/src/zz-red.ts`（待たない呼び出し）で `lefthook run pre-commit --job oxlint --file server/src/zz-red.ts` → `oxlint (skip) no files for inspection`。崩した `scripts/zz-red.mjs` と `server/evals/zz-red.json` で `node scripts/oxfmt.mjs --check ./scripts/zz-red.mjs` と `node scripts/oxfmt.mjs --check server/evals/zz-red.json` → どちらも exit 0。HEAD の設定で `a == b`・`(a: any)`・node:test の `test.skip` を置いて `node scripts/oxlint.mjs -c <HEAD の設定>` → eqeqeq・no-explicit-any・skip の指摘が出ない
  - 完了条件: 同じ 3 つ → 順に no-floating-promises で落ちる、exit 1 と exit 1、eqeqeq・no-explicit-any・sphica(no-skipped-tests) が出る。`bun run verify` → 0 で終わる
  - コミット: `fix(lint): lint top-level files in pre-commit, and carry over Biome's recommended rules (T08)`
  - 結果: red は上の 3 つで実測（skip / exit 0 と exit 0 / 指摘なし）。直した後 → `server/src/zz-red.ts:3:3: error typescript(no-floating-promises)`、exit 1 と exit 1、`eslint(eqeqeq)`・`typescript(no-explicit-any)`・`sphica(no-skipped-tests)`。Biome の recommended 215 個（A11y を除く）を名前で Oxlint に写し、今のコードで違反 0 の 51 個を有効にした（no-template-curly-in-string は T05 で消した 12 か所の抑止を Oxlint の形で戻した）。`node --test test/lint-plugin.test.ts` → 5 件 pass。`bun run verify` → exit 0（acceptance 151 件 pass）

## 記録

- 2026-10-21 / 全体 / 持ち主が軽い進め方を選んだ / タスクごとの Codex レビューは行わず、merge 前に 1 回だけ流す
- 2026-10-21 / T01 / Vite+ は足切りを通ったが、同梱の Oxc の道具が単体より古く、vite・vitest・rolldown・tsdown をこのリポジトリで使わない / 単体の Oxc の道具を採り、Vite+ は入れない。#367 で Vitest を採るなら見直す
- 2026-10-21 / T05 / 1 つだった採用のタスクを T05（lint）・T06（format）・T07（Biome を抜く）に分けた / 変更欄が P1 の結果で決まったため。T05 の変更欄は `server/package.json` ほか 6 件から上の 15 件に、計画は S5, S6 から S5 に
- 2026-10-21 / T07 / `server/evals/review`（M1 と M2）は Biome そのものを評価の対象として使い、`server/test/review-eval.test.ts` が verify で流れる / `@biomejs/biome` は devDependencies に残し、lint と format からだけ抜く。plan の S6 は「置き換えた Biome の部分」なのでこの範囲に収まる
- 2026-10-21 / T05 / `server/package.json` は package の入力 / devDependencies を変える最初のコミット（T05）でバージョンを上げる
- 2026-10-21 / T02 / 結果欄の「直す 34 件（no-useless-spread 24）」は誤り。24 件はすべて意図したコードで、`--fix` は `record.ts:869` の `[...quote.slice()].at(-1)` を UTF-16 単位に変え、`text.ts` の `english-exempt` を消した / 修正は戻した。持ち主の判断で `no-useless-spread` も切り（6 個目）、plan の上限を 6 個にした。直すのは prefer-string-starts-ends-with 8 件と no-useless-fallback-in-spread 2 件の 10 件
- 2026-10-21 / T05 / 変更欄に、違反を直したファイル、Biome の lint の抑止コメントを消したファイル（Biome の linter を T05 で切るため。T07 から前倒し）、`knip.json`、プラグインのテストを足した（前の値は上の 15 件）
- 2026-10-21 / T06 / 変更欄を `.oxfmtrc.json`, `biome.json`, `lefthook.yml`, `package.json`, `server/package.json`, `.git-blame-ignore-revs` から上の値にした / Oxfmt の glob 引数はディレクトリ引数を絞るので範囲を `scripts/oxfmt.mjs` で決めた。`biome.json` は T07 で消す。`.git-blame-ignore-revs` は整形のコミットの SHA が要るので T07 に移す
- 2026-10-21 / T07 / 変更欄に `server/package.json`, `knip.json`, `.git-blame-ignore-revs` を足した（前の値は `biome.json`, `CLAUDE.md`, `AGENTS.md`, `.github/workflows/check.yml`） / server の Biome のスクリプトが残っていた、knip の除外が要った、blame の除外を T06 から移した
- 2026-10-21 / T08 / review-shipping 4 件と Codex 4 件（うち 2 件が重複）を受けて修正タスクを足した / 6 件とも採用。Biome の recommended で Oxlint に同じものが無い・動きが違うものは PR 本文に一覧を残す
