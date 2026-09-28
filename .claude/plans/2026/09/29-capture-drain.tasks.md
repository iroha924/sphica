---
kind: tasks
plan: 29-capture-drain.plan.md
branch: fix/capture-drain
base: main
---

# capture の送信を、送信待ちが空になるか持ち時間が尽きるまで続け、保留分が新しい記録を塞がないようにする（W8、#188） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 送信を最後まで続ける

1 回の送信で送信待ちが全部 DB に入り、保留分が新しい記録を塞がなくなる。

- [ ] T01: flush() を送信待ちの繰り返しと保留分の 1 度の見直しに作り直す
  - 種別: 修正
  - 計画: S1
  - 依存: なし
  - 変更: `server/src/capture.ts`, `server/test/capture.test.ts`
  - red: `cd server && node --test --test-timeout=60000 --test-name-pattern="#188" test/capture.test.ts` → 700 件で `left: 200`、保留 500 件 + 新しい 1 件で `0 !== 1` の 2 件が落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/capture.test.ts` → 回帰 2 件と、後から登録・期限切れ・締め切り・取り残しの 4 件を含めて全部 pass
  - コミット: `fix(capture): drain the queue until empty or out of time, and keep held records from starving new ones`

- [ ] T02: MCP ツールの中の送信に短い持ち時間を渡す
  - 種別: 変更
  - 計画: S2
  - 依存: T01（`flush()` の持ち時間の引数と `TOOL_FLUSH_BUDGET_MS` が要る）
  - 変更: `server/src/extract.ts`
  - 完了条件: `rg -n "flush\(" server/src/extract.ts` → 3 か所とも `TOOL_FLUSH_BUDGET_MS` を渡している。`bun run typecheck` → 0 で終わる
  - コミット: `fix(extract): give sends inside MCP tools a short time budget`

## P2: 出荷

パッケージのバージョンをそろえる。

- [ ] T03: release:plan に従って npm と 3 つの plugin manifest のバージョンを上げる
  - 種別: 変更
  - 計画: S3
  - 依存: T02（出荷する差分がそろってから判定する）
  - 変更: `plugin/package.json`, `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`
  - 完了条件: `bun run release:plan -- --base 896e9e5` → `plugin`。`bun run verify` → 0 で終わる
  - コミット: `chore(release): bump to 0.6.1`

## 記録
