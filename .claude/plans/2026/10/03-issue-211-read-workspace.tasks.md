---
kind: tasks
plan: 03-issue-211-read-workspace.plan.md
branch: fix/issue-211-read-workspace
base: main
---

# 読み取りの MCP サーバーが cwd を省いた呼び出しでもセッションのプロジェクトを引き、instructions の先頭 512 文字に守る規則を収める のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 読み取りの MCP サーバーがセッションのプロジェクトを引く

cwd を省いても Claude Code と Codex で自分のプロジェクトの結果が返り、Codex が 512 文字で切っても規則が残る。

- [ ] T01: cwd を省いた呼び出しで、_meta、CLAUDE_PROJECT_DIR、起動場所の順にプロジェクトを決める
  - 種別: 修正
  - 計画: S1, S2
  - 依存: なし
  - 変更: `server/src/mcp.ts`, `server/test/plugin.test.ts`
  - red: `cd server && node --test --test-name-pattern 'without cwd' test/plugin.test.ts` → env だけ・`_meta` だけ・両方の 3 件が、起動場所のプロジェクトを返して（期待の不一致で）落ちる
  - 完了条件: `cd server && node --test test/plugin.test.ts` → pass
  - コミット: `fix(mcp): resolve the read server's project from the host workspace when cwd is omitted`

- [ ] T02: 読み取りの instructions の先頭 512 文字に cwd の規則と記録の扱いを収める
  - 種別: 修正
  - 計画: S3
  - 依存: なし
  - 変更: `server/src/mcp.ts`, `server/test/plugin.test.ts`
  - red: `cd server && node --test --test-name-pattern '512' test/plugin.test.ts` → 読み取りの instructions の先頭 512 コードポイントに規則が無く落ちる
  - 完了条件: `cd server && node --test test/plugin.test.ts` → pass
  - コミット: `fix(mcp): keep the read server's rules within the first 512 characters of its instructions`

## P2: リリースの準備

0.6.27 にそろえ、終わった #207 の計画を消す。

- [ ] T03: 0.6.27 にそろえ、終わった #207 の plan と tasks を消す
  - 種別: 変更
  - 計画: S4
  - 依存: T01（release:plan が plugin と判定する変更が要る）, T02（同じリリースに入れる instructions の変更が要る）
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.claude/plans/2026/10/03-issue-207-hook-runtime.plan.md`, `.claude/plans/2026/10/03-issue-207-hook-runtime.tasks.md`
  - 完了条件: `bun run release:plan -- --base v0.6.26` → plugin、`bun run verify` → exit 0
  - コミット: `chore(release): bump to 0.6.27`

## 記録
