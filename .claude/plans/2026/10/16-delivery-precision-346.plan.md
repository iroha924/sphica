---
kind: plan
status: approved
codex_session: 01a143a5-0e9b-7e51-b951-5b7db0d7a44c
codex_rounds: 3
approved_at: 2026-10-16
---

# #346 の手順 1: 自動配信の当たる率を抜き取りで測り、終わった計画を外す計画に進むかを決める

## 要点

- 直近 7 日（2026-10-09〜10-16）の配信の組（delivery 1 行 × 記録 1 件）から seed 固定で 80 組を抜き取り、Claude と Codex が別々に useful / irrelevant / unknown を付ける
- 各組に原因の分類（finished-plan / open-plan / plan-unknown / standing / other）を、記録の本文と配信時点の issue・PR の状態で付ける
- 抜き取りとラベル用のシートは `server/evals/delivery/sample.ts`、結果は `server/evals/delivery/precision-baseline.json`
- ラベルの前に固定した式で、終わった計画を配信から外す手順 2 の計画に進むかを決め、結果と防げた例を #346 に書く
- 配信の挙動・schema・record サーバー・パッケージは変えない（リリースなし）。手順 2 は結果を見てから別の計画にする

## 持ち主の決定

- 計画を配信から外すのは持ち主の言葉があるときだけ（CLAUDE.md の agent-adoption）。記録は書き換えない（#346 の本文）
- 採否の基準は測る前に決める（#346 の本文、#219 の形）
- 配信量の比較（手順 1 の前半）は済んだ（#346 のコメント、2026-10-16）
- 実験は PR のブランチで merge 前に測り、基準に届かないものは採らずに結果を issue に残す（epic #200 の Policy）

## 目的

- 自動配信のうち関係ないものの割合と、役に立った例・防げた例を、再現できる抜き取りで持つ
- 関係ない配信の原因がどの分類に偏っているかが分かり、終わった計画を外す手順 2 に進むかが式で決まっている

## 対象外

- 手順 2 の実装（trace の finished、アンカーの取り外し）と手順 3 の測り直し。手順 1 の結果を見てから別の計画にする。その計画は次の条件を満たす
  - merge 前に PR のブランチで測る（epic #200 の Policy）
  - 同じ配信の機会で旧・新を比べ、外した記録の代わりに空いた枠へ出る記録も評価する。別々の抜き取りの割合どうしは比べない（役に立つ配信が残ったかを判定できない）
  - 外した applies_to に頼る照合は、読む前・編集の前・シェルが名指したパス（`server/src/deliver.ts:1191`）・prompt のアンカー照合・review の各経路で止まる。prompt の選択肢の照合（`server/src/deliver.ts:807`）と、残る他のアンカー（evidence を含む。`server/src/review.ts:149`）による配信は残るので、経路ごとに測る
  - 作業の完了と記録全体の不要を区別する。計画の記録には続く条件も入っている（u157 search-fixes-plan のパスの検証や未知の引数の拒否）
  - 既に終わって配信され続けている計画（u361 m1-plan など）の扱いを決める。trace は 1 つのセッションに束縛され、引用できるのはそのセッションの source だけ（`server/src/record.ts:169`）
  - finished の入力は対象キー・revision・source・quote を持ち、trace 以外・他の project・持ち主でない引用・引用の不一致・対象外の状態・古い revision を拒否する。glean の revision の一致（`server/src/glean.ts:45`, `:409`）に合わせる
- 読む前の配信の並べ方（新しい順に最大 5 件、`server/src/deliver.ts:305` の `anchoredTo`）。古い記録が押し出される件（u81）は #346 のコメントに書いた
- symbol アンカーを読む前・編集の前の照合に使うこと（今は path だけで照合）

## 前提

- 計画の記録と作業項目（work）をつなぐ列・リンクは無い（`db/schema.sql` の unit 313 行、work 1193 行）。キーの文字列では計画を見分けられない: 窓のキーに plan を含む 522 組のうち decision 519、implementation 3 で、`readme-badge-explanations` や `lock-then-plan`（配信の処理の順序の決定）も含む（Codex が sqlite3 -readonly で集計、2026-10-16）
- 窓（2026-10-09T00:00:00.000Z 以上 2026-10-16T00:00:00.000Z 未満、project 1、outcome emitted）の組は 3,093、191 セッション（Claude Code 22、Codex 169）。kind は decision 2,307、constraint 648、dead_end 50、finding 47、implementation 41（同上）
- 編集の前（`server/src/deliver.ts:323`）、prompt（`:774`）、review（`server/src/review.ts:141`）は kind を限定しない。読む前（`server/src/deliver.ts:471`）だけが decision と constraint に限る
- 配信のログは最後の配信が 90 日より前のセッションの行を消し（`server/src/deliver.ts:1097`）、session や unit の削除で delivery_unit も消える（`db/schema.sql:1215`, `:1230`）。母集団は DB から読み直すと変わりうる
- 抜き取りの前例: #219 は母集団を時刻順に並べ mulberry32 で先頭 40 を取り、Claude と Codex が独立にラベルし、不一致は unknown にした（`server/evals/post-write/shell-write-trial.json`、`server/evals/post-write/replay.ts:202`）。unknown の解決次第で結論が変わるなら undecided にする判定がある（`server/evals/post-write/replay.ts:240`）
- Claude Code の会話の記録は `~/.claude/projects/<project>/<session>.jsonl`（サブエージェントは `<session>/subagents/`）。読み方は `server/evals/post-write/transcript.ts` にある。Codex の会話の記録の場所と形は未検証（`server/src/codex-log.ts` が読む形を S1 で確かめる）

## 方針

### 母集団と抜き取り（`server/evals/delivery/sample.ts`）

- DB は reader の接続で読み取り専用に開く。パスは引数で受け、`~/.sphica` を既定にしない
- 母集団: project の delivery のうち outcome = emitted、at が窓の中の行と、その delivery_unit の組。event はすべて、main とサブエージェントの両方
- 並べ方: (at, delivery.id, unit_id) の昇順。mulberry32（`replay.ts:202` を使うか同じ実装）、seed 20261016 でシャッフルし先頭 80
- 母集団の (delivery.id, unit_id) の一覧を JSON に保存し、その sha256、抽出条件、抽出した時刻も保存する。保存した母集団があればそれから抜き取る。生 DB から抽出し直した母集団が保存したものと違えば、違いを報告して止まる
- 抜き取った組ごとに、ラベル用のシート（Markdown）を出す: 配信の時刻・event・path・agent、記録のキー・kind・本文、配信の直前の持ち主の依頼、配信の後のそのターンの動き（読んだ・直したファイル、返答の頭）。会話の記録が見つからない組は「記録なし」と書き、抜き取りから除かない
- モード: 母集団の抽出（`--db`）、抜き取りとシート（`--sample`）、判定（`--decide`、ラベルの JSON を受ける）。足りない引数は名指しして止まる

### ラベル

- useful: その記録の中身が、その時点で agent がしていた作業の判断に関わる（反する変更を止める、守るべき条件を伝える、同じ失敗を避ける）
- irrelevant: その時点の作業と関係ない
- unknown: 決められない、または 2 者が食い違う
- Claude と Codex が別々に付け、両者のラベルと決定したラベルを残す。Codex には read-only でシートを渡す
- useful のうち、会話で agent が配信を受けて方針を変えたのが見える組は「防げた例」として、会話の該当箇所を残す

### 原因の分類（ラベルとは別。各組に 1 つ、元の kind と分類の理由も保存）

- finished-plan: 本文が計画で、対応する issue が閉じているか PR が merge 済み（配信の時点で。closedAt / mergedAt と、再 open があればその履歴で判定）
- open-plan: 本文が計画で、対応する作業が配信の時点で終わっていない
- plan-unknown: 本文は計画だが、対応する issue・PR か、その時点の状態が分からない
- standing: 計画でない decision・constraint
- other: decision・constraint 以外の kind（dead_end、finding、implementation など）
- キーの文字列は候補の抽出にだけ使う。計画かどうかは本文で決め、対応する issue・PR と日時を保存する

### 判定（ラベルの前に固定）

F = I + U + R（finished-plan の組の中。I は確定した irrelevant、U は unknown、R は useful）

- F < 8: 判定できない。手順 2 には進まない
- 5I >= 4F かつ R + U <= 1: 手順 2 の計画に進む
- 5(I + U) < 4F または R >= 2: 進まない（不採用）
- それ以外: undecided。unknown の組を持ち主に見せて決めてもらう
- 固定する例: (F, I, U, R) = (8, 7, 1, 0) は進む、(10, 8, 2, 0) は undecided、(8, 0, 8, 0) は undecided
- 判定によらず、分類ごとの件数と irrelevant（unknown を含む・含まない）の割合、防げた例を #346 に書く

### 結果の JSON（`server/evals/delivery/precision-baseline.json`）

- `shell-write-trial.json` の形に合わせる: note, window, inputs（DB と会話の記録の sha256）, population（定義・件数・一覧の sha256）, sampling（方法・seed・件数）, labels（定義）, sample（組ごとに claude / codex / settled / class / class_reason / issue・PR と日時）, result, verdict

## 採った案と棄却した案

- 採用: この計画は手順 1 の測定と判定まで。棄却: 手順 2（trace の finished）と手順 3 まで同じ計画に入れる（採否が出荷の後にしか決まらず epic #200 の Policy に反し、関係ない配信の主な原因が終わった計画かもまだ分からない）
- 採用: 計画かどうかを本文で、終わったかを配信の時点の issue・PR の状態で決める。棄却: キーに plan を含む decision を計画とみなす（計画でない決定が混ざる）
- 採用: unknown の解決次第で結論が変わるなら undecided。棄却: unknown を irrelevant 側に数える（unknown だけでゲートを通る）
- 採用: 分類に other を置き、抽出の後に除かない。棄却: decision・constraint 以外は配信されないとみなす（編集の前・prompt・review は kind を限定しない）
- 採用: 母集団の一覧と sha256 を保存して抜き取りを再現する。棄却: seed だけを固定する（配信のログは消えるので母集団が変わる）

## 手順

- S1: `server/evals/delivery/sample.ts`（母集団の抽出・保存・照合、抜き取り、シートの作成、判定）と、実 SQLite の一時 DB と一時の会話の記録で流すテスト。knip の入口に足す
- S2: 母集団を保存して 80 組を抜き取り、Claude と Codex がラベルと分類を付け、判定して `precision-baseline.json` に書く
- S3: 結果・分類ごとの割合・防げた例・判定を #346 に書く（持ち主に文面を見せてから）

## 完了条件

- A1: `bun run verify` → 通る
- A2: `jq '[.sample[] | select(.claude and .codex and .settled and .class and .class_reason)] | length' server/evals/delivery/precision-baseline.json` → 80。`jq -c '(.result | {F, I, U, R}), .verdict' server/evals/delivery/precision-baseline.json` → 4 つの数と verdict が出る
- A3: `node --test server/test/delivery-sample.test.ts` → 保存した母集団と seed 20261016 で 2 回抜き取ると同じ 80 組が同じ順に出る、保存した一覧と違う母集団では違いを報告して 0 以外で終わる、の両方のテストが通る
- A4: `node --test server/test/delivery-sample.test.ts` → (8,7,1,0) は進む、(10,8,2,0) と (8,0,8,0) は undecided、F < 8 は判定できない、のテストが通る
- A5: `gh issue view 346 --comments` → 結果・分類ごとの割合・防げた例・判定を書いたコメントがある

## リスク

- Codex の会話の記録が読めない・形が違う → S1 で `server/src/codex-log.ts` の読み方を確かめ、読めない組は「記録なし」として残し、件数を結果に書く
- 80 組では割合の幅が広い（Wilson で ±9 ポイント程度）→ 判定は終わった計画の組の中の偏りで行い、全体の割合は参考として報告する
- 窓の Codex のセッションの多くは codex exec のレビュー → event と agent ごとの件数を結果に出す

## 未解決

なし

## 変更履歴

- 2026-10-16 / A2 の jq を `(.result | {F, I, U, R}), .verdict` に直した / 元の式は `.verdict` を `.result` の中で読み null になる（JSON の verdict は最上位にある）/ 完了条件のコマンドの誤りで、範囲は変わらないので Go は不要
