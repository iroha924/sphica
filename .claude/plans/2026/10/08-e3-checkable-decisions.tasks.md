---
kind: tasks
plan: 08-e3-checkable-decisions.plan.md
branch: feat/e3-review-eval
base: main
---

# review が diff で決着しない決定を違反ではなく質問で返し、rules が Biome で検査できる決定に検査の下書きを付ける（E3: #220 と #257）のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: review の評価の土台

precedent の lane を Claude と Codex で隔離して流し、正解と機械で突き合わせられるようにする。Biome が fixture で使えることも先に確かめる。

- [x] T01: fixture の repo と DB、記録と diff、(diff, 記録) ごとの正解
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `server/evals/review/fixture.ts`, `server/evals/review/cases.json`, `server/test/review-eval.test.ts`
  - 完了条件: `cd server && node --test test/review-eval.test.ts` → fixture が一時ディレクトリに作られ、cases.json の全 diff で `review_select` が正解の「選ばれるか」と一致する
  - コミット: `test(eval): add the review evaluation fixture and expected verdicts`
  - 結果: `node --test --test-timeout=120000 test/review-eval.test.ts` → pass（8 diff、記録 6 件を足し、AI の決定 keep-case も active）。`bun run verify` → exit 0
- [x] T02: Biome を fixture の `biome.json` に向けて流す経路の確認
  - 種別: 追加
  - 計画: S1
  - 依存: T01（fixture の repo が要る）
  - 変更: `server/evals/review/biome.ts`, `server/test/review-eval.test.ts`
  - 完了条件: `cd server && node --test test/review-eval.test.ts` → 型 1（直接の import の禁止）と型 2（`overrides` の `includes` で絞った module 間の禁止）が本物の import で落ち、コメント・文字列・文書での言及では通る
  - コミット: `test(eval): check that the pinned Biome enforces both import templates on the fixture`
  - 結果: `node --test --test-timeout=120000 test/review-eval.test.ts` → 2 件 pass。型 1 は本物の import 2 か所だけを落とし、コメント・文字列・docs は通る。型 2 は src/ui から src/db.ts への直接の import を落とし、src/library.ts 経由は通る。読めない biome.json は例外になる。`bun run verify` → exit 0
- [x] T03: review 用の runner（Claude と Codex）と流す前の検証
  - 種別: 追加
  - 計画: S1
  - 依存: T01（runner は fixture に向けて流す）
  - 変更: `server/evals/review/run.ts`, `server/evals/review/runner.ts`, `server/test/review-eval.test.ts`, `knip.json`
  - 完了条件: `cd server && node --test test/review-eval.test.ts` → runner の settings・引数・MCP 設定が plan の方針どおり（Read / Grep / Glob と読み取り MCP だけ、hook なし、`EVAL_SPHICA_DB` を MCP の子プロセスへ明示、Codex は read-only と隔離した CODEX_HOME）。`node evals/review/run.ts --preflight` → Claude で checkout の外の無害なファイルが読めず、両ホストで本文の hash と fixture の DB が MCP の呼び出しログに出る
  - コミット: `feat(eval): run the precedent lane on Claude and Codex against the review fixture`
  - 結果: `node --test --test-name-pattern="a lane starts" test/review-eval.test.ts` → pass。`node evals/review/run.ts --preflight` → ✓ preflight passed（Claude は外のファイルへ Read を試して blockReadsOutsideWorkingDirectories で拒否、両ホストとも fixture の DB で review_select が trace:s-ja-storage/storage を選択、Claude の init は Read / Grep / Glob と sphica の MCP だけ、プラグインは Claude Code 組み込みのものだけ。1 run は Claude 36 秒、Codex 50 秒）。`bun run verify` → exit 0
- [x] T04: 採点器と、既知のログでの検証
  - 種別: 追加
  - 計画: S1
  - 依存: T03（runner の残すログの形が要る）
  - 変更: `server/evals/review/grade.ts`, `server/evals/review/runner.ts`, `server/evals/review/run.ts`, `server/test/review-eval.test.ts`
  - 完了条件: `cd server && node --test test/review-eval.test.ts` → 既知の成功・失敗・未完了・欠落・外を読んだログで、誤った violation、見逃し、質問、除外の件数が期待どおり（未完了と欠落は失敗、0 件扱いにならない）
  - コミット: `feat(eval): grade precedent runs against the expected verdicts`
  - 結果: `node --test test/review-eval.test.ts` → 4 件 pass（合成のログで、拒否された check を数えず後の backed を採る、束の欠け・completion 行の欠け・exit 1 は failed、`../..` を上がる Codex は excluded、質問の一覧を拾う、failed と excluded は違反の件数に足さない）。preflight の実際のログに `node evals/review/grade.ts --report` → Claude は probe の外のファイルを名指して excluded、Codex は completion 行が無く failed（どちらも期待どおり）。`bun run verify` → exit 0

## P2: 今の本文での基準

回数を固定し、今の precedent の本文での誤った violation と見逃しを測る。

- [x] T05: 予備測定（k=5、A/A）と本測定の回数の固定、今の本文での本測定
  - 種別: 追加
  - 計画: S2, S3
  - 依存: T04（採点器が要る）
  - 変更: `server/evals/review/run.ts`, `server/evals/review/cases.json`, `server/evals/review/grade.ts`, `server/test/review-eval.test.ts`
  - 完了条件: `cd server && node evals/review/grade.ts --report ~/.cache/sphica-eval/review/pilot-a` → モデル別・diff 別の誤った violation と見逃しの件数、failed と除外の数が出る（pilot-b も同じ）
  - コミット: `test(eval): fix the review measurement runs after the pilot`
  - 結果: 今の本文（body sha256 7a1ac6dd…）で diff 8 × 両モデル × 5 回 × 2 組 = 160 run。pilot-a: Claude 40 graded・誤った violation 1（thumb-quality の grid-3g）・見逃し 0、Codex 37 graded・3 failed（Codex 側の停止で時間切れ）・0・0。pilot-b: Claude 40 graded・0・0、Codex 40 graded・0・0。本測定は打ち切り（plan の変更履歴、持ち主の Go）。`node --test test/review-eval.test.ts` → 5 件 pass、`bun run verify` → exit 0

## P3: #220 の質問

diff で決着しない記録を質問として返す本文に変え、同じ回数で測って採否を決める。

- [-] T06: precedent の判定と質問の出力、launcher の照合と Questions の節
  - 種別: 変更
  - 計画: S3
  - 依存: T05（本文を変える前に baseline と回数を固定する）
  - 変更: `plugin/skills/review/reviewers/precedent.md`, `plugin/skills/review/SKILL.md`
  - 完了条件: `bun run verify:ai` → 0 で終わる。`cd server && node evals/review/grade.ts --report <新しい本文の run ディレクトリ> --against <baseline>` → モデル別の誤った violation の増減と見逃しの増減が出る
  - コミット: `feat(review): return decisions a diff cannot settle as questions, not violations`

## P4: #257 の下書き

`/sphica:rules` に Biome の検査の下書きを足し、下書きの正しさ（M1）を測る。

- [x] T07: M1 の記録・正解・別のケースと、rules を流して下書きを採点する経路
  - 種別: 追加
  - 計画: S4
  - 依存: T02（Biome の経路）, T03（runner）
  - 変更: `server/evals/review/rules-cases.json`, `server/evals/review/rules-grade.ts`, `server/evals/review/run.ts`, `server/evals/review/runner.ts`, `server/test/review-eval.test.ts`
  - 完了条件: `cd server && node --test test/review-eval.test.ts` → 既知の正しい下書き・誤った下書き・下書きすべきでない記録への下書きで、M1 の 3 つの基準の判定が期待どおり
  - コミット: `test(eval): grade drafted Biome checks against held-out cases`
  - 結果: `node --test test/review-eval.test.ts` → 5 件 pass（正しい下書きは全項目 0、全体の禁止を写さない override は src/ui/sort.ts を見逃す、admin の例外が無いと src/ui/admin.ts で誤った失敗、到達の禁止への marker は unwanted、下書きが無い返答と読めない JSONC は failed）。`bun run verify` → exit 0
- [-] T08: rules の Skill の検査の下書き
  - 種別: 変更
  - 計画: S4
  - 依存: T07（M1 で測る）
  - 変更: `plugin/skills/rules/SKILL.md`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run verify:ai` → 0 で終わる。`cd server && node evals/review/rules-grade.ts --report <M1 の run ディレクトリ>` → モデル別に、下書きすべきでない記録への下書き・誤った失敗・見逃しの件数が出る
  - コミット: `feat(rules): draft a Biome import check for decisions that forbid a direct dependency`

- [-] T12: 下書きが全体の paths を落とし、module の禁止をファイル名の glob で書く誤りを直す
  - 種別: 修正
  - 計画: S4
  - 依存: T08（直す対象の Skill の節）
  - 変更: `plugin/skills/rules/SKILL.md`, `server/evals/review/rules-cases.json`, `server/test/review-eval.test.ts`
  - red: `cd server && node evals/review/rules-grade.ts --report ~/.cache/sphica-eval/review/m1b` → M1 のケース（全体の `paths`・同じ名前の別 module・tsconfig の別名）を足した後、直す前の下書きに誤った失敗（`src/ui/legacy.ts`）と見逃し（`src/ui/alias.ts`、`src/ui/pad.ts`）が出る
  - 完了条件: `cd server && node evals/review/rules-grade.ts --report ~/.cache/sphica-eval/review/m1c` → 両ホスト各 10 run で、下書きすべきでない記録への下書き・誤った失敗・見逃しが 0
  - コミット: `fix(rules): copy project-wide bans into overrides and list the imports a module ban covers`

## P5: #257 の Lifecycle と変更タスクでの比較（M1 が基準に届いたときだけ）

overview が持ち主の挙げた検査ファイルの marker を読み、変更タスクで「ルール文だけ」と比べる。

- [-] T09: overview look の `checks` と、コメントの marker の読み取り
  - 種別: 追加
  - 計画: S5
  - 依存: T08（M1 が基準に届いたときだけ作る）
  - 変更: `server/src/overview.ts`, `server/src/rule-files.ts`, `server/src/mcp.ts`, `server/test/overview.test.ts`, `server/test/rule-files.test.ts`, `plugin/skills/rules/SKILL.md`
  - 完了条件: `cd server && node --test test/overview.test.ts test/rule-files.test.ts` → 一覧のファイルだけを読み、`//`・`/* */`・`#`・`<!-- -->` の marker を拾い、superseded（後継付き）・withdrawn・別プロジェクトを出し、読めなかった・無かった・範囲外の件数と上限・ページ送り・READ_BUDGET を守る
  - コミット: `feat(overview): flag check files whose marker names a replaced record`
- [-] T13: 検査ファイルの marker を文字列や別の言語のコメントから拾い、instruction ファイルの走査を変え、checks のハッシュが衝突する誤りを直す
  - 種別: 修正
  - 計画: S5
  - 依存: T09（直す対象の look の checks）
  - 変更: `server/src/overview.ts`, `server/src/rule-files.ts`, `server/test/overview.test.ts`, `plugin/skills/rules/SKILL.md`
  - red: `cd server && node --test --test-name-pattern="marker lines only" test/overview.test.ts` → 直す前のコードで、JSON の文字列の中の `// sphica:` と JSONC の HTML コメントを marker として拾い、checks に入れた AGENTS.md のコード例の `// sphica:` を拾い、`["a\u0000b", "c"]` と `["a", "b", "c"]` のカーソルを同じと見なして失敗する
  - 完了条件: `cd server && node --test test/overview.test.ts test/rule-files.test.ts` → 全件 pass
  - コミット: `fix(overview): read a check file's marker only from a comment line of its own language`

- [-] T14: 拡張子が Object の継承プロパティ名（constructor）の検査ファイルで look が例外で落ちる誤りを直す
  - 種別: 修正
  - 計画: S5
  - 依存: T13（直す対象のコメントの表）
  - 変更: `server/src/overview.ts`, `server/test/overview.test.ts`, `plugin/skills/rules/SKILL.md`
  - red: `cd server && node --test --test-name-pattern="marker lines only" test/overview.test.ts` → 直す前のコードで `checks.constructor` を渡すと TypeError: openers.map is not a function
  - 完了条件: `cd server && node --test test/overview.test.ts test/rule-files.test.ts` → 全件 pass
  - コミット: `fix(overview): treat a check file's unknown extension as unknown, whatever its name`

- [x] T10: M2 のタスク、隠しテスト、patch の違反の判定
  - 種別: 追加
  - 計画: S5
  - 依存: T07（M1 の rules の fixture とケースの上に作る）
  - 変更: `server/evals/review/m2.ts`, `server/evals/review/m2-cases.json`, `server/test/review-eval.test.ts`
  - 完了条件: `cd server && node --test --test-name-pattern="M2 judges" test/review-eval.test.ts` → 禁止された import を残した patch は違反あり、library 経由は違反なし、例外の admin は違反なし・誤った失敗なし、隠しテストで完了を判定する
  - コミット: `test(eval): add change tasks that compare rule lines with an installed Biome check`
  - 結果: `node --test --test-name-pattern="M2 judges" test/review-eval.test.ts` → pass。M2 の予備の run（rules、タスク 3 つ × 両ホスト × 3 回）→ `node evals/review/m2.ts --report ~/.cache/sphica-eval/review/m2-pilot` で 18 run、failed 0、違反 0、誤った失敗 0、完了 18。基準 (1) を評価できず #257 は不採用（plan の変更履歴、持ち主の Go）。check の条件は流していない。`bun run verify` → exit 0

## P6: 採否の反映と出荷の準備

不採用の差分を外し、版をそろえる。

- [-] T11: 不採用の差分の除去と版の同期
  - 種別: 変更
  - 計画: S6
  - 依存: T05（#220 の採否は予備測定で決まった）, T08（#257 の M1 の採否）, T10（#257 の M2 の採否）
  - 変更: `plugin/skills/rules/SKILL.md`, `server/src/overview.ts`, `server/src/rule-files.ts`, `server/src/mcp.ts`, `server/test/overview.test.ts`, `server/test/rule-files.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `git diff main -- plugin server/src server/test/overview.test.ts server/test/rule-files.test.ts .claude-plugin` → 空。`bun run release:plan -- --base <前の release のコミット>` → `none`。`bun run verify` → 0 で終わる
  - コミット: `revert(rules): drop the Biome check drafts and look checks that #257 did not adopt`

- [x] T15: main から切ったブランチに、最終の差分（評価の仕組み・テスト・knip・計画）を 1 コミットで載せる
  - 種別: 変更
  - 計画: S6
  - 依存: T10（#257 の M2 の採否）
  - 変更: `knip.json`, `server/evals/review/run.ts`, `server/evals/review/m2.ts`, `server/test/review-eval.test.ts`
  - 完了条件: `git diff --quiet main -- plugin server/src server/test/overview.test.ts server/test/rule-files.test.ts .claude-plugin` → exit 0。`bun run release:plan -- --base v0.6.42 のコミット` → none。`bun run verify` → 0 で終わる
  - コミット: `test(eval): add the review and rules evaluation for E3 (#220, #257)`
  - 結果: `git diff --quiet main -- plugin server/src server/test/overview.test.ts server/test/rule-files.test.ts .claude-plugin` → exit 0（製品側は main と同じ、版は 0.6.42）。`bun run release:plan -- --base v0.6.42 のコミット` → none。`bun run verify` → exit 0

- [x] T16: M2 の判定が checkout の外へのリンクを通して書き、採点器が completion 行の中身を確かめず、結果の無い run を数えない誤りを直す
  - 種別: 修正
  - 計画: S1
  - 依存: T15（直す対象は最終の差分の評価の仕組み）
  - 変更: `server/evals/review/m2.ts`, `server/evals/review/grade.ts`, `server/evals/review/rules-grade.ts`, `server/evals/review/run.ts`, `server/test/review-eval.test.ts`
  - red: `cd server && node --test --test-name-pattern="completion line leaves|never writes through" test/review-eval.test.ts` → 直す前のコードで、未確認の範囲を残した COMPLETE の報告を graded にし、M2 の判定が外を指す biome.jsonc のリンクを拒まず先を読んで失敗する
  - 完了条件: `cd server && node --test test/review-eval.test.ts` → 全件 pass
  - コミット: `fix(eval): refuse links out of a judged checkout and grade only complete reports`
  - 結果: red を確かめた（未確認の範囲を残した報告で reason が空、リンクの先を Biome が読んで parse の失敗）。`node --test test/review-eval.test.ts` → 8 件 pass。直した採点器で予備測定を採点し直した: `node evals/review/grade.ts --report ~/.cache/sphica-eval/review/pilot-a` → Claude 40 graded・誤った violation 1、Codex 37 graded・3 failed（時間切れ）。pilot-b → 両モデル 40 graded・0。数字は元のとおり。`bun run verify` → exit 0

- [x] T17: M2 の判定のテストが macOS 以外で sandbox-exec を呼んで落ちる誤りを直す
  - 種別: 修正
  - 計画: S5
  - 依存: T16（直す対象の M2 の判定）
  - 変更: `server/evals/review/m2.ts`, `server/test/review-eval.test.ts`
  - red: `gh run view 37741122318 --log-failed` → PR #304 の CI の check（Linux）で「M2 judges」が AssertionError: not run to the end (spawnSync /usr/bin/sandbox-exec ENOENT)
  - 完了条件: `cd server && node --test test/review-eval.test.ts` → 全件 pass。PR #304 の CI の check が pass
  - コミット: `fix(eval): run M2's hidden test without the macOS sandbox in tests on other hosts`
  - 結果: judge が隠しテストの runner を受け取るようにし、テストは eval-fixture と同じく macOS 以外では Node の囲いだけで流す。sandbox なしの経路を手元で流して確かめた（count の違反ありの patch で violations [src/ui/detail.ts]、completed true。実際のパスを渡さないと Node の囲いの外になり、隠しテストが走らなかった）。`node --test test/review-eval.test.ts` → 8 件 pass、`bun run verify` → exit 0

- [x] T18: GitHub の Codex のレビューの 7 件を直す（M2 が run の git の設定を持ち主の権限で実行する穴を含む）
  - 種別: 修正
  - 計画: S1
  - 依存: T17（直す対象の評価の仕組み）
  - 変更: `server/evals/review/m2.ts`, `server/evals/review/grade.ts`, `server/evals/review/rules-grade.ts`, `server/evals/review/run.ts`, `server/test/review-eval.test.ts`
  - red: `node filter-red.ts` → 直す前の m2.ts で、checkout の .git/config に仕込んだ clean filter と .gitattributes を置いて judge を呼ぶと filter ran on the host: true（スクリプトはこの会話の scratchpad にあり、同じことをテスト「M2 judges through a git directory the run cannot write」が確かめる）
  - 完了条件: `cd server && node --test test/review-eval.test.ts` → 全件 pass
  - コミット: `fix(eval): judge M2 through a pinned git dir and tighten the graders`
  - 結果: red を確かめた（filter ran on the host: true）。直した後 `node --test test/review-eval.test.ts` → 12 件 pass（仕込んだ filter が走らない、走らなかった隠しテストは失敗、正解の外の判定を数える、報告されない違反で失敗、precedent の run だけを数える、held-out のケースを名指した rules の run を除外、run が 0 本になる引数を拒む）。予備測定を採点し直した: pilot-a は Claude 40 graded・誤った violation 1・食い違い 1、Codex 37 graded・3 failed、pilot-b は両モデル 40 graded・0、m1c は 20 graded・全項目 0、m2-pilot は違反 0・完了 18。数字は元のとおり。`bun run verify` → exit 0

- [x] T19: M2 の判定が run の書いた Biome の設定（入れ子と extends）を読み、外を読んだ run の判定が 1 段ずつの `cd ..` を見逃す誤りを直す
  - 種別: 修正
  - 計画: S1
  - 依存: T18（直す対象の M2 の判定と外の読み取りの判定）
  - 変更: `server/evals/review/m2.ts`, `server/evals/review/grade.ts`, `server/test/review-eval.test.ts`
  - red: `cd server && node --test --test-name-pattern="own check only|one directory at a time" test/review-eval.test.ts` → 直す前のコードで、run の biome.jsonc の extends の先を Biome が読んで失敗し、`cd .. && cd .. && cat` を除外しない
  - 完了条件: `cd server && node --test test/review-eval.test.ts` → 全件 pass
  - コミット: `fix(eval): judge M2 with its own Biome config only and catch any parent step`
  - 結果: red を確かめた（biome printed no report、climbed が出ない）。直した後 `node --test test/review-eval.test.ts` → 14 件 pass。予備測定を採点し直して数字は元のとおり（pilot-a・pilot-b・m1c）。M2 の予備の 18 run は、ルートの biome.json が fixture と同じで入れ子の設定も無かったので、保存された判定（違反 0）は変わらない。`bun run verify` → exit 0

- [x] T20: Codex の M2 の run の外の読み取りを除外せず、fixture を入力を確かめずに使い回し、`--rules` が下書きの指示の無い本文で流れる誤りを直す
  - 種別: 修正
  - 計画: S1
  - 依存: T19（直す対象の評価の仕組み）
  - 変更: `server/evals/review/m2.ts`, `server/evals/review/fixture.ts`, `server/evals/review/run.ts`, `server/evals/review/runner.ts`, `server/evals/review/rules-body.md`, `server/test/review-eval.test.ts`
  - red: `cd server && node --test --test-name-pattern="cached fixture|names the repository holding the hidden|body M1 measured" test/review-eval.test.ts` → 直す前のコードには cachedFixture・m2Rows・RULES_BODY が無く失敗する（中身: `grep -c noRestrictedImports plugin/skills/rules/SKILL.md` が 0、M2 の集計に除外の列が無い、fixture.json があれば入力を見ずに使う）
  - 完了条件: `cd server && node --test test/review-eval.test.ts` → 全件 pass
  - コミット: `fix(eval): exclude M2 runs that read the evals, key fixtures by inputs, keep M1's body`
  - 結果: `node --test test/review-eval.test.ts` → 17 件 pass。M2 の除外を初めはリポジトリ全体で判定し、予備の 18 run がすべて除外になった（condition が置く check.mjs が server/node_modules の Biome を名指す）。除外の対象を server/evals に絞り、`node evals/review/m2.ts --report ~/.cache/sphica-eval/review/m2-pilot` → 18 run、除外 0、違反 0、完了 18（元のとおり）。`bun run verify` → exit 0

- [x] T21: 評価される run が Codex のログイン情報や正解を読めるのを OS の囲いで止め、条件の混在と文字列の中の marker を直す
  - 種別: 修正
  - 計画: S1
  - 依存: T20（直す対象の評価の仕組み）
  - 変更: `server/evals/review/runner.ts`, `server/evals/review/run.ts`, `server/evals/review/m2.ts`, `server/evals/review/grade.ts`, `server/evals/review/rules-grade.ts`, `server/test/review-eval.test.ts`
  - red: `codex exec -s read-only -C <checkout> -` → 今までの lane の形で checkout の probe.sh を流すと READ auth（$CODEX_HOME/auth.json）、READ cases（server/evals/review/cases.json）。M1 の以前の読み方は `"message": "sphica: trace:..."` も marker と数えた
  - 完了条件: `cd server && node --test test/review-eval.test.ts` → 全件 pass。`node evals/review/run.ts --preflight` → ✓ preflight passed（Codex の probe が cases・outside・auth のすべてで DENIED）
  - コミット: `fix(eval): fence what runs may read, refuse mixed settings, count comment markers only`
  - 結果: Codex の lane は permission profile（`:read-only`、M2 は `:workspace`）で server/evals・出力先・~/.codex・run の auth.json を deny にし、`-s` を外した。checkout は出力先の外（一時ディレクトリ）。Claude の M2 の shell の sandbox にも同じ拒否を足した。`..` の文字列の判定は外した。preflight → ✓（Codex の probe は DENIED cases・outside・auth、READ は 0、MCP は DB に届いた）。M2 を両ホスト 1 run ずつ（check、count）→ 両方 completed、違反 0、Codex は check.mjs を流せた。条件の混在を拒む検査を入れ、予備測定の各ディレクトリはホストごとに 1 つの条件で、これまでどおり採点できた。`node --test test/review-eval.test.ts` → 18 件 pass。`bun run verify` → exit 0

## 記録

- 2026-10-08 / T05 / 欄を変えた。変更（前: plan.json、後: run.ts・cases.json・grade.ts・review-eval.test.ts）、完了条件（前: baseline の本測定と plan.json の回数、後: 予備測定 A と B の report）/ 予備測定で #220 の打ち切りが決まり（plan の変更履歴、持ち主の Go）、本測定の回数を固定するファイルは要らなくなった。予備測定で見つけた直しをこのタスクに入れた: duplicate-names の正解をどの判定でも可に（あいまい）、grade.ts の missed を「正解が violation だけ」のときに限定、run.ts の時間切れでプロセスのグループごと止めて上限を 10 分に
- 2026-10-08 / T06 / 取りやめ / #220 は予備測定で打ち切り、本文の変更をしない（plan の変更履歴、持ち主の Go）。S3 を担うのは T06 だけだったので、plan の変更履歴で S3 を行わないと決めた
- 2026-10-08 / T11 / 依存を変えた（前: T06（#220 の採否）、後: T05（#220 の採否は予備測定で決まった））/ T06 の取りやめ
- 2026-10-08 / T05 / Codex の ui-indirect の 3 run が 03:39〜03:40 に別々の場所で止まり、30 分の上限の後も子の MCP サーバーがパイプを開いたまま約 59 分続いた / プロセスのグループごと止める修正を入れた。止まった原因は分かっていない（同じ時刻の 3 run だけで、pilot-b では 0 件）

- 2026-10-08 / T07 / 予備測定（T05）を流している間に、依存（T02・T03）を満たした T07 を先に終えた。変更欄に run.ts・runner.ts を足した（rules の lane を runner に足すため）/ 予備測定の node は読み込み済みのコードで動くので結果は混ざらない

- 2026-10-08 / T04 / 変更欄を直した（前: grade.ts・`server/test/fixtures/review-eval/`・review-eval.test.ts、後: grade.ts・runner.ts・run.ts・review-eval.test.ts）/ 既知のログはテストの中で合成した。preflight の run に completion 行が無く、review の Step 4 で launcher が付ける指示を runner の prompt に足した

- 2026-10-08 / T03 / 変更欄に `knip.json` を足した（前: run.ts・runner.ts・review-eval.test.ts、後: それに knip.json）/ 評価のスクリプトは knip の entry に並べる決まりのため
- 2026-10-08 / T03 / MCP の子プロセスへは EVAL_SPHICA_DB ではなく SPHICA_DB と SPHICA_HOME を直接渡した / slot の sphica.sh を通さず node で mcp.js を起動するので、変換する層が無い
- 2026-10-08 / T03 / Claude の init に Claude Code 組み込みのプラグイン（path: builtin）が 3 つ載る / 持ち主の review でも同じく載るので、preflight は組み込み以外のプラグインだけを落とす

- 2026-10-08 / T02 / Biome の `overrides` の options は全体の options を置き換え、合わさらない（全体の lodash の禁止を繰り返さない override では src/ui に lodash が通る）/ T02 のテストに入れ、T08 の下書きの書式で全体の禁止を各 override に写すと決める
- 2026-10-08 / T02 / `--config-path` と cwd の綴りが違う（macOS の /var と /private/var）と override の includes が当たらない / restrictedImports で realpath を使う
- 2026-10-08 / T05 / 計画欄を変えた（前: S2、後: S2, S3）/ S3 を「#220 の採否の記録」に直し、採否は T05 の予備測定で決まったため
- 2026-10-08 / T08 / M1 の回数を測る前に固定した: 両ホスト各 10 run（`run.ts --rules --runs 10`）。基準は plan のとおり（下書きすべきでない記録への下書き 0、誤った失敗 0、本物の違反の見逃し 0）をモデル別に全 run で満たすこと
- 2026-10-08 / T08 / 1 回目の M1（~/.cache/sphica-eval/review/m1、両ホスト各 10 run、全項目 0）は無効にした / Skill の例（lodash、lodash-es、src/ui/**、**/db.ts）が M1 の fixture の記録と同じ名前で、例を写せば正解できた。例を関係の無い名前（moment、src/views/**、**/store.ts）に変え、同じ回数（各 10 run）で m1b として流し直す
- 2026-10-08 / T08 / 変更欄に 4 つの manifest を足した（前: rules/SKILL.md、後: それと npm・Claude・Codex・marketplace の版）/ plugin に入るファイルを変えるコミットは pre-commit が版の同期を求める。`release:plan --base v0.6.42` は plugin、0.6.43 に上げた。T11 は最後に版がそろっていることを確かめる
- 2026-10-08 / T09 / 変更欄に rules/SKILL.md を足した（「Later」に checks の渡し方を書く）/ look が検査ファイルを読むのは checks で名指したときだけなので、Skill に書かないと使われない
- 2026-10-08 / T08 / Codex のタスクごとのレビュー（8b5ac133）: F1（override に patterns だけを写すと全体の paths の禁止が消える）と F2（module の禁止をファイル名の glob にすると同じ名前の別 module まで禁止し、tsconfig の別名の import を見逃す）を受け入れ、修正タスク T12 を足す
- 2026-10-08 / T12 / 修正タスクを足した（T08 のレビューの F1・F2）。Biome 2.5.14 で確かめた: import の書き方そのもの（`../db`、`../db.ts`、`@db`）を並べればそれだけが落ち、`../legacy/db.ts` と `./db.ts` は落ちない。写した `paths` は override でも効く。`includes` の `src/ui/*` はすぐ下だけに当たる / M1 のケースを足して流し直す（m1c、各 10 run）
- 2026-10-08 / T09 / Codex のタスクごとのレビュー（b4b0823c）: F2（文字列の中や別の言語のコメントの marker を拾う）・F3（checks に入れた instruction ファイルの走査が変わる）・F4（NUL で checks のハッシュが衝突する）を受け入れ、修正タスク T13 を足した。F1（複数行のブロックコメントの中の marker を拾えない）は見送る: marker の形を行頭の 1 行のコメントと決めて Skill に書く。言語ごとのコメントの解析を自前で書くと読み落としが出やすい
- 2026-10-08 / T12 / コミット欄を短くした（前: keep every project-wide ban in an override and name the imports a module ban covers、後: copy project-wide bans into overrides and list the imports a module ban covers）/ 件名の上限 100 文字を超えた
- 2026-10-08 / T10 / M2 の予備の run を本測定の前に流す: ルール文だけ（rules）、タスク 3 つ × 両ホスト × 3 回。ルール文だけで違反が出なければ、基準 (1)「違反がルール文だけより減る」を測れないので持ち主に戻す
- 2026-10-08 / T12・T13 / Codex のタスクごとのレビュー（d3b28eae、e5836e20）: T13-F2（拡張子が constructor だと look が例外で落ちる）を受け入れて T14 を足した。T12-F1（下書きの後に足された深いディレクトリを M1 で測っていない）は見送り、import の書き方で禁止する方式の限界として下書きに書くよう Skill に足した。T13-F1（複数行の文字列の中の marker らしい行を拾う）は見送り: 言語ごとの文字列の解析が要り、起きても look が余計な知らせを 1 行出すだけ。同じ箇所の 2 巡目なので、ここからは例外で落ちる・誤った結果を返す不具合だけを直す
- 2026-10-08 / T10 / 欄を変えた。依存（前: T09、後: T07）、変更（前: cloud の tasks.json・grade.ts・eval-grade.test.ts、後: review の m2.ts・m2-cases.json・review-eval.test.ts）、完了条件（前: tasks.json に回数を固定、後: 判定のテスト）/ cloud の評価ループの条件（none・search・inject・gold）は「ルール文だけ」と「ルール文＋検査」の比較に合わず、M2 は review の評価の下に専用の変更タスクの lane として作った。M2 の予備の run で #257 の打ち切りが決まり、本測定の回数は固定しない
- 2026-10-08 / T11 / 欄を変えた。依存に T10 を足し、変更に #257 の製品側の変更（rules/SKILL.md・overview・rule-files・mcp・関連テスト）を足し、完了条件を「main との差分が空で release:plan が none」に、コミットを revert に / #257 が不採用になり、下書きと Lifecycle を最終の差分から外す（plan の変更履歴、持ち主の Go）
- 2026-10-08 / T11 / 取りやめ（このブランチでは）/ 0.6.43 → 0.6.42 に戻すコミットは pre-commit（check-mcp-version.mjs）が「HEAD より下げない」で止め、0.6.43 のまま main に入れると marketplace が存在しない npm の版を指す。持ち主の決定 u223（未公開の版を含む PR は main に入れず、版の変更を除いた中身を main から 1 コミットの新しい PR に作り直す）のとおり、このブランチは実験の実装の記録として残し、最終の差分（評価の仕組み・テスト・knip・計画）だけを main から切った feat/e3-review-eval に 1 コミットで載せる。T11 の完了条件（main との製品側の差分が空、release:plan が none、verify）はそのブランチで確かめる
- 2026-10-08 / T08・T09・T12・T13・T14 / 取りやめ（最終の差分では）/ 実装と測定は feat/e3-checkable-decisions に残した（T08 8b5ac133、T09 b4b0823c、T12 d3b28eae、T13 e5836e20、T14 01f54de0）。#257 が不採用になり（plan の変更履歴、持ち主の Go）、製品側の変更は main に入れない
- 2026-10-08 / T15 / タスクを足し、frontmatter の branch を feat/e3-review-eval に変えた（前: feat/e3-checkable-decisions）/ 持ち主の決定 u223 のとおり、版を上げたままのブランチは main に入れず、main から 1 コミットで作り直した。T01〜T05・T07・T10 のコミットは feat/e3-checkable-decisions にあり、このブランチの check_plan done はそれを見られないので、このブランチでは最後の 1 コミットが各タスクのファイルを変えていることを見る
- 2026-10-08 / T11 / feat/e3-checkable-decisions の 6a2da9da は check_plan tasks の違反（S6 を担うタスクが無い）を出したままコミットした（出力を head に通して終了コードが隠れた）。このブランチで T15 を足して直した
- 2026-10-08 / T08 / 結果（feat/e3-checkable-decisions で）: `bun run verify:ai` → 0。M1（m1b、Skill の例を fixture と関係の無い名前にした後、両ホスト各 10 run）→ `node evals/review/rules-grade.ts --report ~/.cache/sphica-eval/review/m1b` で 20 run すべて graded、下書きすべきでない記録への下書き 0・marker の欠け 0・誤った失敗 0・見逃し 0。Claude の 10 run は全部 override に全体の禁止を写し、admin を `!src/ui/admin.ts` で外した。M1 は基準に届いた（採用）。`bun run verify` → exit 0
- 2026-10-08 / T12 / 結果（feat/e3-checkable-decisions で）: red: ケースを足した後の `node evals/review/rules-grade.ts --report ~/.cache/sphica-eval/review/m1b` → 直す前の 20 run すべてで誤った失敗 src/ui/legacy.ts、見逃し src/ui/alias.ts・src/ui/pad.ts（と、当時の fixture に paths が無かった src/pad.ts）。直した後の m1c（両ホスト各 10 run）→ 20 run すべて graded、下書きすべきでない記録への下書き 0・marker の欠け 0・誤った失敗 0・見逃し 0。`node --test test/review-eval.test.ts` → pass。`bun run verify` → exit 0
- 2026-10-08 / T09 / 結果（feat/e3-checkable-decisions で）: `node --test test/overview.test.ts test/rule-files.test.ts` → 全件 pass（新しく: 名指した biome.jsonc と checks.toml の `//`・`/* */`・`#`・`<!-- -->` の marker を拾い、superseded（後継付き）・withdrawn・別プロジェクトを出す、名指さないファイルは読まない、無い 1 件・外 2 件を数える、カーソルは別の checks の一覧では続かない、MCP で checks を live に渡すと拒否、symlink で外へ出る検査ファイルと上限を超えるファイルは読まない）。`bun run verify` → exit 0
- 2026-10-08 / T13 / 結果（feat/e3-checkable-decisions で）: red: 直す前のコードで `--test-name-pattern="marker lines only"` → 失敗（AGENTS.md:3、biome.jsonc:2 の HTML コメント、checks.toml:2 の `//` を拾った）。直した後: `node --test test/overview.test.ts test/rule-files.test.ts` → 33 件 pass（行頭のその言語のコメントだけを拾う、checks に入れた AGENTS.md は Markdown として読む、拡張子の分からないファイルは件数を出す、NUL を含む一覧と区切りの違う一覧はカーソルを共有しない）。T09 のテストの行末コメントと JSONC の HTML コメントを、行頭のコメントに直した（意図した挙動の変更）。`bun run verify` → exit 0
- 2026-10-08 / T14 / 結果（feat/e3-checkable-decisions で）: red を確かめた（TypeError: openers.map is not a function）。表を Map にして `node --test test/overview.test.ts test/rule-files.test.ts` → 33 件 pass。Skill に、module の禁止は今ある深さだけを守ると書いた（T12 のレビューの F1 を見送った代わり）。`bun run verify` → exit 0
- 2026-10-08 / T15 / Codex の全差分のレビュー（main..c05d5484、high）: 3 件とも受け入れ T16 を足した。M2 の判定が外を指すリンクを通して書く（高）、採点器が completion 行の未確認の範囲・件数・重複を見ない（中）、result.json の無い run を分母に入れない（中）。厳しくした件数の照合が Codex の `findings: 1 (informational)` を読めず 8 run を落としたので、件数の後ろの説明を許した
- 2026-10-08 / T17 / PR #304 の CI の check（Linux、Node 24.15 と 26）で M2 の判定のテストが sandbox-exec の ENOENT で落ちた。この PR で入ったもので、Linux に sandbox-exec が無いという決まった原因なので、ジョブの流し直しはしなかった
- 2026-10-08 / T18 / GitHub の Codex（chatgpt-codex-connector、aeea56e のレビュー）の 9 件: 7 件を受け入れた（正解の外の判定、報告されない違反、gradeAll が precedent 以外の run を数える、Codex の rules の run の外の読み取り、sandbox-exec の無いホストの隠しテスト、M2 の judge が run の書ける .git を通す（セキュリティ。持ち主に報告して Go を得てから直した。予備の 18 run の checkout に filter・hooksPath・fsmonitor・hook・.gitattributes は無かった）、run が 0 本になる引数）。2 件は見送った: Claude の lane が持ち主の HOME を使う（ログインに要り、cloud の runner と同じ。ファイルのツールは checkout の外を読めず資格情報のディレクトリも拒む）、質問の一覧の形が prompt に無い（#220 の新しい本文で足す予定の形で、#220 は不採用）
- 2026-10-08 / T19 / Codex の T17・T18 の再レビュー（aeea56e3..63d18c89、high）: 4 件。run の Biome の設定の extends（高）と入れ子の設定（中）、1 段ずつの `cd ..`（中）を受け入れ T19 を足した。報告の本文に違反が載ったかを見ない（中）は前回と同じ理由で見送った。同じ評価コードへのレビューは 4 巡目で、ここで打ち切る
- 2026-10-08 / T20 / GitHub の Codex（06aa3e68 のレビュー、持ち主が共有）の 4 件: M2 の Codex の run の外の読み取り、fixture の使い回し、`--rules` の本文の 3 件を受け入れ T20 を足した。報告の一覧と違反の突き合わせ（3 回目）は同じ理由で見送った。#257 で測った rules の本文は、Skill を main に戻したので評価の fixture（server/evals/review/rules-body.md）として残した
- 2026-10-08 / T21 / GitHub の Codex（c94bfcd1 のレビュー、持ち主が共有）の 5 件をすべて直した（持ち主の判断「全部直してから merge」）。Codex の読み取りを止める方法は researcher と Codex に並行で調べ、両方とも permission profile の deny と答えた（rust-v0.160.1 のソース）。手元で確かめた: `:root` を deny して必要な場所だけ read にする形は、codex が自分の実行ファイルを起動できず失敗した（親を deny すると子の read が効かない、issue #21081 と同じ形）。deny だけを並べる形で効いた。TOML では default_permissions を表より前に書く必要がある
- 2026-10-08 / T21 / 気づいたこと: #220 の予備測定の A と A/A で Claude Code が 2.1.293 と 2.1.294 で違っていた（#220 のコメントには書いていない）。main の cloud の評価の Codex の runner（evals/cloud/codex.ts）にも、ログイン情報を読める同じ形が残っている。どちらも持ち主に相談する
- 2026-10-08 / T21 / M2 の smoke で、2 つのプロセスが同じ出力先に fixture を同時に作ってぶつかった（table sphica_generation already exists）。fixture ができるまで 1 つずつ始める
