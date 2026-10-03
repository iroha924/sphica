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

- [ ] T02: build に `--dist` `--fixture` とタスクごとの run 数を足し、manifest に fixture のハッシュを残す
  - 種別: 追加
  - 計画: S7
  - 依存: なし
  - 変更: `server/evals/cloud/build.ts`, `server/evals/cloud/firing.ts`, `server/test/eval-build.test.ts`
  - 完了条件: `cd server && node --test test/eval-build.test.ts` → 渡した dist の bundle と fixture がスロットに入り、manifest に fixture の sha256 があり、tasks.json の `runs` が plan.json の行数になるテストが pass
  - コミット: `feat(evals): build from a given bundle and fixture with per-task run counts (T02)`

- [ ] T03: ローカルの Claude runner と回収を足す
  - 種別: 追加
  - 計画: S2
  - 依存: T01（hook と MCP に run の DB の絶対パスを渡す）
  - 変更: `server/evals/cloud/claude.ts`, `server/evals/cloud/claude-settings.ts`, `server/evals/cloud/collect.ts`, `server/test/eval-claude.test.ts`
  - 完了条件: `cd server && node --test test/eval-claude.test.ts` → 条件ごとの settings / mcp.json の生成、開始 SHA からの patch（未追跡を含み `.tools` などを除く）、stream の最後の result の答え、collect が claude-runs を読むテストが pass
  - コミット: `feat(evals): run Claude locally in a sandboxed claude -p and collect from its run directory (T03)`

- [ ] T04: canary（権限・文脈・DB）と生成した settings の単体テストを足す
  - 種別: 追加
  - 計画: S3
  - 依存: T03（runner の settings と起動の形が要る）
  - 変更: `server/evals/cloud/claude.ts`, `server/evals/cloud/canary.ts`, `server/test/eval-claude.test.ts`
  - 完了条件: `cd server && node --test test/eval-claude.test.ts` → 生成した settings に持ち主の実パスの読み取り禁止・allowUnsandboxedCommands=false・failIfUnavailable=true があり、canary の判定が「未試行」「ログ欠落」「sentinel の変化」を失敗にするテストが pass。`node evals/cloud/claude.ts --canary --build <build>` → 全項目 blocked / matched で 0
  - コミット: `feat(evals): refuse to start Claude runs until the canary is blocked (T04)`

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
