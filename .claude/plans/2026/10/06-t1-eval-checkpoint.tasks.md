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

- [x] T01: `checkpointKey`・`loadCheckpoint`・`saveCheckpoint` と採点者の起動引数の定数を足す
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `server/evals/cloud/grading.ts`, `server/test/eval-grade.test.ts`
  - 完了条件: `cd server && node --test --test-name-pattern="checkpoint" test/eval-grade.test.ts` → pass。何も変えなければ同じキー、plan の各要素を 1 つずつ変えると違うキー（swapped で expect・against を変えたとき、文面だけを変えたときも含む）。無いファイルは空、壊れた JSON・形の違い・version の違いはパスを挙げて throw し、ファイルのバイト列は変わらない。保存した内容を読み戻すと同じ
  - コミット: `feat(eval): add the grading checkpoint's key, load, and atomic save (T01)`
  - 結果: `cd server && node --test --test-name-pattern="checkpoint" test/eval-grade.test.ts` → pass 2 / fail 0（キーは 22 通りの変更と swapped の expect・against の変更でどれも変わり、同じ入力で同じ。無いファイルは空、保存して読み戻すと同じで一時ファイルは残らない、壊れた 7 通りはパスを挙げて throw しバイト列は変わらない）。eval-grade.test.ts 全体 pass 61 / fail 0、`bun run lint`・`bun run typecheck`・`bun run english`・`bun run architecture` は指摘なし

## P2: grade.ts が checkpoint で動く

採点者の呼び出しを 1 件ずつ保存し、再実行では入力が一致しない分と終わっていない分だけを採点する。

- [x] T02: grade.ts を checkpoint で動かし、`grades.json` をアトミックに書く
  - 種別: 修正
  - 計画: S2
  - 依存: T01（キーと読み書きが要る）
  - 変更: `server/evals/cloud/grade.ts`, `server/evals/cloud/codex-home.ts`, `server/test/eval-grade.test.ts`
  - red: grade.ts を変える前に、止まった実行の再開のテスト（`checkpoint resumes`）だけを足して `cd server && node --test --test-name-pattern="checkpoint resumes" test/eval-grade.test.ts` → fail（再実行で codex が 3 回呼ばれる。期待は 2 回）
  - 完了条件: `cd server && node --test --test-name-pattern="checkpoint" test/eval-grade.test.ts` → pass。plan の方針にある子プロセスのテスト（再開、終わったビルドの再実行で 0 回、answer を変えた行だけ、終了コード 1 は呼び直し・形の崩れは使い回し、Claude の途中で止めた再開、壊れた checkpoint、文面が同じで run が違う 2 行、保存の失敗）がすべて通る。既存の `the grader runs with its own HOME` と `collect and grade refuse --out` のテストも通る
  - コミット: `fix(eval): save each grader result as it finishes and grade only what is left on a rerun (T02)`
  - 結果: red は grade.ts を変える前に `cd server && node --test --test-name-pattern="checkpoint resumes" test/eval-grade.test.ts` → fail（「the rerun grades only the two rows left」actual 3 / expected 2）。変更後は `--test-name-pattern="checkpoint"` → pass 9 / fail 0（再開、終わったビルドの再実行で 0 回と answer を変えた行だけ、exit 1 の呼び直しと形の崩れの使い回し、Claude の途中で止めた再開、壊れた checkpoint 3 通り、文面が同じ 2 行、保存の失敗）。eval-grade.test.ts 全体 pass 68 / fail 0、`bun run lint`・`bun run typecheck`・`bun run english` は指摘なし

## P3: 手順書

eval-loop Skill に checkpoint と、最初から採点し直す方法を書く。

- [x] T03: eval-loop Skill の 5 段目に checkpoint の 1 行を足す
  - 種別: 変更
  - 計画: S3
  - 依存: T02（書く挙動が grade.ts に入っている必要がある）
  - 変更: `.claude/skills/eval-loop/SKILL.md`
  - 完了条件: `bun run verify:ai` → 通る。5 段目に `grades.checkpoint.json`、再実行は残りだけを採点すること、最初からやり直すには消すこと、Claude の既定のモデルの変化は検出しないことが書いてある
  - コミット: `docs(skills): say how grading resumes from its checkpoint (T03)`
  - 結果: `bun run verify:ai` → exit 0（AI config と links の指摘なし）。5 段目に `<build dir>/grades.checkpoint.json`、止まった後の再実行は残りと入力の変わった分だけを採点すること、最初からやり直すにはファイルを消すこと、Claude の既定のモデルの変化は検出しないことを足した

- [x] T04: Codex を起動する設定を、key に入れたのと同じ本文にする
  - 種別: 修正
  - 計画: S2
  - 依存: T02（key と起動の両方が grade.ts にある）
  - 変更: `server/evals/cloud/grade.ts`, `server/evals/cloud/codex-home.ts`, `server/test/eval-grade.test.ts`
  - red: `cd server && node --test --test-name-pattern="checkpoint starts Codex" test/eval-grade.test.ts` → fail（1 回目の呼び出しで持ち主の config を model "n" に変えると、2 回目の Codex が model "n" で起動する。key は model "m" のまま）
  - 完了条件: `cd server && node --test --test-name-pattern="checkpoint" test/eval-grade.test.ts` → pass。途中で持ち主の config が変わっても、1 回の実行の Codex はすべて key と同じ本文の設定で起動する
  - コミット: `fix(eval): start the Codex grader with the settings its checkpoint key holds (T04)`
  - 結果: red は直す前に `cd server && node --test --test-name-pattern="checkpoint starts Codex" test/eval-grade.test.ts` → fail（actual [model "m", model "n"] / expected [model "m", model "m"]）。直した後は `--test-name-pattern="checkpoint"` → pass 10 / fail 0、eval-grade.test.ts 全体 pass 69 / fail 0、`bun run lint`・`bun run typecheck` は指摘なし。`isolatedCodexHome` は設定の本文を引数で受け、省略時は今までどおり持ち主の config を読む（codex.ts の呼び出しは変わらない）

- [x] T05: Codex に渡す schema を、key に入れたのと同じ本文にする
  - 種別: 修正
  - 計画: S2
  - 依存: T02（key と起動の両方が grade.ts にある）
  - 変更: `server/evals/cloud/grade.ts`, `server/test/eval-grade.test.ts`
  - red: `cd server && node --test --test-name-pattern="checkpoint gives Codex" test/eval-grade.test.ts` → fail（Codex の `--output-schema` が repo の `grade.schema.json` を指す。採点中にこのファイルが変わると、key の schema と Codex が読む schema がずれる）
  - 完了条件: `cd server && node --test --test-name-pattern="checkpoint" test/eval-grade.test.ts` → pass。Codex の `--output-schema` は 1 回の呼び出しの一時ディレクトリにあるファイルで、本文は開始時に読んだ schema と同じ
  - コミット: `fix(eval): give the Codex grader the schema text its checkpoint key holds (T05)`
  - 結果: red は直す前に `cd server && node --test --test-name-pattern="checkpoint gives Codex" test/eval-grade.test.ts` → fail（「not the repository's file: …/server/evals/cloud/grade.schema.json」）。直した後は `--test-name-pattern="checkpoint"` → pass 11 / fail 0、eval-grade.test.ts 全体 pass 70 / fail 0、`bun run lint`・`bun run typecheck` は指摘なし。schema は採点者の作業ディレクトリではなく、1 回の呼び出しの HOME に書く

## 記録

- 2026-10-06 / T01 / Codex のタスクごとのレビュー（afc825ee）は指摘 0 件。Codex の sandbox では mkdtemp が EPERM でファイル操作のテストを流せなかった / 手元で同じテストを流して pass を確かめた
- 2026-10-06 / T02 / Codex の設定を key に入れるには、呼ぶ前に設定の本文が要る / 変更欄を `server/evals/cloud/grade.ts`, `server/test/eval-grade.test.ts` から、`server/evals/cloud/codex-home.ts` を足した形に変えた（`ownerCodexSettings` を切り出し、`isolatedCodexHome` もそれを使う）
- 2026-10-06 / T02 / 設定を最初に読むと、行が 0 件のビルドで持ち主の config が無いと止まった（既存の `collect and grade refuse --out` テスト） / Codex を呼ぶ行が出たときだけ読むようにした
- 2026-10-06 / T02 / Codex のタスクごとのレビュー（4722706d）で P2 を 1 件再現: key の設定は最初に 1 回読むが、Codex の起動は呼ぶたびに持ち主の config を読み直すので、途中で設定が変わると別のモデルの結果が古い設定の key に保存される / 採る。修正タスク T04 を足した
- 2026-10-06 / T04 / Codex のタスクごとのレビュー（4628ab80）は指摘 0 件（sandbox ではテストを流せず、手元で pass）
- 2026-10-06 / 全差分 / Codex の全差分レビュー（high）で P2 を 1 件: key の schema は開始時の本文だが、Codex の `--output-schema` は repo のファイルを指すので、採点中に schema が変わるとずれる / 採る。修正タスク T05 を足した
