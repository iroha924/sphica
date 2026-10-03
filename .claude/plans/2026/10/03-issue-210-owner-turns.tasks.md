---
kind: tasks
plan: 03-issue-210-owner-turns.plan.md
branch: fix/issue-210-owner-turns
base: main
---

# Capture stops counting SDK turns as the owner's and stops giving one turn's working-tree changes to another, and pending traces count for 14 days のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: オーナーのターンとターンの境目を直す

SDK のターンをオーナーの発言にせず、中断と compaction をまたいで作業ツリーの変更を別のターンに付けない。

- [x] T01: `sdk-` で始まる entrypoint をオーナーのターンにせず、0.6.24 にそろえる
  - 種別: 修正
  - 計画: S1, S7
  - 依存: なし
  - 変更: `server/src/capture.ts`, `server/test/capture.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - red: `cd server && node --test --test-name-pattern="sdk-" test/capture.test.ts` → `sdk-ts` と `sdk-py`、親の目印が一致する `sdk-ts` の assert が true を返して落ちる
  - 完了条件: `cd server && node --test test/capture.test.ts` → pass。`cli`・`claude-desktop`・`remote_desktop`・未設定は true のまま。`bun run release:plan -- --base ea92016e` → `plugin`。4 つのファイルが 0.6.24
  - コミット: `fix(capture): never count an Agent SDK turn as the owner's, and bump to 0.6.24 (T01)`
  - 結果: red 実測: `node --test --test-name-pattern="sdk-" test/capture.test.ts` → `AssertionError: sdk-ts without a marker`。直した後 `node --test test/capture.test.ts` → 38 pass / 0 fail。4 つのファイルを 0.6.24 に更新（release:plan はこのコミットの後に流して plugin を確かめる）

- [x] T02: 起点にターン id を持たせ、別の id の注入でないプロンプトと Codex の Interrupt でターンを終える
  - 種別: 修正
  - 計画: S2
  - 依存: なし
  - 変更: `server/src/capture.ts`, `server/test/capture.test.ts`
  - red: `cd server && node --test --test-name-pattern="interrupt" test/capture.test.ts` → #210 の t1/t2 の流れで、t2 に `agent-a.ts` と `owner-b.ts` の status の編集が出て落ちる（Claude Code の中断と Codex の Interrupt の両方）。`turn` の無い走っている起点でも同じく落ちる
  - 完了条件: `cd server && node --test test/capture.test.ts` → pass。同じ id の途中のメッセージと、走っている間の別の id の注入では起点が残り、止まっているときの完了通知はターンを始める（既存のテストも pass）。取り直しに失敗したら次の Stop が status の編集を書かない
  - コミット: `fix(capture): end a running turn on a new typed prompt or a Codex interrupt (T02)`
  - 結果: red 実測（直す前の capture.ts）: `--test-name-pattern="interrupt"` → 4 fail（t2 に `owner-b.ts` と `agent-a.ts`、古い起点で `owner-b.ts`、失敗した取り直しで `y.ts` `z.ts`）。Interrupt の分岐だけ戻すと Codex の後半（通知が続く場合）が `agent-c.ts` `owner-d.ts` で落ちる。直した後 `node --test test/capture.test.ts` → 42 pass / 0 fail。取り直しの失敗は壊した `.git/index` で再現（PATH を外すと identify も失敗して早く戻るため）

- [x] T03: SessionStart の compact は走っている起点を上書きしない
  - 種別: 修正
  - 計画: S3
  - 依存: なし
  - 変更: `server/src/capture.ts`, `server/test/capture.test.ts`
  - red: `cd server && node --test --test-name-pattern="compact" test/capture.test.ts` → 両ホストで、t1 の途中のシェルの変更 x が compact の後の Stop で status の編集に出ず落ちる
  - 完了条件: `cd server && node --test test/capture.test.ts` → pass。startup・resume・clear では今どおり取り直すテストも pass
  - コミット: `fix(capture): keep a running turn's starting point across compaction (T03)`
  - 結果: red 実測: `--test-name-pattern="compact"` → `AssertionError: claude-code`（`x.ts` が出ず actual: []）。直した後 `node --test test/capture.test.ts` → 43 pass / 0 fail（両ホストの compact と startup・resume・clear）。`bun run typecheck` → エラーなし

- [x] T04: `fit()` の `redacted` を残した部分だけで決める
  - 種別: 修正
  - 計画: S4
  - 依存: なし
  - 変更: `server/src/capture.ts`, `server/test/capture.test.ts`
  - red: `cd server && node --test --test-name-pattern="redacted" test/capture.test.ts` → 捨てた部分にだけ鍵がある切り詰めの発言で `redacted` が true になり落ちる（先頭と末尾の窓それぞれ）
  - 完了条件: `cd server && node --test test/capture.test.ts` → pass。境目をまたぐ鍵と、境目が複数バイト文字の場合は true のまま
  - コミット: `fix(capture): mark a cut message redacted only when a mask is in the kept text (T04)`
  - 結果: red 実測: `--test-name-pattern="redacted only"` → `AssertionError: start window`（最初の assert で止まるので end window の red は個別には見ていない）。直した後 `node --test test/capture.test.ts` → 44 pass / 0 fail（窓の先と末尾、残す部分、境目をまたぐ鍵、複数バイトの境目）

## P2: trace 待ちを 14 日にし、受け入れケースを足す

持ち主の追加の 14 日を入れ、P1 の 3 つの挙動を受け入れケースで固定する。

- [x] T05: trace 待ちに数える期間を 14 日にする
  - 種別: 変更
  - 計画: S5
  - 依存: なし
  - 変更: `server/src/trace.ts`, `server/src/mcp-record.ts`, `plugin/skills/trace/SKILL.md`, `server/test/status.test.ts`, `server/test/extract.test.ts`, `server/test/record.test.ts`, `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`
  - 完了条件: `cd server && node --test test/status.test.ts` → pass（13 日・ちょうど 14 日は数え、14 日を少し過ぎた・20 日は別の見出し）。`rg -n "30 days|30 日" server/src/trace.ts server/src/mcp-record.ts plugin/skills/trace/SKILL.md server/evals/acceptance server/test/status.test.ts` → 一致なし
  - コミット: `feat(trace): count a session as waiting for 14 days after its last owner message (T05)`
  - 結果: テストを先に 14 日へ直して 30 日のコードで流す → status.test.ts 2 fail。直した後 `node --test test/status.test.ts` → 5 pass。`bun run test` → 3 件（extract・record の trace のテスト）が 17 日前の fixture を今の数え方で古い側に回して落ちたので、時計を fixture の 10 日後に移し `node --test test/extract.test.ts test/record.test.ts` → 51 pass。`rg -n "30 days|30 日" …` → 一致なし

- [ ] T06: 受け入れケースを 3 件足す（SDK のターン、中断の後のロールオーバー、compaction）
  - 種別: 追加
  - 計画: S6
  - 依存: T01（sdk-* の判定が要る）, T02（ロールオーバーが要る）, T03（compact で起点を残す挙動が要る）
  - 変更: `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`, `server/test/acceptance-cases.test.ts`
  - 完了条件: `bun run verify` → 終了コード 0。受け入れケースの件数が 3 件増える
  - コミット: `test(acceptance): cover SDK turns, interrupted turns, and compaction in capture (T06)`

## 記録

- 2026-10-03 / T01, T02 / コミットの件名が 100 文字を超え commit-msg の検査で止まった / 件名を短くした（T01: `…never count an Agent SDK turn as the owner's, and bump to 0.6.24`、T02: `…end a running turn on a new typed prompt or a Codex interrupt`）
- 2026-10-03 / T05 / extract.test.ts と record.test.ts の trace のテストが 2026-09-10 の fixture を 2026-09-27 の時計で数えていて、14 日で古い側に回り落ちた / 変更欄に 2 ファイルを足した（前: status.test.ts のみのテスト、後: extract.test.ts・record.test.ts も）
- 2026-10-03 / T01 / Codex のタスクレビューは指摘 0 件（sandbox でテストは流せず、テストは自分で流した結果）
