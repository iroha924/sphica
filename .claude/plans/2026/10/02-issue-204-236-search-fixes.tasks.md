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

- [x] T01: 検索の候補を FTS から引く（cross join）と、実際の SQL のクエリプランのテストを足し、0.6.19 に揃える
  - 種別: 修正
  - 計画: S1, S7
  - 依存: なし
  - 変更: `server/src/search.ts`, `server/test/search.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - red: `cd server && node --test --test-name-pattern="query plan" test/search.test.ts` → Node 24.15.0 で、順位を取る SQL の最初の段が `SEARCH unit USING ... (project_id=?)` / `SEARCH source ...` で落ちる
  - 完了条件: `cd server && node --test --test-name-pattern="query plan" test/search.test.ts` → pass（kind・lifecycle・path・併用・sources・asked の owner と除外 session 付きで、順位を取る SQL が `SCAN unit_fts` / `SCAN source_fts` から始まる）。合成 DB で今の SQL と比べて桁が悪くならないことを 1 回測り結果行に書く。`bun run release:plan -- --base v0.6.18` → plugin、4 つのファイルが 0.6.19
  - コミット: `fix(search): read candidates from the full-text index first (T01)`
  - 結果: red: Node 24.15.0 で `node --test --test-name-pattern="query plan" test/search.test.ts` → fail（順位を取る SQL が `SEARCH unit USING COVERING INDEX unit_content (project_id=?) | ... | SCAN unit_fts` から始まる）。両サブクエリを `cross join` にした後 → pass（unit 検索 4 条件・source 検索・askedBefore の owner と除外 session 付きで、全部 `SCAN unit_fts` / `SCAN source_fts` から始まる）。`node --test test/search.test.ts test/asked.test.ts` → 21 pass
  - 結果: `node test/zz-bench.tmp.ts` → コミットしない一時スクリプトを変更の前後で 1 回ずつ流した。合成 DB（3 プロジェクト、20 語の語彙で 30 語ずつの source、big 30,000 行・other 30,000 行・small 50 行）で searchSources を測った。big: 「sqlite 検索 設計」48,595 ms → 24 ms、「キャッシュ」12,810 ms → 16 ms。small（他のプロジェクトに一致が多い場合）: 92 ms → 10 ms、27 ms → 7 ms。どちらも悪くならない
  - 結果: `bun run release:plan -- --base v0.6.18` → plugin。npm と 3 つの manifest を 0.6.19 にした

- [x] T02: 質問の "does" を外し、複数形の識別子を完全一致に数える
  - 種別: 修正
  - 計画: S2, S3
  - 依存: なし
  - 変更: `server/src/text.ts`, `server/src/search.ts`, `server/test/text.test.ts`, `server/test/search.test.ts`
  - red: `cd server && node --test --test-name-pattern="does|plural identifier" test/text.test.ts test/search.test.ts` → `queryTerms("what does sanitize do")` が `["doe","sanitize"]`、"getUsers retry backoff jitter" が symbol `getUsers` の記録を見つけず落ちる
  - 完了条件: `cd server && node --test --test-name-pattern="does|plural identifier" test/text.test.ts test/search.test.ts` → pass（`["sanitize"]`、getUsers が見つかる、path `src/x.ts` だけが一致する "src retry backoff jitter" は weaker のまま）。`node --test test/terms-golden.test.ts` → pass（terms() の出力は変わらない）
  - コミット: `fix(search): drop folded question words and match plural identifiers (T02)`
  - 結果: red: `node --test --test-name-pattern="does|plural identifier|question" test/text.test.ts test/search.test.ts` → fail 2 件（`queryTerms("what does sanitize do")` が `["doe","sanitize"]`、検索が sanitize の記録を見つけず `[]`）。QUESTION を terms() で畳んだ集合と比べるようにした後、同じコマンド → fail 1 件（"getUsers retry backoff jitter" が `[]`）で、getUsers の red を分けて確かめた。anchor の path と symbol のまるごとを NFKC・小文字化・singular() で畳んで比べるようにした後 → pass 4
  - 結果: `node --test test/terms-golden.test.ts test/search.test.ts test/text.test.ts test/text-properties.test.ts test/asked.test.ts` → 44 pass（terms() の出力は変わらない）。"src retry backoff jitter" は hit 0・weaker 2（src/users.ts と src/x.ts の記録）

- [x] T03: search の path を repoPath() で正規化し、使えない path をエラーにする
  - 種別: 修正
  - 計画: S4
  - 依存: なし
  - 変更: `server/src/search.ts`, `server/src/mcp.ts`, `server/test/search.test.ts`
  - red: `cd server && node --test --test-name-pattern="path" test/search.test.ts` → `./src/x.ts` で何も見つからず、絶対パスと空文字がエラーにならず落ちる
  - 完了条件: `cd server && node --test --test-name-pattern="path" test/search.test.ts` → pass（`./src/x.ts` で `src/x.ts` の記録が見つかる。絶対パス・`..`・空白だけ・空文字が理由入りのエラー。検索語が無い質問でも path を先に確かめる）
  - コミット: `fix(search): normalize the path filter and refuse paths outside the repository (T03)`
  - 結果: red: `node --test --test-name-pattern="path filter" test/search.test.ts` → fail（`./src/x.ts` で `[]`）。searchUnits が検索語より先に repoPath() で正規化し、null なら `refused` を返し、MCP の search がそれを `isError` で返すようにした後 → pass（`./src/x.ts` で記録が見つかる。`/repo/src/x.ts`・`../src/x.ts`・`src\x.ts`・空文字・空白だけが refused、検索語の無い "the" でも絶対パスが refused）
  - 結果: `node --test test/search.test.ts test/asked.test.ts` → 23 pass。`bun run check` → exit 0（PATH_REFUSED の export を knip が未使用と指摘したので外した）

## P2: 単語分割の確かめと MCP の引数

doctor が今の Node の分割を配った規則と照合し、両 MCP サーバーが知らない引数をキー名入りのエラーにする。

- [x] T04: golden を server/src に移し、doctor が今の Node の分割を照合する
  - 種別: 追加
  - 計画: S5
  - 依存: なし
  - 変更: `server/src/terms-golden.json`, `server/test/fixtures/terms-golden.json`, `server/test/terms-golden.test.ts`, `server/src/split-check.ts`, `server/src/cli.ts`, `server/test/cli.test.ts`, `.agents/skills/knowledge-schema/SKILL.md`
  - 完了条件: `cd server && node --test test/terms-golden.test.ts` → pass（`server/src/terms-golden.json` を読む）。`node --test --test-name-pattern="word splitting" test/cli.test.ts` → pass（一致で ok の行、期待値を 1 件変えたデータで warn の行に不一致の件数と ICU のバージョン、reindex の案内なし）。`bun run bundle` の後 `plugin/dist/cli.js` が golden を含む
  - コミット: `feat(doctor): check this Node splits words as the shipped rules do (T04)`
  - 結果: `node --test test/terms-golden.test.ts` → 1 pass（server/src/terms-golden.json を split-check.ts 経由で読む）。`node --test --test-name-pattern="word splitting" test/cli.test.ts` → 1 pass（子プロセスの doctor が「Word splitting  matches the fixed samples (ICU 78.2)」、期待値を 1 件変えたデータでは warn で「1 of 54 fixed samples split differently with ICU 1.0」、reindex の語なし）
  - 結果: `bun run bundle` → exit 0。golden の文（「ｆｕｌｌｗｉｄｔｈ ＡＢＣ」）は plugin/dist/cli.js にだけ入り、mcp.js・deliver.js には入らない。`bun run check` → exit 0

- [x] T06: asked と path を併せたテストに、空でない path を渡す
  - 種別: 修正
  - 計画: S4
  - 依存: T03（path の `min(1)` を入れたのが T03）
  - 変更: `server/test/plugin.test.ts`
  - red: `cd server && node --test test/plugin.test.ts` → T03 の後で「search with asked leaves out the session…」が fail（`path: ""` が `min(1)` の入力検証に先に当たり、`asked cannot be combined with sources or path.` が返らない）
  - 完了条件: `cd server && node --test test/plugin.test.ts` → 全件 pass
  - コミット: `test(mcp): combine asked with a real path in the refusal test (T06)`
  - 結果: red を上のとおり確かめた（T05 の作業中に `node --test test/plugin.test.ts` → 28 pass / 1 fail）。テストの path を `src/x.ts` にした後 → 28 pass / 0 fail

- [x] T05: 両 MCP サーバーの全ツールで知らない引数を拒む
  - 種別: 修正
  - 計画: S6
  - 依存: なし
  - 変更: `server/src/mcp.ts`, `server/src/mcp-record.ts`, `server/test/plugin.test.ts`
  - red: `cd server && node --test --test-name-pattern="unknown argument" test/plugin.test.ts` → 全ツールで `zz_unknown` が捨てられ、エラーにならず落ちる
  - 完了条件: `cd server && node --test --test-name-pattern="unknown argument" test/plugin.test.ts` → pass（listTools の全ツールが引数表に載り、全ツールが `isError: true` で本文に `zz_unknown` を出す）。`node --test test/plugin.test.ts` → pass
  - コミット: `fix(mcp): reject unknown tool arguments by name (T05)`
  - 結果: red: `node --test --test-name-pattern="unknown argument" test/plugin.test.ts` → fail（最初の `status` が `zz_unknown` を捨てて isError にならない）。両サーバーの 18 個の `inputSchema` を `z.object({...}).strict()` で包んだ後 → pass（listTools の全 18 ツールが引数表に載り、全部が isError で本文に `zz_unknown` を出す）
  - 結果: `node --test test/plugin.test.ts` → 29 pass（_meta で workspace を渡すテスト、説明が 2,048 文字以内のテストも通る）。`bun run check` → exit 0

- [x] T07: search の sources と path の併用をエラーにする
  - 種別: 修正
  - 計画: S4
  - 依存: T03（使えない path をエラーにする扱いを入れたのが T03）
  - 変更: `server/src/mcp.ts`, `server/test/plugin.test.ts`
  - red: `cd server && node --test --test-name-pattern="asked leaves out" test/plugin.test.ts` → `{ sources: true, path: "src/x.ts" }` が拒まれず source の検索結果を返して fail
  - 完了条件: `cd server && node --test test/plugin.test.ts` → 全件 pass
  - コミット: `fix(mcp): refuse a path filter combined with sources (T07)`
  - 結果: red を上のとおり確かめた。sources の分岐で path があれば `sources cannot be combined with path.` を isError で返すようにした後、`node --test test/plugin.test.ts` → 29 pass。`bun run check` → exit 0

## 記録
2026-10-02 / - / 終わった計画 4 組の削除は .claude/plans の中だけの変更で、done の検査（.claude/plans の外の変更を見る）に掛からないのでタスクにしない / plan と tasks を入れる最初のコミットで削除する
2026-10-02 / T04 / 変更欄の `server/src/text.ts` を `server/src/split-check.ts` に替えた / text.ts はすべてのフックと MCP が読むので、golden（約 14 KB）をそこで import すると全バンドルに入る。照合を別モジュールにして doctor（cli.js）だけに入れた
2026-10-02 / T06 / T03 の `min(1)` で plugin.test.ts の asked と path の併用テスト（`path: ""`）が落ちていた。T03 では search.test.ts と `bun run check` だけを流し、plugin.test.ts を流していなかった / 修正タスク T06 を足し、T05 より前にコミットした
2026-10-02 / T01 / Codex のタスクレビュー（aa6129d3）: 指摘 0 件 / なし
2026-10-02 / T02 / Codex のタスクレビュー（96c93a09）: 指摘 0 件 / なし
2026-10-02 / T03 / Codex のタスクレビュー（9e2c876b）: 2 件。F2（asked と path: "" のテストが min(1) で落ちる）は T06 で直していた。F1（sources: true のとき path を検査せず黙って無視する）は採用し、T07 を足した
