---
kind: tasks
plan: 18-agent-run-delivery.plan.md
branch: feat/agent-run-delivery-353
base: main
---

# エージェントが起動した実行と、サブエージェント・子スレッドの起動への自動配信を減らす（#353） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 実装の前の計測

固定した #346 標本で、塊ごとに外れるペアの内訳を出し、基準で採否を決める。不採用の塊は P2 で実装しない。

- [ ] T01: 固定標本の代理の内訳を出すスクリプトと結果の JSON を足す
  - 種別: 追加
  - 計画: S5
  - 依存: なし
  - 変更: `server/evals/delivery/agent-runs.ts`, `server/evals/delivery/agent-runs-353.json`, `server/test/agent-runs.test.ts`
  - 完了条件: `node server/evals/delivery/agent-runs.ts --check` → JSON と同じ件数が出て 0 で終わり、塊ごとの useful / irrelevant / unknown と採否が基準どおり。`cd server && node --test test/agent-runs.test.ts` → 分類と基準の境界（useful 1、irrelevant 4 と 5、停止の行を外れる側に数えない）が通る
  - コミット: `feat(eval): count the #346 sample pairs agent-run delivery changes would drop`

## P2: 判定と配信

エージェントが起動した非対話の実行を判定し、その開始と通常の読み取りを止め、サブエージェント・子スレッドの起動を検索の 1 行にする。

- [ ] T02: 親の印の照合を切り出し、エージェントが起動した実行の判定を足す
  - 種別: 追加
  - 計画: S1
  - 依存: T01（実行の抑制の塊が採用されていないと判定を入れる理由が無い）
  - 変更: `server/src/capture.ts`, `server/src/deliver.ts`, `server/test/capture.test.ts`, `server/test/deliver.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `cd server && node --test test/capture.test.ts test/deliver.test.ts` → 親の印なし / 一致 / 不一致、Codex の `codex_exec` / ログ無し / `codex-tui` / 読めないログ / 子スレッド、Claude の `sdk-cli` / `cli` で判定が表どおり。isOwnerTurn の既存のテストがそのまま通る。バージョンが 4 ファイルで同じ
  - コミット: `feat(deliver): tell runs another agent started from the owner's sessions`

- [ ] T03: エージェントが起動した実行の開始を suppressed の行にし、通常の読み取り配信を止める
  - 種別: 変更
  - 計画: S2
  - 依存: T02（判定の関数が要る）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`, `scripts/lib/sql-call-sites.mjs`
  - 完了条件: `cd server && node --test test/deliver.test.ts` → 判定を満たす実行で、開始は出力無し・unit 無し・outcome suppressed・reason は開始の種類、Read とシェルの名指しは出力も行も無し、シェルの停止とその context・編集の前・review は今どおり、停止 → compact → 同じコマンドで止まり直す、suppressed の行が sample.ts の抽出に入らない
  - コミット: `feat(deliver): hold back session start and read delivery for agent-started runs`

- [ ] T04: サブエージェントと Codex の子スレッドの起動を検索の 1 行だけにする
  - 種別: 変更
  - 計画: S3
  - 依存: T01（起動の縮小の塊が採用されていないと変える理由が無い）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - 完了条件: `cd server && node --test test/deliver.test.ts` → SubagentStart とログで確かめた Codex の子スレッドの開始が SEARCH_FIRST だけで unit 無し、reason と agent_id は今どおり、サブエージェントの読みの数え方は起動で戻らない、対話の本体の開始は今どおり
  - コミット: `feat(deliver): start subagents and child threads with the search line only`

- [ ] T05: delivery-view の suppressed の扱いと README の配信の節を直す
  - 種別: 変更
  - 計画: S4
  - 依存: T03（suppressed の行が書かれるようになってから説明する）, T04（README に起動の縮小を書く）
  - 変更: `server/src/delivery-view.ts`, `server/test/delivery-view.test.ts`, `README.md`
  - 完了条件: `cd server && node --test test/delivery-view.test.ts` → suppressed の行が表に出て keyless に入らない。`rg -n "not written today" server/src` → 0 件。`bun run verify` → 0 で終わる
  - コミット: `docs(deliver): describe what agent-started runs and subagent starts receive`

## 記録
