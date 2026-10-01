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

- [x] T02: 配信のログに agent_id を付け、表示済みと予算をエージェントごとに数える
  - 種別: 修正
  - 計画: S2
  - 依存: T01（agent_id の列と書き込み先のビューが要る）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - red: `cd server && node --test --test-name-pattern="subagent" test/deliver.test.ts` → 子の Read の後に親が同じ path を Read すると記録が出ない（親の表示済みにされている）ので落ちる
  - 完了条件: `cd server && node --test --test-name-pattern="subagent" test/deliver.test.ts` → pass。子 A・子 B・親が別々に数えられ、子の Edit が親の Read を止めない
  - コミット: `fix(deliver): count shown records and the read budget per agent (T02)`
  - 結果: red 実測: 直す前のコードで `node --test --test-name-pattern="subagent" test/deliver.test.ts` → 子 A が読んだ後の親の Read が [] で落ちた（期待 trace:ext-s1/k10）。直した後 → 1 pass。`node --test test/deliver.test.ts` → 22 pass。lint・typecheck → 通過

- [x] T03: 親の compact と clear で読む前の窓を区切る
  - 種別: 修正
  - 計画: S2
  - 依存: T02（窓の検索が agent_id で絞った行を前提にする）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - red: `cd server && node --test --test-name-pattern="compact|clear" test/deliver.test.ts` → compact の後に同じ path を Read しても記録が出ないので落ちる
  - 完了条件: `cd server && node --test --test-name-pattern="compact|clear" test/deliver.test.ts` → pass。compact・clear で区切られ、startup・resume・fork では区切られず、本文が空でも区切りの行が書かれる
  - コミット: `fix(deliver): start counting reads again after compaction or clear (T03)`
  - 結果: red 実測: 直す前のコードで `node --test --test-name-pattern="compact|clear" test/deliver.test.ts` → startup・resume・fork の確認は通り、compact の後の Read が [] で落ちた（期待 trace:ext-s1/k0）。直した後 → 1 pass。`node --test test/deliver.test.ts` → 23 pass。lint・typecheck → 通過

- [x] T04: 読む前とセッション開始の配信を、書き込みロックを取ってから計画する
  - 種別: 修正
  - 計画: S3
  - 依存: T03（ロックの中で計画するのは窓まで入った数え方）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - red: `cd server && node --test --test-name-pattern="concurrent" test/deliver.test.ts` → 同じセッションで deliver.ts を同時に起動すると同じ key が 2 回以上返るか、予算を超えるので落ちる
  - 完了条件: `cd server && node --test --test-name-pattern="concurrent|write lock" test/deliver.test.ts` → pass（重なる unit・件数の上限・文字数の上限の 3 件と、ロック中・BUSY 以外のログの失敗で本文が返り途中の行が残らない既存のテスト）
  - コミット: `fix(deliver): plan reads and session starts under the write lock (T04)`
  - 結果: red 実測: 直す前のコードで `node --test --test-name-pattern="concurrent" test/deliver.test.ts` → 3 件とも落ちた（同じ 2 件が 5 回ずつ / 予算の後に 5 件 / 6 回の読み込みで 8846 字）。2 回流して同じ。直した後 → 3 pass を 3 回続けて確認。`node --test test/deliver.test.ts` → 26 pass（ロック中に 1 秒未満で答える既存のテストと、trigger でログを拒んでも本文が返り session 行が残らない既存のテストを含む）。lint・typecheck → 通過

- [x] T08: 境界で agent_id を SQLite が数える長さと同じ文字の範囲に絞る
  - 種別: 修正
  - 計画: S2
  - 依存: T02（agentOf が要る）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - red: `cd server && node --test --test-name-pattern="agent id" test/deliver.test.ts` → 先頭が NUL の agent_id の配信がログに残らず、同じ Read で記録がもう一度出るので落ちる
  - 完了条件: `cd server && node --test --test-name-pattern="agent id" test/deliver.test.ts` → pass。受け付けない agent_id はメインの会話として数えられ、ログに残る
  - コミット: `fix(deliver): accept only agent ids the log can store (T08)`
  - 結果: red 実測: 直す前のコードで `node --test --test-name-pattern="agent id" test/deliver.test.ts` → "the first delivery was logged" で落ちた（NUL で始まる id のログが CHECK で拒まれ、同じ記録が再び出た）。直した後 → `--test-name-pattern="agent id|subagent"` 2 pass。lint・typecheck → 通過

## P3: SubagentStart

サブエージェントの開始時に、作業中の件・広い constraint・検索の 1 行が両ホストで届く。

- [x] T05: SubagentStart で開始の一式と検索の 1 行を配信する
  - 種別: 追加
  - 計画: S4
  - 依存: T02（agent_id 付きでログを書く）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`, `plugin/hooks/hooks.json`, `plugin/hooks/codex.json`, `scripts/check-ai-config.mjs`, `scripts/check-tarball.mjs`
  - 完了条件: `cd server && node --test --test-name-pattern="SubagentStart" test/deliver.test.ts` → pass。`bun run verify:ai` → exit 0（両ホストの配線の検査を含む）
  - コミット: `feat(deliver): give subagents the session-start records and a search line (T05)`
  - 結果: `node --test --test-name-pattern="SubagentStart" test/deliver.test.ts` → 1 pass（作業中の件・広い constraint・検索の 1 行、2 回目の SubagentStart も同じ本文で子の読み込みは区切らない、子の開始の後の親の resume は配信される、ログは sub-1:subagent）。`bun run verify:ai` → 通過。SubagentStart を両方の hook ファイルから一時的に外すと 3 件の違反で落ちることを確かめて戻した。`bun run bundle` と `npm pack` の tarball で `node scripts/check-tarball.mjs` → 通過（SubagentStart に hookEventName SubagentStart で検索の行を返す）。`node --test test/deliver.test.ts` → 28 pass

## P4: 受け入れケースとリリース

受け入れケースで固定し、0.6.17 に揃える。

- [x] T06: 受け入れの driver にホスト・agent_id・event を足し、ケースを足す
  - 種別: 追加
  - 計画: S5
  - 依存: T04（並行と窓の挙動がケースの期待になる）, T05（SubagentStart のケースが要る）
  - 変更: `server/evals/acceptance/driver.ts`, `server/evals/acceptance/cases.json`, `server/test/acceptance-cases.test.ts`
  - 完了条件: `bun run verify` → exit 0（受け入れケースを含む）
  - コミット: `test(acceptance): pin per-agent and compaction delivery cases (T06)`
  - 結果: driver に呼び出しごとの host・agent_id・command（Bash）・subagent_start と each_context の lacks を足し、injection-24〜28 を足した。main の worktree に新しい driver と cases を写して `SPHICA_ACCEPTANCE_LAYER=injection node --test evals/acceptance/run.ts` → 5 件とも落ちた（検索の行が無い / compact・clear の後の Read に記録が無い / Codex の子の後に親へ記録が無い）。このブランチで `bun run acceptance` → 97 pass、`node --test test/acceptance-cases.test.ts` → 4 pass。チェックの直後に `bun run verify` → exit 0（受け入れ 97 pass を含む）

- [x] T09: compact・clear のテストを日付に依存させず、並行の文字数のテストが空の応答で通らないようにする
  - 種別: 変更
  - 計画: S3
  - 依存: T04（直すテストが要る）
  - 変更: `server/test/deliver.test.ts`
  - 完了条件: `cd server && node --test --test-name-pattern="compact|clear|concurrent" test/deliver.test.ts` → pass。開始の配信が作業中の件で必ず本文を持ち、子プロセスが 0 で終わり、文字数のケースが 1000 字より多く届いたことを確かめる
  - コミット: `test(deliver): keep the window test off the clock and the concurrent tests off empty answers (T09)`
  - 結果: 作業中の件を入れて開始の配信が必ず本文を持つようにし、clear の前に作業を done にして本文の無い開始でも区切りの行が書かれることを見る形にした。together() は子プロセスが 0 以外で終わると失敗し、文字数のケースは 1000 字より多く届いたことと unavailable が無いことも見る。`node --test --test-name-pattern="compact|clear|concurrent" test/deliver.test.ts` → 4 pass

- [x] T10: SubagentStart に持ち主向けの trace 待ちの案内を出さない
  - 種別: 修正
  - 計画: S4
  - 依存: T05（SubagentStart の配信が要る）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - red: `cd server && node --test --test-name-pattern="pending notice" test/deliver.test.ts` → agent_id の無い SubagentStart が案内を受け取り、その日の持ち主の SessionStart に案内が出ないので落ちる
  - 完了条件: `cd server && node --test --test-name-pattern="pending notice" test/deliver.test.ts` → pass
  - コミット: `fix(deliver): keep the pending-trace notice for the owner's own session start (T10)`
  - 結果: red 実測: 直す前のコードで `node --test --test-name-pattern="pending notice" test/deliver.test.ts` → agent_id の無い SubagentStart の本文に案内が出て落ちた。直した後 → 1 pass。`node --test test/deliver.test.ts` → 29 pass。lint・typecheck → 通過

- [x] T11: agent_id の無い SubagentStart のログを、親の resume の判定に数えない
  - 種別: 修正
  - 計画: S4
  - 依存: T10（直すテストが要る）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - red: `cd server && node --test --test-name-pattern="pending notice" test/deliver.test.ts` → agent_id の無い SubagentStart の後の親の resume が、開始を出し済みとして飛ばされ、案内が出ないので落ちる
  - 完了条件: `cd server && node --test --test-name-pattern="pending notice" test/deliver.test.ts` → pass
  - コミット: `fix(deliver): do not take a subagent start for the main conversation's on resume (T11)`
  - 結果: red 実測: 親の開始を resume にしたテストが、直す前のコードで "the owner still gets today's pending notice" で落ちた。resume の判定から reason が subagent の行を外した後 → 1 pass。`node --test test/deliver.test.ts` → 29 pass。typecheck → 通過

- [-] T07: release:plan を流し、0.6.17 に揃える
  - 種別: 変更
  - 計画: S6
  - 依存: T06（リリースに入る変更が揃っている）
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run release:plan -- --base v0.6.16` → plugin。4 つのファイルが 0.6.17
  - コミット: `chore(release): 0.6.17 (T07)`

## 記録
- 2026-10-02 / T01・T07 / pre-commit の bundle 検査が、パッケージに入る変更をバージョンを上げずにコミットさせない（前回の PR も最初のタスクで上げていた） / T01 の変更欄に schema.test.ts と 4 つのバージョンのファイルを足し（前: schema・migration・fixture・db-types・sqlite・db-write・migrate.test・db.test）、release:plan と 0.6.17 への更新を T01 でした。T07 は取りやめ（S6 は T01 が担う）
- 2026-10-02 / T04 / 並行のテストは deliver.test.ts の補助関数（save・decided・checkout）を使うので、新しいファイルではなく deliver.test.ts に置いた / 変更欄から server/test/deliver-concurrent.test.ts を外し、red と完了条件のコマンドを deliver.test.ts の --test-name-pattern に変えた（前: node --test test/deliver-concurrent.test.ts と --test-name-pattern="log fail"）。BUSY 以外のログの失敗は既存のテスト（trigger で拒む）が見ている
- 2026-10-02 / T01 / Codex のタスクレビュー: 指摘なし
- 2026-10-02 / T02 / Codex のタスクレビュー F1（P3、再現済み）: 先頭が NUL の agent_id は JS の length が 1 で SQLite の length が 0 になり、CHECK で log が失敗する / 採用。T08 を足した
- 2026-10-02 / T03・T04 / Codex のタスクレビュー F1（P2）: compact・clear のテストは、開始の配信が trace 待ちの案内に左右され 30 日後に落ちる。F2（P2、再現済み）: 並行の文字数のテストは全部の応答が空でも通る / 両方採用。T09 を足した
- 2026-10-02 / T08・T05 / Codex のタスクレビュー F1（P2）: agent_id の無い SubagentStart は isOwnerTurn が真になり得て、持ち主向けの案内を受け取りその日の 1 回を使う / 採用。T10 を足した
- 2026-10-02 / T10 / Codex のタスクレビュー F1（P2）: agent_id の無い SubagentStart のログが親の resume の判定に当たり、持ち主の resume が飛ばされる / 採用。T11 を足した
