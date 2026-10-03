---
kind: tasks
plan: 03-issue-239-eval-loop-findings.plan.md
branch: fix/issue-239-eval-loop-findings
base: main
---

# Fix the four review findings of the cloud evaluation loop (#239) before the next loop のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 信号と採点の入力を正す

壊れたログでもヒットを失わず、gold が届かなかった run を gold の結果に数えない。

- [x] T01: Codex のログに壊れた行があっても確かなヒットを yes に残す
  - 種別: 修正
  - 計画: S1
  - 依存: なし
  - 変更: `server/evals/cloud/judge.ts`, `server/test/eval-grade.test.ts`
  - red: `cd server && node --test --test-name-pattern='proven hit' test/eval-grade.test.ts` → ヒットと壊れた行の両方の順で `in_search` / `read` が `unknown` になり落ちる
  - 完了条件: `cd server && node --test test/eval-grade.test.ts` → 全件 pass
  - コミット: `fix(evals): keep a proven hit when a Codex log has a broken line (T01)`
  - 結果: red 実測（3e842e19 の judge.ts）: `search hit with {bad json ...` で actual 'unknown' / expected 'yes' で落ちた。直した後 `node --test test/eval-grade.test.ts` → pass 40, fail 0

- [ ] T02: gold フックが gold を返さなかった gold の run を excluded にする
  - 種別: 修正
  - 計画: S2
  - 依存: なし
  - 変更: `server/evals/cloud/judge.ts`, `server/evals/cloud/collect.ts`, `server/test/eval-grade.test.ts`
  - red: `cd server && node --test --test-name-pattern='gold hook returned no record' test/eval-grade.test.ts` → receipt が無い・空・無関係の gold の run が excluded にならず落ちる
  - 完了条件: `cd server && node --test test/eval-grade.test.ts` → 全件 pass（swapped の gold のテストを含む）
  - コミット: `fix(evals): exclude a gold run whose hook returned no gold record (T02)`

## P2: 段のつなぎ目を正す

report が bundle の分からない入力を通さず、collect → grade → report が同じビルドの tasks.json で流れる。

- [ ] T03: report が bundle の無い・空の grades ファイルを拒否する
  - 種別: 修正
  - 計画: S3
  - 依存: なし
  - 変更: `server/evals/cloud/report.ts`, `server/test/eval-grade.test.ts`
  - red: `cd server && node --test --test-name-pattern='bundle' test/eval-grade.test.ts` → bundle が両方無い・両方空の 2 ファイルで report が 0 で終わり落ちる
  - 完了条件: `cd server && node --test test/eval-grade.test.ts` → 全件 pass
  - コミット: `fix(evals): refuse grades files without a bundle in the report (T03)`

- [ ] T04: collect と grade の --out を消し、成果物をビルドディレクトリに固定する
  - 種別: 修正
  - 計画: S4
  - 依存: なし
  - 変更: `server/evals/cloud/collect.ts`, `server/evals/cloud/grade.ts`, `server/test/eval-grade.test.ts`
  - red: `cd server && node --test --test-name-pattern='--out' test/eval-grade.test.ts` → ビルドの外を指す `--out` を collect と grade が受け付けて 0 で終わり、そこにファイルができて落ちる
  - 完了条件: `cd server && node --test test/eval-grade.test.ts` → 全件 pass。`rg -n -- '--out' server/evals/cloud/collect.ts server/evals/cloud/grade.ts` → 出力先としての `--out` が無い
  - コミット: `fix(evals): write loop and grades files only in the build directory (T04)`

## 記録
