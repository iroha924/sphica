---
kind: tasks
plan: 30-issue-237-migrate-failure-message.plan.md
branch: fix/issue-237-migrate-failure-message
base: main
---

# #237: 移行ステップが commit されていない失敗では、バックアップへ戻す案内を出さず、その実行のバックアップを消す のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 失敗の案内を分け、0.6.14 として出せる状態にする

移行が始まらなかった失敗で復元手順が出なくなり、その実行のバックアップが残らなくなる。パッケージに入る変更なので、同じコミットでバージョンを上げる。

- [x] T01: `migrate()` の失敗の文面を 3 分岐にし、commit されていないときはその実行のバックアップを消す
  - 種別: 修正
  - 計画: S1, S2
  - 依存: なし
  - 変更: `server/src/admin.ts`, `server/test/admin.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - red: `cd server && node --test --test-timeout=60000 test/admin.test.ts` → ロックのテスト（CLI）は出力に `To go back to it` が出てバックアップが 1 つ増えて落ち、スクリプトが無いテストは `Move the database aside` と復元手順が出て落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/admin.test.ts` → ロックのテスト（CLI）、スクリプトが無いテスト、1 ステップ commit 後のテスト（`is now at revision 2`）が通る。`bun run verify` → 0。`bun run release:plan -- --base v0.6.13` → `plugin`、4 か所とも 0.6.14
  - コミット: `fix(init): do not tell the owner to restore a backup when no migration step was committed (T01)`
  - 結果: `cd server && node --test --test-timeout=60000 test/admin.test.ts` → 直す前は 3 本が落ちた（red: ロックのテストは出力に `To go back to it` が出て `No migration step was committed` が無い / スクリプトが無いテストは `No migration from revision 1. Move the database aside` が出る / 1 ステップ commit 後のテストは `is now at revision 2` が無い）。直した後は 30 pass・0 fail、ロックのテストは 5.6 秒。`bun run verify` → exit 0。`bun run release:plan -- --base v0.6.13` → plugin、4 か所とも 0.6.14。`bun run bundle && cd plugin && node ../scripts/check-tarball.mjs "$(npm pack --silent)"` → exit 0

## 記録

- 2026-09-30 / T01 / review-shipping（コミット前）の指摘は 1 件: `prune()` のコメントが「失敗した実行は 1 つも消さない」のままで、今は自分のバックアップを消す / 採用。同じコミットで「古いものは消さない」に直した
- 2026-09-30 / T01 / Codex のレビュー（5ddc0d9、新しい会話。全差分 `main..5ddc0d9` も同じ範囲）は指摘 0 件。Codex はテスト・verify を流していない（read-only）。release:plan は Codex の環境では GitHub の設定を読めず exit 1 / 直しなし。テスト・verify・release:plan は Claude が流して結果欄のとおり
