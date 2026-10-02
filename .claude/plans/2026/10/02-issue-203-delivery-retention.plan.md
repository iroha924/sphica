---
kind: plan
status: approved
codex_session: 01a0f9e5-cbb4-7b72-a5bb-9b357532383f
codex_rounds: 3
approved_at: 2026-10-02
---

# #203 の残り: 配信のログ（delivery）を、最後の配信から 90 日たったセッションの分だけ、ログを書くたびに少しずつ消す

## 要点

- 規則: 最後の配信が 90 日より前のセッションの delivery 行を、配信のログを書くたびに古い順で最大 200 行ずつ消す。session_id が null の行は行の at だけで決める。delivery_unit の対応も一緒に消える
- 消すのは capture 接続。新しいビュー `capture_delivery_prune` への insert で消し、capture が delivery・delivery_unit を直接 delete できないのは変えない
- schema revision 7: delivery_unit.delivery_id の FK を cascade から no action にし、`delivery_ad` トリガーで子の行を消す（cascade は capture の権限で通らない）。delivery(at) の index を足す
- 0.6.17 の capture が revision 7 の DB にログを書ける（既存の capture_delivery・capture_delivery_scoped は変えない）
- 変えないもの: 日ごとの集計は作らない、空のログを書く条件（#205）、session 行、#244 の保留。0.6.18 として出す

## 持ち主の決定

- #203 の残りのうち、delivery の保持期間をこの計画でやる（2026-10-02「候補1の計画を進める」）
- #203 から保持期間と project の key の正規化を外し、#205 の後に回した（記録 u120、2026-09-30「2つとも外すで同意」）。key の正規化は引き続き別の計画
- #244（サブエージェント自身の compaction）は 0.6.17 を 2 週間ほど使って実ログで頻度を数えるまで保留（記録 u137）

## 目的

- delivery と delivery_unit が際限なく増えない。最後の配信から 90 日を過ぎたセッションの行は、その後の配信のたびに 200 行ずつ減り、いずれ 0 になる
- 90 日以内に配信のあったセッションでは、表示済みと読む前の予算（beforeRead）と resume の判定が今と同じ結果になる
- capture の接続ができることは「ビューへの insert」のままで、delivery・delivery_unit への直接の delete は拒否される
- 消す行が多く残っている DB でも、配信のフックは 1 秒未満で返る

## 対象外

- 日ごとの件数などの集計（読む所が無い）
- prompt・session_start・review の nothing 行を書かない変更（#205 で残すと決めた）
- session 行の削除（source が紐付く）
- 保持期間を設定で変えられるようにすること
- project の key の正規化（別の計画）、#244、#236

## 前提

- delivery を読むのは server/src/deliver.ts の beforeRead（:259-300、同じセッション・同じ agent の、compact/clear の区切り以降の emitted 行）と resume の判定（:784-795、同じセッションの emitted の session_start）だけ。eval（server/evals/cloud）はスロットごとの新しい DB を読む
- delivery を消すコードは無い。消えるのは session と unit の削除の cascade だけ（db/schema.sql:942、:954-955）
- 持ち主の実 DB（読み取り専用で集計、2026-09-27〜10-01）: delivery 3,707 行・delivery_unit 1,149 行、delivery 表 426KB と delivery_session index 307KB（DB 全体 4.28MB）。1 日 300〜1,100 行
- 書く経路は capture 接続の capture_delivery_scoped（INSTEAD OF トリガー、deliver.ts:650-680 の write()）。owner 接続は移行・doctor・init でしか走らず、定期的な掃除の場所にならない
- captureAuthorizer（server/src/db-write.ts:94-120）は DELETE を FTS の内部表以外すべて拒否し、TRIGGER_WRITES は INSERT にしか使わない
- 実測（node:sqlite メモリ DB、2026-10-02、Claude と Codex の両方）: ビューのトリガーで子を先に消してから親を delete しても、FK cascade の子の DELETE はトリガー名 null で authorizer に来て拒否される。FK を no action にして親の AFTER DELETE トリガーで子を消すと、トリガー名付きで来て通る。owner は authorizer を持たず、session の削除から delivery_ad が走って子も消える
- 実測（Codex、メモリ DB）: 0.6.17 の captureAuthorizer で、新しいビューと delivery_ad を足した schema の capture_delivery・capture_delivery_scoped に unit 付きで書けた。下の prune の SQL は delivery(at) と delivery_session(session_id, at) で外側も内側も SEARCH になり、一時ソートが無い。期限切れ 452 行が 3 回で 252 → 52 → 0 になった
- server/test/db.test.ts:167 は capture_ 以外の全トリガーの書き込みを INGEST_TRIGGER_WRITES（db-write.ts:171）と突き合わせる
- deliver.ts は sql:reach の対象（LIVE_FILES は cli.ts と capture.ts だけ、scripts/lib/sql-call-sites.mjs:42）

## 方針

1. schema revision 7（db/schema.sql と db/migrations/0007.sql、SCHEMA_REVISION = 7）
   - delivery_unit を作り直し、delivery_id の FK を no action にする。unit_id の `on delete cascade`、主キー、delivery_unit_unit index は今のまま
   - `create trigger delivery_ad after delete on delivery begin delete from delivery_unit where delivery_id = old.id; end;`
   - `create index delivery_at on delivery (at);`
   - `create view capture_delivery_prune as select null as cutoff;` と、その INSTEAD OF insert トリガー `capture_delivery_prune_insert`:
     `delete from delivery where id in (select d.id from delivery d where d.at < new.cutoff and (d.session_id is null or not exists (select 1 from delivery n where n.session_id = d.session_id and n.at >= new.cutoff)) order by d.at, d.id limit 200);`
   - 移行は delivery_unit を参照する配信のトリガー（capture_delivery_insert、capture_delivery_scoped_insert）を先に落とし、表を作り直してから同じ定義で戻す。既存の行はすべて残す
   - revision 6 の fixture（server/test/fixtures/schema-rev6.sql）を足し、db-types と codegen を更新する
2. 権限（server/src/db-write.ts）
   - CAPTURE_VIEWS に capture_delivery_prune を足す
   - captureAuthorizer の DELETE を、トリガー名が `capture_delivery_prune_insert` で表が delivery のとき、`delivery_ad` で表が delivery_unit のときだけ通す。それ以外の DELETE は今どおり拒否
   - INGEST_TRIGGER_WRITES に `delivery_ad: ["delete delivery_unit"]` を足す
3. 配信（server/src/deliver.ts の write()）
   - ログの 2 つの insert の後、同じトランザクションで `capture_delivery_prune` に cutoff を insert する。cutoff は `iso(Date.now() - 90 日)`、比較は厳密な `<`
   - 保持日数は deliver.ts の定数 1 つ（90）
4. 0.6.18 にする（release:plan の後、npm と 3 つの manifest）

## 採った案と棄却した案

- 採用: 配信のログを書くたびに最大 200 行ずつ消す。棄却: owner 接続で消す（移行・doctor・init でしか走らない）
- 採用: 消すための新しいビュー（案 B）。棄却: 既存の配信トリガーに delete を足す（案 A。0.6.17 の authorizer が新しい DB への配信ログの insert を準備の時点で拒否する）
- 採用: FK を no action にして delivery_ad で子を消す。棄却: FK cascade のまま、子を先に消す（cascade の DELETE はトリガー名 null で来て、capture の権限で拒否される。実測）。棄却: capture に delivery_unit の直接 delete を許す
- 採用: セッション単位（最後の配信が 90 日より前のセッション）。棄却: 行の at だけで消す（長く続くセッションの表示済みと予算が途中で戻る）
- 採用: session_id が null の行は行ごとに判断する。棄却: `is` で null をまとめる（最近の null 行が古い null 行の削除を止める）
- 採用: 集計しない。棄却: 日ごとの件数を残す（読む所が無い）
- 採用: 保持は 90 日の定数。棄却: 設定で変えられるようにする（使う人がいない）

## 手順

- S1: schema revision 7（delivery_unit の作り直し、delivery_ad、delivery_at、capture_delivery_prune）と移行・fixture・codegen
- S2: captureAuthorizer と INGEST_TRIGGER_WRITES
- S3: deliver.ts の write() で prune を呼ぶ
- S4: 時間と互換性の検査（大量の古い行がある DB でのフック全体の時間、0.6.17 の authorizer からの書き込み）
- S5: 0.6.18 に揃える

## 完了条件

- A1: `cd server && node --test test/migrate.test.ts test/schema.test.ts test/db.test.ts` → pass。revision 6 から移行した DB と新しい DB の定義が一致し、revision 6 の delivery・delivery_unit の行が残り、foreign_key_check が空
- A2: `cd server && node --test --test-name-pattern="retention" test/deliver.test.ts` → pass。最後の配信が cutoff より前のセッションの行と、その delivery_unit が消える / ちょうど cutoff の行を持つセッションは残る / cutoff 以降に配信のあるセッションは古い行も残る / null の session の行は行ごとに消える / 450 行の古い行が 3 回の配信で 250 → 50 → 0 になる
- A3: `cd server && node --test --test-name-pattern="prune|delete" test/db.test.ts` → pass。capture 接続から delivery・delivery_unit への直接の delete は拒否され、capture_delivery_prune への insert は通る。delivery_ad 以外のトリガー名では delivery_unit を消せない
- A4: `cd server && node --test --test-name-pattern="retention timing" test/deliver.test.ts` → pass。一時ファイルの DB に消す対象 10,000 行と、最近の配信で守られる古い行 10,000 行を入れ、実 capture 接続で deliver.ts を子プロセスで pre_read として流すと、1 回目で delivery が 200 行減り、フック全体が 1 秒未満で終わる
- A5: `cd server && node --test --test-name-pattern="older capture" test/db.test.ts` → pass。0.6.17 の captureAuthorizer と同じ規則の接続で、revision 7 の DB の capture_delivery と capture_delivery_scoped に unit 付きで書ける
- A6: `cd server && node --test test/deliver.test.ts` → pass（beforeRead・resume・compact/clear・agent ごと・並行・ロック中 1 秒未満の既存テストを含む）
- A7: `bun run release:plan -- --base v0.6.17` → plugin。npm と 3 つの manifest が 0.6.18
- A8: `bun run verify` → exit 0（sql:reach で prune の呼び出しが数えられる）

## リスク

- 移行で delivery_unit を作り直すとき、配信のトリガーを戻し忘れて定義がずれる → A1 の定義の一致で落ちる
- 古い行が多い DB で、最近のセッションの古い行を毎回調べ直して遅くなる → A4 で測る。1 秒を超えたら候補の走査に上限を足す案を Codex と詰め直す
- 0.6.17 と 0.6.18 が混在するとき、0.6.17 の配信は prune を呼ばない → 消えるのが遅れるだけで壊れない
- 消した後に同じ古いセッションが再開すると、記録がもう一度出て予算も戻る → 90 日以上空いた再開は文脈が残っていない前提で許す

## 未解決

なし

## 変更履歴
- 2026-10-02 / 案 A の棄却理由に注記: 0.6.17 の deliver は revision 7 の DB では reader が revision を確かめて止まり、ログを書かない（review-shipping が 0.6.17 の tarball で再現）。案 A でも 0.6.17 の配信ログは壊れず、B を採る理由は「既存の配信トリガーと権限を変えずに済む」だけになる。採った案は変えない / 事実の誤りの訂正 / Go 不要
- 2026-10-02 / 方針 3 の prune を、ログの 2 つの insert の後から前へ移した / 90 日以上あいたセッション自身の配信が最初に来ると、先に入った今の行がそのセッションの古い行を守ってしまう（GitHub の Codex レビュー、再現済み） / Go 不要（規則は変えず、規則どおりに動かす修正）
- 2026-10-02 / capture_delivery_prune に session_id の列を足し、トリガーがまずそのセッションの古い行を上限なしで消してから、ほかの 200 行を消すようにした。write() はログを書くセッションを渡す / 90 日を過ぎた行が 200 行を超えて溜まっていると、戻ってきたセッションの古い行が上限で残り、新しい行に守られる（Codex の再レビュー、再現済み。持ち主が「今直す」を選んだ） / Go 不要（規則は変えない。ビューは未リリース）
