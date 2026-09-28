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

- [x] T01: flush() を送信待ちの繰り返しと保留分の 1 度の見直しに作り直す
  - 種別: 修正
  - 計画: S1
  - 依存: なし
  - 変更: `server/src/capture.ts`, `server/test/capture.test.ts`
  - red: `cd server && node --test --test-timeout=60000 --test-name-pattern="#188" test/capture.test.ts` → 700 件で `left: 200`、保留 500 件 + 新しい 1 件で `0 !== 1` の 2 件が落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/capture.test.ts` → 回帰 2 件と、後から登録・期限切れ・締め切り・取り残しの 4 件を含めて全部 pass
  - コミット: `fix(capture): drain the queue until empty or out of time, and keep held records from starving new ones`
  - 結果: red（直す前）`--test-name-pattern="#188"` → 2 件が `left: 200` と `actual: 0` で失敗。直した後 `node --test test/capture.test.ts` → pass 29 / fail 0。直す前の capture.ts に戻すと新しいテスト 4 件が失敗（持ち時間のテストだけは元から 500 件で止まるので通る）。`bun run typecheck`・`bun run lint` → 0、`sql:live` 8 / 8、`sql:reach` 153 / 153

- [x] T02: MCP ツールの中の送信に短い持ち時間を渡す
  - 種別: 変更
  - 計画: S2
  - 依存: T01（`flush()` の持ち時間の引数と `TOOL_FLUSH_BUDGET_MS` が要る）
  - 変更: `server/src/extract.ts`
  - 完了条件: `rg -n "flush\(" server/src/extract.ts` → 3 か所とも `TOOL_FLUSH_BUDGET_MS` を渡している。`bun run typecheck` → 0 で終わる
  - コミット: `fix(extract): give sends inside MCP tools a short time budget`
  - 結果: `rg -n "flush\(" server/src/extract.ts` → 39・86・94 行の 3 か所とも `TOOL_FLUSH_BUDGET_MS` を渡す。`bun run verify`（typecheck と knip を含む）→ 0

- [x] T04: ロックが取れないときに持ち時間まで待ち、送信待ちを最低 1 バッチ送る
  - 種別: 修正
  - 計画: S1
  - 依存: なし
  - 変更: `server/src/capture.ts`, `server/test/capture.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/capture.test.ts` → 新しいテストのうち、保留分と送信待ちが両方ある締め切りのテストと取り残し 2 件が失敗する
  - 完了条件: `cd server && node --test --test-timeout=60000 test/capture.test.ts` → 全部 pass。`bun run verify` → 0
  - コミット: `fix(capture): wait for the lock within the budget and always send a batch of the queue`
  - 結果: red（直す前）`node --test test/capture.test.ts` → 3 件失敗（2 つ目が `busy: true` で即座に返る、保留分があると送信待ち 0 件、取り直しで負けた 1 つ目が 0 件）。直した後 → pass 30 / fail 0。`bun run verify` → 0（sql:reach 153 / 153、sql:live 8 / 8、acceptance pass 59）

- [x] T05: 持ち時間が切れた後にロックを取らず、何も送らなかったときは送信の状態を書かない
  - 種別: 修正
  - 計画: S1
  - 依存: なし
  - 変更: `server/src/capture.ts`, `server/test/capture.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/capture.test.ts` → 持ち時間の途中で空いたロックを取るテストと、空の送信待ちで状態を書くテストが失敗する
  - 完了条件: `cd server && node --test --test-timeout=60000 test/capture.test.ts` → 全部 pass。`bun run verify` → 0
  - コミット: `fix(capture): stop waiting for the lock at the deadline and keep the last send time when nothing was sent`
  - 結果: red（直す前）→ 2 件失敗（持ち時間 50 ms・60 ms 後に空くロックで `sent: 1`、空の送信で flushedAt が .824Z → .830Z に変わる）。直した後 `node --test test/capture.test.ts` を 3 回 → 毎回 pass 32 / fail 0。`bun run verify` → 0（sql:reach 153 / 153、sql:live 8 / 8、acceptance pass 59）

## P2: 出荷

パッケージのバージョンをそろえる。

- [x] T03: release:plan に従って npm と 3 つの plugin manifest のバージョンを上げる
  - 種別: 変更
  - 計画: S3
  - 依存: なし
  - 変更: `plugin/package.json`, `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`
  - 完了条件: `bun run release:plan -- --base 896e9e5` → `plugin`。`bun run verify` → 0 で終わる
  - コミット: `chore(release): bump to 0.6.1`
  - 結果: `bun run release:plan -- --base 896e9e5` → `release kind: plugin`（inputs: server/src/capture.ts）。npm・plugin・marketplace・Codex を 0.6.1 にそろえた。`bun run verify` → 0（sql:reach 153 / 153、sql:live 8 / 8、acceptance pass 59）

## 記録

2026-09-29 / T03 / pre-commit の bundle フックが、パッケージに入るファイルの変更と同じコミットでのバージョン上げを求め、T01 のコミットが止まった / T03 を T01 と同じコミットで終える。依存を「T02（出荷する差分がそろってから判定する）」から「なし」に変えた。`bun run verify` は T02 の後に流す
2026-09-29 / T01, T02 / knip が、T02 で使う前の `TOOL_FLUSH_BUDGET_MS` と外から使わない `FLUSH_BUDGET_MS` の export を未使用として落とした / T02 を T01 と同じコミットで終え、`FLUSH_BUDGET_MS` の export を外した
2026-09-29 / T04 / 43e6cdb の Codex レビュー F1・F2 を採用（持ち主が「両方直す」を選択。plan の変更履歴を参照）。review-shipping は出荷可、古いコメント 1 件を T04 で直す / 修正タスク T04 を足した
2026-09-29 / T05 / Codex のレビュー（6e19681 と main..HEAD）で、ロック待ちが持ち時間を越えてからロックを取る件と、空の送信待ちでも doctor の「last sent」を書き換える後退が見つかった。2 件とも採用 / 修正タスク T05 を足した
