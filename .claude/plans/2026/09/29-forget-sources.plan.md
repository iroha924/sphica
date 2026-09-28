---
kind: plan
status: approved
codex_session: 01a0e8f8-bc01-7341-ab4b-fe5484efba69
codex_rounds: 4
approved_at: 2026-09-29
---

# 持ち主が選んだ source を、索引と残りのバイトごと消し、それを根拠にした記録を判定し直す（W2、#187）

## 要点

- `/sphica:forget` から、持ち主が選んだ source（セッションの発言、PR の項目、ファイルの抜粋）を消せるようにする。record サーバーに `forget_preview` と `forget_apply` を足し、CLI は増やさない
- 消す前に MCP の elicitation で人に確認する。入力必須の欄に件数を打ち込ませ、対応していないホスト・拒否・不一致のときは何も書かない
- 消すと、`source` の行・`source_fts` の項目・DB と WAL に残るバイトが消える。それを根拠にしていた有効な記録は、保存時と同じ規則で判定し直し、支えが足りなければ candidate へ戻す
- 消した source は墓標（元の id と本文のハッシュだけ）を残し、capture・harvest・glean が同じものを取り込み直さないようにする
- そのために schema を revision 2 に上げる。世代 2 で初めての移行になるので、`sphica init` が revision 1 の DB を 1 つのトランザクションで移行する仕組みも作る
- 変えないもの: CLI のコマンド（init / doctor / uninstall）、記録の本文（unit の本文・選択肢・anchor の抜粋・work）は消さずに残し、そう表示する

## 持ち主の決定

- #187: 消すのは持ち主が選んだ source。全履歴の自動の期限切れは採らない（履歴そのものが製品のため）（issue 本文）
- 選別の順序で W1 の次に W2 を進める（2026-09-28）
- 削除の入口は MCP ツールと `/sphica:forget` Skill にする。`sphica doctor --forget` は採らない（2026-09-29、議論の 3 往復目の後に持ち主が選択）
- CLI は init / doctor / uninstall だけ（0.5.0 の再構築時の持ち主の決定）

## 目的

- 有効な記録が根拠にしている source を消すと、その行と `source_fts` の項目が無くなる。その根拠だけで有効だった記録は candidate になる（#187 の完了条件）
- 消した source の文字列が、掃除の後の DB ファイルと WAL のバイト列に見つからない
- 消したものと同じ内容を harvest・glean・capture が再び保存しない
- revision 1 の DB が `sphica init` で revision 2 になり、記録を失わない

## 対象外

- 記録の本文（`unit` の text・why・選択肢、`unit_anchor.excerpt`、`work`、撤回の `retraction_reason` の引用）の削除。#187 が求めるのは記録の判定し直しで、削除ではない。残ることを preview と結果で示す
- セッション・プロジェクト単位の削除、自動の期限切れ
- capture の spool と rejected のファイル、バックアップなど、DB の外の複製。preview と結果で示す
- CLI からの削除（持ち主の決定）

## 前提

- `source` は更新できない（`db/schema.sql:115`）。消すと `unit_evidence`・`unit_adoption`・`source_processing` は cascade で消え、`*_no_delete` トリガーは source が無いので通す（`db/schema.sql:479-486`）
- `unit_state.source_id`・`unit_evidence.retraction_source_id`・`unit_adoption.retraction_source_id`・`external_reference.owner_source_id` は削除時の動作なしで `source` を参照する。`foreign_keys = on`（`server/src/sqlite.ts:53`）。有効化のたびに `unit_state.source_id` へ最初の根拠を入れる（`server/src/record.ts:~605`）ので、有効な記録が根拠にする source は今は消せない
- 実測（node:sqlite 24.15、2026-09-29）: 動作なしの FK は親の削除を拒否する。`on delete set null` は子の update トリガーを発火させる（凍結トリガーがあると親の削除も止まる）
- 実測: 秘密の文字列を DB と WAL から消すには、`secure_delete = on` での削除 → `insert into source_fts(source_fts) values('optimize')` → `wal_checkpoint(TRUNCATE)` の 3 つがそろう必要がある。`optimize` が無いと FTS の segment に残り、VACUUM でも消えない
- 実測: defensive モードと authorizer の下で `optimize` は通る。authorizer には FK の cascade と set null がトリガー名なしのふつうの delete / update として、FTS の内部テーブルへの書き込みも見える
- 世代 2 に移行の仕組みは無い。revision が合わないと reader と ingest は止まり、DB を退避して `sphica init` するよう案内する（`server/src/sqlite.ts:60-68`）。`assets.ts` と `scripts/bundle.mjs` は migrations の同梱を想定している
- capture は同じ発言を送り直さない（フックのイベントごと）。ただし spool に残っていれば再送する（`server/src/capture.ts:644-749`）。capture の id には本文の digest が入る（`capture.ts:~379`）
- harvest は最新の revision のハッシュとだけ比べる（`server/src/github.ts:397-455`）ので、消すと次の harvest で戻る。glean の抜粋も同じ（`server/src/glean.ts:447-485`）
- superseded と withdrawn は後の有効化で戻さない（`server/src/glean.ts:687`）
- `unit_state.run_id` の非 NULL を前提に読むコードは無い（`read.ts:135` は run_id を読まない。Codex も確認）
- elicitation（調べた日: 2026-09-29。researcher と Codex が別々に調べて一致）: Claude Code は対話のダイアログで出す。ただし持ち主が設定した `Elicitation` フックはダイアログを出さずに答えられる（https://code.claude.com/docs/en/hooks#elicitation）。Codex は自動承認の下では欄の無いスキーマを accept、`approval_policy = never` では decline する（codex-rs/codex-mcp/src/elicitation.rs）。0.151 の TUI にはフォームの不具合の報告がある（openai/codex#41797）。人だけが答える保証にはならない
- SDK 1.30.0: `elicitInput` は client が `elicitation.form` を宣言していないと例外を投げる（`server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js:340-373`）。Claude Code が `form` を宣言するかは未検証
- record サーバーのツール一覧はテストで固定している（`server/test/plugin.test.ts:463-495`）

## 方針

### schema revision 2（`db/schema.sql` と `db/migrations/0002.sql`）

- 新しい表
  - `forget_batch (id integer primary key autoincrement not null, project_id integer not null references project (id) on delete cascade, at text not null <時刻の check>) strict`
  - `source_forgotten (source_id integer primary key not null, project_id integer not null references project (id) on delete cascade, artifact text not null, kind text not null, external_id text not null, content_hash blob not null check (length(content_hash) = 32), batch_id integer not null references forget_batch (id)) strict`、unique (project_id, artifact, kind, external_id, content_hash)。`source_id` は元の id で、FK は付けない。本文は持たない
- `unit_state` を作り直す（SQLite の 12 手順。https://www.sqlite.org/lang_altertable.html#otheralter）
  - `source_id integer references source (id) on delete set null`
  - `run_id integer references extraction_run (id)`（null を許す）と `forget_id integer references forget_batch (id)`、`check ((run_id is null) <> (forget_id is null))`
  - `unit_state_append_only` は、source が無くなって `source_id` だけが null になる更新（他の列は変わらない）だけを通す
  - `unit_state_project` は、`run_id` があれば `extraction_run`、`forget_id` があれば `forget_batch` と project を照合する
- トリガーの変更（作り直しは不要）
  - `unit_evidence_no_delete` / `unit_adoption_no_delete`: 撤回済みで、`retraction_source_id` が `source_forgotten` にある行だけ、削除を通す
  - `unit_rev_evidence_d` / `unit_rev_adoption_d` を足す: `after delete ... when exists (unit)` で revision + 1（明示の削除にも cascade にも効く）
  - `capture_message_insert`: `source_forgotten` に (session の artifact, 'session_message', external_id, content_hash) があれば挿入しない。view の列は変えない
- 末尾を `pragma user_version = 2`、`SCHEMA_REVISION = 2`。`bun run codegen` で `db-types.ts` を作り直す

### 移行（`server/src/admin.ts`、`sphica init`）

- `sphica init` が revision 1 の DB を見つけたら、退避を案内せずに移行する。owner 接続で、トランザクションの外で `foreign_keys = off` にする → `begin immediate` → `0002.sql` → `pragma foreign_key_check` が空であることを確かめる → commit → `foreign_keys = on` に戻す（失敗したら rollback してから戻す）
- バックアップは作らない（DDL のトランザクションで元に戻る。消したいものの複製を増やさない）
- reader と ingest が revision 1 を開いたときは「`sphica init` を実行する」と案内する。capture は世代しか見ないので、移行の前後も書き続ける

### 削除の処理（`server/src/forget.ts` を新設）

- `plan(db, projectId, ids)`: id ごとに、存在する / 消し済み（`source_forgotten` にある）/ どちらでもない（入力エラー）/ 別のプロジェクト（入力エラー）に分ける。影響する記録を key ごとに、予測する結果（active → candidate / active のまま / 撤回済みの行を n 件削除）付きで返す。source の本文は返さない
- `apply(file, projectId, ids, confirmed)`: forget 接続で `begin immediate` → `plan` を計算し直し、確認済みのものと違えば何も書かずに中止する → `pragma secure_delete = on` → forget_batch と墓標を挿入 → 撤回の理由が消える source にある撤回済みの evidence / adoption を削除 → その source を引く `external_reference` を削除 → source を削除（cascade と set null と FTS トリガー）→ 影響した有効な記録ごとに active → candidate（`forget_id`、理由 `source s<id> forgotten by the owner`）を入れ、続けて candidate → active を試す。`unit_state_rules` が拒否すれば candidate のまま → commit
- 掃除: commit の後に `optimize` と `wal_checkpoint(TRUNCATE)` を行い、結果を確かめる。busy なら「掃除が終わっていない、同じ操作をもう一度実行すると終わる」と返す。消し済みの id だけを渡すと、掃除だけを行う
- 判定し直す規則: active の記録だけを、保存時と同じ `unit_state_rules` で判定する。candidate・superseded・withdrawn の状態は変えない。後継が candidate になっても、前の記録は戻さない。commit の anchor を持つ implementation は、anchor が別の根拠なので active のまま

### 接続の役 forget（`server/src/db-write.ts`）

- `WriteRole` に `forget` を足す。開くときに revision を確かめる
- authorizer は大まかな防御として、読み取り、`forget_batch`・`source_forgotten`・`unit_state` への insert、`source`・`external_reference`・`unit_evidence`・`unit_adoption`・`source_processing` の delete、`unit_state` と `unit` の update、FTS の内部テーブル、`secure_delete` と `wal_checkpoint` の pragma を許す。そのほかは拒否する。実際に許す操作の一覧は、実 schema で動かして決める。「optimize だけ」「cascade だけ」には authorizer では絞れないので、書く SQL を `forget.ts` に固定する
- ingest の authorizer は、`forget_batch` と `source_forgotten` への書き込みと、`source` の delete を拒否する（抽出のツールが削除の例外を使えないようにする）
- CLAUDE.md と AGENTS.md の connection-roles の行に forget を足す

### MCP ツールと Skill

- `server/src/mcp-record.ts` に run に結び付かない 2 つを足す
  - `forget_preview { cwd, sources: ["s12", …] }` → `plan` の結果
  - `forget_apply { cwd, sources }`（destructive の注記）→ `plan` → elicitation（フォーム）→ `apply`。フォームの欄は必須の文字列 `confirm` 1 つで、消す件数と一致しなければ中止する。client がフォームの elicitation を宣言していない・decline・cancel・エラー・時間切れのときは何も書かず、理由を返す
- `plugin/skills/forget/SKILL.md`: read サーバーの `search`（`sources: true`）と `read s<id>` で候補を探し、秘密を引用し直さずに id と短い説明だけを持ち主に見せる → `forget_preview` → `forget_apply`。ダイアログに答えるのは持ち主の操作だと書く
- record サーバーの説明、ツール一覧のテスト、Skill の allowed-tools を合わせて直す

### 取り込み直しを止める

- harvest の `storeItems` と glean の抜粋の保存は、墓標と (artifact, kind, external_id, content_hash) が一致すれば保存しない。本文が変わった（ハッシュが違う）ものは新しい revision として保存する（新しい発言として扱う）

## 採った案と棄却した案

- 採用: MCP ツールと `/sphica:forget`。棄却: `sphica doctor --forget`（持ち主が MCP を選んだ）
- 採用: 必須の入力欄を持つ elicitation で確認し、fail closed にする。棄却: モデルが渡す確認の引数だけ（モデルが埋められる）
- 採用: 行を消す。棄却: source の本文だけを空にする（`source_no_update` の例外と span の扱いがかえって増える）
- 採用: `unit_state` だけを作り直し、`forget_batch` を足す。棄却: `extraction_run.origin` に forget を足す（多くの FK の親を作り直すことになる）
- 採用: 撤回の理由が消える撤回済みの行は削除する（トリガーの変更だけで済む）。棄却: その source の削除を拒否する（#187 の対象を狭める）／`unit_evidence` と `unit_adoption` を作り直して理由を null にする
- 採用: 移行の前にバックアップを作らない。棄却: `sphica.db.rev1.bak` にコピー（消したい本文の複製が残る）
- 採用: `secure_delete` + FTS の `optimize` + `wal_checkpoint(TRUNCATE)`。棄却: VACUUM（実測で FTS の語が残った）
- 採用: 記録の本文は残して表示で知らせる。棄却: 影響した記録も消す（#187 は判定し直しを求めている）

## 手順

- S1: schema revision 2（新しい表、`unit_state` の作り直し、トリガー、`SCHEMA_REVISION`、codegen）と `db/migrations/0002.sql`。新しい DB と移行した DB の一致を確かめるテスト
- S2: `sphica init` による移行と、reader・ingest の案内の文言
- S3: 接続の役 forget と、ingest の authorizer の制限。`db.test.ts` の許可と拒否
- S4: `forget.ts` の plan と apply（判定し直し、確認のずれの検出、掃除）
- S5: harvest と glean の墓標の照合（capture の照合は S1 のトリガーで入る）
- S6: record サーバーの `forget_preview` / `forget_apply` と elicitation、ツール一覧のテスト、サーバーの説明
- S7: `/sphica:forget` Skill、CLAUDE.md と AGENTS.md の connection-roles、受け入れケース
- S8: `release:plan` に従ってバージョンを上げ（npm と 3 つの manifest）、リリース手順に移行の確認を入れる

## 完了条件

- A1: `bun run verify` → 全部通る
- A2: `cd server && node --test test/forget.test.ts` → #187 の完了条件のテスト（有効な記録が引く source を消すと、行と `source_fts` の項目が無くなり、記録が candidate になる）と、根拠が 2 つある記録が active のまま残るテストが通る
- A3: `cd server && node --test --test-name-pattern=bytes test/forget.test.ts` → 消した source の文字列が、掃除の後の DB ファイルと WAL のバイト列に無いテストと、記録の本文に写っている場合は残るテストが通る
- A4: `cd server && node --test test/migrate.test.ts` → revision 1 の DB（前のリリースのタグの `db/schema.sql` から作る）を移行すると、新しい revision 2 の DB と表・索引・view・トリガーの定義が一致し、`foreign_key_check` が空、`integrity_check` が ok、移行後に capture の書き込みと record の保存が通る
- A5: `cd server && node --test --test-name-pattern=tombstone test/*.test.ts` → harvest・glean・capture で、消したものと同じ内容は保存されず、本文を変えたものは保存されるテストが通る
- A6: `bun run sql:live` → 移行済みの DB に capture の子プロセスが書き込める
- A7: `SPHICA_DB=<使い捨ての DB> claude` → 対話で `/sphica:forget` を実行するとダイアログが出る。件数を正しく打つと消え、decline と件数の不一致では何も消えない（手で確かめ、結果を PR 本文に書く）
- A8: 更新した global CLI で、revision 1 の DB の複製を `SPHICA_DB` に指して `sphica init` と `sphica doctor` → revision 2 になり、doctor が問題なしと出す
- A9: `gh pr checks <PR>` → Windows を含む全ジョブが pass

## リスク

- Claude Code が `elicitation.form` を宣言せず、SDK が例外を投げる → A7 で分かる。そうなら capability を自分で読み、`elicitation/create` を直接送る形にする（fail closed は変えない）
- Codex の TUI でフォームが動かない → Codex では削除できず、理由を返す。Skill と結果に「Claude Code で実行する」と書き、限界として PR に残す
- 読み手のセッションが WAL を握っていて、checkpoint が busy になる → 掃除が終わっていないと返し、同じ操作をもう一度実行すれば終わる
- 移行の途中の失敗 → 1 つのトランザクションで rollback され、revision 1 のまま残る。案内を出して止める
- 持ち主が設定した Elicitation フックや自動承認で、確認が素通りする → 持ち主自身の設定なので防げない。Skill に書く

## 未解決

なし

## 変更履歴
