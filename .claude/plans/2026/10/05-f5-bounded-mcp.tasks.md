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

- [x] T03: precedent.md と SKILL.md に束ごとの手順と受領行の照合を書く
  - 種別: 変更
  - 計画: S2
  - 依存: T01（返答の文言と受領行の形が要る）, T02（finding の形の書き換えが要る）
  - 変更: `plugin/skills/review/reviewers/precedent.md`, `plugin/skills/review/SKILL.md`, `server/test/plugin.test.ts`
  - 完了条件: `cd server && node --test test/plugin.test.ts` → pass。precedent.md に束ごとの select → read（続きも）→ 判定 → check と受領行、1 記録 1 finding、作業ツリーの変化は検出しない前提があり、SKILL.md に欠落・重複・selection の混在で blocked_unknown の規定がある
  - コミット: `docs(review): walk every batch of the decision lane and reconcile the receipts`
  - 結果: `node --test --test-name-pattern 'review Skill walks|unknown argument' test/plugin.test.ts` → 2 pass（規定の存在の検査。モデルの実際の照合は検証していない）。SKILL.md の行数上限（497）のため、照合の規定は既存の UNKNOWN の箇条に 1 行で入れ、元からあった二重の空行を 1 つにした。`bun run verify` → 0

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

- [x] T09: 受領行の書式をツールの返事と同じ大文字の `Batch k of n backed` にそろえる
  - 種別: 修正
  - 計画: S2
  - 依存: T03（受領行の規定がある）
  - 変更: `plugin/skills/review/reviewers/precedent.md`, `plugin/skills/review/SKILL.md`, `server/test/plugin.test.ts`
  - red: `cd server && node --test --test-name-pattern 'review Skill walks' test/plugin.test.ts` → 受領行の書式が checkedText の返事（`Batch 1 of 2 backed (selection ...)`）の先頭と一致せず fail
  - 完了条件: `cd server && node --test --test-name-pattern 'review Skill walks' test/plugin.test.ts` → pass。precedent.md と SKILL.md の受領行がすべて `Batch k of n backed` で、checkedText の返事の先頭がその形で始まる
  - コミット: `fix(review): write batch receipts exactly as review_check replies`
  - 結果: red: `node --test --test-name-pattern 'review Skill walks' test/plugin.test.ts` → precedent.md に「Batch 1 of <n> backed (selection <selection>)」が無く fail
  - 結果: 実装後 → 1 pass（checkedText の返事が `Batch \d+ of \d+ backed (selection ` で始まり、precedent.md と SKILL.md の受領行に小文字の `batch k of` が無い）。`bun run verify` → 0

- [x] T10: 受領行の例と規定に、返事の 1 文目の末尾のピリオドまで含める
  - 種別: 修正
  - 計画: S2
  - 依存: T09（受領行が大文字の形になっている）
  - 変更: `plugin/skills/review/reviewers/precedent.md`, `plugin/skills/review/SKILL.md`, `server/test/plugin.test.ts`
  - red: `cd server && node --test --test-name-pattern 'review Skill walks' test/plugin.test.ts` → precedent.md に「Batch 1 of <n> backed (selection <selection>).」の行が無く fail
  - 完了条件: `cd server && node --test --test-name-pattern 'review Skill walks' test/plugin.test.ts` → pass。checkedText の返事が `Batch k of n backed (selection <16 桁>).` で始まり、precedent.md の例 2 行と規定、SKILL.md の照合の規定がピリオドまで同じ形
  - コミット: `fix(review): copy the receipt's closing period too`
  - 結果: red: 上の完了条件のコマンド → 「Batch 1 of <n> backed (selection <selection>).」で fail。実装後 → 1 pass。`bun run verify` → 0

- [x] T13: 束の境目でない after を review_select と review_check で拒む
  - 種別: 修正
  - 計画: S1
  - 依存: T01（束がある）
  - 変更: `server/src/review.ts`, `server/src/review-findings.ts`, `server/src/mcp.ts`, `server/test/review.test.ts`, `server/test/plugin.test.ts`
  - red: `cd server && node --test --test-name-pattern 'review batch boundary' test/review.test.ts` → 120 件で after に 1 件目の id を渡した check が問題なしを返し fail
  - 完了条件: `cd server && node --test test/review.test.ts` → pass。境目でない after の check が「after N is not where a batch review_select gave ends」を返す
  - コミット: `fix(review): refuse an after that is not where a batch ended`
  - 結果: red: 上のコマンド → 問題なし（[]）で fail。実装後 `node --test test/review.test.ts` → 13 pass。review_select も境目でない after を not checked で返す。`bun run verify` → 0

## P2: read の応答の上限（#267）

read に何個の ref を渡しても 1 回の応答が 64 KiB 以下で、続きを辿れば全文に届く。

- [x] T04: record の描画を同じ呼び出しの他の refs から切り離す（rename の予算を record ごとに数える）
  - 種別: 変更
  - 計画: S3
  - 依存: なし
  - 変更: `server/src/read.ts`, `server/test/read.test.ts`, `server/test/record.test.ts`
  - 完了条件: `cd server && node --test --test-name-pattern 'read rename budget' test/read.test.ts` → pass。同じ record の描画が、一緒に読む refs とその順によらず一致する
  - コミット: `fix(read): count rename lookups per record so other refs do not change it`
  - 結果: 直す前: `node --test --test-name-pattern 'read rename budget' test/read.test.ts` → 5 つの commit を使う record の後に読んだ record が「rename not checked」になり、単独で読んだ描画と一致せず fail
  - 結果: 実装後 → 1 pass。`node --test --test-name-pattern 'rename' test/record.test.ts` → 3 pass（1 record あたり 5 commit の上限はそのまま）。`bun run verify` → 0

- [x] T05: readRefs で応答全体を 64 KiB に収め、source のヘッダーを制限し、record を byte と digest で続ける
  - 種別: 修正
  - 計画: S3
  - 依存: T04（digest が他の refs によらないことが要る）
  - 変更: `server/src/read.ts`, `server/src/mcp.ts`, `server/test/read.test.ts`
  - red: `cd server && node --test --test-name-pattern 'read budget' test/read.test.ts` → 長い source 10 件の read の text が 64 KiB を超えて fail
  - 完了条件: `cd server && node --test --test-name-pattern 'read budget' test/read.test.ts` → pass。各応答の text が 64 KiB 以下、続きを辿ると全 source の本文と全 record の描画に全バイト一致で届く、1 行が 64 KiB を超える引用、長いヘッダー、2/3/4 bytes の文字が境界に来る本文で offset が毎回増える、描画が変わると digest の不一致、入らない refs が次に渡す refs で返る
  - コミット: `fix(read): keep each reply within 64 KiB and continue records and sources where they stopped`
  - 結果: red（MCP サーバー経由、直す前の mcp.ts）: `node --test --test-name-pattern 'read budget' test/read.test.ts` → 長い source 10 件の read が 551020 bytes で fail
  - 結果: 実装後 `node --test test/read.test.ts` → 4 pass（MCP 経由で 64 KiB 以下、1〜4 bytes の文字が混じる source 2 件を続きで全バイト一致まで辿り offset が毎回増える、10 refs で切れた ref の続きが先頭で残りが順に並ぶ、長いヘッダーの source が 1,600 bytes 未満のヘッダーで本文を全部読める、64 KiB を超える 1 行の引用を持つ record を u<id>@<byte>:<digest> で全バイト一致まで辿る、他の refs の後で切れた続きを単独で読んでも digest が一致、記録の変化で最初からの読み直しを返す）。案内の大きさの見積もりで残りのバイト数を 0 として数え 2 bytes 超えたので、最大の桁数で数える形に直した。`bun run verify` → 0

- [x] T11: 切った本文を案内より先に plain にし、閉じていない端末の制御文字列が続きの案内を消さないようにする
  - 種別: 修正
  - 計画: S3
  - 依存: T05（readRefs がある）
  - 変更: `server/src/read.ts`, `server/test/read.test.ts`
  - red: `cd server && node --test --test-name-pattern 'read cut terminal' test/read.test.ts` → OSC の途中で切れた source の案内と次の refs が消え、`VISIBLE END` に届かず fail
  - 完了条件: `cd server && node --test test/read.test.ts` → pass。OSC の途中で切っても続きを辿って `VISIBLE END` に届き、返答に ESC が残らない
  - コミット: `fix(read): clean each piece before its note so an open escape cannot hide the rest`
  - 結果: red: 上のコマンド → `VISIBLE END` が無く fail。実装後 `node --test test/read.test.ts` → 5 pass。`bun run verify` → 0

- [x] T14: source のヘッダーの欄を、制御文字を除いてから切る
  - 種別: 修正
  - 計画: S3
  - 依存: T05（readRefs と欄の切り詰めがある）
  - 変更: `server/src/read.ts`, `server/test/read.test.ts`
  - red: `cd server && node --test --test-name-pattern 'read header terminal' test/read.test.ts` → url に OSC を持つ source の本文 `VISIBLE BODY` が返答に無く fail
  - 完了条件: `cd server && node --test test/read.test.ts` → pass。ヘッダーの欄に OSC があっても本文が出て、返答に ESC が残らない
  - コミット: `fix(read): clean header fields before clipping them`
  - 結果: red: 上のコマンド → `VISIBLE BODY` が無く fail。実装後: 欄を inline してから切り、ヘッダーと本文を別々に plain にした。`node --test test/read.test.ts` → 6 pass。`bun run verify` → 0

## P3: overview look の続き（#267）

look を続けて呼べば、2,000 件より先のアンカーと見出しごとの 50 行より先の指摘に届き、最後が Complete と言う。

- [x] T06: look に不透明なカーソルを足し、アンカー・条件・markers を段階ごとに続ける
  - 種別: 修正
  - 計画: S4
  - 依存: なし
  - 変更: `server/src/overview.ts`, `server/src/mcp.ts`, `server/test/overview.test.ts`
  - red: `cd server && node --test --test-name-pattern 'look cursor' test/overview.test.ts` → 2,500 アンカーで 2,000 件目より後の gone のファイルが、どの呼び出しでも出ずに fail
  - 完了条件: `cd server && node --test --test-name-pattern 'look cursor' test/overview.test.ts` → pass。gone と lost の混在、指摘ゼロのアンカーだけのページ、見出しあたり 120 件の options と deferred の条件、複数ファイルの markers で全指摘に 1 回ずつ届き、最後が Complete、各ページが 64 KiB 以下。壊れたカーソル・live に文字列・look に整数は引数エラー
  - コミット: `fix(overview): continue the look view past its anchor and line caps with a cursor`
  - 結果: red: `node --test --test-name-pattern 'look cursor' test/overview.test.ts` → 2,500 アンカーの最後の 1 件の gone のファイルが、どの呼び出しでも出ず fail（actual 0、expected 1）
  - 結果: 実装後 `node --test test/overview.test.ts` → 14 pass（2,500 アンカーで最初の 2,000 件の指摘ゼロのページも進んで最後が Complete、gone と lost の混在、120 件ずつの options と deferred の条件、2 ファイル 90 か所の markers がページをまたいで 1 回ずつ、壊れたカーソルの拒否、MCP で live に文字列・look に整数・壊れたカーソルが引数エラー）。1 ページ目にすべて出る前提だった既存テストは、ページをたどる形に直した。`bun run verify` → 0

- [x] T12: look のカーソルは、ページが返した文字列そのものだけを受け付ける
  - 種別: 修正
  - 計画: S4
  - 依存: T06（look のカーソルがある）
  - 変更: `server/src/overview.ts`, `server/test/overview.test.ts`
  - red: `cd server && node --test --test-name-pattern 'look cursor strict' test/overview.test.ts` → 末尾に `!` を足したカーソルが受け付けられて fail
  - 完了条件: `cd server && node --test test/overview.test.ts` → pass。前後の `!`、途中の空白、末尾の `=` を足したカーソルが null
  - コミット: `fix(overview): accept only the exact cursor a look page gave`
  - 結果: red: 上のコマンド → `eyJzIjoiYW5jaG9ycyIsImlkIjoyMDAwfQ!` が受け付けられて fail。実装後 `node --test test/overview.test.ts` → 15 pass。`bun run verify` → 0

## P4: acceptance

acceptance の driver が MCP と同じ組み立てを通り、束・続き・カーソルを検査する。

- [x] T07: driver とケースを readRefs・束・look のカーソルに合わせる
  - 種別: 変更
  - 計画: S5
  - 依存: T02（review_validate が finding の新しい形と束を通す）, T05（readRefs が要る）, T06（look のカーソルが要る）
  - 変更: `server/evals/acceptance/driver.ts`, `server/src/read.ts`, `server/test/search.test.ts`, `server/test/extract.test.ts`
  - 完了条件: `bun run verify` → 0。review・read・overview の acceptance ケースが新しい driver を通り、review_validate に diff・after・selection が渡る
  - コミット: `test(acceptance): drive review batches, read budgets, and look cursors as the tools do`
  - 結果: driver の read と read_of_source は readRefs、overview の look は文字列の after、review_select は reviewBatch（after 付き）、review_validate は diff・after・selection を通す。使われなくなった readSource と part を消し、それを呼んでいたテスト 2 本を readRefs に移した。`bun run verify` → 0（acceptance のケースは件数を変えずに全件 pass）

- [x] T15: driver の review_validate が、直前の review_select の selection をそのまま使う
  - 種別: 変更
  - 計画: S5
  - 依存: T07（driver が束と selection を通す）
  - 変更: `server/evals/acceptance/driver.ts`
  - 完了条件: `bun run verify` → 0。review_select の後の review_validate は、その diff・after・selection で checkFindings を呼ぶ（作り直さない）
  - コミット: `test(acceptance): check verdicts against the selection review_select gave`
  - 結果: `bun run verify` → 0。今のケースに review_select の後に記録を変えて検証するものは無いので、変化の検出を acceptance で通す red は作れない（selection の不一致の検出そのものは review.test.ts の 120 件のテストが見ている）

- [x] T16: read と look の上限を 32 KiB に下げ、look の行の予算を READ_BUDGET から決める
  - 種別: 変更
  - 計画: S3, S4
  - 依存: T05（READ_BUDGET がある）, T06（look のページの予算がある）
  - 変更: `server/src/read.ts`, `server/src/overview.ts`, `server/test/read.test.ts`, `server/test/overview.test.ts`, `server/test/search.test.ts`, `.claude/plans/2026/10/05-f5-bounded-mcp.plan.md`
  - 完了条件: `cd server && node --test test/read.test.ts test/overview.test.ts` → pass。read の各応答と、枠を付けた look の各ページが 32 KiB 以下で、続きを辿って全部に届く
  - コミット: `fix(read): keep read and look replies within 32 KiB, which Codex passes on whole`
  - 結果: `node --test test/read.test.ts test/overview.test.ts` → 21 pass。70 KiB の source を 2 回で読み切る前提だった search.test.ts を、続きを最後まで辿る形に直した。plan の上限の記述と変更履歴を直した。`bun run verify` → 0

- [x] T17: 最後の束より後の空の束の check を拒む
  - 種別: 修正
  - 計画: S1
  - 依存: T13（境目の判定がある）
  - 変更: `server/src/review-findings.ts`, `server/test/review.test.ts`
  - red: `cd server && node --test --test-name-pattern 'review batch empty' test/review.test.ts` → 50 件ちょうどで after に最後の id、findings が空の check が問題なしを返して fail
  - 完了条件: `cd server && node --test test/review.test.ts` → pass。空の束の check が「no record after N」を返す
  - コミット: `fix(review): refuse an empty batch, fit long look cursors, keep the selection`
  - 結果: red: 修正を stash した状態で上のコマンド → fail。実装後 `node --test test/review.test.ts` → 14 pass

- [x] T18: look のページに、markers のカーソルの大きさの分を確保する
  - 種別: 修正
  - 計画: S4
  - 依存: T16（look の予算が READ_BUDGET から決まる）
  - 変更: `server/src/overview.ts`, `server/test/overview.test.ts`
  - red: `cd server && node --test --test-name-pattern 'look cursor size' test/overview.test.ts` → 制御文字の多い長いディレクトリ名の CLAUDE.md で、1 ページ目が 33568 bytes になり fail
  - 完了条件: `cd server && node --test test/overview.test.ts` → pass。そのページが枠込みで 32 KiB 以下、40 か所の marker に 1 回ずつ届く
  - コミット: `fix(review): refuse an empty batch, fit long look cursors, keep the selection`
  - 結果: red: 上のコマンド → 33568 bytes で fail。実装後: markers の段で、残りの marker のカーソルの最大の大きさを確保し、ページに 1 行も無いときは確保なしで 1 行出す（前進の保証）。`node --test test/overview.test.ts` → 16 pass

- [x] T19: driver の review_validate は、review_select の後なら diff を明示しても保存した selection と after を使う
  - 種別: 変更
  - 計画: S5
  - 依存: T15（保存した selection がある）
  - 変更: `server/evals/acceptance/driver.ts`
  - 完了条件: `bun run verify` → 0
  - コミット: `fix(review): refuse an empty batch, fit long look cursors, keep the selection`
  - 結果: `bun run verify` → 0（T17〜T19 をまとめて）

## 記録

- 2026-10-05 / T01 / checkFindings の形が変わり、acceptance の driver の型検査が通らなくなる / 変更欄に `server/evals/acceptance/driver.ts` を足し（前: 無し）、review_validate を最小限合わせた。diff・after・selection を通すのは T07 のまま
- 2026-10-05 / T01 / Codex のタスクレビュー F1（P2、再現済み）: selection が parseDiff の結果から作られ、削除行だけが違う diff が同じ selection になる / 採る。plan は diff の本文から作ると決めていた。修正タスク T08 を足した
- 2026-10-05 / T02 / Codex のタスクレビュー: 指摘なし（Codex 側はテストを一時ディレクトリの EPERM で流せず、コードを読んでの判定） / 対応なし
- 2026-10-05 / T08 / Codex のタスクレビュー: 指摘なし / 対応なし
- 2026-10-05 / T03 / Codex のタスクレビュー F1（P2）: 受領行が小文字の `batch` で、review_check の返事（`Batch`）を写すと照合で食い違う / 採る。修正タスク T09 を足した
- 2026-10-05 / T04 / 変更欄: 前 `server/src/read.ts`, `server/src/mcp.ts`, `server/test/read.test.ts` → 後 `server/src/read.ts`, `server/test/read.test.ts`, `server/test/record.test.ts`（mcp.ts は変えず、上限の数え方が変わった既存テストの題名を直した）
- 2026-10-05 / T04 / Codex のタスクレビュー: 指摘なし（テストは EPERM で流せず、コードを読んでの判定） / 対応なし
- 2026-10-05 / T09 / Codex のタスクレビュー F1: 受領行の例に、返事の 1 文目の末尾のピリオドが無く完全一致しない / 採る。修正タスク T10 を足し、同じコミットで終えた
- 2026-10-05 / T05 / Codex のタスクレビュー F1（P2、再現済み）: 本文を OSC の途中で切ると、framed の plain が閉じていない制御文字列として続きの案内と次の refs まで消す / 採る。修正タスク T11 を足し、同じコミットで終えた
- 2026-10-05 / T07 / 変更欄: 前 `server/evals/acceptance/driver.ts`, `server/evals/acceptance/cases.json`, `server/test/acceptance-cases.test.ts` → 後 `server/evals/acceptance/driver.ts`, `server/src/read.ts`, `server/test/search.test.ts`, `server/test/extract.test.ts`。層ごとの件数は合意した数として acceptance-cases.test.ts が固定しているのでケースは足さず、driver が readRefs を通るようになって不要になった readSource を消した
- 2026-10-05 / T11 / Codex のタスクレビュー: 指摘なし / 対応なし
- 2026-10-05 / T06 / Codex のタスクレビュー F1（P2、再現済み）: base64url の decode が範囲外の文字を読み飛ばすので、壊れたカーソルが通る / 採る。修正タスク T12 を足し、同じコミットで終えた
- 2026-10-05 / 全差分 / Codex の全差分レビュー（high）F1（P2、再現済み）: 束の境目でない after から始めると、u1 を飛ばしたまま Batch 1〜3 of 3 の受領行がそろう / 採る。修正タスク T13
- 2026-10-05 / 全差分 / 同 F2（P2、再現済み）: source のヘッダーの欄を切ると端末の制御文字列の終わりが落ち、本文と続きの案内が消える / 採る。修正タスク T14
- 2026-10-05 / 全差分 / 同 F3（P2）: driver の review_validate が review_select の selection を使わず作り直すので、記録の変化の検出を通らない / 採る。修正タスク T15
- 2026-10-05 / 全差分 / review-shipping（再現済み）: Codex 0.160.0 は 64 KiB の read の応答を約 10,000 トークン（bytes/4 の見積もり）で真ん中から切り、続きの案内だけ残るので本文が黙って抜ける。Claude Code 2.1.289 は詰まった ASCII の 64 KiB をファイルに退避した / plan の前提（64 KiB は切られない）が誤り。上限の値と範囲を新しい会話で Codex と相談中
- 2026-10-05 / T16 / 上限の値を新しい会話で Codex と相談（session 01a10c61-fc03-7ce3-b9cf-7500406edeb2）: read と look は共通の 32 KiB、look は枠などの分を先に確保、live と review_select の返答の大きさは範囲の外で後追い、32 KiB の両ホストでの実測が要る / 採る。実測は完了確認の段で行う
- 2026-10-05 / T16 / 種別を修正から変更にし red の欄を消した（完了したタスクの欄の直し）/ 64 KiB の応答を Codex が真ん中で切ることはホストの挙動で、テストの中で落ちる red を作れない（review-shipping が packed の server で再現済み）。tasks の検査の違反を `| head` で見落としたままコミットしたので、このコミットで直した
- 2026-10-05 / 完了確認 / package にした server（HEAD 7907cd2d）で両ホストを 1 回ずつ実測: 150 KB の `LINE-00001 lorem ipsum dolor sit amet` の行の source を read の `["s1"]` で読む。Codex 0.160.0（codex exec --json、hooks と plugins は無効）は mcp_tool_call の結果が 33,701 文字で truncated なし、モデルは LINE-00001〜00852 を切れ目なく見て続きは s1@32348。Claude Code 2.1.289（claude -p、--strict-mcp-config）は tool_result がファイルに退避されずそのまま 33,660 文字、続きは s1@32348 / 32 KiB は両ホストでそのまま届く。日本語、引用符やバックスラッシュの多い本文、Codex の Code Mode は未計測
- 2026-10-05 / T13〜T16 / Codex の再レビュー（high）: F1（P2、再現済み）50 の倍数の件数で最後の id を after にした空の束の check が backed を返す → T17。F2（P2、再現済み）長いパスの指示ファイルのカーソルで look のページが 32 KiB を超える → T18。F3（P2）driver で diff を明示すると selection を作り直す → T19 / すべて採る
