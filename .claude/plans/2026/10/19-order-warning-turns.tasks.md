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

- [x] T01: ターンの途中の発言と同じターンの返事を比べないようにし、0.6.63 に上げる
  - 種別: 修正
  - 計画: S1, S2
  - 依存: なし
  - 変更: `server/evals/acceptance/driver.ts`, `server/evals/acceptance/load.ts`, `server/evals/acceptance/cases.json`, `server/test/acceptance-cases.test.ts`, `server/src/record.ts`, `server/test/record.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - red: driver の `.answer` 参照、acceptance case（u655 の形）、件数 20 → 21 だけを足した状態で `bun run bundle && SPHICA_ACCEPTANCE_LAYER=capture bun run acceptance` → 新しい case が `check reported "is older than the proposal it cites"` で落ち、capture-19 と capture-20 は通る
  - 完了条件: `bun run verify` → 0 で終わる。変更を `git add` した状態で `bun run release:plan -- --base v0.6.62` → `plugin`（版を上げる前に流す）
  - コミット: `fix(record): do not compare a mid-turn reply with the same turn's answer (T01)`
  - 結果: red: driver の `.answer` 参照・capture-21・件数 21 だけの状態で `bun run bundle && SPHICA_ACCEPTANCE_LAYER=capture bun run acceptance` → capture-21 が `check reported "is older than the proposal it cites"` で落ち（その前の active と採用 1 件の確認は通過）、capture-19・20 は pass。実装後、record.test の新しいテストから `!midTurn` を外すと fail、戻すと pass。変更を stage して `bun run release:plan -- --base v0.6.62` → `plugin`（版を上げる前）。`bun run verify` → exit 0（acceptance 151 件 pass）

## P2: release:plan の表示（#360）

`release:plan` が、stage していない package の変更を知らせ、比べたもの（index）を名指す。

- [x] T02: release:plan が stage していない package の変更を知らせ、index と比べたと表示する
  - 種別: 修正
  - 計画: S3
  - 依存: なし
  - 変更: `scripts/release-plan.mjs`, `server/test/release-plan.test.ts`
  - red: テストだけを足した状態で `cd server && node --import ./test/isolate-home.ts --test test/release-plan.test.ts` → stage していない package のファイルがあるケースで、`not staged, not counted` の行が無いために落ちる
  - 完了条件: 同じコマンド → 通る。`bun run verify` → 0 で終わる
  - コミット: `fix(release): say which package changes release:plan did not count (T02)`
  - 結果: red: テストだけを足した状態で `cd server && node --import ./test/isolate-home.ts --test test/release-plan.test.ts` → fail。最初に落ちたのは、red 欄に書いた stage していない行の確認より手前の `compared:` の行（`<base>..<HEAD>` のまま）で、どちらも今回直す出力。実装後 → pass。`bun run verify` → exit 0（acceptance 151 件、SQL 267/267）。このリポジトリで未追跡の `plugin/skills/zz-probe.md` を置いて `bun run release:plan -- --base v0.6.62` → `compared: v0.6.62..index (HEAD 04b47a47…)`、`not staged, not counted (git add them first): 1` とそのパス、`--json` に `compared: index` と `unstaged`（置いたファイルは消した）

- [x] T03: release:plan がパスを trim せずに取り、表示では制御文字をエスケープする
  - 種別: 修正
  - 計画: S3
  - 依存: T02（直すスクリプトとテストが T02 にある）
  - 変更: `scripts/release-plan.mjs`, `server/test/release-plan.test.ts`
  - red: テストに、先頭がタブのパス（package の外）と改行を含む未追跡のパスのケースだけを足して `cd server && node --import ./test/isolate-home.ts --test test/release-plan.test.ts` → 外のパスが plugin と分類されるか、改行で偽の行が出るために落ちる
  - 完了条件: 同じコマンド → 通る。`bun run verify` → 0 で終わる
  - コミット: `fix(release): read release:plan paths untrimmed and escape them when shown (T03)`
  - 結果: red: テストだけを足して流す → fail（先頭がタブの外のファイルが `inputs: plugin/skills/outside.md` として plugin に分類され、改行を含む名前から `release kind: plugin.md` の行が出た）。直した後 → 2 件 pass。`bun run verify` → exit 0

## 記録

- 2026-10-19 / T01 / review-shipping（コミット前）: 出荷してよい、低 1 件。中継されたメッセージで始まるターンは前のターンの turn id を使い回す（`server/test/capture.test.ts:1053`）ので、前後が分かる組み合わせでも警告が出ないことがある / 不採用。失うのは警告だけで保存は変わらず、中継で始まるターンに限る。PR に限界として書く
- 2026-10-19 / T01 / review-shipping: Codex は AskUserQuestion にあたる答えを記録しない（`plugin/hooks/codex.json` の PostToolUse は apply_patch だけ）ので、答えの部分は Claude Code だけに効く。前からある差 / PR に書く
- 2026-10-19 / T01 / Codex のタスクごとのレビュー（04b47a47）: 指摘なし
- 2026-10-19 / T02 / Codex の全差分レビュー（17bdf688）で P2 が 2 件（どちらも再現済み）: -z で取ったパスを表示でエスケープしないので改行を含む名前で偽の行を作れる、git() の trim が -z の先頭のタブを削り外のファイルを package と分類する / 採用。T03 を足して直す
- 2026-10-19 / T02 / review-shipping（コミット後、push 前）: 指摘なし。突然変異 3 種でテストが落ちることを確認済み
- 2026-10-19 / T03 / Codex の再レビュー（c84d14fd、全差分レビューと同じ会話）: F1・F2 は直っていて、新しい欠陥なし
