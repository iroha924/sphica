---
kind: tasks
plan: 30-issue-212-eval-base.plan.md
branch: feat/issue-212-eval-base
base: main
---

# #212: 実験を判定する検索ベンチ・評価ループの内訳・テストの基盤を入れる のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 検索ベンチ

モデルを呼ばずに、検索の変更を main と並べて正解あり・正解なしの指標で比べられる。

- [x] T01: 検索ベンチのコーパスとランナー、verify で動くことを見るテスト
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `server/evals/retrieval/corpus.json`, `server/evals/retrieval/bench.ts`, `server/evals/retrieval/run.ts`, `server/test/retrieval-bench.test.ts`, `knip.json`
  - 完了条件: `cd server && node evals/retrieval/run.ts` → 正解あり 48・正解なし 12 と、recall@1/5/10・MRR・誤表示率を全体・言語の組み合わせ別・overlap 別に出す。`node --test test/retrieval-bench.test.ts` → 通り、コーパスの質問を一時的に 1 件削ると件数不足で落ちる（戻す）
  - コミット: `test(search): add an offline retrieval benchmark with answerable and unanswerable questions (T01)`
  - 結果: `cd server && node evals/retrieval/run.ts` → 正解あり 48・正解なし 12。全体 R@1/5/10 47.9%・MRR 0.479・正解なしで返した率 0.0%。overlap 79.2%、no overlap 16.7%。言語別 en>en 50.0%、en>ja 75.0%、ja>en 25.0%、ja>ja 41.7%（いずれも R@1）。`node --test test/retrieval-bench.test.ts` → 1 pass（0.3 秒）。質問を 1 件消すと actual 47 / expected 48 で落ちた（戻した）。`bun run verify` → exit 0

- [x] T02: `--compare <ref>` で旧版の worktree に DB を作って並べる
  - 種別: 追加
  - 計画: S1
  - 依存: T01（写すランナーとコーパスが要る）
  - 変更: `server/evals/retrieval/run.ts`
  - 完了条件: `cd server && node evals/retrieval/run.ts --compare main` → main と作業ツリーの 2 列で同じ指標を出す。ランナーの API が無い古い ref（例: `v0.5.0`）ではその旨で落ちる
  - コミット: `test(search): compare the retrieval benchmark against another ref, each with its own index (T02)`
  - 結果: `cd server && node evals/retrieval/run.ts --compare main` → main と this tree の 2 列（1.7 秒、worktree は片付く）。作業ツリーの STOP に語を一時的に足すと this tree だけが 47.9% → 50.0% に変わり、main は変わらない（戻した）。`--compare v0.4.0` → 「the benchmark does not run against v0.4.0 (its source lacks what the runner uses)」で落ちる。`bun run verify` → exit 0

## P2: 受け入れケースの 4 種

superseded・abstention・poisoned・override の製品側の挙動がケースで固定される。

- [ ] T03: 受け入れケースに 4 種を足す
  - 種別: 追加
  - 計画: S2
  - 依存: なし
  - 変更: `server/evals/acceptance/cases.json`, `server/evals/acceptance/world.json`
  - 完了条件: `bun run acceptance` → 4 種を含めて通る（今のコードで落ちたケースは、修正タスクを足して直してから）
  - コミット: `test(acceptance): pin superseded, abstention, poisoned, and override behavior (T03)`

## P3: 評価ループの記録・採点・報告

クラウドのループの報告で、検索の失敗と利用の失敗、群、gold − inject、再提案率、counterfactual、採点者の一致が読める。

- [ ] T04: クラウドのタスクに 4 種を足し、fixture に記録を足す
  - 種別: 追加
  - 計画: S3
  - 依存: なし
  - 変更: `server/evals/cloud/tasks.json`, `server/evals/cloud/fixture.ts`, `server/test/eval-grade.test.ts`
  - 完了条件: `cd server && node evals/cloud/build.ts --dry-run` 相当の既存の検査（build が fixture と gold の本文を確かめる）が 8 タスクで通る。`node --test test/eval-grade.test.ts` → 通る
  - コミット: `test(eval): add superseded, abstention, poisoned, and override tasks (T04)`

- [ ] T05: gold key ごとの `in_delivery`・`in_search`・`read`
  - 種別: 追加
  - 計画: S4
  - 依存: なし
  - 変更: `server/evals/cloud/collect.ts`, `server/evals/cloud/judge.ts`, `server/test/eval-grade.test.ts`
  - 完了条件: `cd server && node --test test/eval-grade.test.ts` → Codex の `mcp_tool_call` の入力例から 3 信号が出る。Claude のログは、呼び出しと結果が交互なら信号が出て、並行（結果の前に次の呼び出し）なら `unknown` になるテストが通る
  - コミット: `feat(eval): record per gold key whether it was delivered, in a search result, or read (T05)`

- [ ] T06: build ID、plan.json、`collect.ts --build`
  - 種別: 変更
  - 計画: S5
  - 依存: なし
  - 変更: `server/evals/cloud/build.ts`, `server/evals/cloud/collect.ts`, `server/test/eval-grade.test.ts`
  - 完了条件: `cd server && node --test test/eval-grade.test.ts` → 計画の行にブランチが照合され、ブランチの無い行が task・condition 付きの run 無しとして残るテストが通る。2 回の build が互いの出力を消さない
  - コミット: `feat(eval): build under an id with a firing plan, and collect against the plan (T06)`

- [ ] T07: counterfactual の反転版の記録と `--variant swapped`
  - 種別: 追加
  - 計画: S6
  - 依存: T06（build ID と plan.json が要る）
  - 変更: `server/evals/cloud/build.ts`, `server/evals/cloud/fixture.ts`, `server/evals/cloud/tasks.json`, `server/test/eval-grade.test.ts`
  - 完了条件: `cd server && node --test test/eval-grade.test.ts` → swapped の build の gold 記録で採った案と却下案が入れ替わり、run に variant が付き、hidden test が使われないテストが通る
  - コミット: `feat(eval): add a swapped gold variant for the counterfactual check (T07)`

- [ ] T08: 評価スキーマを zod から作る
  - 種別: 変更
  - 計画: S10
  - 依存: なし
  - 変更: `server/evals/cloud/schema-check.ts`, `server/evals/cloud/answer.schema.json`, `server/evals/cloud/grade.schema.json`, `server/test/eval-grade.test.ts`
  - 完了条件: `cd server && node --test test/eval-grade.test.ts` → zod から作った JSON Schema がファイルと一致し、全 object が `additionalProperties: false` で全プロパティ required のテストが通る
  - コミット: `refactor(eval): generate the answer and grade schemas from zod (T08)`

- [ ] T09: 採点の欄（`proposes_rejected`、`followed`）と 2 人目の採点者
  - 種別: 追加
  - 計画: S7
  - 依存: T08（欄を足すスキーマの出所が要る）, T07（`followed` を付ける variant が要る）
  - 変更: `server/evals/cloud/grade.ts`, `server/evals/cloud/grading.ts`, `server/evals/cloud/schema-check.ts`, `server/evals/cloud/grade.schema.json`, `server/test/eval-grade.test.ts`
  - 完了条件: `cd server && node --test test/eval-grade.test.ts` → Claude の採点の出力例が同じ schema で読め、2 人の採点が run ごとに並び、報告の値が Codex 採点のままのテストが通る
  - コミット: `feat(eval): grade proposals of rejected options and followed versions with a second grader (T09)`

- [ ] T10: `report.ts`（群、gold − inject、再提案率、counterfactual、採点者の一致）
  - 種別: 追加
  - 計画: S7
  - 依存: T05（gold key の信号が要る）, T06（build ごとの結果が要る）, T09（採点の欄が要る）
  - 変更: `server/evals/cloud/report.ts`, `server/evals/cloud/grading.ts`, `server/test/eval-grade.test.ts`
  - 完了条件: `cd server && node --test test/eval-grade.test.ts` → 作った loop と grades の入力から、言語の組み合わせ別・overlap 別・gold の有無別、タスク×モデルの gold − inject（各 run と n）、再提案率、元版と反転版の並び、採点者の一致率が出るテストが通る
  - コミット: `feat(eval): report by group, gold minus inject per task, re-proposals, and grader agreement (T10)`

## P4: テスト

性質・時間・順序・promise・Skill と型の食い違いが機械で見つかる。

- [ ] T11: fast-check のプロパティテストと `mask()` の時間のテスト
  - 種別: 追加
  - 計画: S8
  - 依存: なし
  - 変更: `server/package.json`, `bun.lock`, `server/test/text-properties.test.ts`
  - 完了条件: `cd server && node --test test/text-properties.test.ts` → 通る。`mask()` の比を 10 回測った値を結果に残し、閾値を確定する
  - コミット: `test(text): add property tests with fast-check and a growth check for mask (T11)`

- [ ] T12: Node 26 の順序ランダム化と Biome の promise の 2 ルール
  - 種別: 変更
  - 計画: S9
  - 依存: なし
  - 変更: `.github/workflows/check.yml`, `biome.json`
  - 完了条件: `bun run lint` → 0 件で通る。`cd server && node --test --test-randomize --test-random-seed=12345 test/*.test.ts` を Node 26 で流して通る（順序依存が出たら直す）
  - コミット: `ci: run tests in random order on Node 26 and flag floating promises (T12)`

- [ ] T13: trace・glean の Skill の JSON 欄と zod の型の突き合わせ
  - 種別: 追加
  - 計画: S10
  - 依存: なし
  - 変更: `scripts/check-pairs.mjs`
  - 完了条件: `bun run pairs` → 通り、Skill の欄の表から 1 行を一時的に消すと落ちる（戻す）
  - コミット: `test(pairs): match the trace and glean Skills' JSON fields with the zod types (T13)`

- [ ] T14: Stryker を手で 1 回流し、意味のある生存変異をテストで殺す
  - 種別: 追加
  - 計画: S11
  - 依存: T11（プロパティテストが入った後の生存変異を見る）
  - 変更: `server/test/text-properties.test.ts`, `server/test/search.test.ts`
  - 完了条件: `cd server && node --test test/text-properties.test.ts test/search.test.ts` → 足したテストが通る。Stryker の版・コマンド・対象・生存変異の数と除外の理由を結果に残す
  - コミット: `test: kill the surviving mutants that matter in text, anchors, and search (T14)`

## P5: 評価ループの手順

新しい流し方で 1 ループを回せる手順が Skill にある。

- [ ] T15: eval-loop Skill を build ID・plan.json・report.ts の流し方に書き換える
  - 種別: 変更
  - 計画: S12
  - 依存: T06（build ID と plan.json が要る）, T10（report.ts が要る）
  - 変更: `.claude/skills/eval-loop/SKILL.md`
  - 完了条件: `bun run verify:ai` → 通る。Skill の手順に `--variant`、`plan.json`、`collect.ts --build`、`report.ts`、流す前の見積もりの確認がある
  - コミット: `docs(eval-loop): run a loop by build id, firing plan, and report (T15)`

## 記録
- 2026-09-30 / T01 / テストからも同じ計算を呼ぶため、計算を bench.ts に分け、run.ts は出力だけにした。knip の entry に run.ts を足した / 変更欄（前: corpus.json・run.ts・テスト、後: それに bench.ts と knip.json を足した）。overlap の質問で外れた 5 件は、質問にだけある語で「半分より多く」の規則を満たさないためで、ラベルは正しい
- 2026-09-30 / T02 / 完了条件の古い ref の例 v0.5.0 は、ランナーが使う API がそろっていて通った / 落ちることは v0.4.0（generation 1）で確かめた（前: `v0.5.0`、後: `v0.4.0`）
