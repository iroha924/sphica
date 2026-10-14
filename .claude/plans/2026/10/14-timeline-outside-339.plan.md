---
kind: plan
status: approved
codex_session: 01a1361d-4425-7483-9b2b-7ee31e27f0f0
codex_rounds: 4
approved_at: 2026-10-14
---

# 質問に答えた記録を DB の行に持たせ、timeline が出す連なりの外の記録の行を、連なりの記録が答えた質問の取り下げだけにする（issue #339）

## 要点

- schema を revision 13 に上げ、「この取り下げは、この記録が質問に答えたから」を持つ表 `unit_answer` を足す。trace の保存が質問を閉じるときに、取り下げの状態の行と一緒に書く
- `read` の `timeline: true` で、連なり（置き換えでつながる記録）の外の記録について出す状態の行を、連なりの記録が答えた質問の `became withdrawn` だけにする。判定は `unit_answer` の行でする。印は付けない（理由が `answered by <連なりの記録>` と言う）
- 連なりの外の記録の `became superseded`・`became active`・`became candidate` と、連なりの記録が答えていない取り下げは出さない。持ち主の DB（issue の時点の 582 件）では 288 行が 1 行になる見込み
- 移行（`db/migrations/0013.sql`）は表を足すだけで、既存の表は作り直さない。これまでの取り下げのうち理由が `answered by <key>` のものは、同じ run が保存したその key の記録を探して `unit_answer` に写す（1 回きり。見つからないものは写さず、移行の注記に出す）
- 評価ループは回し直さない（持ち主の決定）。fixture の timeline を直す前後で比べる
- `read` の引数とツールの説明文、`timeline` なしの `read`、`search`、capture の経路は変えない。0.6.57 として 1 つの PR で出す
- 届いた後は、plugin を更新して開いているセッションを `/reload-plugins` で開き直してから、`sphica init` で持ち主の DB を revision 13 に移行する（移行の前に自動でバックアップが取られる）。開き直しから移行までの短い間、読み取りと記録の MCP は止まる。この順にするのは、開いたままの 0.6.56 の記録 MCP が移行の後も質問を閉じられ、答えた記録を書かないため

## 持ち主の決定

- issue #339 を直す。1 つの PR で出す
- 直し方は厳密な (b): 答えた記録を DB の行に持たせ、連なりの記録が答えた質問の行だけを残す。schema の変更を伴う（2026-10-14、3 つの案の比較を見たうえで選んだ）
- 原因は、理由の文字列からではなく DB の行から判定する
- これまでの取り下げは、移行で 1 回だけ理由の文字列から `unit_answer` に写す（2026-10-14、写さない案と比べて選んだ。議論の後に持ち主が追加）
- 評価ループ（history-sync）は回し直さない（2026-10-14）
- MCP の返信の中身が変わるので、計画を Codex と詰めてから Go を取る
- 直す前に落ちるテストを先に書く
- 直す前後で、持ち主の DB を読み取り専用で開いて件数を測り直し、PR 本文に載せる
- Claude Code と Codex で同じ返信になること
- issue の「What a fix has to keep」を守る: 連なりの run が保存し、連なりの記録が答えた質問は `became withdrawn` の行が残り、その質問の `became candidate` / `became active` の行は出ない。`timeline` なしの `read` と `search` の返信は今のまま

## 目的

- timeline の中の行は、連なりの記録についての行か、`[same run]` / `[same place]` の印が付いた `saved` の行か、連なりの記録が答えた質問の取り下げの行のどれかになる
- 持ち主の DB のコピー（revision 13 に移行したもの）の 582 件で、連なりの外の記録についての `became` の行が 288 行から 1 行（u544 の timeline の、質問 u541 の取り下げ）になる
- trace の `answers` で質問が閉じると、どの形（decision、finding、古い質問への連鎖）でも `unit_answer` に行ができ、答えた記録の timeline にその取り下げが出る
- revision 12 の DB を移行すると、fresh な revision 13 の DB と同じ定義になり、既存の行は 1 つも変わらない

## 対象外

- `unit_answer` を `read`（全文）や `search`、export、overview に出すこと（今の返信を変えない）
- 質問を閉じなかった `answers`（答えた記録が active にならなかった、AI の決定だった）を行に残すこと。`unit_answer` は起きた取り下げの原因だけを持つ
- 同じ run が行った置き換えを 1 行にまとめて出すこと（Codex の中間の案）
- 置き換えの原因を `unit_state` に持たせること（`unit_replacement` と `unit_link` がもう持っている）
- `[same run]` / `[same place]` の `saved` の行の出し方と上限、先頭行（`LEAD`）
- README とツールの説明文（どちらも連なりの外の記録の状態の行に触れていない）
- 計測のスクリプトをリポジトリに入れること

## 前提

- `server/src/timeline.ts:226-241`: `outside` の問い合わせ。連なりの記録を保存した run が書いた `unit_state` のうち、連なりの外の記録のもので、「記録が別の run のもの」か「新しい状態が superseded か withdrawn」のものを全部取る。`timeline.ts:470-477` が印なしで `<key> (u<id>) became <state>: <reason>` と出す
- `server/src/timeline.ts:69-100`: 連なりは `unit_link`（kind = supersedes）を両方向にたどった記録で、上限は 20 件
- 誰が質問に答えたかを持つ行は無い。`answers` は保存の入力にだけあり（`server/src/record.ts:105`）、`closeAnswered`（`record.ts:949-1045`）は `reconcile` に `withdraw: Map<質問の id, { reason: "answered by <key>", source: <grounds> }>` を渡すだけ。古い質問への連鎖は `reason: "answered by <key> (through <間の質問の key>)"`（`record.ts:1022-1025`）
- `server/src/reconcile.ts:339-382`: `unit_state` と `unit_replacement` を書くのは `reconcile` だけで、`scripts/check-architecture.mjs:66-79` がそれを検査する。`Hint` は `{ reason, source }`（`reconcile.ts:16`）で、glean の取り下げ（`server/src/glean.ts:941`）も同じ型を渡す
- 答えた記録はその保存の run が新しく保存する（`record.ts:1191` の insert）。harvest と glean は `answers` を拒否する（`record.ts:737-738`）
- key の形: 記録の key は `<origin>:<target>/<slug>` で、slug は `^[a-z0-9][a-z0-9._/-]{0,63}$`（`record.ts:39`）。slug に空白と括弧は入らない
- 記録（`unit`）を 1 件だけ消す経路は無い。`server/src` の delete は source（forget）と `artifact_link` だけで、記録が消えるのは project ごと消えるとき
- `server/src/db-write.ts:144-164`: ingest が insert できる表の一覧（`INGEST_INSERTS`）。forget の役は別の一覧
- 移行の前例: `db/migrations/0012.sql` は表 `unit_anchor_retirement` と trigger を足すだけで、既存の表を作り直していない。`migrate()`（`server/src/admin.ts:221-260`）は移行の前にバックアップを取り、1 つの transaction で流し、`foreign_key_check` を見る。`server/test/migrate.test.ts:174-178` が、移行した DB と fresh な DB の定義を比べ、`:275-282` が前の revision ごとの fixture（`server/test/fixtures/schema-rev<N>.sql`）があることを見る。今は rev11 まであり、rev12 の fixture が要る
- 今の revision は 12（`server/src/sqlite.ts:20`、`db/schema.sql` の末尾）。reader と ingest は revision が合わないと止まり、capture は generation だけを見る（`knowledge-schema` の Skill）
- 実測（2026-10-14。持ち主の DB を `sqlite3` の `.backup` で読み取り専用にコピーし、`created_at < 2026-10-13T15:00:00.000Z` の 582 件それぞれの timeline を main（deb3c4fd、0.6.56）のコードで組み立てた。数えたのは、その timeline に `saved:` の行（印なし）を持たない記録についての `became` の行）
  - 該当の行がある timeline は 179 件、行は 288 行（1 件で最大 4 行）。issue の数字と一致
  - 元は 24 件の状態の変化（superseded 23 件、withdrawn 1 件）。kind 別の行数は finding 133、decision 126、constraint 18、question 11
  - superseded の 277 行に、連なりの記録による置き換えは 0 行
  - withdrawn の 11 行は 1 件の変化（質問 u541、state の理由は `answered by trace:cbc0dbe8-…/phase05-outcome`、run 122）が、同じ trace の 11 件の記録の timeline に出たもの。答えた記録（u544）が連なりの中なのは 1 行（u544 の timeline）
  - DB 全体の withdrawn の状態は 5 件。理由が `answered by` で始まるのは 1 件（上の u541）。残り 4 件は glean の `withdrawn: <持ち主の引用>`
- `server/test/timeline.test.ts:225` は、別の run が保存し連なりの run が閉じた質問の `became withdrawn` を、`saveRecord` の実際の経路で期待している。`:983-989` は `unit_state` の行を直接入れて期待している。`:1063-1113` は `woken became active` と `replaced became superseded` を期待している（PR #338 のレビューで足した）
- `server/src/frame.ts:10-17`: 返信の枠の id は呼び出しごとに乱数。2 つの返信はそのままでは一致しない
- 評価の `history-sync` の fixture（`server/evals/acceptance/cases.json:8132-8300`）: 3 本の trace は直前の decision だけを置き換え、`answers` は無い。gold の 3 件は同じ連なりに入る。同じ trace の `battery`、`push`、`german-label`、`late-edits` の timeline には今、連なりの外の `became superseded` が出ている
- `server/evals/acceptance/driver.ts:1421-1423`: read の検査は `read_contains`（文字列 1 つ）だけで、検査すると次の `then` 要素へ進む。否定の検査は無い。`server/test/acceptance-cases.test.ts:14` が retrieval のケース数を 15 と固定している。質問に答える fixture は `cases.json:6062`（`s-ja-ask`）と `:6203`（`s-en-cache-where`）にある
- `plugin/mcp/claude.json` は `node ${CLAUDE_PLUGIN_ROOT}/dist/mcp.js`、`plugin/mcp/codex.json` は cwd を plugin にして `node ./dist/mcp.js`。どちらも `server/src/mcp.ts:295` から同じ `timelineRefs` を呼ぶ
- 今のバージョンは 0.6.56（タグ v0.6.56 は 9fec994c）

## 方針

1. `db/schema.sql` に表を足し、末尾を `pragma user_version = 13` にする。置く場所は `unit_state` の trigger の後ろ

   ```sql
   -- Why a question was withdrawn: the record whose answer closed it, written with the withdrawal's state row.
   create table unit_answer (
     state_id integer primary key not null references unit_state (id) on delete cascade,
     answer_unit integer not null references unit (id) on delete cascade
   ) strict;
   create index unit_answer_unit on unit_answer (answer_unit);
   ```

   trigger（`before insert`）で断るもの: 状態が withdrawn でない / 状態の記録が question でない / 答えた記録が質問と別の project / 答えた記録の `run_id` が状態の `run_id` と違う（質問を閉じる記録は、その保存が保存した記録）/ 答えた記録が question。`before update` は全部断る。`before delete` は、状態の行と答えた記録の両方が残っているときに断る（`unit_link_no_delete` と同じ形）
2. `db/migrations/0013.sql`: 方針 1 と同じ文（表・index・trigger）と、これまでの取り下げの写し。`unit_state` の `to_state = 'withdrawn'` で `run_id` が null でない行 t のうち、記録が question のものについて、同じ project で `run_id = t.run_id` の question でない記録 a のうち、`t.reason = 'answered by ' || a.key` か、`substr(t.reason, 1, length('answered by ' || a.key || ' (through '))` が `'answered by ' || a.key || ' (through '` と等しいものを探す（`like` は使わない。key の `_` が任意の 1 文字に当たる）。候補がちょうど 1 件のときだけ `(t.id, a.id)` を入れる。つまり insert の trigger が通す組だけを選ぶ。理由が `answered by ` で始まるのに、候補が無い・条件に合わない・複数ある行は入れず、`sphica_migration_note` に出す。`.check.sql` は作らない（止める行が無い）
3. `server/src/sqlite.ts` の `SCHEMA_REVISION` を 13 にし、`bun run codegen` で `server/src/db-types.ts` を作り直す。`server/test/fixtures/schema-rev12.sql` に今の `db/schema.sql` を置き、`migrate.test.ts` の revision ごとの比較に rev12 を足す。`schema.test.ts:418` の revision の固定を 13 にする。`db-write.ts` の `INGEST_INSERTS` に `unit_answer` を足す（forget の役には足さない。検査の trigger は select と raise だけなので `INGEST_TRIGGER_WRITES` は変えない）
4. 書き込み: `reconcile.ts` の `Hint` に `answer?: number`（答えた記録の id）を足す。`reconcile` は withdrawn の状態を書くとき、その取り下げの hint に `answer` があれば、入れた状態の id で `unit_answer` に 1 行入れる。`closeAnswered`（`record.ts`）は、名指しされた質問にも、連鎖で閉じる古い質問にも、答えた記録の id を渡す。glean の取り下げは渡さない。`scripts/check-architecture.mjs` の「`reconcile.ts` だけが書く」検査に `unit_answer` を足す
5. `server/src/timeline.ts`: `outside` の問い合わせを、`unit_answer` を起点に「答えた記録が連なりの中、取り下げられた記録が連なりの外」の状態の行だけにする（run の条件は要らない）。出力は今と同じ `<key> (u<id>) became withdrawn: <reason>`、印なし、連なりの段のまま。`LEAD`、related の段、件数は変えない
6. テスト。先に書いて、直す前のコードで落ちることを確かめる
   - `server/test/timeline.test.ts`
     - 置き換え: 1 回の保存が、頼んだ記録と、前の run の decision を置き換える別の記録を保存する。頼んだ記録の timeline に、前の decision の行が出ない
     - `saveRecord` の実際の経路（`answers`）で: decision が答える / adoption の無い finding が答える / 古い質問への連鎖（`answered by … (through …)`）。答えた記録の timeline にその取り下げが出て、古い質問の `became active` は出ない。同じ保存の別の記録（同じ発言を引用するものを含む）の timeline には出ない
     - 行を直接入れて: `unit_answer` の無い取り下げ（glean の形）は出ない
     - 上限 20 件: 既存のテスト（`:537-597`）に、切れた先の記録を連なりの端の記録が実際に置き換えた行を足す。直す前は `became superseded` が出て、直した後は出ず、末尾の注記は出る
     - 既存の直し: `:983-989` は `unit_answer` の行を足す。`:1063-1113` の `woken became active` と `replaced became superseded` は出ない側に
   - `server/test/schema.test.ts`: `unit_answer` の trigger が断るもの（方針 1 の 5 つ、forget だけが原因で `run_id` が null の状態、update、単独の delete）を実際の DB で。project ごと消すと `unit_answer` も消え、`foreign_key_check` が空であること。外部キーに index があること（既存の検査が見る）
   - `server/test/db.test.ts`: ingest は `unit_answer` に insert でき、forget・capture・reader はできない
   - `server/test/migrate.test.ts`: revision 12 の DB を移行すると fresh と同じ定義になる。`answered by <key>` と `answered by <key> (through <key>)` の取り下げが `unit_answer` に写り、glean の取り下げは写らない。key が見つからない、答えた側が question、前半が同じ key の 2 件（`a` と `a_b`、`a` と `ab`）がある、のそれぞれで取り違えず、写せない行は注記に出て移行は止まらない。`unit_state` の行と id は変わらない
   - 保存の経路のテスト（`server/test/record.test.ts` の、質問を閉じる保存のテスト）: 質問を閉じた保存の後に `unit_answer` の行があり、連鎖で閉じた古い質問の行も元の答えた記録を指す。閉じなかった `answers` には無い。答えた記録の出典を forget した後も `unit_answer` の行は残る
7. acceptance: `server/evals/acceptance/driver.ts` に `read_lacks`（文字列の配列）を足し、`cases.json` の `steps` の説明と retrieval のケースを 2 つ足す。`acceptance-cases.test.ts` の retrieval を 17 にする。timeline を直すのと同じコミットに入れ、直す前に否定のケースが落ちることを確かめる
   - history-sync の fixture で `trace:s-en-sync-2/battery` の timeline: 見出しと `battery` の `saved` の本文があり（別々の `then` 要素）、`trace:s-en-sync-1/every5 (u` が無い
   - `s-en-cache-where` で、答えた記録の timeline に、質問の `became withdrawn: answered by` がある（直す前も通る。残ることの固定）
8. 文書: `.agents/skills/knowledge-schema/SKILL.md`（`.claude/skills/knowledge-schema` はここへの symlink）の「The record model」に `unit_answer` と、`reconcile` が書くことを足す。`db/schema.sql` の冒頭の表の一覧にも足す（表を足すのと同じコミットで）。`.agents/skills/plugin-release/SKILL.md` の「Confirming it arrived」に、revision を上げるリリースの順序（方針 12 の到着の後）と理由を書く
9. バージョンを 0.6.57 にする（`plugin/package.json`、`plugin/.claude-plugin/plugin.json`、`plugin/.codex-plugin/plugin.json`、`.claude-plugin/marketplace.json` の npm source）。編集の前に `bun run release:plan -- --base 9fec994c` を流す。package の入力を変える最初のコミットに入れる
10. 件数の計測: 直す前（deb3c4fd、コピーは revision 12 のまま）と、直した後（別のコピーを `migrate()` で revision 13 にしてから）で、同じ 582 件を測る。582 件でなかったら 1 行という目標を成立したものとして扱わず、数字を取り直す。移行の注記（写せなかった取り下げ）が出たら、その内容も載せる。PR 本文に、前後のコミット、582 件の固定の仕方、数え方、状態別の件数、残った行の unit と state の id を載せる
11. fixture の比較: history-sync の fixture の DB を直す前のコード（revision 12）で 1 回だけ作る（保存の時刻は実時計なので、2 回作ると時刻が変わる）。そのコピーを直した後のコードの `migrate()` で revision 13 にし、直す前のコードと元の DB、直した後のコードと移行したコピーで timeline を組み立てて比べる（枠の id は、開始と終了が対応することを見たうえで置き換える）。gold の 3 件は同じ。`battery`、`push`、`german-label`、`late-edits` は連なりの外の `became superseded` の行だけが消える。PR 本文に、これはサーバーの返信の回帰の確認で、モデルの回答の質は測っていないと書く
12. 両ホスト
    - リリースの前: `bun run bundle` した `plugin/dist/mcp.js` を、Claude Code の起動の形と Codex の起動の形（cwd を plugin にして `node ./dist/mcp.js`）の両方で stdio で起動し、同じ一時 DB（`SPHICA_DB`）・同じ `cwd` 引数・同じ refs で `read`（`timeline: true`）を呼ぶ。2 つの返信と `timelineRefs` を直接呼んだ文字列を、枠の id を置き換えて比べる
    - 到着の後: revision の検査は接続を開くときだけなので、移行の前から開いている 0.6.56 の記録 MCP の接続は、移行の後も質問を閉じられ、`unit_answer` を書かない（Codex がインメモリの DB で再現した）。これを避ける順にする。(1) `cd ~ && npm i -g sphica@0.6.57` (2) 両ホストの plugin を更新する (3) 持ち主が開いているセッションで `/reload-plugins` を流し、ほかのセッションを閉じる。`pgrep -fl mcp-record` で、0.6.56 のキャッシュから動いている記録 MCP が無いことを見る。Codex は cwd を plugin にして `./dist/mcp-record.js` で起動するので、パスにバージョンが出ない PID は `lsof -a -p <pid> -d cwd` で cwd まで見る。一覧を取れない、またはバージョンを判別できない PID が残るときは、無いとは扱わず移行に進まない (4) 登録済みのリポジトリで `sphica init`（revision 13 への移行。バックアップの場所と注記を報告する） (5) `sphica doctor`。(3) から (4) までの間、読み取りと記録の MCP は「expects revision 13」で止まる（capture は動く）。(4) が終わるまで、このセッションから trace を保存しない
    - その後、両ホスト（`claude -p` と `codex exec`。Codex は `HOME=<tmp>`、DB は `<tmp>/.sphica/sphica.db`）から、同じ一時 DB・同じ `cwd` 引数・同じ refs で `read`（`timeline: true`）を呼ばせ、ツールの結果の text を、枠の id を置き換えて比べる
13. リリースは `plugin-release` の Skill の手順どおり。最終の head の CI、Codex のレビューと全スレッドの解決、`review-shipping`、タグ、持ち主の `npm-release` の承認、run と後続の scan の完了、到着の確認まで。PR の Release notes に、更新の順序（plugin を更新してセッションを開き直してから `sphica init`）と、移行で写せなかった取り下げは注記に出ることを書く

## 採った案と棄却した案

- 採用: 厳密な (b)。答えた記録を `unit_answer` に持たせ、連なりの記録が答えた質問の取り下げだけを出す（実測で 1 行）。棄却: (a) 今の行を全部、印付きで残す（288 行）
- 棄却: 取り下げを run と出典で絞って印付きで出す（3 行。うち 2 行は答えた記録が連なりの外。持ち主が厳密な案を選んだ）
- 採用: 取り下げの状態の行に付く別の表（`unit_answer`）。既存の表を作り直さず、起きた取り下げに直接付けられる。棄却: `unit_state` に列を足す（追記だけを許す既存の trigger と、移行で既存の行を更新する扱いが増える）
- 棄却: `unit_link` に kind `answers` を足す（CHECK を変えるので表の作り直しになり、kind を見る箇所が増え、取り下げの状態の行との対応を直接持たない）
- 採用: 到着の順序を「plugin の更新と開き直し → `sphica init`」にする。棄却: 今の Skill の順（`sphica init` → plugin の更新）のまま（開いたままの 0.6.56 の記録 MCP が、移行の後に `unit_answer` なしで質問を閉じられる）
- 棄却: pack した成果物の検査（`scripts/check-tarball.mjs`）に、答えた質問を持つ revision 12 の DB を足す（その検査は今も tarball の中の移行を古い DB に流していて、写しの文は 0 行に対して実行される。行の組み合わせは同じファイルを `migrate.test.ts` が見る）
- 棄却: 書き込みの transaction ごとに revision を確かめ直す（次の revision の変更からは効くが、今回止めたい 0.6.56 の接続には効かない。書き込みの全経路に手が入る。要るなら別の issue）
- 採用: これまでの取り下げを移行で 1 回だけ写す（その run が保存した記録の key との一致で探す）。棄却: 写さない（これまでに答えた質問の行が timeline から消え、issue の「残すこと」に反する）
- 棄却: timeline が読むたびに理由の文字列から答えた記録を探す（持ち主の決定）
- 棄却: 評価ループの回し直し（持ち主の決定）

## 手順

- S1: schema を revision 13 にする。`unit_answer` の表と trigger、移行と写し、fixture、型、ingest の許可、schema・役・移行のテスト、0.6.57（方針 1・2・3・9、方針 6 の該当分）
- S2: 質問を閉じる保存が `unit_answer` を書く。`reconcile` と `closeAnswered`、architecture の検査、保存の経路のテスト（方針 4、方針 6 の該当分）
- S3: timeline のテストと acceptance のケース（`read_lacks` を含む）を先に足して直す前のコードで落ちることを確かめ、timeline の問い合わせを `unit_answer` に替える（方針 5・7、方針 6 の timeline の分）
- S4: Skill と schema の冒頭の説明を合わせる（方針 8）

件数の計測、fixture の比較、両ホストの確認、リリースと移行（方針 10〜13）はコードを変えないので、完了条件 A5〜A10 として流す。

## 完了条件

- A1: `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 test/timeline.test.ts` → 全件 pass。方針 6 の timeline の新しいテストは、`server/src/timeline.ts` だけを S2 の時点の内容に戻すと fail する
- A2: `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 test/migrate.test.ts test/schema.test.ts test/db.test.ts` → 全件 pass
- A3: `bun run verify` → 0 で終わる
- A4: `git diff --stat deb3c4fd -- server/src` → `timeline.ts`、`reconcile.ts`、`record.ts`、`sqlite.ts`、`db-write.ts`、`db-types.ts` だけ
- A5: `node <計測のスクリプト> <リポジトリ> <持ち主の DB のコピー> 2026-10-13T15:00:00.000Z` → 直す前のコードの worktree と revision 12 のコピー、直した後のコードと移行したコピーで 1 回ずつ流し、どちらも 582 件で、連なりの外の記録についての `became` の行が、直す前 288 行（179 件の timeline）、直した後 1 行（u544 の timeline の u541）
- A6: `node <fixture の timeline を書き出すスクリプト> <リポジトリ> <fixture の DB>` → 直す前のコードの worktree と元の DB、直した後のコードと移行したコピーで 1 回ずつ流して `diff` を取ると、gold の 3 件は同じ、`battery`・`push`・`german-label`・`late-edits` は連なりの外の `became superseded` の行だけが消える
- A7: `bun run bundle` の後、`node <MCP を stdio で呼ぶスクリプト> <リポジトリ> <一時 DB>` → `plugin/dist/mcp.js` を両ホストの起動の形で呼んだ `read`（`timeline: true`）の返信と、`timelineRefs` を直接呼んだ文字列が、枠の id を置き換えると一致する
- A8: `gh pr checks <PR>` → 最終の head で `check`、`pr-body`、`release` が全部 pass。未解決のレビューのスレッドが 0
- A9: `gh run watch <release run> --exit-status` → 成功。`bun run release:status` → npm の latest、マーケットプレイス、Claude と Codex のキャッシュが 0.6.57。後続の 2 つの scan の run が成功
- A10: `pgrep -fl mcp-record` → `sphica init` の前に、0.6.56 のキャッシュから動いている記録 MCP が無い。`sphica init`（登録済みのリポジトリで）と `sphica doctor` → 持ち主の DB が revision 13 になり、直すものが無い。その後 `claude -p --output-format stream-json …` と `codex exec --json …` を一時 DB で流し、両ホストから呼んだ `read`（`timeline: true`）のツールの結果が、枠の id を置き換えると一致する

## リスク

- finding や dead end の timeline から、同じ run が行った置き換えと後継の記録を見つける手掛かりが減る → 要ると分かったら、対象外に書いた中間の案を issue にする
- 上限 20 件で切れた先の記録を連なりの端の記録が置き換えた行が出なくなる → 末尾の注記が「その先はたどっていない」と言う範囲。テストで固定する
- 移行の写しが、答えた記録を取り違える（同じ run の別の記録の key が、理由の中の key の前半と一致する） → 一致は key の全体と、その直後が文字列の終わりか ` (through ` であることで見る。slug に空白と括弧は入らないので、同じ run の 2 つの key が両方一致することは無い。移行のテストで、前半が同じ key の 2 件を置いて確かめる
- 新しく開く接続は revision が合わないと止まるが、移行の前から開いている 0.6.56 の記録 MCP の接続は止まらず、移行の後に `unit_answer` なしで質問を閉じられる。その取り下げは timeline に出ない（誤った行が出るのではなく、行が欠ける） → 方針 12 の順（plugin の更新、開き直し、`pgrep` の確認、`sphica init`）で避け、Release notes と Skill に書く。ほかの利用者が順を守らなかった分は補わない
- plugin を更新してから `sphica init` を流すまで、読み取りと記録の MCP が「expects revision 13」で止まる（capture は動き続ける） → 持ち主に先に伝え、間を空けずに `sphica init` を流す
- ほかの利用者の DB に、Sphica が書いていない形の `answered by` の理由や、条件に合わない組がある → 写さず注記に出るだけで、移行は止まらない。その取り下げは timeline に出なくなる
- 計測の時点で 582 件でない、または 1 行にならない → 目標の数字を取り直し、差の理由を確かめてから進む
- 到着の後の `codex exec` が MCP の `read` を呼ばない、または結果の text をログから取れない → 取れた範囲を報告し、取れなかった側を未確認と書く

## 未解決

なし

## 変更履歴

- 2026-10-14 / 直し方を「取り下げを run と出典で絞って印付きで出す」から厳密な (b)（`unit_answer` の表、revision 13）に替えた。印・`LEAD`・related の段と件数の変更は取りやめた / 持ち主が 3 つの案の比較を見て選んだ / Go はこの計画で取り直す
