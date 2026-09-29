---
kind: tasks
plan: 29-look-and-overview.plan.md
branch: feat/look-and-overview
base: main
---

# Add an on-request overview of live records and of records that need a look, per-option reconsider conditions, and a rules draft Skill (#193, #194, #195) のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: schema revision 3

却下案に見直し条件と持ち主の引用を持てる DB になり、revision 2 から移行できる。

- [x] T01: `reconsider_when` と role `reconsiders`、有効化の検査、migration 0003、revision 2 の fixture と移行テストを足し、バージョンを 0.6.4 に上げる
  - 種別: 追加
  - 計画: S1, S9
  - 依存: なし
  - 変更: `db/schema.sql`, `db/migrations/0003.sql`, `server/src/sqlite.ts`, `server/src/db-types.ts`, `server/src/knowledge.ts`, `server/test/fixtures/schema-rev2.sql`, `server/test/migrate.test.ts`, `server/test/schema.test.ts`, `server/test/admin.test.ts`, `plugin/package.json`, `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/migrate.test.ts test/schema.test.ts` → 全部 pass（移行した DB が新規と一致し、案と evidence の行と id が残る。rejected 以外の案への条件、案の無い `reconsiders`、owner 以外の引用で有効化、引用の無い条件で有効化が拒否される。`forget_id` 付きの有効化は通る）。`bun run codegen:check` → 0。`bun run release:plan -- --base ecf7717` → `plugin`、4 か所が 0.6.4
  - コミット: `feat(schema): let a rejected option carry a reconsider condition with the owner's quote`
  - 結果: `node --test test/migrate.test.ts test/schema.test.ts` → pass（revision 1 と 2 からの移行が新規の DB と定義一致、revision 2 の案と evidence の行と id が残り、移行後に条件付きの却下案と `reconsiders` が入る。chosen への条件・空の条件・案の無い `reconsiders`・条件の無い案への `reconsiders`・AI の発言の引用・引用の無い有効化が拒否され、条件の引用だけの取り消しでは active のまま、`forget_id` 付きの有効化は通る）。`npm test` → 381 / 381 pass。`bun run check`（lint・pairs・codegen:check・typecheck・knip ほか）→ 0。差分のファイルを `releaseKind` に渡して `plugin`、4 か所が 0.6.4

## P2: 見直し条件の保存と表示

trace が持ち主の言った見直し条件を引用付きで保存でき、`read` で見える。

- [x] T02: record_check / record_save に `reconsider_when` と `reconsider_quote` を足し、trace Skill に書き方を足す
  - 種別: 追加
  - 計画: S2
  - 依存: T01（新しい列と role が要る）
  - 変更: `server/src/record.ts`, `server/test/record.test.ts`, `plugin/skills/trace/SKILL.md`, `server/src/glean.ts`, `server/test/extract.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/record.test.ts` → 全部 pass（引用付きの条件が保存され active になる。片方だけ、owner 以外の引用、引用が source に無い、rejected 以外の案は拒否される。content_hash が条件で変わる）
  - コミット: `feat(record): save a reconsider condition the owner stated, with its quote`
  - 結果: `node --test test/record.test.ts test/extract.test.ts` → pass 33 / fail 0（引用付きの条件が保存されて active、`reconsiders` の span が持ち主の言葉を切り出す。条件の無い記録の content_hash は以前と同じ式、条件ありとは違う。片方だけ・chosen への条件・AI の引用・evidence に直接 `reconsiders` は拒否、引用が見つからないと quarantined。glean の add_evidence も `reconsiders` を拒否）。`npm test` → 382 / 382 pass。`bun run check` → 0、`bun run verify:ai` → 0

- [x] T03: `read` の却下案の下に見直し条件と引用を出し、引用を失った条件に unsupported と付ける
  - 種別: 追加
  - 計画: S3
  - 依存: T02（条件付きの記録を保存する経路が要る）
  - 変更: `server/src/read.ts`, `server/test/record.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/record.test.ts` → 全部 pass（`Reconsider when:` と引用が出る。引用を取り消すと unsupported と出て、決定は active のまま）
  - コミット: `feat(read): show a rejected option's reconsider condition and whether its quote still stands`
  - 結果: `node --test test/record.test.ts` → pass 20 / fail 0（却下案の下に `Reconsider when:` と `(reconsiders)` の引用が出る。引用を取り消すと `[unsupported: its owner quote was retracted or forgotten …]` と出て、決定は active のまま）。`npm test` → 382 / 382 pass。`bun run check` → 0

- [x] T09: 検索の照合に却下案の見直し条件の語を入れる
  - 種別: 修正
  - 計画: S2
  - 依存: T02（条件付きの記録を保存する経路が要る）
  - 変更: `server/src/search.ts`, `server/test/search.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/search.test.ts` → 条件の語（read replicas）だけの質問で、全文検索が拾った記録を照合が弱い候補として捨て、hits が空で落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/search.test.ts` → 全部 pass
  - コミット: `fix(search): match a rejected option's reconsider condition, which the index already holds`
  - 結果: red（直す前）`node --test test/search.test.ts` → 新しいテストが actual [] / expected ["trace:ext-s1/storage"] で失敗。直した後 → pass 13 / fail 0。`npm test` → 383 / 383 pass。`bun run check` → 0

- [x] T10: 見つからない見直し条件の引用を quarantine ではなく拒否にし、他人の言葉を条件にしないと trace Skill に書く
  - 種別: 修正
  - 計画: S2
  - 依存: T02（条件の検査が要る）
  - 変更: `server/src/record.ts`, `server/test/record.test.ts`, `plugin/skills/trace/SKILL.md`
  - red: `cd server && node --test --test-timeout=60000 test/record.test.ts` → source に無い `reconsider_quote` で check の errors が空（quarantine されるだけ）で落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/record.test.ts` → 全部 pass
  - コミット: `fix(record): refuse a reconsider condition whose quote is not in the source`
  - 結果: red（直す前）`node --test test/record.test.ts` → actual '' / expected /reconsider_quote not found in s\d+/ で失敗。直した後 → pass 20 / fail 0。`npm test` → 383 / 383 pass。`bun run check` → 0、`bun run verify:ai` → 0

- [x] T11: trace Skill に、見つからない見直し条件の引用は保存を拒否すると書く
  - 種別: 変更
  - 計画: S2
  - 依存: T10（拒否の挙動が要る）
  - 変更: `plugin/skills/trace/SKILL.md`
  - 完了条件: `bun run verify:ai` → 0
  - コミット: `docs(trace): say a missing reconsider quote refuses the save`
  - 結果: `bun run verify:ai` → 0

## P3: overview ツール

頼まれたとき、有効な決定と制約の一覧と、確認が要る記録の一覧が出る。

- [x] T04: ファイルの有無の検査（親の symlink を含む）と、規約ファイルの列挙（git と git の外、上限付き）を足す
  - 種別: 追加
  - 計画: S4
  - 依存: なし
  - 変更: `server/src/anchors.ts`, `server/src/rule-files.ts`, `server/test/rule-files.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/rule-files.test.ts` → 全部 pass（消えたファイル、root の外へ出る symlink の親、未追跡の規約ファイル、ignore されたファイルを除く、git の外のたどり、200 ファイルと 256 KiB と深さの上限で件数が出る）
  - コミット: `feat(overview): check whether anchored files exist and list rule files to scan`
  - 結果: `node --test test/rule-files.test.ts` → pass 7 / fail 0（ファイルが消えたものと関数名だけ消えたものの区別、root の外へ出る symlink と壊れた symlink の親は unknown、git の未追跡を含み ignore を除く、作業ツリーで消した追跡ファイルは出ない、大きすぎ・バイナリ・symlink を件数で出す、200 件の上限、git の外のたどりで node_modules・ドットディレクトリ・symlink を飛ばす、深さ 8 と 5,000 エントリで不完全と出す）。`npm test` → 全件 pass。`bun run check` → 0

- [x] T05: `overview` の `live` を足す（unit id のページ送り、ディレクトリごとのまとめ、50 件と 64 KiB の上限）
  - 種別: 追加
  - 計画: S5
  - 依存: なし
  - 変更: `server/src/overview.ts`, `server/src/mcp.ts`, `server/test/overview.test.ts`, `server/test/plugin.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/overview.test.ts` → 全部 pass（fixture の有効な決定と制約を全件出し superseded と withdrawn を出さない、複数ディレクトリの記録は 1 回だけ、ページの間の supersede で取りこぼさない、上限で切れても最低 1 件出て次の `after` が出した最大の id）
  - コミット: `feat(overview): list every live decision and constraint, grouped by directory`
  - 結果: `node --test test/overview.test.ts` → pass 2 / fail 0（有効な決定と制約 5 件を全部出し、finding・superseded・withdrawn・candidate を出さない。最初の applies_to のディレクトリでまとめ、ルートのファイルは (repository root)、場所の無いものは最後。55 件で 1 ページ目 50 件、ページの間に supersede しても 2 ページ目に残り 5 件と後継が出る）。`npm test` → 392 / 392 pass。`bun run check` → 0、`sql:reach` → 164 / 164

- [x] T12: 規約ファイルの上限を見たファイルの数で数え、途中がファイルのパス・読めないディレクトリ・規約ファイル名の symlink を取りこぼさない
  - 種別: 修正
  - 計画: S4
  - 依存: T04（検査と列挙が要る）
  - 変更: `server/src/anchors.ts`, `server/src/rule-files.ts`, `server/test/rule-files.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/rule-files.test.ts` → 途中がファイルのパスで ENOTDIR が投げられる、読めないファイル 201 件を全部読む（readFileSync 201 回）、git の外で規約ファイル名の symlink が skipped に入らない、で 3 件落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/rule-files.test.ts` → 全部 pass
  - コミット: `fix(overview): bound rule-file reads by files looked at and count what the walk could not read`
  - 結果: red（直す前）→ 3 件が上の理由で失敗（ENOTDIR、actual [0, 201, 201] / expected [0, 201, 200]、actual skipped 0 / expected 1）。直した後 `node --test test/rule-files.test.ts` → pass 10 / fail 0。`npm test` → 全件 pass。`bun run check` → 0

- [x] T06: `overview` の `look` を足し、forget と取り消しの回帰テストを足す
  - 種別: 追加
  - 計画: S6
  - 依存: T03（unsupported の判定が要る）, T04（ファイルの検査と規約ファイルの列挙が要る）, T05（ツールと返事の組み立てが要る）
  - 変更: `server/src/overview.ts`, `server/src/mcp.ts`, `server/test/overview.test.ts`, `server/test/forget.test.ts`, `server/src/read.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/overview.test.ts test/forget.test.ts` → 全部 pass（Files gone、Symbol not found、Reconsider conditions、Rule markers の superseded・withdrawn・無いキー、確かめられなかった件数。引用だけの source を forget しても決定が active で unsupported と出る）
  - コミット: `feat(overview): list records that need a look: gone files, conditions, stale rule markers`
  - 結果: `node --test test/overview.test.ts test/forget.test.ts` → pass 15 / fail 0（Files gone に消したファイル、Symbol not found に関数名だけ消えたもの、Conditions に引用付きの却下案の条件と defer の revisit_when、Rule markers に superseded（後継のキー付き）・withdrawn・無いキーの行番号とキーだけ。外へ出る symlink は Not checked に件数、作業ツリーが無いと各見出しが not checked。引用だけの source を forget しても決定は active で、read と look に unsupported）。`npm test` → 397 / 397 pass。`bun run check` → 0、`sql:reach` → 169 / 169

- [x] T13: live の行を部分ごとに切り詰めてパスを残し、見出しも切り詰め、live と look のキーを inline に通す
  - 種別: 修正
  - 計画: S5
  - 依存: T06（look の行が要る）
  - 変更: `server/src/overview.ts`, `server/test/overview.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/overview.test.ts` → 改行を含むキー（session の部分から入る）で独立した `## forged` 行が出て落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/overview.test.ts` → 全部 pass（64 KiB 未満、偽の行が出ない、長い本文でも全件にパスが残る）
  - コミット: `fix(overview): clip each part of a live line and keep keys on one line`
  - 結果: red（直す前）→ `/^## forged/m` に一致して失敗。直した後 `node --test test/overview.test.ts` → pass 4 / fail 0（本文 2,000 字・440 字のディレクトリ 49 件と改行入りキーで 64 KiB 未満、49 件すべてに `/f.ts]` が残る）。`npm test` → 全件 pass。`bun run check` → 0

- [x] T14: look の返事全体にバイトの上限を置き、読めないファイルと 2,000 件を超えたアンカーを数え、後継を最後までたどり、長いキーのマーカーも読む
  - 種別: 修正
  - 計画: S6
  - 依存: T06（look が要る）
  - 変更: `server/src/overview.ts`, `server/test/overview.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/overview.test.ts` → 大きすぎて関数名を探せないファイルが Not checked に数えられずに落ちる（ほかに、300 字を超えるキーのマーカーを読まない、25 段の置き換えで途中の記録を後継と出す、を同じテストで見る）
  - 完了条件: `cd server && node --test --test-timeout=60000 test/overview.test.ts` → 全部 pass
  - コミット: `fix(overview): bound the whole look reply and count every place it could not check`
  - 結果: red（直す前）→ `/- 1 code locations whose file could not be scanned/` に一致せず失敗。直した後 `node --test test/overview.test.ts` → pass 5 / fail 0（64 KiB 未満、Files gone に「100 more not shown」、25 段の置き換えの先が v25、400 字のセッション id のキーの後継が出る）。`npm test` → 399 / 399 pass。`bun run check` → 0、`sql:reach` → 170 / 170

## P4: 規約の下書きと受け入れ

持ち主が選んだ制約から規約の下書きが出て、両ホストの受け入れ case が揃う。

- [x] T07: `/sphica:rules` Skill と Codex の呼び出し設定を足す
  - 種別: 追加
  - 計画: S7
  - 依存: T05（Skill が live を使う）
  - 変更: `plugin/skills/rules/SKILL.md`, `plugin/skills/rules/agents/openai.yaml`, `README.md`, `README.ja.md`
  - 完了条件: `bun run verify:ai` → 0。`cd server && node --test --test-timeout=60000 test/plugin.test.ts` → 全部 pass（rules Skill が明示の呼び出しだけで、Codex の policy が対である）
  - コミット: `feat(rules): draft rule lines for constraints the owner picks, marked with their record keys`
  - 結果: `bun run verify:ai` → 0（plugin Skills 6、`disable-model-invocation: true` と `allow_implicit_invocation: false` の対を検査が確かめる）。`node --test test/plugin.test.ts` → pass 28 / fail 0。`bun run english` → 0

- [ ] T08: acceptance に overview の live と look と見直し条件の case を足し、新しい SQL の呼び出し箇所が全部通ることを確かめる
  - 種別: 追加
  - 計画: S8
  - 依存: T06（look が要る）, T07（rules Skill が要る）
  - 変更: `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`, `server/test/acceptance-cases.test.ts`
  - 完了条件: `bun run verify` → 0（acceptance の case と `sql:reach` が全件）
  - コミット: `test(acceptance): cover the overview views and reconsider conditions`

## 記録
- 2026-09-29 / T01 / `sphica init` の移行テストが revision 2 を固定で期待していた / 変更欄に `server/test/admin.test.ts` を足した（前: 無し）
- 2026-09-29 / T02 / glean の add_evidence も同じ role 一覧を使っていて、`reconsiders` を渡すと DB のトリガーで分かりにくく落ちる / 入力で除き、変更欄に `server/src/glean.ts`, `server/test/extract.test.ts` を足した（前: 無し）
- 2026-09-29 / T09 / T01 の Codex レビュー F1: 見直し条件は全文検索の索引に入るが、search の照合（judgeUnits）が案の text と why しか見ず、条件の語だけの質問を捨てる / 修正タスク T09 を足した。F2（`reconsiders` を入力で受け付ける）と F3（content_hash に条件が無い）は T02 で直してあり、採らない
- 2026-09-29 / T10 / T02 の Codex レビュー F2: 見つからない条件の引用で記録ごと quarantine になり、T02 の完了条件（拒否）と食い違う / 修正タスク T10 で拒否にした
- 2026-09-29 / T10 / T02 の Codex レビュー F1: 持ち主が他人の発言を紹介した一文も条件の引用として通る。採用の引用と同じく author_kind でしか見られず、機械では見分けられない / trace Skill に書き足すだけにした
- 2026-09-29 / T03, T09 / Codex レビュー: 指摘なし
- 2026-09-29 / T11 / T10 の Codex レビュー F1: trace Skill の「引用が無いと quarantine」の説明が、見直し条件の引用だけは拒否になった挙動と食い違う / T11 を足して Skill に書いた
- 2026-09-29 / T05 / 1 行を 600 バイトで切るので 50 行で 64 KiB に届かず、バイトの上限の分岐は通らない / 分岐を置かず、定数のコメントで 64 KiB 未満に収まる理由を書いた。ツール一覧のテスト（plugin.test.ts）に overview を足し、変更欄にも足した（前: 無し）
- 2026-09-29 / T12 / T04 の Codex レビュー F1・F3・F6・F7（上限が読めた数だけ、ENOTDIR で例外、読めないディレクトリを黙って飛ばす、規約ファイル名の symlink を数えない）/ 修正タスク T12 を足した
- 2026-09-29 / T04 / Codex レビュー F2（検査と読み込みの間の差し替え）・F4（外へ出る親 symlink の下で消えた追跡ファイル）・F5（入れ子の git リポジトリと submodule）は採らない。どれも端の入力で、anchors.ts の readText も同じ前提で読む
- 2026-09-29 / T06 / 引用を失った条件の表示を read と揃えるため、read.ts の UNSUPPORTED を export した / 変更欄に `server/src/read.ts` を足した（前: 無し）
- 2026-09-29 / T12 / Codex レビュー: 指摘なし
- 2026-09-29 / T13 / T05 の Codex レビュー F1〜F3（キーが inline を通らず改行で行を偽造できる、長い本文でパスが切り詰めで消える、見出しが切り詰められず 64 KiB を超え得る）/ 修正タスク T13 を足した。look のキーも同じく inline に通した
- 2026-09-29 / T07 / Claude と Codex の呼び出し設定の対は `verify:ai`（check-ai-config.mjs）が全 plugin Skill に対して見ていて、plugin.test.ts に足すものが無かった。README の機能一覧に overview と rules を足した / 変更欄を `server/test/plugin.test.ts` から `README.md`, `README.ja.md` に変えた
- 2026-09-29 / T14 / T06 の Codex レビュー F1〜F5（返事全体の上限が無い、読めないファイルを none と出す、置き換えを 20 段で打ち切る、300 字を超えるキーのマーカーを見落とす、2,000 件を超えた件数を出さない）/ 修正タスク T14 を足した。F6（有効な制約の却下案の条件も出る）は採らない: 制約にも却下案と条件を持てるので、出すほうが正しい
