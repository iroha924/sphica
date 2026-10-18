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

- [x] T01: 固定標本の代理の内訳を出すスクリプトと結果の JSON を足す
  - 種別: 追加
  - 計画: S5
  - 依存: なし
  - 変更: `server/evals/delivery/agent-runs.ts`, `server/evals/delivery/agent-runs-353.json`, `server/test/agent-runs.test.ts`, `server/evals/delivery/sample.ts`
  - 完了条件: `node server/evals/delivery/agent-runs.ts --check` → JSON と同じ件数が出て 0 で終わり、塊ごとの useful / irrelevant / unknown と採否が基準どおり。`cd server && node --test test/agent-runs.test.ts` → 分類と基準の境界（useful 1、irrelevant 4 と 5、停止の行を外れる側に数えない）が通る
  - コミット: `feat(eval): count the #346 sample pairs agent-run delivery changes would drop`
  - 結果: `node server/evals/delivery/agent-runs.ts --check server/evals/delivery/agent-runs-353.json` → agent-run {useful 0, irrelevant 17, unknown 22, adopted}、subagent-start {useful 0, irrelevant 5, unknown 2, adopted}、exit 0（手集計と一致）
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/agent-runs.test.ts` → pass 5 / fail 0。`bun run check` → 0 で終わる

## P2: 判定と配信

エージェントが起動した非対話の実行を判定し、その開始と通常の読み取りを止め、サブエージェント・子スレッドの起動を検索の 1 行にする。

- [x] T02: 親の印の照合を切り出し、エージェントが起動した実行の判定を足す
  - 種別: 追加
  - 計画: S1
  - 依存: T01（実行の抑制の塊が採用されていないと判定を入れる理由が無い）
  - 変更: `server/src/capture.ts`, `server/src/deliver.ts`, `server/test/deliver.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `cd server && node --test test/capture.test.ts test/deliver.test.ts` → 親の印なし / 一致 / 不一致、Codex の `codex_exec` / ログ無し / `codex-tui` / 読めないログ / 子スレッド、Claude の `sdk-cli` / `cli` で判定が表どおり。isOwnerTurn の既存のテストがそのまま通る。バージョンが 4 ファイルで同じ
  - コミット: `feat(deliver): tell runs another agent started from the owner's sessions`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/capture.test.ts test/deliver.test.ts` → tests 136 / pass 136 / fail 0（isOwnerTurn の既存のテストは無変更で通る）。`bun run check` → exit 0。4 ファイルの version が 0.6.61

- [x] T03: エージェントが起動した実行の開始を suppressed の行にし、通常の読み取り配信を止める
  - 種別: 変更
  - 計画: S2
  - 依存: T02（判定の関数が要る）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`, `server/test/review-bridge.test.ts`
  - 完了条件: `cd server && node --test test/deliver.test.ts` → 判定を満たす実行で、開始は出力無し・unit 無し・outcome suppressed・reason は開始の種類、Read とシェルの名指しは出力も行も無し、シェルの停止とその context・編集の前・review は今どおり、停止 → compact → 同じコマンドで止まり直す、suppressed の行が sample.ts の抽出に入らない
  - コミット: `feat(deliver): hold back session start and read delivery for agent-started runs`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/deliver.test.ts test/review-bridge.test.ts test/delivery-sample.test.ts test/capture.test.ts test/agent-runs.test.ts` → tests 184 / pass 184 / fail 0（開始は suppressed・unit 0・reason startup / compact、Read とシェルの名指しは出力も行も無し、停止 → compact → 再び停止、編集の前と review は配信、suppressed の行は sample.ts の抽出に入らない）。`bun run check` → exit 0

- [x] T04: サブエージェントと Codex の子スレッドの起動を検索の 1 行だけにする
  - 種別: 変更
  - 計画: S3
  - 依存: T01（起動の縮小の塊が採用されていないと変える理由が無い）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - 完了条件: `cd server && node --test test/deliver.test.ts` → SubagentStart とログで確かめた Codex の子スレッドの開始が SEARCH_FIRST だけで unit 無し、reason と agent_id は今どおり、サブエージェントの読みの数え方は起動で戻らない、対話の本体の開始は今どおり
  - コミット: `feat(deliver): start subagents and child threads with the search line only`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/deliver.test.ts test/review-bridge.test.ts` → tests 85 / pass 85 / fail 0（SubagentStart・agent id の無い SubagentStart・ログで確かめた Codex の子スレッドの開始が検索の 1 行だけ、unit 0・chars 0・reason は subagent / startup、読みは起動で戻らない、本体の開始は記録を出す）。`bun run check` → exit 0

- [x] T05: delivery-view の suppressed の扱いと README の配信の節を直す
  - 種別: 変更
  - 計画: S4
  - 依存: T03（suppressed の行が書かれるようになってから説明する）, T04（README に起動の縮小を書く）
  - 変更: `server/src/delivery-view.ts`, `server/test/delivery-view.test.ts`, `README.md`
  - 完了条件: `cd server && node --test test/delivery-view.test.ts` → suppressed の行が表に出て keyless に入らない。`rg -n "not written today" server/src` → 0 件。`bun run verify` → 0 で終わる
  - コミット: `docs(deliver): describe what agent-started runs and subagent starts receive`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/delivery-view.test.ts` → tests 12 / pass 12 / fail 0（suppressed の行が `| session_start | suppressed | 1 | 0 | 0 | - | 0 |` で出て keyless は `-`）。`rg -n "not written today" server/src` → 0 件。`bun run verify` → exit 0（acceptance 148 / pass 148）

## 記録

- 2026-10-18 / T01 / Codex のログを探す `walk` を sample.ts から使うため export した / 変更欄に `server/evals/delivery/sample.ts` を足した（前: agent-runs.ts, agent-runs-353.json, agent-runs.test.ts）
- 2026-10-18 / T02 / 実装の前に (b) の前提を実測した（codex-cli 0.163.0、使い捨ての CODEX_HOME、入力を控える hook）: 永続の `codex exec` は transcript_path を渡しログの 1 行目は originator `codex_exec`・source `exec`、`--ephemeral` は transcript_path が null、どちらも子のフックに SPHICA_PARENT_SESSION が届き CLAUDE_CODE_ENTRYPOINT `cli` も受け継ぐ / (b) を予定どおり入れる
- 2026-10-18 / T02 / startedByAgent は isOwnerTurn と agentRun のテストで通るので capture.test.ts は変えなかった / 変更欄から `server/test/capture.test.ts` を外した（前: capture.ts, deliver.ts, capture.test.ts, deliver.test.ts, 4 つのバージョンのファイル）
- 2026-10-18 / T02 / Codex のタスクごとのレビュー（77c3d65d、high）: 指摘 0。isOwnerTurn の前後 1,152 通りの一致と agentRun 128 通りを確かめた。テストは sandbox の EPERM で流せず、手元で 136 件通ったことを確かめた / 対応なし
- 2026-10-18 / T03 / 新しい SQL の呼び出し箇所は無く、review の確認を review-bridge.test.ts に足した / 変更欄を直した（前: deliver.ts, deliver.test.ts, scripts/lib/sql-call-sites.mjs → 後: deliver.ts, deliver.test.ts, review-bridge.test.ts）。writer への outcome は Plan の欄 `outcome` で渡した（plan の「引数で受け取る」と同じ働き）
