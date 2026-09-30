---
kind: plan
status: approved
codex_session: 01a0ef9e-bce6-7b20-a712-b915c561dea1
codex_rounds: 3
approved_at: 2026-09-30
---

# #201: 移行の前にバックアップを取り、plugin 更新後の案内と schema・索引の検査を固める

## 要点

- `sphica init` の移行は、最初の移行の前に `VACUUM INTO` で `backups/` にバックアップを取り、検査してから移行する。取れなければ移行しない。場所と戻し方を移行の前とエラーに出す
- forget の preview・確認文面・完了の返答に、Sphica が作ったバックアップの場所と件数を出す（自動では消さない）
- revision 不一致の案内に必要な CLI の版を入れ、delivery は不一致だけ別の印でセッションに 1 回、prompt でも返す
- 4 つの capture ビューの列を全 fixture の revision と比べ、fixture の欠けも落とすテストを足す
- `terms()` の出力を golden で固定し、規則を変えたら revision を上げて移行の SQL で索引を作り直す、という規範に揃える（マーカーは作らない）
- 変えないもの: schema（revision 4 のまま）、接続ロール、自動移行はしない、MCP ツールの引数

## 持ち主の決定

- 1 issue = 1 PR。#201 は v1 epic（#200）の最初で、テーブルを作り直す #202・#203 の前に入れる
- 「修正」は、直す前のコードで落ちる再現テストを先に書き、修正後に通れば採用
- パッケージに入る変更は、npm と 3 つの plugin manifest の版を同じ PR で上げる

## 目的

- 移行が途中で失敗しても、commit 後に誤りと分かっても、移行前の DB に戻せる。その場所と戻し方が CLI の出力とエラーにある
- plugin だけ新しくなって DB の revision が合わないとき、持ち主が見る案内に「どの版の CLI を入れて `sphica init` するか」がある
- capture ビューの列が revision をまたいで変わると、テストが落ちる
- 収録入力に対する `terms()` の出力が変わると、テストが落ち、revision を上げて再索引の移行を足すよう言う

## 対象外

- 自動移行（フックや記録サーバーからの移行）。理由は「採った案と棄却した案」
- 復元コマンド。#201 は「戻せる」ことまで。戻す道具は要望が出てから
- バックアップの自動削除を forget から行うこと（過去の決定 forget-design で棄却済み）
- 再索引入りの移行の実 DB テスト（旧 DB の行が新規則で見つかる）。再索引入りの移行を最初に作る issue（#204 の予定）の完了条件にする
- ホストのセッション（Claude Code・Codex）で不一致の案内が見えることの実機確認。このリリースは revision を上げないため、次に revision を上げるリリース（#202/#203）の完了条件にする
- 他プロセスが残した `.partial` の検出・表示（doctor に出すこと）

## 前提

- `migrate()` は `server/src/admin.ts:56-83`。revision ごとに 1 トランザクション、foreign_keys off、commit 前に foreign_key_check、書き込みロック下で revision を読み直す。移行ファイルは `dbDir()/migrations`（admin.ts:22）
- `SCHEMA_REVISION` は 4（`server/src/sqlite.ts:16`）。移行は `db/migrations/0002〜0004.sql`、fixture は `server/test/fixtures/schema-rev1..3.sql`
- バックアップは無い。`server/src/forget.ts:311` は「DB の外の複製（バックアップ含む）は触らない」と返す。forget-design（trace:81368516…/forget-design）で DB の外の複製の削除は棄却
- reader・ingest・forget は revision が違うと開けない（`sqlite.ts:51-70`、`db-write.ts:197`）。不一致メッセージは「Update the sphica CLI (`npm i -g sphica`), then run `sphica init`」で版を含まない
- CLI（`npm i -g sphica`）と plugin cache は別経路（plugin-release Skill、`server/src/plugin.ts:298-308`）。plugin だけ新しいと、古い CLI の `sphica init` は DB と自分の revision が一致して "Already exists" を返し、移行しない
- delivery（`server/src/deliver.ts:727-730`）は失敗を session_start・pre_edit・pre_read でセッションに 1 回 `Sphica unavailable: <reason>` として返す。印は `onceUnavailable`（575-577）で障害の種類を区別しない。prompt と shell では返さない
- capture ビューの列の検査は `server/test/migrate.test.ts:212` の `capture_message`、rev1 と現在の比較だけ。ビューは `db/schema.sql:820-859` に 4 つ
- FTS は contentless（`unit_fts`・`source_fts`、`content=''`）。`reindex()`（admin.ts:190-209）は delete-all して入れ直す。owner 接続にも `sphica_terms` が登録される（`db-write.ts:198`）ので、移行の SQL に同じ文を書けば作り直せる
- `server/src/text.ts:38` と `admin.ts:4` は「terms() を変えたら持ち主に `sphica doctor --reindex` を案内する」と書いている
- `VACUUM INTO` は一貫したスナップショットを作り、出力先に空でないファイルがあると失敗し、中断すると不完全なファイルが残り得る（https://www.sqlite.org/lang_vacuum.html §2.1、2026-09-30 Codex が確認）

## 方針

1. バックアップ（`server/src/admin.ts`）
   - `migrate(file, dir = dbDir()/migrations)`。移行ファイルのディレクトリを引数で渡せるようにする（テストで失敗する移行を差し込むため）
   - 移行が 1 つ以上あるときだけ、最初の移行の前に owner 接続で `VACUUM INTO '<DB のディレクトリ>/backups/sphica.rev<from>.<YYYYMMDDTHHMMSSmmmZ>.<pid>.db.partial'`。ディレクトリは `mode: 0o700` で作る（Windows では効かない）。名前にコロンを使わない
   - `.partial` を読み取り専用で開き、`pragma quick_check` が `ok`、`user_version` が from であることを確かめてから `.partial` を外す rename。失敗したら自分の `.partial` だけ消して例外（移行しない）
   - 移行の前に `Backed up: <path>` を出す。移行が失敗したら、エラーにバックアップのパスと戻し方の 1 行を入れる: 「Sphica を使うセッションを閉じ、sphica.db・sphica.db-wal・sphica.db-shm を脇へ移し、バックアップを sphica.db へコピーする」
   - 移行が全部 commit した後だけ刈り込む: `backups/` の `sphica.rev*.db`（`.partial` を除く）を名前の新しい順に 3 つ残す。今回作ったものは必ず残る。他プロセスの `.partial` は消さず、数えない
2. forget の案内（`server/src/forget.ts`、`server/src/mcp-record.ts`）
   - バックアップの場所と完成品の件数を返す関数を 1 つ置き、forget_preview の返答、elicitation の確認文面、forget_apply の完了の返答（forget.ts:311 の文を置き換え）に出す。件数 0 なら場所だけ出さない
3. 不一致の案内（`server/src/sqlite.ts`、`server/src/deliver.ts`）
   - DB が古いときのメッセージ: 「The database schema is revision N, but this Sphica expects revision M. Run `npm i -g sphica@<version>`, then `sphica init` to migrate it (records are kept; a backup is made first).」。`<version>` は package の version（既存の版の取り方に合わせる）
   - deliver: 不一致の失敗だけ `markOnce("revision", …)` の別の印を使い、session_start・pre_edit・pre_read に加えて、オーナーの発話の prompt でも 1 回返す。shell は返さない。DB を開く前の return は変えない。ほかの失敗は今の `onceUnavailable` のまま
   - 不一致の判別は、sqlite.ts から専用のエラー型（`RevisionMismatch`）を投げて `instanceof` で見る（文面の照合はしない）
4. capture ビューの列（`server/test/migrate.test.ts`）
   - `capture_session`・`capture_message`・`capture_edit`・`capture_delivery` の `pragma table_info` を、各 fixture の DB と現在の DB で比べる。ビューが無い古い revision は「無い」ことを期待値に書く（飛ばさない）
   - fixture が 1..SCHEMA_REVISION-1 の全部そろっていることもテストにする
5. 全文索引の規則（`server/test/`、`server/src/text.ts`、`server/src/admin.ts`、`.claude/skills/knowledge-schema/SKILL.md`）
   - `server/test/fixtures/terms-golden.json` に入力と `terms()` の出力を固定する。入力は手書きの例（日本語・英語・識別子・記号・絵文字・結合文字）と `server/evals/acceptance/` の world の全テキスト。テストの失敗メッセージは「terms() の出力が変わった。revision を上げ、reindex と同じ文を入れた移行を足してから golden を更新する」
   - `reindex()` の SQL を定数にして export する（移行を書くときに写す元を 1 つにする）
   - text.ts:38・admin.ts:4 の「doctor --reindex を案内する」を「revision を上げて移行で作り直す」に置き換え、knowledge-schema Skill にも同じ 1 行を足す（止める仕組みは規範文書の水準。期待値だけの更新は機械で止められない）
6. 版と出荷
   - `bun run release:plan -- --base <前のリリースのコミット>` を流し、`plugin` なら npm と 3 つの manifest を同じ版に上げる（plugin-release Skill）
   - sql:live に、`npm pack` を展開した `dist/deliver.js` と `dist/cli.js` を一時 HOME（`SPHICA_HOME`）の rev3 の DB に流す検査を足す: deliver が版入りの案内を返す → cli の init が `Backed up:` と `Migrated:` を出す → バックアップが revision 3 で開ける

## 採った案と棄却した案

- 採用: `.partial` に書いて検査後に rename、名前にミリ秒と pid。棄却: 秒単位の名前（同じ秒の再試行が失敗する）
- 採用: 刈り込みは移行が全部 commit した後だけ。棄却: 作成直後に刈り込む（失敗を繰り返すと移行前の世代を失う）
- 採用: 自動移行はせず、版入りの案内。棄却: SessionStart の capture フックで owner 接続を開いて自動移行（10 秒で時間切れになり得る、持ち主の見ていないところで schema を変える）、reader が 1 つ前の revision を開く（何を読めるかを revision ごとに判定する仕組みが要り検査できない）、記録サーバーに移行させる（ロールの分離を崩す）
- 採用: 不一致に別の 1 回印。棄却: `onceUnavailable` の共用（先に別の障害警告が出たセッションで不一致の案内が黙る）
- 採用: forget の preview・確認・完了に場所と件数。棄却: 完了の返答だけ（件数を打つ前に知れない）
- 採用: 再索引は移行の SQL に書く。棄却: 移行が読むマーカー（contentless の索引は SQL で作り直せ、要らない）
- 採用: golden を回帰テストとして置き、保証を収録入力に限る。棄却: golden に revision 欄を持たせて移行を強制する（最初の revision が 1 になり何も強制しない）、前回リリースのスナップショットとの比較（テストが外部から tarball やタグを取る）

## 手順

- S1: `migrate()` に移行ディレクトリの引数と、検査済みバックアップ・戻し方の出力・刈り込みを入れる（方針 1）
- S2: forget の preview・確認・完了にバックアップの場所と件数を出す（方針 2）
- S3: 不一致のエラー型と版入りのメッセージ、delivery の別の 1 回印と prompt での案内（方針 3）
- S4: capture ビューの列と fixture のそろいのテスト（方針 4）
- S5: terms の golden、reindex の SQL の定数化、規範の文の置き換え（方針 5）
- S6: sql:live の tarball 検査と、版の更新（方針 6）

## 完了条件

- A1: `bun run verify` → 0 で終わる
- A2: `cd server && node --test test/admin.test.ts test/migrate.test.ts` → 失敗する移行を差し込んだ rev1 の DB で、移行が途中で止まり、バックアップが revision 1・元の行数（WAL にだけあった行を含む）で開け、戻し方どおりに置き換えると owner で元の行が読めるテストが通る
- A3: `cd server && node --test test/deliver.test.ts` → 同じセッションで一般の障害警告の後でも、不一致の案内（`npm i -g sphica@<version>` を含む）が SessionStart と prompt で 1 回ずつ返るテストが通る
- A4: `bun run bundle && cd plugin && node ../scripts/check-tarball.mjs "$(npm pack --silent)"` → tarball の deliver.js が rev3 の DB に版入りの案内を返し、cli.js の init が `Backed up:` と `Migrated: … (revision 3 → 4)` を出す
- A5: `rg -n "doctor --reindex" server/src .claude/skills` → terms() の変更時の手順として書いた箇所が残っていない（doctor の索引が壊れたときの案内は残る）
- A6: `bun run release:plan -- --base v0.6.11` → `plugin`。`package.json` と 3 つの manifest の版が一致する

## リスク

- 大きい DB で `VACUUM INTO` が遅い、ディスクが足りない → 移行せずに止まる（今より安全側）。エラーにそう書く
- バックアップに forget した本文が残る → forget の preview・確認・完了で場所と件数を出し、持ち主が消す
- golden に無い入力にだけ効く `terms()` の変更は通る → 規範文書で止める。入力集合を acceptance の world から作って広くとる
- 他プロセスの `.partial` が残り続ける → 数えず消さない。溜まる報告が来たら doctor に出す

## 未解決

なし

## 変更履歴
- 2026-09-30 / A4 と方針 6 の検査の置き場を sql:live から scripts/check-tarball.mjs に / 配布物を展開して動かす検査が既にそこにあり、CI の check と release が流す / Go 不要（検査の置き場だけで範囲は同じ）
- 2026-09-30 / 方針 5 の reindex() の SQL の定数化をやめた / 使う側が無く未使用の export になる / Go 不要
