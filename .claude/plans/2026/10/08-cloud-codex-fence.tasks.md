---
kind: tasks
plan: 08-cloud-codex-fence.plan.md
branch: fix/cloud-codex-fence
base: main
---

# cloud の評価の Codex（run と採点者）に permission profile の囲いを当て、持ち主のログイン・正解・他の run を読めなくする（#305）のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 共通の囲い

review と cloud の両方が、同じ関数で Codex を囲えるようになる。管理者のシステム設定で囲いが外れる経路も塞ぐ

- [x] T01: codex-home.ts に共通の囲い（profile、管理者の設定の検査、fencedCodexHome、EVAL_CACHE、fenceDigest、ロック）を置き、review を切り替える
  - 種別: 修正
  - 計画: S1
  - 依存: なし
  - 変更: `server/evals/cloud/codex-home.ts`, `server/evals/review/runner.ts`, `server/evals/review/run.ts`, `server/evals/review/m2.ts`, `server/test/review-eval.test.ts`, `server/test/eval-codex.test.ts`
  - red: `cd server && node --test --test-name-pattern="system config" test/review-eval.test.ts` → 仮の root に `etc/config.toml` を置いても `managedCodexSettings` が空を返して失敗する
  - 完了条件: `cd server && node --test test/review-eval.test.ts test/eval-codex.test.ts` → 全件 pass。`/etc/codex/config.toml` の検出、`fencedCodexHome` が `default_permissions` を表より前に書くこと、run の auth.json を deny すること、渡した settings をそのまま使うこと、`fenceDigest` が役割の名前で同じ値になること、ロックが 2 つ目を拒むこと、`runnerDigest` が codex-home.ts の変更で変わることを確かめる
  - コミット: `fix(eval): share the Codex read fence and refuse a system Codex config (T01)`
  - 結果: `cd server && node --test --test-name-pattern="system config" test/review-eval.test.ts` → 直す前は `actual: []`（期待は `.../codex-etc-*/config.toml`）で失敗した
  - 結果: `cd server && node --test test/review-eval.test.ts test/eval-codex.test.ts` → 25 件 pass。`bun run typecheck`・`bun run lint`・`bun run english` → 0 で終わった

## P2: 評価される Codex の囲い

codex.ts の run が、資格情報・`server/evals`・`~/.cache/sphica-eval`・run の DB を読めない形で動き、今と同じ配置で結果を残す

- [x] T02: codex.ts の組み立てを codex-run.ts に出す（挙動は変えない）
  - 種別: 変更
  - 計画: S2
  - 依存: なし
  - 変更: `server/evals/cloud/codex-run.ts`, `server/evals/cloud/codex.ts`, `server/test/eval-codex.test.ts`
  - 完了条件: `cd server && node --test test/eval-codex.test.ts` → pass。今の引数（`-s workspace-write` を含む）、設定、フックの組み立てを、codex-run.ts の関数から読んで確かめる
  - コミット: `refactor(eval): move the Codex run setup out of the CLI wrapper (T02)`
  - 結果: `cd server && node --test test/eval-codex.test.ts` → 5 件 pass（偽の codex で codex.ts を流し、`-s workspace-write`、run の HOME、設定の model、result.json などの成果物を確かめた）。`bun run typecheck`・`bun run lint`・`bun run english` → 0 で終わった
- [x] T03: codex-run.ts に囲いを当てる（出力先の制限、一時の場所、DB の置き場、profile、片付け、fence と fence_roots、ロック）
  - 種別: 修正
  - 計画: S2
  - 依存: T01（fencedCodexHome・EVAL_CACHE・fenceDigest・ロックが要る）, T02（組み立てを関数として呼べることが要る）
  - 変更: `server/evals/cloud/codex-run.ts`, `server/evals/cloud/codex.ts`, `server/test/eval-codex.test.ts`
  - red: `cd server && node --test --test-name-pattern="read fence" test/eval-codex.test.ts` → 引数に `-s` があり、設定に `default_permissions` も auth.json の deny も無いので失敗する
  - 完了条件: `cd server && node --test test/eval-codex.test.ts` → pass。偽の `codex` を PATH の先頭に置いた run で、引数に `-s` が無いこと、deny に `server/evals`・`EVAL_CACHE`・`DENY_DIRS`・`DENY_FILES`・run の auth.json があること、`--out` が `EVAL_CACHE` の外なら止まること、`EVAL_SPHICA_DB` が run のディレクトリを指すこと、成功でも失敗でも `<run>/work`・`home`・`tmp` に移って一時の親が消えること、result.json に `fence` と `fence_roots` があることを確かめる
  - コミット: `fix(eval): fence what the Codex run under test can read (T03)`
  - 結果: `cd server && node --test --test-name-pattern="read fence" test/eval-codex.test.ts` → 直す前は `--out` が `EVAL_CACHE` の外でも run が始まり（status 0）、失敗した
  - 結果: `cd server && node --test test/eval-codex.test.ts` → 7 件 pass（`-s` なし、deny の各項目、外の `--out` の拒否、`EVAL_SPHICA_DB`、一時の場所からの移動と後片付け、失敗した run の移動、ロックの解放、`fence` と `fence_roots`）。`bun run typecheck`・`bun run lint`・`bun run english` → 0 で終わった

## P3: 集計と採点

囲いの前の run を数えず、採点者も同じ囲いで動き、fence の違う結果どうしを比べない

- [x] T04: collect が loop.json に run_roots を書き、Codex の行に fence を写し、囲いの無い run を除外する
  - 種別: 修正
  - 計画: S3
  - 依存: T01（fenceDigest で今の fence を求めるため）
  - 変更: `server/evals/cloud/collect.ts`, `server/evals/cloud/codex-run.ts`, `server/test/eval-claude.test.ts`
  - red: `cd server && node --test --test-name-pattern="read fence" test/eval-claude.test.ts` → `fence` の無い Codex の run が excluded にならずに数えられて失敗する
  - 完了条件: `cd server && node --test test/eval-claude.test.ts` → pass。loop.json に解決した `run_roots` があること、`fence` の無い run と違う run が「run without the current read fence」で excluded になること、今の fence の run が数えられることを確かめる
  - コミット: `fix(eval): exclude Codex runs made without the current read fence (T04)`
  - 結果: `cd server && node --test --test-name-pattern="read fence" test/eval-claude.test.ts` → 直す前は今の fence の run の行に `fence` が無く（actual: undefined）、失敗した
  - 結果: `cd server && node --test test/eval-claude.test.ts` → 46 件 pass（今の fence の run は数え、fence の無い run と違う run は「run without the current read fence」で除外し、loop.json に `run_roots` がある）。`bun run typecheck`・`bun run lint`・`bun run english` → 0 で終わった
- [x] T09: T01 のレビューの指摘を直す（ロックの二重解放、`..` で始まる名前の内側判定、Windows のパスの指紋、`default_permissions` の検査）
  - 種別: 修正
  - 計画: S1
  - 依存: T01（直す対象の関数が要る）
  - 変更: `server/evals/cloud/codex-home.ts`, `server/test/eval-codex.test.ts`
  - red: `cd server && node --test test/eval-codex.test.ts` → 解放を 2 回呼ぶと次の持ち主のロックが消えて 3 つ目の取得が通る、`..build` を外と判定する、Windows 形式のパスで同じ方針の指紋が食い違う、の 3 件で失敗する
  - 完了条件: `cd server && node --test test/eval-codex.test.ts` → 全件 pass
  - コミット: `fix(eval): release only the lock this holder took, and compare paths by components (T09)`
  - 結果: `cd server && node --test test/eval-codex.test.ts` → 直す前は lock の再解放（Missing expected exception）、`..build`（must be inside）、Windows の指紋（c431…≠c2f9…）で失敗した
  - 結果: `cd server && node --test test/eval-codex.test.ts` → 9 件 pass

- [x] T05: grade が採点者を囲う（-s を外す、出力先の制限、settings の写し、checkpoint の fence、ロック、行への fence）
  - 種別: 修正
  - 計画: S4
  - 依存: T01（fencedCodexHome とロックが要る）, T04（loop.json の run_roots と行の fence が要る）
  - 変更: `server/evals/cloud/grade.ts`, `server/evals/cloud/grading.ts`, `server/evals/cloud/codex-run.ts`, `server/evals/cloud/codex-home.ts`, `server/evals/cloud/collect.ts`, `server/test/eval-grade.test.ts`
  - red: `cd server && node --test --test-name-pattern="read fence" test/eval-grade.test.ts` → `GRADER_ARGS.codex` に `-s read-only` があり、`run_roots` が `EVAL_CACHE` の外の loop.json も受け付けて失敗する
  - 完了条件: `cd server && node --test test/eval-grade.test.ts` → pass。偽の `codex` で、引数に `-s` が無いこと、設定に deny が入ること、`run_roots` の無い loop.json と外の root を持つ loop.json を拒むこと、Codex の checkpoint の key が fence で変わり Claude の key は変わらないこと、grades.json の行に `fence` があることを確かめる
  - コミット: `fix(eval): fence the Codex grader and key its checkpoints by the fence (T05)`
  - 結果: `cd server && node --test --test-name-pattern="read fence" test/eval-grade.test.ts` → 直す前は `GRADER_ARGS.codex` に `-s` があり（the profile is the sandbox: actual false）、失敗した
  - 結果: `cd server && node --test test/eval-grade.test.ts` → 73 件 pass。`node --test test/eval-claude.test.ts test/eval-codex.test.ts test/review-eval.test.ts` → 76 件 pass。`bun run typecheck`・`bun run lint`・`bun run english` → 0 で終わった
- [ ] T06: report が fence の無い・混ざる・違う Codex の結果を比べない
  - 種別: 修正
  - 計画: S5
  - 依存: T05（grades.json の行の fence が要る）
  - 変更: `server/evals/cloud/report.ts`, `server/test/eval-grade.test.ts`
  - red: `cd server && node --test --test-name-pattern="fence" test/eval-grade.test.ts` → fence の無い grades.json と有る grades.json の `compare` が止まらずに失敗する
  - 完了条件: `cd server && node --test test/eval-grade.test.ts` → pass。fence が無い、片側で混ざる、両側で違う場合に止まり、同じ fence なら今までどおり比べることを確かめる
  - コミット: `fix(eval): refuse to compare Codex results made under different read fences (T06)`

## P4: 実際の Codex で確かめる手段と手順

測る前に、実際の Codex で囲いが効いていることを確かめられる

- [ ] T07: codex.ts --probe と grade.ts --probe を足す
  - 種別: 追加
  - 計画: S6
  - 依存: T03（run の囲いが要る）, T05（採点者の囲いが要る）
  - 変更: `server/evals/cloud/codex-run.ts`, `server/evals/cloud/codex.ts`, `server/evals/cloud/probe.ts`, `server/evals/cloud/grade.ts`, `server/test/eval-codex.test.ts`
  - 完了条件: `cd server && node --test test/eval-codex.test.ts` → pass。probe.sh の分類（`LC_ALL=C` で DENIED・MISSING・READ・ERROR）、対象が無いときに走らせる前に止まること、対象の記録が選べないときの「no eligible probe target」、prompt に anchor のパスが出ないこと、完了した `command_execution` の出力だけで判定すること、grade の probe が checkpoint と grades.json に触れないことを、偽の events で確かめる
  - コミット: `feat(eval): add probes that show the Codex run and grader cannot read what is fenced (T07)`
- [ ] T08: eval-loop Skill に probe・1 つずつ・出力先・既知の限界を書く
  - 種別: 変更
  - 計画: S7
  - 依存: T07（probe のコマンドが要る）
  - 変更: `.claude/skills/eval-loop/SKILL.md`
  - 完了条件: `bun run verify:ai` → 0 で終わる
  - コミット: `docs(eval-loop): run the Codex probes before measuring and keep outputs under the cache (T08)`

## 記録

- 2026-10-08 / T01 / 結果行の書式違反のままコミットした（e9fbe9be。check_plan の出力を tail に通して終了コードを捨てた） / 次のコミット（9ce4ac72）で直した
- 2026-10-08 / T02 / 変更欄の `server/test/eval-codex.test.ts` に、codex.ts を偽の codex で流すテストを足した / 欄は変えていない
- 2026-10-08 / T03 / 偽の codex のテストを動かすため、テストのビルドを一時 HOME の `.cache/sphica-eval/builds` に置き、T02 のテストから `-s workspace-write` と HOME の確認を外した / T03 のテストが代わりに確かめる
- 2026-10-08 / T04 / 今の fence を collect で求めるため、codex-run.ts に `currentRunFence` を足した / T04 の変更欄に `server/evals/cloud/codex-run.ts` を足した（前: collect.ts と eval-claude.test.ts のみ）
- 2026-10-08 / T01 / Codex のレビュー（high）で P2 が 4 件。ロックの再解放、`default_permissions` の無い設定でも通るテスト、Windows のパスの指紋、`..build` の判定 / 4 件とも採用し、T09 を足して直した
- 2026-10-08 / T04 / T04 のコミット（edbb3d45）は eval-grade.test.ts の collect のテスト 3 件（fence の無い Codex の run を数える前提）を落としていた。完了条件で eval-claude.test.ts しか流さなかった / T05 のコミットで、それらの result.json に今の fence を足した
- 2026-10-08 / T05 / 採点者の fence を求めるため `currentRunFence` を `currentFence(base, cache)` に広げ、collect の呼び出しを直した。存在しない run の置き場も判定できるよう `requireInside` が親までたどって解決する形にした。codex-run.ts の内側判定を codex-home.ts の `isInside` にそろえた / T05 の変更欄に codex-run.ts・codex-home.ts・collect.ts を足した（前: grade.ts・grading.ts・eval-grade.test.ts）
- 2026-10-08 / T05 / 既存の採点のテストのビルドを一時 HOME の `.cache/sphica-eval/builds` に移し、loop.json に `run_roots` を足した。kill -9 で止めたテストは、残ったロックを持ち主の代わりに消してから再開する / 欄は変えていない
