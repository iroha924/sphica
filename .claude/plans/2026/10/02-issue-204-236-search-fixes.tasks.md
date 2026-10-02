---
kind: tasks
plan: 02-issue-204-236-search-fixes.plan.md
branch: fix/issue-204-236-search-fixes
base: main
---

# Fix the reproduced search defects of #204 and reject unknown MCP tool arguments (#236), released as 0.6.19 のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 検索の欠陥

検索が FTS から候補を引き、"does"・複数形の識別子・`./` 付きの path でも該当する記録を見つけ、使えない path はエラーで返す。

- [ ] T01: 検索の候補を FTS から引く（cross join）と、実際の SQL のクエリプランのテストを足し、0.6.19 に揃える
  - 種別: 修正
  - 計画: S1, S7
  - 依存: なし
  - 変更: `server/src/search.ts`, `server/test/search.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - red: `cd server && node --test --test-name-pattern="query plan" test/search.test.ts` → Node 24.15.0 で、順位を取る SQL の最初の段が `SEARCH unit USING ... (project_id=?)` / `SEARCH source ...` で落ちる
  - 完了条件: `cd server && node --test --test-name-pattern="query plan" test/search.test.ts` → pass（kind・lifecycle・path・併用・sources・asked の owner と除外 session 付きで、順位を取る SQL が `SCAN unit_fts` / `SCAN source_fts` から始まる）。合成 DB で今の SQL と比べて桁が悪くならないことを 1 回測り結果行に書く。`bun run release:plan -- --base v0.6.18` → plugin、4 つのファイルが 0.6.19
  - コミット: `fix(search): read candidates from the full-text index first (T01)`

- [ ] T02: 質問の "does" を外し、複数形の識別子を完全一致に数える
  - 種別: 修正
  - 計画: S2, S3
  - 依存: なし
  - 変更: `server/src/text.ts`, `server/src/search.ts`, `server/test/text.test.ts`, `server/test/search.test.ts`
  - red: `cd server && node --test --test-name-pattern="does|plural identifier" test/text.test.ts test/search.test.ts` → `queryTerms("what does sanitize do")` が `["doe","sanitize"]`、"getUsers retry backoff jitter" が symbol `getUsers` の記録を見つけず落ちる
  - 完了条件: `cd server && node --test --test-name-pattern="does|plural identifier" test/text.test.ts test/search.test.ts` → pass（`["sanitize"]`、getUsers が見つかる、path `src/x.ts` だけが一致する "src retry backoff jitter" は weaker のまま）。`node --test test/terms-golden.test.ts` → pass（terms() の出力は変わらない）
  - コミット: `fix(search): drop folded question words and match plural identifiers (T02)`

- [ ] T03: search の path を repoPath() で正規化し、使えない path をエラーにする
  - 種別: 修正
  - 計画: S4
  - 依存: なし
  - 変更: `server/src/search.ts`, `server/src/mcp.ts`, `server/test/search.test.ts`
  - red: `cd server && node --test --test-name-pattern="path" test/search.test.ts` → `./src/x.ts` で何も見つからず、絶対パスと空文字がエラーにならず落ちる
  - 完了条件: `cd server && node --test --test-name-pattern="path" test/search.test.ts` → pass（`./src/x.ts` で `src/x.ts` の記録が見つかる。絶対パス・`..`・空白だけ・空文字が理由入りのエラー。検索語が無い質問でも path を先に確かめる）
  - コミット: `fix(search): normalize the path filter and refuse paths outside the repository (T03)`

## P2: 単語分割の確かめと MCP の引数

doctor が今の Node の分割を配った規則と照合し、両 MCP サーバーが知らない引数をキー名入りのエラーにする。

- [ ] T04: golden を server/src に移し、doctor が今の Node の分割を照合する
  - 種別: 追加
  - 計画: S5
  - 依存: なし
  - 変更: `server/src/terms-golden.json`, `server/test/fixtures/terms-golden.json`, `server/test/terms-golden.test.ts`, `server/src/text.ts`, `server/src/cli.ts`, `server/test/cli.test.ts`, `.agents/skills/knowledge-schema/SKILL.md`
  - 完了条件: `cd server && node --test test/terms-golden.test.ts` → pass（`server/src/terms-golden.json` を読む）。`node --test --test-name-pattern="word splitting" test/cli.test.ts` → pass（一致で ok の行、期待値を 1 件変えたデータで warn の行に不一致の件数と ICU のバージョン、reindex の案内なし）。`bun run bundle` の後 `plugin/dist/cli.js` が golden を含む
  - コミット: `feat(doctor): check this Node splits words as the shipped rules do (T04)`

- [ ] T05: 両 MCP サーバーの全ツールで知らない引数を拒む
  - 種別: 修正
  - 計画: S6
  - 依存: なし
  - 変更: `server/src/mcp.ts`, `server/src/mcp-record.ts`, `server/test/plugin.test.ts`
  - red: `cd server && node --test --test-name-pattern="unknown argument" test/plugin.test.ts` → 全ツールで `zz_unknown` が捨てられ、エラーにならず落ちる
  - 完了条件: `cd server && node --test --test-name-pattern="unknown argument" test/plugin.test.ts` → pass（listTools の全ツールが引数表に載り、全ツールが `isError: true` で本文に `zz_unknown` を出す）。`node --test test/plugin.test.ts` → pass
  - コミット: `fix(mcp): reject unknown tool arguments by name (T05)`

## 記録
2026-10-02 / - / 終わった計画 4 組の削除は .claude/plans の中だけの変更で、done の検査（.claude/plans の外の変更を見る）に掛からないのでタスクにしない / plan と tasks を入れる最初のコミットで削除する
