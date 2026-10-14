---
kind: tasks
plan: 14-timeline-outside-339.plan.md
branch: fix/timeline-outside-339
base: main
---

# 質問に答えた記録を DB の行に持たせ、timeline が出す連なりの外の記録の行を、連なりの記録が答えた質問の取り下げだけにする（issue #339） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 答えた記録を DB の行に持たせる

revision 13 の DB に `unit_answer` ができ、質問を閉じる保存がそこへ書く。これまでの取り下げは移行で写る。timeline の返信はまだ変わらない。

- [ ] T01: schema を revision 13 にして `unit_answer` を足し、これまでの取り下げを移行で写し、0.6.57 にする
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `db/schema.sql`, `db/migrations/0013.sql`, `server/src/sqlite.ts`, `server/src/db-types.ts`, `server/src/db-write.ts`, `server/test/fixtures/schema-rev12.sql`, `server/test/schema.test.ts`, `server/test/db.test.ts`, `server/test/migrate.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 test/migrate.test.ts test/schema.test.ts test/db.test.ts` → 全部通る（revision 12 からの移行が fresh と同じ定義になる、写しが `answered by` の取り下げだけを取り違えずに写す、trigger が断る、ingest だけが insert できる）。`bun run codegen:check` → 0。`bun run release:plan -- --base 9fec994c` → `plugin`、4 か所が 0.6.57
  - コミット: `feat(schema): keep the record that answered a question beside its withdrawal (revision 13)`

- [ ] T02: 質問を閉じる保存が `unit_answer` を書く
  - 種別: 追加
  - 計画: S2
  - 依存: T01（`unit_answer` の表と ingest の許可が無いと insert できない）
  - 変更: `server/src/reconcile.ts`, `server/src/record.ts`, `scripts/check-architecture.mjs`, `server/test/record.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 test/record.test.ts` → 全部通る（閉じた質問と、連鎖で閉じた古い質問に `unit_answer` の行があり、閉じなかった `answers` と glean の取り下げには無く、出典を forget しても残る）。`bun run architecture` → 通り、`unit_answer` を書くのは `reconcile.ts` だけと言う
  - コミット: `feat(record): write the answering record when a save closes a question`

## P2: timeline の返信を直す

頼んだ記録と関係の無い行が timeline から消え、連なりの記録が答えた質問の取り下げだけが残る。

- [ ] T03: timeline が出す連なりの外の記録の行を、連なりの記録が答えた質問の取り下げだけにする
  - 種別: 修正
  - 計画: S3
  - 依存: T01（問い合わせが `unit_answer` を読む）, T02（保存が `unit_answer` を書かないと、実際の保存の経路のテストで取り下げの行が出ない）
  - 変更: `server/src/timeline.ts`, `server/test/timeline.test.ts`, `server/evals/acceptance/driver.ts`, `server/evals/acceptance/cases.json`, `server/test/acceptance-cases.test.ts`
  - red: テストとケースを足した後、`server/src/timeline.ts` を直す前に `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 test/timeline.test.ts` → 足したテストが、連なりの外の記録の `became superseded` の行や、連なりの記録が答えていない質問の `became withdrawn` の行が出ている、という理由で失敗する。`bun run acceptance` → `battery` の timeline に `every5` の行がある、という理由で 1 件失敗する
  - 完了条件: 同じ 2 つのコマンド → 全部通る（retrieval は 17 件）。`cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 test/acceptance-cases.test.ts` → 全部通る
  - コミット: `fix(read): tell only a question a chain record answered among changes to records outside a timeline's chain`

## P3: 規範と手順を合わせる

schema の Skill が新しい表を言い、リリースの Skill が revision を上げるときの到着の順序を言う。

- [ ] T04: Skill に `unit_answer` と、revision を上げるリリースの到着の順序を書く
  - 種別: 変更
  - 計画: S4
  - 依存: T02（`reconcile` が `unit_answer` を書いていないと、Skill が先に違うことを言う）
  - 変更: `.agents/skills/knowledge-schema/SKILL.md`, `.agents/skills/plugin-release/SKILL.md`
  - 完了条件: `bun run verify:ai` → 通る。`rg -n "unit_answer" .agents/skills/knowledge-schema/SKILL.md` → 表の一覧と `reconcile` の説明に出る。`rg -n "mcp-record" .agents/skills/plugin-release/SKILL.md` → 移行の前に古い記録 MCP が無いことを確かめる段がある
  - コミット: `docs(skills): name unit_answer and the order of arrival for a release that raises the revision`

## 記録
