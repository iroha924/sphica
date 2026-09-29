---
kind: tasks
plan: 29-export-decisions.plan.md
branch: feat/export-decisions
base: main
---

# 持ち主が選んだ有効な決定を、引用と置き換えの連なり付きで、コミットできる Markdown に書き出す（#198、0.6.6） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 書き出しの本体

選んだ決定を引用と連なり付きの Markdown にし、不適格な入力と危ない保存先を拒む

- [ ] T01: `export.ts` で文書の組み立てと保存先の検査を作り、0.6.6 に上げる
  - 種別: 追加
  - 計画: S1, S4
  - 依存: なし
  - 変更: `server/src/export.ts`, `server/test/export.test.ts`, `scripts/lib/sql-call-sites.mjs`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `node --test test/export.test.ts` → 引用と 2 段の連なり、不適格なキー・深さ・大きさ・保存先の各失敗、Markdown の注入の各テストが通る。`bun run release:plan -- --base v0.6.5` → `plugin`、4 つのファイルが 0.6.6。`bun run verify` → 0
  - コミット: `feat(export): build a Markdown export of chosen live decisions`

## P2: 入口

読み取りの MCP と明示起動の Skill から書き出せる

- [ ] T02: 読み取りの MCP に `export` ツールを登録する
  - 種別: 追加
  - 計画: S2
  - 依存: T01（組み立てと検査の関数が要る）
  - 変更: `server/src/mcp.ts`, `server/test/plugin.test.ts`, `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`, `server/test/acceptance-cases.test.ts`
  - 完了条件: `bun run --cwd server test` → ツール一覧のテストが通る。`bun run acceptance` → export の case が通る。`bun run verify` → 0
  - コミット: `feat(mcp): add the export tool to the read server`

- [ ] T03: `/sphica:export` Skill を足す
  - 種別: 追加
  - 計画: S3
  - 依存: T02（`allowed-tools` の検査が登録済みのツール名を求める）
  - 変更: `plugin/skills/export/SKILL.md`, `plugin/skills/export/agents/openai.yaml`
  - 完了条件: `bun run verify:ai` → 0。`bun run english` → 0
  - コミット: `feat(skills): add /sphica:export to write chosen decisions to a file`

## 記録
