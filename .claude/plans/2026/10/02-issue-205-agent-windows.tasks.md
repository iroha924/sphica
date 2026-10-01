---
kind: tasks
plan: 02-issue-205-agent-windows.plan.md
branch: feat/issue-205-agent-windows
base: main
---

# #205 後半: 読む前の配信の「表示済み」と予算を、compaction の区切り・エージェントごと・並行の読み込みで正しく数える のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: schema revision 6

配信のログにエージェントの欄ができ、古いビューを変えずに新しいビューから書ける。

- [x] T01: delivery.agent_id と capture_delivery_scoped を revision 6 で足す
  - 種別: 追加
  - 計画: S1, S6
  - 依存: なし
  - 変更: `db/schema.sql`, `db/migrations/0006.sql`, `server/test/fixtures/schema-rev5.sql`, `server/src/db-types.ts`, `server/src/sqlite.ts`, `server/src/db-write.ts`, `server/test/migrate.test.ts`, `server/test/db.test.ts`, `server/test/schema.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `cd server && node --test test/migrate.test.ts test/db.test.ts test/schema.test.ts` → pass。rev 5 の delivery・delivery_unit の行が残り、capture_delivery の列が変わらず、capture の役が capture_delivery_scoped に agent_id 付きで書ける
  - コミット: `feat(schema): add delivery.agent_id and a scoped capture view in revision 6 (T01)`
  - 結果: `bun run release:plan -- --base v0.6.16` → plugin。4 つのファイルを 0.6.17 にした。`node --test test/migrate.test.ts test/db.test.ts test/schema.test.ts` → 83 pass / 0 fail（rev 5 から移行した DB と新しい DB の定義が一致、rev 5 の delivery が agent_id null で残る、capture の役が両方のビューに書けて delivery へ直接は書けない、agent_id の空と 201 文字は CHECK で拒否）。`bun run test`（server）→ 545 pass。lint・typecheck・pairs・architecture・codegen:check → 通過

## P2: 数え方の修正

サブエージェント・compaction・並行の読み込みで、表示済みと予算が正しく数えられる。

- [ ] T02: 配信のログに agent_id を付け、表示済みと予算をエージェントごとに数える
  - 種別: 修正
  - 計画: S2
  - 依存: T01（agent_id の列と書き込み先のビューが要る）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - red: `cd server && node --test --test-name-pattern="subagent" test/deliver.test.ts` → 子の Read の後に親が同じ path を Read すると記録が出ない（親の表示済みにされている）ので落ちる
  - 完了条件: `cd server && node --test --test-name-pattern="subagent" test/deliver.test.ts` → pass。子 A・子 B・親が別々に数えられ、子の Edit が親の Read を止めない
  - コミット: `fix(deliver): count shown records and the read budget per agent (T02)`

- [ ] T03: 親の compact と clear で読む前の窓を区切る
  - 種別: 修正
  - 計画: S2
  - 依存: T02（窓の検索が agent_id で絞った行を前提にする）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - red: `cd server && node --test --test-name-pattern="compact|clear" test/deliver.test.ts` → compact の後に同じ path を Read しても記録が出ないので落ちる
  - 完了条件: `cd server && node --test --test-name-pattern="compact|clear" test/deliver.test.ts` → pass。compact・clear で区切られ、startup・resume・fork では区切られず、本文が空でも区切りの行が書かれる
  - コミット: `fix(deliver): start counting reads again after compaction or clear (T03)`

- [ ] T04: 読む前とセッション開始の配信を、書き込みロックを取ってから計画する
  - 種別: 修正
  - 計画: S3
  - 依存: T03（ロックの中で計画するのは窓まで入った数え方）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`, `server/test/deliver-concurrent.test.ts`
  - red: `cd server && node --test test/deliver-concurrent.test.ts` → 同じセッションで deliver.ts を同時に起動すると同じ key が 2 回以上返るか、予算を超えるので落ちる
  - 完了条件: `cd server && node --test test/deliver-concurrent.test.ts` → pass（重なる unit・件数の上限・文字数の上限の 3 件）。`node --test --test-name-pattern="log fail" test/deliver.test.ts` → BUSY 以外のログの失敗で本文が返り、途中の行が残らない
  - コミット: `fix(deliver): plan reads and session starts under the write lock (T04)`

## P3: SubagentStart

サブエージェントの開始時に、作業中の件・広い constraint・検索の 1 行が両ホストで届く。

- [ ] T05: SubagentStart で開始の一式と検索の 1 行を配信する
  - 種別: 追加
  - 計画: S4
  - 依存: T02（agent_id 付きでログを書く）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`, `plugin/hooks/hooks.json`, `plugin/hooks/codex.json`, `scripts/check-ai-config.mjs`, `scripts/check-tarball.mjs`
  - 完了条件: `cd server && node --test --test-name-pattern="SubagentStart" test/deliver.test.ts` → pass。`bun run verify:ai` → exit 0（両ホストの配線の検査を含む）
  - コミット: `feat(deliver): give subagents the session-start records and a search line (T05)`

## P4: 受け入れケースとリリース

受け入れケースで固定し、0.6.17 に揃える。

- [ ] T06: 受け入れの driver にホスト・agent_id・event を足し、ケースを足す
  - 種別: 追加
  - 計画: S5
  - 依存: T04（並行と窓の挙動がケースの期待になる）, T05（SubagentStart のケースが要る）
  - 変更: `server/evals/acceptance/driver.ts`, `server/evals/acceptance/cases.json`, `server/test/acceptance-cases.test.ts`
  - 完了条件: `bun run verify` → exit 0（受け入れケースを含む）
  - コミット: `test(acceptance): pin per-agent and compaction delivery cases (T06)`

- [-] T07: release:plan を流し、0.6.17 に揃える
  - 種別: 変更
  - 計画: S6
  - 依存: T06（リリースに入る変更が揃っている）
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run release:plan -- --base v0.6.16` → plugin。4 つのファイルが 0.6.17
  - コミット: `chore(release): 0.6.17 (T07)`

## 記録
- 2026-10-02 / T01・T07 / pre-commit の bundle 検査が、パッケージに入る変更をバージョンを上げずにコミットさせない（前回の PR も最初のタスクで上げていた） / T01 の変更欄に schema.test.ts と 4 つのバージョンのファイルを足し（前: schema・migration・fixture・db-types・sqlite・db-write・migrate.test・db.test）、release:plan と 0.6.17 への更新を T01 でした。T07 は取りやめ（S6 は T01 が担う）
