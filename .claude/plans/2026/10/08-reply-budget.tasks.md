---
kind: tasks
plan: 08-reply-budget.plan.md
branch: fix/reply-budget
base: main
---

# overview live と review_select の応答を 32 KiB に収め、MCP SDK を 1.31.0 に上げる（#289、code scanning #21） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む
## P1: 依存の脆弱性を直す

SDK が脆弱でない 1.31.0 になり、両サーバーが今までどおり動く。

- [ ] T01: @modelcontextprotocol/sdk を 1.31.0 に上げ、lockfile・bundle・notices を確かめる
  - 種別: 修正
  - 計画: S3
  - 依存: なし
  - 変更: `server/package.json`, `server/bun.lock`
  - red: `cd server && bun pm ls 2>/dev/null | grep modelcontextprotocol` → `@modelcontextprotocol/sdk@1.30.0`（脆弱な範囲）
  - 完了条件: 同じコマンド → `@modelcontextprotocol/sdk@1.31.0`。`bun run bundle` の後、`.build/meta-mcp.json` と `.build/meta-mcp-record.json` の inputs に client/auth・jose・pkce-challenge が 0 件。`bun run verify` → 0
  - コミット: `fix(deps): update the MCP SDK to 1.31.0 for CVE-2026-104850`

## P2: 応答を 32 KiB に収める

overview live と review_select のどの応答も、枠込みで READ_BUDGET 以下になる。

- [ ] T02: overview live を、候補の応答全体のバイト数で 1 件ずつ足して切る
  - 種別: 修正
  - 計画: S1
  - 依存: なし
  - 変更: `server/src/overview.ts`, `server/test/overview.test.ts`
  - red: `cd server && node --test --test-name-pattern="live" test/overview.test.ts` → 長いキー・本文・パスの 50 件のページが READ_BUDGET を超えて落ちる
  - 完了条件: `cd server && node --test --test-name-pattern="live" test/overview.test.ts` → pass（予算内、after で全件が 1 回ずつ、グループの並び、最後のページ、境界の前後）
  - コミット: `fix(overview): keep each live page within the reply budget`

- [ ] T03: review_select の理由を構造で持ち、表示のときだけ切り、u<id> と代替の経路で枠込み 32 KiB に収める。review Skill の reviewer を u<id> で読む形にする
  - 種別: 修正
  - 計画: S2
  - 依存: なし
  - 変更: `server/src/review.ts`, `server/src/mcp.ts`, `server/src/deliver.ts`, `server/test/review.test.ts`, `server/test/plugin.test.ts`, `plugin/skills/review/reviewers/precedent.md`
  - red: `cd server && node --test --test-name-pattern="review_select" test/review.test.ts test/plugin.test.ts` → 40 KB の選択肢、日本語の選択肢 50 件、長いキーで、応答が READ_BUDGET を超えて落ちる
  - 完了条件: `cd server && node --test --test-name-pattern="review_select" test/review.test.ts test/plugin.test.ts` → pass（予算内、u<id> だけの経路、配信フックの出力・selection・境界・next が同じ、子プロセスでのバイト数）
  - コミット: `fix(review): keep each review_select reply within the reply budget`

## P3: 出す

- [ ] T04: release:plan を流し、npm と 3 つのマニフェストのバージョンを揃え、npm pack で配布物を確かめる
  - 種別: 変更
  - 計画: S4
  - 依存: T01（パッケージに入る変更）, T02（同）, T03（同）
  - 変更: `package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run release:plan -- --base v0.6.41` → `plugin`。`bun run verify` → 0。npm pack を外で展開して両サーバーが起動する
  - コミット: `chore(release): 0.6.42`

## 記録
