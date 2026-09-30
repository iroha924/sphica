---
kind: plan
status: approved
codex_session: 01a0f2ac-e3d5-75c3-9cc7-4300778eae42
codex_rounds: 4
approved_at: 2026-10-01
---

# #202・#203: schema を revision 5 に上げ、書き込みの境界・状態遷移・index・CHECK を固める

## 要点

- schema を revision 4 → 5 に上げる。移行は 1 本で、ほぼ全部の表を作り直す。既存の行で新しい規則に合わないものは、直すか外して `sphica init` の出力に全件出す。Sphica が書かない行（DB を外から書き換えたもの）と、消すしかない source があるときだけ、何も変えずに止まって全件を出す
- ingest 接続（記録サーバー）の書き込みを、表・操作・列ごとに許可したものだけにする。session の発言の直接の書き込み、全文索引の直接の操作、run を saved から戻すことを止める
- unit の状態は決めた遷移表の外へ動かない。後継は 1 つだけで、後継が取り下げられたら元の unit は candidate に戻る。支えの規則は 1 つのビューにして、有効にするときと証拠を取り下げるときで同じものを使う
- reader に書き込みを書くと型エラーになる。FK の列には必ず index があり、テストが守る。引用のある session を手で消すことは拒む
- 重複を止める一意キー（編集の観測、生きている anchor）、3 つの表で同じ path の規則、細かい CHECK を足す。どのリリースも書かない値と表（`external_reference` など）を消す
- #203 から外すもの: delivery の行の保持期間（#205 の判断待ち）、project の key の正規化（spool・登録・harvest をまたぐので別の計画）。PR は #202 を閉じ、#203 はこの 2 項目を残して開いたままにする
- 変えないもの: capture の 4 つのビューの列、MCP ツールの引数、CLI のコマンド、project の key、`terms()` の規則

## 持ち主の決定

- #202 と #203 を、1 つの plan・1 つの schema revision・1 つの PR・1 回のリリースにまとめる
- 「修正」は、直す前のコードで落ちる再現テストを先に書き、修正後に通れば採用
- パッケージに入る変更は、npm と 3 つの plugin manifest のバージョンを同じ PR で上げる
- Sphica は自前の進捗ファイルを持たない（移行の結果を書き残すファイルは作らない）
- #203 のうち、delivery の行の保持期間と project の key の正規化は、この計画から外す（議論の後に持ち主が追加）

## 目的

- ingest 接続から、#202 に挙がった書き込み（FTS のコマンドと偽の行、owner の session_message の直接 insert、`sphica_generation` の削除、saved の run を running に戻す、project の key と session の書き換え、delivery などの削除）がどれも拒まれ、trace・harvest・glean の保存と init の登録は通る
- #202 に挙がった遷移（active→active、superseded→active、withdrawn→active、最初の行が candidate 以外、後継が 2 つ、finding が decision を supersede、option の証拠だけで active のまま）がどれも拒まれる
- rev4 の DB を `sphica init` で移行すると、新規の rev5 の DB と同じ定義になり、行・id・`sqlite_sequence`・検索・保存が保たれ、直した行と外した行が全件出る
- #203 に挙がった lookup が index を使う（クエリプランに index 名が出る）

## 対象外

- delivery の行の保持期間: #205（何を表示済みと数えるか、`nothing` の行）が決まらないと、消してよい行が決まらない
- project の key の正規化: key は capture の spool（`capture.ts:372, 682-730`）、init の登録（`cli.ts:297-303`）、harvest の API 呼び出し（`extract.ts:140, 177`）に使われ、schema の作り直しとは別の挙動変更になる。別の計画の入力: spool は旧 key を先に照合する、衝突する組があるときは新規登録を拒む、新規の INSERT だけを正規形に限るトリガー
- `implements` の link を trace が書く機能、`external_reference` を使う機能、as-of の読み取り（#217）、`terms()` の規則の変更（#204）
- session を手で消した後の unit の判定し直し（引用のある session の削除は拒むので起きない）

## 前提

- `SCHEMA_REVISION` は 4（`server/src/sqlite.ts:17`）。移行は `db/migrations/0002〜0004.sql`、fixture は `server/test/fixtures/schema-rev1..3.sql`。`migrate()` は revision ごとに 1 トランザクション、FK off、commit 前に `foreign_key_check`、失敗すると rollback（`server/src/admin.ts:99-108, 126-185`）
- ingest の authorizer は拒否リスト（`server/src/db-write.ts:125-134`）。ingest の書き込みは `record.ts:724-997`、`glean.ts:555-840`、`github.ts:439-507`、`trace.ts:102`、`cli.ts:299`
- glean は同じ run を 2 回 saved にする（`record.ts:993-997` と `glean.ts:836-840`）
- `extraction_run.session_id` は `on delete set null`（`db/schema.sql:192`）。`unit_state` は `run_id` と `forget_id` のどちらか一方が必須（同 393）
- session の id は project の id から作る（`server/src/knowledge.ts` の `sessionId`）
- 実測（node:sqlite、一時 DB、2026-09-30）: AFTER INSERT トリガーの中から同じ表へ insert すると、内側の行にもほかのトリガーが走る / INSTEAD OF のビューへの `insert … returning id` は null を返す / authorizer の第 5 引数は、トリガーの中ではトリガー名、直接の文・FK の cascade と set null・FTS5 の内部テーブルでは null / FTS5 のコマンドは `SQLITE_INSERT <表>` として届く / 式を含む unique index に `on conflict do nothing` は効く / トランザクションの中で作った temp 表は commit の後も同じ接続から読める
- kysely 0.29.6 は `kysely/readonly` を export している（`server/node_modules/kysely/package.json`）
- `git log -S` で、`thread_resolved` の pr_event、`capped` の status と outcome、`external_reference` の insert、`implements` の link を書くコードは server/src の履歴に無い（`implements` は証拠の role としてだけ現れる。2026-09-30、Codex も `thread_resolved` と `capped` を独立に確認）
- 未検証: `reopened`・`closed` の pr_event と `failed` の status・outcome を書く経路が履歴に無いこと。実装のタスクで同じ形で確かめ、確かめられた値だけを消す
- `sqlite_sequence` は表を drop するとその表の行も消える（https://www.sqlite.org/fileformat2.html#the_sqlite_sequence_table 、2026-09-30 Codex が確認）
- 過去の決定: source を消すのは持ち主の forget だけ（trace:81368516…/forget-design）。持ち主の引用を失っても決定を candidate に戻さない（trace:8013bfee…/look-and-overview）。ingest から owner_identity を書かせない（trace:af73d0c3…/ingest-no-owner-identity）

## 方針

1. 移行の形（`db/migrations/0005.check.sql`、`0005.sql`、`server/src/admin.ts`）
   - `migrate()` は各 revision の `begin immediate` の内側で、`<revision>.check.sql` があれば先に流す。temp 表 `sphica_migration_stop (rule, item)` に行があれば、その場で全件読んで例外の文に載せて投げる（読むのは rollback の前）。失敗の文面は今の「何も commit されていない」に乗る
   - 0005.sql の順序: 全トリガーとビューを drop → `sqlite_sequence` を temp 表へ退避 → `extraction_run` を新しい定義に作り直す → 修復のある project ごとに origin `migration`・target `revision:5`・status `saved` の run を 1 行作る → 修復 → 残りの表を `create new_x` / `insert … select` / `drop` / `rename` → sequence を「旧値とコピー後の値の大きい方」で書き戻す → index・ビュー・トリガー → `reindex()` と同じ文で 2 つの FTS を作り直す → `pragma user_version = 5`。FTS の仮想表は drop しない
   - 修復は temp 表 `sphica_migration_note (rule, item, action)` に 1 行ずつ書く。`migrate()` は commit の前に全件読み、commit の後に規則ごとの件数と全件を `say()` で出す（上限なし、1 行 1 件）。temp 表は読んだ後に drop する
   - lifecycle を変える修復は、state 行の追加・`unit.lifecycle` の更新・`unit.revision` の +1 を SQL で明示的に行う（トリガーは drop 済み）。state 行の `run_id` は上の migration の run、理由は `schema revision 5: <規則>`
   - 成功した移行・DB の作成・reindex の後にだけ `pragma optimize` を流す。`withOwner` の finally と `inspect()` には入れない
   - `server/test/fixtures/schema-rev4.sql` を今の schema.sql の写しで足す
2. 既存の行の扱い（3 類）
   - 値で直す: `line_end` だけある → null / 負の `retraction_span_start` → 0 / `retracted_at < added_at` → `added_at` / 文字を切る span → 文字の境界まで広げる / `unit_state.at < unit.created_at` → `created_at` / `finished_at < started_at` → `started_at` / 自分や別の unit を指す `replaced_by` → null / `http://`・`https://` で始まらない url → null / assistant の `indexed = 1` → 0 / path が規則に合わない review_comment の source → path と行を null / active なのに支えが足りない unit、active な後継の無い superseded の unit → candidate
   - 外す: 重複した edit_observation（id の小さい方を残し、anchor は付け替える）/ path が規則に合わない edit_observation（指す anchor の `edit_observation_id` は null）と anchor / 重複した生きている anchor（id の大きい方を残し、古い方を retire して `replaced_by` に残す行）/ 2 つ目以降の後継の link（active な後継のうち id の最も大きいもの、無ければ id の最も大きいものを残す）と kind の組が合わない link / hash が unit と合わない alias。link の整理で残す後継を決めてから、状態の修復をする
   - 止める（0005.check.sql）: どのリリースも書かない値を持つ行（消すと決めた値）、`external_reference` の行、path が規則に合わない file_excerpt の source。メッセージは「Sphica が書かない行がある。一覧の行を直すか、source は前のバージョンの /sphica:forget で忘れてから、もう一度 `sphica init`」
3. ingest の allow list（`server/src/db-write.ts`、`db/schema.sql`、`github.ts`、`glean.ts`）
   - 既定は DENY。許すのは READ / SELECT / FUNCTION / TRANSACTION / SAVEPOINT / RECURSIVE、値なしの `pragma data_version`、FTS5 の内部テーブルへの書き込み、下の対応表
   - 直接の INSERT: `project`、`ingest_source`、`extraction_run`、`source_processing`、`unit`、`unit_option`、`unit_evidence`、`unit_adoption`、`unit_link`、`unit_state`、`unit_anchor`、`unit_alias`、`field_def`、`unit_field`、`work`、`artifact_link`
   - 直接の UPDATE（列ごと）: `extraction_run`（status, finished_at）、`unit_anchor`（retired_at, replaced_by）、`unit_link`（resolved_at, resolution）、`unit_evidence` と `unit_adoption`（retraction の 5 列）、`work`（upsert が書く列）
   - 直接の DELETE: `artifact_link` だけ
   - トリガーの中の書き込み: トリガー名ごとの表と操作。`unit` の lifecycle と revision は `unit_state_apply` と `unit_rev_*` の中だけ、`unit_fts`・`source_fts` は FTS のトリガーの中だけ、`source` は `ingest_source_insert` の中だけ
   - ビュー `ingest_source`（`session_id` と `turn_id` の列を持たない）と INSTEAD OF トリガーを足す。トリガーは `session_id` を null で入れるので、既存の CHECK が session_message を拒む。`github.ts` と `glean.ts` は insert の後に `(project_id, kind, external_id, revision)` と `session_id is null` で id を引く
   - `extraction_run` の凍結: status が running の行だけ status と finished_at を変えられる。ほかの列は変えられない。例外は、旧 session がもう無く `session_id` だけが null になる更新（FK の動作）
   - run を saved にする更新を `saveRecord` から出して 1 つの関数にし、呼び出し側が全部の操作の後に 1 回だけ呼ぶ（trace・harvest は `saveRecord` の後、glean は `saveGlean` の最後）
   - 検査: `sqlite_schema` の全トリガーの本文が書く表が対応表にあること（拾えない書き込みの構文があれば落ちる作りにする）、trace・harvest・glean の保存と init の登録を ingest 接続で通すこと、#202 の再現の各ケースが拒まれること。capture の対応表は変えない
4. unit の凍結（`db/schema.sql`）
   - `unit_text_frozen` の対象に `no_code_surface`・`created_at`・`extraction`・`extraction_reason`・`unsourced` を足す。変える経路は作らない（直すなら後継を書く）
   - `revision` は `old.revision + 1` 以外を拒む
5. 遷移表と後継（`db/schema.sql`、`record.ts`、`glean.ts`）
   - 最初の行は null→candidate だけ。2 行目以降は `from_state` が今の lifecycle。candidate→{active, superseded, withdrawn}、active→{candidate, superseded, withdrawn}、superseded→candidate（後継が全部 withdrawn のときだけ）。withdrawn からは動かない。from ≠ to。superseded へは supersedes の link を持つ後継が active のときだけ
   - `create unique index unit_link_one_successor on unit_link (to_unit) where kind = 'supersedes'`
   - supersedes の kind の組は、同じ kind どうしか、decision と constraint の間。`unit_link_check` と `record.ts` の check の両方に入れる
   - 後継が withdrawn になったら、AFTER INSERT のトリガーが、それが supersede していて今 superseded の unit に superseded→candidate の行を入れる（run_id・forget_id は引き継ぐ）。`glean.ts` の withdraw は、戻った unit を同じ保存の中で判定し直す
6. 支えのビュー（`db/schema.sql`、`glean.ts`）
   - ビュー `unit_support (unit_id, missing)`。`missing` は足りない理由の文で、足りていれば null。中身は今の 3 つの規則（decision・constraint は unit 単位の証拠と採用、implementation はコードかコミットの証拠、finding・dead_end・question は unit 単位の証拠）。文言は今と同じにして、コードの `ACTIVATION` を変えない
   - 使う場所: activate、証拠の retract、採用の retract、anchor の retire。retract・retire の後で unit が active かつ `missing` が null でなければ abort
   - reconsider の条件の引用の規則は activate だけの規則として今のまま残す
   - replace_anchor: 置き換え先が置き換える anchor と同じ組（path・symbol・commit・role）なら check でエラー。保存の順序は「支えを失うなら先に candidate へ → 新しい anchor を insert → 古いのを retire → 判定し直し」
7. reader の型（`server/src/db.ts` と読み取りの関数）
   - `openReader()` の戻り値を `ReadonlyKysely<DB>` にし、reader と writer の両方から呼ぶ読み取りの関数はそれを受ける。`// @ts-expect-error` で「reader に insert を書くと型エラー」を 1 つ置く
8. index（`db/schema.sql`、`github.ts`、`glean.ts`、`server/test/schema.test.ts`）
   - 規則: FK の列（複合ならその列の組）は、どれかの index の先頭に並ぶ。全表の `pragma foreign_key_list` と index を突き合わせるテストで守る。例外は置かない
   - 足す index は規則が要求するもの全部（`unit_link (to_unit, kind)`、`delivery_unit (unit_id)`、`unit (run_id)`、`unit_anchor` の `edit_observation_id` と `replaced_by`、`unit_state` の `source_id`・`forget_id`・`run_id`、`unit_evidence`・`unit_adoption` の `retraction_source_id`、`unit_adoption (source_id)`、`source_forgotten (batch_id)`、残りの `run_id` など）
   - `github.ts` と `glean.ts` の item の lookup に `session_id is null` を足す
   - クエリプランのテスト: delivery の conflicts、search・read の後継の lookup、item の lookup、forget が触る列
9. FK の動作（`db/schema.sql`、`forget.ts`）
   - 規則を schema の先頭のコメントに書く: 行はそれが属するものと一緒に消える / 忘れられる source を引用する行はそれと一緒に消える / 由来を指すだけの列（`run_id`・`forget_id`・`edit_observation_id`）は NO ACTION のまま（RESTRICT は cascade の順序で落ちうる）
   - `unit_evidence`・`unit_adoption` の `retraction_source_id` を `on delete cascade` にし、no-delete のトリガーの例外を「retraction の source が無くなった」に変える。`forget.ts` の先回りの delete は消す
   - `before delete on session` のトリガー: project がまだ在り、その session の source を引用する行（証拠・採用・field_def・unit_field・unit_state）か、その観測を指す anchor が在れば abort（「先に /sphica:forget でその発言を忘れる」）
   - テスト: project の削除で全部消えて `foreign_key_check` が空 / 引用の無い session（running と saved の run を持つ）は消える / 引用のある session は拒まれる
10. 一意キーと CHECK（`db/schema.sql`、`github.ts`、`scripts/check-pairs.mjs`、`server/src/cli.ts`）
    - `edit_observation`: 表の unique を外し、`(session_id, coalesce(turn_id, ''), path, via)` の unique index
    - 生きている anchor: `(unit_id, path, coalesce(symbol, ''), coalesce(commit_sha, ''), role) where retired_at is null` の unique index
    - 同じ content_hash の unit は unique にしない。`unit (project_id, content_hash)` の index と、`sphica doctor` に「同じ内容の生きている記録が N 組」の 1 行
    - path の CHECK: `source.path`・`edit_observation.path`・`unit_anchor.path` を同じ式にする（`//`・`./`・`/./`・制御文字 0x01-0x1f と 0x7f を拒む）。check-pairs に、3 つの式が列名を除いて同じであることの検査を足す。`github.ts` の `cleanPath` は制御文字を含む path を null にする
    - 小さい CHECK（それぞれテスト）: `line_end` は `line_start` があるときだけ / `retraction_span_start >= 0` / `retracted_at >= added_at` / span が UTF-8 の文字を切らない（証拠・採用・field_def・unit_field・retraction） / `unit_state.at >= unit.created_at` / `finished_at >= started_at` / `replaced_by` は自分以外で同じ unit の anchor / url は `http://` か `https://` / assistant の source は `indexed = 0` / alias の `content_hash` は unit のものと同じ
11. 使われていない値（`db/schema.sql`、`server/src/knowledge.ts`、`forget.ts`、`db-write.ts`、check-pairs）
    - 消す: `unit_link` の `implements`、`external_reference` の表（forget.ts の delete と `FORGET_WRITES` も）、run の `capped` と outcome の `capped`、pr_event の `thread_resolved`。`reopened`・`closed`・`failed`（と、`failed` を消せたときの `extraction_run.reason`）は、履歴で書く経路が無いと確かめられたものだけ消す
    - 足す: `extraction_run.origin` の `migration`（移行の修復の由来）。`knowledge.ts` と check-pairs に入れ、origin ごとに最後の抽出を出す表示は抽出として数えない。begin のツールは trace・harvest・glean だけを作る（`trace.ts:95`）
    - 残す: `available_at`（#217 の as-of が使う予定で、最初の revision 以外は後から作り直せない）。`auto_vacuum` は 0 のまま。どちらも理由を schema のコメントに書く
12. バージョンと出荷
    - `SCHEMA_REVISION` を 5 に。`bun run codegen`。knowledge-schema Skill の表（ロール、FK の規則、移行の形）を直す
    - `bun run release:plan -- --base v0.6.14` を流し、`plugin` なら npm と 3 つの manifest を同じバージョンに上げる（plugin-release Skill）
    - `scripts/check-tarball.mjs` の検査を rev4 の DB に向ける

## 採った案と棄却した案

- 採用: 既存の行を 3 類に分け、止めるのは Sphica が書かない行と消すしかない source だけ。棄却: 全部を止めずに直す（書かれなかった run を saved と偽り、source を確認なしに消すことになる）、合わない行があれば常に止める（持ち主が直せない行で plugin だけ新しい状態から動けなくなる）
- 採用: 修復の一覧は上限なしで全件出す。棄却: 規則ごとに先頭 20 行（残りをどう直したか後から確かめられない）
- 採用: session_message の直接 insert はビュー `ingest_source` で止める。棄却: authorizer だけで止める（値を見られない）
- 採用: 引用のある session の直接削除を拒む。棄却: 削除を通して `edit_observation_id` を null にする（支えの無い active な unit が残る）
- 採用: FK の index は列の組で検査する。棄却: 各列がどれかの index の先頭（複合 FK の検索を保証しない）
- 採用: project の key の正規化は別の計画。棄却: 重なる組を別の key へ退避（通常の作業ディレクトリから読めなくなる）、重なる組を触らず探すときに旧 key を先に見る（3 つ目の clone で project が増え、spool を取り違える）、移行で統合（session の id と trace の unit の key が project の id を含む）
- 採用: `pragma optimize` は成功した書き込みの後にだけ。棄却: `withOwner` の finally（移行の失敗の例外を上書きしうる、`inspect()` の読み取りに統計の更新が混ざる）
- 採用: 移行の修復の由来は origin `migration` の run。棄却: glean の run と偽る、`unit_state` に列を足す
- 採用: run を saved にするのは全部の操作の後に 1 回。棄却: glean の 2 回目の更新だけ消す（操作の途中で run が saved になる）
- 採用: replace_anchor は同じ組への置き換えを拒み、insert が先。棄却: retire を先にする（retire と `replaced_by` は同じ更新で入れる規則と合わない）

## 手順

- S1: `migrate()` に check の手順・停止と修復の一覧・`pragma optimize` を入れ、rev4 の fixture を足す（方針 1）
- S2: run を saved にする更新を 1 回にまとめる（方針 3）
- S3: `schema.sql` を revision 5 にする: 凍結、遷移表と後継、支えのビュー、`ingest_source`、`extraction_run` の凍結、session の削除のトリガー、FK の動作、index、一意キー、CHECK、値の整理（方針 3〜6・8〜11）
- S4: `0005.check.sql` と `0005.sql` を書き、修復と停止を規則ごとにテストする（方針 1・2）
- S5: ingest の allow list と対応表の検査、source の insert をビュー経由にする（方針 3）
- S6: コード側を新しい規則に合わせる: supersedes の kind の組、withdraw の後の判定し直し、replace_anchor、forget の delete、`cleanPath`、item の lookup（方針 5・6・8・9・10）
- S7: reader の型（方針 7）
- S8: FK の index の検査とクエリプランのテスト（方針 8）
- S9: `sphica doctor` の 1 行、check-pairs、`knowledge.ts`、Skill の更新（方針 10・11・12）
- S10: `SCHEMA_REVISION`・codegen・tarball の検査・バージョン（方針 12）

## 完了条件

- A1: `bun run verify` → 0 で終わる
- A2: `cd server && node --test test/db.test.ts` → #202 の再現の各ケース（FTS のコマンドと偽の行、session_message の直接 insert、`sphica_generation` の削除、saved の run を running に戻す、project の key と session の更新、delivery・work・edit_observation・source_processing・extraction_run の削除）が ingest で拒まれ、trace・harvest・glean（新しい unit あり / 操作だけ）の保存と init の登録が通るテストが通る
- A3: `cd server && node --test test/schema.test.ts` → 遷移表・後継・支え・凍結・session の削除・FK の index の規則・各 CHECK のテストが通る
- A4: `cd server && node --test test/migrate.test.ts` → 実際の `admin.migrate()` で、(a) 移行した rev4 の DB が新規の DB と同じ定義、(b) 規則を破る行を入れた rev4 の DB で、修復が決めたとおりになり全件が出て、全 autoincrement 表の次の id が旧値 + 1、検索が当たり、ingest の保存と capture の書き込みが通る、(c) 止める行を入れた DB で、全件が例外の文に出て revision が 4 のまま・全表の行が変わらない、が通る
- A5: `bun run bundle && cd plugin && node ../scripts/check-tarball.mjs "$(npm pack --silent)"` → tarball の deliver が rev4 の DB にバージョン入りの案内を返し、cli の init が `Backed up:` と `Migrated: … (revision 4 → 5)` を出す
- A6: `rg -n "external_reference" db/schema.sql server/src --glob '!db-types.ts'` → 該当なし
- A7: `bun run release:plan -- --base v0.6.14` → `plugin`。`package.json` と 3 つの manifest のバージョンが一致する
- A8: `bun run release:status` → リリースの後、持ち主の PC で plugin を更新し、Claude Code と Codex のセッションで revision 不一致の案内が 1 回見え、`sphica init` が移行した後で、consistent を返す

## リスク

- 表の作り直しが多く移行の SQL が長い → A4 の (a)(b) で守る。落ちたら修復と作り直しを表ごとに切り分ける
- 修復が記録を変える → 移行前のバックアップが残り、全件が出力に出る
- allow list が正当な書き込みを落とす（実行時にしか出ない）→ A2 の実際の保存と受け入れケースで確かめる。落ちたら対応表に足し、対応表の検査に同じ経路を足す
- 持ち主の DB に「止める」行がある → 何も変わらず止まる。一覧を見て、その値を消す判断を見直す
- plugin だけ先に新しくなると読めない → #201 で入れたバージョン入りの案内と `sphica init` で戻る（A8 で確かめる）
- Codex との議論の途中でモデルが `gpt-6-sol` から `gpt-6.1-sol` に変わった（3 往復目から）→ 指摘はコードで裏を取ってから受け入れた

## 未解決

なし

## 変更履歴
