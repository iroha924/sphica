---
kind: tasks
plan: 06-t1-eval-checkpoint.plan.md
branch: fix/t1-eval-checkpoint
base: main
---

# 評価の採点を終わった分から保存し、止まった後の再実行では残りだけを採点する（#269）のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: checkpoint の部品

採点者の結果を保存する場所の読み書きと、入力が一致するかを決めるキーを作る。grade.ts の挙動はまだ変えない。

- [ ] T01: `checkpointKey`・`loadCheckpoint`・`saveCheckpoint` と採点者の起動引数の定数を足す
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `server/evals/cloud/grading.ts`, `server/test/eval-grade.test.ts`
  - 完了条件: `cd server && node --test --test-name-pattern="checkpoint" test/eval-grade.test.ts` → pass。何も変えなければ同じキー、plan の各要素を 1 つずつ変えると違うキー（swapped で expect・against を変えたとき、文面だけを変えたときも含む）。無いファイルは空、壊れた JSON・形の違い・version の違いはパスを挙げて throw し、ファイルのバイト列は変わらない。保存した内容を読み戻すと同じ
  - コミット: `feat(eval): add the grading checkpoint's key, load, and atomic save (T01)`

## P2: grade.ts が checkpoint で動く

採点者の呼び出しを 1 件ずつ保存し、再実行では入力が一致しない分と終わっていない分だけを採点する。

- [ ] T02: grade.ts を checkpoint で動かし、`grades.json` をアトミックに書く
  - 種別: 修正
  - 計画: S2
  - 依存: T01（キーと読み書きが要る）
  - 変更: `server/evals/cloud/grade.ts`, `server/test/eval-grade.test.ts`
  - red: grade.ts を変える前に、止まった実行の再開のテスト（`checkpoint resumes`）だけを足して `cd server && node --test --test-name-pattern="checkpoint resumes" test/eval-grade.test.ts` → fail（再実行で codex が 3 回呼ばれる。期待は 2 回）
  - 完了条件: `cd server && node --test --test-name-pattern="checkpoint" test/eval-grade.test.ts` → pass。plan の方針にある子プロセスのテスト（再開、終わったビルドの再実行で 0 回、answer を変えた行だけ、終了コード 1 は呼び直し・形の崩れは使い回し、Claude の途中で止めた再開、壊れた checkpoint、文面が同じで run が違う 2 行、保存の失敗）がすべて通る。既存の `the grader runs with its own HOME` と `collect and grade refuse --out` のテストも通る
  - コミット: `fix(eval): save each grader result as it finishes and grade only what is left on a rerun (T02)`

## P3: 手順書

eval-loop Skill に checkpoint と、最初から採点し直す方法を書く。

- [ ] T03: eval-loop Skill の 5 段目に checkpoint の 1 行を足す
  - 種別: 変更
  - 計画: S3
  - 依存: T02（書く挙動が grade.ts に入っている必要がある）
  - 変更: `.claude/skills/eval-loop/SKILL.md`
  - 完了条件: `bun run verify:ai` → 通る。5 段目に `grades.checkpoint.json`、再実行は残りだけを採点すること、最初からやり直すには消すこと、Claude の既定のモデルの変化は検出しないことが書いてある
  - コミット: `docs(skills): say how grading resumes from its checkpoint (T03)`

## 記録
