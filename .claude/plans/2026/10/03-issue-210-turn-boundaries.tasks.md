---
kind: tasks
plan: 03-issue-210-turn-boundaries.plan.md
branch: fix/issue-210-turn-boundaries
base: main
---

# Capture keeps a working-tree starting point per turn so a status edit never lands on another turn, and the record server prefers Codex's workspace のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: ターンごとの起点

起点をターンごとのファイルと通し番号で持ち、どの順序でも status の編集を別のターンに付けない。

- [x] T01: 起点をターンごとのファイルと通し番号にし、Stop は snapshot の後に今のターンを確かめてから書く
  - 種別: 修正
  - 計画: S1, S5
  - 依存: なし
  - 変更: `server/src/capture.ts`, `server/test/capture.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - red: `cd server && node --test --test-name-pattern="turn boundary" test/capture.test.ts` → #210 の t1/t2（Claude Code の中断、Codex の Interrupt）で t2 に `owner-b.ts` が出る、compaction の後の Stop に compaction の前のシェルの変更が出ない、遅れた Stop(t1) が t2 の変更を拾う、で落ちる
  - 完了条件: `cd server && node --test test/capture.test.ts` → pass。方針 11 の順序（同じ id の途中のメッセージ、走っている間の注入、遅れた保存、消せない起点、同点、seq:null、読めないファイル、tmp を比べない、entries:null・running:false を比べる、Stop と Interrupt が turn と seq を保つ、旧形式の 1 ファイルを読まない）が全部 pass。SessionStart はセッションのディレクトリがあっても例外を出さない
  - コミット: `fix(capture): keep a working-tree starting point per turn and record status edits only for the current turn (T01)`
  - 結果: `bun run release:plan -- --base 85d09b55` → `plugin`、4 つの manifest を 0.6.28 にした。red 実測（直す前の capture.ts）: 4 件 fail（Claude Code と Codex の t2 に `agent-a.ts` `owner-b.ts`、compact で `before.ts` が出ない、遅れた Stop(t1) に `t1:t2-only.ts`）。直した後 `node --test test/capture.test.ts` → 49 pass / 0 fail（turn boundary 10 件）。消せない起点は削除の操作が無くなったので、遅れた Stop の件で代える。`bun run typecheck` エラーなし、`bun run verify` → exit 0（受け入れケース 103 pass）

- [x] T02: prune を、セッションのディレクトリごとに seq が最大のファイルを印にして残す形にする
  - 種別: 変更
  - 計画: S1
  - 依存: T01（ターンごとのファイルの形が要る）
  - 変更: `server/src/capture.ts`, `server/test/capture.test.ts`
  - 完了条件: `cd server && node --test --test-name-pattern="prune" test/capture.test.ts` → pass。番号を振った後・保存の前に prune が走る順（C16）で付け違えない、期限切れの最大 seq のファイルが印になり番号が下がらない、ほかの古いファイルと旧形式の 1 ファイルが消える、読めない古いファイルが消える
  - コミット: `fix(capture): keep the highest-numbered starting point when pruning so numbers never go down (T02)`
  - 結果: `node --test --test-name-pattern="prune" test/capture.test.ts` → pass（t1 が番号を振った後・保存の前に prune、最大 seq の old2 が印になり、t2 と同点で t1 に `t2-only.ts` が付かない。期限切れの old1・読めないファイル・tmp・旧形式の 1 ファイルが消え、新しいターンが保存された後の prune で old2 も消える）。`node --test test/capture.test.ts` → 50 pass / 0 fail、`bun run typecheck` エラーなし

- [x] T03: Claude Code の capture の UserPromptSubmit と Stop を同期の hook にする
  - 種別: 変更
  - 計画: S2
  - 依存: なし
  - 変更: `plugin/hooks/hooks.json`, `scripts/check-ai-config.mjs`
  - 完了条件: `node scripts/check-ai-config.mjs` → 終了コード 0。`rg -n '"async": true' plugin/hooks/hooks.json` → PostToolUse の 1 件だけ
  - コミット: `fix(hooks): run capture synchronously on prompt submit and stop in Claude Code (T03)`
  - 結果: `node scripts/check-ai-config.mjs` → exit 0。`rg -n '"async": true' plugin/hooks/hooks.json` → 79 行目（PostToolUse）の 1 件だけ

- [x] T04: 中断の後のロールオーバーと compaction の受け入れケースを足す
  - 種別: 追加
  - 計画: S3
  - 依存: T01（受け入れケースが通る挙動が要る）
  - 変更: `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`, `server/evals/acceptance/load.ts`, `server/test/acceptance-cases.test.ts`
  - 完了条件: `bun run verify` → 終了コード 0。capture の受け入れケースが 2 件増え、main の `capture.ts` に差し替えると 2 件とも落ちる
  - コミット: `test(acceptance): cover interrupted turns and compaction in capture (T04)`
  - 結果: 前回取り下げた 03fc2d7c の capture-16（Claude Code の中断の後の `src/owner-fix.ts`）・capture-17（Codex の compaction の前の `src/lockfile.ts`）と driver の shell_edits・compact・ends・owner_edits_after・no_edit_observation を当て直した。`--test-name-pattern="capture-1[67]"` → 2 pass。main の `capture.ts` に差し替えると 2 件とも fail（`src/owner-fix.ts was observed in s-ja-interrupt`、`no edit observed for src/lockfile.ts in s-en-compact`）。`bun run verify` → exit 0（受け入れケース 105 pass）

## P2: record サーバーの workspace

Codex の `_meta` を `CLAUDE_PROJECT_DIR` より先に見て、引き継いだ環境変数で別のプロジェクトに書かない。

- [ ] T05: record サーバーの workspace を `_meta` → `CLAUDE_PROJECT_DIR` の順にする
  - 種別: 修正
  - 計画: S4
  - 依存: なし
  - 変更: `server/src/mcp-record.ts`, `server/test/plugin.test.ts`
  - red: `cd server && node --test --test-name-pattern="record.*_meta" test/plugin.test.ts` → `_meta` と `CLAUDE_PROJECT_DIR` が両方あるとき、環境変数のプロジェクトに書かれて落ちる
  - 完了条件: `cd server && node --test --test-name-pattern="_meta" test/plugin.test.ts` → pass（`_meta` が勝つ、`_meta` が未登録なら環境変数に落ちない、別 project の cwd を拒否する）
  - コミット: `fix(mcp): resolve the record server's workspace from Codex's _meta before CLAUDE_PROJECT_DIR (T05)`

## P3: リリース

- [-] T06: 0.6.28 にそろえる
  - 種別: 変更
  - 計画: S5
  - 依存: T02（出す変更が揃っている必要がある）, T03（同）, T04（同）, T05（同）
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run release:plan -- --base 85d09b55` → `plugin`。`bun run verify` → 終了コード 0
  - コミット: `chore(release): bump to 0.6.28 (T06)`

## 記録

- 2026-10-03 / T01, T06 / pre-commit の bundle の検査が、package の入力（capture.ts）を変えたコミットにバージョンの更新が無いと止めた / 0.6.28 への更新を T01 に移し、T01 の変更欄に 4 つの manifest を足した（前: capture.ts と capture.test.ts、後: それに plugin/package.json・plugin/.claude-plugin/plugin.json・plugin/.codex-plugin/plugin.json・.claude-plugin/marketplace.json）。T01 の計画欄に S5 を足し（前: S1、後: S1, S5）、T06 は取りやめ（リリースノートは PR 本文に書く）
