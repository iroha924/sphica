---
kind: tasks
plan: 27-eval-structured-grading.plan.md
branch: feat/eval-structured-grading
base: main
---

# The evaluation grades answers and Codex's own answers through checked schemas, and tracks the "received the record and still implemented the request" failure per model のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 形と検査

採点と Codex の回答の形を決め、手書きの厳密な検査で崩れを見分けられるようにする。

- [x] T01: tasks.json の against、2 つの schema、schema-check とそのテスト
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `server/evals/cloud/tasks.json`, `server/evals/cloud/grade.schema.json`, `server/evals/cloud/answer.schema.json`, `server/evals/cloud/schema-check.ts`, `server/test/eval-grade.test.ts`
  - 完了条件: `cd server && node --test test/eval-grade.test.ts` → 全件 pass（型違い、範囲外、enum 違反、余分なキー、欠けたキーで理由付きの不一致）
  - コミット: `feat(evals): add grade and answer schemas with a strict check`
  - 結果: `cd server && node --test test/eval-grade.test.ts` → pass 3 / fail 0（型違い、範囲外、enum 違反、余分なキー、欠けたキー、schema ファイルとの一致）。`tsc` → 通過

## P2: 実行・回収・採点

Codex の回を台帳と schema で受け、回収で 4 つの信号と除外を残し、盲検で採点して表にする。

- [x] T02: codex.ts に起動の台帳、回答の schema、gold フックの受領を足す
  - 種別: 変更
  - 計画: S2
  - 依存: T01（answer.schema.json が要る）
  - 変更: `server/evals/cloud/codex.ts`
  - 完了条件: `bun run --cwd server typecheck` → exit 0。コードを読み、started.json が起動の前、result.json が finally で書かれることを確かめる（本物の Codex は完了条件 A3 で走らせる）
  - コミット: `feat(evals): record every Codex run and take its answer through a schema`
  - 結果: `bun run --cwd server typecheck` → exit 0。読んで確かめた: started.json は clone の前に書き、以降は try で包み、result.json は finally で status と reason を書く。回答は `--output-schema answer.schema.json -o answer.json`、gold は gold-hook.sh が受領を gold-receipt.txt に残す

- [x] T03: collect.ts に patch、delivered と found、answer_format、excluded を足す
  - 種別: 変更
  - 計画: S3
  - 依存: T01（schema-check が要る）, T02（started.json と answer.json と gold の受領を読む）
  - 変更: `server/evals/cloud/collect.ts`, `server/evals/cloud/judge.ts`, `server/test/eval-grade.test.ts`
  - 完了条件: `cd server && node --test test/eval-grade.test.ts` → 全件 pass（ログが無い回の found が unknown、result.json の無い回が excluded になるテストを含む）
  - コミット: `feat(evals): keep patches, delivery and lookup signals, and excluded runs in the loop`
  - 結果: `cd server && node --test test/eval-grade.test.ts` → pass 8 / fail 0（found の unknown、delivered の条件ごとの判定、answer_format、patch の切り詰め、collect.ts を子プロセスで流して result.json の無い回と失敗した回が excluded）。`tsc`、`knip` → 通過

- [ ] T04: grade.ts で盲検の採点と表を出す
  - 種別: 追加
  - 計画: S4
  - 依存: T01（schema-check が要る）, T03（loop.json の新しい列を読む）
  - 変更: `server/evals/cloud/grade.ts`, `server/test/eval-grade.test.ts`
  - 完了条件: `cd server && node --test test/eval-grade.test.ts` → 全件 pass（空・0 以外の終了・JSON でない・schema 不一致が ungraded、依頼文に条件とモデルが入らない、切り詰めた差分で unknown を許す）
  - コミット: `feat(evals): grade answers blind through a checked schema and tabulate by model and condition`

- [ ] T05: eval-loop Skill の回収と採点の手順、報告の書き方を直す
  - 種別: 変更
  - 計画: S5
  - 依存: T04（書く手順が grade.ts を使う）
  - 変更: `.claude/skills/eval-loop/SKILL.md`
  - 完了条件: `bun run verify:ai` → exit 0。`rg -n "grade.ts|--fired|unknown" .claude/skills/eval-loop/SKILL.md` → 各 1 件以上
  - コミット: `docs(eval-loop): grade with grade.ts and report both models with unknown and excluded counts`

## 記録
2026-09-27 / T03 / collect.ts は読み込むと main() を走らせるのでテストから関数を呼べない / 判定を judge.ts に分け、変更欄を「collect.ts, eval-grade.test.ts」から「collect.ts, judge.ts, eval-grade.test.ts」にした
