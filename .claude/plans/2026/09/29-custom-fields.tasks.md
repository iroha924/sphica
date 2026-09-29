---
kind: tasks
plan: 29-custom-fields.plan.md
branch: feat/custom-fields
base: main
---

# プロジェクトごとのカスタム項目を、引用付きの値として trace の記録に持たせる期限付きの試作（#196、0.6.8） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: schema と forget

定義と値の表が DB の規則ごとに入り、forget で一緒に消える

- [x] T01: schema を revision 4 にし、`field_def` と `unit_field`、トリガー、検索のビューと移行 `0004.sql` を足す
  - 種別: 追加
  - 計画: S1, S2
  - 依存: なし
  - 変更: `db/schema.sql`, `db/migrations/0004.sql`, `server/src/sqlite.ts`, `server/src/db-types.ts`, `server/src/knowledge.ts`, `server/src/db-write.ts`, `scripts/check-pairs.mjs`, `server/test/fixtures/schema-rev3.sql`, `server/test/schema.test.ts`, `server/test/migrate.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/migrate.test.ts` → 各トリガーの拒否（owner でない定義、別プロジェクト、範囲外、kinds 外、state の後の値、型の違反、update）と、rev3 から移行した DB と新しい DB の一致が通る。`bun run release:plan -- --base v0.6.7` → `plugin`、4 つのファイルが 0.6.8。`bun run verify` → 0
  - コミット: `feat(schema): add project-defined fields and quoted field values (revision 4)`
  - 結果: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/migrate.test.ts` → 30 pass / 0 fail（定義と値の各拒否、source を消すと定義・値が消え revision が上がり検索から消える、rev1〜3 から移行した DB と新しい DB の定義が一致、rev3 から移行した後に値で検索できる）。HEAD の schema.sql に戻すと新しい 2 件と revision の 1 件が落ちる。`bun run release:plan -- --base v0.6.7` → `plugin`、npm と 3 つの manifest が 0.6.8。`node scripts/check-pairs.mjs` は FIELD_TYPES と kinds の一覧をずらすとそれぞれ落ちる。`bun run verify` → 0

- [ ] T02: forget の認可とプレビューに定義と値を入れる
  - 種別: 追加
  - 計画: S1, S2
  - 依存: T01（新しい表が要る）
  - 変更: `server/src/db-write.ts`, `server/src/forget.ts`, `server/test/forget.test.ts`, `server/test/db.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/forget.test.ts test/db.test.ts` → 実際の forget 接続で、定義の引用元と値の引用元それぞれを消すと、プレビューの件数どおりに消え、値の語で検索に出なくなり、unit の revision が上がって古い revision の glean 操作が拒否される。`bun run verify` → 0
  - コミット: `feat(forget): remove field definitions and values with their quoted sources`

## P2: trace で書く

trace の保存で定義と値を検査して書き、値で検索できる

- [ ] T03: record の入力に `field_defs` と unit の `fields` を足し、検査と保存、record_context の定義を作る
  - 種別: 追加
  - 計画: S1, S3
  - 依存: T01（新しい表が要る）
  - 変更: `server/src/record.ts`, `server/src/extract.ts`, `server/src/mcp-record.ts`, `server/test/record.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/record.test.ts` → trace 以外の run の拒否、再定義の拒否、各型の表記の規則（`p95=320ms` から 320 は通り 95 は拒否、`-5` から 5・`1.5` から 1・`1e3` から 1 は拒否）、定義だけの save で source が `units` になる、が通る。`bun run verify` → 0
  - コミット: `feat(record): take field definitions and quoted field values in trace`

- [ ] T04: 検索の判定語に値を入れ、acceptance を足す
  - 種別: 追加
  - 計画: S1, S3
  - 依存: T03（record_save で値を書けることが要る）
  - 変更: `server/src/search.ts`, `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`, `server/test/acceptance-cases.test.ts`
  - 完了条件: `bun run acceptance` → 定義 → 値 → 値だけで search に残る、引用に表記の無い値が拒否、定義だけの save、の 3 件が通る（判定語を足す前に 1 件目が弱い一致で落ちることを結果に残す）。`bun run verify` → 0
  - コミット: `feat(search): match records by their field values`

## P3: 見せる

read と `/sphica:fields` で定義と値が見える

- [ ] T05: `read` に値と引用の `Fields:` を出す
  - 種別: 追加
  - 計画: S4
  - 依存: T01（新しい表が要る）
  - 変更: `server/src/read.ts`, `server/test/search.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/search.test.ts` → read に name、値、source ref、引用文、話し手、日時が出る。`bun run verify` → 0
  - コミット: `feat(read): show field values with their quotes`

- [ ] T06: 読み取りの MCP に `fields` ツールを足す
  - 種別: 追加
  - 計画: S4
  - 依存: T01（新しい表が要る）
  - 変更: `server/src/fields.ts`, `server/src/mcp.ts`, `server/test/fields.test.ts`, `server/test/plugin.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/fields.test.ts test/plugin.test.ts` → 定義ごとの件数の表、`|` と改行の入ったセル、200 文字の切り詰め、framed の囲み、ツール一覧に `fields`。`bun run verify` → 0
  - コミット: `feat(mcp): add the fields tool to the read server`

- [ ] T07: `/sphica:fields` Skill を足す
  - 種別: 追加
  - 計画: S4
  - 依存: T06（`allowed-tools` の検査が登録済みのツール名を求める）
  - 変更: `plugin/skills/fields/SKILL.md`, `plugin/skills/fields/agents/openai.yaml`, `README.md`, `README.ja.md`
  - 完了条件: `bun run verify:ai` → 0。`bun run english` → 0
  - コミット: `feat(skills): add /sphica:fields to show field definitions`

## P4: trace の手順と出荷の準備

trace Skill が項目の書き方を案内し、0.6.8 にそろう

- [ ] T08: trace Skill に項目の書き方を足す
  - 種別: 変更
  - 計画: S5
  - 依存: T03（Skill が説明する入力の形が要る）
  - 変更: `plugin/skills/trace/SKILL.md`
  - 完了条件: `bun run verify:ai` → 0。`bun run verify` → 0
  - コミット: `feat(trace): explain field definitions and values`

## 記録
2026-09-29 / T01 / source の削除が新しい表へ連鎖すると forget の接続が `not authorized` で止まり、forget のテストが落ちた / forget の認可（`FORGET_WRITES` に field_def・unit_field・unit_fts）を T02 から T01 に移した。T01 の変更欄に `server/src/db-write.ts` を足し、値の型の一覧を knowledge.ts の `FIELD_TYPES` と check-pairs の組にしたので `server/src/knowledge.ts` と `scripts/check-pairs.mjs` も足した（前: schema・移行・sqlite・db-types・fixture・テストのみ）
2026-09-29 / T01, T08 / パッケージに入る変更はバージョンを揃えないと pre-commit の bundle が止める / 0.6.8 への引き上げを T08 から T01 に移した。T01 の変更欄と完了条件に 4 つの manifest と release:plan を足し、T08 の変更欄（前: trace Skill と 4 つの manifest、新: trace Skill のみ）と完了条件（前: release:plan・verify:ai・verify、新: verify:ai・verify）と名前を直した
