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

- [x] T01: `parseDiff` が削除されるファイルの hunk の行も消費するように直し、テスト 3 種を足し、バージョンを 0.6.54 に上げる
  - 種別: 修正
  - 計画: S1, S2, S3
  - 依存: なし
  - 変更: `server/src/review.ts`, `server/test/review.test.ts`, `server/test/text-properties.test.ts`, `server/test/review-bridge.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/review.test.ts test/text-properties.test.ts test/review-bridge.test.ts` → `server/src/review.ts` が未修正のまま、足した 3 つのテストが落ちる。単体は削除 1 行の後ろの `src/kept.ts` の `added` が空、削除 3 行の後ろの `lines` が `[2]`。property は反例が出る。配信は location-free の記録の key が文面に無い。既存のテストは落ちない
  - 完了条件: `bun run verify` → 終了コード 0。その前に、(1) `server/src` が main と同じ状態で `node server/evals/scale/run.ts` を流して表を結果行に残す、(2) red を確かめてから直し、red と同じコマンドが fail 0、(3) 修正とテストを stage して `bun run release:plan -- --base v0.6.53` が `release kind: plugin`、`npm view sphica versions --json` に 0.6.54 が無いことを確かめてから 4 か所を上げる、(4) 直した後の `node server/evals/scale/run.ts` の表を結果行に残し、記録 1 万件で 1 回 1 秒以内のまま、(5) `review-shipping` に止める指摘が無い
  - コミット: `fix(review): count a deleted file's hunk lines so the next file keeps its added lines`
  - 結果: `node server/evals/scale/run.ts` → 変更の前（コミット bf6c7e44、`server/src` は main と同じ、Apple M4 Pro、node v24.15.0）に流して終了コード 0、全行 problems none。記録 1 万件（uniform）の中央値: prompt 132〜172 ms、read 62 ms、edit 61 ms、名指しの shell 120 ms、review 264〜265 ms、session start 69 ms。表は PR 本文に載せる
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/review.test.ts test/text-properties.test.ts test/review-bridge.test.ts` → 直す前（`server/src/review.ts` は未修正、テストだけ足した状態）は tests 45、pass 42、fail 3。落ちたのは足した 3 つだけ。単体（`a file after deleted ones keeps its added lines and their numbers`）は、削除 1 行の後ろの `src/kept.ts` が `added: []`・`lines: []`、削除 3 行の後ろが `lines: [2]`（期待は `[11]`）。property（`parseDiff reads a file the same after a deleted file of any length and content`）は 1 回目で反例 `[[""],["--- a/x"],1]`、kept が `added: []`。配信（`a file that follows a deleted one in git's diff keeps its added lines`）は `delivered: false` で、`src/old.ts` が `added: []`・`lines: []`（期待は `["export const client = mongoClient;"]`・`[2]`）。issue が「コードから読んだだけ」としていた下流の影響（location-free の記録が当たらない）を、実際の git の出力で確かめた
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/review.test.ts test/text-properties.test.ts test/review-bridge.test.ts` → 直した後は tests 45、pass 45、fail 0
  - 結果: `git add <修正とテスト> && bun run release:plan -- --base v0.6.53` → `release kind: plugin`、inputs は `server/src/review.ts`、immutable releases on、SHA pinning on。`npm view sphica versions --json` の最後は 0.6.53 で、0.6.54 は無い。その後 4 か所を 0.6.54 に上げた
  - 結果: `bun run verify` → 1 回目で終了コード 0（受け入れ 138 件 pass、fail 0）。bundle は capture 390,172 / cli 632,796 / deliver 450,303 / git-worker 12,888 / mcp-record 1,773,021 / mcp 1,680,844 バイトで、上限は変えていない。その後に変えたのは `server/test/review.test.ts` のコメント 1 行だけ
  - 結果: `node server/evals/scale/run.ts` → 直した後（未コミットの `server/src` の変更あり）に流して終了コード 0、全行 problems none。記録 1 万件（uniform）の中央値: prompt 135〜179 ms、read 64 ms、edit 63 ms、名指しの shell 126 ms、review 268〜270 ms、session start 72 ms。1 秒以内のまま。review を通らない行も同じ 2〜6 ms の幅で増えている
  - 結果: `node scripts/check-tarball.mjs <tgz>` → `review-shipping` が `npm pack` した tarball に自分でも流して終了コード 0（53 files、CLI 0.6.54 が起動）。`review-shipping` は止める指摘なし。0.6.53 の配布物と比べて変わったのは `dist/mcp.js`・`dist/deliver.js`・バージョンの 3 ファイルだけで、pack した `deliver.js` と `mcp.js` の `review_select` は、1 行の削除ファイルの後ろの変更で 0.6.53 が「当たる記録なし」、0.6.54 が `no-mongo` を返した（`review-shipping` の報告。自分で流したのは check-tarball と下の typechange の入力）

## 記録

- 2026-10-13 / T01 / 配信のテストは、plan の方針 4 が例に挙げた `src/a-gone.ts` を足さず、テスト用の checkout に元からある 1 行の `src/db.ts` を削除し、その後ろに並ぶ `src/old.ts` に行を足した / 追跡済みで 1 行・パスの順で前、という条件は同じ。`git diff --name-only` の順はテストの中で assert している
- 2026-10-13 / T01 / `review-shipping` の指摘 3 件 / (1) 単体テストのコメントが「2 行以上で行番号がずれる」と読めた（実際は 2 行でも added が消え、ずれるのは 3 行から）→ このテストの入力（1 行と 3 行）の話に直した。(2) 同じパスが削除と新規の 2 つの block で出る typechange（symlink → 通常ファイル）は、直した後 `gone: true` のまま added 行を持つ。逆向き（通常ファイル → symlink）は直す前から同じ形で、未修正と修正後の両方に同じ入力を流して確かめた。#336 の範囲の外なので直さず、PR 本文の Declined findings に書く。(3) この tasks が未チェックで stage されていない → このコミットで入れる
- 2026-10-13 / T01 / file header の無い hunk（git の出力ではない）で、直す前は added 行の `+++ b/decoy.ts` を header と読んで `decoy.ts` を返し、直した後は `[]` を返す（`review-shipping` の比較。自分では流していない）/ hunk の行を header と読まなくなる向きで、対象外にした「行数の合わない diff」とは別。直さない
