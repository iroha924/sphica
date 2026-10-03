---
kind: tasks
plan: 04-issue-206-eval-base.plan.md
branch: feat/issue-206-eval-base
base: main
---

# Build the local evaluation base that #206's delivery experiments and #211's alwaysLoad are measured on (PR-A, no release) のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: ビルドと実行の土台

スロットの DB・receipts・gold の印を run ごとの絶対パスで渡し、old と new を同じ fixture で組み立て、Claude をローカルで安全に回せる。

- [x] T01: スロットの DB・receipts・gold の印を env の絶対パスで渡せるようにする
  - 種別: 変更
  - 計画: S1
  - 依存: なし
  - 変更: `server/evals/cloud/build.ts`, `server/evals/cloud/slot-scripts.ts`, `server/test/eval-build.test.ts`
  - 完了条件: `cd server && node --test test/eval-build.test.ts` → `EVAL_SPHICA_DB` / `EVAL_RUN_DIR` があればそのパス、無ければ今の TMPDIR のパスを使うテストが pass
  - コミット: `feat(evals): pass the slot database and receipts by absolute path (T01)`
  - 結果: `node --test test/eval-build.test.ts` → pass 4, fail 0。`npx tsc --noEmit` → エラーなし

- [x] T12: 今の main で build.ts が落ちる 2 か所を直す（fixture の付け替えが ingest の権限で拒否される、exec form の hooks.json から matcher が取れない）
  - 種別: 修正
  - 計画: S7
  - 依存: なし
  - 変更: `server/evals/cloud/build.ts`
  - red: `cd server && node evals/cloud/build.ts --project tsundoku --out <tmp>` → `rekey` で `not authorized`、直した後に `plugin/hooks/hooks.json has no PreToolUse delivery hook`
  - 完了条件: `cd server && node evals/cloud/build.ts --project tsundoku --out <tmp>` → `built 4 repositories`
  - コミット: `feat(evals): build from a given bundle and fixture with per-task run counts (T02, T12, T13)`
  - 結果: red 実測: main の worktree（c042ada2）で `node evals/cloud/build.ts --project tsundoku` → `Error: not authorized`（`rekey`）。owner の接続にした後 `plugin/hooks/hooks.json has no PreToolUse delivery hook`。両方直して `built 4 repositories`

- [x] T02: build に `--dist` `--fixture` とタスクごとの run 数を足し、manifest に fixture のハッシュを残す
  - 種別: 追加
  - 計画: S7
  - 依存: T12（今の main では build が最後まで通らない）
  - 変更: `server/evals/cloud/build.ts`, `server/evals/cloud/firing.ts`, `server/test/eval-build.test.ts`
  - 完了条件: `cd server && node --test test/eval-build.test.ts` → tasks.json の `runs` が plan.json の行数になるテストが pass。`node evals/cloud/build.ts --project tsundoku --dist <dir> --fixture <db> --out <tmp>` → 渡した dist の bundle と fixture がスロットに入り、manifest に fixture の sha256 がある
  - コミット: `feat(evals): build from a given bundle and fixture with per-task run counts (T02, T12, T13)`
  - 結果: `node --test test/eval-build.test.ts test/eval-grade.test.ts` → pass 50, fail 0。build を 2 回（素のビルドと、その fixture.db と印を付けた deliver.js を渡すビルド）→ 両 manifest の fixture が 8d3065c1… で一致、bundle の deliver.js のハッシュは違い、スロットの deliver.js の末尾に印がある

- [x] T13: gold の印が TMPDIR に戻る場合と、session start で消えることのテストを足す（T01 の Codex レビュー F1）
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `server/test/eval-build.test.ts`
  - 完了条件: `cd server && node --test test/eval-build.test.ts` → EVAL_RUN_DIR なしで gold が 1 度だけ返り、印が TMPDIR にあり、start の後にまた返るテストが pass
  - コミット: `feat(evals): build from a given bundle and fixture with per-task run counts (T02, T12, T13)`
  - 結果: `node --test test/eval-build.test.ts` → 新しいテストを含め pass

- [x] T03: ローカルの Claude runner と回収を足す
  - 種別: 追加
  - 計画: S2
  - 依存: T01（hook と MCP に run の DB の絶対パスを渡す）
  - 変更: `server/evals/cloud/claude.ts`, `server/evals/cloud/claude-run.ts`, `server/evals/cloud/judge.ts`, `server/evals/cloud/collect.ts`, `server/test/eval-claude.test.ts`
  - 完了条件: `cd server && node --test test/eval-claude.test.ts` → 条件ごとの settings / mcp.json の生成、開始 SHA からの patch（未追跡を含み `.tools` などを除く）、stream の最後の result の答え、collect が claude-runs を読むテストが pass
  - コミット: `feat(evals): run Claude locally in a sandboxed claude -p (T03, T14)`
  - 結果: `node --test test/eval-claude.test.ts test/eval-build.test.ts test/eval-grade.test.ts` → 全件 pass（eval-claude 8 件）。実 run 2 回（pilot-sort、inject、claude-opus-5-5）: exit 0、17 秒前後、answer.md・patch.diff・receipts・delivery のログがそろい、init に `mcp_servers: sphica connected`。1 回目は `mcp__sphica__search` が permission_denied だったので許可を足し、2 回目で search が 2 回通った

- [x] T14: run 数の検査と、matcher と rekey のテストを足す（T02 の Codex レビュー F1, F2）
  - 種別: 追加
  - 計画: S7
  - 依存: なし
  - 変更: `server/evals/cloud/build-lib.ts`, `server/evals/cloud/build.ts`, `server/evals/cloud/firing.ts`, `server/test/eval-build.test.ts`
  - 完了条件: `cd server && node --test test/eval-build.test.ts` → 0・負・小数・文字列の run 数で止まり、exec form と command form の hooks から matcher が取れ、実際の SQLite で project が付け替わるテストが pass
  - コミット: `feat(evals): run Claude locally in a sandboxed claude -p (T03, T14)`
  - 結果: `node --test test/eval-build.test.ts` → pass 9, fail 0

- [x] T04: canary（権限・文脈・DB）と生成した settings の単体テストを足す
  - 種別: 追加
  - 計画: S3
  - 依存: T03（runner の settings と起動の形が要る）
  - 変更: `server/evals/cloud/claude.ts`, `server/evals/cloud/claude-run.ts`, `server/evals/cloud/canary.ts`, `server/evals/cloud/canary-check.ts`, `server/evals/cloud/slot-scripts.ts`, `server/test/eval-claude.test.ts`
  - 完了条件: `cd server && node --test test/eval-claude.test.ts` → 生成した settings に持ち主の実パスの読み取り禁止・allowUnsandboxedCommands=false・failIfUnavailable=true があり、canary の判定が「未試行」「ログ欠落」「sentinel の変化」を失敗にするテストが pass。`node evals/cloud/canary.ts --build <build>` → 全項目 ✓ で 0
  - コミット: `feat(evals): refuse local Claude runs until the canary passes (T04)`
  - 結果: `node --test test/eval-claude.test.ts test/eval-build.test.ts test/eval-grade.test.ts` → pass 64, fail 0。`node evals/cloud/canary.ts --build <build-c1>` → 30 項目全部 ✓、`canary passed`、exit 0。fence の 5 つの試みは Write・Edit・Read が権限（"denied by your permission settings"）、Bash の書き込みと cat が sandbox（"Operation not permitted"）で止まった。canary の無いビルドで claude.ts は拒否する

## P2: 測る信号と評価セット

最初の編集の前に検索したか、衝突の扱い、old が実際に届ける記録を測れる。

- [ ] T05: 呼び出しごとの作業ツリーの観測と、Sphica の search が最初の編集より前かの判定を足す
  - 種別: 追加
  - 計画: S4
  - 依存: T03（stream-json の回収が要る）
  - 変更: `server/evals/cloud/claude.ts`, `server/evals/cloud/judge.ts`, `server/evals/cloud/collect.ts`, `server/test/eval-grade.test.ts`
  - 完了条件: `cd server && node --test test/eval-grade.test.ts` → Bash 編集 → search → Write は no、search → Bash 編集は yes、Write だけ・Bash だけ・並行の呼び出し（unknown）のテストが pass
  - コミット: `feat(evals): tell whether a run searched Sphica before its first edit (T05)`

- [ ] T06: stale・abstention・crowded・conflict・poisoned-delivered の setup とタスクを足す
  - 種別: 追加
  - 計画: S5
  - 依存: T02（タスクごとの run 数の欄が要る）
  - 変更: `server/evals/cloud/tasks.json`, `server/evals/acceptance/cases.json`, `server/evals/acceptance/world.json`, `server/test/eval-fixture.test.ts`
  - 完了条件: `cd server && node --test test/eval-fixture.test.ts` → fixture を作り、今の deliver で stale・conflict 以外の対象タスクの gold が pre_read か pre_edit で届き、conflict の 2 件は今は届かず、candidate は届かないテストが pass
  - コミット: `test(evals): add delivered stale, abstention, crowded, conflict, and poisoned fixtures (T06)`

- [ ] T07: 採点に衝突の欄と re-proposal の率を足す
  - 種別: 追加
  - 計画: S6
  - 依存: なし
  - 変更: `server/evals/cloud/grading.ts`, `server/evals/cloud/grade.schema.json`, `server/evals/cloud/report.ts`, `server/test/eval-grade.test.ts`
  - 完了条件: `cd server && node --test test/eval-grade.test.ts && node evals/cloud/schema-check.ts` → `named_conflict` と `implemented_one_side` の検査と、re-proposal を分母と unknown つきの率で出すテストが pass し、schema が zod と一致
  - コミット: `feat(evals): grade conflicts and report re-proposals as a rate (T07)`

- [ ] T08: report に old と new を並べる `--compare` を足す
  - 種別: 追加
  - 計画: S7
  - 依存: T02（manifest の fixture のハッシュが要る）
  - 変更: `server/evals/cloud/report.ts`, `server/test/eval-grade.test.ts`
  - 完了条件: `cd server && node --test test/eval-grade.test.ts` → fixture のハッシュかタスク定義が違えば拒否し、同じなら bundle ごとに表を分けて出すテストが pass
  - コミット: `feat(evals): compare an old and a new build without mixing their bundles (T08)`

- [ ] T09: 順番のオフラインのベンチを足す
  - 種別: 追加
  - 計画: S8
  - 依存: T06（crowded の fixture が要る）
  - 変更: `server/evals/order/run.ts`, `server/test/eval-order.test.ts`, `server/package.json`
  - 完了条件: `cd server && node --test test/eval-order.test.ts` → イベントごとの gold-in-delivery の率を件数と文字数の上限を分けて出し、`--compare <ref>` で 2 つの deliver を並べるテストが pass
  - コミット: `feat(evals): measure whether gold records land inside the delivery limits (T09)`

## P3: 実機の確認と手順

遅延読み込みの証拠と、ローカルの流れの手順がそろう。

- [ ] T10: tool search の遅延読み込みの証拠を実 run で確かめ、runner の settings に固定する
  - 種別: 追加
  - 計画: S9
  - 依存: T04（canary を通った runner で実 run する）
  - 変更: `server/evals/cloud/claude-settings.ts`, `server/evals/cloud/judge.ts`, `server/test/eval-claude.test.ts`
  - 完了条件: `cd server && node --test test/eval-claude.test.ts` → 実 run で取った init の形から、search が遅延か最初から読み込まれたかを判定するテストが pass。証拠の欄が無ければ判定は unknown を返し、記録節に「G6 は測れない」と書く
  - コミット: `feat(evals): pin deferred tool loading and detect it from the stream (T10)`

- [ ] T11: eval-loop Skill をローカルの流れに合わせて直す
  - 種別: 変更
  - 計画: S10
  - 依存: T04（canary の手順）, T08（compare の手順）
  - 変更: `.claude/skills/eval-loop/SKILL.md`
  - 完了条件: `bun run verify:ai` → 0 で終わる
  - コミット: `docs(eval-loop): run Claude locally behind the canary and compare old and new builds (T11)`

## 記録
- 2026-10-04 / T01 / build.ts はモジュールを読んだ時点でビルドを始めるのでスクリプトをテストから読めない / スロットのスクリプトを `slot-scripts.ts` に移し、変更欄に足した（前: build.ts と test、後: slot-scripts.ts を追加）
- 2026-10-04 / T01 / 持ち主のシェルに `SPHICA_DB` が残っていると run の DB として使ってしまう / runner が渡す変数は `SPHICA_DB` ではなく `EVAL_SPHICA_DB` にした（完了条件の変数名を前: `SPHICA_DB`、後: `EVAL_SPHICA_DB` に直した）
- 2026-10-04 / T12 / build.ts が main で落ちていた（9/30 のループより後の権限と hooks.json の変更）/ 修正タスク T12 を足し、T02 の依存に入れた（前: なし、後: T12）。T02 の完了条件に実ビルドを足した（build は読み込みで走るスクリプトでテストから組み立てられないため）
- 2026-10-04 / T01 / Codex レビュー F1（gold の印の TMPDIR への戻りのテストが無い）を採った / T13 を足した
- 2026-10-04 / T03 / スクリプトとして読み込んだ時点で走る claude.ts からは関数をテストに出せない / 設定・patch・答えの取り出しを `claude-run.ts` に置き、stream の判定を judge.ts に足した（変更欄 前: claude-settings.ts、後: claude-run.ts と judge.ts）
- 2026-10-04 / T03 / 実 run で、acceptEdits の -p は MCP の呼び出しを全部拒否した / search と inject の settings に `allow: ["mcp__sphica"]` を足した
- 2026-10-04 / T03 / 実 run で、Sphica のツールは強制しなくても遅延読み込みで、モデルは ToolSearch の `select:mcp__sphica__search` で読み込んでから呼んだ / T10 はこの ToolSearch の呼び出しを遅延の証拠の候補にする
- 2026-10-04 / T03 / Claude Code 自身の安全判定で Bash の 1 呼び出しが拒否された（brace と引用符）/ 条件によらず同じなのでそのまま
- 2026-10-04 / T02 / Codex レビュー F1（run 数の検査）を採り T14 にした。F2 は matcher と rekey を build-lib.ts に切り出してテストし、`--dist` / `--fixture` の通しのビルドは CI に無い Linux 版 Node（31MB）が要るので自動テストにせず、手で流した結果を T02 に残した
- 2026-10-04 / T04 / `--setting-sources ""` ではプロジェクトの CLAUDE.md も読み込まれず、モデルが Read で読みに行った（cloud と条件がずれる）/ `--setting-sources project` に変え、clone の `.claude/settings.json`（cloud のフック）は開始前のコミットで消し、フックは `--settings` から渡す。正の対照（CLAUDE.md を置いた run）で InstructionsLoaded の receipt に `memory_type: Project` が出て、user の CLAUDE.md は出ないことを確かめた
- 2026-10-04 / T04 / canary は `claude.ts --canary` ではなく別の `canary.ts` にし、結果をビルドの `canary.json` に残して claude.ts が見る（変更欄 前: claude.ts と canary.ts、後: claude-run.ts・canary-check.ts・slot-scripts.ts を追加）。receipt に読み込んだファイルを残すため HOOK_SH に `file` と `memory` を足した
- 2026-10-04 / T04 / Sphica は delivery の session_id をホストの id から作り直すので、DB の canary は「各 DB に session が 1 つ、2 つの run で違う、TMPDIR に DB が無い」で見る
