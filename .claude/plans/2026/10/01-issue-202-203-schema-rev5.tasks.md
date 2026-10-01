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

- [x] T06: withdrawn でない後継を 1 つまでにし、kind の組を限り、後継が withdrawn になったら元の unit を candidate に戻す
  - 種別: 修正
  - 計画: S3, S4, S6
  - 依存: T05（superseded→candidate の遷移が要る）
  - 変更: `.claude/plans/2026/10/01-issue-202-203-schema-rev5.plan.md`, `db/schema.sql`, `db/migrations/0005.sql`, `server/src/record.ts`, `server/src/glean.ts`, `server/test/schema.test.ts`, `server/test/migrate.test.ts`, `server/test/extract.test.ts`, `server/test/search.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/schema.test.ts` → 後継が withdrawn でない unit に 2 つ目の後継、finding が decision を supersede する link が通り、唯一の後継を withdraw しても元の unit が superseded のままで落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/migrate.test.ts test/record.test.ts test/extract.test.ts` → それらが拒まれ、後継を withdraw した後は元の unit に新しい後継を付けられ（withdrawn の後継の link は残る）、glean の withdraw で元の unit が支えが揃っていれば active に戻り、withdrawn でない後継が 2 つある rev4 の DB の移行で決めた 1 つが残って一覧に出るテストが通る
  - コミット: `fix(db): keep one successor per unit and bring the old unit back when it is withdrawn (T06)`
  - 結果: `cd server && node --test --test-timeout=60000 --test-name-pattern="one live successor|brings back the record|keeps one live successor" test/schema.test.ts test/extract.test.ts test/migrate.test.ts` → 直す前のコードでは 3 本とも落ちた（red）。直した後 `node --test test/schema.test.ts test/migrate.test.ts test/extract.test.ts test/search.test.ts` → 全件 pass（種類の合わない supersede と 2 つ目の生きた後継は拒まれ、後継を取り下げると元の記録が candidate に戻って同じ保存で active になり、その後は新しい後継を付けられる。取り下げた後継の link は残る。移行は生きた後継を 1 つ残し、種類の合わない link を外して一覧に出す）。`bun run verify` → exit 0

- [x] T07: 支えの規則を 1 つのビューにし、retract と anchor の retire でも同じ規則で拒む
  - 種別: 修正
  - 計画: S3, S4, S6
  - 依存: T05（支えの足りない active な unit を candidate に戻す移行の修復が、遷移表と migration の run を使う）
  - 変更: `db/schema.sql`, `db/migrations/0005.sql`, `server/src/glean.ts`, `server/src/db-types.ts`, `server/test/schema.test.ts`, `server/test/migrate.test.ts`, `server/test/extract.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/schema.test.ts` → option の証拠だけが残る active な unit の、最後の unit 単位の証拠の retract が通ってしまい落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/migrate.test.ts test/extract.test.ts test/record.test.ts test/forget.test.ts` → その retract と、active な implementation の最後のコードの anchor の retire が拒まれ、glean の replace_anchor は同じ組への置き換えをエラーにして別の組へは通り、支えの足りない active な unit を入れた rev4 の DB の移行で candidate に戻って一覧に出るテストが通る
  - コミット: `fix(db): judge support with one rule when activating, retracting, and retiring an anchor (T07)`
  - 結果: `cd server && node --test --test-timeout=60000 --test-name-pattern="judged by one rule" test/schema.test.ts` → 直す前の schema では Missing expected exception で落ちた（red）。直した後 `node --test test/*.test.ts` → 512 pass・0 fail（schema: option の証拠だけが残る decision の最後の証拠の retract と、active な implementation の commit 付き anchor の retire が拒まれる / migrate: 支えの足りない active な unit が candidate に戻って一覧に出る / extract: 同じ場所への replace_anchor はエラー、別の場所へは通って candidate に戻る）。`bun run verify` → exit 0

- [x] T08: reader の型を ReadonlyKysely にする
  - 種別: 変更
  - 計画: S7
  - 依存: なし
  - 変更: `server/src/db.ts`, `server/src/cli/common.ts`, `server/src/deliver.ts`, `server/src/search.ts`, `server/src/read.ts`, `server/src/status.ts`, `server/src/overview.ts`, `server/src/project.ts`, `server/src/asked.ts`, `server/src/export.ts`, `server/src/fields.ts`, `server/src/review.ts`, `server/src/trace.ts`, `server/src/extract.ts`, `server/src/github.ts`, `server/src/glean.ts`, `server/src/record.ts`, `server/evals/acceptance/driver.ts`, `server/test/temp-db.ts`, `server/test/db.test.ts`
  - 完了条件: `bun run verify` → 0（型の検査を含む）。`server/test/db.test.ts` の `// @ts-expect-error` を付けた reader への insert が型エラーのままで、外すと型の検査が落ちる
  - コミット: `refactor(db): type the reader connection as read-only (T08)`
  - 結果: `bun run verify` → exit 0（型検査を含む）。`server/test/db.test.ts` の reader への insert は `@ts-expect-error` のまま型検査が通り、`openReader()` を `Kysely<DB>` に戻すと「Unused @ts-expect-error」で型検査が落ちることを確かめた。実行時も reader の接続が書き込みを拒む

- [x] T21: T04・T05 の Codex の指摘を直す（candidate の後継がいる unit の withdraw を通す、migration の run を id カウンターの復元の後に作る）
  - 種別: 修正
  - 計画: S4, S6
  - 依存: T05（直す対象の withdraw の検査と移行の修復が要る）
  - 変更: `server/src/glean.ts`, `db/migrations/0005.sql`, `server/test/extract.test.ts`, `server/test/migrate.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/extract.test.ts test/migrate.test.ts` → 採用の無い後継を足しながら元の unit を withdraw する glean の保存が check のエラーで落ち、run を消した rev4 の DB の移行で migration の run が消した id を使い直して落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/extract.test.ts test/migrate.test.ts` → その保存で元の unit が withdrawn・後継が candidate になり、同じ保存で後継が active になって元が superseded になったときは withdraw を「しなかった」と返し、migration の run の id が旧カウンター + 1 になるテストが通る
  - コミット: `fix(glean): let a record be withdrawn beside a candidate successor, and keep run ids unused (T21)`
  - 結果: `cd server && node --test --test-timeout=60000 --test-name-pattern="withdrawn beside a successor|whose successor is withdrawn" test/extract.test.ts test/migrate.test.ts` → 直す前は 2 本とも落ちた（red: check の「The record is not valid」/ migration の run の id が 9 でなく 2）。直した後 `node --test test/extract.test.ts test/migrate.test.ts` → 42 pass・0 fail。`bun run verify` → exit 0。review-shipping（1 回目は API の 529 で結果なし、投げ直し）: 指摘なし。save 側の分岐だけを戻すとテストの後半が落ちることを確認

- [x] T22: 隔離された後継と出典の無い後継を、生きた後継に数えない
  - 種別: 修正
  - 計画: S3, S4, S6
  - 依存: T06（直す対象の後継の規則が要る）
  - 変更: `db/schema.sql`, `db/migrations/0005.sql`, `server/src/record.ts`, `server/test/schema.test.ts`, `server/test/extract.test.ts`, `server/test/migrate.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/extract.test.ts` → 隔離された後継が付いた unit に、支えのある新しい後継を付けようとすると拒まれて落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/extract.test.ts test/migrate.test.ts` → 隔離された後継・出典の無い後継がいても新しい後継を付けられ、その後継が active になると元の unit が superseded になるテストが通る
  - コミット: `fix(db): let quarantined and unsourced successors hold no place (T22)`
  - 結果: `cd server && node --test --test-timeout=60000 --test-name-pattern="one live successor at a time|brings back the record|keeps one live successor" test/schema.test.ts test/extract.test.ts test/migrate.test.ts` → 直す前のコードでは 3 本とも落ちた（red）。直した後 schema・extract・migrate のテストは 75 pass・0 fail（隔離された後継・出典の無い後継がいても新しい後継を付けられ、active になると元が superseded になる。生きた後継を取り下げると元は candidate に戻る。移行は隔離された後継しか無い superseded の unit を candidate に戻す）。`bun run verify` → exit 0

## P3: index・FK・一意キー・CHECK・値の整理（#203）

名前を挙げた lookup が index を使い、重複と規則に合わない値が入らず、使われていない値と表が消える。

- [x] T09: FK の列に index を足し、規則をテストで守り、item の lookup に session_id is null を足す
  - 種別: 修正
  - 計画: S3, S4, S6, S8
  - 依存: T03（revision 5 の schema と移行が要る）
  - 変更: `db/schema.sql`, `db/migrations/0005.sql`, `server/src/github.ts`, `server/src/glean.ts`, `server/test/temp-db.ts`, `server/test/schema.test.ts`, `server/test/github.test.ts`, `server/test/extract.test.ts`, `server/test/deliver.test.ts`, `server/test/search.test.ts`, `server/test/forget.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/schema.test.ts` → FK の列（の組）を先頭に持つ index が無い表が一覧になって落ちる（`unit_link.to_unit`、`delivery_unit.unit_id` など）
  - 完了条件: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/github.test.ts test/deliver.test.ts test/search.test.ts test/forget.test.ts test/migrate.test.ts` → FK の index の規則のテストが通り、delivery の conflicts・後継の lookup・item の lookup・forget が触る列のクエリプランに index 名が出るテストが通る
  - コミット: `fix(db): index every foreign key and the item lookups (T09)`
  - 結果: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/github.test.ts test/deliver.test.ts test/search.test.ts test/forget.test.ts test/extract.test.ts` → 直す前の schema と lookup では 16 本が落ちた（red: FK の index の規則、item の lookup、delivery の conflicts、検索と読み取りの後継、forget）。直した後は同じ 6 ファイルと migrate.test.ts で 130 pass・0 fail。`bun run verify` → exit 0

- [x] T10: FK の動作を揃え、引用のある session の直接削除を拒む
  - 種別: 修正
  - 計画: S3, S4, S6
  - 依存: T03（revision 5 の schema と移行が要る）
  - 変更: `db/schema.sql`, `db/migrations/0005.sql`, `server/src/forget.ts`, `server/src/db-write.ts`, `server/test/schema.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/schema.test.ts` → 発言を証拠に引用された session の owner 接続での削除が通り、支えの無い active な unit が残って落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/forget.test.ts test/migrate.test.ts` → project の削除で全部消えて `foreign_key_check` が空、引用の無い session は消え、引用のある session は拒まれ、forget は先回りの delete なしで前と同じ結果になるテストが通る
  - コミット: `fix(db): make foreign key actions consistent and refuse deleting a cited session (T10)`
  - 結果: `cd server && node --test --test-timeout=60000 test/schema.test.ts` → 直す前の schema では、retraction の理由の source を消すテストと session の削除のテストが落ちた（red）。直した後 schema・forget・migrate・extract・record・admin のテストは全件 pass（理由の source と一緒に取り下げ済みの行が消え、forget の結果は前と同じ。引用の無い session は消え、6 つの経路のどれかで引用された session は拒まれ、project の削除は全部消えて foreign_key_check が空）。`bun run verify` → exit 0

- [x] T11: run を凍結する（running の行だけ status と finished_at を変えられる）
  - 種別: 修正
  - 計画: S3, S4
  - 依存: T02（同じ run を 2 回 saved にする更新が残っていると glean の保存が落ちる）, T10（session の削除のテストが、run の session_id を null にする FK の動作を通す）
  - 変更: `db/schema.sql`, `db/migrations/0005.sql`, `server/test/schema.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/schema.test.ts` → saved の run を running に戻す更新と、run の target の更新が通ってしまい落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/extract.test.ts test/migrate.test.ts` → それらが拒まれ、running と saved の run を持つ引用の無い session の削除と、trace・harvest・glean の保存が通るテストが通る
  - コミット: `fix(db): freeze an extraction run once it is saved (T11)`
  - 結果: `cd server && node --test --test-timeout=60000 --test-name-pattern="changes once" test/schema.test.ts` → 直す前の schema では落ちた（red）。直した後 schema.test.ts は全件 pass（saved の run を running に戻す・終了時刻や target を変える・session_id を消すのは拒まれ、running から saved は通る。session の削除で session_id が null になるのは通る）。`bun run verify` → exit 0

- [x] T12: 編集の観測と生きている anchor に一意キーを足し、同じ内容の記録を doctor に出す
  - 種別: 修正
  - 計画: S3, S4, S9
  - 依存: T07（replace_anchor が同じ組への置き換えを拒むようになっていないと、一意キーと衝突する）
  - 変更: `db/schema.sql`, `db/migrations/0005.sql`, `server/src/cli.ts`, `server/src/record.ts`, `server/src/glean.ts`, `server/test/schema.test.ts`, `server/test/migrate.test.ts`, `server/test/admin.test.ts`, `server/test/record.test.ts`, `server/test/extract.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/schema.test.ts` → turn_id が null の同じ capture_edit の insert 2 回で 2 行になり、同じ場所の生きている anchor が 2 つ入って落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/capture.test.ts test/migrate.test.ts test/cli.test.ts` → どちらも 1 行に収まり、重複を入れた rev4 の DB の移行で決めた行が残って一覧に出て、`sphica doctor` が同じ内容の生きている記録の組の数を出すテストが通る
  - コミット: `fix(db): keep edit observations and live anchors unique, and report duplicates in doctor (T12)`
  - 結果: `cd server && node --test --test-timeout=60000 --test-name-pattern="observed once per turn|repeated edit observations|hold the same words|given twice in a record" test/schema.test.ts test/migrate.test.ts test/admin.test.ts test/record.test.ts` → 直す前のコードでは 4 本とも落ちた（red）。直した後 schema・migrate・admin・record・capture のテストは 143 pass・0 fail（turn の無い観測も 1 行、同じ場所の生きた anchor は 1 つ、記録の中の同じ anchor は 1 つにまとめる、移行は重複を片付けて一覧に出す、doctor が同じ文面の生きた記録の組を数える）。glean の [anchor P, P からの replace_anchor] の保存は、順序の直しを戻すと UNIQUE で落ちることを確かめた。`bun run verify` → exit 0

- [x] T23: T12・T22 の Codex の指摘を直す（anchor の移動の連鎖、移行の重複の片付けの時間、同じ保存の隔離された後継）
  - 種別: 修正
  - 計画: S4, S6
  - 依存: T12（直す対象の一意キーと移行の片付けが要る）, T22（直す対象の生きた後継の条件が要る）
  - 変更: `db/schema.sql`, `db/migrations/0005.sql`, `server/src/glean.ts`, `server/src/record.ts`, `server/test/extract.test.ts`, `server/test/migrate.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/extract.test.ts test/migrate.test.ts` → [p→q, q→r] の replace_anchor の保存が生の UNIQUE エラーで落ち、同じ保存で隔離される後継の隣の正常な後継が拒まれ、重複の無い 5000 unit・20000 anchor の rev4 の DB の移行に 22 秒かかって落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/extract.test.ts test/migrate.test.ts` → 連鎖は順序が逆なら名前入りのエラー、正しい順なら保存でき、隔離される後継の隣の正常な後継が active になり、その移行が 10 秒以内に終わるテストが通る
  - コミット: `fix(glean): order chained anchor moves, share a save with quarantined successors, dedupe fast (T23)`
  - 結果: `cd server && node --test --test-timeout=60000 test/extract.test.ts test/migrate.test.ts` → 直す前のコードでは 3 本が落ちた（red: 連鎖の保存が UNIQUE、隔離される後継の隣の正常な後継が拒まれる、移行に 22 秒）。直した後は全件 pass（連鎖は逆順なら名前入りのエラー・正しい順なら保存、正常な後継を先・隔離される後継を後に並べても正常な方が active、移行は 0.65 秒）。トリガーの新しい条件を消すとテストが落ちることを確かめた。`bun run verify` → exit 0

- [x] T13: path の CHECK を 3 つの表で同じ式にする
  - 種別: 修正
  - 計画: S3, S4, S6, S9
  - 依存: T03（止める行の検査 0005.check.sql を置く revision 5 の移行が要る）
  - 変更: `db/schema.sql`, `db/migrations/0005.sql`, `db/migrations/0005.check.sql`, `server/src/github.ts`, `server/src/project.ts`, `server/src/worktree.ts`, `scripts/check-pairs.mjs`, `server/test/schema.test.ts`, `server/test/github.test.ts`, `server/test/migrate.test.ts`, `server/test/project.test.ts`, `server/test/capture.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/schema.test.ts` → `a//b`・`./a`・制御文字を含む path が `edit_observation` と `unit_anchor` に入ってしまい落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/github.test.ts test/migrate.test.ts && bun run pairs` → 3 つの表が同じ path を拒み、制御文字を含む path の review comment は path なしで保存され、合わない path の行を入れた rev4 の DB の移行が決めたとおり（観測と anchor は外す、review_comment は path を null、file_excerpt は止まる）になり、3 つの式が違うと pairs が落ちる
  - コミット: `fix(db): check paths with one rule in sources, edit observations, and anchors (T13)`
  - 結果: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/migrate.test.ts test/github.test.ts` → 直す前のコードでは新しいテスト 4 本が落ちた（red）。直した後 schema・migrate・github・project・capture のテストは全件 pass（3 つの表が同じ path を拒む、制御文字の path の review comment は path と行なしで保存、capture は制御文字の名前のファイルを記録しない、移行は観測と anchor を外して一覧に出し、file_excerpt なら何も変えずに止まる）。3 つの式の 1 つを変えると `bun run pairs` が落ちることを確かめた。`bun run verify` → exit 0

- [x] T14: 細かい CHECK を足す
  - 種別: 修正
  - 計画: S3, S4
  - 依存: T03（revision 5 の schema と移行が要る）
  - 変更: `db/schema.sql`, `db/migrations/0005.sql`, `server/src/github.ts`, `server/test/schema.test.ts`, `server/test/migrate.test.ts`, `server/test/overview.test.ts`, `server/test/record.test.ts`, `server/test/search.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/schema.test.ts` → `line_start` の無い `line_end`、負の retraction の span、`added_at` より前の `retracted_at`、文字を切る span、unit の作成より前の state、開始より前の終了、自分を指す `replaced_by`、`javascript:` の url、`indexed = 1` の assistant の source、hash の違う alias が入ってしまい落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/migrate.test.ts` → それぞれが拒まれ、それぞれの行を入れた rev4 の DB の移行が plan の方針 2 のとおりに直して一覧に出すテストが通る
  - コミット: `fix(db): add the small checks on lines, spans, times, anchors, urls, and aliases (T14)`
  - 結果: `cd server && node --test --test-timeout=60000 --test-name-pattern="the small checks|small values" test/schema.test.ts test/migrate.test.ts` → 直す前のコードでは 2 本とも落ちた（red）。直した後は pass（開始行の無い終了行、負の取り下げの span、追加より前の取り下げ、文字の途中の span、作成より前の state、開始より前の終了、自分や別の記録の anchor への置き換え、javascript: の URL、索引に入るアシスタントの返答、文面の違う alias がそれぞれ拒まれ、移行はそれぞれを一番近い許される値に直して一覧に出す）。`bun run verify` → exit 0

- [x] T24: T14 の Codex の指摘を直す（広げた採用の重複で移行が止まる、終端が 0 以下の取り下げの span、証拠の重複の片付けの時間、置き換え先と取り下げの span を insert でも検査する）
  - 種別: 修正
  - 計画: S3, S4
  - 依存: T14（直す対象の CHECK と移行の修復が要る）
  - 変更: `db/schema.sql`, `db/migrations/0005.sql`, `db/migrations/0005.check.sql`, `server/test/schema.test.ts`, `server/test/migrate.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/migrate.test.ts` → 文字の途中の採用が 2 つ同じ範囲に広がる rev4 の DB の移行が一意制約で落ち、負の取り下げの span が値の修復で CHECK に当たり、置き換え先が別の記録の anchor・取り下げの span が文字の途中の行を insert で入れられ、証拠 2 万行の移行が 7 秒かかる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/migrate.test.ts` → 広げた採用は 1 つ残って一覧に出て、負の取り下げの span は移行を止めて一覧に出し、insert でも拒まれ、証拠 2 万行の移行が 3 秒以内に終わるテストが通る
  - コミット: `fix(db): widen spans before moving rows, stop on negative retraction spans, check inserts too (T24)`
  - 結果: `cd server && node --test --test-timeout=60000 --test-name-pattern="the small checks|small values|no release wrote" test/schema.test.ts test/migrate.test.ts` → 直す前のコードでは 3 本が落ちた（red）。証拠 2 万行の移行は直す前 6.9 秒・直した後 0.3 秒（上限 3 秒）。直した後 schema・migrate のテストは全件 pass。`bun run verify` → exit 0

- [x] T25: 取り下げ済みの証拠と採用の行の insert を拒む
  - 種別: 修正
  - 計画: S3
  - 依存: T24（置き換える insert 時の取り下げ span の検査が要る）
  - 変更: `db/schema.sql`, `db/migrations/0005.sql`, `server/test/schema.test.ts`
  - red: `cd server && node --test --test-timeout=60000 --test-name-pattern="the small checks" test/schema.test.ts` → 別の project の発言や本文の外を理由に引用した取り下げ済みの行が insert で入って落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/migrate.test.ts` → 取り下げ済みの証拠と採用の insert がどれも拒まれ、移行（表の作り直しはトリガーの前に行を写す）が通るテストが通る
  - コミット: `fix(db): refuse writing evidence or adoption already retracted (T25)`
  - 結果: `cd server && node --test --test-timeout=60000 --test-name-pattern="the small checks" test/schema.test.ts` → 直す前の schema では、別の project の発言を理由に引用した取り下げ済みの行が insert で入って落ちた（red）。直した後 schema・migrate のテストは全件 pass（取り下げ済みの証拠と採用の insert はどれも拒まれ、移行は通る）。`bun run verify` → exit 0

- [x] T26: REPLACE をコードに書けなくする
  - 種別: 修正
  - 計画: S5
  - 依存: T17（REPLACE がすり抜ける allow list）
  - 変更: `scripts/check-sql.mjs`, `server/src/db-write.ts`, `lefthook.yml`
  - red: `server/src` の 1 ファイルに `.orReplace()`・`.orReplace ()`・改行をまたぐ `INSERT OR REPLACE` を、`db/schema.sql` に `unique on conflict replace` を足して `bun run sql` → 直す前の検査は exit 0
  - 完了条件: 同じものを足して `bun run sql` がどれも挙げて exit 1、外すと exit 0。`bun run verify` → exit 0
  - コミット: `fix(db): keep REPLACE out of the code, since its delete bypasses the ingest limits (T26)`
  - 結果: 足すと `bun run sql` がどれも挙げて exit 1、外すと exit 0。直す前の検査はこの規則を持たず exit 0（red）

- [x] T27: GitHub の Codex レビュー 1 回目の指摘を直す
  - 種別: 修正
  - 計画: S3, S6, S9
  - 依存: T26
  - 変更: `server/src/record.ts`, `db/schema.sql`, `db/migrations/0005.sql`, `db/migrations/0005.check.sql`, `.agents/skills/knowledge-schema/SKILL.md`, `server/test/record.test.ts`, `server/test/schema.test.ts`, `server/test/migrate.test.ts`
  - red: `cd server && node --test --test-timeout=60000 --test-name-pattern="path|finishes at its start" test/schema.test.ts test/migrate.test.ts test/record.test.ts` → 開始が時計より後の run を saved にすると CHECK で落ち、C1 の制御文字（U+0080〜U+009F）を含む path が source・edit_observation に入り、移行でも外れない
  - 完了条件: 同じコマンドが通る。`rg -n --hidden "external_reference" .agents .claude/skills plugin` → 該当なし。`bun run verify` → exit 0
  - コミット: `fix(db): finish runs no earlier than they began, refuse C1 controls in paths (T27)`
  - 結果: 直す前は 3 本落ちた（red: finished_at の CHECK、C1 の path が insert で通る、移行で外れる anchor が 1 行のまま）。直した後は schema・migrate・record・extract・db のテストが全件 pass

- [x] T15: どのリリースも書かない値と external_reference の表を消し、該当行があれば移行を止める
  - 種別: 削除
  - 計画: S3, S4, S6, S9
  - 依存: T13（0005.check.sql が要る）, T10（forget.ts の delete を揃えた後の形が要る）
  - 変更: `db/schema.sql`, `db/migrations/0005.sql`, `db/migrations/0005.check.sql`, `server/src/forget.ts`, `server/src/db-write.ts`, `server/src/read.ts`, `server/src/db-types.ts`, `server/test/schema.test.ts`, `server/test/migrate.test.ts`, `server/test/forget.test.ts`, `server/test/search.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/migrate.test.ts test/forget.test.ts test/db.test.ts && bun run pairs` → 消した値が拒まれ、その値の行か `external_reference` の行を入れた rev4 の DB の移行が全件を例外の文に出して revision 4 のまま全表の行が変わらないテストが通る。`rg -n "external_reference" db/schema.sql server/src --glob '!db-types.ts'` → 該当なし
  - コミット: `refactor(db): remove values and the table no release ever wrote (T15)`
  - 結果: `cd server && node --test --test-timeout=60000 --test-name-pattern="no release wrote" test/schema.test.ts test/migrate.test.ts` → 直す前の schema では 2 本とも落ちた（red）。直した後は pass（消した値が拒まれ、external_reference と run の reason 列が無い。rev4 の DB にその値の行があると、5 種類とも全件を例外の文に出して revision 4 のまま全表の行が変わらない）。`bun run verify` → exit 0。`rg -n "external_reference" db/schema.sql server/src --glob "!db-types.ts"` → 該当なし

## P4: ingest の allow list

記録サーバーの接続が、保存に必要な書き込み以外をできない。

- [x] T16: ingest の source の insert をビュー経由にする
  - 種別: 変更
  - 計画: S3, S4, S5
  - 依存: T09（item の lookup に session_id is null が入っていて、insert の後の id の引き直しが同じ index を使う）
  - 変更: `db/schema.sql`, `db/migrations/0005.sql`, `server/src/github.ts`, `server/src/glean.ts`, `server/src/db-types.ts`, `server/test/schema.test.ts`, `server/test/github.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/github.test.ts test/extract.test.ts test/migrate.test.ts` → `ingest_source` への insert が source の行を作って id が引け、kind が session_message の insert は拒まれ、harvest と glean の excerpt の保存が通るテストが通る
  - コミット: `refactor(db): write external sources through a view that cannot take session messages (T16)`
  - 結果: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/github.test.ts test/extract.test.ts test/migrate.test.ts` → 全件 pass（`ingest_source` への insert が session_id の無い source を作って id が引け、session_message と session_id を渡す insert は拒まれ、harvest と glean の抜粋の保存が通る）。`bun run verify` → exit 0

- [x] T17: ingest の authorizer を allow list にし、トリガーとの対応表を検査する
  - 種別: 修正
  - 計画: S5
  - 依存: T16（source への直接 insert を拒むには、ビュー経由の経路が要る）, T11（run の更新が 1 回で、列が status と finished_at だけ）, T15（対応表に載せる表とトリガーが確定している）, T12（同）, T07（同）, T06（同）
  - 変更: `server/src/db-write.ts`, `server/test/db.test.ts`, `server/test/extract.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/db.test.ts` → ingest 接続で、FTS の `delete-all` と偽の行、`sphica_generation` の削除、project の key と session の更新、delivery・work・edit_observation・source_processing・extraction_run の削除、source への直接 insert、unit の revision の直接更新が通ってしまい落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/db.test.ts test/plugin.test.ts test/extract.test.ts test/cli.test.ts && bun run verify` → それらが拒まれ、trace・harvest・glean（新しい unit あり / 操作だけ）の保存と init の登録が ingest 接続で通り、全トリガーの本文が書く表が対応表にあるテストが通る。verify が 0
  - コミット: `fix(db): let the ingest connection write only what the record server needs (T17)`
  - 結果: `cd server && node --test --test-timeout=60000 test/db.test.ts` → 直す前の authorizer では、issue の書き込みの一覧の最初（全文索引の delete-all）から通ってしまい落ちた（red）。直した後は全件 pass（一覧の書き込みはどれも not authorized、saved の run を running に戻すのは schema の凍結が拒む、全トリガーの本文の書き込みが一覧と同じ。一覧から 1 つ消すと落ちる）。trace・harvest・glean の保存と init の登録は extract・github・record・cli のテストで通った。`bun run verify` → exit 0

## P5: 通しの検査と出荷

記録の入った rev4 の DB が移行の後もそのまま使え、配布物が rev4 の DB を移行できる。

- [x] T18: 記録の入った rev4 の DB を移行し、同じ DB で修復・id・検索・保存・capture を続けて確かめる
  - 種別: 追加
  - 計画: S4
  - 依存: T17（移行した DB への ingest の保存が、allow list の下で通ることを見る）, T14（修復の規則が全部入っている）
  - 変更: `server/test/migrate.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/migrate.test.ts` → 規則を破る行・消した最大 id・検索できる unit を含む rev4 の DB を実際の `admin.migrate()` で移行し、修復の件数と全件、全 autoincrement 表の次の id、検索の結果、ingest での trace と glean の保存、capture の書き込みが 1 つのテストで通る
  - コミット: `test(db): migrate a populated revision 4 database and keep using it (T18)`
  - 結果: `cd server && node --test --test-timeout=60000 --test-name-pattern="populated revision 4" test/migrate.test.ts` → pass（external_reference を除く全表に行があり、全カウンターが最大 id より上の rev4 の DB を実際の `admin.migrate()` で移行。修復は 1 件で、増えたのは migration の run と state の 1 行ずつだけ、カウンターは下がらず migration の run は旧カウンター + 1、検索は field の値・alias・source を見つけ、ingest の接続で trace の保存と glean の取り下げが通り、capture の書き込みが索引に入る）。`bun run verify` → exit 0。テストだけの追加なので review-shipping は流していない（対象はパッケージに入る変更）

- [x] T19: Skill を直し、配布物の検査を rev4 に向ける
  - 種別: 変更
  - 計画: S9, S10
  - 依存: T18（出荷する移行が通しで確かめられている）
  - 変更: `.agents/skills/knowledge-schema/SKILL.md`, `scripts/check-tarball.mjs`
  - 完了条件: `bun run release:plan -- --base v0.6.14` → `plugin` で、4 か所のバージョンが一致する。`bun run bundle && cd plugin && node ../scripts/check-tarball.mjs "$(npm pack --silent)"` → deliver が rev4 の DB にバージョン入りの案内を返し、init が `Backed up:` と `Migrated: … (revision 4 → 5)` を出す。`bun run verify` → 0
  - コミット: `docs(skill): describe schema revision 5 and check the tarball against revision 4 (T19)`
  - 結果: `bun run release:plan -- --base v0.6.14` → plugin、4 か所とも 0.6.15。`bun run bundle && cd plugin && node ../scripts/check-tarball.mjs "$(npm pack --silent)"` → 43 files、配布物の CLI が記録の入った rev4 の DB をバックアップして移行し、発言が残って revision 5 になる。`bun run verify` → exit 0

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
- 2026-10-01 / T21 / Codex の個別レビューは投げない。Codex 自身の指摘の直しで、review-shipping が再現で確かめた。最後の全差分レビューで見る
- 2026-10-01 / T07 / Codex のレビュー（155a08ae）: 指摘 0 件。unit_support が revision 4 の 3 つの規則と同じ判定であることを確かめた
- 2026-10-01 / T09 / 変更欄に `server/test/temp-db.ts`（実際のコードが流す SQL を記録する `statements()` と、クエリプランを出す `plan()`）と `server/test/extract.test.ts`（glean の抜粋の lookup）を足した
- 2026-10-01 / T09 / `bun run verify` が 1 回、テストが 1 本 900 秒以上かかって落ち、acceptance の 1 件が本物の `gh` に届いた。単独でも、流し直しても通った（2 分） / 再現しないので手を入れない。実行中のスリープを疑うが未確認
- 2026-10-01 / T09 / review-shipping（1 回目は 10 分無応答で打ち切り、投げ直し）: 指摘 2 件（forget のプランの検査が preview だけで apply を見ていない、関数の説明が 2 つ並んでいる） / 同じコミットで直した
- 2026-10-01 / T06 / 「withdrawn でない後継は 1 つまで」への plan の変更に、持ち主が Go。plan を approved に戻した（コミットは T06 と一緒）
- 2026-10-01 / T06 / 変更欄: `server/test/record.test.ts` を外し（名前入りの check のエラーは extract.test.ts の glean の保存で見た）、Go を受けた plan と、後継を 2 つ並べる前提だった検索のテスト `server/test/search.test.ts` を足した
- 2026-10-01 / T06 / review-shipping: 指摘なし。同じ glean の保存で「A の candidate の後継 B を取り下げ」かつ「新しい記録で A を置き換え」は、名前入りのエラーで 2 回の保存に分けることになる（check は保存の前の状態で見る）。使い勝手の制限で壊れてはいないので直さない
- 2026-10-01 / T10 / 変更欄から `server/test/forget.test.ts` を外した（forget の既存のテストが、先回りの delete を消した後も同じ結果で通ることで足りた）。retraction の行の削除を「理由の source が forget の墓石にある」から「理由の source が無くなった」に変えたので、それを見ていた schema.test.ts のテストを cascade の形に書き直した
- 2026-10-01 / T10・T11 / 出荷レビューを 1 回で済ませるため 1 コミットにまとめる（件名の末尾は (T10, T11)）
- 2026-10-01 / T10・T11 / review-shipping: 指摘 3 件（forget.ts と db-write.ts のコメントが墓石の順序を理由に挙げたまま、session の削除のテストが 6 つの引用の経路のうち 1 つしか見ていない） / 同じコミットで直した。T10 の変更欄に `server/src/db-write.ts` を足した。経路を 1 つずつ消すとテストが落ちることを確かめた
- 2026-10-01 / T12 / 変更欄を実態に合わせた（前: admin.ts・capture.test.ts・cli.test.ts を含む。後: record.ts（同じ anchor を 2 回書いた記録を 1 つにまとめる）・glean.ts・record.test.ts・admin.test.ts・extract.test.ts を足し、変えていない 3 つを外した）。生きた anchor の一意キーは、symbol があれば symbol、無ければ行で場所を分ける（record.ts が symbol の無い anchor を行で分けて保存するため）
- 2026-10-01 / T12 / review-shipping: 指摘 2 件。1: glean の「anchor P」と「P から Q への replace_anchor」を同じ保存で並べると、check は通るのに生の UNIQUE エラーで落ちる（再現） / glean の保存で replace_anchor を先に流すようにし、テストでその保存を通した。2: check と保存の間にファイルが変わって symbol が伏せ字の対象になると、保存時に symbol が消えて一意キーがぶつかりうる / ファイルが保存の最中に変わるときだけの端の入力なので直さない
- 2026-10-01 / T09 / Codex のレビュー（744b4e06）: 指摘 2 件（どちらもテストの穴）。F1: forget のプランの検査が external_reference の全走査を見逃す / external_reference は T15 で表ごと消すので直さない。F2: トリガーの中の検索は `statements()` に現れない / 仕組みの限界。FK の子の検索は FK の index の規則のテストが守る。T13 で `statements()` のコメントに 1 行書く
- 2026-10-01 / T06 / Codex のレビュー（94416206）: 指摘 1 件（P1、再現済み）。引用が見つからず隔離された後継（と出典の無い後継）は active になれず取り下げもできないのに、生きた後継として枠を塞ぎ、元の unit を二度と置き換えられない / 採用。修正タスク T22 を足した
- 2026-10-01 / T22 / review-shipping: 指摘 2 件（どちらもテストの穴）。復帰の条件と移行の修復の条件を元に戻してもテストが通った / 生きた後継を取り下げたら、隔離された後継が残っていても元の unit が candidate に戻るテストと、隔離された後継しか無い superseded の unit を移行が candidate に戻すテストを足した。条件を戻すと 2 本とも落ちることを確かめた
- 2026-10-01 / T13 / 変更欄に `server/src/project.ts`・`server/src/worktree.ts`（capture が制御文字を含む path を記録する前に落とす）とそのテスト（project.test.ts・capture.test.ts）を足した。review comment の path を落としたときは行も落とす（path の無い行に意味は無い。移行の修復と同じ）
- 2026-10-01 / T13 / review-shipping: 指摘 4 件。worktree の制御文字の検査にテストが無い / テストを足した。worktree と 0005.sql のコメントが実態と違う（replaced_by を消した anchor が一覧に出ない、起きない場合を書いている） / 直して一覧にも出すようにした。リポジトリ直下の `c:notes.md` のような名前を DB が拒み capture 側は通す / 前の revision から同じ規則で、この変更で入ったものではないので直さない
- 2026-10-01 / T12・T22 / Codex のレビュー（fc5b7e7d..26cc50df）: 指摘 3 件（P2、再現済み）。F1: 互いの移動元を使う replace_anchor の連鎖が check を通って生の UNIQUE エラーになる。F2: 移行の anchor の重複の片付けが相関サブクエリで二乗の時間（32,000 件で 8.6 秒）。F3: 同じ保存で隔離される後継も枠を取り、隣の正常な後継を拒む / 3 件とも採用。修正タスク T23 を足した。出典の無い後継（glean が保存の後で決める）が同じ保存で枠を取る件は、check の時点では分からないので残す（2 回の保存に分ければ通る）
- 2026-10-01 / T23 / 完了条件の移行の時間の上限を 4 秒から 10 秒に変えた（前: 4 秒、後: 10 秒） / review-shipping が CI の遅いマシンでの余裕の薄さを指摘。二乗の版は 22 秒なので 10 秒でも捕まる
- 2026-10-01 / T23 / review-shipping: 指摘 4 件。トリガーの新しい条件が、隔離された後継を先に保存するテストでは通らない / 正常な後継を先にしたテストに変え、条件を消すと落ちることを確かめた。時間の上限 / 上の行。置き換えの連鎖が輪（p→q と q→p）だとどちらの順でも「前に置け」と言う、自分の場所への置き換えで 2 つ目の誤ったエラーが出る / 案内に「2 回の保存に分ける」を足し、自分の場所の場合は 2 つ目を出さない。出典の無い後継は check の時点で枠を取る / 前からある、厳しい側の差なので残す（上の T12・T22 の記録と同じ）
- 2026-10-01 / T13・T23 / Codex のレビュー（6d91e358..8fc246d1）: 指摘 0 件
- 2026-10-01 / T14 / 変更欄に `server/src/github.ts`（http(s) でない URL は保存しない）と、新しい規則に当たった準備を直した overview・record・search のテストを足した（固定の古い時刻で state や取り下げを書いていた、索引に入ったアシスタントの返答をわざと作っていた）
- 2026-10-01 / T14 / review-shipping: 指摘 1 件（再現済み）。文字の途中で切れた引用を広げて重複になったとき、取り下げ済みの行を残して生きている行を消していた / 生きている行を先に残すようにし、テストを足した
- 2026-10-01 / T15 / 前提の裏取り: v0.5.0〜v0.6.14 の各タグで `git grep` し、pr_event の closed・reopened・thread_resolved、run と処理結果の failed・capped、run の reason、implements の link、external_reference への insert を書くコードが無いことを確かめた（review-shipping も 23 タグで独立に確認）。run の reason 列も消した。変更欄: `knowledge.ts`・`check-pairs.mjs`・`db.test.ts` は変わらず（これらの値は突き合わせの対象外）、`read.ts`（Implemented by の行）・`search.test.ts` を足した
- 2026-10-01 / T15 / review-shipping: 指摘 3 件（schema のコメントとトリガーの文面、forget のテストの題名に、消した値の説明が残っていた） / 同じコミットで直した
- 2026-10-01 / T14 / Codex のレビュー（de0d92dd）: 指摘 5 件（P2、再現済み）。F1: 文字の途中の採用を広げると、重複を片付ける前に表の一意制約で移行が止まる。F2: 終端が 0 以下の取り下げの span は、開始だけを 0 にすると CHECK で止まる。F3: 証拠の重複の片付けが二乗の時間（2 万行で 6.7 秒）。F4・F5: 置き換え先と取り下げの span の検査が update にしか無く、insert で素通りする / 全部採用。修正タスク T24 を足した。負の取り下げの span は値で直さず、移行を止める側に移した（どのリリースも書かない値で、直す先の値が決まらない）
- 2026-10-01 / T24 / review-shipping: 指摘 2 件（採用の insert の取り下げ span の検査にテストが無い、置き換え先が自分自身かの節が隣の節と重なって要らない） / テストを足し（検査を消すと落ちることを確かめた）、要らない節を消した。広げる処理は 40 通りのランダムな DB で古い規則と同じ結果になることを、レビュー担当が確かめた
- 2026-10-01 / T16・T17 / 出荷レビューを 1 回で済ませるため 1 コミットにまとめる。変更欄: T16 から extract.test.ts を外し（glean の抜粋の保存は既存のテストで通った）、T17 は plugin.test.ts を外して extract.test.ts を足した（run の更新をテスト用のトリガーで数えていたのを、allow list がそのトリガーの書き込みを拒むので、流した SQL を数える形にした）
- 2026-10-01 / T16・T17 / review-shipping（1 回目は 10 分無応答で打ち切り、投げ直し）: 実際の ingest の書き込みを全部記録し、どれも allow list の中だと確かめた。指摘 2 件（トリガーの本文の読み取りが upsert・`update or`・引用符付きの名前を見落とす、harvest の lookup の数の検査が緩い） / 読み取れない書き方を見たら落ちるようにし、数を 2 倍ちょうどに固定した
- 2026-10-01 / T15・T24 / Codex のレビュー（14774d8e..ff1b273c）: 指摘 1 件（P2、以前からある穴、再現済み）。取り下げ済みの行を insert すると、理由が同じ project の持ち主の発言の中かを見ない（update でしか見ていない） / 採用。修正タスク T25 で、取り下げ済みの行の insert そのものを拒む
- 2026-10-01 / T08 / 読み取りの関数の引数を `ReadonlyKysely<DB>` にすると、書き込み用の `Kysely<DB>` がそこへ代入できず（kysely の型で、書き込みのメソッドの戻り値が合わない）、記録サーバーの呼び出し口が 100 か所以上型エラーになった / 読み取りの関数は `Reads = Pick<ReadonlyKysely<DB>, "selectFrom" | "fn" | "dynamic">` を取るようにした（どちらの接続も渡せ、関数の中から書けない）。`openReader()` は plan どおり `ReadonlyKysely<DB>` を返す。変更欄を実態に合わせた（前: mcp.ts を含む 10 ファイル。後: 読み取りの関数を持つモジュールと acceptance の driver・temp-db.ts。mcp.ts は変わらず）
- 2026-10-01 / T08・T25 / 出荷レビューを 1 回で済ませるため 1 コミットにまとめる。review-shipping は 10 分無応答で打ち切られた（3 度目）。頼んだ検査のうち、`openReader()` を `Kysely<DB>` に戻すと `@ts-expect-error` が未使用になって型検査が落ちること、server/src に取り下げ済みの行を insert する所が無いこと、tsconfig が src・test・evals を含むことを、自分で確かめた
- 2026-10-01 / T19 / 変更欄の Skill のパスを実ファイルに合わせた（`.claude/skills/knowledge-schema` は `.agents/skills/knowledge-schema` へのリンク）。配布物の検査は、移行する古い DB に記録を入れ、移行後も残ることを見る形にした（T03 の記録の宿題）
- 2026-10-01 / T19 / review-shipping: 差分への指摘なし。依頼文に「Windows のジョブもこの検査を流す」と書いたのは誤りで、流すのは ubuntu の check と release だけ（Windows のジョブは配布物の起動と init・doctor だけを見る）
- 2026-10-01 / T16・T17・T08・T25 / Codex のレビュー（22bca244..4eac1a93）: 指摘 1 件（P2、再現済み）。INSERT OR REPLACE の暗黙の削除は authorizer に届かず、delete のトリガーも動かないので、取り下げた行を生きた行で上書きでき、work の key も変えられる。今のコードに REPLACE を出す所は無い / 採用。authorizer では REPLACE を見分けられず（insert としか届かない）、recursive_triggers を入れると既存のトリガーの動きが変わるので、修正タスク T26 で REPLACE をコードに書けなくする機械の検査を足した
- 2026-10-01 / T26 / review-shipping: 指摘 3 件。schema の制約の `on conflict replace` は普通の insert を REPLACE にするのに検査が schema を読まない、`.orReplace ()` のように括弧の前に空白があると漏れる / 2 件とも検査に足した（pre-commit の対象にも schema を足した）。英文の "or replace" に当たる誤検出は、今のファイルに無く、当たったら書き換えれば済むので見送り
- 2026-10-01 / 完了条件 A1 / スリープ中の `bun run verify` は acceptance の 1 件が 600〜900 秒かかって落ちた（2 回、落ちたケースは毎回別）。マシンを起こした状態で T26 を入れて流し直すと exit 0（acceptance 79 件 pass、72 秒）
- 2026-10-01 / 全差分 / Codex のレビュー（e6028dc3..680fd62f）: 指摘 0 件。revision 1〜4 から 5 への移行が新規の DB と全 166 定義で一致し、移行後の保存・検索・後継の取り下げと復帰・forget の cascade が実際の authorizer の下で通ることを、メモリ上の SQLite で確かめた（bun run verify と npm pack は read-only のため流していない）
- 2026-10-01 / PR #241 / GitHub の Codex レビュー 1 回目（468111c）: 指摘 3 件（P2）。F1: begin と save の間に時計が戻ると finished_at の CHECK で保存全体が落ちる（再現済み）。F2: path の規則が C1 の制御文字を通し、コード側（`\p{Cc}`）と食い違う。F3: knowledge-schema Skill の表に external_reference が残る / 3 件とも採用、T27。完了条件 A6 の rg は隠しディレクトリを見ていなかった。F1 と同じ類の、保存をまたいで時計が戻ったときの state の at と取り下げの時刻は直さない（数時間をまたいで時計が戻るときだけの端の入力）
- 2026-10-01 / T27 / review-shipping: 指摘なし。ingest の接続での max() の更新、GLOB の範囲が文字コードで比べられること（U+0080〜009F が当たり U+00A0 以降は当たらない）、移行の一覧に path が出ないこと、verify と配布物の検査を確かめた
- 2026-10-01 / PR #241 / GitHub の Codex レビュー 2 回目（e0390f1）: 指摘 4 件（P2、P1 なし）。保存をまたいで時計が戻ったときの state の at と取り下げの時刻の CHECK（2 件）、NUL を含む path が GLOB を通る、同じ glean の保存で同じ記録を置き換える 2 つの新しい記録の片方が出典なしになるとき枠の検査が先に拒む / どれも端の入力なので直さず、PR 本文の Declined findings に書いてレビューを終えた
- 2026-10-01 / リリース / v0.6.15 の prepare が 1 回、mask の時間の比例を見るテスト（text-properties.test.ts、このブランチで変えていない）で落ちた。失敗したジョブだけ流し直すと通った。持ち主の承認の後、publish・merge・finish が通った。持ち主の DB を `sphica init` で移行し、修復は 4 行（kind の組が合わない supersedes の link 2 本を外し、その 2 つの unit を candidate に戻した）。`bun run release:status` → consistent
