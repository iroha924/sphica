---
kind: tasks
plan: 14-timeline-outside-339.plan.md
branch: fix/timeline-outside-339
base: main
---

# 質問に答えた記録を DB の行に持たせ、timeline が出す連なりの外の記録の行を、連なりの記録が答えた質問の取り下げだけにする（issue #339） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 答えた記録を DB の行に持たせる

revision 13 の DB に `unit_answer` ができ、質問を閉じる保存がそこへ書く。これまでの取り下げは移行で写る。timeline の返信はまだ変わらない。

- [x] T01: schema を revision 13 にして `unit_answer` を足し、これまでの取り下げを移行で写し、0.6.57 にする
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `db/schema.sql`, `db/migrations/0013.sql`, `server/src/sqlite.ts`, `server/src/db-types.ts`, `server/src/db-write.ts`, `server/test/fixtures/schema-rev12.sql`, `server/test/schema.test.ts`, `server/test/db.test.ts`, `server/test/migrate.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 test/migrate.test.ts test/schema.test.ts test/db.test.ts` → 全部通る（revision 12 からの移行が fresh と同じ定義になる、写しが `answered by` の取り下げだけを取り違えずに写す、trigger が断る、ingest だけが insert できる）。`bun run codegen:check` → 0。`bun run release:plan -- --base 9fec994c` → `plugin`、4 か所が 0.6.57
  - コミット: `feat(schema): keep the record that answered a question beside its withdrawal (revision 13)`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 test/migrate.test.ts test/schema.test.ts test/db.test.ts` → 135 件 pass、0 件 fail（revision 1〜12 からの移行が fresh と同じ定義、写しは 4 件を写して 5 件を注記）。`db/migrations/0013.sql` の `having count(*) = 1` を外すと、写しのテストが 1 件 fail する（戻した）。`bun run codegen:check` → matches。`caffeinate -i bun run verify` → exit 0（acceptance 140 pass。2 件が一致する場合のテストを足す前の作業ツリーで）。`bun run release:plan -- --base 9fec994c` → コミットの前は `none`（コミットどうしを比べるため）で、バージョンの行は 4 か所とも 0.6.57。コミットの後の結果は記録節に書く。review-shipping は指摘なし

- [x] T02: 質問を閉じる保存が `unit_answer` を書く
  - 種別: 追加
  - 計画: S2
  - 依存: T01（`unit_answer` の表と ingest の許可が無いと insert できない）
  - 変更: `server/src/reconcile.ts`, `server/src/record.ts`, `scripts/check-architecture.mjs`, `server/test/record.test.ts`, `server/test/extract.test.ts`, `server/test/forget.test.ts`, `server/test/architecture.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 test/record.test.ts` → 全部通る（閉じた質問と、連鎖で閉じた古い質問に `unit_answer` の行があり、閉じなかった `answers` と glean の取り下げには無く、出典を forget しても残る）。`bun run architecture` → 通り、`unit_answer` を書くのは `reconcile.ts` だけと言う
  - コミット: `feat(record): write the answering record when a save closes a question`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 test/record.test.ts test/architecture.test.ts` → 85 件 pass、0 件 fail。`server/src/reconcile.ts` と `server/src/record.ts` を stash すると、足した検査のうち 2 件が fail する。連鎖で渡す答えを保存の先頭の記録に替えると、連鎖のテストが 1 件 fail する（戻した）。`bun run architecture` → `lifecycle writers: only server/src/reconcile.ts writes unit_state, unit_replacement, and unit_answer`。`caffeinate -i bun run verify` → exit 0（acceptance 140 pass。下の 2 つのテストを足す前の作業ツリーで）。足した後に `bun run check` → exit 0、`bun run --cwd server test` → 1291 件 pass、0 件 fail

- [x] T05: `reconcile.ts` だけが書く検査が、引用符付きの表名も見つける
  - 種別: 修正
  - 計画: S2
  - 依存: T02（検査に `unit_answer` を足したのが T02）
  - 変更: `scripts/check-architecture.mjs`, `server/test/architecture.test.ts`
  - red: テストに引用符付きの表名の 3 ケースを足した後、検査を直す前に `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 test/architecture.test.ts` → `insert into "unit_answer"` を書くファイルで検査が 0 で終わり、テストが失敗する
  - 完了条件: 同じコマンド → 全部通る。`bun run architecture` → 通る
  - コミット: `fix(check): find a write to a judged table whose name is quoted`
  - 結果: red: 検査を直す前に同じコマンド → 2 件 pass、1 件 fail（`export const sql = 'insert into "unit_answer" (state_id, answer_unit) values (1, 2)';` で exit 0）。直した後 → 3 件 pass、0 件 fail。`bun run architecture` → `lifecycle writers: only server/src/reconcile.ts writes unit_state, unit_replacement, and unit_answer`。`caffeinate -i bun run verify` → exit 0（acceptance 142 pass、T03 の変更も入った作業ツリーで）。review-shipping は指摘なし

- [x] T06: `reconcile.ts` だけが書く検査が、文字列の中でエスケープした引用符の付いた表名も見つける
  - 種別: 修正
  - 計画: S2
  - 依存: T05（引用符付きの表名を見る正規表現を広げる）
  - 変更: `scripts/check-architecture.mjs`, `server/test/architecture.test.ts`
  - red: テストに `insert into \"unit_answer\"` のケースを足した後、検査を直す前に `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 test/architecture.test.ts` → そのケースで検査が 0 で終わり、テストが失敗する
  - 完了条件: 同じコマンド → 全部通る。`bun run architecture` → 通る
  - コミット: `fix(check): find a write to a judged table whose quoted name is escaped in a string`
  - 結果: red: 検査を直す前に同じコマンド → 2 件 pass、1 件 fail。直した後 → 3 件 pass、0 件 fail。`bun run architecture` → `lifecycle writers: only server/src/reconcile.ts writes unit_state, unit_replacement, and unit_answer`。`bun run check` → exit 0。review-shipping は指摘なし（直す前後の正規表現が `server/src` の 60 ファイルで同じ結果になること、以前の形が全部まだ落ちることを確かめたと返った）

## P2: timeline の返信を直す

頼んだ記録と関係の無い行が timeline から消え、連なりの記録が答えた質問の取り下げだけが残る。

- [x] T03: timeline が出す連なりの外の記録の行を、連なりの記録が答えた質問の取り下げだけにする
  - 種別: 修正
  - 計画: S3
  - 依存: T01（問い合わせが `unit_answer` を読む）, T02（保存が `unit_answer` を書かないと、実際の保存の経路のテストで取り下げの行が出ない）
  - 変更: `server/src/timeline.ts`, `server/test/timeline.test.ts`, `server/evals/acceptance/driver.ts`, `server/evals/acceptance/cases.json`, `server/test/acceptance-cases.test.ts`
  - red: テストとケースを足した後、`server/src/timeline.ts` を直す前に `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 test/timeline.test.ts` → 足したテストが、連なりの外の記録の `became superseded` の行や、連なりの記録が答えていない質問の `became withdrawn` の行が出ている、という理由で失敗する。`bun run acceptance` → `battery` の timeline に `every5` の行がある、という理由で 1 件失敗する
  - 完了条件: 同じ 2 つのコマンド → 全部通る（retrieval は 17 件）。`cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 test/acceptance-cases.test.ts` → 全部通る
  - コミット: `fix(read): tell only an answered question among changes outside a timeline's chain`
  - 結果: red: `server/src/timeline.ts` を直す前に `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 test/timeline.test.ts` → 6 件 pass、4 件 fail（上限の先の `k4 … became superseded` が出る、取り下げただけの質問 `dropped` の行が出る、`woken became active` と `replaced became superseded` が出る、新しいテストで `tabs became superseded`・答えていない質問の取り下げ・`rule-open became active` が出る）。`bun run acceptance` → 140 件 pass、2 件 fail（retrieval-16 は `read says "trace:s-en-sync-1/every5 (u"`、retrieval-17 は `read says "became active: trace:s-en-cache-where/cache-where-open no longer replaces it"`）。直した後: `test/timeline.test.ts test/acceptance-cases.test.ts` → 14 件 pass、0 件 fail。`caffeinate -i bun run verify` → exit 0（acceptance 142 pass、retrieval は 17 件）。review-shipping は指摘なし

## P3: 規範と手順を合わせる

schema の Skill が新しい表を言い、リリースの Skill が revision を上げるときの到着の順序を言う。

- [x] T04: Skill に `unit_answer` と、revision を上げるリリースの到着の順序を書く
  - 種別: 変更
  - 計画: S4
  - 依存: T02（`reconcile` が `unit_answer` を書いていないと、Skill が先に違うことを言う）
  - 変更: `.agents/skills/knowledge-schema/SKILL.md`, `.agents/skills/plugin-release/SKILL.md`
  - 完了条件: `bun run verify:ai` → 通る。`rg -n "unit_answer" .agents/skills/knowledge-schema/SKILL.md` → 表の一覧と `reconcile` の説明に出る。`rg -n "mcp-record" .agents/skills/plugin-release/SKILL.md` → 移行の前に古い記録 MCP が無いことを確かめる段がある
  - コミット: `docs(skills): name unit_answer and the order of arrival for a release that raises the revision`
  - 結果: `bun run verify:ai` → 通った（AI config: 28 invariants、リンクのエラー 0）。`bun run markdown` → 0 issues。`rg -n "unit_answer" .agents/skills/knowledge-schema/SKILL.md` → 表の一覧（66 行目）と `reconcile` の説明（74・76 行目）に出る。`rg -n "mcp-record" .agents/skills/plugin-release/SKILL.md` → 移行の前に古い記録 MCP が無いことを確かめる段（166・167 行目）がある。Skill に書いた「開いたままの古い接続は移行の後も書ける」は、fixture のコピーで確かめた（直す前のコードの ingest 接続を開く → 新しいコードで revision 13 に移行 → 同じ接続で `extraction_run` に insert できる。古いコードの新しい接続は「expects revision 12」で断られる）

## 記録

- 2026-10-14 / T01 / コミットの後に `bun run release:plan -- --base 9fec994c` → `release kind: plugin`、4 か所が 0.6.57、入力は `db/migrations/0013.sql`・`db/schema.sql`・`server/src/db-types.ts`・`server/src/db-write.ts`・`server/src/sqlite.ts` / 完了条件どおり
- 2026-10-14 / T01 / Codex のコミットのレビュー（d80d5d4b、新しい会話、high）は指摘 0 件。指定のテスト一式は流さず、メモリ上の SQLite で個別に確かめたと返った / 採否なし
- 2026-10-14 / T02 / 変更欄に `server/test/extract.test.ts`（glean の取り下げに行が無いこと）、`server/test/forget.test.ts`（出典を forget しても行が残ること）、`server/test/architecture.test.ts` を足した。前の値は `server/src/reconcile.ts`, `server/src/record.ts`, `scripts/check-architecture.mjs`, `server/test/record.test.ts` / 計画の方針 6 のテストの置き場所が 1 ファイルに収まらなかった
- 2026-10-14 / T02 / review-shipping は出荷を止める指摘なし。テストの穴を 2 つ挙げた（連鎖のテストは記録が 1 件で取り違えても通る、`reconcile.ts` だけが書く検査に違反で落ちるテストが無い） / 両方直した。連鎖のテストに答えない記録を足し、`architecture.test.ts` に違反で落ちるテストを足した
- 2026-10-14 / 全体 / 過去の記録 `trace:15ab6a31-…/record-upkeep-plan`（2026-10-11、0.6.51 の answers）は「schema と revision は変えない」と決め、「リンクの種類 answers と状態 answered を足す」を棄却している。今回の計画はその決定を覆す / 持ち主に知らせた。push と PR の作成の前に確認を取る
- 2026-10-14 / T02 / Codex のコミットのレビュー（e838b374、新しい会話、high）は 1 件: `scripts/check-architecture.mjs` の検査が、引用符付きの表名（`insert into "unit_answer"`）を見つけない。メモリ上で再現したと返った。保存と取り下げの経路には指摘なし / 採る。修正タスク T05 を T02 の後ろに足した
- 2026-10-14 / T03 / `server/test/timeline.test.ts` の既存のテスト 1 件の名前を変えた。前は「…and a change the chain's run made to a record it saved」、今は「…and tells a question the chain's run saved and answered by its withdrawal alone」（issue #339 が前の名前で引いている） / 見ているものが「run が保存した記録への変化」から「連なりの記録が答えた質問の取り下げ」に変わったため
- 2026-10-14 / T03 / review-shipping の観測: planner の統計が無い DB で連なりが 20 件あると、新しい問い合わせは project の全記録を歩く計画になる（4 万件の記録で 12 ms） / 直さない。`read` には hook の時間の上限が無く、記録の数に比例する程度のため
- 2026-10-14 / T03 / コミットの件名を短くした。前は `fix(read): tell only a question a chain record answered among changes to records outside a timeline's chain`（113 字で、commit-msg の検査の上限 100 字を超えた）、今は `fix(read): tell only an answered question among changes outside a timeline's chain` / 検査に合わせた
- 2026-10-14 / T03, T05 / Codex のコミットのレビュー（4e740e59 と 22fd1023、新しい会話）は指摘 0 件。一式のテストは流さず、メモリ上の SQLite で保存の実際の経路・移行した DB の返信・予算の件数を個別に確かめたと返った / 採否なし
- 2026-10-14 / 全体 / Codex の全差分のレビュー（deb3c4fd..ec79cac0、新しい会話、high）は P1・P2 なし、P3 が 1 件: `scripts/check-architecture.mjs` の検査が、文字列の中でエスケープした引用符（`into \"unit_answer\"`）を見つけない。再現したと返った / 採る。修正タスク T06 を足した。変数に入れた表名や実行時に組み立てた表名までは追わない（PR 本文の Declined findings に書く）
- 2026-10-14 / 全体 / plan の完了条件: A4 `git diff --stat deb3c4fd -- server/src` → 6 ファイルだけ。A5 計測 → 直す前 288 行（179 件）、直した後 1 行（u544 の timeline の u541、state 1129）、移行の注記 0 件。A6 fixture の比較 → gold の 3 件は 0 行の差、`battery`・`push`・`german-label`・`late-edits` は連なりの外の `became superseded` が 1 行ずつ消えるだけ。A7 bundle した `mcp.js` を両ホストの起動の形で呼んだ返信（1,960 字）が互いに、また `timelineRefs` の返信と一致。pack した成果物は 54 ファイル、`check-tarball.mjs` が通る / A8〜A10 は push の後
