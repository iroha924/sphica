---
kind: tasks
plan: 28-confirm-before-override.plan.md
branch: feat/confirm-before-override
base: main
---

# 依頼が記録の退けた変更を求めるとき、実装の前に持ち主へ確かめるよう配信の文言を直し、評価スロットの Go の規則を除いて Claude と Codex を同じ条件で測り直す のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 評価を同じ条件で測れるようにする

旧文言のまま、スロットから Go の節を除き、gold を実配信と同じ表示にし、負例タスクを足す。ここまでのコミットが旧文言の計測の基準になる。

- [x] T01: npm と 3 つの manifest のバージョンを上げる
  - 種別: 変更
  - 計画: S1
  - 依存: なし
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run release:plan -- --base v0.5.2` → 4 か所が同じ新しいバージョン
  - コミット: `chore(release): bump to the next patch version`
  - 結果: `bun run release:plan -- --base v0.5.2` → npm 0.5.3 / plugin 0.5.3 / marketplace 0.5.3 / Codex 0.5.3

- [ ] T02: 記録 1 件の描画を deliver.ts から export し、gold がそれを使う。スロットの Go の節を除き、切り詰めを検査する
  - 種別: 変更
  - 計画: S1
  - 依存: T01（配布物の変更はバージョンを上げた後でないとコミットできない）
  - 変更: `server/src/deliver.ts`, `server/evals/cloud/build.ts`, `server/test/deliver.test.ts`
  - 完了条件: `bun run verify` → exit 0。`node evals/cloud/build.ts --project tsundoku` → 構築でき、スロットの CLAUDE.md と AGENTS.md に "Before implementing" 節が無く、gold.sh の出力に退けた選択肢が入る
  - コミット: `feat(evals): render gold with the delivery renderer and drop the Go gate from slots`

- [ ] T03: 負例タスク pilot-display を足す
  - 種別: 追加
  - 計画: S2
  - 依存: T02（gold の切り詰め検査が新しいタスクにもかかる）
  - 変更: `server/evals/cloud/tasks.json`
  - 完了条件: `node evals/cloud/build.ts --project tsundoku` → pilot-display を含めて構築できる
  - コミット: `feat(evals): add pilot-display, a related record the request does not conflict with`

- [ ] T04: eval-loop Skill に旧・新の計測手順と出荷の条件を書く
  - 種別: 変更
  - 計画: S3
  - 依存: T03（書く手順が pilot-display を含む）
  - 変更: `.claude/skills/eval-loop/SKILL.md`
  - 完了条件: `bun run verify:ai` → exit 0
  - コミット: `docs(eval-loop): measure old and new wording on the same slots and state the ship bar`

## P2: 確かめてから聞くよう文言を直す

配信と MCP の案内に固定文言を入れ、編集の前の「理由を言えば通してよい」を消す。

- [ ] T05: 配信の固定文言 CONFIRM / CONFIRM_GOLD と各 lead への配置、境界と命令形のテスト
  - 種別: 変更
  - 計画: S4
  - 依存: T02（gold が共有の描画関数を使っている）
  - 変更: `server/src/deliver.ts`, `server/evals/cloud/build.ts`, `server/test/deliver.test.ts`, `server/test/deliver-codex.test.ts`
  - 完了条件: `bun run verify` → exit 0（各配信面で長い lead でも記録が 1 件以上残る、命令形の本文でも lead がバイト単位で同じ、を含む）
  - コミット: `feat(deliver): ask the user before making a change a checked record rules out`

- [ ] T06: MCP の案内で「コードとの食い違い」と「依頼が過去の決定を覆す」を分ける
  - 種別: 変更
  - 計画: S5
  - 依存: T05（同じ文言の考え方を使う）
  - 変更: `server/src/mcp.ts`
  - 完了条件: `bun run verify` → exit 0
  - コミット: `feat(mcp): tell agents to confirm with the user before overturning a past decision`

## 記録
