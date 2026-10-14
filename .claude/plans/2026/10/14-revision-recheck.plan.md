---
kind: plan
status: approved
codex_session: 01a13936-4501-7d71-90e1-0ae817bc3032
codex_rounds: 3
approved_at: 2026-10-14
---

# ingest と forget の接続は、開いた後に DB の revision が変わっていたら書き込みを拒否する（#342）

## 要点

- ingest と forget の接続は、行の書き込みを「`begin immediate` の直後に revision を確かめたトランザクション」の中でだけ許す。違えば rollback してから `RevisionMismatch`（今と同じ文面）を投げる
- 強制は `connectWriter` の中だけで行う: `begin immediate` の文を検査付きに包み、authorizer が検査済みでない書き込みを拒否する。呼び出し側が検査を付け忘れることはできない
- トランザクションの外で書いている 4 か所（`logCall`、trace / glean の `openRun`、`init` のプロジェクト登録、forget の commit 後の optimize）を `inTransaction` に入れる
- 変えないもの: capture は今までどおり世代だけを見て、revision をまたいで書き続ける。owner（`sphica init`）は移行する。schema の revision は 13 のまま
- チェックを持たない古いサーバー（0.6.57 以前）は守れない。次に revision を上げるリリースより前に出しておくための変更
- パッケージに入る変更なので、npm と 3 つの plugin manifest を同じバージョンに上げる

## 持ち主の決定

- #342 をやる（2026-10-14）
- issue の「What a fix has to keep」を守る: capture は同じ世代の中で revision が変わっても書き続ける。`sphica init`（owner 接続）は古い revision の DB を移行する
- issue の「How to check a fix」の順で確かめる: 今のコードで落ちるテストを先に書き、それから `bun run verify`

## 目的

記録サーバーが開いた ingest 接続を持ったまま `sphica init` が DB を移行したとき、そのサーバーの次の書き込みは `RevisionMismatch` の文面で拒否され、DB に何も残らない。forget も同じ。capture と owner の挙動は変わらない。

## 対象外

- チェックを持たない古いバージョンのサーバーを止めること（schema 側の仕組みが要る。棄却した案 D）
- 保持した prepared statement を、検査済みトランザクションの外で実行し直す経路。authorizer は prepare 時にしか呼ばれないので塞げない。Sphica のコードは statement を保持しない（kysely のアダプタはクエリごとに prepare する）。移行は schema を変えるので、移行の後は再 prepare で拒否される
- issue #342 の「When to reevaluate」にある、revision 13 の DB で `unit_answer` が欠けた行を探す調査

## 前提

- 接続を開くときにだけ revision を見る: `server/src/sqlite.ts:55` `prepare`、`server/src/db-write.ts:346` `connectWriter`（ingest / forget は "revision"、capture / owner は "generation" / "none"）
- 記録サーバーは ingest 接続を 1 本ずっと持つ: `server/src/mcp-record.ts:44`、`server/src/db.ts:33` `kyselyOn`
- forget は呼び出しごとに `openWriter("forget")` を開いて閉じ、自前の `begin immediate` を使う: `server/src/forget.ts:220`、`:249`
- authorizer を付けた後の接続は、`pragma user_version` を新しく prepare しても、付ける前に prepare した文でも `not authorized` で拒否する（Node 24.15.0 で実測、2026-10-14）
- FTS5 は commit の実行中に shadow table（`x_data`、`x_idx`）への insert を prepare し、そのとき `raw.isTransaction` は false（Node 24.15.0 で実測、2026-10-14）。savepoint / release の処理でも flush する（Codex が SQLite 3.51.3 の `fts5_main.c` で確認）
- autocommit の書き込みは、prepare 時に revision を確かめても実行までに移行が割り込める。`begin immediate` の後なら別接続の移行は止まる（Codex が共有インメモリ SQLite で実測）
- `raw.exec` は差し替えた `raw.prepare` を通らない。`INSERT … RETURNING` は列を持つ。`begin immediate` の文は prepare しただけでは `isTransaction` が false のまま（Codex が Node 24.15.0 で実測）
- `iterate` は iterator を作るだけで、`sqlite3_step` は最初の `next()` で走る（Node v24.15.0 `src/node_sqlite.cc`）
- `authorizer` の中で `raw.isTransaction`（`sqlite3_get_autocommit` を読むだけ）を読める（Node 24.15.0 で実測、2026-10-14）
- トランザクションの外の書き込み: `server/src/trace.ts:153` `logCall`、`server/src/extract.ts:183`・`:203`（trace / glean の `openRun`）、`server/src/cli.ts:510`（`init` のプロジェクト登録）、`server/src/forget.ts:270`〜`:274`（commit 後の optimize）。harvest の `openRun(trx, …)`（`extract.ts:222`）は `:217` のトランザクションの中
- SQL の呼び出し場所はソースから自動で集められる（`scripts/lib/sql-call-sites.mjs:15`）。手動の一覧は例外用で空

## 方針

`server/src/sqlite.ts`:
- `requireRevision(raw)` を置き、`pragma user_version` を読んで違えば `RevisionMismatch` を投げる。`prepare` の中の今の検査もこれを使う

`server/src/db-write.ts`（ingest と forget の接続だけ）:
- 接続ごとの状態 `checked`（初期値 false）を持つ
- `raw.prepare` を包む。SQL がちょうど `begin immediate` の文は、`run` / `all` / `get` で実行されたときに「`begin immediate` を実行 → `requireRevision` → 違えば `rollback` を実行してから投げる → 合えば `checked = true`」を行う文を返す。`iterate` は呼ばれたら投げる。`columns()` は元の文のものを返す。それ以外の SQL は元の文をそのまま返す
- authorizer に `checked` と `raw` を渡し、次の規則を足す（既存の表ごとの許可より前で判定し、既存の禁止はそのまま残る）
  - 行の書き込み（INSERT / UPDATE / DELETE）は、`checked && raw.isTransaction` のときだけ許す。`raw.isTransaction` が false の書き込みは拒否し、`checked = false` にする
  - FTS5 の shadow table（`SHADOW`）への書き込みは `checked` を見ない（今の特例を判定の最初に置いたまま）。shadow は defensive mode で文から名指しできないので、仮想表への書き込み（こちらは `checked` で止まる）か、その flush からしか起きない
  - SQLITE_TRANSACTION の BEGIN を見たら `checked = false`。SQLITE_SAVEPOINT を `raw.isTransaction` が false のときに見たら `checked = false`
  - COMMIT / ROLLBACK の prepare では `checked` を変えない（commit 中の FTS5 の flush を通すため）
  - `pragma user_version` は、名前が一致し p2 が null のときだけ許す（代入 `= N` と `user_version(N)` は p2 が値になるので拒否のまま）
- capture と owner の接続は包まない

呼び出し側:
- `inTransaction` / `inRolledBack`（`server/src/db.ts`）と `previewForget` / `applyForget` の `begin immediate` は変更なし（同じリテラルなので検査付きになる）
- `logCall` を単独の `inTransaction` に入れる
- `beginTrace` / `beginGlean` の `openRun` 呼び出しを `inTransaction` に入れる。`openRun` 自体と harvest の呼び出しは変えない
- `init` のプロジェクト登録（`cli.ts:510`）を `inTransaction` に入れる
- `applyForget` の commit 後の optimize 2 件を `inTransaction(c, …)`（取得済みの接続）に入れる。拒否されたら今の catch で `cleanup: "incomplete"`。`wal_checkpoint` はトランザクションの外のまま
- ほかに ingest / forget 接続でトランザクションの外の書き込みが見つかれば同じく入れる（漏れはテストで authorizer の拒否として出る）

テスト（`server/test/db.test.ts` ほか）:
- forget の移行窓は、テストの中だけで prepare を差し替えて（`server/test/temp-db.ts:54` の手法）、`begin immediate` の実行直前、または削除の commit 直後に 1 回だけ owner 接続で revision を上げる。本番コードに移行用のフックは足さない

出荷:
- `bun run release:plan -- --base 94196c67`（v0.6.57）の種別に従う。plugin なら npm と 3 つの manifest を同じバージョンに上げる。最初にパッケージ入力を変えるコミットにバージョンの bump を入れる（pre-commit が main のバージョンのままのコミットを拒否する）

## 採った案と棄却した案

- 採用: 接続側で強制する（検査付き begin ＋ authorizer の `checked`）。棄却: 案 B、`inTransaction` に役を渡し、ツールの入口で 1 回確かめる（入口の検査は後の autocommit の書き込みまでロックを持たない）
- 棄却: 案 C、記録サーバーがツール呼び出しごとに接続を開き直す（開いてから書くまでの移行は止まらない）
- 棄却: 案 A の最初の形、autocommit の書き込みを prepare 時に確かめる（実行までに移行が割り込める。`raw.exec` と保持した文が漏れる）
- 棄却: COMMIT / ROLLBACK の prepare で `checked` を外す（commit 中の FTS5 の flush を拒否する）
- 棄却: 案 D、各接続が自分の revision を返す SQL 関数を登録し、トリガーが DB の revision と比べる（古いサーバーまで止められるが、schema の revision を上げる必要があり、capture の表を除くトリガーが表ごとに増える）
- 棄却: `pragma schema_version` / `data_version` の変化で見る（移行以外の書き込みでも変わり、revision の変化と区別できない）
- 棄却: `openRun` 自体を `inTransaction` で包む（harvest のトランザクションの中で BEGIN が入れ子になる）

## 手順

- S1: 今のコードで落ちるテスト（ingest と forget の、開いた後の移行）を書いて red を確かめる
- S2: `requireRevision` と、ingest / forget の検査付き begin・authorizer の `checked`・`user_version` の読み取りの許可を入れる
- S3: トランザクションの外の書き込み（`logCall`、trace / glean の `openRun`、`init` の登録、forget の optimize）を `inTransaction` に入れる
- S4: 移行窓・持ち越し・自動 rollback・FTS の正常系・既存の禁止・forget の preview / apply のテストを足す
- S5: バージョンを上げ、`release:plan` と `verify` を通す

## 完了条件

テストの名前には `revision` を含める（A1〜A9 を 1 つのコマンドで流せるように）。

- A1: 修正前のコードで `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern=revision test/db.test.ts test/forget.test.ts` → ingest の「開いた後の移行」のテストが失敗する。修正後は同じテストが通る（ingest 接続で 1 クエリ → owner 接続で `user_version` を上げる → 同じ接続で `inTransaction` の書き込み → `RevisionMismatch` の文面で拒否、行が増えない）
- A2: `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern=revision test/db.test.ts test/forget.test.ts` → forget の接続（`connectWriter("forget")`）で A1 と同じテストが通る
- A3: `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern=revision test/db.test.ts test/forget.test.ts` → capture の接続を開いたまま移行しても書けるテストが通る
- A4: `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern=revision test/db.test.ts test/forget.test.ts` → 検査付き begin の後、ロックを持っている間は owner 接続（busy timeout 0）の `user_version` 変更が SQLITE_BUSY になるテストが通る
- A5: `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern=revision test/db.test.ts test/forget.test.ts` → 拒否の後、その接続は rollback 済み（`isTransaction` が false）で別接続が書き込みロックを取れ、revision を戻せば次の `inTransaction` が通るテストが通る
- A6: `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern=revision test/db.test.ts test/forget.test.ts` → ingest / forget で、`raw.exec("begin")`・`begin deferred`・最外側の savepoint で始めたトランザクションと autocommit の insert が拒否され、検査済みトランザクションを commit した直後にも同じく拒否され、`insert or rollback` の自動 rollback の後の autocommit の insert も拒否されるテストが通る
- A7: `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern=revision test/db.test.ts test/forget.test.ts` → `record_check`（`inRolledBack`）が revision の違いで拒否され、`previewForget` / `applyForget` は接続を開いた後・`begin immediate` の実行前に revision を上げると拒否されて何も消えないテストが通る
- A8: `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern=revision test/db.test.ts test/forget.test.ts` → `applyForget` で削除の commit 直後に revision を上げると、削除が残り結果が `cleanup: "incomplete"` になるテストが通る
- A9: `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern=revision test/db.test.ts test/forget.test.ts` → 新しい ingest 接続で source / unit の FTS 索引を初めて書く経路が commit まで通り別接続の検索で見えること、`checked` が true の中でも既存の禁止（owner_identity への insert など）が拒否されること、ingest と forget のどちらでも shadow table を直接書けず forget の未検査の状態で FTS の optimize の insert が拒否されること、のテストが通る
- A10: `bun run verify` → 0 で終わる（`sql:reach`、`sql:live`、acceptance を含む）
- A11: `bun run release:plan -- --base 94196c67` → plugin を返し、`package.json` と 3 つの plugin manifest のバージョンが同じ

## リスク

- 見つけていないトランザクションの外の書き込みが本番で拒否される → テストと `sql:live`・acceptance で出る。出たら `inTransaction` に入れる
- authorizer の状態が FTS5 の内部の prepare と噛み合わない場面が残る → A9 の正常系で出る。出たら shadow の扱いを直して Codex と詰め直す
- 記録サーバーのツールが移行の後にエラーを返すようになる（今は黙って書く）→ 文面は接続を開けないときと同じで、プラグインの更新と再起動を案内する

## 未解決

なし

## 変更履歴
