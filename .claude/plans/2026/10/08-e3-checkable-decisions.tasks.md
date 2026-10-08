---
kind: tasks
plan: 08-e3-checkable-decisions.plan.md
branch: feat/e3-checkable-decisions
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
- [x] T08: rules の Skill の検査の下書き
  - 種別: 変更
  - 計画: S4
  - 依存: T07（M1 で測る）
  - 変更: `plugin/skills/rules/SKILL.md`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run verify:ai` → 0 で終わる。`cd server && node evals/review/rules-grade.ts --report <M1 の run ディレクトリ>` → モデル別に、下書きすべきでない記録への下書き・誤った失敗・見逃しの件数が出る
  - コミット: `feat(rules): draft a Biome import check for decisions that forbid a direct dependency`
  - 結果: `bun run verify:ai` → 0。M1（m1b、Skill の例を fixture と関係の無い名前にした後、両ホスト各 10 run）→ `node evals/review/rules-grade.ts --report ~/.cache/sphica-eval/review/m1b` で 20 run すべて graded、下書きすべきでない記録への下書き 0・marker の欠け 0・誤った失敗 0・見逃し 0。Claude の 10 run は全部 override に全体の禁止を写し、admin を `!src/ui/admin.ts` で外した。M1 は基準に届いた（採用）。`bun run verify` → exit 0

- [x] T12: 下書きが全体の paths を落とし、module の禁止をファイル名の glob で書く誤りを直す
  - 種別: 修正
  - 計画: S4
  - 依存: T08（直す対象の Skill の節）
  - 変更: `plugin/skills/rules/SKILL.md`, `server/evals/review/rules-cases.json`, `server/test/review-eval.test.ts`
  - red: `cd server && node evals/review/rules-grade.ts --report ~/.cache/sphica-eval/review/m1b` → M1 のケース（全体の `paths`・同じ名前の別 module・tsconfig の別名）を足した後、直す前の下書きに誤った失敗（`src/ui/legacy.ts`）と見逃し（`src/ui/alias.ts`、`src/ui/pad.ts`）が出る
  - 完了条件: `cd server && node evals/review/rules-grade.ts --report ~/.cache/sphica-eval/review/m1c` → 両ホスト各 10 run で、下書きすべきでない記録への下書き・誤った失敗・見逃しが 0
  - コミット: `fix(rules): copy project-wide bans into overrides and list the imports a module ban covers`
  - 結果: red: ケースを足した後の `node evals/review/rules-grade.ts --report ~/.cache/sphica-eval/review/m1b` → 直す前の 20 run すべてで誤った失敗 src/ui/legacy.ts、見逃し src/ui/alias.ts・src/ui/pad.ts（と、当時の fixture に paths が無かった src/pad.ts）。直した後の m1c（両ホスト各 10 run）→ 20 run すべて graded、下書きすべきでない記録への下書き 0・marker の欠け 0・誤った失敗 0・見逃し 0。`node --test test/review-eval.test.ts` → pass。`bun run verify` → exit 0

## P5: #257 の Lifecycle と変更タスクでの比較（M1 が基準に届いたときだけ）

overview が持ち主の挙げた検査ファイルの marker を読み、変更タスクで「ルール文だけ」と比べる。

- [x] T09: overview look の `checks` と、コメントの marker の読み取り
  - 種別: 追加
  - 計画: S5
  - 依存: T08（M1 が基準に届いたときだけ作る）
  - 変更: `server/src/overview.ts`, `server/src/rule-files.ts`, `server/src/mcp.ts`, `server/test/overview.test.ts`, `server/test/rule-files.test.ts`, `plugin/skills/rules/SKILL.md`
  - 完了条件: `cd server && node --test test/overview.test.ts test/rule-files.test.ts` → 一覧のファイルだけを読み、`//`・`/* */`・`#`・`<!-- -->` の marker を拾い、superseded（後継付き）・withdrawn・別プロジェクトを出し、読めなかった・無かった・範囲外の件数と上限・ページ送り・READ_BUDGET を守る
  - コミット: `feat(overview): flag check files whose marker names a replaced record`
  - 結果: `node --test test/overview.test.ts test/rule-files.test.ts` → 全件 pass（新しく: 名指した biome.jsonc と checks.toml の `//`・`/* */`・`#`・`<!-- -->` の marker を拾い、superseded（後継付き）・withdrawn・別プロジェクトを出す、名指さないファイルは読まない、無い 1 件・外 2 件を数える、カーソルは別の checks の一覧では続かない、MCP で checks を live に渡すと拒否、symlink で外へ出る検査ファイルと上限を超えるファイルは読まない）。`bun run verify` → exit 0
- [x] T13: 検査ファイルの marker を文字列や別の言語のコメントから拾い、instruction ファイルの走査を変え、checks のハッシュが衝突する誤りを直す
  - 種別: 修正
  - 計画: S5
  - 依存: T09（直す対象の look の checks）
  - 変更: `server/src/overview.ts`, `server/src/rule-files.ts`, `server/test/overview.test.ts`, `plugin/skills/rules/SKILL.md`
  - red: `cd server && node --test --test-name-pattern="marker lines only" test/overview.test.ts` → 直す前のコードで、JSON の文字列の中の `// sphica:` と JSONC の HTML コメントを marker として拾い、checks に入れた AGENTS.md のコード例の `// sphica:` を拾い、`["a\u0000b", "c"]` と `["a", "b", "c"]` のカーソルを同じと見なして失敗する
  - 完了条件: `cd server && node --test test/overview.test.ts test/rule-files.test.ts` → 全件 pass
  - コミット: `fix(overview): read a check file's marker only from a comment line of its own language`
  - 結果: red: 直す前のコードで `--test-name-pattern="marker lines only"` → 失敗（AGENTS.md:3、biome.jsonc:2 の HTML コメント、checks.toml:2 の `//` を拾った）。直した後: `node --test test/overview.test.ts test/rule-files.test.ts` → 33 件 pass（行頭のその言語のコメントだけを拾う、checks に入れた AGENTS.md は Markdown として読む、拡張子の分からないファイルは件数を出す、NUL を含む一覧と区切りの違う一覧はカーソルを共有しない）。T09 のテストの行末コメントと JSONC の HTML コメントを、行頭のコメントに直した（意図した挙動の変更）。`bun run verify` → exit 0

- [x] T14: 拡張子が Object の継承プロパティ名（constructor）の検査ファイルで look が例外で落ちる誤りを直す
  - 種別: 修正
  - 計画: S5
  - 依存: T13（直す対象のコメントの表）
  - 変更: `server/src/overview.ts`, `server/test/overview.test.ts`, `plugin/skills/rules/SKILL.md`
  - red: `cd server && node --test --test-name-pattern="marker lines only" test/overview.test.ts` → 直す前のコードで `checks.constructor` を渡すと TypeError: openers.map is not a function
  - 完了条件: `cd server && node --test test/overview.test.ts test/rule-files.test.ts` → 全件 pass
  - コミット: `fix(overview): treat a check file's unknown extension as unknown, whatever its name`
  - 結果: red を確かめた（TypeError: openers.map is not a function）。表を Map にして `node --test test/overview.test.ts test/rule-files.test.ts` → 33 件 pass。Skill に、module の禁止は今ある深さだけを守ると書いた（T12 のレビューの F1 を見送った代わり）。`bun run verify` → exit 0

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

- [ ] T11: 不採用の差分の除去と版の同期
  - 種別: 変更
  - 計画: S6
  - 依存: T05（#220 の採否は予備測定で決まった）, T08（#257 の M1 の採否）, T10（#257 の M2 の採否）
  - 変更: `plugin/skills/rules/SKILL.md`, `server/src/overview.ts`, `server/src/rule-files.ts`, `server/src/mcp.ts`, `server/test/overview.test.ts`, `server/test/rule-files.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `git diff main -- plugin server/src server/test/overview.test.ts server/test/rule-files.test.ts .claude-plugin` → 空。`bun run release:plan -- --base <前の release のコミット>` → `none`。`bun run verify` → 0 で終わる
  - コミット: `revert(rules): drop the Biome check drafts and look checks that #257 did not adopt`

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
