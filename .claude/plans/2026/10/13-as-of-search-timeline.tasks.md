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

- [x] T09: 後から保存された記録を保存の古い順に取り、索引の外の候補の上限のテストを見分けられる形にする
  - 種別: 修正
  - 計画: S1
  - 依存: T01（直す対象の `searchAsOf` が要る）
  - 変更: `server/src/search.ts`, `server/test/search.test.ts`
  - red: `node --import ./test/isolate-home.ts --test --test-name-pattern="search as of a past time" test/search.test.ts` → 後から保存された一致が 201 件を超え、最古の 1 件の順位が低いとき、`later` の先頭が最古の記録でないので落ちる
  - 完了条件: `bun run test` → 終了コード 0。`later` が保存の古い順の先頭 10 件になり、索引の外の候補は 200 件ちょうどで止まることをテストが確かめる（上限を 20 に書き換えると落ちる）
  - コミット: `fix(search): name the records saved later from the oldest, not by rank`
  - 結果: red: `node --import ./test/isolate-home.ts --test --test-name-pattern="search as of a past time" test/search.test.ts` → 直す前は上限のテストが落ちた（`later` の先頭が id 1 で、最古の id 2002 でない）。直した後は 5 件 pass
  - 結果: `sed -i '' 's/const EXTRA_MAX = 200;/const EXTRA_MAX = 20;/' src/search.ts` → 上限を 20 に書き換えると上限のテストが落ち、200 に戻すと通る
  - 結果: `bun run test` → 終了コード 0（1267 件 pass）。`bun run check` → 終了コード 0。`bun run sql:reach` → 247 / 247

- [x] T10: 後から保存された記録を候補の上限まで読み、読み切れなかったときと 0 件のときにそう書く
  - 種別: 修正
  - 計画: S1
  - 依存: T09（直す対象の、保存の古い順に読む処理が要る）
  - 変更: `server/src/search.ts`, `server/src/mcp.ts`, `server/test/search.test.ts`, `server/test/plugin.test.ts`
  - red: `node --import ./test/isolate-home.ts --test --test-name-pattern="as of a past time|search takes as_of" test/search.test.ts test/plugin.test.ts` → 古くて弱い一致が 200 件を占めるとき後ろの一致が `later` に出ない、読み切れなかったことが返信に出ない、0 件の返信が As of の行で始まらない、の 4 件が落ちる
  - 完了条件: `bun run test` → 終了コード 0。後から保存された記録は保存の古い順に 2000 件まで読まれ、一致が無いまま打ち切ったときは返信がそう言い、0 件の返信も As of の行で始まる
  - コミット: `fix(search): read later records up to the cap and say when a past view found nothing`
  - 結果: red: `node --import ./test/isolate-home.ts --test --test-name-pattern="as of a past time|search takes as_of" test/search.test.ts test/plugin.test.ts` → 直す前は 4 件落ちた（後ろの一致が出ない、読み切れなかったことが出ない、上限の件数、0 件の返信が As of で始まらない）。直した後は 9 件 pass
  - 結果: `python3 <scratchpad>/mutate-t10.py` → `review-shipping` が「テストが見分けていない」と挙げた書き換え 5 個（打ち切りの行を常に出す、後から保存された記録をその時点で判定する、as_of 無しの 0 件に As of の行を付ける、上限ちょうどの境目、絞り込みを無視する）を、テストを足した後にそれぞれ当てて流すと 5 個とも落ちた
  - 結果: `bun run test` → 終了コード 0（1280 件 pass）。`bun run check` → 終了コード 0。`bun run sql:reach` → 261 / 261

## P2: read の timeline

記録の ref を渡すと、置き換えの連なりと結び付く記録を、時刻順の概要で読める。

- [x] T03: timeline を組み立てる関数とそのテストを足す
  - 種別: 追加
  - 計画: S2
  - 依存: なし
  - 変更: `server/src/timeline.ts`, `server/test/timeline.test.ts`, `server/src/read.ts`
  - 完了条件: `bun run test` → 終了コード 0。足したテスト（3 段の連なり、終わった置き換えと複数の期間、提案だけ、時刻不明、同じ run と同じ場所、question が閉じる行、同じ時刻の並び、連なりの上限と境目、予算での省略と必ず残す行、省いた ref の上限、後からの adoption が保存の行に出ない、source の無いイベント）が通る
  - コミット: `feat(read): build a record's timeline from its replacements and related records`
  - 結果: `node --import ./test/isolate-home.ts --test test/timeline.test.ts` → 7 件 pass（3 段の連なり、終わった置き換え・提案・時刻不明、後からの追加と撤回、連なりと結び付く記録の上限、予算と必ず残す行、改行を含む保存文字列、記録でない ref）
  - 結果: `python3 <scratchpad>/mutate-timeline.py` → `review-shipping` が「テストが見分けていない」と挙げた箇所の書き換え 16 個（同じ時刻の並び 3、有効な置き換えを提案とも出す、同じ場所の規則 3、別プロジェクト、未サポートの記録、必ず残す行、tail を数えない、取りこぼしの後も続ける、key の整形、撤回の時刻、source の上限 2）を、テストを直した後にそれぞれ当てて流すと 16 個とも落ちた
  - 結果: `bun run test` → 終了コード 0（1276 件 pass、`timeline.ts` の行の網羅 98.78%）。`bun run check` → 終了コード 0。`bun run sql:reach` → 261 / 261
- [x] T04: MCP の `read` に `timeline` を足す（引数、ref ごとのエラー、description、受け入れケース）
  - 種別: 追加
  - 計画: S2, S3
  - 依存: T03（timeline を組み立てる関数が無いと、引数を渡す先が無い）
  - 変更: `server/src/mcp.ts`, `server/test/plugin.test.ts`, `server/test/acceptance-cases.test.ts`, `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`
  - 完了条件: `bun run test && bun run acceptance` → どちらも終了コード 0。受け入れケース（timeline）と入力のテスト（`timeline: false`、`s<id>` と続きの ref、見つからない ref との混在）は、実装の前に流して落ちることを確かめてある
  - コミット: `feat(mcp): take timeline in read`
  - 結果: red: `node --import ./test/isolate-home.ts --test --test-name-pattern="read takes timeline" test/plugin.test.ts` → `mcp.ts` を HEAD に戻すと落ちた（`timeline` が未知の引数として断られる）。戻すと通った。受け入れケース retrieval-15 は、driver の step が無い間は流せないので、red は MCP のテストで取った
  - 結果: `bun run test` → 終了コード 0（T03・T04 のツリーで 1274 件 pass）。`bun run verify` → 終了コード 0（`sql:reach` 260 / 260、受け入れ 140 件 pass、`mcp.js` は 1.71 MB で上限内）

- [x] T11: 同じ場所の記録を問い合わせの中で照合し、連なりの run が自分で保存した記録に加えた変化も出す
  - 種別: 修正
  - 計画: S2
  - 依存: T03（直す対象の `timelineRefs` が要る）
  - 変更: `server/src/timeline.ts`, `server/test/timeline.test.ts`
  - red: `node --import ./test/isolate-home.ts --test --test-name-pattern="behind many at the same path" test/timeline.test.ts` → 同じ path の別の symbol の記録が 201 件あると、同じ場所の古い記録が timeline に出ないので落ちる
  - 完了条件: `bun run test` → 終了コード 0。同じ場所の照合が読む件数の上限より前に行われ、連なりの run が自分で保存した記録を閉じた変化が 1 行で出る（保存の時点の candidate・active は出ない）
  - コミット: `fix(read): match a timeline's places in the query and show a run's changes to records it saved`
  - 結果: red: `node --import ./test/isolate-home.ts --test --test-name-pattern="behind many at the same path" test/timeline.test.ts` → 直す前は落ちた（同じ場所の古い記録の行が無い）。直した後は pass
  - 結果: `python3 <scratchpad>/mutate-timeline3.py` → `review-shipping` が「テストが見分けていない」と挙げた書き換えを含む 14 個のうち 13 個が落ちた。残る 1 個（同じ場所の問い合わせの limit を外す）は返信が変わらず、読む行数だけが増える書き換え
  - 結果: `bun run test` → 終了コード 0（1280 件 pass、`timeline.ts` の行の網羅 98.84%）。`bun run check` → 終了コード 0。`bun run sql:reach` → 261 / 261

- [x] T12: 同じ場所の問い合わせを、場所が 200 あっても path の索引から引く
  - 種別: 修正
  - 計画: S2
  - 依存: T11（直す対象の、場所を問い合わせの中で照合する処理が要る）
  - 変更: `server/src/timeline.ts`, `server/test/timeline.test.ts`
  - red: `node --import ./test/isolate-home.ts --test --test-name-pattern="through the path index" test/timeline.test.ts` → 場所が 200 のとき、実行計画が `SEARCH f USING INDEX unit_content (project_id=?)`（project の記録を全部たどる）になり、`unit_anchor_path` を使わないので落ちる
  - 完了条件: `bun run test` → 終了コード 0。場所が 3 のときも 200 のときも、同じ場所の問い合わせの実行計画が `SEARCH a USING INDEX unit_anchor_path` になる
  - コミット: `fix(read): reach a timeline's places by path even with 200 of them`
  - 結果: red: `node --import ./test/isolate-home.ts --test --test-name-pattern="through the path index" test/timeline.test.ts` → 直す前は落ちた（計画が `SEARCH f USING INDEX unit_content (project_id=?) | SEARCH a USING INDEX unit_anchor_live_once`）。cross join で結合の順を固定した後は pass
  - 結果: `bun run test` → 終了コード 0（1280 件 pass）。`bun run check` → 終了コード 0。`bun run sql:reach` → 261 / 261

- [x] T13: timeline の、記録でない ref の行も予算で測る
  - 種別: 修正
  - 計画: S2
  - 依存: T03（直す対象の `timelineRefs` が要る）
  - 変更: `server/src/timeline.ts`, `server/test/timeline.test.ts`
  - red: `node --import ./test/isolate-home.ts --test --test-name-pattern="stays within the budget" test/timeline.test.ts` → 予算いっぱいの timeline の後ろに記録でない ref が 9 件続くと、返信が 32,768 バイトを超えるので落ちる
  - 完了条件: `bun run test` → 終了コード 0。記録でない ref の行も予算で測られ、入らない ref は「もう一度呼ぶ ref」として名指される（どの ref も、行で答えるか名指すかのどちらかになる）
  - コミット: `fix(read): measure a timeline's lines for refs that are not records against the budget`
  - 結果: red: `node --import ./test/isolate-home.ts --test --test-name-pattern="stays within the budget" test/timeline.test.ts` → 直す前は落ちた（2 つ目の ref の長さが 127 のとき返信が 32,770 バイト）。測る処理を戻した後は pass
  - 結果: `bun run test` → 終了コード 0（1280 件 pass）。`bun run check` → 終了コード 0

- [x] T16: timeline の「保存の時点にあったもの」を、時刻ではなく run で見分ける
  - 種別: 修正
  - 計画: S2
  - 依存: T03（直す対象の `timelineRefs` が要る）
  - 変更: `server/src/timeline.ts`, `server/test/timeline.test.ts`
  - red: `node --import ./test/isolate-home.ts --test --test-name-pattern="what was added to a record later" test/timeline.test.ts` → 別の run が保存と同じミリ秒に足した根拠が、保存の行の Evidence に混ざる（`and 3 more`）ので落ちる
  - 完了条件: `bun run test` → 終了コード 0。保存の行の根拠と adoption は記録自身の run が書いたものだけで、別の run が足したものは、同じ時刻でも追加の行に出る
  - コミット: `fix(read): tell what a record was saved with by its run, not by the clock`
  - 結果: red: `node --import ./test/isolate-home.ts --test --test-name-pattern="what was added to a record later" test/timeline.test.ts` → 直す前は落ちた（保存の行が `and 3 more` になり、同じミリ秒に別の run が足した根拠が混ざる）。直した後は pass
  - 結果: `python3 <scratchpad>/mutate-gh.py` → 保存の行・根拠の追加・adoption の追加・anchor の追加を時刻の比較へ戻す書き換え 4 個が、4 個とも落ちた
  - 結果: `bun run test` → 終了コード 0（1281 件 pass）。`bun run check` → 終了コード 0。`bun run sql:reach` → 261 / 261

- [ ] T17: 過去の時点の検索で、決定に「adopted by no one」と言わず、記録に残っていることだけを言う
  - 種別: 修正
  - 計画: S1
  - 依存: T02（直す対象の、過去の時点の検索の返信が要る）
  - 変更: `server/src/search.ts`, `server/test/search.test.ts`
  - red: `node --import ./test/isolate-home.ts --test --test-name-pattern="a past view does not say nobody adopted" test/search.test.ts` → adoption の元の発言を forget した後、その前の時点で検索すると、当時 active だった決定に「adopted by no one」と出るので落ちる
  - 完了条件: `bun run test` → 終了コード 0。過去の時点の検索で、その時点に有効な adoption が記録に無い決定・制約は `no adoption in effect then is on record` と出る（採用されなかったのか、後から forget・撤回されたのかは言わない）。今の検索は今までどおり `adopted by no one`
  - コミット: `fix(search): in a past view, say what is on record instead of that nobody adopted a decision`

## P3: 利用者向けの文面

README と plugin の文面が、新しい 2 つの引数を説明する。

- [x] T05: README と plugin の文面に as_of と timeline を足す
  - 種別: 追加
  - 計画: S3
  - 依存: T02（`as_of` の形と返信の注記が決まっていないと書けない）, T04（`timeline` の返信の形が決まっていないと書けない）
  - 変更: `README.md`, `README.ja.md`
  - 完了条件: `bun run verify:ai && bun run english` → どちらも終了コード 0。`rg -n "as_of|timeline" README.md README.ja.md` → 両方のファイルに同じ説明がある
  - コミット: `docs: describe as_of search and the timeline view`
  - 結果: `bun run verify:ai && bun run english` → どちらも終了コード 0。`rg -c "as_of|timeline" README.md README.ja.md` → 両方に 1 行ずつ（機能の一覧の同じ位置に、同じ内容の項目）

## P4: 評価の道具とタスク

変更の前と後を、採点とツール別の呼び出しの数で比べられる。

- [x] T06: collect と report に、ツール別の呼び出しの数と as_of・timeline の使用回数を足す
  - 種別: 追加
  - 計画: S4
  - 依存: なし
  - 変更: `server/evals/cloud/collect.ts`, `server/evals/cloud/report.ts`, `server/evals/cloud/judge.ts`, `server/test/eval-claude.test.ts`, `server/test/eval-grade.test.ts`, `.claude/skills/eval-loop/SKILL.md`
  - 完了条件: `bun run test` → 終了コード 0。Claude と Codex のログの例から、search・read・status の数、`as_of` 付きの search の数、`timeline` 付きの read の数が取れ、呼び出しの単位が取れないログは unknown になるテストが通る。`report.ts --compare` の出力に平均と各実行の値が出るテストが通る
  - コミット: `test(evals): count Sphica calls per tool and the use of as_of and timeline`
  - 結果: `node --import ./test/isolate-home.ts --test test/eval-claude.test.ts test/eval-grade.test.ts` → 123 件 pass。Claude の stream と Codex のイベントから search・read・status の数、`as_of` 付きの search、`timeline` 付きの read が取れ、途中で切れた・壊れたログは unknown（0 ではない）になる。`report.ts --compare` の各側の行の末尾に、平均・各実行の値・ツール別の平均が出る
  - 結果: `bun run test` → 終了コード 0（1279 件 pass）。`bun run verify` → 終了コード 0（受け入れ 140 件 pass）
- [x] T07: judge に、timeline で名前が出た記録の signal（`in_timeline`）を足す
  - 種別: 追加
  - 計画: S4
  - 依存: T04（timeline の行の形が決まっていないと、見分ける正規表現が書けない）
  - 変更: `server/evals/cloud/judge.ts`, `server/evals/cloud/collect.ts`, `server/evals/cloud/report.ts`, `server/test/eval-claude.test.ts`
  - 完了条件: `bun run test` → 終了コード 0。timeline の行で名前が出た記録が timeline の signal で yes、`read: no` になり、全文の read は今までどおり `read: yes` になるテストが通る
  - コミット: `test(evals): tell a record named in a timeline from one read in full`
  - 結果: `node --import ./test/isolate-home.ts --test --test-name-pattern="named in a timeline" test/eval-claude.test.ts` → pass。timeline で名前が出た記録は `gold_timeline` で yes、`read` は no のまま。長い key の前方一致、全文の read、記録の本文が引用した timeline の行、search の結果は timeline と数えない。証明できないログは unknown
  - 結果: `bun run test` → 終了コード 0（1279 件 pass）
- [x] T08: 評価用の 3 段の置き換えの記録とタスクを足す
  - 種別: 追加
  - 計画: S5
  - 依存: なし
  - 変更: `server/evals/acceptance/cases.json`, `server/evals/acceptance/world.json`, `server/evals/cloud/tasks.json`
  - 完了条件: `bun run test && bun run acceptance` → どちらも終了コード 0。`node evals/cloud/build.ts --project tsundoku`（`server/` で）→ fixture が作られ、足した 3 つの決定と、理由を持つ finding・dead end、関係の無い finding が入っている
  - コミット: `test(evals): add a task that asks how a decision changed and why`
  - 結果: `node evals/cloud/build.ts --project tsundoku` → `built 4 repositories`。fixture に `trace:s-en-sync-1/every5`（superseded）、`trace:s-en-sync-2/every30`（superseded）、`trace:s-en-sync-3/foreground`（active）と、finding 3 件（うち 1 件は関係の無い `german-label`）、dead end 1 件が入った。タスクの prompt で検索すると 3 つの決定が返り、`foreground` の timeline は 3 つの決定・置き換え・同じ run の 4 件を時刻順に 1 回の返信で出した。試しに作ったビルドは消した
  - 結果: `bun run test` → 終了コード 0（1279 件 pass）。`bun run verify` → 終了コード 0（受け入れ 140 件 pass）

- [x] T14: 評価の集計で、分からないものを no や 0 と数えない（終わっていない呼び出し、引用された記録名、引数の無い呼び出し）
  - 種別: 修正
  - 計画: S4
  - 依存: T07（直す対象の、timeline の signal と呼び出しの数え方が要る）
  - 変更: `server/evals/cloud/judge.ts`, `server/test/eval-claude.test.ts`
  - red: `node --import ./test/isolate-home.ts --test --test-name-pattern="Sphica's calls are counted|named in a timeline" test/eval-claude.test.ts` → 引数の無い呼び出しで `timeline_reads` が 0 になる、記録の本文が引用した記録名が timeline で名前が出たと数えられる、終わっていない Codex の read で no になる、の 2 件のテストが落ちる
  - 完了条件: `bun run test` → 終了コード 0。引数がログに無い呼び出しがあるツールの使用回数は unknown、timeline の signal は行の主語・置き換えや衝突の相手・見出しだけで数え、終わっていない Sphica の呼び出しがあるログは no を言わない
  - コミット: `test(evals): never count what a log cannot tell as zero or as no`
  - 結果: red: `node --import ./test/isolate-home.ts --test --test-name-pattern="Sphica's calls are counted|named in a timeline" test/eval-claude.test.ts` → 直す前は 2 件とも落ちた。直した後は pass（Codex の呼び出しと戻りは item の id で突き合わせ、id の無いものは件数で突き合わせる）
  - 結果: `node --import ./test/isolate-home.ts --test test/eval-claude.test.ts test/eval-grade.test.ts` → 123 件 pass。`bun run test` → 終了コード 0（1280 件 pass）。`bun run check` → 終了コード 0
  - 結果: `node <scratchpad>/peek-calls.ts` → 進行中の評価の実行ログ 10 件に当てると、終わった 9 件はツール別の呼び出しの数と `timeline` の使用回数が取れ、実行中の 1 件は unknown になった

- [x] T15: 始まりの無い戻りが、後の終わっていない呼び出しを打ち消さないようにする
  - 種別: 修正
  - 計画: S4
  - 依存: T14（直す対象の、呼び出しと戻りの突き合わせが要る）
  - 変更: `server/evals/cloud/judge.ts`, `server/test/eval-claude.test.ts`
  - red: `node --import ./test/isolate-home.ts --test --test-name-pattern="named in a timeline" test/eval-claude.test.ts` → id の無い戻り（始まりがログに無い）の後に、id の無い終わっていない read があると、timeline の signal が unknown でなく no になるので落ちる
  - 完了条件: `bun run test` → 終了コード 0。その並びで unknown になる
  - コミット: `test(evals): keep an unfinished call unknown after a return whose start is missing`
  - 結果: red: `node --import ./test/isolate-home.ts --test --test-name-pattern="named in a timeline" test/eval-claude.test.ts` → 直す前は落ちた（`no`）。突き合わせの件数を 0 より下げないようにした後は pass
  - 結果: `node --import ./test/isolate-home.ts --test test/eval-claude.test.ts test/eval-grade.test.ts` → 123 件 pass。`bun run check` → 終了コード 0

- [x] T18: 評価の集計で、機能ごとの使用回数を「分かった実行」だけで数え、timeline の signal を timeline を頼んだ read に限る
  - 種別: 修正
  - 計画: S4
  - 依存: T14（直す対象の、引数の無い呼び出しを unknown にする処理が要る）
  - 変更: `server/evals/cloud/judge.ts`, `server/evals/cloud/report.ts`, `server/test/eval-claude.test.ts`, `server/test/eval-grade.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/eval-claude.test.ts test/eval-grade.test.ts` → 比較の表が、引数の無い実行の `timeline reads` を 0・`unknown 0` と出す。記録の本文に timeline の見出しがある全文の read を、timeline で名前が出たと数える（`yes`）
  - 完了条件: `bun run test` → 終了コード 0。比較の表は `as_of searches N (unknown a), timeline reads M (unknown b)` と機能ごとに unknown を出し、timeline の signal は `timeline: true` の read の、先頭が timeline の説明の行で始まる返信だけで yes になる。引数がログに無い read の返信が timeline に見えるときは unknown
  - コミット: `test(evals): count a feature's use only where told, and tie the timeline signal to its call`
  - 結果: red: `node --import ./test/isolate-home.ts --test test/eval-claude.test.ts test/eval-grade.test.ts` → 直す前は、比較のテストが落ち（`timeline reads 0 ... unknown` の数が合わない）、timeline の signal のテストは `judge.ts` を HEAD に戻すと落ちた（`yes`）。直した後は 123 件 pass
  - 結果: `bun run test` → 終了コード 0（1281 件 pass）。`bun run check` → 終了コード 0

## 記録

- 2026-10-13 / T01 / plan の D は「後から足された field の語で当たらないこと」を挙げていたが、schema が field の後からの追加を禁じている（trigger の文面 `field values are written with the unit`） / field には時刻の条件を付けず、記録の保存の時刻だけで判定する。そのテストは書かない
- 2026-10-13 / T01 / 返す型 `AsOfNotes` を export すると knip が「使われていない export」で落とした / T02 で `mcp.ts` が使うまで export しない
- 2026-10-13 / T01 / `review-shipping` の指摘（テストが見分けていない 10 か所） / 採用。T01 の中でテストを足した。その時点の置き換え先を選ぶ `orderBy` は、同じ時点で開いている行が 1 つしか無いので消した
- 2026-10-13 / T02 / 変更欄を変えた。前: `server/src/mcp.ts`, `server/src/search.ts`, `server/test/plugin.test.ts`, `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`。新: それに `server/test/search.test.ts`（返信の予算のテスト）と `server/test/acceptance-cases.test.ts`（retrieval の件数 13 → 14）を足した / 受け入れケースの件数はテストが固定していて、返信の組み立ては `search.ts` にある
- 2026-10-13 / T01 / Codex のコミットのレビュー（dc5a4260）: F1（後から保存された記録を順位で 200 件に絞ってから時刻順に並べるので、最古の記録が落ちる。再現つき）と F2（索引の外の候補の上限のテストが 200 と 20 を見分けない）。どちらも採用 / 修正タスク T09 を足した
- 2026-10-13 / T02 / `review-shipping` の指摘 2 件。0 件のときの文が sources の検索を勧める件は採用して T02 の中で直した。受け入れケースの step の説明が「MCP の search を呼ぶ」なのに driver は `searchUnits` を直接呼ぶ件は、今までの step と同じ作りで、MCP の境界は `plugin.test.ts` が見ているので直さない
- 2026-10-13 / T09 / `review-shipping` は T02 と T09 の書き換え 16 個（`orderBy("f.rank")` へ戻す、`EXTRA_MAX` を 20 と 201 にする、を含む）が全部テストで落ちたと報告した / こちらでは `EXTRA_MAX` を 20 にする 1 個だけ流し直して確かめた
- 2026-10-13 / T03 / 変更欄を変えた。前: `server/src/timeline.ts`, `server/test/timeline.test.ts`。新: それに `server/src/read.ts` を足した / `read` が記録を ref から引く処理（`unitView` の中にあった）を `unitByRef` として出し、timeline と共有した
- 2026-10-13 / T03 / plan は、引退の理由の source が消えているとき `its source is no longer kept` と書くとしていた。理由の行が無い anchor は「記録されなかった」と「forget で消えた」を見分けられない（`read` も `reason not recorded` と出す） / `the words that retired it are not recorded or no longer kept` と書く
- 2026-10-13 / T03, T04 / `review-shipping`: 止める指摘なし。`read` を `timeline` 無し・`timeline: false` で呼んだ返信は、v0.6.54 の bundle と 19 通り比べて差が無いと報告した（こちらでは流し直していない）。指摘 13 件のうち、テストの穴 10 件は採用して T03 の中でテストを直した。長い path が 1 行で予算を使い切り、古い行を全部落とす件（11）は採用し、path と symbol を切るようにした。残した ref を frame の外に JSON で出す件（12）は `read` と同じ作りで、呼び出し側が送った文字列なので直さない。コミット時の hook が作業ツリー全体を見る件（13）は、T03・T04・T10 を合わせたツリーで全テストと静的検査が通ることを確かめてからコミットする
- 2026-10-13 / T04 / 変更欄を変えた。前: `server/src/mcp.ts`, `server/test/plugin.test.ts`, `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`。新: それに `server/test/acceptance-cases.test.ts`（retrieval の件数 14 → 15）を足した / 受け入れケースの件数はテストが固定している
- 2026-10-13 / T02, T09 / Codex のコミットのレビュー（d2437320、e75bff21）: F1（保存の古い順に 200 件だけ読むので、古くて弱い一致が 200 件を占めると後ろの一致が出ず、打ち切ったことも出ない。再現つき）と F2（0 件のとき、時刻の意味を説明する行が返らない）。どちらも採用 / 修正タスク T10 を足した。T09 の直しが F1 を生んだので、「修正が新しい欠陥を生む」の 1 回目に数える
- 2026-10-13 / T06 / 変更欄を変えた。前: `server/evals/cloud/collect.ts`, `server/evals/cloud/report.ts`, `server/test/eval-claude.test.ts`, `server/test/eval-grade.test.ts`, `.claude/skills/eval-loop/SKILL.md`。新: それに `server/evals/cloud/judge.ts` を足した / 呼び出しの数え方は、ログの読み取りがある judge.ts に置き、collect から呼ぶ
- 2026-10-13 / T06 / 予定外の発見: collect の「0 件の検索」は `No record holds most of` という文面に一致させていて、`as_of` の 0 件（`No record as of <時刻> holds most of`）を数え落とす / 一致させる文面を直した
- 2026-10-13 / T07 / 変更欄と完了条件を変えた。変更欄の前: `server/evals/cloud/judge.ts`, `server/test/judge.test.ts`。新: `server/evals/cloud/judge.ts`, `server/evals/cloud/collect.ts`, `server/evals/cloud/report.ts`, `server/test/eval-claude.test.ts`。完了条件の前: 「`in_timeline: yes`」。新: 「timeline の signal で yes」 / `server/test/judge.test.ts` は状態の判定（`src/judge.ts`）のテストで、評価のログの読み取りのテストは `eval-claude.test.ts` にある。signal は既存の `gold_signals` に足さず、行の別の欄 `gold_timeline` にした（`gold_signals` を全体で比べている既存のテスト 16 か所を変えずに済む）
- 2026-10-13 / T03, T04 / Codex のコミットのレビュー（3bb4abac、9a3eb84c。Codex 側の都合で途中で終わり、全観点は見ていない）: F1（同じ場所の記録を path だけで 201 件に絞ってから symbol を照合するので、該当する記録が黙って落ちる）と F2（連なりの run が自分で保存した連なりの外の記録に加えた変化が出ない）。どちらも採用 / 修正タスク T11 を足した
- 2026-10-13 / T08 / 3 つの決定には `why` を持たせず、理由は同じ trace の finding と dead end だけに置いた。anchor は付けていない（既存のタスクが編集するファイルに結び付けると、その配信の数が変わる） / 同じ場所で結び付く記録は、このタスクでは測らない。テスト（`timeline.test.ts`）で確かめてある
- 2026-10-13 / T08 / タスクは `history-sync`（search 条件、3 回）。prompt は日本語、記録は英語
- 2026-10-13 / T11 / `review-shipping`: 止める指摘なし。場所が 200 を超えると残りを黙って捨てる件は採用し、返信の注記に書くようにした（anchor の古い順に 200）。場所が 2 つ以上あると同じ場所の問い合わせが path の索引を使わない件（記録 3 万件で 1 回 250 ms と報告）は採用し、path の条件を先に置いて索引で引くようにした（テストで実行計画を確かめる）。テストが見分けていない書き換えは、テストを 1 本足して塞いだ
- 2026-10-13 / T05 / `review-shipping`: README の「後から保存された記録は別に名前を出す」は、実際は今の検索に当たるものだけを 10 件まで出す / 両方の README をそう直した
- 2026-10-13 / T05 / 変更欄と完了条件を変えた。前: `README.md`, `plugin/README.md`。新: `README.md`, `README.ja.md` / `plugin/README.md` は bundle が作る追跡外の写し（`.gitignore`）で、手で直すファイルではない。日本語の README が別にある。plugin の Skill と reviewers の文面は `rg` で確かめ、`search` と `read` の引数を並べている箇所が無かったので変えていない
- 2026-10-13 / T10 / `review-shipping`: 止める指摘なし。as_of 無しの検索は v0.6.54 の bundle と 168 回比べて差が無く、過去の時点の検索は後から保存された候補が 2000 件あるとき 1 回あたり 110〜160 ms 増える（記録 3 万件で最大 334 ms、ふつうの検索の約 1.5 倍）と報告した（こちらでは測り直していない）。読み取りの MCP に時間の上限は無いので受け入れる。テストが見分けていない書き換え 5 個は採用し、T10 の中でテストを足した
- 2026-10-13 / T11 / Codex のコミットのレビュー（fcfee2a5）: 前回の 2 件は塞がれたと確認。F1（path の条件を先に書いても、場所が 200 あると索引を使わず project の記録をたどる。記録 1 万件で同じ場所の問い合わせだけで約 150 ms。再現つき）を採用 / 修正タスク T12 を足した。返信の中身は正しく、時間だけの問題。T11 で足した実行計画のテストは場所 3 つの段階しか見ていなかった
- 2026-10-13 / T12 / このコミットの前に `review-shipping` は流していない（問い合わせの結合の順を変える 4 行）/ PR の前に、ブランチ全体を `review-shipping` と Codex の全差分のレビューに見せる
- 2026-10-13 / T10, T12 / Codex のコミットのレビュー（1d419fd7、53d3c1b8）: 指摘 0 件。T10 は件数の境目（1999・2000・2001 件）と注記の条件、T12 は場所 1・3・200・記録 1 万件での実行計画を、Codex が実行して確かめた（`bun run test` 全体は Codex 側では未実行）
- 2026-10-13 / 全体 / `review-shipping` のブランチ全体の確認（92ef98b4..53d3c1b8）: 配布物に止める指摘なし。pack した 0.6.55 のファイル一覧は公開済みの 0.6.54 と同じ 53 件で、違うのは `package.json`、2 つの `plugin.json`、`README.md`、`dist/mcp.js` だけ。T12 の cross join は場所 0・1・3・200・201 で inner join と行も順序も同じ、と報告した（こちらでは流し直していない）
- 2026-10-13 / 全体 / 予定外の発見: リポジトリの `server/node_modules/node_modules` に、自分自身を指す symlink が 18:28:42 にできていた（追跡外）。レビュー用のサブエージェントが作業用の写しを作るときに作ったと見ている（推測）。これがあると手元の bundle の `THIRD_PARTY_NOTICES.md` に同じパッケージが重複する（103 → 231。`verify` のログで確認）。`dist/*.js` は変わらない / symlink を消した。A1 の `bun run verify` は評価の実行が終わってから流し直す
- 2026-10-13 / 全体 / Codex の全差分のレビュー（92ef98b4..53d3c1b8、effort high）: 指摘 4 件、どれも Codex が再現済み。(1) timeline で記録でない ref の行を測らずに足すので 32 KiB を超える（T03 の中で、`review-shipping` の「この分岐は通らない」を受けて測る処理を消したのが原因。ref が 1 つなら成り立つが複数だと成り立たない）→ 採用、T13。(2) 終わっていない Codex の read で timeline の signal が no になる、(3) 記録の本文が引用した記録名を timeline で名前が出たと数える、(4) 引数の無い呼び出しで使用回数が 0 になる → 採用、T14
- 2026-10-13 / T13, T14 / Codex の直しの再レビュー（53d3c1b8..5ff7b278）: 4 件のうち 3 件は塞がれたと確認（timeline の予算は 300 通りで最大がちょうど 32,768 バイト）。残り 1 件（id の無い戻りが先にあると、後の終わっていない呼び出しが打ち消される）を採用 / 修正タスク T15 を足した。実際の Codex のログの item には id がある（評価の実行ログで確認）ので、id の無いログだけの話
- 2026-10-13 / 全体 / PR #338 を作成（dc7b9d48）。CI は全項目 pass。GitHub の Codex のレビュー: セキュリティは指摘なし、コードは P2 が 4 件。(1) `report.ts` が、引数の無い実行の機能の使用回数を 0 と数える、(2) `timeline.ts` が、保存の時点のものを時刻で決めるので、別の run が同じミリ秒に足したものが保存の行に混ざる、(3) `judge.ts` が、記録の本文に timeline の見出しがある全文の read を timeline と数える、(4) `search.ts` が、adoption の元の発言を forget した後の過去の時点の検索で、当時 active だった決定に「adopted by no one」と出す / 4 件とも採用。(1)(3) は T18、(2) は T16、(4) は T17。(3) のうち「長い key が切られると見落とす」は直さない（評価の gold の key は短く、200 バイトを超える key はどの返信でも切られる）
- 2026-10-13 / T18 / (1) は T14 の直しの残り（集計側だけ unknown にして、表示側が 0 に戻していた）。評価の集計の「分からないものの扱い」を小分けに直す形が T14・T15・T18 と続いた / 今回は集計から表示まで同じ規則で通した。GitHub の Codex に追加のレビューは頼まず、配布物に入る T16・T17 は `review-shipping` で確かめる
- 2026-10-13 / T17 / 名前・red・完了条件を変えた。前: 「当時 active だったのに adoption が残っていない決定は `adopted then by words forgotten since` と出す」（状態と adoption から forget を推し量る）。新: 上のとおり、推し量らずに記録に残っていることだけを言う / `review-shipping` が、推し量りが外れる場合を 3 つ挙げた（撤回の時刻と状態の時刻が 1 ms ずれる、撤回の理由の発言だけを forget する、revision 5 の移行で降格した記録）うえ、superseded の決定では元の指摘が残ると示した（2 つは再現つき）。記録 `trace:02d1edcd-26b8-4e63-85a8-b10d404cd68d/successor-inference`（状態や採用から推し量る作りは穴が出続けた）と同じ形なので、推し量る案を捨てた
- 2026-10-13 / T16, T17 / `review-shipping`: 止める指摘なし。run で見分ける規則は、保存・glean・harvest・forget・reconcile・移行のどの書き込みでも成り立つと報告した（こちらでは読み直していない）。テストが見分けていない書き換え（同じミリ秒の adoption と anchor）は、テストを足して塞いだ
