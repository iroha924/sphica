---
kind: tasks
plan: 14-revision-recheck.plan.md
branch: fix/revision-recheck-342
base: main
---

# ingest と forget の接続は、開いた後に DB の revision が変わっていたら書き込みを拒否する（#342）のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 書き込みをトランザクションに寄せる

ingest と forget の接続の書き込みが、全部 `begin immediate` で始まるトランザクションの中で起きるようになる（挙動は変わらない）。

- [ ] T01: トランザクションの外の書き込みを `inTransaction` に入れ、バージョンを上げる
  - 種別: 変更
  - 計画: S3, S5
  - 依存: なし
  - 変更: `server/src/trace.ts`, `server/src/extract.ts`, `server/src/cli.ts`, `server/src/forget.ts`, `plugin/package.json`, `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`
  - 完了条件: `bun run release:plan -- --base 94196c67` → plugin。`bun run test` → 全件通る
  - コミット: `refactor(record): write the call log, runs, project registration, and forget's cleanup in transactions`

## P2: revision の検査

開いた後に revision が変わった ingest / forget の接続が書き込みを拒否する。

- [ ] T02: ingest と forget の接続に、検査付きの begin と、検査済みでない書き込みを拒否する authorizer を入れる
  - 種別: 修正
  - 計画: S1, S2
  - 依存: T01（トランザクションの外の書き込みが残っていると、authorizer の強制でそれらが拒否されてテストが落ちる）
  - 変更: `server/src/sqlite.ts`, `server/src/db-write.ts`, `server/test/db.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern=revision test/db.test.ts` → ingest と forget の「開いた後の移行」のテストが、書き込みが通ってしまい失敗する
  - 完了条件: 同じコマンド → 通る。`bun run test` → 全件通る
  - コミット: `fix(db): refuse an ingest or forget write when the revision changed after the connection opened`

- [ ] T03: 移行窓・持ち越し・自動 rollback・FTS の正常系・既存の禁止・forget の preview / apply のテストを足す
  - 種別: 追加
  - 計画: S4
  - 依存: T02（検査付き begin と authorizer の `checked` が無いと、拒否を確かめるテストが書けない）
  - 変更: `server/test/db.test.ts`, `server/test/forget.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern=revision test/db.test.ts test/forget.test.ts` → plan の A2〜A9 に当たるテストが全部通る
  - コミット: `test(db): cover the revision check's lock, carry-over, rollback, FTS, and forget paths`

## 記録
