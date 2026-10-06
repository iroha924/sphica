---
kind: tasks
plan: 06-f6-harvest-sources.plan.md
branch: fix/f6-harvest-sources
base: main
---

# harvest の実行が見る source を開始時のまま固定し、消された本文を空の版として残し、doctor の ~/Projects 探索をやめる（#264 + doctor） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: harvest の範囲と消された本文（#264）

別の harvest が割り込んでも実行中の範囲が変わらず、空にされた本文が今の版になる。

- [ ] T01: revision 11 で harvest_run_source を足し、走っている途中の harvest を移行で消す
  - 種別: 追加
  - 計画: S1, S5
  - 依存: なし
  - 変更: `db/schema.sql`, `db/migrations/0011.sql`, `server/src/sqlite.ts`, `server/src/db-types.ts`, `server/src/db-write.ts`, `server/test/fixtures/schema-rev10.sql`, `server/test/migrate.test.ts`, `server/test/schema.test.ts`, `server/test/db.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `cd server && node --test test/migrate.test.ts test/schema.test.ts test/db.test.ts` → pass。移行した DB と新しい DB が一致し、走っている途中の harvest がメモ付きで消え、保存済みの harvest・走っている途中の trace と glean・source・record_call が残る。trigger が別のプロジェクトの source と harvest でない実行を拒む。ingest は insert でき、forget の source の削除で行が消える。`bun run codegen:check` → 差分なし
  - コミット: `feat(schema): keep a harvest run's sources in harvest_run_source (revision 11) (T01)`

- [ ] T02: beginHarvest が範囲を保存し、context・check・save が保存した範囲だけを見る
  - 種別: 修正
  - 計画: S2
  - 依存: T01（harvest_run_source の表が要る）
  - 変更: `server/src/extract.ts`, `server/src/github.ts`, `server/test/extract.test.ts`
  - red: `cd server && node --test --test-name-pattern 'harvest run keeps' test/extract.test.ts` → B がコメントの版 2 を取り込んだ後、A の context に版 1 が無く、A の check が版 1 の引用を範囲外として拒んで fail
  - 完了条件: `cd server && node --test test/extract.test.ts` → pass。A は B の版 2 と、B の本文が閉じる issue の変化の影響を受けない。DB を開き直しても同じ。A の source の forget と B の新しい版の forget が A の範囲から版を外す。B の範囲は B に沿って進む。移行で消えた実行 id の check が「Begin again」を返す
  - コミット: `fix(harvest): keep each run's sources as they were when it began (T02)`

- [ ] T03: 空にされた issue 本文・コメント・review を空の今の版として保存する
  - 種別: 修正
  - 計画: S3
  - 依存: なし
  - 変更: `server/src/github.ts`, `server/test/github.test.ts`
  - red: `cd server && node --test --test-name-pattern 'cleared' test/github.test.ts` → issue コメントを空にした後の harvest で、今の版が前の本文のままで fail
  - 完了条件: `cd server && node --test test/github.test.ts` → pass。5 種類それぞれで今の版が空になり、前の版を read で読める。空のまま取り込み直しても行は増えない。一度も保存されていない空の item は行を作らない
  - コミット: `fix(harvest): record a cleared issue body, comment, or review as an empty revision (T03)`

## P2: doctor と README

doctor と README から ~/Projects の前提が消える。

- [ ] T04: doctor の ~/Projects の探索と表示を消し、README の例と project.ts のコメントを直す
  - 種別: 削除
  - 計画: S4
  - 依存: なし
  - 変更: `server/src/project.ts`, `server/src/cli.ts`, `server/test/cli.test.ts`, `server/test/project.test.ts`, `README.md`, `README.ja.md`
  - 完了条件: `cd server && node --test test/cli.test.ts test/project.test.ts` → pass。子プロセスの `sphica doctor` の Projects 欄に `not found` も `copies` も出ない。`rg -n 'localRoots|projectsDir|~/Projects' server/src README.md README.ja.md plugin` → 一致なし
  - コミット: `refactor(doctor): stop looking for projects under ~/Projects (T04)`

## P3: 片付け

終わった計画ファイルが残らない。

- [ ] T05: 全タスクが終わった計画ファイルを消す
  - 種別: 削除
  - 計画: S6
  - 依存: なし
  - 変更: `.claude/plans/2026/10/03-issue-210-turn-boundaries.plan.md`, `.claude/plans/2026/10/03-issue-210-turn-boundaries.tasks.md`, `.claude/plans/2026/10/03-issue-211-read-workspace.plan.md`, `.claude/plans/2026/10/03-issue-211-read-workspace.tasks.md`, `.claude/plans/2026/10/03-issue-239-eval-loop-findings.plan.md`, `.claude/plans/2026/10/03-issue-239-eval-loop-findings.tasks.md`, `.claude/plans/2026/10/04-agent-adoption.plan.md`, `.claude/plans/2026/10/04-agent-adoption.tasks.md`, `.claude/plans/2026/10/04-issue-206-delivery-experiments.plan.md`, `.claude/plans/2026/10/04-issue-206-delivery-experiments.tasks.md`, `.claude/plans/2026/10/04-issue-206-eval-base.plan.md`, `.claude/plans/2026/10/04-issue-206-eval-base.tasks.md`, `.claude/plans/2026/10/05-f1-windows-hooks.plan.md`, `.claude/plans/2026/10/05-f1-windows-hooks.tasks.md`, `.claude/plans/2026/10/05-f4-capture-recovery.plan.md`, `.claude/plans/2026/10/05-f4-capture-recovery.tasks.md`, `.claude/plans/2026/10/05-f5-bounded-mcp.plan.md`, `.claude/plans/2026/10/05-f5-bounded-mcp.tasks.md`, `.claude/plans/2026/10/05-markdown-checks.plan.md`, `.claude/plans/2026/10/05-markdown-checks.tasks.md`
  - 完了条件: `git ls-files .claude/plans` → 06-f6-harvest-sources の 2 つだけ。`bun run verify:ai` → 終了コード 0
  - コミット: `chore(plans): remove finished plans (T05)`

## 記録
