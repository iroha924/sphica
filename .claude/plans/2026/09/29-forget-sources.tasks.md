---
kind: tasks
plan: 29-forget-sources.plan.md
branch: feat/forget-sources
base: main
---

# 持ち主が選んだ source を、索引と残りのバイトごと消し、それを根拠にした記録を判定し直す（W2、#187） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: schema revision 2 と移行

revision 1 の DB を記録を失わずに revision 2 へ上げられるようにする。

- [x] T08: バージョンを上げる（npm と 3 つの manifest）
  - 種別: 変更
  - 計画: S8
  - 依存: なし
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run release:plan -- --base v0.5.7` → plugin と出る。4 か所が同じバージョン
  - コミット: `chore(release): bump to 0.6.0`
  - 結果: `bun run release:plan -- --base v0.5.7` → release kind: plugin。4 か所を 0.6.0 にした。T01 と合わせて `bun run verify` → exit 0

- [x] T01: schema revision 2 と移行 SQL、新しい DB と移行した DB の一致のテスト
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `db/schema.sql`, `db/migrations/0002.sql`, `server/src/sqlite.ts`, `server/src/db-types.ts`, `server/test/migrate.test.ts`, `server/test/schema.test.ts`, `server/test/fixtures/schema-rev1.sql`
  - 完了条件: `cd server && node --test test/migrate.test.ts test/schema.test.ts` → 移行後の定義が新しい DB と一致し、`foreign_key_check` が空で、新しいトリガーの許可と拒否のテストが通る。`bun run verify` が通る
  - コミット: `feat(schema): add revision 2 with forget batches, tombstones, and a rebuilt unit_state`
  - 結果: `node --test test/migrate.test.ts test/schema.test.ts` → pass 3 / pass 19（定義の一致、foreign_key_check 空、行と id の保持、移行後の capture 書き込み、新しいトリガーの許可と拒否）。`bun run verify` → exit 0

- [x] T02: `sphica init` が revision 1 の DB を移行し、reader と ingest は init を案内する
  - 種別: 変更
  - 計画: S2
  - 依存: T01（移行 SQL と revision 2 が要る）
  - 変更: `server/src/admin.ts`, `server/src/sqlite.ts`, `server/src/cli.ts`, `server/test/admin.test.ts`, `scripts/check-sql-live.mjs`
  - 完了条件: `cd server && node --test test/admin.test.ts` → revision 1 の DB に init すると revision 2 になり、記録の件数が変わらない。移行の失敗で rollback される。`bun run sql:live` が通る
  - コミット: `feat(init): migrate a revision 1 database in place`
  - 結果: `node --test test/admin.test.ts` → pass 23（移行で revision 2・件数保持・再実行で変化なし、壊れた参照で rollback し revision 1 のまま）。`bun run sql:live` → 子プロセスの init が revision 1 を移行し、capture が書き込めた。`bun run verify` → exit 0

## P2: 削除の中身

選んだ source を消し、記録を判定し直し、取り込み直しを止める処理を、MCP に出す前に作る。

- [x] T03: 接続の役 forget と、ingest による削除と墓標の書き込みの拒否
  - 種別: 追加
  - 計画: S3
  - 依存: T01（forget_batch と source_forgotten の表が要る）
  - 変更: `server/src/db-write.ts`, `server/src/sqlite.ts`, `server/test/db.test.ts`, `CLAUDE.md`, `AGENTS.md`, `.agents/skills/knowledge-schema/SKILL.md`
  - 完了条件: `cd server && node --test test/db.test.ts` → forget の許可と拒否、ingest の新しい拒否、forget が revision 1 を開けないテストが通る。`bun run architecture` が通る
  - コミット: `feat(db): add the forget connection role and keep ingest from deleting sources`
  - 結果: `node --test test/db.test.ts` → pass 14（forget の一連の書き込みと拒否 8 種、ingest の削除と墓標の拒否、forget が revision 1 を拒否）。`bun run verify` → exit 0

- [x] T09: 移行で unit_state の採番を引き継ぎ、移行のテストを空振りしない形にする
  - 種別: 修正
  - 計画: S1, S2
  - 依存: T01（移行 SQL）, T02（init の移行と sql:live の段）
  - 変更: `db/migrations/0002.sql`, `server/test/migrate.test.ts`, `server/test/admin.test.ts`, `scripts/check-sql-live.mjs`
  - red: `cd server && node --test test/migrate.test.ts` → 採番のテストが actual 3 / expected 4 で失敗（消えた id が再利用される）
  - 完了条件: `cd server && node --test test/migrate.test.ts test/admin.test.ts` → pass。`bun run sql:live` が移行後の revision 2 を確かめて通る
  - コミット: `fix(schema): keep unit_state's id counter across the migration`
  - 結果: red を実測（actual 3, expected 4）。修正後 `node --test test/migrate.test.ts test/admin.test.ts` → pass 27（init の移行テストは source・unit・unit_state の件数と active を確かめる）。`bun run sql:live` → 8 / 8 で通る。`bun run verify` → exit 0

- [x] T04: `forget.ts` の plan と apply（判定し直し、確認とのずれの検出、掃除）
  - 種別: 追加
  - 計画: S4
  - 依存: T03（forget 接続が要る）
  - 変更: `server/src/forget.ts`, `server/test/forget.test.ts`, `server/src/record.ts`, `db/schema.sql`, `db/migrations/0002.sql`, `server/src/db-types.ts`
  - 完了条件: `cd server && node --test test/forget.test.ts` → #187 の完了条件、根拠が 2 つの記録、commit の anchor を持つ implementation、superseded と withdrawn、撤回の理由の source、external_reference、確認とのずれ、消し済みと存在しない id、バイトの掃除、busy のテストが通る。`bun run sql:reach` が通る
  - コミット: `feat(forget): delete chosen sources and judge the units that cited them again`
  - 結果: `node --test test/forget.test.ts` → pass 10（#187 の完了条件、根拠 2 つ、commit の anchor、superseded・withdrawn・candidate、撤回の理由と external_reference、確認とのずれ、存在しない id と他プロジェクトの id と消し済み id、DB と WAL のバイト、記録の本文の写し、busy と再実行）。`bun run verify` → exit 0（sql:reach を含む）

- [x] T10: ingest の evidence・adoption の削除と、forget の secure_delete の無効化・unit の任意の列の更新を拒否する
  - 種別: 修正
  - 計画: S3
  - 依存: T03（forget と ingest の authorizer）
  - 変更: `server/src/db-write.ts`, `server/test/db.test.ts`
  - red: `cd server && node --test test/db.test.ts` → 追加した 2 件が失敗（ingest の delete from unit_evidence と、forget の pragma secure_delete = off・update unit set no_code_surface が通る）
  - 完了条件: `cd server && node --test test/db.test.ts test/forget.test.ts test/schema.test.ts` → pass
  - コミット: `fix(db): narrow what ingest and forget may write`
  - 結果: red を実測（2 件失敗、actual ''）。修正後 `node --test test/db.test.ts test/forget.test.ts test/schema.test.ts` → pass 45。`bun run verify` → exit 0

- [x] T05: harvest と glean が墓標と同じ内容を保存しない
  - 種別: 追加
  - 計画: S5
  - 依存: T01（source_forgotten の表が要る）
  - 変更: `server/src/github.ts`, `server/src/glean.ts`, `server/test/github.test.ts`, `server/test/extract.test.ts`, `server/test/schema.test.ts`, `server/test/forget.test.ts`
  - 完了条件: `cd server && node --test --test-name-pattern=tombstone test/*.test.ts` → harvest・glean・capture で同じ内容は保存されず、本文を変えたものは保存される
  - コミット: `feat(ingest): skip items the owner forgot when harvesting, gleaning, and capturing`
  - 結果: `node --test --test-name-pattern=tombstone test/*.test.ts` → pass（harvest・glean・capture の 3 件を含む）。照合を外した github.ts と glean.ts では harvest と glean の 2 件が失敗することを確かめて戻した。`bun run verify` → exit 0

## P3: `/sphica:forget` として出す

Claude Code と Codex から、人の確認付きで削除を呼べるようにする。

- [x] T06: record サーバーの `forget_preview` と `forget_apply`、elicitation での確認
  - 種別: 追加
  - 計画: S6
  - 依存: T04（plan と apply が要る）
  - 変更: `server/src/mcp-record.ts`, `server/test/plugin.test.ts`, `server/src/forget.ts`
  - 完了条件: `cd server && node --test test/plugin.test.ts` → 件数の一致で消え、フォーム非対応・decline・cancel・不一致・エラーでは何も書かないテストと、ツール一覧のテストが通る
  - コミット: `feat(mcp): add forget_preview and forget_apply with a confirmation the owner types`
  - 結果: `node --test test/plugin.test.ts` → pass 26（ツール一覧、preview と確認文に本文が出ない、elicitation 非対応・件数の不一致・decline では消えない、件数が合えば消える、空の elicitation 宣言は SDK 1.30 がフォーム対応と読み件数が合えば消える）。`bun run verify` → exit 0。cancel と elicitInput の失敗は未テスト（decline と同じ分岐、失敗は catch で止まる）

- [x] T07: `/sphica:forget` Skill と受け入れケース
  - 種別: 追加
  - 計画: S7
  - 依存: T06（Skill が呼ぶツールが要る）
  - 変更: `plugin/skills/forget/SKILL.md`, `plugin/skills/forget/agents/openai.yaml`, `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`, `server/test/acceptance-cases.test.ts`, `CLAUDE.md`, `AGENTS.md`, `README.md`, `README.ja.md`
  - 完了条件: `bun run verify:ai` と `bun run acceptance` → Skill の検査と forget の受け入れケースが通る
  - コミット: `feat(skills): add /sphica:forget`
  - 結果: `bun run verify:ai` → 通る（plugin Skills 5）。forget-01 は driver の forget を外すと失敗（source_gone、source_search は actual 1 / expected 0）し、戻すと通ることを確かめた。`bun run verify` → exit 0（受け入れ 59 件）

- [x] T11: 消した revision より古い版を今の版として出さず、次の番号を消した版より後にする。取り消された forget_apply では消さない
  - 種別: 修正
  - 計画: S5, S6
  - 依存: T05（harvest と glean の墓標の照合）, T06（forget_apply）
  - 変更: `db/schema.sql`, `db/migrations/0002.sql`, `server/src/db-types.ts`, `server/src/forget.ts`, `server/src/github.ts`, `server/src/glean.ts`, `server/src/mcp-record.ts`, `server/test/github.test.ts`, `server/test/extract.test.ts`, `server/test/plugin.test.ts`, `server/test/db.test.ts`, `server/test/schema.test.ts`
  - red: `cd server && node --test --test-name-pattern=tombstone test/github.test.ts` → 最新の revision を消すと古い版 A が今の本文として出る（expected []）。`node --test --test-name-pattern=forget_apply test/plugin.test.ts` → 取り消した呼び出しでも後の回答で消える（残り 1、期待 2）
  - 完了条件: `cd server && node --test test/github.test.ts test/extract.test.ts test/plugin.test.ts test/forget.test.ts` → pass
  - コミット: `fix(forget): hide revisions older than a forgotten one and ignore cancelled calls`
  - 結果: red を 2 件とも実測。修正後 `node --test test/github.test.ts test/extract.test.ts test/forget.test.ts test/schema.test.ts test/db.test.ts test/migrate.test.ts` → pass 73、`node --test test/plugin.test.ts` → pass 26。`bun run verify` → exit 0

- [x] T12: 仕上げのレビューの指摘を直す（移行の案内、harvest の件数と見えた時刻、掃除の失敗、確定前の取り消し、glean の古い版、索引の検査、文書）
  - 種別: 修正
  - 計画: S2, S5, S6, S7
  - 依存: T07（Skill と受け入れケース）, T11（墓標の revision と取り消し）
  - 変更: `server/src/sqlite.ts`, `server/src/extract.ts`, `server/src/github.ts`, `server/src/forget.ts`, `server/src/glean.ts`, `server/src/mcp-record.ts`, `server/test/admin.test.ts`, `server/test/db.test.ts`, `server/test/extract.test.ts`, `server/test/github.test.ts`, `server/test/forget.test.ts`, `server/evals/acceptance/driver.ts`, `server/evals/acceptance/cases.json`, `plugin/skills/forget/SKILL.md`, `README.md`, `README.ja.md`
  - red: `cd server && node --test --test-name-pattern="harvest: begin keeps|tombstone: harvest does not store|migrates a revision 1" test/extract.test.ts test/github.test.ts test/admin.test.ts` → 3 件が失敗（案内に CLI の更新が無い、飛ばした項目も数える actual 1、消した版の後の版に見えた時刻が入る）。取り消しは確認を外すと `cancelled before` のテストが失敗
  - 完了条件: `bun run verify` → exit 0
  - コミット: `fix(forget): address the branch review findings`
  - 結果: red を実測（3 件と取り消し 1 件）。forget-01 の `source_index_misses` は forget を外すと「the index still holds テレメトリ」で失敗し、戻すと通る。`bun run verify` → exit 0（受け入れ 59 件）。掃除そのものが例外を投げる経路と、glean で消した版より古い版が戻る経路は、テストで再現する継ぎ目が無く未テスト

- [x] T13: 掃除が終わらなかったときの文面で、原因をほかのセッションの読み取りと決めつけない
  - 種別: 修正
  - 計画: S6, S7
  - 依存: T12（掃除の失敗を incomplete にした）
  - 変更: `server/src/mcp-record.ts`, `plugin/skills/forget/SKILL.md`
  - red: 文面だけの修正で、失敗させるテストは無い（`rg "Another session is reading" server/src` → 1 件）
  - 完了条件: `bun run verify` → exit 0
  - コミット: `fix(forget): word an unfinished cleanup without assuming its cause`
  - 結果: `bun run verify` → exit 0（受け入れ 59 件）

## 記録
2026-09-29 / T01 / `git show v0.5.7:db/schema.sql` は浅い clone で読めない / revision 1 の schema を `server/test/fixtures/schema-rev1.sql` に固定し、変更欄に足した（前: 6 ファイル、後: 7 ファイル）
2026-09-29 / T01 / rename が `unit_lifecycle_via_state` の参照で失敗した（実測）/ 移行で `unit_lifecycle_via_state` と `unit_option_sealed` を先に drop し、作り直す
2026-09-29 / T08 / pre-commit の bundle 検査が、パッケージに入る変更にバージョンの同時更新を求めた / T08 を T01 の前へ移し、同じコミットで済ませる（完了条件: 前 `release:plan` が plugin と出て verify が通る、後 plugin と出て 4 か所が同じバージョン）
2026-09-29 / T03 / knowledge-schema Skill に「世代 2 に移行の仕組みは無い」と接続の役の表が残っていた / 同じタスクで直し、変更欄に `.agents/skills/knowledge-schema/SKILL.md` を足した
2026-09-29 / T01 / review-shipping: 旧 0.5.7 の CLI は revision 2 の DB に「退避しろ」と出す。Windows CI は移行を通らない / Release notes で先に CLI を更新するよう書く。Windows の移行は仕上げで判断する
2026-09-29 / T09 / Codex の T01 レビュー F1（unit_state の作り直しで sqlite_sequence が失われ id が再利用される、再現済み）を採用。T02 レビュー F1（init のテストが project しか見ない）と F2（sql:live が revision を見ない）も採用 / 修正タスク T09 を T04 の前に足した
2026-09-29 / T04 / 変更欄を実際に合わせた（前: forget.ts, forget.test.ts, sql-call-sites.mjs。後: forget.ts, forget.test.ts, record.ts, schema.sql, 0002.sql, db-types.ts）。台帳は変更不要だった。ACTIVATION を record.ts から export して共有 / source_forgotten の unique は、A→B→A と編集された項目の同じハッシュの 2 revision を両方消すと衝突するので、通常の索引に変えた（未リリースの schema と移行 SQL を同じ形に直した）
2026-09-29 / T10 / Codex の T03 レビュー F1・F3・F4（再現済み）を採用し修正タスク T10 を足した。F2（ingest が forget_id 付きの unit_state を書ける）は見送り: authorizer には値が見えず、ingest は run_id 付きなら unit_state を元々書ける。authorizer はコードの書き間違いを止める粗い防御で、forget_id を書くのは forget.ts の固定の SQL だけ / T09 のレビューは指摘なし
2026-09-29 / T05 / capture の墓標テストは T01 で schema.test.ts に入っていた。Codex の T04 レビュー F1（A3 の `--test-name-pattern=bytes` に一致するテストが無く空振りする、再現済み）を採用 / 変更欄を直した（前: capture.test.ts、後: schema.test.ts と forget.test.ts）。テスト名に bytes と tombstone を入れた
2026-09-29 / T06 / preview と確認の文面を作る forgetText を forget.ts に置いた / 変更欄に forget.ts を足した
2026-09-29 / T07 / Codex 向けの `agents/openai.yaml`（暗黙の起動を止める）が必要だった。record-writes の規範と README に forget を書き足した / 変更欄に 5 ファイルを足した
2026-09-29 / T11 / Codex の T05 レビュー F1（最新の revision を消すと古い版が今の版になり番号も使い回す）・F3（glean の墓標テストが保存の段を通らない。保存の段は元から拒否していた）、T06 レビュー F2（取り消した呼び出しへの後からの回答で消える）を採用し T11 を足した。墓標に revision を足した（未リリースの schema と移行 SQL を同じ形に直した）。T05 F2（anchor の excerpt に同じ行が入り得る）は、anchor はいまの作業ツリーを読む別の経路で plan の「別の経路からの同じ言葉は保存する」に入るため見送り。T06 F1（artifact のパスや unit の key に秘密があれば preview に出る）は、識別子で search の結果にも元から出るため見送り。T06 のレビューは Codex が自分の誤報に気づいて途中で止めたので、残りは仕上げの全差分レビューで見る。T10 のレビューは指摘なし
2026-09-29 / T12 / 仕上げのレビューを採用し T12 を足した。review-shipping F1（旧 CLI では移行されないのに案内が CLI の更新を言わない、再現済み）、Codex 全差分 F1（commit 後の掃除の失敗がエラーになる）・F2（消した唯一の版の後の版に available_at が入る）・F3（harvest_begin が飛ばした項目も数える）、T07 レビュー F1（Skill のパスでの探し方は索引に効かない）・F2（source_search は行と結合して数えるので索引だけ残る退行を見逃す）・F3/F4（README が記録の本文に残る言葉と掃除の未完了を書いていない）、T11 レビュー F1（承認後の確定前の取り消し）・F2（glean で消した版より古い版を今の版として使い直す）。review-shipping F2（旧 0.5.7 の CLI が revision 2 の DB に退避を勧める）は出荷済みのコードで直せないので README と Release notes で知らせる。review-shipping は途中でターン上限に達したため、項目 3・5・6（検査の自己一致、一括置換、古いコメント）は見ていない。検証のため持ち主の実 DB の複製を scratchpad に作っていたので消した
2026-09-29 / T13 / 全差分レビュー 2 回目は P1・P2 なし。T12 レビュー F3（掃除の未完了の原因を読み手と決めつける）を採用し T13 を足した。F1（ロックを同期で待つ間に届いた取り消しが確定前の確認に間に合わない）は数秒の競合に限られる極端な入力、F2（記録に引用されず本文に番号の無い PR 項目は番号では見つからない）は Skill が本文の言葉で探すよう案内し持ち主に尋ねられるため、どちらも見送り PR の Declined findings に書く。レビューの往復はここで止める（CLAUDE.md: 新しい P1 が無く P2 が極端な入力だけ）
