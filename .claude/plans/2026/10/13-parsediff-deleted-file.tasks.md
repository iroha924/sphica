---
kind: tasks
plan: 13-parsediff-deleted-file.plan.md
branch: fix/parsediff-deleted-file
base: main
---

# parseDiff が、削除されたファイルの後ろのファイルの added 行と行番号を失わないようにする（#336） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 削除されたファイルの後ろのファイルも、単独のときと同じ added 行と行番号になる

`parseDiff` が削除ファイルの hunk の行も数えて消費する。0.6.54 として `mcp.js` と `deliver.js` に入る。

- [ ] T01: `parseDiff` が削除されるファイルの hunk の行も消費するように直し、テスト 3 種を足し、バージョンを 0.6.54 に上げる
  - 種別: 修正
  - 計画: S1, S2, S3
  - 依存: なし
  - 変更: `server/src/review.ts`, `server/test/review.test.ts`, `server/test/text-properties.test.ts`, `server/test/review-bridge.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/review.test.ts test/text-properties.test.ts test/review-bridge.test.ts` → `server/src/review.ts` が未修正のまま、足した 3 つのテストが落ちる。単体は削除 1 行の後ろの `src/kept.ts` の `added` が空、削除 3 行の後ろの `lines` が `[2]`。property は反例が出る。配信は location-free の記録の key が文面に無い。既存のテストは落ちない
  - 完了条件: `bun run verify` → 終了コード 0。その前に、(1) `server/src` が main と同じ状態で `node server/evals/scale/run.ts` を流して表を結果行に残す、(2) red を確かめてから直し、red と同じコマンドが fail 0、(3) 修正とテストを stage して `bun run release:plan -- --base v0.6.53` が `release kind: plugin`、`npm view sphica versions --json` に 0.6.54 が無いことを確かめてから 4 か所を上げる、(4) 直した後の `node server/evals/scale/run.ts` の表を結果行に残し、記録 1 万件で 1 回 1 秒以内のまま、(5) `review-shipping` に止める指摘が無い
  - コミット: `fix(review): count a deleted file's hunk lines so the next file keeps its added lines`

## 記録
