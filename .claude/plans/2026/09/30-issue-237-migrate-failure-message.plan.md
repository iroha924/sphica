---
kind: plan
status: approved
codex_session: 01a0f226-6591-73c2-adfc-9b960770fa80
codex_rounds: 3
approved_at: 2026-09-30
---

# #237: 移行ステップが commit されていない失敗では、バックアップへ戻す案内を出さず、その実行のバックアップを消す

## 要点

- `migrate()` が失敗したとき、失敗後の revision を移行前と比べて文面を 3 つに分ける: commit されていない / 進んだ / 確かめられない
- commit されていないときは「バックアップで置き換える必要は無い」と言い、この実行が作ったバックアップだけを消す。古い世代は減らさない
- 進んだとき・確かめられないときは、今の復元手順を出してバックアップを残す
- 原因ごとの案内を足す: ロックなら「書き込みが終わってからもう一度」、移行スクリプトが無いなら「sphica を入れ直す」（今の「DB を脇へ移せ」をやめる）
- ロックのテストは CLI を子プロセスで流し、出力・終了コード・revision・バックアップの数を見る
- 0.6.14 として出す（npm と 3 つの plugin manifest）
- 変えないもの: バックアップの作り方、成功時の刈り込み、schema（revision 4 のまま）、接続ロール、busy timeout、成功時の `sphica init` の出力

## 持ち主の決定

- #237 を次に直す（revision を上げるリリースの前に直す、という前回の記録どおり）。1 issue = 1 PR
- 「修正」は、直す前のコードで落ちる再現テストを先に書き、修正後に通れば採用
- パッケージに入る変更は、npm と 3 つの plugin manifest のバージョンを同じ PR で上げる
- #201 の計画で決めたことは変えない: 刈り込みは移行が全部 commit した後だけ、復元コマンドは作らない、自動移行はしない

## 目的

- 別の接続が書き込みロックを持っていて `sphica init` の移行が始まらなかったとき、出力に復元手順が出ず、「commit されていない」「もう一度流す」が出て、`backups/` にその実行のバックアップが残らない
- 失敗を繰り返しても、フルサイズのバックアップが 1 回ごとに増えない
- 1 ステップ以上 commit された後の失敗では、今どの revision かと復元手順が出て、バックアップが残る

## 対象外

- 並行した別の init の刈り込みで、案内するバックアップが消えている場合の対処（リスクに条件を書く）
- rollback が失敗したときに元のエラーが置き換わること（`immediate()` の今の動き）
- バックアップの前に書き込みロックを試すこと（採った案と棄却した案）
- busy timeout の変更、移行の自動の再試行

## 前提

- `migrate()` は `server/src/admin.ts:110-148`。バックアップ（114）→ revision ごとに `immediate()`（125）→ 失敗は catch（139-144）で必ず復元手順を付けて投げ直す。`prune()` は成功時だけ（145）
- `immediate()`（83-93）は `begin immediate` の外で失敗すると rollback せずに投げ、中で失敗すると rollback して元のエラーを投げ直す。rollback 自体が失敗するとそのエラーに置き換わり、トランザクションが開いたまま残り得る
- 各ステップは書き込みロックの下で `versionOf(raw) !== r - 1` なら何もせず return する（126）。並行した別の init が進めた revision も読める
- revision が同じでも DB は変わり得る: capture は同じ revision の DB に書ける（`server/src/db-write.ts:195-197`）
- 実測 2026-09-30（Node 24.15.0、rev3 fixture、同じプロセスの別の owner 接続が `begin immediate` を保持）: `migrate(file)` は 5197 ms 後に `database is locked` + 復元手順で落ち、revision は 3 のまま、`backups/` に 1 つ残る
- busy のエラーは `code: "ERR_SQLITE_ERROR"`, `errcode: 5`。primary result code を取る関数が `server/src/db.ts:68-71` にある。`DatabaseSync.isTransaction` は boolean（実測 2026-09-30）
- `fs.rmSync` の `force` が無視するのはパスが無いときだけ（https://nodejs.org/download/release/latest-v24.x/docs/api/fs.html 、2026-09-30 Codex が確認）
- バージョン入りの案内は `server/src/sqlite.ts:76` が `packageVersionAt(ROOT) ?? "latest"` で作っている（`server/src/plugin.ts`）
- CLI は `boxed()`（`server/src/cli.ts:375-391`）で失敗を `stopped(plain(reason(e)))` に通し、終了コードを 1 にする
- 既存のテスト: `server/test/admin.test.ts:521-566`（1 ステップ commit 後の失敗。復元手順どおりに戻せることまで見る）、CLI を子プロセスで流す形は 187-191
- テストの時間制限は 1 件 60 秒（`server/package.json` の `--test-timeout=60000`）

## 方針

1. `server/src/admin.ts` の `migrate()` の catch を 3 分岐にする
   - 確定した revision を読む: `raw.isTransaction` が true なら読まない（未 commit の値が読め、接続を閉じれば巻き戻る）。false なら `versionOf(raw)`、読み取りが失敗したら「確かめられない」
   - commit されていない（トランザクションが開いておらず、revision が `from` と同じ）
     - この実行のバックアップを `fs.rmSync(backup, { force: true })` で消す。try で囲み、消せたかどうかを文面に出す。`prune()` は呼ばない
     - `<元>. No migration step was committed: the database is still at revision <from>, and there is no need to replace it with a backup (the backup made for this run was removed).`
     - 消せなかったとき、括弧の中は `the backup made for this run is still at <path>; delete it yourself`
     - 元のエラーの primary result code が 5（busy）のときだけ、続けて `Another process is writing to the database. Run \`sphica init\` again when it has finished.`
   - 進んだ（revision が `from` と違う）
     - `<元>. The database is now at revision <now> (this run, or another \`sphica init\` running at the same time, migrated it that far). The database before migrating is at <backup> (anything recorded after it was made is not in it). To go back to it, …今と同じ復元手順…`
   - 確かめられない（トランザクションが開いたまま、または読み取りが失敗）
     - `<元>. The committed revision could not be confirmed after the failure. The database before migrating is at <backup> (…今と同じ復元手順…)`
   - 復元手順の文は 1 か所に置き、進んだ・確かめられないの両方から使う
2. 移行スクリプトが無いときの文（`server/src/admin.ts:119-122`）
   - `No migration from revision N. Move the database aside, then run \`sphica init\`.` を `This Sphica has no migration script for revision <r> (<script のパス> is missing). Reinstall sphica (\`npm i -g sphica@<version>\`), then run \`sphica init\` again.` に置き換える。`<version>` は `packageVersionAt(ROOT) ?? "latest"`
3. テスト（`server/test/admin.test.ts`）
   - ロック（CLI）: 一時 HOME の `.sphica/sphica.db` を rev1 で作り、`backups/` に完成品の名前のファイルを 3 つ置く。テストのプロセスが owner 接続で `begin immediate` を持ったまま `spawnSync(node, [CLI, "init"], { env: { PATH: signedOut, HOME, USERPROFILE } })`。確かめる: 終了コードが 0 でない、出力に `Backed up:` の後で `No migration step was committed`・`was removed`・`Run \`sphica init\` again when it has finished` がある、`To go back to it` が無い、revision 1 のまま、`backups/` は前から置いた 3 つだけ。ロックを離してもう一度 CLI の init → 0 で終わり revision が `SCHEMA_REVISION`
   - スクリプトが無い: 空の移行ディレクトリで `migrate(file, dir)`。文面が `no migration script for revision 2`・`Reinstall sphica`・`No migration step was committed` を含み、`Move the database aside`・`To go back to it` を含まない。revision 1 のまま、バックアップが残らない
   - 既存の「1 ステップ commit 後の失敗」に、文面が `is now at revision 2` を含むことを足す
4. バージョンと出荷
   - `bun run release:plan -- --base v0.6.13` を流し、`plugin` なら `plugin/package.json`・`plugin/.claude-plugin/plugin.json`・`plugin/.codex-plugin/plugin.json`・`.claude-plugin/marketplace.json` を 0.6.14 にする（plugin-release Skill の手順どおり）

## 採った案と棄却した案

- 採用: commit されていないときは、この実行のバックアップだけを消す。棄却: 残して刈り込みの対象に数える（失敗時に `prune()` を走らせると #201 の「失敗を繰り返しても移行前の世代を失わない」に反し、残すだけなら失敗のたびに 1 つ溜まる）
- 採用: バックアップの後で失敗を見分ける。棄却: バックアップの前に書き込みロックを試す（`VACUUM INTO` はトランザクションの中で流せず、試した後にロックを離すので競合が残る。スクリプトが無い失敗も拾えない）
- 採用: 文面は「移行ステップは commit されていない」。棄却: 「DB は変わっていない」（バックアップの後に capture が同じ revision のまま書ける）
- 採用: 進んだ分岐は「この実行か、並行した別の init が進めた」。棄却: 「この実行が N で止まった」（別の init が進めた revision も読める）
- 採用: トランザクションが開いたままなら revision を読まず、バックアップを残す。棄却: そのまま読む（未 commit の値を表示する）
- 採用: 原因ごとの案内を、busy は catch で、スクリプトが無いときは投げる側の文で持つ。棄却: どの失敗にも「もう一度 `sphica init`」を足す（スクリプトが無いときは何度流しても同じ）
- 採用: ロックのテストは CLI の子プロセス 1 本。棄却: `migrate()` 直呼びと CLI の 2 本（5 秒を 2 回待つ）、ロックを子プロセスで持つ（同じ分岐なのにタイミング合わせが増える）
- 採用: 並行した init の刈り込みでバックアップが消える場合はリスクに書くだけ。棄却: 案内の前に存在を確かめる分岐（時計が戻った後か 3 つ以上の同時 init でしか起きず、再現手段の無い未テストの分岐が増える）

## 手順

- S1: ロックのテスト（CLI）とスクリプトが無いテストを足し、`migrate()` の catch を 3 分岐にして、スクリプトが無いときの文を置き換える（方針 1・2・3）
- S2: バージョンを 0.6.14 に上げる（方針 4）

## 完了条件

- A1: `bun run verify` → 0 で終わる
- A2: `cd server && node --test test/admin.test.ts` → ロックのテスト（CLI）、スクリプトが無いテスト、1 ステップ commit 後のテスト（`is now at revision 2` と復元手順）が通る
- A3: `bun run release:plan -- --base v0.6.13` → `plugin`。`plugin/package.json`・`plugin/.claude-plugin/plugin.json`・`plugin/.codex-plugin/plugin.json`・`.claude-plugin/marketplace.json` が 0.6.14 で一致する
- A4: `bun run bundle && cd plugin && node ../scripts/check-tarball.mjs "$(npm pack --silent)"` → 0 で終わる（tarball の init の移行が今までどおり通る）
- A5: `rg -n "Move the database aside" server/src` → 該当なし

## リスク

- 「確かめられない」分岐と「バックアップを消せなかった」文面はテストしていない（rollback と削除を失敗させる手段が無い） → 報告が来たら、その再現を fixture にしてテストを足す
- 並行した別の init が成功して刈り込むと、この実行のバックアップが消えていて、案内のパスが無いことがある。起きるのは、この実行のバックアップより名前の新しい完成品が別の init のもの以外に 2 つ以上あるとき（時計が戻った後か、3 つ以上の同時 init） → 報告が来たら、バックアップの存否と各候補の revision・中身を確かめ、別の issue で対処する（別の init のバックアップは、開始時の revision が違えば移行前の revision に戻せない）
- ロックのテストが busy timeout の 5 秒を待つ → `admin.test.ts` に 1 回だけ。60 秒の制限の内

## 未解決

なし

## 変更履歴
