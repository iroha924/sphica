---
kind: tasks
plan: 29-earlier-questions.plan.md
branch: feat/earlier-questions
base: main
---

# 本人の過去の発言から今の問いに似たものを探し、それが何につながったかと、決定の記録が無いまま繰り返されている問いを示す（C1a #192、C4 #197） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 置き換えを最後までたどる

置き換えが 2 段以上でも、検索が今の記録を示す。

- [x] T01: 後継を今の記録までたどる関数を作って searchUnits で使い、バージョンを上げる
  - 種別: 修正
  - 計画: S1, S8
  - 依存: なし
  - 変更: `server/src/search.ts`, `server/test/search.test.ts`, `plugin/package.json`, `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`
  - red: `cd server && node --test --test-timeout=60000 test/search.test.ts` → A → B → C と置き換えた記録で、A の一致から C に届かずに落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/search.test.ts` → 全部 pass。`bun run release:plan -- --base 0543025` → `plugin`、4 か所が同じバージョン
  - コミット: `fix(search): follow replacements to the live record, not one step`
  - 結果: red（直す前）`node --test test/search.test.ts` → pnpm → npm → bun の置き換えで、pnpm の一致から npm（途中）が返り bun に届かずに失敗。直した後 `node --test test/search.test.ts test/plugin.test.ts` → pass 37 / fail 0。`releaseKind` に差分のファイルを渡して `plugin`。4 か所を 0.6.3 にそろえた。typecheck・lint → 0、`sql:reach` 157 / 157

## P2: 過去の発言と、それが何につながったか

`search` の `asked: true` で、本人の過去の発言とつながった記録、決定の有無、繰り返しが分かる。

- [x] T02: 本人の発言だけを上限まで読んで一致させる形を足す
  - 種別: 追加
  - 計画: S2
  - 依存: なし
  - 変更: `server/src/search.ts`, `server/test/search.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/search.test.ts` → 全部 pass（本人の発言だけ、今のセッションを除く、条件が上限の前、`limit` で止めない）
  - コミット: `feat(search): match earlier owner messages across the whole scan`
  - 結果: `node --test test/search.test.ts` → pass 11 / fail 0（今のセッションの一致 601 件が上限を食わずに、別のセッションの本人の発言 3 件を全部返す。AI の返事と PR の本文は返らない。当たりにセッションとターンが付く）。typecheck・lint → 0

- [x] T03: 一致した発言ごとのつながった記録・同じターンの文脈・決定の有無と、繰り返しの行を組み立てる
  - 種別: 追加
  - 計画: S3, S4
  - 依存: T01（後継をたどる関数が要る）, T02（一致した発言の一覧が要る）
  - 変更: `server/src/asked.ts`, `server/test/asked.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/asked.test.ts` → 全部 pass（plan のテストの節の asked の項目）
  - コミット: `feat(search): show what earlier owner messages led to and repeats with no recorded decision`
  - 結果: `node --test test/asked.test.ts` → pass 2 / fail 0（2 回置き換えた決定は後継 bun まで示す、trace 済みで記録なし・未 trace・finding だけを「No recorded decision」、同じターンの AI の返事を引用した記録は文脈に分けて返事を id で示す、絞り込みで隠しても「No recorded decision」と言わず件数を言う、表示 1 件でも 2 セッションの繰り返しを trace 済み・未 trace に分けて示す、決定のあるセッションが入ると繰り返しの行は出ない、今のセッションを除く）。typecheck・lint・knip → 0、`sql:reach` 161 / 161、architecture・english → 通過

- [x] T04: MCP の search に asked を足す
  - 種別: 追加
  - 計画: S5
  - 依存: T03（文の中身が要る）
  - 変更: `server/src/mcp.ts`, `server/test/plugin.test.ts`, `README.md`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/plugin.test.ts` → 全部 pass（`asked` の文、`sources` や `path` との組み合わせを断る）
  - コミット: `feat(mcp): search earlier owner messages with asked`
  - 結果: `node --test test/plugin.test.ts` → pass 28 / fail 0（本物の MCP クライアントで、別のセッションの本人の発言に「No recorded decision. Not traced yet: run /sphica:trace old.」が付き、`CLAUDE_CODE_SESSION_ID` のセッションの発言は返らない。`sources` と一緒なら断る）。typecheck → 0、architecture → 通過。README の機能の一覧に 1 行足した

- [x] T07: レビューの指摘を直す（本文での偽装、隠した記録の再表示、一部だけ trace 済みのセッション、表示しない分の後継、Codex のセッションの除外、空の path、テストの空振り）
  - 種別: 修正
  - 計画: S3, S4, S5
  - 依存: なし
  - 変更: `server/src/asked.ts`, `server/src/mcp.ts`, `server/test/asked.test.ts`, `server/test/plugin.test.ts`, `server/test/search.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/asked.test.ts test/plugin.test.ts` → 改行を含む本文が偽の見出しを作る、隠した decision が文脈に出る、一部だけ trace 済みのセッションが traced に入る、Codex の今のセッションが返る、`path: ""` が断られない、で落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/asked.test.ts test/plugin.test.ts test/search.test.ts` → 全部 pass。`bun run verify` → 0
  - コミット: `fix(search): keep asked output one message per heading, hidden records hidden, and every session tellable`
  - 結果: red（直す前）`node --test test/asked.test.ts test/plugin.test.ts` → 「a message's text cannot start a heading」「this session's own words are left out」で失敗。1 つずつ直し、その都度次の確かめ（「a record the filters hid does not come back as context」「H still has a message no trace looked at」）が意図どおり落ちることを確かめた。直した後 `node --test test/asked.test.ts test/plugin.test.ts test/search.test.ts` → pass 42 / fail 0。`bun run verify` → 0（`sql:reach` 161 / 161、acceptance 62 / 62）。評価を流し直して 0 / 8、13 / 21 で変わらず

- [x] T08: 同じターンの文脈にも kinds と lifecycles をかけ、空振りのテスト 2 件を直す
  - 種別: 修正
  - 計画: S3
  - 依存: なし
  - 変更: `server/src/asked.ts`, `server/test/asked.test.ts`, `server/test/plugin.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/asked.test.ts` → kinds: ["decision"] で、返事だけを引用した finding が文脈に出て落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/asked.test.ts test/plugin.test.ts` → 全部 pass
  - コミット: `fix(search): apply the kind and lifecycle filters to same-turn context too`
  - 結果: red（直す前）`node --test test/asked.test.ts` → kinds: ["decision"] で返事だけを引用した finding が文脈に出て「the finding quoting the reply is not a decision」で失敗。直した後 `node --test test/asked.test.ts test/plugin.test.ts` → pass 32 / fail 0（偽の発言が結果にあることと、Claude 側のセッションの発言も除かれることを確かめる形にした）。typecheck → 0

- [x] T09: search に session を足し、今のセッションが分からないときは含まれうると言う
  - 種別: 修正
  - 計画: S5
  - 依存: なし
  - 変更: `server/src/mcp.ts`, `server/src/asked.ts`, `server/test/plugin.test.ts`, `server/test/asked.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/plugin.test.ts` → 環境変数の無い（Codex と同じ）MCP で、session を渡しても今のセッションの発言が返って落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/plugin.test.ts test/asked.test.ts` → 全部 pass。`bun run verify` → 0
  - コミット: `fix(mcp): take the session to leave out in asked, and say when it is unknown`
  - 結果: red（直す前）`node --test test/plugin.test.ts` → 環境変数の無い MCP に session を渡しても、今の Codex のセッションの発言が返り「Asked in 2 sessions」に数えられて失敗。直した後 `node --test test/plugin.test.ts test/asked.test.ts` → pass 32 / fail 0（session を渡せば除く、渡さなければ「Owner messages matching:」と注意書き）。`bun run verify` → 0（`sql:reach` 161 / 161、acceptance 62 / 62）

## P3: 測定と acceptance

- [x] T05: 固定のコーパスで関係ない発言を返す率を測るローカルの評価を足して流す
  - 種別: 追加
  - 計画: S6
  - 依存: T03（一致と組み立てが要る）
  - 変更: `server/evals/asked/run.ts`, `server/evals/asked/corpus.json`, `knip.json`
  - 完了条件: `node server/evals/asked/run.ts` → 関係ない / 返した数、見落とし、空、上限で止まった問いを出力する。`bun run verify` → 0
  - コミット: `test(evals): measure unrelated earlier-message matches on a fixed corpus`
  - 結果: `node evals/asked/run.ts`（server/ から）→ unrelated / returned 0 / 8（0.0%）、missed / related 13 / 21（61.9%）。空の問い 4 件（q-tel、q-token、q-log、q-hira）、上限で止まった問いは無し。ひらがなの問い q-hira は db-1・db-3 を見落とした。`bun run verify` → 0（`sql:reach` 161 / 161、acceptance 60 / 60）

- [x] T06: asked の acceptance case を足す
  - 種別: 追加
  - 計画: S7
  - 依存: T03（組み立てが要る）
  - 変更: `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`, `server/test/acceptance-cases.test.ts`
  - 完了条件: `bun run acceptance` → 追加した case を含めて全部 pass。`bun run verify` → 0
  - コミット: `test(acceptance): cover earlier owner messages and what they led to`
  - 結果: `bun run acceptance` → pass 62 / fail 0（asked-01: 保存先を聞くと `trace:s-ja-storage/storage (decision, active)` を示す。asked-02: trace していないテレメトリの発言に「No recorded decision. Not traced yet」）。ドライバーに `asked` のステップと `asked_contains` の期待を足し、層ごとの件数に asked: 2 を足した。`bun run verify` → 0（`sql:reach` 161 / 161、`sql:live` 8 / 8）

## 記録

2026-09-29 / T04 / plan の「Skill で search の使い方を書いている箇所があれば合わせる」に当たる箇所は Skill に無く、README の機能の一覧だった（plugin/README.md は bundle が写す追跡外のファイル） / T04 の変更欄に `README.md` を足した（前: `server/src/mcp.ts`, `server/test/plugin.test.ts`）
2026-09-29 / T05 / knip が入口に無いファイルを未使用とみなすので、`evals/asked/run.ts` を knip.json の入口に足した。測定では、関係ない発言は返さない一方で見落としが多い（語の半分を超える規則の厳しさ）。ひらがなの問いの見落としは u29 の見直しの条件に当たる / T05 の変更欄に `knip.json` を足した（前: `server/evals/asked/run.ts`, `server/evals/asked/corpus.json`）。一致の規則の見直しは plan の対象外なので、数字を PR に書いて持ち主の判断に回す
2026-09-29 / T07 / Codex レビュー: T01（120d791）は指摘なし。T02（3fdd478）2 件のうち、AI の返事を除く確認が空振り（F1）は採用、当たりのターンが未テスト（F2）は見送り（asked.test.ts の同じターンの文脈と返事がターンを使って通る）。T03（46c35f5）4 件（本文で見出しを偽装できる、隠した記録が文脈に出る、一部だけ trace 済みのセッションを traced と数える、表示しない発言の後継をたどる）は全部採用。T04（5c2e6c7）3 件（両方の環境変数があると Codex のセッションを除き損ねる、`path: ""` を断らない、framed をテストしていない）は全部採用 / 修正タスク T07 を足した。表示しない分の後継（F4）は性能の直しで、red のテストは作らない
2026-09-29 / T08 / c2a6be3（T07）と main..c2a6be3 の Codex レビュー: 同じターンの文脈に絞り込みがかからない（両方で指摘）は採用。両方のセッション id の除外を Codex 側しか確かめていない、偽の見出しのテストが偽の発言が結果にあることを確かめていない、の 2 件も採用。review-shipping は、Codex が起動した読み取りの MCP には CODEX_THREAD_ID が無く、Codex では今のセッションの発言が返ることを再現した（テストはその環境変数を与えて空振りしていた） / 修正タスク T08 を足した。Codex の件は公開インターフェースに響くので、持ち主に直し方を聞いてから plan を直す
2026-09-29 / T09 / 持ち主が Codex の件で「session 引数を足す」を選び、plan を直した（変更履歴を参照） / 修正タスク T09 を足した
