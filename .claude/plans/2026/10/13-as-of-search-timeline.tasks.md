---
kind: tasks
plan: 13-as-of-search-timeline.plan.md
branch: feat/as-of-search-timeline
base: main
---

# search に as_of を、read に timeline を足す（issue #217）のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: search の as_of

時刻を渡すと、その時点で保存されていた記録を、その時点の状態で検索できる。

- [x] T01: `searchUnits` に asOf を通し、バージョンを 0.6.55 に上げる
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `server/src/search.ts`, `server/test/search.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run test` → 終了コード 0。足したテスト（置き換えの前後、anchor の引退の前後、後から保存された記録、その時点の alias、権威の変化、cutoff と等しい時刻、足した候補の上限、今より後の as_of は as_of 無しと同じ）は、実装の前に流して落ちることを確かめてある
  - コミット: `feat(search): search records as Sphica held them at a past time`
  - 結果: red: `node --import ./test/isolate-home.ts --test --test-name-pattern="search as of a past time" test/search.test.ts` → `server/src/search.ts` を HEAD に戻すと、最初に足した 3 件が 3 件とも落ちた（時刻を渡しても今の状態の記録が返る、後から保存された記録が当たる、索引の外の記録が 0 件）。実装を戻すと通った
  - 結果: `bun run test` → 終了コード 0（1265 件 pass、`search.ts` の行の網羅 100%）。`bun run check` → 終了コード 0。`bun run sql:reach` → 247 / 247
  - 結果: `bun run release:plan -- --base b38325c6` → `plugin`、4 か所とも 0.6.55。`npm view sphica@0.6.55 version` → 404
  - 結果: `python3 <scratchpad>/mutate.py` → `review-shipping` が「テストが実装を見分けていない」と挙げた 10 個の書き換え（その時点の置き換え先、後から足された anchor、3 つの上限、「後から保存」の境目）を、テストを 2 件足した後にそれぞれ当てて流すと 10 個とも落ちた。`review-shipping` に止める指摘は無い
- [x] T02: MCP の `search` に `as_of` を足す（入力の検証、返信の注記、description、受け入れケース）
  - 種別: 追加
  - 計画: S1, S3
  - 依存: T01（`searchUnits` の asOf が無いと、引数を渡す先が無い）
  - 変更: `server/src/mcp.ts`, `server/src/search.ts`, `server/test/plugin.test.ts`, `server/test/search.test.ts`, `server/test/acceptance-cases.test.ts`, `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`
  - 完了条件: `bun run test && bun run acceptance` → どちらも終了コード 0。受け入れケース（as-of の検索）と入力のテスト（日付だけ、オフセット無し、年の端、`sources`・`asked` との組み合わせ）は、実装の前に流して落ちることを確かめてある
  - コミット: `feat(mcp): take as_of in search and say what the snapshot covers`
  - 結果: red: `SPHICA_ACCEPTANCE_LAYER=retrieval node --test evals/acceptance/run.ts` → `server/src/search.ts` を T01 の前（b6d1ee02）に戻すと、足した retrieval-14 だけが落ちた（置き換えられた決定が superseded のまま返る）。戻すと 14 件 pass
  - 結果: red: `node --import ./test/isolate-home.ts --test --test-name-pattern="as_of|as of a past time keeps" test/plugin.test.ts test/search.test.ts` → `mcp.ts` と `search.ts` を HEAD に戻すと 2 件とも落ちた（`as_of` が未知の引数として断られる、返信が frame から始まる）。戻すと通った
  - 結果: `bun run test` → 終了コード 0（1267 件 pass）。`bun run verify` → 終了コード 0（静的検査、bundle、`sql:reach` 247 / 247、`sql:live`、hook と Codex の信頼の検査、受け入れ 139 件 pass）
  - 結果: `node --import ./test/isolate-home.ts --test --test-name-pattern="search takes as_of" test/plugin.test.ts` → `review-shipping` の指摘（0 件のときの文が、as_of と一緒に使えない sources の検索を勧める）を直した後に pass。`review-shipping` に止める指摘は無く、v0.6.54 の bundle と比べて as_of 無しの返信 40,826 組に差が無いと報告した（こちらでは流し直していない）

- [ ] T09: 後から保存された記録を保存の古い順に取り、索引の外の候補の上限のテストを見分けられる形にする
  - 種別: 修正
  - 計画: S1
  - 依存: T01（直す対象の `searchAsOf` が要る）
  - 変更: `server/src/search.ts`, `server/test/search.test.ts`
  - red: `node --import ./test/isolate-home.ts --test --test-name-pattern="search as of a past time" test/search.test.ts` → 後から保存された一致が 201 件を超え、最古の 1 件の順位が低いとき、`later` の先頭が最古の記録でないので落ちる
  - 完了条件: `bun run test` → 終了コード 0。`later` が保存の古い順の先頭 10 件になり、索引の外の候補は 200 件ちょうどで止まることをテストが確かめる（上限を 20 に書き換えると落ちる）
  - コミット: `fix(search): name the records saved later from the oldest, not by rank`

## P2: read の timeline

記録の ref を渡すと、置き換えの連なりと結び付く記録を、時刻順の概要で読める。

- [ ] T03: timeline を組み立てる関数とそのテストを足す
  - 種別: 追加
  - 計画: S2
  - 依存: なし
  - 変更: `server/src/timeline.ts`, `server/test/timeline.test.ts`
  - 完了条件: `bun run test` → 終了コード 0。足したテスト（3 段の連なり、終わった置き換えと複数の期間、提案だけ、時刻不明、同じ run と同じ場所、question が閉じる行、同じ時刻の並び、連なりの上限と境目、予算での省略と必ず残す行、省いた ref の上限、後からの adoption が保存の行に出ない、source の無いイベント）が通る
  - コミット: `feat(read): build a record's timeline from its replacements and related records`
- [ ] T04: MCP の `read` に `timeline` を足す（引数、ref ごとのエラー、description、受け入れケース）
  - 種別: 追加
  - 計画: S2, S3
  - 依存: T03（timeline を組み立てる関数が無いと、引数を渡す先が無い）
  - 変更: `server/src/mcp.ts`, `server/test/plugin.test.ts`, `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`
  - 完了条件: `bun run test && bun run acceptance` → どちらも終了コード 0。受け入れケース（timeline）と入力のテスト（`timeline: false`、`s<id>` と続きの ref、見つからない ref との混在）は、実装の前に流して落ちることを確かめてある
  - コミット: `feat(mcp): take timeline in read`

## P3: 利用者向けの文面

README と plugin の文面が、新しい 2 つの引数を説明する。

- [ ] T05: README と plugin の文面に as_of と timeline を足す
  - 種別: 追加
  - 計画: S3
  - 依存: T02（`as_of` の形と返信の注記が決まっていないと書けない）, T04（`timeline` の返信の形が決まっていないと書けない）
  - 変更: `README.md`, `plugin/README.md`
  - 完了条件: `bun run verify:ai && bun run english` → どちらも終了コード 0。`rg -n "as_of|timeline" README.md plugin/README.md` → 両方のファイルに同じ説明がある
  - コミット: `docs: describe as_of search and the timeline view`

## P4: 評価の道具とタスク

変更の前と後を、採点とツール別の呼び出しの数で比べられる。

- [ ] T06: collect と report に、ツール別の呼び出しの数と as_of・timeline の使用回数を足す
  - 種別: 追加
  - 計画: S4
  - 依存: なし
  - 変更: `server/evals/cloud/collect.ts`, `server/evals/cloud/report.ts`, `server/test/eval-claude.test.ts`, `server/test/eval-grade.test.ts`, `.claude/skills/eval-loop/SKILL.md`
  - 完了条件: `bun run test` → 終了コード 0。Claude と Codex のログの例から、search・read・status の数、`as_of` 付きの search の数、`timeline` 付きの read の数が取れ、呼び出しの単位が取れないログは unknown になるテストが通る。`report.ts --compare` の出力に平均と各実行の値が出るテストが通る
  - コミット: `test(evals): count Sphica calls per tool and the use of as_of and timeline`
- [ ] T07: judge に、timeline で名前が出た記録の signal（`in_timeline`）を足す
  - 種別: 追加
  - 計画: S4
  - 依存: T04（timeline の行の形が決まっていないと、見分ける正規表現が書けない）
  - 変更: `server/evals/cloud/judge.ts`, `server/test/judge.test.ts`
  - 完了条件: `bun run test` → 終了コード 0。timeline の行で名前が出た記録が `in_timeline: yes`、`read: no` になり、全文の read は今までどおり `read: yes` になるテストが通る
  - コミット: `test(evals): tell a record named in a timeline from one read in full`
- [ ] T08: 評価用の 3 段の置き換えの記録とタスクを足す
  - 種別: 追加
  - 計画: S5
  - 依存: なし
  - 変更: `server/evals/acceptance/cases.json`, `server/evals/acceptance/world.json`, `server/evals/cloud/tasks.json`
  - 完了条件: `bun run test && bun run acceptance` → どちらも終了コード 0。`node evals/cloud/build.ts --project tsundoku`（`server/` で）→ fixture が作られ、足した 3 つの決定と、理由を持つ finding・dead end、関係の無い finding が入っている
  - コミット: `test(evals): add a task that asks how a decision changed and why`

## 記録

- 2026-10-13 / T01 / plan の D は「後から足された field の語で当たらないこと」を挙げていたが、schema が field の後からの追加を禁じている（trigger の文面 `field values are written with the unit`） / field には時刻の条件を付けず、記録の保存の時刻だけで判定する。そのテストは書かない
- 2026-10-13 / T01 / 返す型 `AsOfNotes` を export すると knip が「使われていない export」で落とした / T02 で `mcp.ts` が使うまで export しない
- 2026-10-13 / T01 / `review-shipping` の指摘（テストが見分けていない 10 か所） / 採用。T01 の中でテストを足した。その時点の置き換え先を選ぶ `orderBy` は、同じ時点で開いている行が 1 つしか無いので消した
- 2026-10-13 / T02 / 変更欄を変えた。前: `server/src/mcp.ts`, `server/src/search.ts`, `server/test/plugin.test.ts`, `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`。新: それに `server/test/search.test.ts`（返信の予算のテスト）と `server/test/acceptance-cases.test.ts`（retrieval の件数 13 → 14）を足した / 受け入れケースの件数はテストが固定していて、返信の組み立ては `search.ts` にある
- 2026-10-13 / T01 / Codex のコミットのレビュー（dc5a4260）: F1（後から保存された記録を順位で 200 件に絞ってから時刻順に並べるので、最古の記録が落ちる。再現つき）と F2（索引の外の候補の上限のテストが 200 と 20 を見分けない）。どちらも採用 / 修正タスク T09 を足した
- 2026-10-13 / T02 / `review-shipping` の指摘 2 件。0 件のときの文が sources の検索を勧める件は採用して T02 の中で直した。受け入れケースの step の説明が「MCP の search を呼ぶ」なのに driver は `searchUnits` を直接呼ぶ件は、今までの step と同じ作りで、MCP の境界は `plugin.test.ts` が見ているので直さない
