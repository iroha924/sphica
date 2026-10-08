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
- [x] T11: T03 のレビューの指摘を直す（リポジトリの git の履歴から正解を読める、後片付けの失敗で一時の checkout を残したままロックを外す、checkout の中を指す絶対リンクが移した後に切れる）
  - 種別: 修正
  - 計画: S2
  - 依存: T03（直す対象の run の囲いが要る）
  - 変更: `server/evals/cloud/codex-run.ts`, `server/test/eval-codex.test.ts`
  - red: `cd server && node --test test/eval-codex.test.ts` → 設定にリポジトリのルートの deny が無い、読めないディレクトリを残すと一時の木が消えずに残る、`link` が消えた一時の木を指す、の 3 件で失敗する
  - 完了条件: `cd server && node --test test/eval-codex.test.ts` → 全件 pass
  - コミット: `fix(eval): deny the repository, clear what a run leaves, keep its links in the checkout (T11)`
  - 結果: `cd server && node --test test/eval-codex.test.ts` → 直す前は新しい 3 件が失敗した（deny の正規表現に合わない、一時の木が残る、リンクの解決先が違う）
  - 結果: `cd server && node --test test/eval-codex.test.ts test/eval-grade.test.ts test/eval-claude.test.ts test/review-eval.test.ts` → 152 件 pass。テストの後に os.tmpdir() に `sphica-codex-*` が残っていないことを確かめた。`bun run typecheck`・`bun run lint` → 0 で終わった

- [x] T10: T04 のレビューの指摘を直す（除外した Codex の行に記録した fence を写す）
  - 種別: 修正
  - 計画: S3
  - 依存: T04（直す対象の collect の除外が要る）
  - 変更: `server/evals/cloud/collect.ts`, `server/test/eval-claude.test.ts`
  - red: `cd server && node --test --test-name-pattern="read fence" test/eval-claude.test.ts` → 違う fence で除外した run の行に `fence` が無く失敗する
  - 完了条件: `cd server && node --test test/eval-claude.test.ts test/eval-grade.test.ts` → 全件 pass
  - コミット: `fix(eval): keep the recorded fence on excluded Codex rows (T10)`
  - 結果: `cd server && node --test --test-name-pattern="read fence" test/eval-claude.test.ts` → 直す前は `other` の行の fence が undefined で失敗した
  - 結果: `cd server && node --test test/eval-claude.test.ts test/eval-grade.test.ts` → 119 件 pass。`bun run typecheck`・`bun run lint` → 0 で終わった

- [x] T06: report が fence の無い・混ざる・違う Codex の結果を比べない
  - 種別: 修正
  - 計画: S5
  - 依存: T05（grades.json の行の fence が要る）
  - 変更: `server/evals/cloud/report.ts`, `server/test/eval-grade.test.ts`
  - red: `cd server && node --test --test-name-pattern="fence" test/eval-grade.test.ts` → fence の無い grades.json と有る grades.json の `compare` が止まらずに失敗する
  - 完了条件: `cd server && node --test test/eval-grade.test.ts` → pass。fence が無い、片側で混ざる、両側で違う場合に止まり、同じ fence なら今までどおり比べることを確かめる
  - コミット: `fix(eval): refuse to compare Codex results made under different read fences (T06)`
  - 結果: `cd server && node --test --test-name-pattern="compare" test/eval-grade.test.ts` → 直す前は fence の無い Codex の結果との `compare` が止まらず（Missing expected exception）、失敗した
  - 結果: `cd server && node --test test/eval-grade.test.ts test/eval-claude.test.ts` → 119 件 pass（fence が無い・片側で混ざる・両側で違う場合に止まり、除外した run の fence は見ない）。`bun run typecheck`・`bun run lint` → 0 で終わった

## P4: 実際の Codex で確かめる手段と手順

測る前に、実際の Codex で囲いが効いていることを確かめられる

- [x] T07: codex.ts --probe と grade.ts --probe を足す
  - 種別: 追加
  - 計画: S6
  - 依存: T03（run の囲いが要る）, T05（採点者の囲いが要る）
  - 変更: `server/evals/cloud/codex-run.ts`, `server/evals/cloud/codex.ts`, `server/evals/cloud/probe.ts`, `server/evals/cloud/grade.ts`, `server/test/eval-codex.test.ts`
  - 完了条件: `cd server && node --test test/eval-codex.test.ts` → pass。probe.sh の分類（`LC_ALL=C` で DENIED・MISSING・READ・ERROR）、対象が無いときに走らせる前に止まること、対象の記録が選べないときの「no eligible probe target」、prompt に anchor のパスが出ないこと、完了した `command_execution` の出力だけで判定すること、grade の probe が checkpoint と grades.json に触れないことを、偽の events で確かめる
  - コミット: `feat(eval): add probes that show the Codex run and grader cannot read what is fenced (T07)`
  - 結果: `cd server && node --test test/eval-codex.test.ts` → 16 件 pass（probe.sh の分類と NEXT を流さないこと、probe.sh 以外の出力を数えないこと、無い対象で走らせる前に止まること、anchor の無い slot で対象が無いこと、codex.ts と grade.ts の `--probe` が囲いの無い偽の codex で READ を拾って 1 で終わり、run を `<out>/probe` に分け、cache の token・checkpoint・grades.json を残さないこと）
  - 結果: `cd server && node --test test/eval-grade.test.ts test/eval-claude.test.ts test/review-eval.test.ts test/eval-codex.test.ts` → 156 件 pass。`bun run typecheck`・`bun run lint`・`bun run english`・`bun run architecture` → 0 で終わった
- [x] T12: T05 のレビューの指摘を直す（`..` を symlink の解決より先に畳んで cache の外を内側と判定する、空の `run_roots` で置き場の確認が素通りになる）
  - 種別: 修正
  - 計画: S4
  - 依存: T05（直す対象の検査が要る）
  - 変更: `server/evals/cloud/codex-home.ts`, `server/evals/cloud/grade.ts`, `server/test/eval-codex.test.ts`, `server/test/eval-grade.test.ts`
  - red: `cd server && node --test --test-name-pattern="resolves links" test/eval-codex.test.ts` → `cache/hop/../new`（hop は外へのリンク）を内側として受け付けて失敗する。`node --test --test-name-pattern="read fence" test/eval-grade.test.ts` → `run_roots: []` の loop を採点に進めて失敗する
  - 完了条件: `cd server && node --test test/eval-codex.test.ts test/eval-grade.test.ts` → 全件 pass
  - コミット: `fix(eval): resolve each link before stepping up, and refuse a loop with no run roots (T12)`
  - 結果: 直す前の codex-home.ts で `node --test --test-name-pattern="resolves links" test/eval-codex.test.ts` → 失敗（Missing expected exception）。`node --test --test-name-pattern="read fence" test/eval-grade.test.ts` → 空の run_roots で stderr が空になり失敗した
  - 結果: `cd server && node --test test/eval-codex.test.ts test/eval-grade.test.ts` → 90 件 pass。`bun run typecheck`・`bun run lint` → 0 で終わった

- [x] T08: eval-loop Skill に probe・1 つずつ・出力先・既知の限界を書く
  - 種別: 変更
  - 計画: S7
  - 依存: T07（probe のコマンドが要る）
  - 変更: `.claude/skills/eval-loop/SKILL.md`
  - 完了条件: `bun run verify:ai` → 0 で終わる
  - コミット: `docs(eval-loop): run the Codex probes before measuring and keep outputs under the cache (T08)`
  - 結果: `bun run verify:ai` → 0 で終わった（AI config と lychee のリンク検査）

- [x] T13: T09・T11 のレビューの指摘を直す（リポジトリの別の worktree と、linked worktree の外にある共通の git ディレクトリを deny から漏らす）
  - 種別: 修正
  - 計画: S2
  - 依存: T11（リポジトリの deny が要る）
  - 変更: `server/evals/cloud/codex-run.ts`, `server/test/eval-codex.test.ts`
  - red: `cd server && node --test test/eval-codex.test.ts` → 直す前は worktree と共通の git ディレクトリを数える関数が無く、新しいテストが読み込みで失敗する（deny に入らないことは `codexDenies` が REPO しか返さないことで分かる）
  - 完了条件: `cd server && node --test test/eval-codex.test.ts` → 全件 pass
  - コミット: `fix(eval): deny every worktree of the repository and the git directory they share (T13)`
  - 結果: `cd server && node --test test/eval-codex.test.ts test/eval-grade.test.ts test/eval-claude.test.ts test/review-eval.test.ts` → 158 件 pass（一時のリポジトリと linked worktree で、どちらから見ても両方の worktree を数え、worktree の有無で fence が変わらない）。`bun run typecheck`・`bun run lint` → 0 で終わった

- [x] T14: `bun run verify` の knip が指摘した未使用の export（`isolatedCodexHome`、`probeOutput`）を外す
  - 種別: 修正
  - 計画: S1, S6
  - 依存: T07（probeOutput が要る）
  - 変更: `server/evals/cloud/codex-home.ts`, `server/evals/cloud/probe.ts`
  - red: `bun run verify` → knip が「Unused exports (2)」で 1 を返す
  - 完了条件: `bun run knip` → 0 で終わる
  - コミット: `fix(eval): stop exporting helpers only their own files use (T14)`
  - 結果: `bun run verify` → 直す前は knip が `isolatedCodexHome` と `probeOutput` を未使用の export として 1 で終わった
  - 結果: `bun run knip` → 0 で終わった

- [x] T15: T07 のレビューの指摘を直す（偽の probe の出力で通る、リポジトリの .git と 2 つ目以降の資格情報のファイルを見ない、not found の read を成功と数える、gold の probe で gold の hook が選ばない、anchor のパスを引用せず読み取りの完了も見ない、候補を 10 件で打ち切る）
  - 種別: 修正
  - 計画: S6
  - 依存: T07（直す対象の probe が要る）
  - 変更: `server/evals/cloud/probe.ts`, `server/evals/cloud/codex.ts`, `server/test/eval-codex.test.ts`
  - red: `cd server && node --test --test-name-pattern="probe script tells|refuses a target" test/eval-codex.test.ts` → 直す前の probe.ts で、`printf 'DENIED locked' # probe.sh` の出力を probe の出力と数え、not found の read を成功と数えて 2 件失敗する
  - 完了条件: `cd server && node --test test/eval-codex.test.ts` → 全件 pass
  - コミット: `fix(eval): judge only probe.sh's own run and close the probe's gaps (T15)`
  - 結果: 直す前の probe.ts・codex.ts で `node --test --test-name-pattern="probe script tells|refuses a target" test/eval-codex.test.ts` → 2 件失敗した（偽の行で actual ''、not found の read が真）
  - 結果: `cd server && node --test test/eval-codex.test.ts` → 18 件 pass。`bun run typecheck`・`bun run lint`・`bun run knip` → 0 で終わった

- [x] T16: 全差分のレビューの指摘を直す（採点者の fence が grades.json に残らず別の囲いの採点を比べられる、採点者の probe が対象ごとの判定を残さない）
  - 種別: 修正
  - 計画: S4, S5, S6
  - 依存: T06（report の fence の比較が要る）, T15（probe の判定が要る）
  - 変更: `server/evals/cloud/grade.ts`, `server/evals/cloud/report.ts`, `server/evals/cloud/probe.ts`, `server/evals/cloud/codex.ts`, `server/test/eval-grade.test.ts`, `server/test/eval-codex.test.ts`
  - red: `cd server && node --test --test-name-pattern="compare puts|read fence" test/eval-grade.test.ts` → grades.json に `grader_fence` が無く、採点者の fence の無い・違う結果の `compare` が止まらずに失敗する。`node --test --test-name-pattern="grade.ts --probe" test/eval-codex.test.ts` → 採点者の probe が `READ control` の行を出さずに失敗する
  - 完了条件: `cd server && node --test test/eval-grade.test.ts test/eval-codex.test.ts` → 全件 pass
  - コミット: `fix(eval): record the grader's fence with the grades and print every probe line (T16)`
  - 結果: `cd server && node --test --test-name-pattern="compare puts|read fence" test/eval-grade.test.ts` → 直す前は Missing expected exception と grader_fence が undefined で 2 件失敗、`grade.ts --probe` のテストも READ control の行が無く失敗した
  - 結果: `cd server && node --test test/eval-grade.test.ts test/eval-codex.test.ts test/eval-claude.test.ts test/review-eval.test.ts` → 158 件 pass。`bun run typecheck`・`bun run lint`・`bun run knip` → 0 で終わった

- [x] T17: CI の Node 26（テストの順番をランダムにするジョブ）で落ちた review-eval のテストを、読み込み時点の home と比べる形に直す
  - 種別: 修正
  - 計画: S1
  - 依存: T01（review-eval.test.ts の変更が要る）
  - 変更: `server/test/review-eval.test.ts`
  - red: `cd server && $(mise where node@26.10.0)/bin/node --test --test-randomize --test-random-seed=515 test/review-eval.test.ts` → 「a lane starts with only the read tools」が、fixture の組み立てが HOME を差し替えている最中に `os.homedir()` と比べて失敗する
  - 完了条件: `cd server && $(mise where node@26.10.0)/bin/node --test --test-randomize --test-random-seed=515 test/review-eval.test.ts` → 全件 pass
  - コミット: `test(eval): compare the deny list with the home it was built from (T17)`
  - 結果: `cd server && $(mise where node@26.10.0)/bin/node --test --test-randomize --test-random-seed=515 test/review-eval.test.ts` → 直す前は 1 件失敗（CI の check (26) と同じ。失敗したジョブだけの再実行でも再現）、直した後は 21 件 pass。seed 515・516・1・42 で eval の 4 ファイルが 158 件 pass

- [x] T18: GitHub の Codex のレビューの指摘のうち 7 件を直す（後片付けのコピーの失敗で一時の木を消す、テストの子プロセスの環境、grade.ts の冒頭のコメントの行数、改行を含む worktree のパス、`../` を含むタスク名、通常の report で fence の違う結果が混ざる、probe.sh を run の最中に書き換えられる）
  - 種別: 修正
  - 計画: S2, S5, S6
  - 依存: T16（report と probe の直しが要る）, T17（テストの直しが要る）
  - 変更: `server/evals/cloud/codex-run.ts`, `server/evals/cloud/codex.ts`, `server/evals/cloud/probe.ts`, `server/evals/cloud/report.ts`, `server/evals/cloud/grade.ts`, `server/test/eval-codex.test.ts`, `server/test/eval-grade.test.ts`
  - red: `cd server && node --test test/eval-codex.test.ts test/eval-grade.test.ts` → コピーの失敗で一時の木が消える、`../escaped` のタスクで run が始まる、改行を含む worktree を数えない、fence の違う 2 つのビルドを report が並べる、probe.sh が checkout の中にあり書けるかを見ない、の 5 件で失敗する
  - 完了条件: `cd server && node --test test/eval-codex.test.ts test/eval-grade.test.ts test/eval-claude.test.ts test/review-eval.test.ts` → 全件 pass
  - コミット: `fix(eval): keep a run that cannot move back, and close the gaps the PR review found (T18)`
  - 結果: `cd server && node --test test/eval-codex.test.ts test/eval-grade.test.ts` → 直す前は新しい 5 件が失敗した。改行を含む worktree は、読み方だけを古い形に戻して失敗することも確かめた
  - 結果: `cd server && node --test test/eval-codex.test.ts test/eval-grade.test.ts test/eval-claude.test.ts test/review-eval.test.ts` → 161 件 pass。`bun run typecheck`・`bun run lint`・`bun run knip`・`bun run english` → 0 で終わった

## P5: HOME の許可の一覧と review の評価（PR #306 のレビューの後に持ち主が追加）

囲った Codex が HOME の下で読めるのを node と bun のインストール先だけにし、review の評価も同じ囲いとロックで動かす

- [ ] T19: HOME の許可の一覧と run の PATH を作り、cloud の run と採点者の deny と指紋をそれに替える
  - 種別: 修正
  - 計画: S8
  - 依存: T18（今の codexDenies と指紋が要る）
  - 変更: `server/evals/cloud/codex-home.ts`, `server/evals/cloud/codex-run.ts`, `server/evals/cloud/grade.ts`, `server/test/eval-codex.test.ts`, `server/test/eval-grade.test.ts`, `server/test/eval-claude.test.ts`
  - red: `cd server && node --test --test-name-pattern="allowlist" test/eval-codex.test.ts` → 仮の HOME の `.git-credentials`・`.kube`・`.local/share/atuin` が deny に無く、run の PATH に HOME の `.local/bin` が残って失敗する
  - 完了条件: `cd server && node --test test/eval-codex.test.ts test/eval-grade.test.ts test/eval-claude.test.ts` → 全件 pass
  - コミット: `fix(eval): deny all of HOME but the node and bun installs to the fenced Codex (T19)`
- [ ] T20: probe の対象を HOME の許可の一覧に合わせる（HOME の直下の token、deny されたディレクトリ、node の実体の対照）
  - 種別: 修正
  - 計画: S8
  - 依存: T19（許可の一覧が要る）
  - 変更: `server/evals/cloud/probe.ts`, `server/evals/cloud/codex.ts`, `server/evals/cloud/grade.ts`, `server/test/eval-codex.test.ts`
  - red: `cd server && node --test --test-name-pattern="probe" test/eval-codex.test.ts` → 対象に HOME の直下の token と node の対照が無く失敗する
  - 完了条件: `cd server && node --test test/eval-codex.test.ts` → 全件 pass
  - コミット: `fix(eval): probe HOME as the allowlist fences it (T20)`
- [ ] T21: 採点者のロックを、一時のディレクトリを消せたときだけ外す
  - 種別: 修正
  - 計画: S9
  - 依存: T19（grade.ts の変更が要る）
  - 変更: `server/evals/cloud/grade.ts`, `server/test/eval-codex.test.ts`
  - red: `cd server && node --test --test-name-pattern="grader keeps the lock" test/eval-codex.test.ts` → 採点者の一時のディレクトリが消せなくてもロックを外して失敗する
  - 完了条件: `cd server && node --test test/eval-codex.test.ts` → 全件 pass
  - コミット: `fix(eval): keep the grader's lock while its temp directories remain (T21)`
- [ ] T22: review の評価の Codex の lane を、同じ囲い・一時の木・共有のロックで動かし、Claude の lane にリポジトリの deny を足す
  - 種別: 修正
  - 計画: S9
  - 依存: T19（codexDenies が要る）
  - 変更: `server/evals/review/runner.ts`, `server/evals/review/run.ts`, `server/evals/review/m2.ts`, `server/test/review-eval.test.ts`
  - red: `cd server && node --test --test-name-pattern="review lanes" test/review-eval.test.ts` → Codex の lane の deny にリポジトリの `.git` と HOME の許可の一覧が無く、HOME と TMPDIR が出力先の中にあり、ロックを取らずに失敗する
  - 完了条件: `cd server && node --test test/review-eval.test.ts` → 全件 pass
  - コミット: `fix(eval): fence the review evaluation's lanes like the cloud runs (T22)`
- [ ] T23: M2 のチェックを run ごとの Biome の写しで動かし、写しが変わった run を除外する
  - 種別: 修正
  - 計画: S9
  - 依存: T22（M2 の一時の木が要る）
  - 変更: `server/evals/review/m2.ts`, `server/test/review-eval.test.ts`
  - red: `cd server && node --test --test-name-pattern="Biome copy" test/review-eval.test.ts` → check.mjs がリポジトリの Biome を指し、写しを書き換えた run が除外されずに失敗する
  - 完了条件: `cd server && node --test test/review-eval.test.ts` → 全件 pass
  - コミット: `fix(eval): run M2's check on a per-run Biome copy and exclude runs that changed it (T23)`
- [ ] T24: eval-loop Skill に HOME の許可の一覧・run の PATH・review の評価の囲いと、既知の限界を書く
  - 種別: 変更
  - 計画: S8, S9
  - 依存: T23（書く中身が要る）
  - 変更: `.claude/skills/eval-loop/SKILL.md`
  - 完了条件: `bun run verify:ai` → 0 で終わる
  - コミット: `docs(eval-loop): describe the HOME allowlist and the review evaluation's fence (T24)`

## 記録

- 2026-10-08 / T01 / 結果行の書式違反のままコミットした（e9fbe9be。check_plan の出力を tail に通して終了コードを捨てた） / 次のコミット（9ce4ac72）で直した
- 2026-10-08 / T02 / 変更欄の `server/test/eval-codex.test.ts` に、codex.ts を偽の codex で流すテストを足した / 欄は変えていない
- 2026-10-08 / T03 / 偽の codex のテストを動かすため、テストのビルドを一時 HOME の `.cache/sphica-eval/builds` に置き、T02 のテストから `-s workspace-write` と HOME の確認を外した / T03 のテストが代わりに確かめる
- 2026-10-08 / T04 / 今の fence を collect で求めるため、codex-run.ts に `currentRunFence` を足した / T04 の変更欄に `server/evals/cloud/codex-run.ts` を足した（前: collect.ts と eval-claude.test.ts のみ）
- 2026-10-08 / T01 / Codex のレビュー（high）で P2 が 4 件。ロックの再解放、`default_permissions` の無い設定でも通るテスト、Windows のパスの指紋、`..build` の判定 / 4 件とも採用し、T09 を足して直した
- 2026-10-08 / T04 / T04 のコミット（edbb3d45）は eval-grade.test.ts の collect のテスト 3 件（fence の無い Codex の run を数える前提）を落としていた。完了条件で eval-claude.test.ts しか流さなかった / T05 のコミットで、それらの result.json に今の fence を足した
- 2026-10-08 / T05 / 採点者の fence を求めるため `currentRunFence` を `currentFence(base, cache)` に広げ、collect の呼び出しを直した。存在しない run の置き場も判定できるよう `requireInside` が親までたどって解決する形にした。codex-run.ts の内側判定を codex-home.ts の `isInside` にそろえた / T05 の変更欄に codex-run.ts・codex-home.ts・collect.ts を足した（前: grade.ts・grading.ts・eval-grade.test.ts）
- 2026-10-08 / T05 / 既存の採点のテストのビルドを一時 HOME の `.cache/sphica-eval/builds` に移し、loop.json に `run_roots` を足した。kill -9 で止めたテストは、残ったロックを持ち主の代わりに消してから再開する / 欄は変えていない
- 2026-10-08 / T03 / Codex のレビュー（high）で P1 が 2 件、P2 が 1 件。リポジトリの .git から `git show` で tasks.json を読める、後片付けのコピーの失敗で一時の木を残したままロックを外す、絶対リンクが移した後に切れる / 3 件とも採用し、T11 を足して直した。deny を `server/evals` からリポジトリのルートに広げた（plan の方針 2 の deny の対象が変わる）
- 2026-10-08 / T04 / Codex のレビューで P2 が 2 件。パスに引用符があると指紋が食い違う（T09 で塞がっていた）、除外した Codex の行に fence が残らない / 後者を採用し、T10 を足す
- 2026-10-08 / T11 / review の評価の `evalDenies` も `server/evals` だけを deny していて、同じくリポジトリの .git から読める / plan の対象外（review の挙動は変えない）なので直さず、持ち主に聞く
- 2026-10-08 / T07 / `gradeOne` が probe のためにイベントも返すようになり、checkpoint に `events` まで保存して既存の checkpoint のテストが落ちた / 保存する欄を status と output に限った
- 2026-10-08 / T05 / Codex のレビュー（high）で P1 が 1 件、P2 が 1 件。`..` を symlink の解決より先に畳むので cache の外を内側と判定する（Codex が再現）、空の `run_roots` が素通りになる / 2 件とも採用し、T12 を足して直した
- 2026-10-08 / T11 / Codex のレビュー（high）で P1 が 2 件。別の worktree と共通の git ディレクトリが deny から漏れる、run の後に残ったプロセスがリンクを差し替えると後片付けの chmod が木の外を辿り得る / 前者を採用し T13 を足した。後者は見送る（Codex も推測。残ったプロセスは sandbox を引き継ぐので隠したものは読めず、後片付けが辿った先は持ち主の権限を持ち主のファイルに足すか、後の run から隠した run ディレクトリへ写すだけで、モデルに中身が届かない）
- 2026-10-08 / T07 / Codex のレビュー（high）で P1 が 1 件、P2 が 6 件。モデルの出力で probe を偽れる（Codex が再現）、.git と 2 つ目以降の資格情報のファイルを見ない、not found の read を成功と数える、gold の probe で hook が gold を返さない、anchor のパスの引用と読み取りの完了、候補の 10 件の打ち切り / 7 件とも採用し、T15 を足して直した
- 2026-10-08 / 完了条件 / 実際の Codex（codex-cli 0.160.1）で、ビルド g4-head-check の写し（builds/fence-305-check）に T14 までのコードで流した。inject・search・none の probe は ✓、gold の probe は T07 の指摘どおり「gold hook returned nothing」で ✗、4 条件の通常の run と collect は 4 行とも除外なし、採点者の probe は ✓ / T15 の後に全部流し直す
- 2026-10-08 / 完了条件 / T15 の後に、実際の Codex で inject・search・gold・none の probe と採点者の probe を流し直し、全部 ✓。gold の probe も gold の receipt（582 バイト）が返った
- 2026-10-08 / 全差分 / Codex の全差分のレビュー（high）で P2 が 3 件。採点者の fence が残らない（Codex が再現）、probe.sh を書き換えて流してから戻すと判定を偽れる、採点者の probe が対象ごとの判定を残さない / 1 件目と 3 件目を採用し T16 で直した。2 件目は見送る（probe は囲いの設定の誤りを見つける確認で、わざと欺くモデルまでは相手にしない。塞ぐにはスクリプトを書けない場所に置く作り直しと実機の確認が要る。スクリプトの改ざんが見えたら見直す）
- 2026-10-08 / T17 / PR #306 の check (26) が落ち、失敗したジョブだけの再実行でも再現した。review の fixture の組み立て（acceptance の driver）が HOME を差し替えている最中に、テストが `os.homedir()` と比べていた。main にもあった順番への依存で、テストを足したことでランダムな並びが変わって表に出た / T17 で直した
- 2026-10-08 / T18 / GitHub の Codex のレビュー（5f9caf9）で P1 が 7 件、P2 が 3 件。7 件を T18 で直した（probe.sh の書き換えは前に見送ったが、渡す記録から指示され得るという理由で採用した）。残る 3 件（資格情報を許可の一覧で絞る、review の runner にも共有のロック、組織が管理する設定を測る run ごとの probe で確かめる）は、範囲か方針が変わるので持ち主に聞く
- 2026-10-08 / P5 / 持ち主の決定（資格情報は許可の一覧で絞る、review の評価もこの PR で直す、probe の必須化は見送る）を受け、plan の方針 8・9 を足して T19〜T24 を足した。設計は Codex と 3 往復で合意した
