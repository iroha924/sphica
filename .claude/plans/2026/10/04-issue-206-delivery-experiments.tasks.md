---
kind: tasks
plan: 04-issue-206-delivery-experiments.plan.md
branch: feat/issue-206-delivery
base: feat/issue-206-eval-base
---

# Measure #206's delivery changes and #211's alwaysLoad against the local evaluation base, and ship only the combination that passes (PR-B) のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 定義と各 G の実装

配信の行に載せる日付・採用者・出どころ・anchor の状態を求められ、各 G がそれぞれ 1 コミットで入る（測るときは G ごとに PR-A の HEAD へ当てる）。

- [x] T01: 保存した月・採用者・出どころ・anchor の状態を求める読み取りを足す
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `server/src/provenance.ts`, `server/src/text.ts`, `server/src/read.ts`, `server/src/export.ts`, `server/test/provenance.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `cd server && node --test test/provenance.test.ts` → owner > maintainer > other の採用者、取り消された evidence を数えない出どころ、reported_speaker を伝えられた側と数える、anchor の状態の一番悪いもの、のテストが pass
  - コミット: `feat(deliver): read a record's saved month, adopter, speakers, and anchor state (T01)`
  - 結果: `node --test test/provenance.test.ts` → pass 2, fail 0。`bun run sql:reach` → 207 / 207。`npx tsc --noEmit` → エラーなし

- [ ] T02: G1a 配信の行に保存した月・採用者・anchor の状態を載せる
  - 種別: 変更
  - 計画: S2
  - 依存: T01（定義の読み取りが要る）
  - 変更: `server/src/deliver.ts`, `server/evals/cloud/build.ts`, `server/evals/cloud/judge.ts`, `server/test/deliver.test.ts`, `server/test/eval-grade.test.ts`
  - 完了条件: `cd server && node --test test/deliver.test.ts test/eval-grade.test.ts` → 行が `- <key> (<kind> <stance>; saved YYYY-MM; adopted by <who>; anchor <state>): …` になり、gold の描画と受け取りの検査が新しい形で通るテストが pass
  - コミット: `feat(deliver): show when a record was saved, who adopted it, and its anchor state (T02)`

- [ ] T03: G1b 引用を先に置き、長い Why を配信から外す
  - 種別: 変更
  - 計画: S3
  - 依存: T01（evidence の引用の読み取りが要る）
  - 変更: `server/src/deliver.ts`, `server/evals/cloud/build.ts`, `server/test/deliver.test.ts`
  - 完了条件: `cd server && node --test test/deliver.test.ts` → 引用が先に出て `Why:` が出ず、Rejected は残り、同じ記録の文字数が減るテストが pass
  - コミット: `feat(deliver): lead with the quoted words and drop the long reason (T03)`

- [ ] T04: G2 読む前・編集の前・セッション開始の broad constraints を重みの順に選ぶ
  - 種別: 変更
  - 計画: S4
  - 依存: T01（採用者の読み取りが要る）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - 完了条件: `cd server && node --test test/deliver.test.ts` → constraint → dont → オーナーの採用 → maintainer の採用 → 新しい順に選ぶテストが pass
  - コミット: `feat(deliver): choose records by weight before age (T04)`

- [ ] T05: G3 未解決の衝突を 1 行で見せる
  - 種別: 変更
  - 計画: S5
  - 依存: なし
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - 完了条件: `cd server && node --test test/deliver.test.ts` → 未解決の衝突の 2 件が 1 行で出て delivery_unit に 2 件とも入り、読み込みの予算を 2 件と数え、同じ窓で 2 度出ず、解決済みは今と同じのテストが pass
  - コミット: `feat(deliver): show an unresolved conflict as one line naming both records (T05)`

- [x] T06: G4 第三者かエージェントの言葉だけの記録を hook で押し込まず、引用を話者の種類で囲む
  - 種別: 変更
  - 計画: S6
  - 依存: T01（出どころの読み取りが要る）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`, `server/test/eval-fixture.test.ts`
  - 完了条件: `cd server && node --test test/deliver.test.ts` → 第三者だけは押し込まず search では見つかる、伝聞は第三者、混ざった evidence と owner / maintainer は押し込む、取り消された evidence は数えない、のテストが pass
  - コミット: `feat(deliver): keep records resting only on others' words out of hooks (T06)`
  - 結果: ブランチ exp/206-g4（T01 から分けた）。`node --test test/deliver.test.ts` → pass 35, fail 0。`node --test test/eval-fixture.test.ts` → pass 2（backup の upload の記録は届かない）。acceptance → pass 105, fail 0。引用の囲いは入れていない（下の記録）

- [ ] T07: G6 読み取り MCP の search に alwaysLoad を付ける
  - 種別: 変更
  - 計画: S7
  - 依存: なし
  - 変更: `server/src/mcp.ts`, `server/test/plugin.test.ts`
  - 完了条件: `cd server && node --test test/plugin.test.ts` → tools/list で search だけが `_meta["anthropic/alwaysLoad"] === true` を持つテストが pass
  - コミット: `feat(mcp): load search up front in Claude Code (T07)`

## P2: 測定と判定

baseline と各 variant をローカルで回して各 G を判定し、通った G の組み合わせを測り直して、出すものを決める。

- [ ] T08: report の比較に各 G のバーと共通の回帰の判定を足す
  - 種別: 追加
  - 計画: S8
  - 依存: なし
  - 変更: `server/evals/cloud/report.ts`, `server/test/eval-grade.test.ts`
  - 完了条件: `cd server && node --test test/eval-grade.test.ts` → `--compare --bar <g1a|g3|g4|g6>` が plan のバーどおりに「通過 / 未達 / 判定不能」を出し、共通の回帰を全回帰セルで判定するテストが pass
  - コミット: `feat(evals): judge each experiment's bar and the shared regression rule (T08)`

- [ ] T09: baseline と各 variant を回し、通った G の組み合わせを測り直して、通らなかった G を戻し、バージョンを揃える
  - 種別: 変更
  - 計画: S8, S9, S10
  - 依存: T02（G1a の variant が要る）, T03（G1b の variant が要る）, T04（G2 の variant が要る）, T05（G3 の variant が要る）, T06（G4 の variant が要る）, T07（G6 の variant が要る）, T08（判定が要る）
  - 変更: `server/src/deliver.ts`, `server/src/mcp.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `node evals/cloud/report.ts --compare <baseline>/grades.json <final>/grades.json --bar all` → 残した G が全部「通過」、共通の回帰も「通過」。`bun run release:plan -- --base v0.6.28` → 残した G があれば plugin、無ければ none
  - コミット: `feat(deliver): ship the delivery changes that passed their measurement (T09)`

## 記録
- 2026-10-04 / T01 / 読み取りは配信以外（read の表示など）でも使える形なので、deliver.ts ではなく新しい `provenance.ts` に置いた。引用のバイトの切り出し `cut` を read.ts から text.ts へ移した（read.ts を配信フックから読むと git まわりまで bundle に入るため）。テストは deliver.test.ts ではなく `provenance.test.ts`（変更欄 前: deliver.ts と deliver.test.ts、後: provenance.ts・text.ts・read.ts・export.ts・provenance.test.ts）
- 2026-10-04 / T01 / pre-commit の bundle の検査が、パッケージに入る変更のコミットにバージョンの揃えを求めた / `release:plan -- --base v0.6.28`（plugin）を流してから、npm と 3 つの manifest を 0.6.29 に上げて T01 に入れた。T09 で通る G が無ければ戻す（変更欄にバージョンの 4 ファイルを足した）
- 2026-10-04 / T06 / G4 単独では行に引用が出ないので、囲う対象が無い / 引用の囲い（spotlighting）は G1b と G4 を合わせるときに足す。G4 単独は「出どころでの絞り込み」だけを測る。エージェントだけの言葉の finding や dead end もフックで出なくなる（記録の汚染の経路を塞ぐ代わりに、配信が減る）ので、回帰のセルで見る
