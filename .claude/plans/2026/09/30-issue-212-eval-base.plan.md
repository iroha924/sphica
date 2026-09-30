---
kind: plan
status: approved
codex_session: 01a0f013-6104-7f91-b80b-7d74359852ae
codex_rounds: 3
approved_at: 2026-09-30
---

# #212: 実験を判定する検索ベンチ・評価ループの内訳・テストの基盤を入れる

## 要点

- モデルを呼ばない検索ベンチ（`server/evals/retrieval/`）を足す。正解のある 48 問の recall@1/5/10・MRR と、正解の無い 12 問の誤表示率を、言語の組み合わせ別・語の重なり別に出す。verify は「動かない・件数不足・NaN」でだけ落とし、数字の判定は実験の PR が `--compare <ref>` で旧版と並べて行う
- 受け入れケースに superseded・abstention・poisoned・override の 4 種を足す（製品側の挙動だけ）。エージェントの振る舞いはクラウドのタスクに同じ 4 種を足して採点する
- 評価ループの記録と報告を広げる: gold key ごとの `in_delivery`・`in_search`・`read`、言語の組み合わせと語の重なりの群、タスク×モデルの gold − inject、再提案率、counterfactual gold（元版と反転版の 2 build）、Claude と Codex の 2 人の採点の一致率。発火の計画を分母にする
- テストを足す: fast-check のプロパティテスト、`mask()` の時間の伸び、Node 26 lane の順序ランダム化、Biome の promise の 2 ルール、`z.toJSONSchema()` を評価スキーマの出所に、Skill の JSON 欄と zod の型の突き合わせ。Stryker は依存にせず手で 1 回
- 最後にクラウドの 1 ループ（Claude 約 62 run、$9〜$19）。流す前に持ち主にこの数字で確かめる
- 変えないもの: 出荷する製品のコード（受け入れケースが落ちて見つかった不具合の修正を除く）、schema、MCP ツール。devDependency（fast-check）を足すので、版は 0.6.13 に上げてリリースする（後から持ち主が決定）

## 持ち主の決定

- 1 issue = 1 PR（大きくてよい）。#212 は #204・#205・#206・#213〜#221 の実験の判定に使う
- 各項目は、実験が必要とする測定を出すなら採用、出さないなら理由を書いて不採用
- クラウド評価で、承認済みの 1 ループを超えてクレジットを使う前に持ち主に確かめる
- 開発ルール・制約（依存など）は変えてよい。変える案は持ち主が結果と一緒に決める
- やらない: embedding・ベクトル検索、日本語形態素解析、promptfoo
- fast-check を足すとバージョンの検査がリリースを求めるので、0.6.13 に上げてリリースする（実装中に持ち主が追加）
- 利用者に API キーや追加課金を求める機能は作らない

## 目的

- #204 の検索の変更を、main と変更後で同じコーパスに流して、正解ありの MRR・recall@k と正解なしの誤表示率で比べられる
- 評価ループの報告で、検索の失敗（gold が届かない・出てこない）と利用の失敗（届いたのに従わない）、言語の組み合わせ、語の重なり、再提案率、gold − inject、記録の中身に従ったか（counterfactual）、採点者の一致を分けて読める
- 結果が返らなかった run も、計画したタスク×条件の分母に残る

## 対象外

- trace の抽出を実エージェントで採点する仕組み。正解の unit とセッションのコーパスが別に要り、検索・配信の実験の判定には使わない。trace を変える issue（#215 など）で扱う
- Claude 側をローカルの Agent SDK と API キーで流すこと。API 課金に移り、ルーティン（サブスクリプション）で足りている。inspect-ai もこのタスク数では要らない
- `@openai/codex-sdk` で評価スクリプトのイベント解析を置き換えること。測定を増やさない依存になる
- superseded の旧記録を配信に出すこと（#206 の実験）
- Claude の run ログに tool 呼び出しと結果を結び付ける記録経路を新しく作ること

## 前提

- クラウドのタスクは 4 件（`server/evals/cloud/tasks.json`）。条件は none / search / inject / gold の 4 スロット。quiet のタスクは none と inject の 2 条件
- 集約の `delivered` と `found` は `collect.ts:55-58, 217-252` にある。`found` は search と read を分けず、gold のどれか 1 つを見た集約値
- 採点は Codex だけ（`grade.ts:71-89`）。`grading.ts:tabulate` はモデル×条件のセルだけ
- 受け入れケースは 74 件、retrieval は 12 件（うち 4 件は正解が無い、`cases.json:814` ほか）
- 配信は active の記録だけを選ぶ（`deliver.ts:69-73`）。検索は superseded の旧記録に後継を添えて並べる（`search.ts:122-155`）
- 過去の決定 revive-rejected-option: 持ち主の発言から覆しの承認を自動で判定しない
- Claude のルーティンのログ（`~/.cache/sphica-eval/archive/loop5-structured/logs/*.log`）は tool_use と tool_result の抜き書きで、id が無い。並行の呼び出しでは順番が入れ替わる（実物で確認、2026-09-30）
- Codex の JSONL は `item.completed` の `mcp_tool_call` に引数と結果が 1 つのイベントで入る（`judge.ts:24-59`、`server/test/eval-grade.test.ts:95-115`）
- build.ts は出力先を消して作り直し（`build.ts:285-310`）、collect は今の build の main を祖先に持たないブランチを除く（`collect.ts:187-198`）。`--fired` はスロットの合計しか持たず、ブランチの無い run は task が unknown になる（`collect.ts:155-168, 260-265`）
- Biome 2.5.14 の nursery `noFloatingPromises` / `noMisusedPromises` は、今のコードで当たる箇所 0 件（一時ファイルの `f();` には反応するのを確認）
- Node 26.10 に `--test-randomize` と `--test-random-seed` がある。CI の check は Node 24.15 と 26 のマトリクス（`.github/workflows/check.yml:26-29`）
- fast-check 4.10.2（npm、保守者 ndubien、2026-09-19 更新）。@stryker-mutator/tap-runner 10.0.0。install の前に配布元で来歴を確かめる
- 1 run の費用はおよそ $0.15〜$0.30（eval-loop Skill）

## 方針

1. 検索ベンチ（`server/evals/retrieval/`: `corpus.json`、`run.ts`）
   - コーパス: 記録約 40 件（decision・constraint ほか、日英、alias つき、一部 superseded・retracted）と、質問 60 件（正解あり 48 = 4 言語組み合わせ × 12、正解なし 12）。既存の retrieval 12 件の質問と正解もここに移して含める（受け入れケース側は残す）。各質問に `lang`（`<質問>><記録>`）と、手で付けた `overlap: true|false`
   - 記録は test の helper（`tempDb`、unit・alias の挿入）で 1 つの DB に一度だけ入れ、索引は本物のトリガーで作る。全質問をその DB の search の入口に流す
   - 出力: 正解ありは recall@1/5/10 と MRR、正解なしは 1 件でも返した率。全体・言語の組み合わせ別・overlap 別
   - `--compare <ref>`: その ref の worktree に HEAD のランナーとコーパスを写し、その ref のソースと node_modules で DB を作って流し、両方を並べて出す。ランナーの使う API が無い ref ではその旨で落ちる
   - verify の中のテスト: 動く、質問の件数が 48 と 12 に届く、指標が NaN でない。数字では落とさない。実験の issue が主指標と許容下限を先に書く
2. 受け入れケースの 4 種（製品側だけ。今のコードで落ちたら不具合として直す）
   - superseded: 検索は後継と旧記録を出し、旧記録に superseded の印。配信は後継だけ
   - abstention: 当てはまる記録が無い、または retracted しか無いとき、配信は何も出さない
   - poisoned: 第三者の PR コメントの命令文は adoption を得ず active にならない
   - override: 持ち主が今の依頼で却下案を名指ししたとき、配信は古い決定と理由を 1 回見せる。承認は自動で判定しない
3. クラウドのタスク 4 件を足す（superseded・abstention・poisoned・override）。fixture に必要な記録を足す。条件は override・superseded・poisoned が 4 条件、abstention は none・inject・gold。各タスクに `lang` と `overlap`
4. 評価ループの記録（`collect.ts`、`judge.ts`）
   - gold key ごとに `in_delivery`（inject の delivery_unit）、`in_search`（search の結果に key が出た）、`read`（read の結果が gold の記録を見せた。Codex の read の引数は key でなく `u4` のような番号のため、結果の先頭行で判定する）。Codex は `mcp_tool_call` から取り、今のイベント形の入力例をテストに置く。Claude はログで呼び出しと結果の対応が一意に決まるとき（前の結果が返るまで次の呼び出しが無い）だけ出し、決まらないときは `unknown`。集約の `delivered`・`found` は残す
   - build に ID を持たせる: `build.ts --variant original|swapped` は `~/.cache/sphica-eval/builds/<build-id>/` に出力し、前の build を消さない。`plan.json`（タスク×条件×試行、各行に build-id と variant）をその中に書く。RemoteTrigger で発火するたびに、その行に発火時刻を付ける
   - `collect.ts --build <id>` は、その build の main を祖先に持つブランチだけを取り、計画の行に task・condition・試行で照合する。照合できない行は run 無しとして残す。`--fired` は計画ファイルに置き換える
5. counterfactual gold: 却下案のある 2 タスク（pilot-dates、sphica-search-wording）だけ。反転版は、採った案と却下案を入れ替え、理由も合う文に書き直した架空の記録として fixture に別に持つ。流し方は original の build → 発火 → collect、次に swapped の build → 発火 → collect。hidden test は反転版では使わない
6. 採点と報告（`grade.ts`、`grade.schema.json`、新規 `report.ts`）
   - `grade.schema.json` に `proposes_rejected`（答えか patch が記録の却下案を提案・実装したか）と、counterfactual の run だけの `followed: presented | other | neither`（採点者には提示された記録の本文を渡し、元版か反転版かは渡さない）を足す
   - Codex と Claude（`claude -p`、持ち主のサブスクリプション）が同じ全 run を同じ blindPrompt と schema で採点する。報告の値は Codex 採点のまま、実行モデル別の一致率と、一致しない run の一覧を出す。第二採点者は上書きしない
   - `report.ts` は複数の build の結果を読み、モデル×条件に加えて、言語の組み合わせ別、overlap 別、gold の有無別、タスク×モデルの gold − inject（各 run の値、n、除外・未採点を並べ、2 run の差は「予備」と書く）、条件ごとの再提案率、元版と反転版の並び、採点者の一致を出す
7. テスト
   - fast-check（devDependency、seed 固定）: `ftsQuery()` を任意の Unicode で実 FTS5 の match に通して例外にならない、`head()`/`tail()` のバイト上限、`quoteSpan()`、`leaves()`、`parseDiff()`
   - `mask()` の時間: 悪意ある形の入力で長さ n・2n・4n（n はウォームアップ後に 1 回 5ms 以上）を各 5 回、中央値の隣り合う比（2n/n と 4n/2n）がどちらも 3.0 以下。CI で 10 回流してばらつきを見てから閾値を確定し、tasks の結果に残す
   - Node 26 の CI lane に `--test-randomize` と、run 番号から作る `--test-random-seed`（ログに出す）。順序依存のテストが出たら直す
   - Biome の `noFloatingPromises` / `noMisusedPromises` を error で有効にする
   - `answer.schema.json` と `grade.schema.json` を zod から `z.toJSONSchema()` で作り、JSON ファイルとの一致と、Codex の `--output-schema` の strict 条件（全 object に `additionalProperties: false`、全プロパティ required）を同じテストで見る
   - check-pairs: trace・glean の Skill の JSON 欄の表と `record.ts`・`glean.ts` の zod の型を突き合わせる
   - Stryker: 依存にせず、手で 1 回 `text.ts`・`anchors.ts`・`search.ts` に流す。生き残った変異のうち意味のあるものをテストで殺す。実行した版・コマンド・対象・除外した変異の理由は PR 本文に書く（issue へのコメントは持ち主に文面を見せてから）
8. クラウドの 1 ループ: 流す前に持ち主に見積もり（Claude 約 62 run = 既存 3 タスク×4 + quiet 2 + 新 4 タスク×4 − abstention の search 1、各 2 run、に counterfactual 2 タスク × 2 run、$9〜$19。Codex と採点はサブスクリプション）で確かめる。ループの結果で #212 の完了条件を確かめ、eval-loop Skill の手順を新しい流し方（build ID、plan.json、report.ts）に書き換える

## 採った案と棄却した案

- 採用: ベンチは verify で「動かない・件数不足・NaN」だけ落とし、数字は実験の PR が旧版と並べて判定。棄却: 全指標を基準値以上に固定（#204 の妥当なトレードオフも拒む）
- 採用: ベンチ専用のコーパスを 1 つの DB に。棄却: 受け入れケースの given を使う（ケースごとに DB が違い、順位を比べられない）
- 採用: 正解なしの質問の誤表示率を別に出す。棄却: recall と MRR だけ（誤表示を測れない）
- 採用: `--compare` は旧版の worktree でその版の `terms()` と索引で DB を作る。棄却: 同じ DB を両版の検索で読む（tokenizer の比較が誤る）
- 採用: 受け入れケースは製品側、エージェントの振る舞いはクラウドで採点。棄却: 4 種をすべて既存挙動の固定とみなす
- 採用: 語の重なりは手でラベルを付けて固定。棄却: `terms()` で毎回計算（#204 で群が動く）
- 採用: gold − inject はタスク×モデルの中で各 run と n を並べる。棄却: モデル×条件の平均差だけ（揺れとタスク構成の違いを効果と取り違える）
- 採用: counterfactual は整合した反転版の記録と、別 ID の build と、`followed` の盲検採点。棄却: gold スロットに variant を渡すだけ（実行と採点がつながらない）
- 採用: 2 人の採点者が全 run を採点して一致率を出す。棄却: Claude が Codex の run だけを採点（自己選好と基準の違いを切り分けられない）
- 採用: 発火の計画ファイルを分母に。棄却: スロット合計の `--fired`（ブランチの無い run が task unknown になる）
- 採用: `mask()` は隣り合う長さの時間比。棄却: fast-check で線形時間を見る（任意入力では確かめられない）
- 採用: Claude のログは対応が一意なときだけ信号を出す。棄却: 新しい記録経路を作る（範囲外）
- 採用: Stryker は手で 1 回。棄却: 常設の依存にして verify で流す（重く、測定を増やさない）

## 手順

- S1: 検索ベンチ（コーパス、ランナー、`--compare`、verify のテスト）
- S2: 受け入れケースの 4 種（落ちたら不具合を直す）
- S3: クラウドのタスク 4 件と fixture の記録
- S4: gold key ごとの信号（Codex と Claude）
- S5: build ID、plan.json、`collect.ts --build`
- S6: counterfactual の反転版の記録と `--variant`
- S7: `grade.schema.json` の欄、2 人の採点、`report.ts`
- S8: fast-check と `mask()` の時間のテスト
- S9: Node 26 の順序ランダム化、Biome の 2 ルール
- S10: zod を出所にした評価スキーマ、Skill の欄と zod の突き合わせ
- S11: Stryker を手で 1 回
- S12: クラウドの 1 ループ（持ち主の確認の後）と eval-loop Skill の書き換え

## 完了条件

- A1: `bun run verify` → exit 0
- A2: `cd server && node evals/retrieval/run.ts` → 正解あり 48・正解なし 12 の件数と、recall@1/5/10・MRR・誤表示率を全体・言語の組み合わせ別・overlap 別に出す
- A3: `cd server && node evals/retrieval/run.ts --compare main` → main と作業ツリーの 2 列で同じ指標を出す
- A4: `cd server && node --test --test-timeout=60000 test/*.test.ts` → ベンチのテストが件数不足や例外で落ちることを、コーパスを一時的に削って確かめる（戻す）
- A5: `bun run acceptance` → 4 種のケースを含めて通る
- A6: `cd server && node evals/cloud/report.ts` → クラウドの 1 ループの出力に、gold key ごとの 3 信号、言語の組み合わせ別・overlap 別・gold の有無別、タスク×モデルの gold − inject、再提案率、元版と反転版の `followed`、採点者の一致率が出る。計画の全行が run か run 無しとして出る
- A7: `gh run view <PR の check の run> --log | grep -i random` → Node 26 の check がランダムな順序の seed をログに出し、job が success
- A8: `gh pr view <PR> --json body -q .body` → #212 の各項目が、採用か不採用（理由つき）で本文にある

## リスク

- ベンチのコーパスを書く人が正解を知っているため、質問が記録の言い回しに寄る → overlap のラベルで群を分け、false の質問を半数にする
- Claude のログで対応の決まらない run が多い → `unknown` のまま数え、割合を報告に出す。多ければ記録経路を別の issue にする
- counterfactual で、反転版の記録が不自然でモデルに疑われる → 反転版も元版と同じ source の形で書き、疑った run を別に数える
- `mask()` の時間のテストが CI で揺れる → 閾値は CI での 10 回の実測で決める
- クラウドのループが見積もりを超える → 見積もりを超える前に止めて持ち主に聞く
- 順序のランダム化で順序依存のテストが多数出る → 直す。直すのが大きければ記録して持ち主に聞く

## 未解決

なし

## 変更履歴
- 2026-09-30 / counterfactual のタスクを pilot-dates と superseded-install に変えた / sphica-search-wording の fixture は実際の PR の harvest で、反転版に架空の出典が要る。superseded-install は status-02 を外すだけで反転する / Go 不要（件数と費用は同じ）
- 2026-09-30 / 0.6.13 に上げてリリースする / release-scope が devDependency の追加もパッケージの入力とみなすため。持ち主が 3 案（自前の生成器、リリース、検査を直す）からリリースを選んだ / Go 済み（持ち主が決定）
- 2026-09-30 / 方針 4 の `read` を「引数に key」から「結果が記録を見せた」に直した / Codex の read の引数は番号で key を持たない（T05 の記録） / Go 不要（実装に合わせた文面の訂正）
