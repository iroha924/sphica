---
kind: tasks
plan: 30-issue-201-migration-safety.plan.md
branch: fix/issue-201-migration-safety
base: main
---

# #201: 移行の前にバックアップを取り、plugin 更新後の案内と schema・索引の検査を固める のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 移行の前のバックアップ

移行が途中で失敗しても、検査済みのバックアップから移行前の DB に戻せる。

- [x] T01: 移行の前に検査済みのバックアップを取り、戻し方を出し、成功後に刈り込む
  - 種別: 修正
  - 計画: S1
  - 依存: なし
  - 変更: `server/src/admin.ts`, `server/test/admin.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - red: `cd server && node --test --test-timeout=60000 test/admin.test.ts` → 失敗する移行を差し込んだ rev1 の DB の移行の後に、revision 1 のバックアップが見つからず落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/migrate.test.ts test/admin.test.ts` → バックアップが revision 1・元の行数（WAL にだけあった行を含む）で開け、戻し方どおりに置き換えると元の行が読め、成功後は完成品が 3 つに刈り込まれ、他プロセスの `.partial` が残るテストが通る
  - コミット: `fix(init): back up the database before migrating and say how to restore it (T01)`
  - 結果: `cd server && node --test --test-timeout=60000 test/admin.test.ts` → 直す前は新しい 2 本が落ちた（red: 移行ディレクトリの引数が無く失敗する移行が走らない / バックアップが無い）。直した後は 25 pass・0 fail。`bun run verify` → exit 0。`bun run release:plan -- --base v0.6.11` → plugin、4 か所とも 0.6.12

- [x] T08: T01 のレビュー指摘を直す（今回のバックアップを刈り込まない、消せない古いバックアップで init を落とさない、移行なしのテストを名前で比べる、戻し方にバックアップ後の記録が入らないことを書く）
  - 種別: 修正
  - 計画: S1
  - 依存: T01（直す対象の migrate() と prune() が要る）
  - 変更: `server/src/admin.ts`, `server/test/admin.test.ts`
  - red: `cd server && node --test --test-timeout=60000 --test-name-pattern=backup test/admin.test.ts` → 消せない古いバックアップで ERR_FS_EISDIR が migrate() から漏れて落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/admin.test.ts` → 時計が戻った 3 つの完成品と消せない 1 つがあっても移行が終わり、今回のバックアップが残るテストが通る
  - コミット: `fix(init): keep this run's backup when pruning and never fail init over an old one (T08)`
  - 結果: `cd server && node --test --test-timeout=60000 --test-name-pattern=backup test/admin.test.ts` → 直す前は新しいテストが ERR_FS_EISDIR で落ちた（red）。直した後 `node --test test/admin.test.ts` → 26 pass・0 fail。`bun run verify` → exit 0

## P2: 持ち主への案内

forget の画面でバックアップの場所が分かり、revision の不一致では入れるべき CLI の版が 1 回届く。

- [x] T02: forget の preview・確認・完了にバックアップの場所と件数を出す
  - 種別: 追加
  - 計画: S2
  - 依存: T01（バックアップの置き場所と名前の規則が要る）
  - 変更: `server/src/backups.ts`, `server/src/forget.ts`, `server/src/mcp-record.ts`, `server/src/admin.ts`, `server/test/forget.test.ts`, `plugin/skills/forget/SKILL.md`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/forget.test.ts` → バックアップが 2 つある場合に preview・確認文面・完了の返答に場所と件数が出て、0 のときは出ないテストが通る
  - コミット: `feat(forget): show where Sphica's backups are before and after forgetting (T02)`
  - 結果: `cd server && node --test --test-timeout=60000 test/forget.test.ts` → 16 pass・0 fail（新しいテストは 2 つの完成品と 1 つの .partial で「2 backups」を出し、0 のとき backup を言わない）。`bun run verify` → exit 0

- [x] T09: T02 のレビュー指摘を直す（MCP の preview・確認・完了の 3 か所にバックアップの案内が出ることをテストで見る）
  - 種別: 追加
  - 計画: S2
  - 依存: T02（案内を出す forgetText の呼び出しが要る）
  - 変更: `server/test/plugin.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 --test-name-pattern="forget_apply removes" test/plugin.test.ts` → forget_preview の返答・elicitation の文面・forget_apply の返答に「1 backup made before migrating, in <dir>」が入って通る
  - コミット: `test(forget): check the backup notice through the record server (T09)`
  - 結果: `cd server && node --test --test-timeout=60000 --test-name-pattern="forget_apply removes" test/plugin.test.ts` → 1 pass・0 fail

- [x] T03: 不一致の案内に CLI の版を入れ、delivery は別の 1 回印で prompt でも返す
  - 種別: 修正
  - 計画: S3
  - 依存: なし
  - 変更: `server/src/sqlite.ts`, `server/src/deliver.ts`, `server/test/deliver.test.ts`, `server/test/db.test.ts`, `server/test/admin.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/deliver.test.ts` → 一般の障害警告を出した同じセッションで、rev3 の DB に対する SessionStart と prompt が案内を返さず、案内に `sphica@<version>` が無くて落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/deliver.test.ts test/db.test.ts test/admin.test.ts` → 版入りの案内が SessionStart と prompt で 1 回ずつ返り、shell では返らないテストが通る
  - コミット: `fix(deliver): name the CLI version to install when the database revision differs (T03)`
  - 結果: `cd server && node --test --test-timeout=60000 --test-name-pattern="another revision" test/deliver.test.ts` → 直す前は、先に別の警告を出したセッションの SessionStart が空を返して落ちた（red）。直した後 `node --test test/deliver.test.ts test/db.test.ts test/admin.test.ts` → 60 pass・0 fail。`bun run verify` → exit 0

## P3: schema と索引の検査

capture ビューの列の変化と `terms()` の出力の変化がテストで落ちる。

- [x] T04: 4 つの capture ビューの列を全 fixture と比べ、fixture のそろいを検査する
  - 種別: 追加
  - 計画: S4
  - 依存: なし
  - 変更: `server/test/migrate.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/migrate.test.ts` → 4 つのビューについて rev1..3 と現在を比べるテストが通り、一時的にビューの列を 1 つ変えると落ちる（手で確かめて戻す）
  - コミット: `test(schema): compare every capture view's columns across all revisions (T04)`
  - 結果: `cd server && node --test --test-timeout=60000 test/migrate.test.ts` → 12 pass・0 fail。schema.sql の capture_edit から via を一時的に外すと `--test-name-pattern="every capture view"` が 3 fail（戻した）。`bun run verify` → exit 0

- [x] T05: terms() の golden、reindex の SQL の定数化、規範の文の置き換え
  - 種別: 追加
  - 計画: S5
  - 依存: なし
  - 変更: `server/test/fixtures/terms-golden.json`, `server/test/terms-golden.test.ts`, `server/src/admin.ts`, `server/src/text.ts`, `.agents/skills/knowledge-schema/SKILL.md`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/terms-golden.test.ts` → 通り、`terms()` の規則を一時的に変えると revision と移行を求めるメッセージで落ちる（手で確かめて戻す）。`rg -n "doctor --reindex" server/src .claude/skills` → terms() の変更時の手順として書いた箇所が無い
  - コミット: `test(search): pin terms() output and rebuild the index through a migration (T05)`
  - 結果: `cd server && node --test test/terms-golden.test.ts` → 1 pass（54 入力）。MAX_TERM を一時的に 10 にすると 1 fail で revision と移行を求めるメッセージが出た（戻した）。Node 24.15（ICU 78.2）と 26.10（ICU 78.3）で golden の出力は同じ。`rg -n "doctor --reindex" server/src .claude/skills` → 残るのは doctor の壊れた索引の案内・コマンド定義・knowledge-schema の Writers 表だけ。`bun run verify` → exit 0

## P4: 配布物の確認と版

npm pack した配布物で案内・バックアップ・移行が通しで動き、版がそろう。

- [ ] T06: sql:live に tarball の deliver.js と cli.js を rev3 の DB に流す検査を足す
  - 種別: 追加
  - 計画: S6
  - 依存: T01（`Backed up:` の出力が要る）, T03（版入りの案内が要る）
  - 変更: `scripts/check-sql-live.mjs`
  - 完了条件: `bun run sql:live` → tarball の deliver.js が rev3 の DB に版入りの案内を返し、cli.js の init が `Backed up:` と `Migrated: … (revision 3 → 4)` を出し、バックアップが revision 3 で開ける
  - コミット: `test(live): run the packed hooks and CLI against an older database (T06)`

- [-] T07: 版を 0.6.12 にそろえる
  - 種別: 変更
  - 計画: S6
  - 依存: なし
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run release:plan -- --base v0.6.11` → `plugin`。`bun run verify` → 0 で終わる
  - コミット: `chore(release): bump to 0.6.12 (T07)`

## 記録

- 2026-09-30 / T01 / 実物の migrate() を通すテストは admin.test.ts にあり、migrate.test.ts は SQL を自前の手順で流す / 変更欄と red を migrate.test.ts から admin.test.ts に変えた（前: `server/src/admin.ts`, `server/test/migrate.test.ts`、後: `server/src/admin.ts`, `server/test/admin.test.ts` と版の 4 ファイル）
- 2026-09-30 / T01, T07 / pre-commit の bundle の検査が、パッケージの入力を変えるコミットに版の更新を同じコミットで求めた（#208 の T01 も同じ形） / 版の 4 ファイルを T01 に入れ、T07 は取りやめ。S6 の版の更新は T01 が担う
- 2026-09-30 / T02 / backups() を admin.ts から forget.ts が読むと、記録サーバーの bundle に CLI の部品（cli/view.ts）が入る / バックアップの場所の関数を server/src/backups.ts に分け、forget の Skill の「残るもの」も直した。変更欄（前: `server/src/forget.ts`, `server/src/mcp-record.ts`, `server/src/admin.ts`, `server/test/forget.test.ts`、後: それに `server/src/backups.ts` と `plugin/skills/forget/SKILL.md` を足した）
- 2026-09-30 / T01 レビュー / Codex の F1〜F4: F2（時計が戻ると今回のバックアップを刈り込む）・F3（消せない古いバックアップで移行済みの init が落ちる）・F4（移行なしのテストが件数だけ比べる）は直す。F1（バックアップ後・最初の移行前に capture が書いた行は戻すと消える）は、戻す以上バックアップ後の記録は失われるので防げない。エラーの戻し方に「バックアップの後の記録は入っていない」と書いて扱う / T08 を足した
- 2026-09-30 / T02 レビュー / Codex の F1（バックアップと同じ名前のディレクトリを 1 件と数える）は、手で置かない限り起きない入力なので直さない。F2（テストが MCP の 3 か所を通らず空振りする）は直す / T09 を足した
- 2026-09-30 / T05 / plan 方針 5 の「reindex() の SQL を定数にして export する」は、使う側がテストにも移行にも無く、未使用の export になる（knip が落とす）。2 重に持たないための策は、棄却した C9 (b) の検査のためだった / 定数化はせず、テストの失敗メッセージと規範の文で reindex() を写す元として名指しした。world.json の 2000 文字を超える 3 本（同じ繰り返しの詰め物）は golden から外した
- 2026-09-30 / T05 / `.claude/skills/knowledge-schema` は `.agents/skills/knowledge-schema` へのシンボリックリンクだった / 変更欄を実体のパスに変えた（前: `.claude/skills/knowledge-schema/SKILL.md`、後: `.agents/skills/knowledge-schema/SKILL.md`）
