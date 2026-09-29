---
kind: tasks
plan: 29-earlier-questions.plan.md
branch: feat/earlier-questions
base: main
---

# 本人の過去の発言から今の問いに似たものを探し、それが何につながったかと、決定の記録が無いまま繰り返されている問いを示す（C1a #192、C4 #197） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 置き換えを最後までたどる

置き換えが 2 段以上でも、検索が今の記録を示す。

- [x] T01: 後継を今の記録までたどる関数を作って searchUnits で使い、バージョンを上げる
  - 種別: 修正
  - 計画: S1, S8
  - 依存: なし
  - 変更: `server/src/search.ts`, `server/test/search.test.ts`, `plugin/package.json`, `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`
  - red: `cd server && node --test --test-timeout=60000 test/search.test.ts` → A → B → C と置き換えた記録で、A の一致から C に届かずに落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/search.test.ts` → 全部 pass。`bun run release:plan -- --base 0543025` → `plugin`、4 か所が同じバージョン
  - コミット: `fix(search): follow replacements to the live record, not one step`
  - 結果: red（直す前）`node --test test/search.test.ts` → pnpm → npm → bun の置き換えで、pnpm の一致から npm（途中）が返り bun に届かずに失敗。直した後 `node --test test/search.test.ts test/plugin.test.ts` → pass 37 / fail 0。`releaseKind` に差分のファイルを渡して `plugin`。4 か所を 0.6.3 にそろえた。typecheck・lint → 0、`sql:reach` 157 / 157

## P2: 過去の発言と、それが何につながったか

`search` の `asked: true` で、本人の過去の発言とつながった記録、決定の有無、繰り返しが分かる。

- [x] T02: 本人の発言だけを上限まで読んで一致させる形を足す
  - 種別: 追加
  - 計画: S2
  - 依存: なし
  - 変更: `server/src/search.ts`, `server/test/search.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/search.test.ts` → 全部 pass（本人の発言だけ、今のセッションを除く、条件が上限の前、`limit` で止めない）
  - コミット: `feat(search): match earlier owner messages across the whole scan`
  - 結果: `node --test test/search.test.ts` → pass 11 / fail 0（今のセッションの一致 601 件が上限を食わずに、別のセッションの本人の発言 3 件を全部返す。AI の返事と PR の本文は返らない。当たりにセッションとターンが付く）。typecheck・lint → 0

- [x] T03: 一致した発言ごとのつながった記録・同じターンの文脈・決定の有無と、繰り返しの行を組み立てる
  - 種別: 追加
  - 計画: S3, S4
  - 依存: T01（後継をたどる関数が要る）, T02（一致した発言の一覧が要る）
  - 変更: `server/src/asked.ts`, `server/test/asked.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/asked.test.ts` → 全部 pass（plan のテストの節の asked の項目）
  - コミット: `feat(search): show what earlier owner messages led to and repeats with no recorded decision`
  - 結果: `node --test test/asked.test.ts` → pass 2 / fail 0（2 回置き換えた決定は後継 bun まで示す、trace 済みで記録なし・未 trace・finding だけを「No recorded decision」、同じターンの AI の返事を引用した記録は文脈に分けて返事を id で示す、絞り込みで隠しても「No recorded decision」と言わず件数を言う、表示 1 件でも 2 セッションの繰り返しを trace 済み・未 trace に分けて示す、決定のあるセッションが入ると繰り返しの行は出ない、今のセッションを除く）。typecheck・lint・knip → 0、`sql:reach` 161 / 161、architecture・english → 通過

- [ ] T04: MCP の search に asked を足す
  - 種別: 追加
  - 計画: S5
  - 依存: T03（文の中身が要る）
  - 変更: `server/src/mcp.ts`, `server/test/plugin.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/plugin.test.ts` → 全部 pass（`asked` の文、`sources` や `path` との組み合わせを断る）
  - コミット: `feat(mcp): search earlier owner messages with asked`

## P3: 測定と acceptance

- [ ] T05: 固定のコーパスで関係ない発言を返す率を測るローカルの評価を足して流す
  - 種別: 追加
  - 計画: S6
  - 依存: T03（一致と組み立てが要る）
  - 変更: `server/evals/asked/run.ts`, `server/evals/asked/corpus.json`
  - 完了条件: `node server/evals/asked/run.ts` → 関係ない / 返した数、見落とし、空、上限で止まった問いを出力する。`bun run verify` → 0
  - コミット: `test(evals): measure unrelated earlier-message matches on a fixed corpus`

- [ ] T06: asked の acceptance case を足す
  - 種別: 追加
  - 計画: S7
  - 依存: T03（組み立てが要る）
  - 変更: `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`, `server/test/acceptance-cases.test.ts`
  - 完了条件: `bun run acceptance` → 追加した case を含めて全部 pass。`bun run verify` → 0
  - コミット: `test(acceptance): cover earlier owner messages and what they led to`

## 記録
