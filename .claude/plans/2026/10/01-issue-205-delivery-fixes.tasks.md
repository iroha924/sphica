---
kind: tasks
plan: 01-issue-205-delivery-fixes.plan.md
branch: fix/issue-205-delivery
base: main
---

# #205 前半: 配信フックの再現済みの不具合 3 件を直し、退役した記録を自動配信しないことを固定する のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 配信の不具合を直す

紐付けの無い Read・Edit が行を増やさず、プロンプトの path が別のファイルに当たらず、書き込みロック中も本文がすぐ返る。

- [x] T01: 空の Read・Edit の配信でログを書かない
  - 種別: 修正
  - 計画: S1, S6
  - 依存: なし
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - red: `cd server && node --test --test-name-pattern="no rows" test/deliver.test.ts` → 新しい session で紐付けの無い path を 50 回 Read・Edit すると delivery と session が増えて落ちる
  - 完了条件: `cd server && node --test test/deliver.test.ts` → pass（delivery と session の増分 0、配信済みで空になった再 Read もログが増えない、session_start と prompt の空ログは残る）
  - コミット: `fix(deliver): stop logging reads and edits that delivered nothing (T01)`
  - 結果: red 実測: 直す前のコードで新しいテストが `actual: { delivery: 100, session: 2 }, expected: { delivery: 0, session: 1 }` で落ちた。直した後 `node --test test/deliver.test.ts test/deliver-codex.test.ts` → pass 24 / fail 0（既存テストの nothing 行の期待を emitted だけに直した）

- [x] T02: プロンプトの path を境界と区切りの規則で照合する
  - 種別: 修正
  - 計画: S2
  - 依存: なし
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - red: `cd server && node --test --test-name-pattern="prompt names a path" test/deliver.test.ts` → `web/src/db.tsx`・`web/src/db.ts`・`src/db.ts.bak`・`src/db.ts._bak`・`src/db.ts.$bak`・`web\src\db.ts`・`..\src\db.ts` が `src/db.ts` の記録を出して落ちる（と、`src\lib/db.ts`・`.\src\lib/db.ts`・root を含む絶対表記が当たらずに落ちる）
  - 完了条件: `cd server && node --test test/deliver.test.ts` → pass（上の否定例は出ず、`src/db.tsを直して`・`「src/db.ts」`・`` `src/db.ts` ``・`(src/db.ts)`・混在区切り・絶対表記は出る）
  - コミット: `fix(deliver): match a path named in a prompt on its boundaries, not as a substring (T02)`
  - 結果: red 実測: 直す前のコードで、肯定例 3 件（`src\lib/db.ts`、`.\src\lib/db.ts`、区切りの混ざった root の絶対表記）が外れ、否定例 6 件（`web/src/lib/db.ts`、`.tsx`、`.bak`、`._bak`、`.$bak`、`/elsewhere/src/lib/db.ts`）が当たった。直した後 `node --test test/deliver.test.ts test/deliver-codex.test.ts` → pass 25 / fail 0

- [x] T03: ログを短い待ち時間の 1 トランザクションで書き、ロック中は本文だけ返す
  - 種別: 修正
  - 計画: S3
  - 依存: なし
  - 変更: `server/src/deliver.ts`, `server/src/db-write.ts`, `server/src/sqlite.ts`, `server/test/deliver.test.ts`
  - red: `cd server && node --test --test-name-pattern="write lock" test/deliver.test.ts` → 別接続が `begin immediate` を握っている間、紐付けのある path の Read と Bash の名指しで deliver() が 1 秒以内に返らず落ちる
  - 完了条件: `cd server && node --test test/deliver.test.ts test/db.test.ts` → pass（ロック中は 1 秒以内に本文が返りログは 0 行、解放後の同じ Read で同じ記録がもう一度出る、後段の insert が失敗したら session 行も残らない）。saveText と capture のバッチのロック時間を一時 DB で測り、入力の件数・サイズと一緒に結果行に残す
  - コミット: `fix(deliver): answer before the log when the database is write-locked (T03)`
  - 結果: red 実測: 直す前のコードで `read took 5231 ms` で落ちた。log を 1 トランザクションにしない形へ一時的に戻すと `no session row is left without its delivery` で落ちることも確かめた。直した後 `node --test test/deliver.test.ts test/deliver-codex.test.ts test/db.test.ts test/capture.test.ts` → pass 78 / fail 0
  - 結果: ロック時間の実測 `node test/.tmp-measure/measure.ts` → 2 回とも同じ値（一時のスクリプトで、測った後に消した）。capture の write() に 500 件・各 1800 バイトのメッセージで 44 ms、record の保存（openRun・checkRecord・saveRecord を 1 トランザクション）に証拠・採用・anchor 1 つ・別名 2 つを持つ決定 20 件で 24 ms。250 ms のままにした

## P2: 退役した記録の固定と配布物の検査

superseded・withdrawn の記録が自動配信に出ないことと、展開した配布物がロック中もすぐ答えることを、検査で固定する。

- [x] T04: superseded・withdrawn の記録を自動配信しない受け入れケースと review のテスト
  - 種別: 追加
  - 計画: S4
  - 依存: なし
  - 変更: `server/evals/acceptance/cases.json`, `server/test/acceptance-cases.test.ts`, `server/test/review-bridge.test.ts`
  - 完了条件: `cd server && node --test test/acceptance-cases.test.ts test/deliver.test.ts && bun run acceptance` → pass（superseded と withdrawn それぞれ pre_edit・pre_read・prompt の path・prompt の option・session_start の独立ケースで出ず、同じ条件の active の記録は出る。review も同じ）。今のコードで初回 green の見込みなので、その旨を結果行に書く
  - コミット: `test(deliver): pin that superseded and withdrawn records are never delivered (T04)`
  - 結果: `node --test --test-name-pattern="capture-1[23]|glean-14|injection-(1[4-9]|2[0-3])" evals/acceptance/run.ts` → 13 件 pass（初回 green。今のコードの lifecycle の絞り込みを固定するテスト）。deliverable() の絞り込みを一時的に active・superseded・withdrawn に広げると injection-14〜23 の 10 件と review のテストが落ちることを確かめた。`node --test test/review-bridge.test.ts test/acceptance-cases.test.ts` → pass 14 / fail 0

- [x] T07: 空ログのテストを日付に依存させず、空の session_start のログを確かめる
  - 種別: 修正
  - 計画: S1
  - 依存: T01（直す対象のテスト）
  - 変更: `server/test/deliver.test.ts`
  - red: `cd server && node --test --test-name-pattern="deliver nothing write no rows" test/deliver.test.ts` → 直す前のテストは session_start に emitted を期待し、未 trace の通知（直近 30 日）が消える 2026-10-11 以降は正しい実装でも落ちる。空の session_start のログを省く退行も捕まえない
  - 完了条件: `cd server && node --test test/deliver.test.ts` → pass。session_start が空を返し nothing の行が残ることを見る
  - コミット: `test(deliver): keep the empty-log test independent of the date (T07)`
  - 結果: 発言の日時を 2026-01-01 に固定し、session_start が "" を返して session_start・nothing の行が残ることを見る形にした。red 実測: 空ログを省く条件を pre_read・pre_edit 以外にも広げる退行を一時的に入れると、直す前のテストは pass、直した後のテストは fail 1 で落ちた。`node --test --test-name-pattern="deliver nothing write no rows" test/deliver.test.ts` → pass 1 / fail 0

- [x] T05: 展開した deliver.js がロック中に 1 秒未満で目的の記録を返す検査
  - 種別: 追加
  - 計画: S5
  - 依存: T03（ロック中に応答する実装が無いと検査が落ちる）
  - 変更: `scripts/check-tarball.mjs`
  - 完了条件: `bun run bundle && npm pack --pack-destination <tmp> && node scripts/check-tarball.mjs <tgz>` → exit 0（ロック前の別 session で肯定確認、ロック中の起動から終了が 1 秒未満で additionalContext に目的の key が入る、ロックは finally で解放）
  - コミット: `test(release): check the packed delivery hook answers under a write lock (T05)`
  - 結果: `bun run bundle && (cd plugin && npm pack --pack-destination <tmp>) && node scripts/check-tarball.mjs <tgz>` → 「43 files ... and delivered under a write lock」で exit 0。T03 より前の deliver.ts で作った tarball では `under a write lock the delivery hook took 5291 ms` で落ちることを確かめた

## P3: リリースの準備

- [-] T06: リリースの区分と版の一致を確かめる（取りやめ。S6 は T01 が担う）
  - 種別: 変更
  - 計画: S6
  - 依存: T01（版を上げたコミット）
  - 変更: `plugin/package.json`
  - 完了条件: `bun run release:plan -- --base v0.6.15` → plugin、4 ファイルが 0.6.16
  - コミット: `chore(release): bump to 0.6.16 (T06)`

## 記録
- 2026-10-01 / T01・T06 / pre-commit の bundle の検査が、パッケージの入力を変える最初のコミットで版が上がっていないと落とす（前回の計画と同じ） / 0.6.16 への版の上げを T06 から T01 へ移した。T01 の変更欄: deliver.ts・deliver.test.ts → それに 4 つの manifest を足した。T01 の計画欄: S1 → S1, S6。T06 は取りやめ（コードを変えないコミットになり、release:plan と verify の確認は plan の完了条件 A1・A5 で流す）。`bun run release:plan -- --base v0.6.15` → release kind: plugin、inputs: server/src/deliver.ts
- 2026-10-01 / T04 / review の配信のテストは review-bridge.test.ts にまとまっているので、そちらに足した。変更欄: deliver.test.ts → review-bridge.test.ts。withdrawn は owner 接続で unit_state に active → withdrawn を入れて作った（trigger は通る）
- 2026-10-01 / T01 / Codex のレビュー（44ae063c）: 指摘 1 件（P2）。空ログのテストが未 trace の通知の有無（日付）に依存し、空の session_start のログを確かめていない / 採用。修正タスク T07 を足した
- 2026-10-01 / T02 / Codex のレビュー（2e7c09dc）: 指摘 0 件
- 2026-10-01 / T05 / macOS の一時ディレクトリはリンク（/var → /private/var）で、git の root は実体のパスで返るため、Read の path が root の外に見えて配信が空になった / 一時ディレクトリを realpathSync で実体に揃えた
