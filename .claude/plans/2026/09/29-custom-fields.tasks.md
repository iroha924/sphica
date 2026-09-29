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

- [x] T02: forget の認可とプレビューに定義と値を入れる
  - 種別: 追加
  - 計画: S1, S2
  - 依存: T01（新しい表が要る）
  - 変更: `server/src/forget.ts`, `server/test/forget.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/forget.test.ts test/db.test.ts` → 実際の forget 接続で、定義の引用元と値の引用元それぞれを消すと、プレビューの件数どおりに消え、値の語で検索に出なくなり、unit の revision が上がって古い revision の glean 操作が拒否される。`bun run verify` → 0
  - コミット: `feat(forget): remove field definitions and values with their quoted sources`
  - 結果: `cd server && node --test --test-timeout=60000 test/forget.test.ts test/db.test.ts` → 30 pass / 0 fail（定義の引用元を消すとプレビューどおり定義 1・値 2 が消え、`acme` が unit の索引から消え、両 unit の revision が上がる。値の引用元だけを消すと値 1 だけが消えて定義は残り、消す前の revision で出した glean の withdraw が `changed since you read it` で拒否される）。HEAD の forget.ts に戻すと新しい 2 件と、outcome の形を見る既存の 1 件が落ちる。`bun run verify` → 0（`SQL: tests ran 180 / 180 sites`）

## P2: trace で書く

trace の保存で定義と値を検査して書き、値で検索できる

- [x] T03: record の入力に `field_defs` と unit の `fields` を足し、検査と保存、record_context の定義を作る
  - 種別: 追加
  - 計画: S1, S3
  - 依存: T01（新しい表が要る）
  - 変更: `server/src/record.ts`, `server/src/extract.ts`, `server/src/glean.ts`, `server/test/record.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/record.test.ts` → trace 以外の run の拒否、再定義の拒否、各型の表記の規則（`p95=320ms` から 320 は通り 95 は拒否、`-5` から 5・`1.5` から 1・`1e3` から 1 は拒否）、定義だけの save で source が `units` になる、が通る。`bun run verify` → 0
  - コミット: `feat(record): take field definitions and quoted field values in trace`
  - 結果: `cd server && node --test --test-timeout=60000 test/record.test.ts` → 23 pass / 0 fail（harvest の拒否、owner でない定義・同じ record での二重定義・enum の不整合・未定義の項目・引用に無い値・見つからない引用・kinds 外の拒否、`p95=320ms` から 320 は通り 95・`-5` から 5・`1.5` と `1e3` から 1 は拒否、「レイテンシは3件」から 3 は通る、保存した定義と値、次の run の record_context に定義が出て再定義は拒否、定義だけの save で source が `units`）。HEAD の record.ts では `valueInQuote` が無いため読み込みの段階で落ちる（挙動の違いによる失敗は確かめていない）。`bun run verify` → 0（`SQL: tests ran 185 / 185 sites`）

- [x] T04: 検索の判定語に値を入れ、acceptance を足す
  - 種別: 追加
  - 計画: S1, S3
  - 依存: T03（record_save で値を書けることが要る）
  - 変更: `server/src/search.ts`, `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`, `server/evals/acceptance/world.json`, `server/test/acceptance-cases.test.ts`
  - 完了条件: `bun run acceptance` → 定義 → 値 → 値だけで search に残る、引用に表記の無い値が拒否、定義だけの save、の 3 件が通る（判定語を足す前に 1 件目が弱い一致で落ちることを結果に残す）。`bun run verify` → 0
  - コミット: `feat(search): match records by their field values`
  - 結果: 判定語を足す前の `bun run acceptance` → 71 pass / 1 fail（fields-02 が `trace:s-ja-fields/cache not within 3:` で落ち、値の語は索引に当たっても判定で弱い一致として落ちていた）。足した後 → 72 pass / 0 fail（fields-01: 定義だけの save で定義が入り、その発言が `units`。fields-02: 値 globex が保存され、`globex` だけの検索で 3 位以内。fields-03: 引用に無い値 initech は `is not written in the quote` で拒否され、記録は残らない）。`bun run verify` → 0（`SQL: tests ran 186 / 186 sites`）

## P3: 見せる

read と `/sphica:fields` で定義と値が見える

- [x] T05: `read` に値と引用の `Fields:` を出す
  - 種別: 追加
  - 計画: S4
  - 依存: T01（新しい表が要る）
  - 変更: `server/src/read.ts`, `server/test/search.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/search.test.ts` → read に name、値、source ref、引用文、話し手、日時が出る。`bun run verify` → 0
  - コミット: `feat(read): show field values with their quotes`
  - 結果: `cd server && node --test --test-timeout=60000 test/search.test.ts` → 14 pass / 0 fail（`Fields:` の下に `tenant: acme (s<id> session_message session:s1, the owner, <日時>): "acme is slow"`）。HEAD の read.ts では新しい 1 件が落ちる。`bun run verify` → 0（`SQL: tests ran 187 / 187 sites`）

- [x] T06: 読み取りの MCP に `fields` ツールを足す
  - 種別: 追加
  - 計画: S4
  - 依存: T01（新しい表が要る）
  - 変更: `server/src/fields.ts`, `server/src/mcp.ts`, `server/test/fields.test.ts`, `server/test/plugin.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/fields.test.ts test/plugin.test.ts` → 定義ごとの件数の表、`|` と改行の入ったセル、200 文字の切り詰め、framed の囲み、ツール一覧に `fields`。`bun run verify` → 0
  - コミット: `feat(mcp): add the fields tool to the read server`
  - 結果: `cd server && node --test --test-timeout=60000 test/fields.test.ts test/plugin.test.ts` → 29 pass / 0 fail（定義ごとの行と値の付いた記録の件数 2 / 0、ラベルと引用の `|` が `\|` になって列の数が見出しと同じ、改行が空白になり説明は 200 バイトで切れる、別プロジェクトには定義が出ない、本物の読み取りサーバーのツール一覧に `fields`、登録の無いディレクトリでは isError）。`bun run verify` → 0（`SQL: tests ran 188 / 188 sites`）

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

## P5: レビューの直し

- [ ] T09: forget の後処理で unit 索引を毎回 optimize し、値だけが消えるときも本文が残る注意を出し、値の語がファイルに残らないことを確かめる
  - 種別: 修正
  - 計画: S2
  - 依存: T02（直す処理が要る）
  - 変更: `server/src/forget.ts`, `server/test/forget.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/forget.test.ts` → 後処理が失敗した後の再実行で値の語がファイルに残るテストと、値だけが消えるときの注意のテストが落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/forget.test.ts` → 値の語が DB と WAL のバイトに残らず、再実行でも消え、値だけが消える確認文に本文が残る注意が出る。`bun run verify` → 0
  - コミット: `fix(forget): always merge the unit index after forgetting, and warn when only field values go`

- [ ] T10: integer の数値の開始を、ラテン・ギリシャ・キリル文字、数字、`_`、`.`、符号の直後では認めないようにする
  - 種別: 修正
  - 計画: S3
  - 依存: T03（直す関数が要る）
  - 変更: `server/src/record.ts`, `server/test/record.test.ts`, `.claude/plans/2026/09/29-custom-fields.plan.md`
  - red: `cd server && node --test --test-timeout=60000 test/record.test.ts` → `x-5` から 5、`β95=320ms` と `ｐ95=320ms` から 95 を拒否するテストが落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/record.test.ts` → 上の 3 例が拒否され、`レイテンシは3件` から 3、`p95=-5` から -5、`320ms` から 320 は通る。`bun run verify` → 0
  - コミット: `fix(record): read an integer only where no identifier or sign runs into it`

## 記録
2026-09-29 / T01 / source の削除が新しい表へ連鎖すると forget の接続が `not authorized` で止まり、forget のテストが落ちた / forget の認可（`FORGET_WRITES` に field_def・unit_field・unit_fts）を T02 から T01 に移した。T01 の変更欄に `server/src/db-write.ts` を足し、値の型の一覧を knowledge.ts の `FIELD_TYPES` と check-pairs の組にしたので `server/src/knowledge.ts` と `scripts/check-pairs.mjs` も足した（前: schema・移行・sqlite・db-types・fixture・テストのみ）
2026-09-29 / T01, T08 / パッケージに入る変更はバージョンを揃えないと pre-commit の bundle が止める / 0.6.8 への引き上げを T08 から T01 に移した。T01 の変更欄と完了条件に 4 つの manifest と release:plan を足し、T08 の変更欄（前: trace Skill と 4 つの manifest、新: trace Skill のみ）と完了条件（前: release:plan・verify:ai・verify、新: verify:ai・verify）と名前を直した
2026-09-29 / T02 / 認可は T01 に移したので、T02 で変えたのは forget.ts とそのテストだけになった / T02 の変更欄を直した（前: db-write.ts・forget.ts・forget.test.ts・db.test.ts、新: forget.ts・forget.test.ts）。値を消したときは unit の索引の optimize も走らせ、値の語が索引の断片に残らないようにした
2026-09-29 / T03 / mcp-record.ts は record を unknown で受けて渡すだけなので変えずに済み、glean.ts は Checked の形が増えたので変えた / T03 の変更欄を直した（前: record.ts・extract.ts・mcp-record.ts・record.test.ts、新: record.ts・extract.ts・glean.ts・record.test.ts）
2026-09-29 / T03 / integer の数値の開始の条件で、Unicode の文字を除くと「レイテンシは3件」の 3 が取れなかった / ASCII の英字と `_` だけを除くようにし、plan の方針と変更履歴を直した
2026-09-29 / T01, T02 / Codex のレビュー: T01 の F1（値の語が unit 索引のブロックに残る）は T02 の optimize で直っていたが、バイトを見るテストが無い。T02 の F1（後処理が失敗した後の再実行で unit 索引の optimize が飛ぶ）と F2（値だけを失う記録で、本文が残る注意が出ない）は採用 / 修正タスク T09 を足した
2026-09-29 / T04 / acceptance のドライバーは trace の保存の拒否を期待できず、架空プロジェクトに項目を定義するセッションも無かった / ドライバーに `refused` の trace と `field_defined`・`field_value`・`source_outcome`・`no_unit` の確認を足し、world.json に s-ja-fields を足した。変更欄に world.json を足した（前: search.ts・cases.json・driver.ts・acceptance-cases.test.ts）
2026-09-29 / T03 / Codex のレビュー: F1（`x-5` から 5 が通る）と F2（`β95`・全角の `ｐ95` の 95 が通る）はどちらも再現されていて採用 / 修正タスク T10 を足した
2026-09-29 / T04, T05 / Codex のレビュー: どちらも指摘なし（読み取り専用の環境のためテストの実行はしていない、と明記あり） / 何もしない
