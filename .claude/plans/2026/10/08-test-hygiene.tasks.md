---
kind: tasks
plan: 08-test-hygiene.plan.md
branch: fix/test-hygiene
base: main
---

# チェックの失敗の出力を捨てず、テストの一時ディレクトリの残骸を作らせない（#299、#300） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 失敗の出力を最後まで出す

テストやチェックが落ちたとき、失敗したテストの名前と詳細が切れずに出る。

- [ ] T01: テストの起動・残骸の検査・後片付けを `scripts/lib/test-run.mjs` に切り出し、sql:reach から使う。失敗は出力してから exitCode = 1 で return し、maxBuffer と r.error・r.signal を出す
  - 種別: 修正
  - 計画: S1, S2
  - 依存: なし
  - 変更: `scripts/lib/test-run.mjs`, `scripts/lib/test-run.d.mts`, `scripts/check-sql-reach.mjs`, `server/test/test-run.test.ts`
  - red: `cd server && node --test test/test-run.test.ts` → 偽の bun が 200 KB の stdout と stderr を出して失敗すると、本物の check-sql-reach.mjs の出力の末尾が届かずに落ちる
  - 完了条件: `cd server && node --test test/test-run.test.ts` → pass（漏れなし、漏れあり、失敗と漏れ、出力の上限、後片付け、偽の bun での出力の末尾）
  - コミット: `fix(scripts): keep a failed test run's whole output and check its temp directory`

- [ ] T02: sql:live と hooks:live の失敗の経路を、出力してから exitCode = 1 で return する形にする
  - 種別: 修正
  - 計画: S1
  - 依存: なし
  - 変更: `scripts/check-sql-live.mjs`, `scripts/check-hooks-live.mjs`
  - red: `rg -n "process\.exit\(1\)" scripts/check-sql-live.mjs scripts/check-hooks-live.mjs` → 出力の直後の process.exit(1) がある
  - 完了条件: 同じ rg → 0 件、`bun run sql:live` と `bun run hooks:live` → 通る
  - コミット: `fix(scripts): let the live checks finish their output and cleanup before failing`

## P2: テストに残骸を作らせない

テストの実行が一時ディレクトリに何も残さない。

- [ ] T03: 一時ディレクトリを残すテストを、作成の直後に削除を登録する形に直し、子の環境を組み直すテストに TMPDIR・TMP・TEMP を渡す
  - 種別: 修正
  - 計画: S3
  - 依存: T01（残骸の検査で、直したことを確かめる）
  - 変更: `server/test/admin.test.ts`, `server/test/file-lock.test.ts`, `server/test/assets.test.ts`, `server/test/fake-gh.ts`, `server/test/fake-codex.ts`, `server/test/plugin.test.ts`, `server/test/extract.test.ts`, `server/test/cli.test.ts`
  - red: `bun run sql:reach` → 実行用の TMPDIR に残骸が残り、名前つきで落ちる
  - 完了条件: `bun run sql:reach` → 残骸 0 で通る、`bun run verify` → 0
  - コミット: `fix(test): remove every temp directory a test makes`

## 記録
