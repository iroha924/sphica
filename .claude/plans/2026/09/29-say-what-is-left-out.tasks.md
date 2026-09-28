---
kind: tasks
plan: 29-say-what-is-left-out.plan.md
branch: fix/say-what-is-left-out
base: main
---

# 検索と配信が、見ていないもの・省いたもの・trace 待ちを黙らずに伝える（W4 #189、W7 #190、W3 #191） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 検索が上限で黙らない（W4 #189）

200 件より後ろの強い一致が見つかり、上限で止まったときは結果の文がそう言う。

- [x] T01: 検索の候補をページで読み進め、上限と stopped を足し、バージョンを 0.6.2 に上げる
  - 種別: 修正
  - 計画: S1, S7
  - 依存: なし
  - 変更: `server/src/search.ts`, `server/test/search.test.ts`, `plugin/package.json`, `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`
  - red: `cd server && node --test --test-timeout=60000 test/search.test.ts` → 弱い候補 210 件の後ろの強い一致のテストが、本文と記録の両方で `hits` が空のまま落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/search.test.ts` → 全部 pass（本文・記録の強い一致、`stopped` の true / false、本文のバイトの上限を含む）。`bun run release:plan -- --base 4567a93` → `plugin`、4 か所が 0.6.2
  - コミット: `fix(search): read candidates past the first 200 and say where the scan stopped`
  - 結果: red（直す前）→ 2 件失敗（本文の強い一致が `hits: []`、`stopped` が無い）。直した後 `node --test test/search.test.ts` → pass 7 / fail 0（本文と記録の強い一致、600 件で stopped、64 MiB で stopped と弱い候補 64 件）。`scripts/lib/release-scope.mjs` の `releaseKind` に差分のファイルを渡して `plugin`（`release:plan` はコミット済みの差分だけを見るので、コミット前は `none` と出た）。4 か所を 0.6.2 にそろえた。typecheck・lint → 0、`sql:reach` 153 / 153

- [x] T02: MCP の検索の文で、上限で止まったことを言う
  - 種別: 修正
  - 計画: S2
  - 依存: T01（`stopped` が要る）
  - 変更: `server/src/mcp.ts`, `server/src/search.ts`, `server/test/plugin.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/plugin.test.ts` → 上限で止まった検索の文が「No ... holds most of」と言い切り、候補の数を言わないので落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/plugin.test.ts` → 全部 pass
  - コミット: `fix(mcp): say when a search stopped before reading every candidate`
  - 結果: red（直す前）→ 上限で止まった本文の検索が `No source holds most of: retry, budget, cach, warm. 600 weaker matches left out.` と言い切って失敗。直した後 `node --test test/plugin.test.ts test/search.test.ts` → pass 34 / fail 0。typecheck → 0

- [x] T07: 候補の順番を 1 つの SQL で取ってからページごとに中身を引き、600 件のテストで強い一致を確かめる
  - 種別: 修正
  - 計画: S1
  - 依存: なし
  - 変更: `server/src/search.ts`, `server/test/search.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/search.test.ts` → 1 ページ目を読んだ後に先頭の候補を消すと、次のページで候補を 1 件飛ばすテストが落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/search.test.ts` → 全部 pass。`bun run sql:reach` → 全箇所
  - コミット: `fix(search): take the candidate order in one statement so writes between pages skip nothing`
  - 結果: red（直す前）`node --test test/search.test.ts` → 1 ページ目の後に先頭の候補を消すと、51 番目の強い一致を飛ばして `hits: []` で失敗。直した後 → pass 8 / fail 0（600 件のテストで強い一致が見つかることも確かめる）。`bun run sql:reach` → 157 / 157、typecheck・lint → 0

## P2: 配信が省いたものを言う（W7 #190）

上限から漏れた記録や作業の件数と見方が、配信の文に出る。今届いている記録は押し出さない。

- [x] T03: 各配信に省略の注記を足し、その字数を枠の外に確保し、session_start の省略を数える
  - 種別: 修正
  - 計画: S3
  - 依存: なし
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`, `server/test/review-bridge.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/deliver.test.ts` → 上限を超える記録を置いた各イベントのテストが、注記が無いので落ちる。何も入らないときのテストが空の文で落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/deliver.test.ts` → 全部 pass（既存の「記録が押し出されない」テストを含む）
  - コミット: `fix(deliver): say how many records and work items were left out and where to find them`
  - 結果: red（直す前）→ 編集の配信の最後の行が注記でなく記録（`- trace:ext-s1/e2 …`）で失敗。直した後 `node --test test/deliver.test.ts test/review-bridge.test.ts test/deliver-codex.test.ts` → pass 28 / fail 0（編集・読み取り・プロンプト・セッション開始（記録と作業の 2 つの注記）・review の注記、予算を使い切った後の読み取りが lead と注記だけで出る）。既存の予算のテスト 2 件は注記を記録と数えて落ちたので、記録の行（`- trace:`）と記録を渡した配信だけを数えるように直した

- [x] T04: delivery.chars から注記を除き、読み取りの予算を記録を渡した配信だけで数える
  - 種別: 修正
  - 計画: S4
  - 依存: T03（`Plan.note` と注記だけの配信が要る）
  - 変更: `server/src/deliver.ts`, `db/schema.sql`, `server/test/deliver.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/deliver.test.ts` → 注記付きの読み取りのログの chars に注記の字数が入って落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/deliver.test.ts` → 全部 pass
  - コミット: `fix(deliver): keep the omission note out of the read budget`
  - 結果: red（直す前）`node --test test/deliver.test.ts` → 注記付きの読み取りのログの chars が 862（注記を除くと 764）で失敗。直した後 `node --test test/deliver.test.ts test/review-bridge.test.ts test/deliver-codex.test.ts` → pass 28 / fail 0。`bun run typecheck` → 0

- [x] T08: session_start で渡した制約を fit の採った行で数え、省略の数を 0 未満にしない
  - 種別: 修正
  - 計画: S3
  - 依存: なし
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/deliver.test.ts` → 作業の文に制約の key があり、制約の行が入らないとき、制約の省略の注記が出ずに落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/deliver.test.ts` → 全部 pass
  - コミット: `fix(deliver): count the constraints session start showed by the lines it kept`
  - 結果: red（直す前）`node --test test/deliver.test.ts` → 作業 3 件の文に制約の key があり制約の行が入らないとき、「1 more record」の注記が出ずに失敗。直した後 `node --test test/deliver.test.ts test/review-bridge.test.ts test/deliver-codex.test.ts` → pass 29 / fail 0。typecheck → 0。省略の数を 0 未満にしない直しは、テストなし（記録を参照）

## P3: trace 待ちを知らせる（W3 #191）

trace 待ちのセッションがあると、セッション開始時に 1 日 1 回、件数と `/sphica:trace pending` が出る。

- [x] T05: trace 待ちの数え方を共通にし、session_start で 1 日 1 回知らせる
  - 種別: 追加
  - 計画: S5
  - 依存: T03（session_start の注記の枠と、lead だけでも出す経路が要る）
  - 変更: `server/src/deliver.ts`, `server/src/status.ts`, `server/test/deliver.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/deliver.test.ts test/status.test.ts` → 全部 pass（あると出る、無いと出ない、それだけでも出る、25 件で 25、同じ日の 2 回目は出ない）
  - コミット: `feat(deliver): tell at session start when sessions wait to be traced, once a day`
  - 結果: 実装前 `node --test --test-name-pattern="waiting to be traced" test/deliver.test.ts` → 失敗（行が無い）。実装後 `node --test test/deliver.test.ts test/status.test.ts` → pass 19 / fail 0（無いと出ない、trace 待ちだけでも lead と行が出る、25 件で 25、同じ日の 2 回目は出ない）。typecheck・lint → 0、`sql:reach` 157 / 157、architecture → 通過

## P4: acceptance

- [ ] T06: 検索の上限と配信の省略の acceptance case を足す
  - 種別: 追加
  - 計画: S6
  - 依存: T01（検索の上限）, T03（配信の注記）
  - 変更: `server/evals/acceptance/cases.json`
  - 完了条件: `bun run acceptance` → 追加した case を含めて全部 pass。`bun run verify` → 0
  - コミット: `test(acceptance): cover a search past the first candidates and a delivery that left records out`

## 記録

2026-09-29 / T02 / 文に読んだ件数を出すため、`searchUnits` と `searchSources` の返り値に `read` を足した / T02 の変更欄に `server/src/search.ts` を足した（前: `server/src/mcp.ts`, `server/test/plugin.test.ts`）
2026-09-29 / T03, T04 / T03 の注記だけの読み取りで既存の予算のテストが崩れるので、T04 の red を確かめてから同じコミットで終えた。後の読み取りの記録が注記で削られることを比べるテストは、今の上限（1 回 1500 字・1 セッション 3000 字・8 件）では差が出る状況を作れなかった（字数の組を総当たりして確かめた）ので、ログの chars が注記を除くことを確かめる形にした / T03 の変更欄に `server/test/review-bridge.test.ts` を足した（前: `server/src/deliver.ts`, `server/test/deliver.test.ts`）。T04 の red を「予算を使い切った後の注記だけの読み取りが予算を使う」から「ログの chars に注記が入る」に変えた
2026-09-29 / T01 / T01 の Codex レビュー 4 件: ページの間の書き込みで候補を飛ばす・二重に数える（F1）と、600 件のテストが強い一致を確かめていない（F4）は採用。件数に達して止まったときに stopped が false（F2）は見送り（stopped は上限で打ち切ったことを言い、件数がそろって止まるのは打ち切りではない。コメントで明記する）。1 ページの本文を先に読み込む（F3）は見送り（1 ページ最大約 51 MiB は plan で合意済み）。T02 のレビューは指摘なし / 修正タスク T07 を足す
2026-09-29 / T07 / reader の authorizer はトランザクションを許さないので、1 つのスナップショットで読む案は権限の境界を変えることになる / 候補の順番（id と rank）を 1 つの SQL で上限 + 1 件まで取り、中身をページごとに id で引く形にした。途中で消えた行は読まないだけになる
2026-09-29 / T08 / ec4390f の Codex レビュー 2 件: 作業の文に制約の key があると渡していない制約を渡したと数える（F1）と、作業の一覧と件数の間に作業が完了すると省略の数が負になりログの CHECK で落ちる（F2）。2 件とも採用。F2 のテストは配信が自分で開く DB 接続に割り込む仕組みが要るので付けず、0 未満にしない形で直す / 修正タスク T08 を足した
