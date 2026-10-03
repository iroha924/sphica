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

- [x] T07: prune をセッション単位の削除にし、起点の読み書きの失敗で発言の保存と送信を止めない
  - 種別: 修正
  - 計画: S1
  - 依存: T02（直す対象の prune）
  - 変更: `server/src/capture.ts`, `server/test/capture.test.ts`, `.claude/plans/2026/10/03-issue-210-turn-boundaries.plan.md`
  - red: `cd server && node --test --test-name-pattern="cannot be written|prune drops" test/capture.test.ts` → T02 の capture.ts で、続いているセッションの古い起点が消される、Codex の Interrupt の書き込み失敗で例外になり `{ flush: true }` が返らない、で落ちる
  - 完了条件: `cd server && node --test test/capture.test.ts` → pass
  - コミット: `fix(capture): prune whole idle sessions only and keep recording when a start cannot be written (T07)`
  - 結果: red 実測（d7c0ed1d の capture.ts）: 2 件 fail（prune の `AssertionError`、書き込み失敗のテスト）。直した後 `node --test test/capture.test.ts` → 51 pass / 0 fail。C16 の順序のテストは、方針 7 の変更で穴 (g) に入るので外した

- [x] T08: prune は空のセッションのディレクトリを消さない
  - 種別: 修正
  - 計画: S1
  - 依存: T07（直す対象の prune）
  - 変更: `server/src/capture.ts`, `server/test/capture.test.ts`
  - red: `cd server && node --test --test-name-pattern="prune drops" test/capture.test.ts` → 最初の起点を書いている途中の空のディレクトリが消され `an empty session directory is left alone` で落ちる
  - 完了条件: `cd server && node --test test/capture.test.ts` → pass
  - コミット: `fix(capture): leave an empty session directory to the session writing its first start (T08)`
  - 結果: red 実測（a7cf854a の capture.ts）: `AssertionError: an empty session directory is left alone`（false !== true）。直した後 `node --test test/capture.test.ts` → 51 pass / 0 fail、`bun run typecheck` エラーなし

- [x] T09: 発言を起点より先に spool し、終えたターンは番号だけ残し、旧形式は古いときだけ消し、prune の失敗で通知を止めない
  - 種別: 修正
  - 計画: S1
  - 依存: T08（直す対象の prune）
  - 変更: `server/src/capture.ts`, `server/test/capture.test.ts`, `.claude/plans/2026/10/03-issue-210-turn-boundaries.plan.md`
  - red: `cd server && node --test --test-name-pattern="queued before|prune drops|keep a start's turn" test/capture.test.ts` → 14d10f86 の capture.ts で、起点が発言より先に書かれる、0.6.27 の形の新しいファイルが消える、終えたターンが entries を持ったまま、で落ちる
  - 完了条件: `cd server && node --test test/capture.test.ts` → pass
  - コミット: `fix(capture): queue the prompt before the start, keep ended starts small, and spare live older files (T09)`
  - 結果: red 実測（14d10f86 の capture.ts）: 3 件 fail。`attempt(pruneBaselines)` だけを戻すと `Error: busy` で fail。直した後 `node --test test/capture.test.ts` → 52 pass / 0 fail、`bun run typecheck` エラーなし

- [x] T10: Stop hook がターンを続けさせたときの続きの Stop も、前の Stop の終わりから差分を取る
  - 種別: 修正
  - 計画: S1
  - 依存: T09（終えたターンの起点の形）
  - 変更: `server/src/capture.ts`, `server/test/capture.test.ts`, `.claude/plans/2026/10/03-issue-210-turn-boundaries.plan.md`
  - red: `cd server && node --test --test-name-pattern="keeps the turn going" test/capture.test.ts` → 続きの `after-feedback.ts` が記録されず `[ 't1:first.ts' ]` で落ちる
  - 完了条件: `cd server && node --test test/capture.test.ts` → pass
  - コミット: `fix(capture): record shell edits of a turn a Stop hook keeps going (T10)`
  - 結果: red 実測（af38bfd4 の capture.ts）: actual `[ 't1:first.ts' ]`、expected に `t1:after-feedback.ts`。直した後 `node --test test/capture.test.ts` → 53 pass / 0 fail、`bun run typecheck` エラーなし

- [x] T11: 続きの Stop は取り直された起点を上書きせず、snapshot の失敗で起点を残し、同期の hook の timeout を 30 秒にする
  - 種別: 修正
  - 計画: S1, S2
  - 依存: T10（続きの Stop）
  - 変更: `server/src/capture.ts`, `server/test/capture.test.ts`, `plugin/hooks/hooks.json`, `scripts/check-ai-config.mjs`, `.claude/plans/2026/10/03-issue-210-turn-boundaries.plan.md`
  - red: `cd server && node --test --test-name-pattern="finishes after the same id|snapshot fails" test/capture.test.ts` → f943ab31 の capture.ts で、次の Stop に `t1:owner.ts` が入る、snapshot の失敗の後の続きの Stop が `[]` を返す、で落ちる
  - 完了条件: `cd server && node --test test/capture.test.ts` → pass。`node scripts/check-ai-config.mjs` → exit 0（10 秒の hooks.json では UserPromptSubmit と Stop の 2 件で落ちる）
  - コミット: `fix(capture): keep a reused turn's new start and give the synchronous hooks 30 seconds (T11)`
  - 結果: red 実測（f943ab31 の capture.ts）: actual `[ 't1:new-agent.ts', 't1:owner.ts' ]`、actual `[]`（expected `[ 't1:after-feedback.ts', 't1:first.ts' ]`）。直した後 `node --test test/capture.test.ts` → 55 pass / 0 fail。`node scripts/check-ai-config.mjs` → exit 0、HEAD の hooks.json に戻すと `must be` が 2 件

## P2: record サーバーの workspace

Codex の `_meta` を `CLAUDE_PROJECT_DIR` より先に見て、引き継いだ環境変数で別のプロジェクトに書かない。

- [x] T05: record サーバーの workspace を `_meta` → `CLAUDE_PROJECT_DIR` の順にする
  - 種別: 修正
  - 計画: S4
  - 依存: なし
  - 変更: `server/src/mcp-record.ts`, `server/test/plugin.test.ts`
  - red: `cd server && node --test --test-name-pattern="record.*_meta" test/plugin.test.ts` → `_meta` と `CLAUDE_PROJECT_DIR` が両方あるとき、環境変数のプロジェクトに書かれて落ちる
  - 完了条件: `cd server && node --test --test-name-pattern="_meta" test/plugin.test.ts` → pass（`_meta` が勝つ、`_meta` が未登録なら環境変数に落ちない、別 project の cwd を拒否する）
  - コミット: `fix(mcp): resolve the record server's workspace from Codex's _meta before CLAUDE_PROJECT_DIR (T05)`
  - 結果: red 実測（直す前の mcp-record.ts）: `--test-name-pattern="record.*_meta"` → `Sphica: o/b is not the workspace this session writes to (o/a)` で fail。直した後 `--test-name-pattern="_meta"` → pass、`node --test test/plugin.test.ts` → 35 pass / 0 fail、`bun run typecheck` エラーなし

- [x] T12: 起点のコメントを 3 行以内にして規則を knowledge-schema の Skill へ移し、record MCP のテストの子に一時の HOME を渡す
  - 種別: 変更
  - 計画: S1, S4
  - 依存: T11（コメントの対象のコード）, T05（直すテスト）
  - 変更: `server/src/capture.ts`, `.agents/skills/knowledge-schema/SKILL.md`, `server/test/plugin.test.ts`
  - 完了条件: `bun run verify` → exit 0。新しい複数行コメントが 3 行以内
  - コミット: `docs(capture): move the turn-start rules to the knowledge-schema Skill and give a test child a temp home (T12)`
  - 結果: `node --test test/capture.test.ts` → 55 pass、`--test-name-pattern="_meta" test/plugin.test.ts` → pass、`bun run verify:ai` → exit 0。この PR で足した 4 行以上のコメントは 0（残る 3 か所は前からある INJECTED などのコメント）

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
- 2026-10-03 / T01 / Codex のタスクレビュー 4 件: F4（Codex の Interrupt の書き込み失敗で flush が止まる、P2）を受理し T07 で直す。F1（保存待ちの間の B の編集を A の Stop が拾う）は棄却: T03 で UserPromptSubmit を同期にし、B のモデルは B の hook の保存の後に動く（崩れるのは timeout で、穴 (d)）。F2（同じ id の古い保存が新しい起点を巻き戻す）は棄却: 1 つの hook が何ターンも保存を待つ必要があり、穴 (f) を timeout を過ぎて走り続ける hook に広げて明記した。F3（Stop の書き直しの失敗の後の id の使い回し）は棄却: 起点を書けない場合で、穴 (d) に含めて明記した
- 2026-10-03 / T02 / Codex のタスクレビュー 2 件（P1）: prune が判定の後に同じ id の起点が作り直されると上書き・削除する（F1）、seq:null を消すと遅れた Stop が古いターンを今のターンと見る（F2）を受理 / T07 を足し、prune をセッション単位の削除にした。plan の方針 7・9 と変更履歴を直した
- 2026-10-03 / T03 / 2 行の設定の変更なのでタスクレビューは出さず、PR の全差分のレビューで見る
- 2026-10-03 / T05 / Codex のタスクレビューは指摘 0 件（MCP の統合テストは sandbox で流せず、自分で流した結果）
- 2026-10-03 / T07 / Codex のタスクレビュー 1 件（P1）: 新しいセッションの空のディレクトリも「全部古い」と見て消し、再帰削除の途中で新しい起点だけが先に消えると遅れた Stop が別のターンの編集を拾う（fs の mock で再現）を受理 / T08 を足した。prune の直しが新しい欠陥を生んだのは 1 回目
- 2026-10-03 / T08 / Codex のタスクレビューは指摘 0 件（fs の mock で prune と hook の 50 通りの順序を試し全部 pass。実ファイルの並行プロセスは未検証）
- 2026-10-03 / 全体 / review-shipping（パックした tarball 48 ファイル、dist に新しいコード、hooks.json の timeout 10、新しいテストが main のコードで落ちることを確認）: 4 件を受理し T09 を足した。同期の UserPromptSubmit が 10 秒を超えると発言が spool の前に打ち切られる（遅い git で再現）、ターンごとのファイルが entries ごと積もる（合成の 300 ターン・3 万ファイルで 546 MB・1.9 秒）、0.6.27 の hook のセッションの起点を年齢によらず消す（再現）、prune の例外で通知が出ない（読んだだけ）
- 2026-10-03 / 全体 / Codex の全差分レビュー（fe6f868a、high）3 件（P2）: F1（同期の UserPromptSubmit の timeout で発言が消える）と F3（0.6.27 の hook のセッションの起点を消す）は review-shipping と同じで T09 で直した。F2（Stop hook が続けさせたターンの続きのシェルの編集が落ちる）を受理し T10 を足した
- 2026-10-03 / 全体 / Codex の 2 回目の全差分レビュー（f943ab31、high）3 件（P2、mock で再現）を受理し T11 を足した。直しが新しい欠陥を生むのが 2 回続いた（T09 の直しが足りず、T10 から 2 件）ので持ち主に聞き、「3 件を直して区切る」を受けた。この後の全差分レビューは P1 と出荷後の安全に絞る
- 2026-10-03 / 全体 / Codex の最終の全差分レビュー（4642ec0d、high、P1 と出荷後の安全に絞った）は指摘 0 件（メモリ上の fs・git で 18 ケース、typecheck・AI 設定検査。Windows・0.6.27 からの更新・実ホストの並行 hook は未実走）
- 2026-10-03 / T12 / GitHub の Codex（PR #254）2 件（P1）: 起点の説明と closeTurn のコメントが 3 行を超える（規約）、足した record MCP のテストが子に `HOME: "/nonexistent"` を渡し Windows では `os.homedir()` が本物のプロファイルを指し得る、を受理 / T12 を足した。同じ形は同じファイルの既存の 9 か所にもあるが、この PR の範囲外として触らない
