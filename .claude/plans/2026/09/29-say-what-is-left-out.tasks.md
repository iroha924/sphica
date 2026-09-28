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

## P2: 配信が省いたものを言う（W7 #190）

上限から漏れた記録や作業の件数と見方が、配信の文に出る。今届いている記録は押し出さない。

- [ ] T03: 各配信に省略の注記を足し、その字数を枠の外に確保し、session_start の省略を数える
  - 種別: 修正
  - 計画: S3
  - 依存: なし
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/deliver.test.ts` → 上限を超える記録を置いた各イベントのテストが、注記が無いので落ちる。何も入らないときのテストが空の文で落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/deliver.test.ts` → 全部 pass（既存の「記録が押し出されない」テストを含む）
  - コミット: `fix(deliver): say how many records and work items were left out and where to find them`

- [ ] T04: delivery.chars から注記を除き、読み取りの予算を記録を渡した配信だけで数える
  - 種別: 修正
  - 計画: S4
  - 依存: T03（`Plan.note` と注記だけの配信が要る）
  - 変更: `server/src/deliver.ts`, `db/schema.sql`, `server/test/deliver.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/deliver.test.ts` → 予算を使い切った後の注記だけの読み取りが予算を使い、その後の記録が届かないテストで落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/deliver.test.ts` → 全部 pass
  - コミット: `fix(deliver): keep the omission note out of the read budget`

## P3: trace 待ちを知らせる（W3 #191）

trace 待ちのセッションがあると、セッション開始時に 1 日 1 回、件数と `/sphica:trace pending` が出る。

- [ ] T05: trace 待ちの数え方を共通にし、session_start で 1 日 1 回知らせる
  - 種別: 追加
  - 計画: S5
  - 依存: T03（session_start の注記の枠と、lead だけでも出す経路が要る）
  - 変更: `server/src/deliver.ts`, `server/src/status.ts`, `server/test/deliver.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/deliver.test.ts test/status.test.ts` → 全部 pass（あると出る、無いと出ない、それだけでも出る、25 件で 25、同じ日の 2 回目は出ない）
  - コミット: `feat(deliver): tell at session start when sessions wait to be traced, once a day`

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
