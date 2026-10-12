---
kind: tasks
plan: 12-record-upkeep.plan.md
branch: feat/record-upkeep
base: main
---

# trace の保存 1 回で、答えの出た質問を閉じ、作業状況を複数まとめて直せるようにする のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 質問を閉じる

trace の保存の中で、答えの記録が質問を取り下げる。持ち主が glean を打たなくてよくなる。

- [x] T01: バージョンを上げ、`answers` の入力・検証と、資格のある答えによる質問の取り下げを入れる
  - 種別: 追加
  - 計画: S1, S2, S3
  - 依存: なし
  - 変更: `server/src/record.ts`, `server/src/extract.ts`, `server/test/record.test.ts`, `server/evals/acceptance/cases.json`, `server/test/acceptance-cases.test.ts`, `plugin/skills/trace/SKILL.md`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 test/record.test.ts test/extract.test.ts test/acceptance-cases.test.ts` → 持ち主の採用のある決定と根拠のある finding が開いた質問を withdrawn にし、理由が `answered by <キー>` になる。agent の採用だけの決定と candidate に留まった答えは閉じず、理由が返る。既に閉じた質問は変えずに答えを保存する。同じ保存の 2 つの答えは最初の資格のあるものが理由になる。1 つの答えで質問 2 件、`supersedes` との併用が通る。質問でない対象・別プロジェクト・`question` の unit・harvest と glean・`supersedes` と同じキーは保存を断る。断られた保存は何も残さない。check と save の返答に質問ごとの行が出て、check の予測と save の結果が同じ。足した受け入れケース（質問を閉じる）は、実装の前は `answers` が未知の欄という理由で落ちる
  - コミット: `feat(record): close a question from the record that answers it`
  - 結果: 実装の前に `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 --test-name-pattern="^answers:" test/record.test.ts` → 5 件とも `Unrecognized key: "answers"` で失敗。受け入れケース reconcile-11 も、`record.ts` と `extract.ts` を戻した状態で同じ理由の失敗を確かめた。実装の後に同じコマンド → 5 pass（持ち主の採用のある決定と finding が質問を withdrawn にし、理由が `answered by <キー>` で source が答えの発言、agent の採用だけの決定と candidate の答えは閉じずに理由が出る、既に閉じた質問は変えずに答えを保存する、同じ保存の 2 つの答えは資格のある方が理由になる、1 つの答えで質問 2 件と `supersedes` の併用、質問でない対象・別プロジェクト・`question` の unit・harvest と glean・6 件は断る、断られた保存は何も残さない、check の予測と save の結果が同じ行で出る）。`node --import ./test/isolate-home.ts --test test/acceptance-cases.test.ts` → 4 pass。`bun run verify` → exit 0（受け入れケース 134 件）。`bun run release:plan -- --base 6a4d91c6` はコミットの前なので none と出た。コミットの後に流し直す

- [x] T02: 取り下げで戻った祖先の質問も同じ答えで閉じる
  - 種別: 追加
  - 計画: S3
  - 依存: T01（`answers` の取り下げの経路と結果の行が要る）
  - 変更: `server/src/record.ts`, `server/test/record.test.ts`, `server/evals/acceptance/cases.json`, `server/test/acceptance-cases.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 test/record.test.ts test/acceptance-cases.test.ts` → 質問の鎖 2 件と 11 件が全部 withdrawn になり、祖先の理由が `answered by <キー> (through <質問のキー>)` で、答えは active のまま。12 件の鎖は保存全体が rollback する。candidate に戻った祖先も閉じる。祖先でない後継は閉じず、結果に出る。閉じた後に質問か答えに届く別の保存をしても withdrawn のまま。足した受け入れケース（質問の鎖）は、実装の前は元の質問が active に戻るという理由で落ちる
  - コミット: `feat(record): close the older questions an answered one had replaced`
  - 結果: 実装の前（T01 のコード）に `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 --test-name-pattern="^answers:" test/record.test.ts` → 足した 4 件が失敗（鎖 2 件と 11 件は古い質問が active か superseded のまま、12 件は保存が断られない、candidate に戻った祖先が閉じない）。受け入れケース reconcile-12 も `record.ts` を戻した状態で「元の質問が active」の失敗を確かめた。実装の後に同じコマンド → 9 pass（鎖 2 件と 11 件が全部 withdrawn で、祖先の理由が `answered by <キー> (through <質問のキー>)`、source は答えの発言、答えは active。12 件は保存全体が rollback し DB の中身が変わらない。candidate に戻った祖先も閉じる。祖先でない後継は active になるだけで閉じず、結果に `now active (was candidate)` と出る。結果の行は、名指しした質問、祖先、ほかに動いた記録の順で、途中で開いた瞬間は出ない）。閉じた後の別の保存で withdrawn のままなことは T01 のテストが見ている。`bun run verify` → exit 0（受け入れケース 135 件）

- [x] T07: 答えが名指しした古い質問を連鎖で閉じたとき、「既に閉じている」の行を出さない（T02 のレビューの F1）
  - 種別: 修正
  - 計画: S3
  - 依存: T02（直す対象の連鎖の処理）
  - 変更: `server/src/record.ts`, `server/test/record.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 --test-name-pattern="^answers:" test/record.test.ts` → q2 と、q2 が置き換えた q1 の両方を `answers` に書くと、q1 が withdrawn の行と `already superseded, so … closes nothing there` の行の両方に出る
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 --test-name-pattern="^answers:" test/record.test.ts` → q1 は withdrawn の行だけに出て、notes は空。check と save で同じ
  - コミット: `feat(record): take partial work updates, and say an answered older question once`
  - 結果: red を直す前のコード（a1f4a46b）で実測: `--test-name-pattern="^answers: an older question the answer also names"` → check の返答に `△ trace:ext-s1/q1: already superseded, so trace:ext-s1/store closes nothing there` と `✓ would: trace:ext-s1/q1: withdrawn, … through trace:ext-s1/q2` の両方が出て失敗。直した後に `--test-name-pattern="^answers:"` → 10 pass（q1 は withdrawn の行だけに出て、check と save で同じ）。review-shipping が、この 1 行だけを戻すと足したテストだけが落ちることを別のコピーで確かめた。`bun run verify` → exit 0

## P2: 作業状況

trace の保存 1 回で複数の作業状況を直せて、閉じるだけの更新で本文を打ち直さない。trace をする AI に既にあるキーが見える。

- [x] T03: `work` を単一か 1〜10 件の配列で受け、キーごとの結果を返す
  - 種別: 変更
  - 計画: S1, S4, S5
  - 依存: T01（バージョンが上がっていないとパッケージ入力のコミットを hook が断る。check / save の返答に行を足す所も使う）
  - 変更: `server/src/record.ts`, `server/src/extract.ts`, `server/src/glean.ts`, `server/test/record.test.ts`, `server/test/auto-pending.test.ts`, `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`, `server/test/acceptance-cases.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 test/record.test.ts test/auto-pending.test.ts test/acceptance-cases.test.ts` → 配列 2 件が両方保存される。11 件と重複キーは保存を断る。全項目を書いた単一のオブジェクトは今までどおり通る。より新しいセッションの状態があるキーは省かれ、同じ配列のほかのキーは更新され、結果に別々の行で出る。自動 run で記録の無い保存は断られる。断られた保存は unit も作業状況も残さない。足した受け入れケース（作業状況 2 件）は、実装の前は配列が型の違いという理由で落ちる
  - コミット: `feat(record): take several work items in one save and report each`
  - 結果: 実装の前に `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 --test-name-pattern="^work:" test/record.test.ts` → 4 件とも `work: Invalid input: expected object, received array` で失敗。`test/auto-pending.test.ts` の配列の行と、受け入れケース status-08（`record.ts`・`extract.ts`・`glean.ts` を戻した状態）も同じ理由の失敗を確かめた。実装の後に同じコマンド → 4 pass（配列 2 件が created、次の保存で updated と created、単一のオブジェクトも updated。11 件・空の配列・重複キーは断り、10 件は通る。重複キーで断られた保存は unit も作業状況も残さない。harvest と glean は断る。より新しいセッションの状態があるキーは省かれて notes に出て、同じ配列のほかのキーは created になる。check と save が同じ行を出す）。既にあった 2 件（古いセッションが新しい状態を上書きしない、branch を持つ）も pass。`node --import ./test/isolate-home.ts --test --test-name-pattern="updates work only beside" test/auto-pending.test.ts` → pass（配列でも、記録の無い自動 run は断られる）。`test/acceptance-cases.test.ts` → 4 pass。`bun run verify` → exit 0（受け入れケース 136 件）

- [x] T04: 既にあるキーは書いた項目だけを更新し、同じ内容の確認は `run_id` だけ進める
  - 種別: 変更
  - 計画: S4, S5
  - 依存: T03（配列に統一した保存の経路とキーごとの結果の行が要る）
  - 変更: `server/src/record.ts`, `server/src/db-write.ts`, `server/test/record.test.ts`, `server/evals/acceptance/cases.json`, `server/test/acceptance-cases.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 test/record.test.ts test/acceptance-cases.test.ts` → `{ key, status }` でほかの項目が保たれる。`next` の省略は保持、`next: []` は消去。`key` だけは何も書かず、変更なしと返る。新しいキーで `title`・`goal`・`current`・`status` のどれかが無いと保存を断る。保存済みと同じ内容を明示した更新は `run_id` だけ進み、`updated_at` と `branch` は変わらない。その後に届いた古いセッションの更新は省かれる。足した受け入れケース（部分更新）は、実装の前は項目の不足という理由で落ちる
  - コミット: `feat(record): take partial work updates, and say an answered older question once`
  - 結果: 実装の前（a1f4a46b）に `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 --test-name-pattern="^work: an item" test/record.test.ts` → 2 件とも `work.0.title: Invalid input: expected string, received undefined` などで失敗。受け入れケース status-09 も `record.ts` を戻した状態で同じ理由の失敗を確かめた。実装の後に `--test-name-pattern="^work:|^answers:|work state|session's branch"` → 18 pass（`{ key, status }` で題・goal・current・next が保たれる、`next` の省略は保持で `next: []` は消去、新しいキーは 4 項目のどれが欠けても断る、`key` だけは行を変えずに notes に出る、同じ内容の更新は `run_id` だけ進んで `updated_at` と `branch` は変わらず `confirmed, nothing changed` と出る、その後に届いた 10/5 のセッションの更新は省かれる）。T03 のテストのうち、status が欠けた項目のエラーを見ていた 2 行は、status を省けるようになったので、不正な値（`nearly`）で場所と項目が出ることを見る形に直した。`test/acceptance-cases.test.ts` → 4 pass。`bun run verify` → exit 0（受け入れケース 137 件）

- [ ] T05: trace の context に、開いた作業状況と、閉じた作業状況の直近 10 件を出す
  - 種別: 追加
  - 計画: S6
  - 依存: T04（見出しが「変える項目だけ書く」と伝えるので、部分更新が要る）
  - 変更: `server/src/extract.ts`, `server/src/trace.ts`, `server/test/extract.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 test/extract.test.ts` → trace の context の closing part に、開いた作業状況のキー・状態・題・goal・current・next・更新日と、閉じた作業状況の新しい順の 10 件（11 件目は出ない）が出る。harvest と glean の context には出ない。長い日本語の本文が入っていても各ページが 32,768 バイト以内で、ページをたどると全部のキーが欠けずに読める
  - コミット: `feat(trace): list work items in the trace context`

## P3: 文面

trace をする AI が、新しい欄の使い方と、古いサーバーに断られたときの手順を Skill から読める。

- [ ] T06: trace の Skill と、record の形を説明している記述を直す
  - 種別: 変更
  - 計画: S7
  - 依存: T02（`answers` の挙動が決まっている必要がある）, T05（context に出る作業状況の形が決まっている必要がある）
  - 変更: `plugin/skills/trace/SKILL.md`, `README.md`, `README.ja.md`, `server/src/mcp-record.ts`
  - 完了条件: `bun run verify` → 終了コード 0。`plugin/skills/trace/SKILL.md` の表に `answers` の行があり、`work` の行と例が配列と部分更新を説明し、古いサーバーに断られたときは欄を落とさず再読み込みして context を読み直すと書いてある。`rg -n "work" plugin/skills README.md README.ja.md server/src/mcp-record.ts` で拾った record の形の記述が、どれも新しい形と食い違わない
  - コミット: `docs(trace): describe answers and partial work updates`

## 記録

- 2026-10-12 / T03 / Codex のレビュー（a1f4a46b、high）: 指摘なし。コードとテストを読んだ範囲で、実行はしていないと報告があった
- 2026-10-12 / T04・T07 / 1 つのコミットにまとめた（どちらも `record.ts` と `record.test.ts` を変える）。コミット欄を直した。前: T04 `feat(record): update only the fields a work item names`、T07 `fix(record): say once what became of an older question an answer also names`。後: 両方とも `feat(record): take partial work updates, and say an answered older question once`
- 2026-10-12 / T04 / 変更欄に `server/src/db-write.ts` を足した。review-shipping が、ingest の更新の許可表の上のコメント（「The upsert of the current work」）が今の文と合わないと指摘したので直した（コードは同じ）
- 2026-10-12 / T04・T07 / review-shipping（T04 と T07 の差分）: 止める指摘は無し。ingest の接続が `saveWork` の文（select・insert・id での update）を全部許すこと、足したテストが前のコードで落ちること、`npm pack` の中身と起動を確かめたと報告があった。指摘 1 件は採らなかった: 古い Skill の文面のセッションが `next` を省いて「次は無い」のつもりで送ると、今は前の next が残る。省略は保持と計画で決めてあり、古い文面の例は `"next": []` を明示しているので、この形は変えない（PR の Declined findings に書く）

- 2026-10-12 / T02・T03 / review-shipping（aa4f0e1d と T03 の差分）: 1 件。`work` を union で受けると、項目が欠けた作業状況のエラーが `work: Invalid input` だけになり、どの項目かが出ない（再現あり）。T03 のコミットの前に直した: 1 件でも配列として読む形にし、`work.0.status` のように場所と項目が出る。直す前に落ちるテストを足して確かめた。ほかは、`npm pack` の中身（53 ファイル）と起動、4 か所のバージョン、足したテストが前のコードで落ちることを確かめたと報告があった

- 2026-10-12 / T01 / Codex のレビュー（5c0e6ac0、high）: 指摘なし。見た範囲は 12 ファイルと、検証・採用の資格・判定の後の取り下げ・rollback。`bun run verify` と tarball は read-only のため流していないと報告があった
- 2026-10-12 / T02 / Codex のレビュー（aa4f0e1d、high）: 1 件（P2、再現あり）。q2 と、q2 が置き換えた q1 の両方を `answers` に書くと、q1 が withdrawn の行と「already superseded」の行の両方に出る。完了条件の「結果は全部の繰り返しの後の状態から作る」に反するので採り、修正タスク T07 を足した
- 2026-10-12 / T02 / T02 のコミットの前に review-shipping を流していなかった（プロジェクトの決まりでは、パッケージを変えるコミットの前に流す）。T03 のコミットの前に、T02 のコミットと T03 の差分を合わせて流した
- 2026-10-12 / T03 / 変更欄と完了条件のコマンドを直した。前: `server/test/extract.test.ts` を含み、`server/src/glean.ts` と `server/test/auto-pending.test.ts` を含まない。後: 入れ替えた。理由: 自動 run の規則のテストは `auto-pending.test.ts` にあり、`glean.ts` は `Checked.work` の型の変更に合わせる 1 行が要った

- 2026-10-12 / T02 / 最初のコミット（0e6d0fd8、push 前）は、チェックを付けるスクリプトが失敗したまま作られ、`[x]` が入っていなかった。`git reset --soft` で戻し、チェックと結果を入れて作り直した。原因は 2 つ: スクリプトの失敗でコミットの連鎖が止まる形になっていなかった、Python 3.9 が長い 1 行の途中の多バイト文字を読み損ねた。以後は置き換えの文面を JSON に置き、全部を `&&` でつなぐ

- 2026-10-12 / T01・T02 / 完了条件の理由の形を変えた。前: `answered by <キー>: …`（引用の先頭つき）。後: `answered by <キー>`。理由: review-shipping の指摘（状態の履歴は forget で消えないので、引用を写すと忘れた言葉が残る）を確かめて、plan の方針を直した（plan の変更履歴）。glean の `withdraw` の理由は今も引用の先頭 200 字を写していて、同じ残り方をする。この PR の外なので持ち主に報告する
- 2026-10-12 / T01 / review-shipping の結果: 止める指摘は無し。`npm pack` の中身（53 ファイル）と起動、4 か所のバージョン、直す前のコードでの red を確かめたと報告があった。もう 1 件の指摘（trace の context の見出しが「supersedes and conflicts take these keys」のままで `answers` を挙げていない）は T05 で context を直すときに合わせる

- 2026-10-12 / T01 / 変更欄を直した。前: `server/test/extract.test.ts` と `server/evals/acceptance/driver.ts` を含み、`plugin/skills/trace/SKILL.md` を含まない。後: その 2 つを外し、Skill を足した。理由: 返答の行は `record.test.ts` の check / save のテストで確かめられ、受け入れケースは既にある expectation（`lifecycle`・`save_notes_contain`・`unit_read`）で書けた。`bun run pairs` が、保存が受ける欄を trace の Skill の表に書くことを求めるので、`answers` の行は T01 で足した（文面の残りは T06）
- 2026-10-12 / T01 / 計画の「同じ unit の `supersedes` と同じキーは断る」に専用のコードは要らなかった。質問を置き換えられるのは質問だけで、質問は `answers` を持てないので、どちらの組み合わせも既にある検査が断る。テストで確かめた
