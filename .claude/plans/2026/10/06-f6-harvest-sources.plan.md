---
kind: plan
status: approved
codex_session: 01a10e90-e3da-7a80-95dd-50da113002e5
codex_rounds: 2
approved_at: 2026-10-06
---

# harvest の実行が見る source を開始時のまま固定し、消された本文を空の版として残し、doctor の ~/Projects 探索をやめる（#264 + doctor）

## 要点

- harvest を始めたとき、その実行が見る source の id を新しい表 `harvest_run_source` に保存する。context・check・save はこの保存した一覧だけを見るので、別の harvest が新しい版を取り込んだり、PR の閉じる issue が変わったりしても、実行中の範囲は変わらない。持ち主が forget したものは、実行中でも外れる
- DB を revision 11 に上げる。移行のときに、走っている途中の harvest の実行（保存した一覧を持たないもの）を消して、移行のメモに 1 行ずつ残す。その実行 id を使い続けると「Begin again」が返る
- 本文を消した issue 本文、issue コメント、PR コメント、review、review コメントを、PR 本文と同じように空の今の版として保存する。前の版は根拠として残る
- doctor の Projects 欄から、~/Projects を探す処理（見つからない・複数のコピーの表示）をなくす。README の例を `cd path/to/your-repo` にする
- 変えないもの: GitHub で削除されたコメントの扱い、古い版の検索・read、既存の記録の状態、名前付きプロジェクトの表（`~/.sphica/projects.json`）、trace と glean の範囲

## 持ち主の決定

- 次の作業は GitHub Project の Phase 01 の束 F6（#264）にする（「OK」）
- README の `cd ~/Projects/your-repo` は ~/Projects が決め打ちに見えるので、同じ PR で直す（「次のPRでは上記の修正も一緒に混ぜて欲しい」）
- doctor が ~/Projects を探すこと自体をやめる。`localRoots()`、`projectsDir()`、Projects 欄の `(not found in ...)` と `(N copies: ...)` の表示、その関連テスト、`server/src/project.ts` の古いコメントを消す。0.6.32（#277）で入れた表示を取り消すことになるのも承知のうえ（「OK」）
- 名前付きプロジェクトの表（`localMap`、`nameLocal`）は init と記録で使うので残す

## 目的

- harvest の実行 A を始めた後で、同じ PR の別の実行 B がコメントの新しい版を取り込んだり、閉じる issue を変えたりしても、A の context は前と同じ source を出し、A はその source を引用した記録を check して save できる
- issue 本文、issue コメント、PR コメント、review、review コメントの本文が GitHub 上で空にされた後に harvest すると、その item の今の版は空になり、前の版は read で読める
- `sphica doctor` の Projects 欄が、リポジトリの置き場所によらず、名前・記録の件数・最後の取り込みの日時だけを出す。README に ~/Projects の例が無い

## 対象外

- GitHub で削除された item（応答に出てこないもの）の扱い。#264 が求めているのは空にされた本文で、応答に無いことと空であることは別。消えた item は今の版のまま残る
- 最新の版だけを検索する絞り込み、本文が空になった item を引用する記録を自動で取り下げること。古い版は検索と read に残り、それを引用する記録はそのまま有効
- 新しい acceptance case。これは既存の契約の修正で、driver の harvest は始めてすぐ保存する形なので A と B を交互に動かせない。実際の SQLite での結合テストで確かめる
- doctor が ~/Projects 以外の場所でリポジトリを探すこと（init した場所を覚えるなど）

## 前提

- `server/src/extract.ts:183-206` beginHarvest は GitHub から読んだ後、1 つの transaction の中で storeItems、linkIssues、openRun を行う。GitHub からの読み込みは transaction の外
- `server/src/extract.ts:273-307` scopeOf は harvest のとき `pullSources` の結果を `captured_at <= run.started_at` で絞り、context の表示と、記録が引用してよい source（`target.sources`）の両方に使う
- `server/src/github.ts:536-606` pullSources は `pr:N` と、今 `artifact_link` で結ばれている artifact の、各 item の最新の版を返す。forget した版より古い版は除く。並びは `created_at`、`id`
- `server/src/github.ts:503-531` linkIssues は、今の本文に無くなった closes のリンクを消す。`artifact_link` には時刻の列が無い（`db/schema.sql:165-171`）
- `captured_at`（`github.ts` の storeItems）と `started_at`（`server/src/trace.ts:132`）は、どちらも別々に `Date.now()` からミリ秒の精度で取る。時刻で絞る形では、同じミリ秒に重なると範囲が変わり得る（Codex がコードを読んで指摘。実行して再現はしていない）
- `server/src/github.ts:236-248` PR 本文は空でも item として渡す。`:430-435` storeItems は、一度も保存されていない空の item には行を作らない
- `server/src/github.ts:251`、`:265`、`:279`、`:341`、`:355` PR コメント、review、review コメント、issue 本文、issue コメントは、本文が空なら item にしない
- `db/schema.sql:100` source.text は空を許す。`server/src/text.ts:390` 空の引用は拒否される
- `server/src/search.ts:337` 検索は保存された全部の版を対象にする（最新の版に絞らない）
- `server/src/sqlite.ts` SCHEMA_REVISION は 10。`db/migrations/0010.sql` まである。`server/test/fixtures/` には schema-rev9.sql まで
- `server/src/admin.ts:231-255` migrate() は外部キーを切って移行し、commit の前に foreign_key_check を流し、移行のメモを出す
- 保存（`extract.ts:615-658`）は、記録・source_processing・状態・work を、実行を saved にするのと同じ transaction で書く。走っている途中の実行を参照する行は残らない（Codex がコードを読んで確認）
- `server/src/db-write.ts:145` ingest が insert してよい表、`:285` forget が消してよい表の一覧
- `server/src/project.ts:1-5` の冒頭コメントは「each machine finds them under ~/Projects when syncing」と書いている。localRoots を使っていた一括取り込みは 22d2294f（2026-09-26）で消えた。localRoots を今使っているのは doctor（`server/src/cli.ts:359-406`）だけ
- `server/src/project.ts:210` が node:os の唯一の使い道
- `server/evals/acceptance/driver.ts:458-469` harvest は始めてすぐ取り込み、`:1455-1468` 編集は PR 本文だけ（Codex が確認）

## 方針

### harvest の範囲の保存（#264 の 1 項目目）

- 新しい表:
  `create table harvest_run_source (run_id integer not null references extraction_run (id) on delete cascade, source_id integer not null references source (id) on delete cascade, primary key (run_id, source_id)) strict;`
  と `source_id` の index。実行が harvest でないか、source が実行と別のプロジェクトなら insert を拒む trigger を付ける。保存するのは id だけ
- 権限: ingest に insert を許す。forget の source の削除で cascade して消えるよう、forget の消してよい表に入れる。`server/test/db.test.ts` で各ロールの可否を実際の接続で確かめる
- revision 11: `db/schema.sql` と `db/migrations/0011.sql`、`SCHEMA_REVISION`、`bun run codegen`、`server/test/fixtures/schema-rev10.sql`、`server/test/migrate.test.ts` の新旧の一致
- 移行: `origin = 'harvest' and status = 'running'` の extraction_run を消し、1 件ごとに `sphica_migration_note` に 1 行書く。保存済みの harvest、走っている途中の trace と glean、source と record_call は残す
- beginHarvest: 今の transaction の中で、storeItems と linkIssues の後に、今の pullSources と同じ選び方で source を選び、openRun の後で harvest_run_source に 1 行ずつ入れる
- scopeOf（harvest）: その実行の harvest_run_source を source に結んで読む。forget した版より古い版は、時刻で区切らずに除く（forget した B の新しい版があれば、A の古い版も外れる）。`looked` の印と、`created_at`、`id` の並びは今のまま。`captured_at` での絞り込みはなくす
- pullSources は「始めたときの今の source」と「その実行の保存した一覧」の 2 つの読み方に分ける（名前と分け方は実装で決める）

### 消された本文（#264 の 2 項目目）

- issue_body、issue_comment、pr_comment、review、review_comment で、PR 本文と同じく、null・空・空白だけの本文を `""` にして item に入れる。storeItems の今の規則（一度も保存されていない空の item は行を作らない、同じ本文は同じ行）にそのまま任せる

### doctor と README

- `server/src/project.ts`: `localRoots`、`projectsDir`、使われなくなる `underHome`、node:os の import を消し、冒頭のコメントを今の動きに合わせる
- `server/src/cli.ts`: Projects 欄の `localRoots` の呼び出し、home と realpath と tilde の準備、表示の後ろの部分、使われなくなる `p.key` の select を消す。行は名前、記録の件数、最後の取り込みの日時
- テスト: `server/test/cli.test.ts:227-` の表示のテスト、`server/test/project.test.ts` の localRoots と underHome のテストを、準備ごと消す。doctor の Projects 欄に `not found` も `copies` も出ないことを子プロセスで確かめるテストを 1 つ置く
- README.md と README.ja.md: 例を `cd path/to/your-repo` にする。トラブルシューティングの「doctor の Projects にそのリポジトリがあるか」は DB の登録を見ているので、そのまま正しい

### リリースと片付け

- package に入る変更なので、最初の package の変更のコミットで npm（`plugin/package.json`）と plugin の manifest 3 つを 0.6.36 に上げる
- 終わった計画ファイル（`.claude/plans/2026/10/` の 03-*、04-*、05-* の plan と tasks。tasks の全項目が `[x]`）を、記録 u151 に従ってこの PR で消す

## 採った案と棄却した案

- 採用: 開始時の source の id を harvest_run_source に保存する。棄却: 開始時刻以前の最新の版を選ぶ（同じミリ秒に重なると範囲が変わり、閉じる issue の変化も防げない）
- 採用: 閉じる issue も保存した id で固定する。棄却: 開始時の PR 本文の版から closingRefs で読み直す（保存した本文は伏せ字と切り詰めが入り、読んだ本文と同じとは限らない）。棄却: 古いリンクを消さずに残す（PR の範囲の意味が変わる）
- 採用: 移行で、走っている途中の harvest の実行を消してメモに残す。棄却: 保存した一覧があるかの印の列を足す（列が増え、一覧が 0 件の実行と区別するための規則が要る）
- 採用: 実際の SQLite での結合テスト。棄却: 新しい acceptance の層（driver が A と B を交互に動かせない）
- 採用: doctor の場所の探索をまるごと消す。棄却: 文面だけ直す、init した場所を覚えて探す（どちらも ~/Projects か別の場所の前提が残るか、挙動が大きくなる）

## 手順

- S1: revision 11 の harvest_run_source（表・index・trigger・権限・移行・fixture・codegen）と、そのテスト
- S2: beginHarvest が保存し、scopeOf が保存した一覧を読む。A と B の結合テスト
- S3: 消された本文を空の版として保存する。5 種類のテスト
- S4: doctor の ~/Projects の探索をやめ、README と project.ts のコメントを直す
- S5: npm と plugin の manifest を 0.6.36 に上げる（S1 のコミットに入れる）
- S6: 終わった計画ファイルを消す

## 完了条件

- A1: `cd server && node --test test/migrate.test.ts test/schema.test.ts test/db.test.ts` → pass。revision 10 から移行した DB と新しく作った DB が一致し、走っている途中の harvest の実行がメモ付きで消え、保存済みの harvest と走っている途中の trace・glean・source・record_call が残り、消えた実行 id の check が「Begin again」を返す
- A2: `cd server && node --test test/extract.test.ts` → pass。B がコメントの版 2 を取り込んでも、B の本文が閉じる issue を変えても、A の context は版 1 と元の issue を出し、A の check と save が版 1 を引用して通る。DB を開き直しても同じ。A の source を forget すると A の範囲から外れ、B の新しい版を forget すると A の古い版も外れる。B の範囲は B の取り込みに沿って進む
- A3: `cd server && node --test test/github.test.ts` → pass。5 種類それぞれで、本文を空にした後の harvest で今の版が空になり、前の版を read で読める。空のまま取り込み直しても行は増えない。一度も保存されていない空の item は行を作らない
- A4: `cd server && node --test test/cli.test.ts` → pass。HOME を一時ディレクトリにした子プロセスの `sphica doctor` の Projects 欄に `not found` と `copies` が出ない
- A5: `rg -n 'localRoots|projectsDir|~/Projects' server/src README.md README.ja.md plugin` → 一致なし
- A6: `bun run verify` → 終了コード 0
- A7: `bun run release:plan -- --base v0.6.35` → `plugin`。npm と 3 つの manifest が 0.6.36
- A8: `cd plugin && npm pack --pack-destination <リポジトリの外の一時ディレクトリ>` → 展開した中身の数を数え、展開先の CLI で `sphica doctor` が起動して Projects 欄に `not found` も `copies` も出ない
- A9: `gh pr checks <PR 番号> --watch` → 必須の項目がすべて pass

## リスク

- 移行で消す走っている途中の harvest を、持ち主が別のセッションで使っている → その実行の check と save は「Begin again」を返す。始め直せば同じ PR の source が選び直される
- 保存した一覧の行が harvest の回数だけ増える → 1 回の harvest は 1 つの PR とその閉じる issue の source の数（数十〜数百）に留まる。増え方が問題になったら、保存済みの実行の行を消すかを別に決める
- 空の今の版が増えて、context や read で空の本文が出る → 見出しだけが出る。古い版は read で読める
- doctor の表示を消したことで、同じリポジトリの 2 つの clone に気づけなくなる → 2 つの clone は同じプロジェクトとして記録されるので、記録には影響しない

## 未解決

なし

## 変更履歴
