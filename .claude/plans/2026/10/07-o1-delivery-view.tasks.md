---
kind: tasks
plan: 07-o1-delivery-view.plan.md
branch: feat/o1-delivery-view
base: main
---

# 読み取りの MCP の overview に、配信のログを期間で見せるビュー delivery を足し、持ち主が PR ブランチで試してから採否を決める（#258） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: ビューの本体

期間の配信ログを、件数・多く配信された記録・例のセッション・限界の 1 回の返答にして、32 KiB に収める。

- [x] T01: 件数・多く配信された記録・例のセッション・限界と締めを、バイトで組み立てる `deliveryOverview`
  - 種別: 追加
  - 計画: S1, S6
  - 依存: なし
  - 変更: `server/src/delivery-view.ts`, `server/test/delivery-view.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/delivery-view.test.ts` → 他のプロジェクトと期間外の行が出ない、event × outcome × main / subagent の件数（reason が subagent で id の無い開始を subagent に数える）、no logged record key の数と left out の合計、多く配信された記録の並び、例のセッションの行、全節を長い多バイトの key と path で埋めた返答が framed の後に `READ_BUDGET` 以内で限界と締めの行を含む、が通る
  - コミット: `feat(overview): add a bounded delivery view over the delivery log (T01)`
  - 結果: `cd server && node --test --test-timeout=60000 test/delivery-view.test.ts` → 5 件 pass。全節を埋めた返答は framed の後に 30,595 バイト（上限 32,768）。`bun run verify` → 0 で終わる（sql:reach 込み、acceptance 130 件 pass）

- [x] T07: overview の受け入れケースに delivery のビューを足す
  - 種別: 追加
  - 計画: S1
  - 依存: T01（ケースが呼ぶ `deliveryOverview` が要る）
  - 変更: `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`, `server/test/acceptance-cases.test.ts`
  - 完了条件: `bun run acceptance` → 新しい delivery のケースを含めて全件 pass
  - コミット: `test(acceptance): cover the delivery view (T07)`
  - 結果: `SPHICA_ACCEPTANCE_LAYER=overview bun run acceptance` → driver を直す前は overview-06 が `overview lacks "## Logged delivery rows"` で落ち（delivery を look として呼んでいた）、直した後は overview-01〜06 が pass。`bun run verify` → 0 で終わる

- [x] T08: 限界の節の main / subagent の説明を、id の無い subagent の開始の例外に合わせる
  - 種別: 修正
  - 計画: S1
  - 依存: T01（直す限界の文が要る）
  - 変更: `server/src/delivery-view.ts`, `server/test/delivery-view.test.ts`
  - red: `cd server && node --test --test-timeout=60000 --test-name-pattern="counts the project" test/delivery-view.test.ts` → 限界の行が「subagent, id unknown」の例外に触れていないことで落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/delivery-view.test.ts` → 全件 pass、限界の行が例外を書いている
  - コミット: `fix(overview): state the subagent-start exception in the delivery view's limits (T08)`
  - 結果: red: `cd server && node --test --test-timeout=60000 --test-name-pattern="counts the project" test/delivery-view.test.ts` → 直す前は限界の行が見つからず AssertionError で落ちた。直した後 `cd server && node --test --test-timeout=60000 test/delivery-view.test.ts` → 5 件 pass。`bun run verify` → 0 で終わる

- [x] T02: 言及の判定（Stop の返信の候補を取り、key の前後の境界を確かめる）
  - 種別: 追加
  - 計画: S2
  - 依存: T01（言及の印を載せる多く配信された記録と例のセッションの行が要る）
  - 変更: `server/src/delivery-view.ts`, `server/test/delivery-view.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/delivery-view.test.ts` → 単独・バッククォート内は言及、前に足した key（`xtrace:s/foo`）・後に足した key（`trace:s/foo-bar`）は言及でない、最初の候補が不正で後の候補が正しいと言及、配信より前の返信・期間の終わり以降の返信・AskUserQuestion の質問は数えない、同じ (記録, セッション) を二重に数えない、が通る
  - コミット: `feat(overview): mark record keys named in a later captured reply (T02)`
  - 結果: `cd server && node --test --test-timeout=60000 test/delivery-view.test.ts` → 8 件 pass（単独・バッククォート・文末の句点は言及、`xtrace:s/foo`・`trace:s/foo-bar`・`trace:s/foo.bar` は言及でない、配信より前・質問・期間の後は数えない、同じセッションは 1 回）。`bun run verify` → 0 で終わる

- [x] T03: `overview` の `view: "delivery"` と `days`、引数の誤り、description
  - 種別: 追加
  - 計画: S3
  - 依存: T01（呼び出す `deliveryOverview` が要る）
  - 変更: `server/src/mcp.ts`, `server/test/delivery-view.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 --test-name-pattern=mcp test/delivery-view.test.ts` → `days` の省略・1・90 が通り、0・91・1.5・"7"・live や look と `days`・delivery と `after` が誤りを返す
  - コミット: `feat(mcp): serve the delivery view from overview (T03)`
  - 結果: `cd server && node --test --test-timeout=60000 --test-name-pattern=mcp test/delivery-view.test.ts` → 2 件 pass。0・91・1.5・"7" は `Input validation error: ... at days`、live・look と days は `days: only with view delivery`、delivery と after は `after: not with view delivery, which is one page`。範囲内の days=7 は検証を通る。実 DB と git の origin を持つ一時リポジトリで days 省略・1・90 が枠付きで答える。`bun run verify` → 0 で終わる

- [x] T09: 連続するドットの key を言及と数えない、除外の条件ごとにセッションを分けたテスト
  - 種別: 修正
  - 計画: S2
  - 依存: T02（直す言及の判定が要る）
  - 変更: `server/src/delivery-view.ts`, `server/test/delivery-view.test.ts`
  - red: `cd server && node --test --test-timeout=60000 --test-name-pattern="written whole" test/delivery-view.test.ts` → `namesKey("trace:s/foo..bar", "trace:s/foo")` が true で落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/delivery-view.test.ts` → 全件 pass。配信前の返信だけ・質問だけ・期間の後だけ・長い key だけのセッションがそれぞれ 0 件で印なし
  - コミット: `fix(overview): keep a key with consecutive dots from counting as a shorter key's mention (T09)`
  - 結果: red: `cd server && node --test --test-timeout=60000 --test-name-pattern="written whole" test/delivery-view.test.ts` → 直す前は `true !== false` で落ちた。直した後 `cd server && node --test --test-timeout=60000 test/delivery-view.test.ts` → 10 件 pass。質問の除外・配信の時刻の下限・期間の終わりの上限をそれぞれ外すと、組み直したテストが 1 件落ちることを確かめた（コードは戻した）。`bun run verify` → 0 で終わる

- [x] T10: MCP のテストの子プロセスの HOME と、無い DB の置き場所を一時ディレクトリにする
  - 種別: 変更
  - 計画: S3
  - 依存: T03（直す MCP のテストが要る）
  - 変更: `server/test/delivery-view.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 --test-name-pattern=mcp test/delivery-view.test.ts` → 2 件 pass、`/nonexistent` を渡していない
  - コミット: `test(overview): give the delivery view's MCP server a temporary home (T10)`
  - 結果: `cd server && node --test --test-timeout=60000 --test-name-pattern=mcp test/delivery-view.test.ts` → 2 件 pass。`rg -n nonexistent server/test/delivery-view.test.ts` → 0 件。`bun run verify` → 0 で終わる

## P2: 計測と説明

90 日分のログで 1 秒以内に返ることを、bundle した server を新しいプロセスで呼んで確かめ、README に載せる。

- [x] T04: 規模の計測に delivery のビューのケースを足して流す
  - 種別: 追加
  - 計画: S4
  - 依存: T02（計測する全経路に言及の判定が要る）, T03（bundle した server から呼ぶ view が要る）
  - 変更: `server/evals/scale/run.ts`
  - 完了条件: `bun run bundle && node server/evals/scale/run.ts` → delivery のビューの行が 90 日のログで 5 回の最大 1,000 ms 以内、中身の確認が通り、EXPLAIN QUERY PLAN が出る
  - コミット: `test(evals): time the delivery view on a generated 90-day log (T04)`
  - 結果: `bun run bundle && node server/evals/scale/run.ts` → 0 で終わり、全行の problems が none。delivery のビュー（delivery 20,000 行、返信 5,000 件と言及の返信、90 日、bundle した mcp.js を新しいプロセスで 5 回）は中央値 181 ms・最大 182 ms。EXPLAIN QUERY PLAN は全部 index を使い、全件の SCAN なし（Apple M4 Pro、node v24.15.0、commit 9cf52946 の上の未コミットの run.ts）

- [x] T05: README の overview の説明に delivery を足す
  - 種別: 追加
  - 計画: S5
  - 依存: なし
  - 変更: `README.md`, `README.ja.md`
  - 完了条件: `rg -n 'view: "delivery"' README.md README.ja.md` → それぞれ overview の説明の次に 1 件
  - コミット: `docs(readme): describe the delivery view (T05)`
  - 結果: `rg -n 'view: "delivery"' README.md README.ja.md` → README.md:31 と README.ja.md:30 に 1 件ずつ。`bun run verify` → 0 で終わる（Markdown とリンクの検査を含む）

## P3: 試用と出荷

PR ブランチで持ち主が試し、採用なら同じバージョンに上げて出す。不採用ならこのタスクを取りやめ、PR を閉じる。

- [-] T06: 試用の結果を #258 に残し、採用ならバージョンを上げる
  - 種別: 変更
  - 計画: S6
  - 依存: T04（試用の前に 90 日分のログで時間を確かめる）, T05（merge する差分に README が要る）
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run verify` → 0 で終わり、4 つのファイルのバージョンがそろっている
  - コミット: `chore(release): bump to the next version for the delivery view (T06)`

## 記録

- 2026-10-07 / T01 / reader の接続は sum と group_concat を呼べない（`server/src/sqlite.ts` の READER_FUNCTIONS） / 件数は SQL で値ごとにまとめ、合計は TypeScript で出した
- 2026-10-07 / T01, T06 / pre-commit の bundle の検査が、パッケージの入力を変えるコミットにバージョンの更新を同じコミットで求める（過去のブランチも最初のコミットで上げている） / T01 の変更欄に 4 つのマニフェストを足し（前: delivery-view の 2 ファイル）、計画欄を S1 から S1, S6 にして 0.6.40 に上げた。plan の S6・S7 を直した（plan の変更履歴）。T06 の計画欄は S6, S7 から S6。ブランチで上げても npm には出ない（出すのは tag の release だけ）。T06 は変えるファイルが無くなったので取りやめ、S6・S7 の試用・merge・release は 12 段目で完了条件 A5・A6 として確かめる
- 2026-10-07 / T07 / knowledge-schema Skill が新しい挙動には受け入れケースを先に足すよう求めている / overview の層に delivery のケースを足す T07 を T01 の後に追加
- 2026-10-07 / T01 / Codex のタスクごとのレビュー（dac61df9）: P3 で、限界の節が id の無い行をすべて main と言い切り、reason subagent の開始を subagent, id unknown に数える集計と食い違う（delivery-view.ts で確認、受理） / 修正タスク T08 を足した
- 2026-10-07 / T02 / 文末の句点（`trace:s/foo.`）を key の続きと見ると普通の文の言及を落とす / 右側の「.」は、後に key の文字が続くときだけ続きとみなす（`trace:s/foo.bar` は言及でない）。kysely に glob の演算子が無いので、AskUserQuestion の質問は取り出した external_id に `/:ask:.*:q:/` を当てて除いた
- 2026-10-07 / T08, T02 / Codex のタスクごとのレビュー（db8c0d85, 02e69195）: T08 は指摘なし。T02 は P2 で `trace:s/foo..bar` を `trace:s/foo` の言及と数える（namesKey で再現、受理）、P3 で除外の条件を正しい返信と同じセッションに入れたテストは除外を外しても通る（受理） / 修正タスク T09 を足した
- 2026-10-07 / T03, T09 / Codex のタスクごとのレビュー（ed65305f, 9cf52946）: P3 で、MCP の子プロセスに HOME=/nonexistent を固定で渡すのは .claude/rules/verification.md の temp-home の考え方に沿わない（受理。既存の overview.test.ts・read.test.ts の同じ書き方はこのタスクの範囲外として触らない）。T09 は指摘なし / タスク T10 を足した
- 2026-10-07 / T05 / README.ja.md が README.md の overview の説明を日本語で持っている / T05 の変更欄に README.ja.md を足した（前: `README.md`）。完了条件も両方を見る形に変えた（前: `rg -n 'view: "delivery"' README.md` → 30 行目付近の overview の説明に 1 件）
- 2026-10-07 / T04 / 最初の生成データでは人気の記録を `d % 50` で選び、outcome・記録を付けるか・セッションと相関して、言及を入れた key が上位から外れた（ビューは正しかった） / 選び方を相関しない形にし、言及は配信の 1 分後に同じセッションでその記録の key を書く返信として作った
