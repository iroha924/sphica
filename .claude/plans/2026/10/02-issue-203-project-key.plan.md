---
kind: plan
status: approved
codex_session: 01a0fc97-dcd7-7273-aa1d-848189ea0dd8
codex_rounds: 4
approved_at: 2026-10-02
---

# Normalize project keys (the last item of #203) with schema revision 8, released as 0.6.21

## 要点

- remote から作る project の key で、host はどの形式（scp・ssh・git・https）でも小文字にし、host が github.com なら path も小文字にする。小文字化は ASCII の A-Z だけ（SQLite の `lower()` と同じ）
- schema revision 8 で、正規化されていない `git:` の key を insert / update で拒む trigger を足す（project テーブルは作り直さない）
- マイグレーション 0008 は、正規化すると同じ key になる project のグループのうち、中身（9 つの project_id を持つテーブルの行）があるのが 1 つ以下なら、空の重複を消して残りを正規の key に直す。中身のある project が 2 つ以上なら revision 8 を当てずに止め、一覧と「issue で知らせてほしい」案内を出す
- capture の spool には、今までの規則で作った key（legacyKey）を書き続け、送るときは完全一致 → 正規化した key の順で探す。revision 7 の DB でも 8 の DB でも行き先を取り違えない
- 変えないもの: `local:` の key、github.com 以外の path の大文字小文字、spool の形式（v2）、ほかのテーブル
- npm と 3 つの manifest を 0.6.21 にそろえて出す

## 持ち主の決定

- #203 の残り（project の key の正規化）をやる。既に分かれた project をマイグレーションでどうまとめるかは計画で決める（#203 本文）

## 目的

- 大文字小文字だけが違う remote（`git@GitHub.com:O/R`、`https://github.com/o/r` など）から、同じ project の key が出る
- 既存の DB は revision 8 に上がり、正規化されていない key が残らない。新しく書くこともできない
- 中身のある project が 2 つ以上ぶつかる DB では、revision 8 は当たらず、持ち主に何が起きていて何をすればよいかが出る

## 対象外

- 中身のある project どうしのマージ（session の id が project id から作られるので付け替えが要る。unit の key・work の key・field_def の名前・artifact_link・source の revision・tombstone ごとの方針も要る）。該当する DB が見つかっていないので、報告が来たら issue を立てる
- github.com 以外の host の path の小文字化（GitLab や自前のサーバーでは区別することがある）
- 非 ASCII の文字の大文字小文字（http/https の host は URL の parser が punycode にするので対象にならない。scp 形式の非 ASCII の host はそのまま残す）
- #203 のほかの項目（0.6.15・0.6.18 で済み）

## 前提

- `server/src/project.ts:26-39` `normalizeRemote`: scp 形式の分岐は host の大文字小文字を残す。URL の分岐は `new URL` の hostname を使い、https では小文字になるが `ssh://`・`git://` では小文字にならない（Codex が実行して確認: `ssh://git@GitHub.COM/O/R.git` → `GitHub.COM/O/R`）。path はどちらも残す
- GitHub REST API の owner と repo は大文字小文字を区別しない（https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request 、2026-10-02 に Codex が確認）。`server/src/github.ts:47` の `repoOf` は `git:github.com/` だけを拾う
- SQLite の `lower()` は ASCII だけを小文字にする（https://www.sqlite.org/lang_corefunc.html#lower）。JS の `toLowerCase()` は Unicode も変える（Codex が `BÜCHER.example` で再現）
- project_id を持つテーブルは 9 つ（`db/schema.sql:48,63,151,161,170,203,244,600,922`: session, source, artifact_link, forget_batch, source_forgotten, extraction_run, unit, field_def, work）。`sphica init` が書くのは project の行だけ（`server/src/cli.ts:316-322`）
- session の id は project id から作られる（`server/src/knowledge.ts:67`）ので、session を別の project へ動かすと次の capture が UNIQUE で落ちる（Codex が再現）
- マイグレーションは revision ごとに 1 トランザクションで commit し、`000N.check.sql` が `sphica_migration_stop` に行を入れると、その revision を当てずに止まる（`server/src/admin.ts:178-243`）。今の Stop の文面は「Sphica はそういう行を書かない」と言い、forget を勧める（`admin.ts:120-126`）
- capture は revision を見ずに書く（`server/src/db-write.ts:327-331` は generation だけを見る）。spool の key が登録済みの project に無い記録は unregistered/ へ移され、あとで送り直される（`server/src/capture.ts:667-735`）
- 持ち主の DB の project は `git:github.com/iroha924/sphica` の 1 つだけで、すでに小文字（2026-10-02 に read-only で確認）。ほかの利用者の DB は未確認

## 方針

- **正規化の関数**（`server/src/project.ts`）
  - `fold(s)`: `s.replace(/[A-Z]+/g, (m) => m.toLowerCase())`。ASCII だけを小文字にする
  - `normalizeKey(key)`: `git:` の key の host 部分（`git:` の後から最初の `/` まで、`/` が無ければ全体）を `fold` する。host が `github.com` なら key 全体を `fold` する。`local:` の key はそのまま。冪等
  - `normalizeRemote` は今の規則で remote を分解した結果（`legacyRemote`）を作り、`identify()` は `legacyKey = git:<legacyRemote>` と `key = normalizeKey(legacyKey)` の両方を返す（`Place` に `legacyKey` を足す）。`name` は正規化した key の path から作る
  - `legacyKey` を作る規則は 1 つの関数に置き、「revision 7 以下の DB に capture が書かなくなったら消せる」とコメントで書く
- **schema revision 8**（`db/schema.sql`、`db/migrations/0008.sql`、`0008.check.sql`、`server/src/sqlite.ts` の `SCHEMA_REVISION = 8`）
  - trigger `project_key_canonical_insert`（before insert on project）と `project_key_canonical_update`（before update of key on project）: `new.key glob 'git:*'` で、`new.key` が SQL で書いた `normalizeKey` と違えば `raise(abort, 'the project key is not normalized')`。SQL の式は schema.sql と 0008.sql で同じ文字列にする
  - `0008.check.sql`: 正規化した key が同じ project のグループのうち、9 テーブルのどれかに行がある project が 2 つ以上あるグループを、`sphica_migration_stop` に project ごとに入れる（id、key、テーブルごとの行数）
  - `0008.sql` の順序: (1) 各グループで残す project を決める（中身のある 1 つ、全部空なら id が最小のもの）、(2) 残さない空の project を delete、(3) 残す project の key と name を正規化した値に update、(4) trigger を作る、(5) `pragma user_version = 8`。消したもの・直したものは `sphica_migration_note` に 1 行ずつ書く。project の id・created_at・`sqlite_sequence` はそのまま
- **止まったときの文面**（`server/src/admin.ts`）: 今の Stop の文面は rule ごとに差し替えられるようにし、この rule では「revision 8 は当てていない。このバージョンの Sphica はこれらの project をまとめられない。まとめられる Sphica が移行するまで検索・読み取り・記録のツールは使えず、その間も capture は記録を続ける。下の一覧を issue で知らせてほしい」と出す。forget や DB の削除は勧めない。commit 済みの revision とバックアップの既存の報告（3 通りの文面）はそのまま
- **capture**（`server/src/capture.ts`）: spool の記録の `project` には `place.legacyKey` を書く。送るときは、`write()` の `BEGIN IMMEDIATE` のトランザクションの中で、記録ごとに完全一致で project を探し、無ければ key を正規化すると同じになる project が 1 つだけのときにそれを使い（2 つ以上なら unregistered/ に残す）、決まった id を同じトランザクションで session の id の導出と message・edit の書き込みに使う。1 件ずつ送り直すときも、そのトランザクションの中で探し直す（失敗したバッチの対応表を使い回さない）。トランザクションの中で見つからない記録は今までどおり unregistered/ へ置き、rejected/ へは移さない。unregistered/ に置かれた記録も同じ規則で送る。spool の形式（`v: 2`）は変えない
- **ほかの key の利用者**: init の登録、両 MCP サーバーの `projectId`、`writePlace`、delivery、`localRoots`/doctor、GitHub の harvest/glean は `identify().key` を使うので、正規化した key になる。`localRoots` は 2 つのディレクトリが同じ key になったら今までどおり ambiguous として扱う
- **リリース**: `bun run release:plan -- --base v0.6.20` が `plugin` を返したら、npm と 3 つの manifest を 0.6.21 にそろえる

## 採った案と棄却した案

- 採用: 中身があるのが 1 つ以下のグループだけ自動でまとめ、2 つ以上なら revision 8 を当てずに止める。棄却: 全部を SQL でマージする（session の id の付け替えと、project ごとの一意な値の方針が要り、該当する DB が見つかっていない）
- 棄却: ぶつかった方を `git:<host>/<path>#split-<id>` のような key に逃がす（どのリポジトリからも引けなくなり、記録が見えないまま残る）
- 棄却: 止まったときに forget を勧める（forget は project を消さないので、空でもぶつかったまま残る）
- 採用: 正規化を trigger で強制する。棄却: project.key の CHECK に足す（FK 9 本の親で AUTOINCREMENT のテーブルを作り直すことになる）
- 採用: ASCII だけを小文字にする。棄却: JS の `toLowerCase()`（SQLite の `lower()` と結果が変わり、マイグレーションと実行時で key がずれる）
- 採用: spool に legacyKey を書き、送るときに完全一致 → 正規化の順で探す。棄却: 送るときだけ正規化する（マイグレーション前の DB で、空の正規の project に新しい記録が入り、まとめられたはずのグループが止まる側に変わる。Codex が再現）。棄却: DB の revision を見て書き分ける（capture は revision を見ない設計）
- 採用: project の id を書き込みのトランザクションの中で引く。棄却: 今のようにトランザクションの前に引く（引いた後にマイグレーションが空の project を消すと FK で落ち、正しい記録が rejected/ へ移って送り直されない。Codex が再現）

## 手順

- S1: `project.ts` の `fold`・`normalizeKey`・`legacyKey` と `identify()` の変更、その単体テスト
- S2: schema revision 8（trigger、0008.check.sql、0008.sql、SCHEMA_REVISION）と、JS と SQL の正規化が同じ結果になるテスト、マイグレーションのテスト
- S3: Stop の文面を rule ごとにし、この rule の案内を足す
- S4: capture の spool に legacyKey を書き、送るときに書き込みのトランザクションの中で完全一致 → 正規化で探す
- S5: init・MCP の検索・localRoots を大文字小文字の混ざった remote で確かめるテスト
- S6: release:plan と、npm と 3 つの manifest の 0.6.21

## 完了条件

- A1: `cd server && node --test test/project.test.ts` → 混ざった大文字の scp・ssh・git・https の github.com の remote が `git:github.com/o/r` になり、github.com 以外の path と `local:` の key は変わらない
- A2: `cd server && node --test --test-name-pattern="revision 7" test/migrate.test.ts` → revision 7 の DB で (a) 衝突なしの改名で id・created_at・sqlite_sequence が残る、(b) 空の重複が消えて中身のある方が正規の key になる、(c) 中身のある 2 つの衝突で revision 7 のまま止まり、一覧と案内が出る、(d) revision 8 の定義が新しく作った DB と一致する、が全部 pass
- A3: `cd server && node --test --test-name-pattern="canonical key" test/migrate.test.ts` → 正規化されていない key の insert と update が trigger で拒まれ、正規の key・`local:`・host だけの key は通る
- A4: `cd server && node --test --test-name-pattern="parity" test/project.test.ts` → JS の `normalizeKey` と SQL の式が、Unicode を含む同じ key の一覧で同じ結果を返す
- A5: `cd server && node --test --test-name-pattern="legacy key" test/capture.test.ts` → revision 7 の DB（空の正規の project 1 と中身のある大文字の project 2）で、新しい hook の spool が 2 へ送られ、マイグレーション後の次の送信も 2 へ行く。古い位置で project を引いた後にマイグレーションを挟んでも、記録は 2 に入り rejected/ に何も無い
- A6: `bun run verify` → 0 で終わる
- A7: `npm pack` → 展開すると `db/migrations/0008.sql` と `0008.check.sql` が入っていて、展開先から `sphica init` で revision 7 の一時 DB が 8 になる
- A8: `gh pr checks` → 全部 pass

## リスク

- 利用者の DB に中身のある project が 2 つぶつかっていた → revision 8 で止まり、検索と記録のツールは使えないまま（capture は続く）。報告が来たらマージの道具を issue にする
- legacyKey の規則を消し忘れて残り続ける → コメントに消せる条件を書く
- trigger の SQL の式と JS の関数がずれる → A4 のテストで落とす

## 未解決

なし

## 変更履歴
- 2026-10-02 / A2 の test-name-pattern を "revision 8" から "revision 7" に / テストの名前が既存の「migrating revision N」に合わせて移行元の revision を名乗るため / Go 不要
- 2026-10-02 / 衝突で止まったときの案内から「0.6.20 と同じバージョンのプラグインを使い続ける」を外し、検索などは使えず capture は続くことと issue での報告だけにした / marketplace が 0.6.21 を指すので、プラグインを 0.6.20 に留める手順が無く、守れない案内になる（review-shipping の指摘）/ Go 不要（案内を出す範囲は同じ）
- 2026-10-02 / 正規化した key での検索を、正規化して一致する project が 1 つだけのときに限った / revision 7 の未移行の分割で、3 つ目の書き方の記録が空の project に入り、まとめられたはずの分割を止める側に変える（GitHub の Codex の P1、再現済み）/ Go 不要（送り先の規則を狭めるだけで範囲は同じ）
