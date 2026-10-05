---
kind: plan
status: approved
codex_session: 01a10c12-2775-78b2-904c-78f7359f513b
codex_rounds: 4
approved_at: 2026-10-05
---

# review の判定を 50 件で黙って打ち切らず束で回し、read と overview look に応答の上限と続きを付ける（#263 + #267）

## 要点

- review_select と review_check を 50 記録の束で回す。各束に selection（diff と各記録の u.id・revision から作る値）を付け、check の「通った」はその束の中だけを言う。全体の合格は、precedent の reviewer が同じ selection で全束の受領行を揃えたときだけ（Skill の手順）
- review_check の finding は 1 記録 1 要素にし、違反した場所は evidence に何か所でも並べる（各か所を今の規則で検査）。findings の上限 50 = 束の記録数
- read は枠まで含めた最終の応答を 64 KiB に収める。入らない ref は「次に渡す refs」で返し、source は今の `s<id>@<byte>`、単独で入らない record は `u<id>@<byte>:<digest>` で続きを読む
- overview look に不透明なカーソル（after）を足し、アンカーを 2,000 件より先へ、見出しごとの 50 行の打ち切りの先へ進める。最後のページは Complete と言う
- 変えないもの: DB schema、record_context のページ送り（u90）、export（u57）、overview live の after の意味、source の `s<id>@<byte>` の意味

## 持ち主の決定

- GitHub Project の Phase 01 の束 F5（#263 + #267）を 1 つの PR でやる（「OK、それやろう」）
- #263 の Items: 上限を上げるだけで済ませない。束に分けて判定し、判定の残った記録を名指しする。直す前のコードで「51 件選ばれ、50 件だけ判定」で落ちるテストを先に書く
- #267 の Items: read の応答全体の上限と続きの参照（record は丸ごとか、区切りの分かる形で）。look の続き（アンカーと打ち切った指摘の先へ、partial / complete を出す）。record_context の見た扱い（u90）と export（u57）は対象外

## 目的

- 選ばれた記録が 51 件以上でも、判定の無い記録が残ったまま review_check が全体の合格の文言（every verdict is backed）を返さず、残りを key で名指しする
- read に何個の ref を渡しても 1 回の応答（MCP の text 全体）が 64 KiB を超えず、続きを辿れば全 source の全バイトと全 record の描画の全バイトに届く
- overview look を続けて呼べば、2,000 件より先のアンカーと、見出しごとの 50 行より先の指摘に届き、最後のページが Complete と言う（ページの間に記録とファイルが変わらない前提）

## 対象外

- 束の受領行の照合を決定的なコード（MCP ツール）にすること。照合は review Skill の手順でモデルが行う。テストで確かめられるのは「規定が書かれている」までで、モデルが実際に照合するかは検証しない
- review の束の間の作業ツリーの変化（アンカーの状態）の検出。記録の変化は selection の revision で検出する
- look と live のページの間の変化の検出（助言の一覧なので、注記に留める）
- record_context（u90）と export（u57）

## 前提

- server/src/review-findings.ts:20-21 `MAX_FINDINGS = 50`、:59 判定なしを指摘するのは `selected.length <= MAX_FINDINGS` のときだけ。:56-62 は同じ記録に同じ outcome の複数要素を許す
- server/src/mcp.ts:411 review_check の findings も `.max(50)`。:375-399 review_select は選んだ記録を件数の上限なく返す。review_check は stateless で毎回 selectForReview をやり直す（review-findings.ts:35）
- server/src/review.ts:117-185 selectForReview は anchored を u.id 順、その後に場所の無い dont/defer（orderBy なし）を足す
- db/schema.sql の unit_rev_* と unit_state のトリガー: evidence・adoption・anchor・link・alias・field・lifecycle の関連の変化で unit.revision が上がる。本文は書き換えられない
- server/src/mcp.ts:231-252 read は refs 最大 10 件を "\n\n" で連結し framed で包む。上限なし。server/src/frame.ts:6-13 の framed は外枠と固定の説明を足す
- server/src/read.ts:396-432 readSource は本文を 64 KiB（PART）ずつ、続きは保存本文の中の byte offset の `s<id>@<byte>`。ヘッダー（kind・speaker・日時・url・path）は長さの上限なし
- server/src/record.ts:42 quote の長さは無制限で、read.ts:223-224・:247-250 は引用を 1 行に描画する。1 件の record の描画に上限は無い
- server/src/read.ts:381-399 movedTo の rename の lookup は、呼び出し内で共有する Map が 5 件に達すると「rename not checked」になる（他の refs の順で描画が変わる）
- server/src/overview.ts:116 LOOK_LIMITS（anchors 2000、lines 50、line 2200、bytes 56 KiB）。:146-152 アンカーは a.id 順の先頭 2,000 件だけ。:122-137 見出しごとに 50 行で打ち切り。続きの引数は無い（mcp.ts:346-351 の after は live だけ）
- server/src/extract.ts:44-47: Claude Code は既定で 25,000 tokens を超える応答を切るか退避する。64 KiB は CJK（3 bytes/文字）で約 21,800 文字。ホストが 64 KiB を切らないことは未検証（live の 1 ページも同じ大きさで運用している）
- server/evals/acceptance/driver.ts:608-627・:699-716 は MCP の応答の組み立てを通らず、readUnit・selectForReview・checkFindings（空の diff）を直接呼ぶ
- plugin/skills/review/SKILL.md:297-313 は reviewer の completion 行を launcher が照合し、不整合を UNKNOWN にする

## 方針

### review の束（#263）

- selectForReview の結果を u.id 順に固定する（free も含めて最後に id で並べ直す）。返す行に revision を足す
- `REVIEW_BATCH = 50`。review_select に `after`（整数、前の束の最後の u.id、省略で先頭）を足す。返答は「Decision lane: checked. Batch k of n (records i–j of N), selection <s>.」と id > after の先頭 50 件、続きがあれば「Next batch: call review_select with after: <id>」、無ければ「This is the last batch.」
- selection = sha256(diff の本文 + 選ばれた全記録の「u.id:revision」の列) の先頭 16 桁の hex
- review_check は diff・findings・after・selection を取る。今の選択から作り直した selection が違えば「the records this diff touches changed since review_select; start again from the first batch」の問題だけを返す
- 束の 50 件の各記録に finding がちょうど 1 要素（2 つ目以降は「one finding per record; list every place in its evidence」）。判定なしは件数によらず「<key>: no verdict」。束の外の記録への finding は「not in this batch」
- finding の `evidence` は今の 1 か所のオブジェクトか、か所の配列。配列に固定の上限は置かない。同じ（path、line）は 1 か所に数え、各か所を今の規則（diff にある path、追加行、gone のファイルは path だけ）で検査する。か所の数がその diff から列挙できる場所の数（追加行の数 + gone のファイルの数）を超えたら「more places than the diff has」の問題
- findings の要素数の上限は 50 のまま（= 束の記録数）。入力全体の大きさは diff の上限（mcp.ts の DIFF）と findings の件数で抑え、各 finding の異なる場所の数は diff から導く上限で検査する。reason と検査前の evidence の配列の長さには新しい上限を置かない
- 成功の文言は束に限る:「Batch k of n backed (selection <s>).」。最後の束でなければ続けて「Not judged in this call: M records (next batch: <最初の 50 件までの key>); call review_select with after: <id>」。「every verdict is backed」は使わない
- precedent.md: 束ごとに select → 全記録を read（read の続きも全部）→ 判定 → check を回す。出力に束ごとの受領行（batch k of n、selection、check の結果）を、既存の completion 行の前に書く。「several violations of one record are fine」を「list every place it is violated in that finding's evidence」に変える。作業ツリーの変化は検出しない前提を書く
- SKILL.md の台帳: precedent の結果は、同じ selection で 1..n の全束の受領行が揃い、欠落・重複・selection の混在が無いときだけ ran。それ以外は blocked_unknown

### read の応答の上限（#267）

- read.ts に `readRefs(db, projectId, refs, root)` を作り、描画・切り出し・案内・framed をまとめる。mcp.ts と acceptance の driver がこれを呼ぶ
- `READ_BUDGET = 64 * 1024` bytes を、framed を含む最終の text に掛ける。案内（続きの ref、未読の refs）と枠の bytes を先に確保する
- refs を順に描画し、収まる間は丸ごと足す。収まらない ref に来たら:
  - source: ヘッダー行全体を上限（例: 1,000 bytes。各欄を切ったら … で示す）に収め、ヘッダー + 案内 + 本文 1 文字分を確保して、本文だけを既存の `s<id>@<byte>` で切る
  - record: 描画全体を UTF-8 の byte で切り、文字境界まで戻す。続きは canonical な `u<id>@<byte>:<digest>`（digest は描画全体の sha256 の先頭 12 桁）。key で頼まれても続きは u<id> で返す
  - 2 つ目以降で 1 文字も入らない ref は次回へ回す。前進の定義は「少なくとも 1 文字を出し、offset が厳密に増える」
- 最後に「Not read in this reply (size): call read with refs: [...]」で残りの refs を返す
- `u<id>@<byte>:<digest>` を受けたら描画し直し、digest が違えば「u<id> changed since the previous page; read u<id> again from the start」を返す
- record の描画を他の refs から独立させる: rename の結果のキャッシュは呼び出し内で共有し、lookup の上限（5）は「その record で採用する異なる commit の数」で record ごとに数える（キャッシュ済みも同じ予算を使う）
- mcp.ts の read の refs の説明に続きの形を足す

### overview look の続き（#267）

- look に不透明なカーソル（base64url の JSON）を足す。overview の `after` は live では整数、look では文字列。live に文字列・look に整数は引数エラー。壊れたカーソルも引数エラー
- 段階と位置: anchors（a.id）→ options の条件（o.id）→ deferred の条件（u.id）→ markers（file、line、行内の出現番号。file は ruleFiles の順を path で並べ直して固定）
- 1 ページ: カーソルの位置から順に処理し、ページ全体の bytes（56 KiB）かアンカーの走査数（2,000）に達したら止める。アンカーは a.id 順に 1 件ずつ処理し、その指摘行を出せたときだけカーソルを進める（指摘の無いアンカーも処理済みとして進める）。出せなかったものは次のページで再処理
- 見出しごとの 50 行の打ち切りは外す。gone / lost などの見出し分けは、そのページで確定した分をまとめて出す
- 続きがあれば「Partial: call overview with view look and after: "<cursor>"」と、ページが別の時点で読まれる注記。最後は「Complete: every section was listed to its end. Not checked entries on any page still apply.」
- Not checked の節は毎ページ、そのページで走査した範囲について出す。「past the first 2,000」の項目はカーソルで先へ進めるので消す

### acceptance と配布

- driver: overview の after に文字列も通し、read は readRefs を通し、review_select / review_validate に diff・after・selection を通す
- release:plan の結果に従い、npm と 3 つの plugin manifest を同じバージョンに上げる

## 採った案と棄却した案

- 採用: review を 50 記録の束で回す。棄却: MAX_FINDINGS を上げるだけ（issue が退けている。1 人の reviewer が数百件を一度に判定する前提になる）
- 採用: check の成功を束の中に限り、全体の合格は Skill で全束の受領行を照合する。棄却: サーバーに束の進み具合を持たせる、照合用の MCP ツールを足す（読み取りサーバーに状態を足すか、ツールを増やすほどの価値が無い）
- 採用: selection に各記録の revision を入れる。棄却: diff と u.id だけ（束の間に記録の中身が変わっても同じ値になる）
- 採用: 1 記録 1 finding、evidence にか所を並べる（上限は diff の場所の数）。棄却: findings の上限を 200 にする（1 記録の violation が多いと結局超える）、evidence を 20 か所に制限する（21 か所の違反を検査しきれない）、要素数で束を割る（束の境目が 2 種類になる）
- 採用: record の続きは byte offset と digest。棄却: 行の境目で切る `@line`（64 KiB を超える 1 行を読めない）、key に @ の構文を足す（続きは u<id> に統一）
- 採用: source はヘッダーを制限して本文だけを既存の offset で切る。棄却: source の描画全体を byte で切る（既存の `s<id>@<byte>` の意味と衝突する）
- 採用: look のカーソルを段階ごとの安定した id の不透明な文字列にする。棄却: section:位置番号（一覧が変わると飛ばす）
- 採用: 予算は 64 KiB（live と同じ）。棄却: refs の上限を減らす（1 件だけで超え得る）

## 手順

- S1: review の束（review.ts の並びと revision、review-findings.ts の束・selection・1 記録 1 finding・evidence の配列、mcp.ts の review_select / review_check、テスト）
- S2: review Skill の手順（precedent.md、SKILL.md の台帳、plugin.test.ts の文面の検査）
- S3: read の応答の上限（read.ts の readRefs・source ヘッダー・record の byte 継続と digest・rename の予算、mcp.ts、テスト）
- S4: look のカーソル（overview.ts、mcp.ts の after の union、テスト）
- S5: acceptance の driver とケース、release:plan とバージョン

## 完了条件

- A1: `cd server && node --test --test-name-pattern 'review batch' test/review.test.ts` → pass。51 件選ばれ 1 束目に 50 件の finding で、check が束の成功と残り 1 件の key を返し、every verdict is backed と言わない（直す前のコードでは「No problems: every verdict is backed.」で落ちたことを tasks に残す）
- A2: `cd server && node --test --test-name-pattern 'review batch' test/review.test.ts` → pass。120 件を 3 束で回すと各束が成功し、2 束目だけの check も束の成功だけを言う。束の間に記録の revision を上げると selection の不一致で落ちる。1 記録に 21 か所の violation を 1 要素で渡すと全か所が検査される。同じ記録に 2 要素で問題になる
- A3: `cd server && node --test --test-name-pattern 'read budget' test/read.test.ts` → pass。長い source 10 件・単独で 64 KiB を超える record（1 行の引用が 64 KiB を超えるものを含む）・ヘッダーが長い source・2/3/4 bytes の文字が境界に来る本文で、各応答の text が 64 KiB 以下、続きを辿ると全 source の本文と全 record の描画の全バイトに一致して届き、offset が毎回増える。描画を変えると digest の不一致を返す。複数の refs で始めて単独の継続 ref で読んでも digest が一致する
- A4: `cd server && node --test --test-name-pattern 'look cursor' test/overview.test.ts` → pass。2,500 アンカー（gone と lost の混在、指摘ゼロのアンカーだけのページを含む）、見出しあたり 120 件の options と deferred の条件、複数ファイルの markers で、カーソルを辿ると全指摘に 1 回ずつ届き、最後が Complete、各ページが 64 KiB 以下。壊れたカーソル・live に文字列・look に整数は引数エラー
- A5: `cd server && node --test test/plugin.test.ts` → pass。precedent.md と SKILL.md に、束ごとの受領行と、欠落・重複・selection の混在で blocked_unknown にする規定がある（規定の存在の検査で、モデルの実際の照合は検証しない）
- A6: `bun run verify` → 0（acceptance の review・read・overview のケースが新しい driver を通る）
- A7: `bun run release:plan -- --base v0.6.34` → plugin、npm と 3 つの manifest が同じバージョン

## リスク

- ホストが 64 KiB 未満で応答を切る → live と同じ大きさなので同時に起きる。起きたら READ_BUDGET と LOOK の bytes を一緒に下げる
- 束の間の作業ツリーの変化で、アンカーで選ばれる記録が変わる → selection は diff と記録の revision だけを見る。作業ツリーの変化は検出しない前提を precedent.md に書く
- precedent の reviewer が全束を回しきらない（記録が多いと時間が掛かる）→ 受領行の照合で blocked_unknown になり、黙って通らない。束の数が多いときの実時間は未測定
- review_check の finding の形の変更（1 記録 1 要素）を古い Skill が使う → plugin の Skill と同じバージョンで出す。古い Skill の複数要素は問題として返るので黙って通らない

## 未解決

なし

## 変更履歴
