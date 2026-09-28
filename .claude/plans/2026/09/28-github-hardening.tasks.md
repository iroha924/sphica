---
kind: tasks
plan: 28-github-hardening.plan.md
branch: feat/github-hardening
base: main
---

# Codex レビューの完了をリリースの関門で機械的に確かめ、GitHub 側の設定とジョブの上限を締め、closingRefs が HTML コメントを読まないようにし、README のバッジから説明へ辿れるようにする（#184） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 配布物の修正

0.5.6 として、closingRefs が HTML コメントの中の参照を読まなくなり、README のバッジから説明へ辿れる。

- [x] T01: npm と 3 つの manifest のバージョンを 0.5.6 に上げる
  - 種別: 変更
  - 計画: S1
  - 依存: なし
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `grep -h '"version"' plugin/package.json plugin/.claude-plugin/plugin.json plugin/.codex-plugin/plugin.json .claude-plugin/marketplace.json` → 4 行とも 0.5.6
  - コミット: `chore(release): bump to 0.5.6`
  - 結果: `grep -h '"version"' ...` → 4 行とも "version": "0.5.6"

- [x] T02: closingRefs が HTML コメントの中の参照を読まないようにする
  - 種別: 修正
  - 計画: S2
  - 依存: T01（配布物の変更はバージョンを上げた後でないとコミットできない）
  - 変更: `server/src/github.ts`, `server/test/github.test.ts`
  - red: `cd server && node --test test/github.test.ts` → .github/pull_request_template.md の本文を読んだ PR が issue 12 を閉じる参照として返し失敗
  - 完了条件: `bun run test` → テンプレートの本文から参照が返らず、コメントの外の `Closes #3` は返り、閉じない開始記号の後ろは返らず、閉じない開始記号が多い入力でも線形の時間で終わる検査を含めて通る
  - コミット: `fix(github): ignore closing references inside HTML comments`
  - 結果: red を実測（`node --test test/github.test.ts` → `Error: no answer for issues/12`、テンプレートのコメントから issue 12 を読みに行った）。直した後 `bun run test` → 全件 pass（開始記号 20 万個の入力も 1 秒以内）

- [ ] T03: 両方の README のバッジの下に説明への案内を足し、日本語版の Security 節を今の手順に直す（#184）
  - 種別: 変更
  - 計画: S6
  - 依存: T01（README は配布物に入るので、バージョンを上げた後でないとコミットできない）
  - 変更: `README.md`, `README.ja.md`
  - 完了条件: `sed -n 3,12p README.md README.ja.md` → バッジの行の直下に CI と来歴の節へのリンクがある。`rg -n "ステージ|2 要素認証" README.ja.md` → 0 件。`bun run verify:ai` → 通る
  - コミット: `docs(readme): point from the badges to what CI and releases check`

## P2: リリースの関門と GitHub の設定

リリースは Codex のレビューが head で完了していないと止まり、GitHub 側の設定の穴を手元の検査が見つける。

- [ ] T04: release-gate が Codex の要約の完了と未解決のスレッド 0 件を確かめる
  - 種別: 追加
  - 計画: S3
  - 依存: なし
  - 変更: `scripts/lib/release-gate.mjs`, `scripts/lib/release-gate.d.mts`, `scripts/release-gate.mjs`, `server/test/release-gate.test.ts`
  - 完了条件: `bun run test` → 要約の欠落・別の作者・headSha の不一致・running・マーカーの JSON の破損・未解決のスレッドのそれぞれで止め、すべてそろったときだけ通す検査を含めて通る
  - コミット: `feat(release): require a completed Codex review with no open threads on the head`

- [ ] T05: immutable releases と SHA 固定の強制を有効にし、release:plan と release:status で確かめる
  - 種別: 追加
  - 計画: S4, S7
  - 依存: なし
  - 変更: `scripts/lib/repo-settings.mjs`, `scripts/lib/repo-settings.d.mts`, `scripts/release-plan.mjs`, `scripts/release-status.mjs`, `server/test/repo-settings.test.ts`
  - 完了条件: `bun run test` → 200・404・それ以外、true・false の全分岐の検査を含めて通る。持ち主のトークンで両設定を有効にした後 `bun run release:status` → 両方とも有効と表示
  - コミット: `feat(release): check immutable releases and SHA pinning from release:plan and release:status`

- [ ] T06: pr-body のジョブ名を verification-section にし、各ジョブに上限の時間を付ける
  - 種別: 変更
  - 計画: S5, S7
  - 依存: なし
  - 変更: `.github/workflows/pr-body.yml`, `.github/workflows/check.yml`
  - 完了条件: `actionlint .github/workflows/pr-body.yml .github/workflows/check.yml` → 指摘なし。`rg -n "codex-review" .github CLAUDE.md AGENTS.md .agents plugin` → ジョブ名としての参照が 0 件。main の必須チェックの付け替えは PR を開いて新しいチェックが走った後に行い、plan の A5 で確かめる
  - コミット: `ci: name the PR body check for what it checks and cap job times`

## 記録

- 2026-09-28 / - / 持ち主の指示で、.claude/plans の他の plan と tasks（27-claude-bash-delivery、27-eval-structured-grading、28-bind-github-owner、28-confirm-before-override、28-release-automation）を最初のコミットで削除する。ほかのファイルからの参照は 0 件（rg で確認）
