---
kind: tasks
plan: 02-issue-203-project-key.plan.md
branch: fix/issue-203-project-key
base: main
---

# Normalize project keys (the last item of #203) with schema revision 8, released as 0.6.21 のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: key の正規化と schema revision 8

大文字小文字だけが違う remote から同じ key が出て、既存の DB は revision 8 で正規の key にそろい、正規でない key は書けなくなる。

- [x] T01: remote の host を全形式で、github.com の path も ASCII で小文字にし、`normalizeKey` と `legacyKey` を足す
  - 種別: 修正
  - 計画: S1, S6
  - 依存: なし
  - 変更: `server/src/project.ts`, `server/test/project.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - red: `cd server && node --test test/project.test.ts` → `git@GitHub.COM:O/R.git` と `ssh://git@GitHub.COM/O/R.git` が `github.com/o/r` にならず落ちる
  - 完了条件: `cd server && node --test test/project.test.ts` → pass（scp・ssh・git・https の混ざった大文字が `git:github.com/o/r`、github.com 以外の path の大文字は残る、`local:` は変わらない、host だけの key、`normalizeKey` が冪等、`identify()` が `legacyKey` に今の規則の key を返す）
  - コミット: `fix(project): lowercase remote hosts and github.com paths in project keys (T01)`
  - 結果: red: `node --test --test-name-pattern="differing only in case|earlier rule" test/zz-red.tmp.test.ts` → （normalizeKey を恒等関数に差し替えた一時コピーで）`git@GitHub.COM:O/R.git` が `GitHub.COM/O/R`、identify の key が `git:GitHub.COM/O/R` で fail
  - 結果: `cd server && node --test test/project.test.ts` → 13 pass。`tsc --noEmit` → エラーなし
  - 結果: `bun run release:plan -- --base v0.6.20` → plugin。npm と 3 つの manifest を 0.6.21 にした

- [x] T02: schema revision 8（正規でない key を拒む trigger、空の重複をまとめるマイグレーション、中身のある衝突で止める check）
  - 種別: 追加
  - 計画: S2
  - 依存: T01（JS と SQL の正規化が同じ結果になるテストに `normalizeKey` が要る）
  - 変更: `db/schema.sql`, `db/migrations/0008.sql`, `db/migrations/0008.check.sql`, `server/src/sqlite.ts`, `server/test/migrate.test.ts`, `server/test/project.test.ts`, `server/test/schema.test.ts`, `server/test/fixtures/schema-rev7.sql`
  - 完了条件: `cd server && node --test test/migrate.test.ts test/project.test.ts` → pass（衝突なしの改名で id・created_at・sqlite_sequence が残る、空の重複が消える、中身のある 2 つの衝突で revision 7 のまま止まる、revision 8 の定義が新しい DB と一致、trigger が正規でない key の insert / update を拒む、JS と SQL の parity が Unicode を含めて一致）
  - コミット: `feat(db): enforce normalized project keys in schema revision 8 (T02)`
  - 結果: `cd server && node --test test/migrate.test.ts test/project.test.ts` → 53 pass（revision 7 の改名・空の重複の削除・最古を残す・中身のある衝突で 7 のまま止まる・trigger の拒否・parity。revision 7 の定義比較と capture view の列比較も pass）
  - 結果: `bun run verify` → 0 で終わる

- [x] T03: マイグレーションが止まったときの文面を rule ごとにし、project の衝突には前のリリースを使い続けて issue で知らせる案内を出す
  - 種別: 変更
  - 計画: S3
  - 依存: T02（文面を出す rule が 0008.check.sql にある）
  - 変更: `server/src/admin.ts`, `server/test/migrate.test.ts`
  - 完了条件: `cd server && node --test --test-name-pattern="revision 8" test/migrate.test.ts` → pass（衝突の停止で「revision 8 は当てていない」と案内が出て、forget を勧めず、commit 済みの revision とバックアップの既存の報告は変わらない。0005 の rule の文面は今のまま）
  - コミット: `feat(migrate): explain a project key collision that stops revision 8 (T03)`
  - 結果: `cd server && node --test --test-name-pattern="revision 4 stops|revision 7|revision 8" test/migrate.test.ts` → 8 pass（衝突の停止が「Revision 8 was not applied」で始まり、0.6.20 の案内と「Forgetting sources does not resolve it」を含み、汎用の文面を含まず、「still at revision 7」の既存の報告が続く。revision 4 の停止の文面は今のまま）

## P2: capture と key の利用者

spool の記録が、マイグレーションの前後どちらでも正しい project に入り、init・MCP・localRoots が正規の key で引く。

- [ ] T04: spool に legacyKey を書き、送るときに書き込みのトランザクションの中で完全一致 → 正規化の順で project を引く
  - 種別: 変更
  - 計画: S4
  - 依存: T01（`legacyKey` と `normalizeKey` が要る）, T02（マイグレーションを挟むテストに revision 8 が要る）
  - 変更: `server/src/capture.ts`, `server/test/capture.test.ts`
  - 完了条件: `cd server && node --test --test-name-pattern="legacy key" test/capture.test.ts` → pass（revision 7 の空の正規の project 1 と中身のある大文字の project 2 で、新しい hook の記録が 2 に入る。マイグレーション後も 2。引いた後にマイグレーションを挟んでも 2 に入り rejected/ が空。どこにも無い key は unregistered/ に残る）
  - コミット: `fix(capture): route spooled records by their legacy key inside the write transaction (T04)`

- [ ] T05: init・MCP の検索・localRoots を大文字小文字の混ざった remote で確かめるテストを足す
  - 種別: 追加
  - 計画: S5
  - 依存: T01（正規化した key が要る）
  - 変更: `server/test/cli.test.ts`, `server/test/project.test.ts`
  - 完了条件: `cd server && node --test test/cli.test.ts test/project.test.ts` → pass（`git@GitHub.com:O/R.git` の remote で init が `git:github.com/o/r` を登録し、MCP の project の検索が同じ id を返す。大文字だけが違う 2 つのディレクトリを localRoots が ambiguous にする）
  - コミット: `test(project): cover init, MCP lookup, and localRoots with a mixed-case remote (T05)`

## P3: リリースの準備

npm と 3 つの manifest が 0.6.21 にそろう。

- [-] T06: release:plan で区分を確かめ、npm と 3 つの manifest を 0.6.21 にする
  - 種別: 変更
  - 計画: S6
  - 依存: T04（package に入る変更が全部入ってから区分を測る）
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run release:plan -- --base v0.6.20` → plugin。4 つのファイルが 0.6.21。`bun run verify` → 0 で終わる
  - コミット: `chore(release): bump to 0.6.21 (T06)`

## 記録

- 2026-10-02 / T01 / pre-commit の bundle 検査が、package の入力を変えるコミットにバージョンの更新を求めて止めた / T01 の計画を S1 → S1, S6、変更に 4 つのバージョンのファイルを足した。T06 は S6 が T01 に移ったので取りやめ
- 2026-10-02 / T02 / revision の値を固定で見る `server/test/schema.test.ts` と、revision 7 の fixture が要った / T02 の変更欄に `server/test/schema.test.ts`, `server/test/fixtures/schema-rev7.sql` を足した
- 2026-10-02 / T01 / Codex のタスクレビュー（c3ae3eed）は指摘なし。sandbox で一時ディレクトリを作れずテストの一部は Codex 側で未実行 / 同じテストを手元で流し 13 pass を確認済み
