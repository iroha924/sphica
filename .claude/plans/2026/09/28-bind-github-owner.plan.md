---
kind: plan
status: approved
codex_session: 01a0e514-6a9b-7c42-a086-d1b2b51f6198
codex_rounds: 3
approved_at: 2026-09-28
---

# sphica init でログイン中の GitHub アカウントを owner として登録し、他人のリポジトリに出した自分の PR の発言も採用できるようにする（#173）

## 要点

- `sphica init` が `gh api --hostname github.com user` を読み、owner 接続で `owner_identity` に 1 件だけ登録する。gh が無い・未ログイン・応答が不正なら、理由を分けて警告を出し、init は成功のまま
- 登録済みの ID と違うアカウントで init を流しても追加しない（警告だけ）。2 つ目のアカウントの追加と登録の解除はこの計画に入れない
- ingest 接続（記録の MCP サーバーと init の登録）から `owner_identity` を書けなくする。書けるのは owner 接続だけになる
- `sphica doctor` に登録済みのアカウントを表示する。未登録は警告にしない
- PR の取得（`gh(repo)`）も `--hostname github.com` に固定する
- 変えないもの: harvest・glean は登録しない、スキーマ、採用の規則（`owner_statement` / `explicit`）、登録より前に取り込んだ発言（`person` のまま）

## 持ち主の決定

- issue #173 をやる（2026-09-28）
- CLI は init・doctor・uninstall だけ（CLAUDE.md `record-writes`）。API キーや追加の課金が要る機能を入れない。Windows でも動く

## 目的

`sphica init` を gh にログインした状態で流した後、そのアカウントが CONTRIBUTOR として書いた PR を harvest すると、本文が `author_kind = 'owner'` で保存され、それを採用に引いた decision が active で保存される。今のコードでは同じ操作で `person` になり、記録は candidate に留まる。

## 対象外

- 登録より前に保存した `person` の発言と、それを引いた candidate の記録の見直し。source は変更できず（`source_no_update`）、本文が同じなら storeItems は既存の行を返すので、自動では owner にならない
- 2 つ目以降のアカウントの追加、登録の解除、アカウントの付け替え（後で意図を示せる操作として別に設計する）
- github.com 以外のホスト（GitHub Enterprise）

## 前提

- db/schema.sql:26-34 `owner_identity(provider, external_id, login, bound_at)`。コメントは「owner が CLI から設定する」。複数行を許す
- db/schema.sql:105-109 `source_owner_bound` は、登録済みの ID でない外部の発言を `owner` として入れるのを拒む
- server/src/github.ts:293-305 `storeItems` は `owner_identity` の ID と作者の数値 ID を突き合わせて owner / bot / person を決める
- 本番コードに `owner_identity` への insert は無い（server/test/github.test.ts:165、server/test/schema.test.ts:148 だけ）。sphica の記録にもこの件の判断は無い（search、2026-09-28）
- server/src/db-write.ts:117-120 `ingestAuthorizer` は DDL と pragma 以外のすべての DML を許す
- server/src/sqlite.ts:51-69 `prepare()` の `"generation"` は revision を見ない。owner 接続は generation だけを確かめる。server/src/admin.ts:53-73 の `dbInit` は既存の DB の revision が違っても表示して戻る
- server/src/github.ts:39-53 `gh(repo)` は `gh api repos/<repo>/...` を execFile で流し、JSON を unknown で受ける。`gh api` は `--hostname` と `GH_HOST` でホストが変わる（Codex が `gh api --help` で確認）
- server/evals/acceptance/driver.ts:104-116 は `cli("init")` の後で偽の gh を PATH に置く
- README.md / README.ja.md:72 は init を「DB を作りリポジトリを登録する」とだけ書き、:125 のネットワークの節は gh を流すのは harvest と glean だけと書く

## 方針

- server/src/github.ts
  - `gh(repo)` の引数に `--hostname github.com` を足す
  - `ghUser()` を足す。`gh api --hostname github.com user` を流し、`{ id: number, login: string }` を返すか、失敗の種類を返す: `missing`（gh が無い: ENOENT）/ `failed`（終了コードが 0 でない: 未ログイン・ネットワーク）/ `unexpected`（JSON でない、`id` が正の安全な整数でない、`login` が GitHub のログイン名の形 `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$` でない）。execFile の実体は差し替えられるようにしてテストする
- server/src/admin.ts
  - `bindOwner(user, file)` を足す。owner 接続で `pragma user_version` を読み、`SCHEMA_REVISION` でなければ何もせず `skipped` を返す。github の行が無ければ insert して `bound`、同じ ID があれば `already`、別の ID があれば何もせず `other`（登録済みの login と ID を添える）を返す
- server/src/cli.ts
  - `init` は `dbInit()` の後、プロジェクトの登録とは別に（remote の無いリポジトリでも）`ghUser()` と `bindOwner()` を流し、1 行出す: `bound <login> (id N)` / `already bound` / warn `gh is signed in as <login> (id N), but <login> (id M) is bound; not added` / warn `GitHub account not bound: <gh not found | gh api user failed>. Run gh auth login, then sphica init again` / warn `GitHub account not bound: unexpected response from gh api user`。どれも init を失敗させない
  - init のヘルプに GitHub アカウントの登録を書く
  - `doctor` は reader 接続で `owner_identity` を読み、`GitHub owner  <login> (id N)` を ok、無ければ `none`（`bind it with sphica init while gh is signed in`）で出す。none は issues に数えない
- server/src/db-write.ts: `ingestAuthorizer` で `owner_identity` への INSERT / UPDATE / DELETE を拒む
- server/evals/acceptance/driver.ts: 偽の gh を `cli("init")` の前に PATH に置く。偽の gh は `api user` に world の任意の欄（owner の GitHub アカウント）から答え、欄が無ければ 0 でない終了コードで終わる（ログインしていない gh と同じ）。`--hostname github.com` を受け付ける。受け入れケースを 1 件足す: 登録した ID が CONTRIBUTOR として書いた PR 本文を harvest し、それを採用に引いた decision が active で保存される
- 文書: README.md と README.ja.md（init の説明、ネットワークの節、要件の gh の行）、plugin/skills/harvest/SKILL.md の「Who adopts」に、sphica init で登録した自分の GitHub アカウントの発言は owner として採用できると書く
- テスト（実 SQLite、外部 API に繋がない）
  - red: 登録した ID が CONTRIBUTOR として書いた PR を storeItems → `owner`、それを引いた記録が active。今のコードでは登録手段が無く失敗する
  - ingest から `owner_identity` への insert / update / delete が拒まれる
  - bindOwner: 初回 bound、同じ ID で already、別の ID で other かつ行は 1 件のまま、revision 違いで skipped
  - ghUser: 不正な応答（id 無し、id 0、id が文字列、login が空）は unexpected で未ログインの文言にならない。0 でない終了は failed、gh が無いのは missing。`gh(repo)` と `ghUser()` が `--hostname github.com` を渡す
  - sql:live: 一時 HOME と PATH 先頭の偽の gh で `sphica init` を子プロセスとして流し、登録される。gh が失敗しても init は 0 で終わる。`sphica doctor` がアカウントを表示する
- 出荷: `bun run release:plan -- --base <前回のリリースのコミット>` の種別に従い、npm と 3 つの plugin manifest のバージョンをそろえる。npm pack して中身を確かめ、CI を最後まで見る

## 採った案と棄却した案

- 採用: `sphica init` で owner 接続から登録する。棄却: harvest_begin で毎回登録する（モデルが呼ぶ記録サーバーに owner を作る権限を与え、その時の gh のアカウントを黙って登録する）、専用コマンド（CLI を init・doctor・uninstall の外へ広げる）
- 採用: 登録は最初の 1 件だけ、別の ID は警告して追加しない。棄却: init のたびに gh のアカウントを追加する（切り替えたアカウントにも永続的に owner 権限が付く。C2）
- 採用: doctor で未登録を中立の none にする。棄却: 警告にする（gh を使わない人にも毎回「要対応」が出る。C6）
- 採用: 登録前の発言は対象外と明記する。棄却: 既存の source を owner に書き換える（source は変更できず、採用の来歴を壊す。C8）
- 採用: `gh api` のホストを github.com に固定する。棄却: gh の既定に任せる（GH_HOST で別ホストの数値 ID を github.com の owner として扱い得る。C13）

## 手順

- S1: ingestAuthorizer で `owner_identity` への書き込みを拒む、とそのテスト
- S2: `gh(repo)` と `ghUser()` の `--hostname github.com`、`ghUser()` の応答の検証、とそのテスト
- S3: `bindOwner()`（revision の確認、bound / already / other / skipped）とそのテスト、storeItems と記録の保存までの red のテスト
- S4: init での登録と表示、init のヘルプ、doctor の表示、sql:live
- S5: 受け入れのドライバー（偽の gh を init の前に置く、`api user`、`--hostname`）と受け入れケース
- S6: README.md、README.ja.md、harvest Skill の文書
- S7: release:plan に従うバージョンの更新

## 完了条件

- A1: `bun run verify` → 0 で終わる
- A2: `bun run test` → 登録した ID が CONTRIBUTOR として書いた PR 本文が `owner`、それを引いた記録が active の検査を含めて通る
- A3: `bun run acceptance` → 登録した ID の CONTRIBUTOR の PR 本文を採用した decision が active になるケースを含めて通り、既存ケースの結果は変わらない
- A4: `bun run sql:live` → init が偽の gh で登録し、gh の失敗でも 0 で終わり、doctor がアカウントを表示する検査が通る
- A5: `rg -n "insertInto\(\"owner_identity\"\)|into owner_identity" server/src` → server/src/admin.ts の 1 件だけ
- A6: `npm pack` → tarball をリポジトリの外に展開し、一時 HOME と偽の gh を PATH 先頭に置いて `sphica init` と `sphica doctor` を流すと、`bound` の行と doctor の `GitHub owner` の行が出る
- A7: `gh pr checks <PR 番号> --watch` → 全項目 pass

## リスク

- gh のログイン中のアカウントが持ち主のものでない共有のマシン → 表示した login で気づけるようにする。解除はこの計画に無いので、DB を作り直すしかないことを README に書く
- 偽の gh を init の前に置くことで既存の受け入れケースの結果が変わる → world に欄が無いときは未ログインと同じにし、既存ケースが今と同じ結果か verify で確かめる
- `--hostname github.com` で、GH_HOST を enterprise に設定して harvest していた人の動作が変わる → project key は github.com しか扱わないので本来の範囲。リリースノートに書く

## 未解決

なし

## 変更履歴
