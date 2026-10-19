---
kind: tasks
plan: 19-order-warning-turns.plan.md
branch: fix/order-warning-turns-360-361
base: main
---

# #360 と #361: trace の順序の警告を同じターンの途中の発言で出さず、release:plan が stage していない変更を知らせる のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 順序の警告（#361）

ターンの途中の持ち主の発言を採用に引き、同じターンの AI の返事を提案に引いたとき、trace の check と save が警告しない。0.6.63 に上げる。

- [ ] T01: ターンの途中の発言と同じターンの返事を比べないようにし、0.6.63 に上げる
  - 種別: 修正
  - 計画: S1, S2
  - 依存: なし
  - 変更: `server/evals/acceptance/driver.ts`, `server/evals/acceptance/load.ts`, `server/evals/acceptance/cases.json`, `server/test/acceptance-cases.test.ts`, `server/src/record.ts`, `server/test/record.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - red: driver の `.answer` 参照、acceptance case（u655 の形）、件数 20 → 21 だけを足した状態で `bun run bundle && SPHICA_ACCEPTANCE_LAYER=capture bun run acceptance` → 新しい case が `check reported "is older than the proposal it cites"` で落ち、capture-19 と capture-20 は通る
  - 完了条件: `bun run verify` → 0 で終わる。変更を `git add` した状態で `bun run release:plan -- --base v0.6.62` → `plugin`（版を上げる前に流す）
  - コミット: `fix(record): do not compare a mid-turn reply with the same turn's answer (T01)`

## P2: release:plan の表示（#360）

`release:plan` が、stage していない package の変更を知らせ、比べたもの（index）を名指す。

- [ ] T02: release:plan が stage していない package の変更を知らせ、index と比べたと表示する
  - 種別: 修正
  - 計画: S3
  - 依存: なし
  - 変更: `scripts/release-plan.mjs`, `server/test/release-plan.test.ts`
  - red: テストだけを足した状態で `cd server && node --import ./test/isolate-home.ts --test test/release-plan.test.ts` → stage していない package のファイルがあるケースで、`not staged, not counted` の行が無いために落ちる
  - 完了条件: 同じコマンド → 通る。`bun run verify` → 0 で終わる
  - コミット: `fix(release): say which package changes release:plan did not count (T02)`

## 記録
