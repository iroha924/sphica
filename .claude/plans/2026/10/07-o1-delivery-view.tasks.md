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

- [ ] T07: overview の受け入れケースに delivery のビューを足す
  - 種別: 追加
  - 計画: S1
  - 依存: T01（ケースが呼ぶ `deliveryOverview` が要る）
  - 変更: `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`, `server/test/acceptance-cases.test.ts`
  - 完了条件: `bun run acceptance` → 新しい delivery のケースを含めて全件 pass
  - コミット: `test(acceptance): cover the delivery view (T07)`

- [ ] T02: 言及の判定（Stop の返信の候補を取り、key の前後の境界を確かめる）
  - 種別: 追加
  - 計画: S2
  - 依存: T01（言及の印を載せる多く配信された記録と例のセッションの行が要る）
  - 変更: `server/src/delivery-view.ts`, `server/test/delivery-view.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/delivery-view.test.ts` → 単独・バッククォート内は言及、前に足した key（`xtrace:s/foo`）・後に足した key（`trace:s/foo-bar`）は言及でない、最初の候補が不正で後の候補が正しいと言及、配信より前の返信・期間の終わり以降の返信・AskUserQuestion の質問は数えない、同じ (記録, セッション) を二重に数えない、が通る
  - コミット: `feat(overview): mark record keys named in a later captured reply (T02)`

- [ ] T03: `overview` の `view: "delivery"` と `days`、引数の誤り、description
  - 種別: 追加
  - 計画: S3
  - 依存: T01（呼び出す `deliveryOverview` が要る）
  - 変更: `server/src/mcp.ts`, `server/test/delivery-view.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 --test-name-pattern=mcp test/delivery-view.test.ts` → `days` の省略・1・90 が通り、0・91・1.5・"7"・live や look と `days`・delivery と `after` が誤りを返す
  - コミット: `feat(mcp): serve the delivery view from overview (T03)`

## P2: 計測と説明

90 日分のログで 1 秒以内に返ることを、bundle した server を新しいプロセスで呼んで確かめ、README に載せる。

- [ ] T04: 規模の計測に delivery のビューのケースを足して流す
  - 種別: 追加
  - 計画: S4
  - 依存: T02（計測する全経路に言及の判定が要る）, T03（bundle した server から呼ぶ view が要る）
  - 変更: `server/evals/scale/run.ts`
  - 完了条件: `bun run bundle && node server/evals/scale/run.ts` → delivery のビューの行が 90 日のログで 5 回の最大 1,000 ms 以内、中身の確認が通り、EXPLAIN QUERY PLAN が出る
  - コミット: `test(evals): time the delivery view on a generated 90-day log (T04)`

- [ ] T05: README の overview の説明に delivery を足す
  - 種別: 追加
  - 計画: S5
  - 依存: なし
  - 変更: `README.md`
  - 完了条件: `rg -n 'view: "delivery"' README.md` → 30 行目付近の overview の説明に 1 件
  - コミット: `docs(readme): describe the delivery view (T05)`

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
