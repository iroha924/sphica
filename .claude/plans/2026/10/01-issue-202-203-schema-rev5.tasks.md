---
kind: tasks
plan: 01-issue-202-203-schema-rev5.plan.md
branch: fix/issue-202-203-schema-rev5
base: main
---

# #202・#203: schema を revision 5 に上げ、書き込みの境界・状態遷移・index・CHECK を固める のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 移行の土台

revision 5 を開き、表を作り直す移行と、止める行・直した行を全件出す仕組みが動く。以降のタスクは schema.sql と 0005.sql を同じコミットで変える。

- [x] T01: migrate() に事前検査の手順、停止と修復の全件の出力、成功後の pragma optimize を入れる
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `server/src/admin.ts`, `server/test/admin.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/admin.test.ts` → 差し込んだ移行ディレクトリで、`<revision>.check.sql` が temp 表に行を入れると全件が例外の文に出て revision が変わらず、修復の temp 表の行は移行の後に全件出て、どちらの temp 表も残らないテストが通る
  - コミット: `feat(init): run a migration's check script first and print every row it stops on or repairs (T01)`
  - 結果: `cd server && node --test --test-timeout=60000 test/admin.test.ts` → 33 pass・0 fail（新しい 3 本: check の 3 行が例外の文に 1 行ずつ出て revision 1 のまま・バックアップは消える / 修復の 3 行が移行の後に 1 回だけ出て、check は step の前に走り、`sqlite_stat1` ができる / 前の step が commit した後の停止でも一覧と戻し方が出る）。temp 表は接続ごとなので「残らない」は、読んだ直後に drop する実装と、後の step で一覧が繰り返されないことで見た。`pragma optimize` を no-op にすると統計の assert が落ちることを確かめた。`bun run verify` → exit 0。review-shipping の指摘（optimize・commit 後の停止・check の順序をテストが見ていない）は同じコミットでテストを足した

- [x] T02: run を saved にする更新を、全部の操作の後の 1 回にまとめる
  - 種別: 変更
  - 計画: S2
  - 依存: なし
  - 変更: `server/src/record.ts`, `server/src/glean.ts`, `server/src/extract.ts`, `server/test/record.test.ts`, `server/test/extract.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/record.test.ts test/extract.test.ts` → trace・harvest・glean（新しい unit あり / 操作だけ）の保存で、`extraction_run` の更新が 1 回だけ走り saved になるテストが通る
  - コミット: `refactor(record): mark a run saved once, after every write of the save (T02)`
  - 結果: `cd server && node --test --test-timeout=60000 test/record.test.ts test/extract.test.ts` → 47 pass・0 fail。run の更新をトリガーで数え、trace・harvest（2 本）・glean（操作だけ / 新しい unit あり）がどれも 1 回で saved になる。直す前のコードでは glean が 2 回で落ちることを確かめた。`bun run verify` → exit 0。review-shipping: 出荷されるコードに `saveText` を通らない呼び出しは無い。harvest をテストが見ていないという指摘は同じコミットで足した

- [x] T03: revision 5 を開く（全表を作り直す 0005.sql、sqlite_sequence の保持、rev4 の fixture、origin の migration）
  - 種別: 変更
  - 計画: S3, S4, S10
  - 依存: T01（移行が成功した後の出力と optimize の手順が要る）
  - 変更: `db/schema.sql`, `db/migrations/0005.sql`, `server/src/sqlite.ts`, `server/src/knowledge.ts`, `server/src/trace.ts`, `scripts/check-pairs.mjs`, `server/test/fixtures/schema-rev4.sql`, `server/test/migrate.test.ts`, `server/test/schema.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/migrate.test.ts` → 実際の `admin.migrate()` で、移行した rev1〜rev4 の DB が新規の DB と同じ定義になり、最大 id の行を消した rev4 の DB で全 autoincrement 表の次の id が旧値 + 1 になるテストが通る。`bun run verify` → 0
  - コミット: `feat(db): open schema revision 5 with a migration that rebuilds tables and keeps id counters (T03)`
  - 結果: `cd server && node --test --test-timeout=60000 test/migrate.test.ts` → 16 pass・0 fail（実際の `admin.migrate()` で、rev1〜rev4 が新規の DB と同じ定義 / rev4 の全 autoincrement 表のカウンターが移行の前後で同じで、次の run の id が 9 / 全表の全列が移行の前後で同じ）。列を入れ替えた 0005.sql では全列の比較が落ちることを確かめた。`bun run verify` → exit 0。`bun run bundle && cd plugin && node ../scripts/check-tarball.mjs "$(npm pack --silent)"` → 配布物の CLI が rev4 の DB をバックアップして移行。review-shipping: 持ち主の DB の写し（895 source・118 unit）と 111 MB の合成 DB の移行で行・カウンター・FTS に差分なし。作り直した表の列の中身をテストが見ていないという指摘は同じコミットで足した

- [x] T20: 止めた行・直した行の一覧を、行数に比例する時間で組み立てる
  - 種別: 修正
  - 計画: S1
  - 依存: T01（直す対象の一覧の組み立てが要る）
  - 変更: `server/src/admin.ts`, `server/test/admin.test.ts`
  - red: `cd server && node --test --test-timeout=60000 --test-name-pattern="many rows" test/admin.test.ts` → 同じ規則の 10 万行を止める移行で、一覧の組み立てに数秒かかり、時間の上限の assert で落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/admin.test.ts` → 10 万行でも全件が出て、上限の時間内に終わるテストが通る
  - コミット: `fix(init): build the list of stopped rows in linear time (T20)`
  - 結果: `cd server && node --test --test-timeout=60000 --test-name-pattern="many rows" test/admin.test.ts` → 直す前は took 7658 ms で落ちた（red）。直した後 `node --test test/admin.test.ts` → 34 pass・0 fail（10 万行の全件が出て約 120 ms）。`bun run verify` → exit 0。review-shipping: 指摘なし（一覧の出力は前と同じ。12 コアに 24 の負荷をかけても 400 ms）

## P2: 書き込みの境界と状態遷移（#202）

unit の状態が遷移表の外へ動かず、後継は 1 つで、支えの規則が 1 つになる。reader の書き込みは型エラーになる。

- [x] T04: unit の残りの列を凍結し、revision は 1 ずつしか上がらないようにする
  - 種別: 修正
  - 計画: S3, S4
  - 依存: T03（revision 5 の schema と移行が要る）
  - 変更: `db/schema.sql`, `db/migrations/0005.sql`, `server/test/schema.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/schema.test.ts` → active な unit の `no_code_surface`・`created_at`・`revision` と、candidate の `extraction`・`unsourced` の更新が通ってしまい落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/migrate.test.ts` → それらの更新が拒まれ、移行した DB が新規と同じ定義のテストが通る
  - コミット: `fix(db): freeze the remaining unit columns and let revision rise only by one (T04)`
  - 結果: `cd server && node --test --test-timeout=60000 test/schema.test.ts` → 直す前の schema では新しいテストが Missing expected exception で落ちた（red）。直した後 `node --test test/schema.test.ts test/migrate.test.ts` → 全件 pass（schema 24・migrate 17）。`bun run verify` → exit 0

- [x] T05: 状態の遷移表を入れ、合わない現在の状態を移行で candidate に戻す
  - 種別: 修正
  - 計画: S3, S4
  - 依存: T03（origin の migration の run と、修復の一覧の仕組みが要る）
  - 変更: `db/schema.sql`, `db/migrations/0005.sql`, `server/src/cli.ts`, `server/src/glean.ts`, `plugin/skills/glean/SKILL.md`, `server/test/schema.test.ts`, `server/test/migrate.test.ts`, `server/test/admin.test.ts`, `server/test/extract.test.ts`, `server/test/forget.test.ts`, `server/test/search.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/schema.test.ts` → active→active、superseded→active、withdrawn→active、最初の行が withdrawn から、null→active、後継が active でない superseded が通ってしまい落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/migrate.test.ts test/record.test.ts test/forget.test.ts` → 遷移表の外が拒まれ、active な後継の無い superseded の unit を入れた rev4 の DB の移行で、その unit が candidate になり、lifecycle が最後の state と一致し、revision が 1 増え、一覧に出るテストが通る
  - コミット: `fix(db): allow only the listed lifecycle transitions (T05)`
  - 結果: `cd server && node --test --test-timeout=60000 --test-name-pattern="listed transitions" test/schema.test.ts` → 直す前の schema では落ちた（red）。直した後 `node --test test/schema.test.ts test/migrate.test.ts test/admin.test.ts test/extract.test.ts test/record.test.ts test/forget.test.ts` → 全件 pass。移行のテストは、後継が withdrawn の superseded の unit が candidate に戻り、最後の state が migration の run で、revision が 1 増え、一覧に出ることを見る（後継が candidate の unit は superseded のまま）。`bun run verify` → exit 0。review-shipping: 修復の条件を変えると移行のテストが落ちることを確認済み。指摘 1 件（superseded への withdraw）は同じコミットで直した

- [ ] T06: withdrawn でない後継を 1 つまでにし、kind の組を限り、後継が withdrawn になったら元の unit を candidate に戻す
  - 種別: 修正
  - 計画: S3, S4, S6
  - 依存: T05（superseded→candidate の遷移が要る）
  - 変更: `db/schema.sql`, `db/migrations/0005.sql`, `server/src/record.ts`, `server/src/glean.ts`, `server/test/schema.test.ts`, `server/test/migrate.test.ts`, `server/test/record.test.ts`, `server/test/extract.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/schema.test.ts` → 後継が withdrawn でない unit に 2 つ目の後継、finding が decision を supersede する link が通り、唯一の後継を withdraw しても元の unit が superseded のままで落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/migrate.test.ts test/record.test.ts test/extract.test.ts` → それらが拒まれ、後継を withdraw した後は元の unit に新しい後継を付けられ（withdrawn の後継の link は残る）、glean の withdraw で元の unit が支えが揃っていれば active に戻り、withdrawn でない後継が 2 つある rev4 の DB の移行で決めた 1 つが残って一覧に出るテストが通る
  - コミット: `fix(db): keep one successor per unit and bring the old unit back when it is withdrawn (T06)`

- [x] T07: 支えの規則を 1 つのビューにし、retract と anchor の retire でも同じ規則で拒む
  - 種別: 修正
  - 計画: S3, S4, S6
  - 依存: T05（支えの足りない active な unit を candidate に戻す移行の修復が、遷移表と migration の run を使う）
  - 変更: `db/schema.sql`, `db/migrations/0005.sql`, `server/src/glean.ts`, `server/src/db-types.ts`, `server/test/schema.test.ts`, `server/test/migrate.test.ts`, `server/test/extract.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/schema.test.ts` → option の証拠だけが残る active な unit の、最後の unit 単位の証拠の retract が通ってしまい落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/migrate.test.ts test/extract.test.ts test/record.test.ts test/forget.test.ts` → その retract と、active な implementation の最後のコードの anchor の retire が拒まれ、glean の replace_anchor は同じ組への置き換えをエラーにして別の組へは通り、支えの足りない active な unit を入れた rev4 の DB の移行で candidate に戻って一覧に出るテストが通る
  - コミット: `fix(db): judge support with one rule when activating, retracting, and retiring an anchor (T07)`
  - 結果: `cd server && node --test --test-timeout=60000 --test-name-pattern="judged by one rule" test/schema.test.ts` → 直す前の schema では Missing expected exception で落ちた（red）。直した後 `node --test test/*.test.ts` → 512 pass・0 fail（schema: option の証拠だけが残る decision の最後の証拠の retract と、active な implementation の commit 付き anchor の retire が拒まれる / migrate: 支えの足りない active な unit が candidate に戻って一覧に出る / extract: 同じ場所への replace_anchor はエラー、別の場所へは通って candidate に戻る）。`bun run verify` → exit 0

- [ ] T08: reader の型を ReadonlyKysely にする
  - 種別: 変更
  - 計画: S7
  - 依存: なし
  - 変更: `server/src/db.ts`, `server/src/mcp.ts`, `server/src/deliver.ts`, `server/src/search.ts`, `server/src/read.ts`, `server/src/status.ts`, `server/src/overview.ts`, `server/src/project.ts`, `server/src/cli/common.ts`, `server/test/db.test.ts`
  - 完了条件: `bun run verify` → 0（型の検査を含む）。`server/test/db.test.ts` の `// @ts-expect-error` を付けた reader への insert が型エラーのままで、外すと型の検査が落ちる
  - コミット: `refactor(db): type the reader connection as read-only (T08)`

- [x] T21: T04・T05 の Codex の指摘を直す（candidate の後継がいる unit の withdraw を通す、migration の run を id カウンターの復元の後に作る）
  - 種別: 修正
  - 計画: S4, S6
  - 依存: T05（直す対象の withdraw の検査と移行の修復が要る）
  - 変更: `server/src/glean.ts`, `db/migrations/0005.sql`, `server/test/extract.test.ts`, `server/test/migrate.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/extract.test.ts test/migrate.test.ts` → 採用の無い後継を足しながら元の unit を withdraw する glean の保存が check のエラーで落ち、run を消した rev4 の DB の移行で migration の run が消した id を使い直して落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/extract.test.ts test/migrate.test.ts` → その保存で元の unit が withdrawn・後継が candidate になり、同じ保存で後継が active になって元が superseded になったときは withdraw を「しなかった」と返し、migration の run の id が旧カウンター + 1 になるテストが通る
  - コミット: `fix(glean): let a record be withdrawn beside a candidate successor, and keep run ids unused (T21)`
  - 結果: `cd server && node --test --test-timeout=60000 --test-name-pattern="withdrawn beside a successor|whose successor is withdrawn" test/extract.test.ts test/migrate.test.ts` → 直す前は 2 本とも落ちた（red: check の「The record is not valid」/ migration の run の id が 9 でなく 2）。直した後 `node --test test/extract.test.ts test/migrate.test.ts` → 42 pass・0 fail。`bun run verify` → exit 0。review-shipping（1 回目は API の 529 で結果なし、投げ直し）: 指摘なし。save 側の分岐だけを戻すとテストの後半が落ちることを確認

## P3: index・FK・一意キー・CHECK・値の整理（#203）

名前を挙げた lookup が index を使い、重複と規則に合わない値が入らず、使われていない値と表が消える。

- [ ] T09: FK の列に index を足し、規則をテストで守り、item の lookup に session_id is null を足す
  - 種別: 修正
  - 計画: S3, S4, S6, S8
  - 依存: T03（revision 5 の schema と移行が要る）
  - 変更: `db/schema.sql`, `db/migrations/0005.sql`, `server/src/github.ts`, `server/src/glean.ts`, `server/test/schema.test.ts`, `server/test/github.test.ts`, `server/test/deliver.test.ts`, `server/test/search.test.ts`, `server/test/forget.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/schema.test.ts` → FK の列（の組）を先頭に持つ index が無い表が一覧になって落ちる（`unit_link.to_unit`、`delivery_unit.unit_id` など）
  - 完了条件: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/github.test.ts test/deliver.test.ts test/search.test.ts test/forget.test.ts test/migrate.test.ts` → FK の index の規則のテストが通り、delivery の conflicts・後継の lookup・item の lookup・forget が触る列のクエリプランに index 名が出るテストが通る
  - コミット: `fix(db): index every foreign key and the item lookups (T09)`

- [ ] T10: FK の動作を揃え、引用のある session の直接削除を拒む
  - 種別: 修正
  - 計画: S3, S4, S6
  - 依存: T03（revision 5 の schema と移行が要る）
  - 変更: `db/schema.sql`, `db/migrations/0005.sql`, `server/src/forget.ts`, `server/test/schema.test.ts`, `server/test/forget.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/schema.test.ts` → 発言を証拠に引用された session の owner 接続での削除が通り、支えの無い active な unit が残って落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/forget.test.ts test/migrate.test.ts` → project の削除で全部消えて `foreign_key_check` が空、引用の無い session は消え、引用のある session は拒まれ、forget は先回りの delete なしで前と同じ結果になるテストが通る
  - コミット: `fix(db): make foreign key actions consistent and refuse deleting a cited session (T10)`

- [ ] T11: run を凍結する（running の行だけ status と finished_at を変えられる）
  - 種別: 修正
  - 計画: S3, S4
  - 依存: T02（同じ run を 2 回 saved にする更新が残っていると glean の保存が落ちる）, T10（session の削除のテストが、run の session_id を null にする FK の動作を通す）
  - 変更: `db/schema.sql`, `db/migrations/0005.sql`, `server/test/schema.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/schema.test.ts` → saved の run を running に戻す更新と、run の target の更新が通ってしまい落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/extract.test.ts test/migrate.test.ts` → それらが拒まれ、running と saved の run を持つ引用の無い session の削除と、trace・harvest・glean の保存が通るテストが通る
  - コミット: `fix(db): freeze an extraction run once it is saved (T11)`

- [ ] T12: 編集の観測と生きている anchor に一意キーを足し、同じ内容の記録を doctor に出す
  - 種別: 修正
  - 計画: S3, S4, S9
  - 依存: T07（replace_anchor が同じ組への置き換えを拒むようになっていないと、一意キーと衝突する）
  - 変更: `db/schema.sql`, `db/migrations/0005.sql`, `server/src/admin.ts`, `server/src/cli.ts`, `server/test/schema.test.ts`, `server/test/capture.test.ts`, `server/test/migrate.test.ts`, `server/test/cli.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/schema.test.ts` → turn_id が null の同じ capture_edit の insert 2 回で 2 行になり、同じ場所の生きている anchor が 2 つ入って落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/capture.test.ts test/migrate.test.ts test/cli.test.ts` → どちらも 1 行に収まり、重複を入れた rev4 の DB の移行で決めた行が残って一覧に出て、`sphica doctor` が同じ内容の生きている記録の組の数を出すテストが通る
  - コミット: `fix(db): keep edit observations and live anchors unique, and report duplicates in doctor (T12)`

- [ ] T13: path の CHECK を 3 つの表で同じ式にする
  - 種別: 修正
  - 計画: S3, S4, S6, S9
  - 依存: T03（止める行の検査 0005.check.sql を置く revision 5 の移行が要る）
  - 変更: `db/schema.sql`, `db/migrations/0005.sql`, `db/migrations/0005.check.sql`, `server/src/github.ts`, `scripts/check-pairs.mjs`, `server/test/schema.test.ts`, `server/test/github.test.ts`, `server/test/migrate.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/schema.test.ts` → `a//b`・`./a`・制御文字を含む path が `edit_observation` と `unit_anchor` に入ってしまい落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/github.test.ts test/migrate.test.ts && bun run pairs` → 3 つの表が同じ path を拒み、制御文字を含む path の review comment は path なしで保存され、合わない path の行を入れた rev4 の DB の移行が決めたとおり（観測と anchor は外す、review_comment は path を null、file_excerpt は止まる）になり、3 つの式が違うと pairs が落ちる
  - コミット: `fix(db): check paths with one rule in sources, edit observations, and anchors (T13)`

- [ ] T14: 細かい CHECK を足す
  - 種別: 修正
  - 計画: S3, S4
  - 依存: T03（revision 5 の schema と移行が要る）
  - 変更: `db/schema.sql`, `db/migrations/0005.sql`, `server/test/schema.test.ts`, `server/test/migrate.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/schema.test.ts` → `line_start` の無い `line_end`、負の retraction の span、`added_at` より前の `retracted_at`、文字を切る span、unit の作成より前の state、開始より前の終了、自分を指す `replaced_by`、`javascript:` の url、`indexed = 1` の assistant の source、hash の違う alias が入ってしまい落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/migrate.test.ts` → それぞれが拒まれ、それぞれの行を入れた rev4 の DB の移行が plan の方針 2 のとおりに直して一覧に出すテストが通る
  - コミット: `fix(db): add the small checks on lines, spans, times, anchors, urls, and aliases (T14)`

- [ ] T15: どのリリースも書かない値と external_reference の表を消し、該当行があれば移行を止める
  - 種別: 削除
  - 計画: S3, S4, S6, S9
  - 依存: T13（0005.check.sql が要る）, T10（forget.ts の delete を揃えた後の形が要る）
  - 変更: `db/schema.sql`, `db/migrations/0005.sql`, `db/migrations/0005.check.sql`, `server/src/knowledge.ts`, `server/src/forget.ts`, `server/src/db-write.ts`, `server/src/db-types.ts`, `scripts/check-pairs.mjs`, `server/test/schema.test.ts`, `server/test/migrate.test.ts`, `server/test/forget.test.ts`, `server/test/db.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/migrate.test.ts test/forget.test.ts test/db.test.ts && bun run pairs` → 消した値が拒まれ、その値の行か `external_reference` の行を入れた rev4 の DB の移行が全件を例外の文に出して revision 4 のまま全表の行が変わらないテストが通る。`rg -n "external_reference" db/schema.sql server/src --glob '!db-types.ts'` → 該当なし
  - コミット: `refactor(db): remove values and the table no release ever wrote (T15)`

## P4: ingest の allow list

記録サーバーの接続が、保存に必要な書き込み以外をできない。

- [ ] T16: ingest の source の insert をビュー経由にする
  - 種別: 変更
  - 計画: S3, S4, S5
  - 依存: T09（item の lookup に session_id is null が入っていて、insert の後の id の引き直しが同じ index を使う）
  - 変更: `db/schema.sql`, `db/migrations/0005.sql`, `server/src/github.ts`, `server/src/glean.ts`, `server/src/db-types.ts`, `server/test/schema.test.ts`, `server/test/github.test.ts`, `server/test/extract.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/github.test.ts test/extract.test.ts test/migrate.test.ts` → `ingest_source` への insert が source の行を作って id が引け、kind が session_message の insert は拒まれ、harvest と glean の excerpt の保存が通るテストが通る
  - コミット: `refactor(db): write external sources through a view that cannot take session messages (T16)`

- [ ] T17: ingest の authorizer を allow list にし、トリガーとの対応表を検査する
  - 種別: 修正
  - 計画: S5
  - 依存: T16（source への直接 insert を拒むには、ビュー経由の経路が要る）, T11（run の更新が 1 回で、列が status と finished_at だけ）, T15（対応表に載せる表とトリガーが確定している）, T12（同）, T07（同）, T06（同）
  - 変更: `server/src/db-write.ts`, `server/test/db.test.ts`, `server/test/plugin.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/db.test.ts` → ingest 接続で、FTS の `delete-all` と偽の行、`sphica_generation` の削除、project の key と session の更新、delivery・work・edit_observation・source_processing・extraction_run の削除、source への直接 insert、unit の revision の直接更新が通ってしまい落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/db.test.ts test/plugin.test.ts test/extract.test.ts test/cli.test.ts && bun run verify` → それらが拒まれ、trace・harvest・glean（新しい unit あり / 操作だけ）の保存と init の登録が ingest 接続で通り、全トリガーの本文が書く表が対応表にあるテストが通る。verify が 0
  - コミット: `fix(db): let the ingest connection write only what the record server needs (T17)`

## P5: 通しの検査と出荷

記録の入った rev4 の DB が移行の後もそのまま使え、配布物が rev4 の DB を移行できる。

- [ ] T18: 記録の入った rev4 の DB を移行し、同じ DB で修復・id・検索・保存・capture を続けて確かめる
  - 種別: 追加
  - 計画: S4
  - 依存: T17（移行した DB への ingest の保存が、allow list の下で通ることを見る）, T14（修復の規則が全部入っている）
  - 変更: `server/test/migrate.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/migrate.test.ts` → 規則を破る行・消した最大 id・検索できる unit を含む rev4 の DB を実際の `admin.migrate()` で移行し、修復の件数と全件、全 autoincrement 表の次の id、検索の結果、ingest での trace と glean の保存、capture の書き込みが 1 つのテストで通る
  - コミット: `test(db): migrate a populated revision 4 database and keep using it (T18)`

- [ ] T19: Skill を直し、配布物の検査を rev4 に向ける
  - 種別: 変更
  - 計画: S9, S10
  - 依存: T18（出荷する移行が通しで確かめられている）
  - 変更: `.claude/skills/knowledge-schema/SKILL.md`, `scripts/check-tarball.mjs`
  - 完了条件: `bun run release:plan -- --base v0.6.14` → `plugin` で、4 か所のバージョンが一致する。`bun run bundle && cd plugin && node ../scripts/check-tarball.mjs "$(npm pack --silent)"` → deliver が rev4 の DB にバージョン入りの案内を返し、init が `Backed up:` と `Migrated: … (revision 4 → 5)` を出す。`bun run verify` → 0
  - コミット: `docs(skill): describe schema revision 5 and check the tarball against revision 4 (T19)`

## 記録

- 2026-10-01 / T01・T19 / pre-commit の bundle の検査が、パッケージの入力を変える最初のコミットでバージョンが上がっていないと落とす（#201 の T01 と同じ） / バージョンを 0.6.15 に上げるのを T19 から T01 へ移した。T01 の変更欄: `server/src/admin.ts`, `server/test/admin.test.ts` → それに 4 つの manifest を足した。T19 の題名: 「Skill を直し、バージョンを上げ、配布物の検査を rev4 に向ける」→「Skill を直し、配布物の検査を rev4 に向ける」、変更欄から `package.json` と 4 つの manifest を外し、コミット件名を docs(skill) に変えた。完了条件の release:plan の確認は T19 に残す
- 2026-10-01 / T03 / `db-types.ts` は codegen しても変わらず（origin は文字列の列）、`check-tarball.mjs` は fixture の一番新しい revision を自動で使うので変更が要らなかった。origin の型を `trace.ts` で使い、`schema.test.ts` の revision の期待値を 5 にした / 変更欄: `server/src/db-types.ts`・`scripts/check-tarball.mjs` を外し、`server/src/trace.ts`・`server/test/schema.test.ts` を足した
- 2026-10-01 / T01 / Codex のレビュー（04e02b9）: 指摘 1 件（P2）。同じ規則の行を足すたびに配列を全件コピーするので一覧の組み立てが二乗時間になり、10 万行で 7.7 秒、その間は書き込みロックを持ったまま / 採用。修正タスク T20 を足した
- 2026-10-01 / T02 / Codex のレビュー（4873c4c）: 指摘 0 件（テストは read-only のため Codex 側では未実行） / そのまま
- 2026-10-01 / T03 / review-shipping が、配布物の検査（`check-tarball.mjs`）は中身の無い rev4 の DB で「Backed up」「Migrated」の行だけを見ていると指摘 / T19 で、記録の入った DB を配布物の CLI で移行する形にできるかを見る
- 2026-10-01 / T03・T06・T12・T19 / commit-msg の検査は件名を 100 文字までに限る / コミット件名の欄を短くした（T03: every table → tables、T06: its successor is withdrawn → it is withdrawn、T12: duplicate records → duplicates、T19: in the schema skill を削った）
- 2026-10-01 / T05 / 変更欄に `server/src/cli.ts`（doctor の「last extraction」が migration の run を数えない）と、そのテストの `server/test/admin.test.ts`、新しい規則に合わせて準備を直した `server/test/forget.test.ts`（最初の state を withdrawn にしていた）と `server/test/search.test.ts`（unit の created_at を後から書き換えていた。T04 の凍結に当たる）を足した
- 2026-10-01 / T05 / 移行で candidate に戻す superseded の unit は「withdrawn でない後継が 1 つも無いもの」にした。plan の方針 2 は「active な後継の無い superseded」だが、後継が active から candidate に戻っただけの状態は遷移表の中で起こり、その unit は superseded のままが正しい / 遷移表（superseded→candidate は後継が全部 withdrawn のときだけ）と同じ条件に揃えた。範囲は変わらない
- 2026-10-01 / T04・T05 / コミット前の出荷レビューを 1 回で済ませるため、2 つを 1 コミットにまとめる（件名の末尾は (T04, T05)）
- 2026-10-01 / T05 / review-shipping が再現: superseded の unit への glean の withdraw は 0.6.14 では通ったが、遷移表の下では保存全体が読めないエラーで落ちる / 遷移表（合意済み）は変えず、`checkGlean` が withdraw の対象が superseded のとき（と、同じ保存の中で supersede されるとき）に名前入りのエラーを返すようにした。glean の Skill の表に 1 文足した。変更欄に `server/src/glean.ts`・`plugin/skills/glean/SKILL.md`・`server/test/extract.test.ts` を足した
- 2026-10-01 / T03 / Codex のレビュー（dd892aa0）: 指摘 0 件。行を入れていない表は空のまま前後を比べている、という未検証の点は T18 で全表に行を入れて埋める
- 2026-10-01 / T06 / 実装の前に、plan の unique index だと取り下げた後継が枠を塞ぐことに気づいた / Codex と新しい会話で相談して「withdrawn でない後継は 1 つまで」のトリガーに合意。plan の方針 5・2 を直し、status を draft に戻して持ち主の Go を待つ。T06 の題名・red・完了条件を合わせた（前の値: 題名「後継を 1 つにし、…」、red「1 つの unit に 2 つ目の後継、…」、完了条件は「後継を withdraw した後は…」の句が無い）。T06 に依存する T17 は Go まで着手しない
- 2026-10-01 / T04・T05 / Codex のレビュー（3a1aee15）: 指摘 2 件（どちらも P2、再現済み）。F1: 同じ保存で supersede される unit への withdraw を check で拒むのは、後継が candidate に留まる場合に有効な取り下げを落とす（0.6.14 では通る）。F2: migration の run を id カウンターの復元より前に作るので、消した run の id を使い直す / 2 件とも採用。修正タスク T21 を足した
- 2026-10-01 / T07 / review-shipping（1 回目は API の 529 で結果なし、投げ直し）: 指摘なし。5 つの変異（古い retract トリガー、retire のトリガー無し、修復の insert 無し、同じ場所の検査無し、retire の前に戻さない）がそれぞれ新しいテストを落とすことを確認
