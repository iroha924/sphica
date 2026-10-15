---
kind: tasks
plan: 15-remove-shell-write.plan.md
branch: chore/remove-shell-write-219
base: main
---

# 基準に届かなかった shell_write_delivery の試用（#219）を、設定・hook・コードごと外す のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: hook の登録を外す

どちらのホストも、シェルの呼び出しの後に Sphica の hook を呼ばなくなる

- [x] T01: Post の shell の hook の登録と、その形の検査・Windows の CI の harness を外し、バージョンを上げる
  - 種別: 削除
  - 計画: S1, S3
  - 依存: なし
  - 変更: `plugin/hooks/hooks.json`, `plugin/hooks/codex.json`, `scripts/check-ai-config.mjs`, `server/test/codex-trust.test.ts`, `scripts/check-hooks-live.mjs`, `.github/workflows/check.yml`, `server/evals/post-write/shell-write-harness.ts`, `server/test/shell-write-harness.test.ts`, `server/evals/post-write/real-host.md`, `knip.json`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run verify` → 終了コード 0。`node -e` で hooks.json と codex.json を読み、Bash か PowerShell に当たる PostToolUse / PostToolUseFailure の group が無い
  - コミット: `chore(plugin): stop registering hooks after shell calls`
  - 結果: `bun run verify` → exit 0（acceptance 148 pass / 0 fail）。hooks.json と codex.json を読んで Bash・PowerShell に当たる Post の group → `[[],[]]`。`node --test test/codex-trust.test.ts` → 8 pass。`bun run release:plan -- --base 6c7ca731` → plugin、4 か所とも 0.6.60

## P2: コードと設定を外す

後の配信のコード・設定・控え・試用のログが無くなり、古い定義から呼ばれても何も返さない

- [ ] T02: deliver.ts と shell-state.ts から後の配信のコードと設定を外し、deliverablePaths のテストを移し、退行テストと古い呼び出しの検査を足す
  - 種別: 削除
  - 計画: S2, S3
  - 依存: T01（登録が残ったまま後の配信を外すと、check-hooks-live の後の配信の検査が落ちる）
  - 変更: `server/src/deliver.ts`, `server/src/shell-state.ts`, `server/test/shell-state.test.ts`, `server/test/deliver.test.ts`, `server/test/deliver-codex.test.ts`, `scripts/check-hooks-live.mjs`, `server/evals/scale/run.ts`, `plugin/.claude-plugin/plugin.json`
  - 完了条件: `bun run verify` → 終了コード 0。`bun run test` → 全件 pass。退行テストは、後の配信のコードを戻すと落ちる
  - コミット: `chore(deliver): remove delivery after shell calls and its trial option`

## P3: 文書と試用の記録

利用者向けの説明から試用が消え、試用の結果がリポジトリに残る

- [ ] T03: README.md・README.ja.md・ARCHITECTURE.md から試用の記述を外す
  - 種別: 削除
  - 計画: S4
  - 依存: T02（設定が残っているうちに説明を消すと、説明と動きが食い違う）
  - 変更: `README.md`, `README.ja.md`, `ARCHITECTURE.md`
  - 完了条件: `bun run verify` → 終了コード 0。`git grep -n -i -E "shell_write|SHELL_WRITE|shell-state|after a shell command|before and after a shell|シェルのコマンドの直後" -- README.md README.ja.md ARCHITECTURE.md` → 何も出ない
  - コミット: `docs: drop the shell_write_delivery trial from the READMEs`

- [ ] T04: 試用の記録 shell-write-trial.json を足す
  - 種別: 追加
  - 計画: S5
  - 依存: なし
  - 変更: `server/evals/post-write/shell-write-trial.json`
  - 完了条件: `node -p "const t=require('./server/evals/post-write/shell-write-trial.json');[t.population.size,t.sample.length,t.result.noise,t.result.conversations,t.result.p90,t.verdict]"` → `[53, 40, 37, 47, 4, 'not adopted']`。ファイルに会話記録のコマンドの文面が無い
  - コミット: `test(eval): record the shell_write_delivery trial and its decision`

## 記録
- 2026-10-15 / T03 / review-shipping（T01 の前）が、README.md・README.ja.md の 128 行目（Codex の後の配信）と ARCHITECTURE.md:14（deliver.js が shell の前後で動く）も古くなると指摘した。完了条件の検索はこの 3 行に当たらなかった / T03 の完了条件の検索語を、前の値 `shell_write|SHELL_WRITE|shell-state` から `shell_write|SHELL_WRITE|shell-state|after a shell command|before and after a shell|シェルのコマンドの直後` に変えた（変更欄のファイルは同じ）
