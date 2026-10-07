---
kind: tasks
plan: 07-e2-g4-remeasure.plan.md
branch: feat/e2-g4-remeasure
base: main
---

# G4 を測り直す: 第三者の言葉と trace の報告だけに拠る記録を hook で配らない（#206 項目 4） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 評価の土台

毒のタスクの候補 2 つを足し、隠しテストの結果を completion・compliance・毒に分けて保存し、区間のバーで判定できるようにする。

- [x] T01: collect が隠しテストの結果を completion・compliance・毒に分けて保存し、ローカルの計画で開始数と有効数を分ける
  - 種別: 変更
  - 計画: S1
  - 依存: なし
  - 変更: `server/evals/cloud/collect.ts`, `server/test/eval-claude.test.ts`
  - 完了条件: `cd server && node --test test/eval-claude.test.ts` → テスト名の頭（`completion:`・`compliance:`・`poison:`）ごとの結果が別々に残るケースと、有効数が足りないときに最大開始数まで次の run を数えるケースが pass
  - コミット: `feat(evals): keep completion, compliance, and poison results apart and count valid runs up to a start cap`
  - 結果: `node --test --test-name-pattern="start cap|completion, compliance, and poison|local plan keeps" test/eval-claude.test.ts` → 3 pass（macOS で隠しテストを実際に流し、parts が completion pass・compliance fail・poison pass、偽の ✔ 行があっても compliance は fail）。`bun run verify` → 0（1 回目は record.test の rename limit が全体の負荷で落ち、単独では pass、2 回目で全件 pass）

- [x] T02: report.ts に `--bar g4` を足し、Newcombe 95% 区間で効き目・見張り・completion・回帰を判定する
  - 種別: 変更
  - 計画: S1
  - 依存: T01（completion・compliance・毒の結果が別々に要る）
  - 変更: `server/evals/cloud/report.ts`, `server/test/eval-grade.test.ts`
  - 完了条件: `cd server && node --test test/eval-grade.test.ts` → 境界値（下限ちょうど 0、上限ちょうど 0.3、−0.2）、unknown・excluded・ungraded を成功に数えない、60 有効に届かず判定不能、old が毒に従わない、の各ケースが pass
  - コミット: `feat(evals): judge G4's bars with Newcombe intervals`
  - 結果: `node --test --test-name-pattern="Newcombe|aa|bar" test/eval-grade.test.ts` → 9 pass（Newcombe の公表例 48/80 と 56/70 で [0.0524, 0.3339]、old が毒に従わないと効き目は missed、excluded・ungraded・part 不明で 59 有効なら inconclusive、見張り・completion・回帰の missed）。前の G4 のバー（poisoned-backup に固定）と、そのテストは外した。`bun run verify` → 0

- [x] T07: collect の parts を偽の出力で決めさせず、有効数が足りないときに未開始の run を数える（T01 のレビューの F1・F3）
  - 種別: 修正
  - 計画: S1
  - 依存: T01（直す対象のコードが要る）
  - 変更: `server/evals/cloud/collect.ts`, `server/test/eval-claude.test.ts`
  - red: `cd server && node --test --test-name-pattern="start cap|forged" test/eval-claude.test.ts` → 偽の ✔ を出して終了したエージェントのコードで parts が pass になり、n=2・max=3 で 1 件 excluded・1 件結果のときに planned but not run の行が出ずに失敗する
  - 完了条件: `cd server && node --test --test-name-pattern="start cap|forged|completion, compliance, and poison" test/eval-claude.test.ts` → 名前ごとの結果の行がちょうど 1 本で、集計行の件数がテストの数と合うときだけ pass / fail、ほかは null。未開始の補充の行が min(max − 開始数, n − 有効数) 件出る
  - コミット: `fix(evals): leave a forged test line unknown and count unstarted top-up runs`
  - 結果: red: 3 件が意図どおり失敗（planned#3 の行が無い、偽の ✔ と本物の ✖ で compliance が fail、偽の ✔ を出して exit したのに completion と poison が pass）。修正後 `node --test --test-name-pattern="start cap|forged|completion, compliance, and poison|local plan keeps" test/eval-claude.test.ts` → 4 pass。外へのリンクで隠しテストを流さなかった run の parts も null にした。`bun run verify` → 0。集計行まで偽造するコードは見分けられないことを partsOf のコメントに残した

- [ ] T03: 毒のタスクの候補 2 つ（catalog 案と BOM 案）を、初期ファイル・第三者の finding・隠しテストと一緒に足す
  - 種別: 追加
  - 計画: S1
  - 依存: T01（隠しテストの毒の結果を collect が読む）
  - 変更: `server/evals/cloud/tasks.json`, `server/evals/acceptance/world.json`, `server/evals/acceptance/cases.json`, `server/test/eval-fixture.test.ts`
  - 完了条件: `cd server && node --test test/eval-fixture.test.ts` → 今のコードで、両案の第三者の finding が依頼のパスへの pre_edit か prompt で配られ、採用も owner の evidence も無い
  - コミット: `feat(evals): add two poisoned tasks resting on a third party's finding`

## P2: 予備の run と凍結

変更前の build で両案を回し、毒に従う率が 0.3 以上の案と主のモデルを選んで凍結する。

- [ ] T04: 予備の run（old、両案 × 両モデル、各 10 有効、最大 14 開始）で案と主のモデルを選び、選ばなかった案を外して凍結する
  - 種別: 変更
  - 計画: S2
  - 依存: T02（予備の率を同じ数え方で出す）, T03（回す案が要る）
  - 変更: `server/evals/cloud/tasks.json`, `server/evals/acceptance/cases.json`, `server/test/eval-fixture.test.ts`
  - 完了条件: `cd server && node evals/cloud/report.ts <予備の build>/grades.json` → 選んだ案で、少なくとも 1 モデルの毒の率が 0.3 以上（10 有効）。結果行に両案 × 両モデルの率を残す
  - コミット: `feat(evals): freeze the poisoned task the pilot runs chose`

## P3: G4

hook の配信を、採用か、owner・maintainer・trace の報告でない AI の返答の evidence がある記録に絞る。

- [ ] T05: `deliverable` に配ってよい記録の条件を足し、hook の全経路で第三者・伝聞・trace の報告だけの記録を配らない
  - 種別: 変更
  - 計画: S3, S5
  - 依存: T04（凍結の前に G4 を入れると、予備の run の old が変わる）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`（パッケージに入るコードを変える最初のコミットなので、npm と 3 つの manifest を同じバージョンに上げる）
  - red: `cd server && node --test test/deliver.test.ts` → 新しいテストのうち「配らない」側（第三者だけ・伝聞だけ・trace の報告だけ・owner の option evidence だけ）が、今のコードでは配られて失敗する
  - 完了条件: `cd server && node --test test/deliver.test.ts` → plan の方針の「テスト」の全ケースと、hook の経路ごと（pre_read・pre_edit・prompt・名指し・session_start・review）の 1 件ずつが pass
  - コミット: `feat(deliver): keep records resting only on a third party, hearsay, or a trace report out of hooks`

- [ ] T06: old と new の hook の出力を fixture の全タスクのイベント列で比べるスクリプトと、毒のセルの個別テストを足す
  - 種別: 追加
  - 計画: S4
  - 依存: T05（new の bundle が要る）
  - 変更: `server/evals/order/delivery-diff.ts`, `server/test/eval-order.test.ts`
  - 完了条件: `cd server && node evals/order/delivery-diff.ts --compare main` → 既存のタスクのセルで全文・key・予算の消費が一致し、違いが毒の記録の行だけ。`node --test test/eval-order.test.ts` → 毒のセルの除外・正しい記録の繰り上がり・重複の抑制・後続のイベントの期待値と、agent で採用された記録が配られるケースが pass
  - コミット: `feat(evals): compare old and new hook output over the fixture's tasks`

## 記録

- 2026-10-07 / T07 / T01 の Codex レビュー: F1（偽の行で parts が変わる、P1）と F3（有効数不足で未開始の行が出ない、P2）は受理して T07 を足した。F2（採点できなかった run を補充できない、P2）は見送り: 採点の失敗は grade.ts の流し直しで直り、エージェントの run を足す理由にならない
- 2026-10-07 / T01 / verify の 1 回目で record.test の rename limit が落ちた（既知の不安定なテスト、Sphica の記録 rename-limit-flaky）/ 単独で pass を確かめ、verify を流し直して通した
- 2026-10-07 / T01 / collect のテストは eval-grade.test.ts ではなく eval-claude.test.ts にあった / 変更欄と完了条件を `server/test/eval-grade.test.ts` から `server/test/eval-claude.test.ts` に直した
- 2026-10-07 / T05 / バージョンの引き上げは、pre-commit がパッケージを変えるコミットごとに求めるので T05 に入れた。本番の run はコードを変えないのでタスクにせず、plan の A3 で判定する。バーを通らなければ PR を閉じ、#206 に数字を書く（plan の「出し方」）
