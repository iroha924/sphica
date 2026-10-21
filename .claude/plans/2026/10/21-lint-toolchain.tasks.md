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

- [ ] T01: Vite+ を足切りの条件に当てる
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `.claude/plans/2026/10/21-lint-toolchain.tasks.md`
  - 完了条件: 使い捨ての worktree で `vite-plus@1.1.0` を `bun add -d --ignore-scripts` → 入ったパッケージ数、`vp check` が Bun と lefthook のそばで動くか、テストランナーの入れ替えが必須かを結果欄に書き、採用か見送りを決める
  - コミット: `chore(plans): record the Vite+ gate for the lint toolchain (T01)`

- [ ] T02: Oxlint と tsgolint を今のコードで測り、違反を仕分ける
  - 種別: 追加
  - 計画: S2
  - 依存: なし
  - 変更: `.claude/plans/2026/10/21-lint-toolchain.tasks.md`
  - 完了条件: 使い捨ての worktree で、Biome の今のルールに当たる設定と型情報のルールで `oxlint --type-aware` → CI の全体の時間（3 回）、最近 20 コミットの staged の組での時間、違反の件数とルールごとの仕分け（本物 / 誤検知）、切るルールの数、promise のルールの段階、`noUndeclaredDependencies` と organizeImports に当たるものの有無を結果欄に書き、採用か見送りを決める
  - コミット: `chore(plans): record the Oxlint measurements for the lint toolchain (T02)`

- [ ] T03: Oxfmt を今のコードで測る
  - 種別: 追加
  - 計画: S3
  - 依存: なし
  - 変更: `.claude/plans/2026/10/21-lint-toolchain.tasks.md`
  - 完了条件: 使い捨ての worktree で、Biome の今の format 設定に寄せて 2 回流す `oxfmt .` → 1 回目の差分の行数とファイル数、2 回目の差分が 0 か、JSON を扱えるかを結果欄に書き、採用か見送りを決める（Windows は S5 の CI で確かめる）
  - コミット: `chore(plans): record the Oxfmt measurements for the lint toolchain (T03)`

- [ ] T04: `check-comments` と `check-sql` を Oxlint の JS プラグインで試作し、スクリプトと照合する
  - 種別: 追加
  - 計画: S4
  - 依存: T02（Oxlint を採らないなら JS プラグインに移す先が無い）
  - 変更: `.claude/plans/2026/10/21-lint-toolchain.tasks.md`
  - 完了条件: 使い捨ての worktree で、今のコードとわざと違反させたファイルの両方に `bun run comments`・`bun run sql` とプラグインを入れて流す `oxlint` → 検出の一致、メッセージ、スクリプトに残す部分を結果欄に書き、移すものを決める
  - コミット: `chore(plans): record the custom rule trials for the lint toolchain (T04)`

## P2: 採用

P1 で採ると決めたものを作業ブランチに入れ、lefthook・CI・scripts から呼び、置き換えた Biome の部分を抜く。T05 以降の変更欄は P1 の結果で決め、記録節に書いてから着手する。

- [ ] T05: 採用したものを入れる
  - 種別: 変更
  - 計画: S5, S6
  - 依存: T01（Vite+ を採るかで入れる道具が変わる）, T02（Oxlint を採るか）, T03（Oxfmt を採るか）, T04（移すカスタムルール）
  - 変更: `server/package.json`, `server/bun.lock`, `biome.json`, `lefthook.yml`, `package.json`, `.github/workflows/check.yml`
  - 完了条件: `bun run verify` → 0 で終わる。わざと promise を待たないコードで `bun run lint` が落ちる
  - コミット: `chore(lint): move linting and formatting to the Oxc tools (T05)`

## 記録

- 2026-10-21 / 全体 / 持ち主が軽い進め方を選んだ / タスクごとの Codex レビューは行わず、merge 前に 1 回だけ流す
