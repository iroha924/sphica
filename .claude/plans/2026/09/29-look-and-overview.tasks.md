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

- [ ] T03: `read` の却下案の下に見直し条件と引用を出し、引用を失った条件に unsupported と付ける
  - 種別: 追加
  - 計画: S3
  - 依存: T02（条件付きの記録を保存する経路が要る）
  - 変更: `server/src/read.ts`, `server/test/record.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/record.test.ts` → 全部 pass（`Reconsider when:` と引用が出る。引用を取り消すと unsupported と出て、決定は active のまま）
  - コミット: `feat(read): show a rejected option's reconsider condition and whether its quote still stands`

## P3: overview ツール

頼まれたとき、有効な決定と制約の一覧と、確認が要る記録の一覧が出る。

- [ ] T04: ファイルの有無の検査（親の symlink を含む）と、規約ファイルの列挙（git と git の外、上限付き）を足す
  - 種別: 追加
  - 計画: S4
  - 依存: なし
  - 変更: `server/src/anchors.ts`, `server/src/rule-files.ts`, `server/test/rule-files.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/rule-files.test.ts` → 全部 pass（消えたファイル、root の外へ出る symlink の親、未追跡の規約ファイル、ignore されたファイルを除く、git の外のたどり、200 ファイルと 256 KiB と深さの上限で件数が出る）
  - コミット: `feat(overview): check whether anchored files exist and list rule files to scan`

- [ ] T05: `overview` の `live` を足す（unit id のページ送り、ディレクトリごとのまとめ、50 件と 64 KiB の上限）
  - 種別: 追加
  - 計画: S5
  - 依存: なし
  - 変更: `server/src/overview.ts`, `server/src/mcp.ts`, `server/test/overview.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/overview.test.ts` → 全部 pass（fixture の有効な決定と制約を全件出し superseded と withdrawn を出さない、複数ディレクトリの記録は 1 回だけ、ページの間の supersede で取りこぼさない、上限で切れても最低 1 件出て次の `after` が出した最大の id）
  - コミット: `feat(overview): list every live decision and constraint, grouped by directory`

- [ ] T06: `overview` の `look` を足し、forget と取り消しの回帰テストを足す
  - 種別: 追加
  - 計画: S6
  - 依存: T03（unsupported の判定が要る）, T04（ファイルの検査と規約ファイルの列挙が要る）, T05（ツールと返事の組み立てが要る）
  - 変更: `server/src/overview.ts`, `server/src/mcp.ts`, `server/test/overview.test.ts`, `server/test/forget.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/overview.test.ts test/forget.test.ts` → 全部 pass（Files gone、Symbol not found、Reconsider conditions、Rule markers の superseded・withdrawn・無いキー、確かめられなかった件数。引用だけの source を forget しても決定が active で unsupported と出る）
  - コミット: `feat(overview): list records that need a look: gone files, conditions, stale rule markers`

## P4: 規約の下書きと受け入れ

持ち主が選んだ制約から規約の下書きが出て、両ホストの受け入れ case が揃う。

- [ ] T07: `/sphica:rules` Skill と Codex の呼び出し設定を足す
  - 種別: 追加
  - 計画: S7
  - 依存: T05（Skill が live を使う）
  - 変更: `plugin/skills/rules/SKILL.md`, `plugin/skills/rules/agents/openai.yaml`, `server/test/plugin.test.ts`
  - 完了条件: `bun run verify:ai` → 0。`cd server && node --test --test-timeout=60000 test/plugin.test.ts` → 全部 pass（rules Skill が明示の呼び出しだけで、Codex の policy が対である）
  - コミット: `feat(rules): draft rule lines for constraints the owner picks, marked with their record keys`

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
