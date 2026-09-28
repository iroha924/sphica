---
kind: tasks
plan: 29-forget-sources.plan.md
branch: feat/forget-sources
base: main
---

# 持ち主が選んだ source を、索引と残りのバイトごと消し、それを根拠にした記録を判定し直す（W2、#187） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: schema revision 2 と移行

revision 1 の DB を記録を失わずに revision 2 へ上げられるようにする。

- [x] T08: バージョンを上げる（npm と 3 つの manifest）
  - 種別: 変更
  - 計画: S8
  - 依存: なし
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run release:plan -- --base v0.5.7` → plugin と出る。4 か所が同じバージョン
  - コミット: `chore(release): bump to 0.6.0`
  - 結果: `bun run release:plan -- --base v0.5.7` → release kind: plugin。4 か所を 0.6.0 にした。T01 と合わせて `bun run verify` → exit 0

- [x] T01: schema revision 2 と移行 SQL、新しい DB と移行した DB の一致のテスト
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `db/schema.sql`, `db/migrations/0002.sql`, `server/src/sqlite.ts`, `server/src/db-types.ts`, `server/test/migrate.test.ts`, `server/test/schema.test.ts`, `server/test/fixtures/schema-rev1.sql`
  - 完了条件: `cd server && node --test test/migrate.test.ts test/schema.test.ts` → 移行後の定義が新しい DB と一致し、`foreign_key_check` が空で、新しいトリガーの許可と拒否のテストが通る。`bun run verify` が通る
  - コミット: `feat(schema): add revision 2 with forget batches, tombstones, and a rebuilt unit_state`
  - 結果: `node --test test/migrate.test.ts test/schema.test.ts` → pass 3 / pass 19（定義の一致、foreign_key_check 空、行と id の保持、移行後の capture 書き込み、新しいトリガーの許可と拒否）。`bun run verify` → exit 0

- [x] T02: `sphica init` が revision 1 の DB を移行し、reader と ingest は init を案内する
  - 種別: 変更
  - 計画: S2
  - 依存: T01（移行 SQL と revision 2 が要る）
  - 変更: `server/src/admin.ts`, `server/src/sqlite.ts`, `server/src/cli.ts`, `server/test/admin.test.ts`, `scripts/check-sql-live.mjs`
  - 完了条件: `cd server && node --test test/admin.test.ts` → revision 1 の DB に init すると revision 2 になり、記録の件数が変わらない。移行の失敗で rollback される。`bun run sql:live` が通る
  - コミット: `feat(init): migrate a revision 1 database in place`
  - 結果: `node --test test/admin.test.ts` → pass 23（移行で revision 2・件数保持・再実行で変化なし、壊れた参照で rollback し revision 1 のまま）。`bun run sql:live` → 子プロセスの init が revision 1 を移行し、capture が書き込めた。`bun run verify` → exit 0

## P2: 削除の中身

選んだ source を消し、記録を判定し直し、取り込み直しを止める処理を、MCP に出す前に作る。

- [ ] T03: 接続の役 forget と、ingest による削除と墓標の書き込みの拒否
  - 種別: 追加
  - 計画: S3
  - 依存: T01（forget_batch と source_forgotten の表が要る）
  - 変更: `server/src/db-write.ts`, `server/src/sqlite.ts`, `server/test/db.test.ts`, `CLAUDE.md`, `AGENTS.md`
  - 完了条件: `cd server && node --test test/db.test.ts` → forget の許可と拒否、ingest の新しい拒否、forget が revision 1 を開けないテストが通る。`bun run architecture` が通る
  - コミット: `feat(db): add the forget connection role and keep ingest from deleting sources`

- [ ] T04: `forget.ts` の plan と apply（判定し直し、確認とのずれの検出、掃除）
  - 種別: 追加
  - 計画: S4
  - 依存: T03（forget 接続が要る）
  - 変更: `server/src/forget.ts`, `server/test/forget.test.ts`, `scripts/lib/sql-call-sites.mjs`
  - 完了条件: `cd server && node --test test/forget.test.ts` → #187 の完了条件、根拠が 2 つの記録、commit の anchor を持つ implementation、superseded と withdrawn、撤回の理由の source、external_reference、確認とのずれ、消し済みと存在しない id、バイトの掃除、busy のテストが通る。`bun run sql:reach` が通る
  - コミット: `feat(forget): delete chosen sources and judge the units that cited them again`

- [ ] T05: harvest と glean が墓標と同じ内容を保存しない
  - 種別: 追加
  - 計画: S5
  - 依存: T01（source_forgotten の表が要る）
  - 変更: `server/src/github.ts`, `server/src/glean.ts`, `server/test/github.test.ts`, `server/test/extract.test.ts`, `server/test/capture.test.ts`
  - 完了条件: `cd server && node --test --test-name-pattern=tombstone test/*.test.ts` → harvest・glean・capture で同じ内容は保存されず、本文を変えたものは保存される
  - コミット: `feat(ingest): skip items the owner forgot when harvesting, gleaning, and capturing`

## P3: `/sphica:forget` として出す

Claude Code と Codex から、人の確認付きで削除を呼べるようにする。

- [ ] T06: record サーバーの `forget_preview` と `forget_apply`、elicitation での確認
  - 種別: 追加
  - 計画: S6
  - 依存: T04（plan と apply が要る）
  - 変更: `server/src/mcp-record.ts`, `server/test/plugin.test.ts`
  - 完了条件: `cd server && node --test test/plugin.test.ts` → 件数の一致で消え、フォーム非対応・decline・cancel・不一致・エラーでは何も書かないテストと、ツール一覧のテストが通る
  - コミット: `feat(mcp): add forget_preview and forget_apply with a confirmation the owner types`

- [ ] T07: `/sphica:forget` Skill と受け入れケース
  - 種別: 追加
  - 計画: S7
  - 依存: T06（Skill が呼ぶツールが要る）
  - 変更: `plugin/skills/forget/SKILL.md`, `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`, `server/test/acceptance-cases.test.ts`
  - 完了条件: `bun run verify:ai` と `bun run acceptance` → Skill の検査と forget の受け入れケースが通る
  - コミット: `feat(skills): add /sphica:forget`

## 記録
2026-09-29 / T01 / `git show v0.5.7:db/schema.sql` は浅い clone で読めない / revision 1 の schema を `server/test/fixtures/schema-rev1.sql` に固定し、変更欄に足した（前: 6 ファイル、後: 7 ファイル）
2026-09-29 / T01 / rename が `unit_lifecycle_via_state` の参照で失敗した（実測）/ 移行で `unit_lifecycle_via_state` と `unit_option_sealed` を先に drop し、作り直す
2026-09-29 / T08 / pre-commit の bundle 検査が、パッケージに入る変更にバージョンの同時更新を求めた / T08 を T01 の前へ移し、同じコミットで済ませる（完了条件: 前 `release:plan` が plugin と出て verify が通る、後 plugin と出て 4 か所が同じバージョン）
