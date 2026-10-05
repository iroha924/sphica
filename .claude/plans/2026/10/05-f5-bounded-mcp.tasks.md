---
kind: tasks
plan: 05-f5-bounded-mcp.plan.md
branch: fix/f5-bounded-mcp
base: main
---

# review の判定を 50 件で黙って打ち切らず束で回し、read と overview look に応答の上限と続きを付ける（#263 + #267） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: review の束（#263）

選ばれた記録が 51 件以上でも、review_check が判定の残った記録を名指しし、全体の合格を言わない。

- [x] T01: 束と selection で review_select / review_check を回し、判定の無い記録を件数によらず名指しする
  - 種別: 修正
  - 計画: S1
  - 依存: なし
  - 変更: `server/src/review.ts`, `server/src/review-findings.ts`, `server/src/mcp.ts`, `server/test/review.test.ts`, `server/evals/acceptance/driver.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - red: `cd server && node --test --test-name-pattern 'review batch' test/review.test.ts` → 51 件選ばれ 50 件に finding を渡すと「No problems: every verdict is backed.」が返り、残り 1 件の key が無くて fail
  - 完了条件: `cd server && node --test --test-name-pattern 'review batch' test/review.test.ts` → pass。並びが u.id 順、120 件が 3 束、各束の成功が束に限った文言、最後でない束は残りの key と after を返す、束の間に revision を上げると selection の不一致、束の外の finding は not in this batch
  - コミット: `fix(review): judge the decision lane in batches of 50 and name the records left`
  - 結果: red（reviewBatch だけ足し、checkFindings は直す前のまま）: `node --test --test-name-pattern 'review batch' test/review.test.ts` → 「the record left is named: []」で fail（51 件中 50 件の判定で問題なしを返し、r50 を名指ししない）。旧テスト「more records than findings can hold do not make every verdict set fail」はこの挙動を固定していたので置き換えた
  - 結果: 実装後 `node --test test/review.test.ts` → 10 pass（51 件の 2 束、120 件の 3 束を 1 回ずつ、束の外の finding と束の中の判定なし、conflicts の link で revision を上げると selection の不一致）。`bun run verify` → 0。版は 0.6.35

- [x] T02: 1 記録 1 finding にし、違反した場所を evidence の配列で全か所検査する
  - 種別: 変更
  - 計画: S1
  - 依存: T01（束ごとの検査の上に、記録ごとの要素数の規則を載せる）
  - 変更: `server/src/review-findings.ts`, `server/src/mcp.ts`, `server/test/review.test.ts`
  - 完了条件: `cd server && node --test --test-name-pattern 'review evidence' test/review.test.ts` → pass。21 か所の violation を 1 要素で渡すと全か所が検査され、追加行でない 1 か所が問題になる、同じ（path、line）の重複は 1 か所、diff の場所の数を超えると問題、同じ記録への 2 要素は問題、今の 1 か所のオブジェクトも通る
  - コミット: `feat(review): take one finding per record with every place it is violated`
  - 結果: `node --test test/review.test.ts` → 11 pass（review evidence: 21 か所を 1 要素で通す、1 か所が追加行でないと名指し、重複は 1 か所、23 か所の diff に 24 か所で拒否、同じ記録の 2 要素で問題）。上限を超える配列には必ず不正な場所が入るので、上限の検査を場所ごとの検査より先にした。`bun run verify` → 0

- [ ] T03: precedent.md と SKILL.md に束ごとの手順と受領行の照合を書く
  - 種別: 変更
  - 計画: S2
  - 依存: T01（返答の文言と受領行の形が要る）, T02（finding の形の書き換えが要る）
  - 変更: `plugin/skills/review/reviewers/precedent.md`, `plugin/skills/review/SKILL.md`, `server/test/plugin.test.ts`
  - 完了条件: `cd server && node --test test/plugin.test.ts` → pass。precedent.md に束ごとの select → read（続きも）→ 判定 → check と受領行、1 記録 1 finding、作業ツリーの変化は検出しない前提があり、SKILL.md に欠落・重複・selection の混在で blocked_unknown の規定がある
  - コミット: `docs(review): walk every batch of the decision lane and reconcile the receipts`

- [x] T08: selection を diff の本文から作る（解析後のファイル一覧では削除行と文脈が落ちる）
  - 種別: 修正
  - 計画: S1
  - 依存: T01（selection がある）
  - 変更: `server/src/review.ts`, `server/src/review-findings.ts`, `server/src/mcp.ts`, `server/test/review.test.ts`, `server/evals/acceptance/driver.ts`
  - red: `cd server && node --test --test-name-pattern 'review selection' test/review.test.ts` → 削除行だけが違う 2 つの diff の selection が同じで fail
  - 完了条件: `cd server && node --test test/review.test.ts` → pass。削除行・文脈だけが違う diff の selection が違い、同じ diff の本文なら同じ
  - コミット: `fix(review): tie the selection to the whole diff text`
  - 結果: red: `node --test --test-name-pattern 'review selection' test/review.test.ts` → 削除行だけが違う 2 つの diff で selection が一致して fail（reviewBatch に足した diff の引数を直す前のコードは使わない）
  - 結果: 実装後 `node --test test/review.test.ts` → 12 pass。`bun run verify` → 0

## P2: read の応答の上限（#267）

read に何個の ref を渡しても 1 回の応答が 64 KiB 以下で、続きを辿れば全文に届く。

- [ ] T04: record の描画を同じ呼び出しの他の refs から切り離す（rename の予算を record ごとに数える）
  - 種別: 変更
  - 計画: S3
  - 依存: なし
  - 変更: `server/src/read.ts`, `server/src/mcp.ts`, `server/test/read.test.ts`
  - 完了条件: `cd server && node --test --test-name-pattern 'read rename budget' test/read.test.ts` → pass。同じ record の描画が、一緒に読む refs とその順によらず一致する
  - コミット: `fix(read): count rename lookups per record so other refs do not change it`

- [ ] T05: readRefs で応答全体を 64 KiB に収め、source のヘッダーを制限し、record を byte と digest で続ける
  - 種別: 修正
  - 計画: S3
  - 依存: T04（digest が他の refs によらないことが要る）
  - 変更: `server/src/read.ts`, `server/src/mcp.ts`, `server/test/read.test.ts`
  - red: `cd server && node --test --test-name-pattern 'read budget' test/read.test.ts` → 長い source 10 件の read の text が 64 KiB を超えて fail
  - 完了条件: `cd server && node --test --test-name-pattern 'read budget' test/read.test.ts` → pass。各応答の text が 64 KiB 以下、続きを辿ると全 source の本文と全 record の描画に全バイト一致で届く、1 行が 64 KiB を超える引用、長いヘッダー、2/3/4 bytes の文字が境界に来る本文で offset が毎回増える、描画が変わると digest の不一致、入らない refs が次に渡す refs で返る
  - コミット: `fix(read): keep each reply within 64 KiB and continue records and sources where they stopped`

## P3: overview look の続き（#267）

look を続けて呼べば、2,000 件より先のアンカーと見出しごとの 50 行より先の指摘に届き、最後が Complete と言う。

- [ ] T06: look に不透明なカーソルを足し、アンカー・条件・markers を段階ごとに続ける
  - 種別: 修正
  - 計画: S4
  - 依存: なし
  - 変更: `server/src/overview.ts`, `server/src/mcp.ts`, `server/test/overview.test.ts`
  - red: `cd server && node --test --test-name-pattern 'look cursor' test/overview.test.ts` → 2,500 アンカーで 2,000 件目より後の gone のファイルが、どの呼び出しでも出ずに fail
  - 完了条件: `cd server && node --test --test-name-pattern 'look cursor' test/overview.test.ts` → pass。gone と lost の混在、指摘ゼロのアンカーだけのページ、見出しあたり 120 件の options と deferred の条件、複数ファイルの markers で全指摘に 1 回ずつ届き、最後が Complete、各ページが 64 KiB 以下。壊れたカーソル・live に文字列・look に整数は引数エラー
  - コミット: `fix(overview): continue the look view past its anchor and line caps with a cursor`

## P4: acceptance

acceptance の driver が MCP と同じ組み立てを通り、束・続き・カーソルを検査する。

- [ ] T07: driver とケースを readRefs・束・look のカーソルに合わせる
  - 種別: 変更
  - 計画: S5
  - 依存: T02（review_validate が finding の新しい形と束を通す）, T05（readRefs が要る）, T06（look のカーソルが要る）
  - 変更: `server/evals/acceptance/driver.ts`, `server/evals/acceptance/cases.json`, `server/test/acceptance-cases.test.ts`
  - 完了条件: `bun run verify` → 0。review・read・overview の acceptance ケースが新しい driver を通り、review_validate に diff・after・selection が渡る
  - コミット: `test(acceptance): drive review batches, read budgets, and look cursors through the shared builders`

## 記録

- 2026-10-05 / T01 / checkFindings の形が変わり、acceptance の driver の型検査が通らなくなる / 変更欄に `server/evals/acceptance/driver.ts` を足し（前: 無し）、review_validate を最小限合わせた。diff・after・selection を通すのは T07 のまま
- 2026-10-05 / T01 / Codex のタスクレビュー F1（P2、再現済み）: selection が parseDiff の結果から作られ、削除行だけが違う diff が同じ selection になる / 採る。plan は diff の本文から作ると決めていた。修正タスク T08 を足した
