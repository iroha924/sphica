---
kind: tasks
plan: 14-command-dead-ends.plan.md
branch: feat/command-dead-ends-218
base: main
---

# 行き止まりの記録をコマンドに紐付け、その会話で初めてそのコマンドを流そうとした呼び出しを 1 回だけ止める（#218）のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: コマンドの anchor を保存できる

dead_end にコマンドの anchor を付けて保存・検索・表示できるようになる。配信はまだ変わらない。

- [x] T01: schema revision 14 で unit_command を足し、バージョンを上げる
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `db/schema.sql`, `db/migrations/0014.sql`, `server/test/fixtures/schema-rev13.sql`, `server/src/sqlite.ts`, `server/src/db-write.ts`, `server/src/db-types.ts`, `server/test/schema.test.ts`, `server/test/db.test.ts`, `server/test/migrate.test.ts`, `plugin/package.json`, `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/schema.test.ts test/db.test.ts test/migrate.test.ts` → dead_end 以外への insert・CHECK に合わない command・update・unit がある間の delete・別プロジェクトの run が拒まれ、ingest の接続で insert と FTS の検索が通り、revision 13 から移行した DB と新しい DB の定義が一致する
  - コミット: `feat(db): add command anchors for dead ends in schema revision 14 (T01)`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/schema.test.ts test/db.test.ts test/migrate.test.ts` → pass 148 / fail 0。`bun run verify` → exit 0（受け入れ 142 件 pass）

- [x] T02: record server の commands 欄
  - 種別: 追加
  - 計画: S2
  - 依存: T01（unit_command の表が要る）
  - 変更: `server/src/record.ts`, `server/test/record.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/record.test.ts` → dead_end の commands が正規化して保存され、dead_end 以外・1 語だけ・`-` で始まる・引用符入り・mask で変わる値・6 件以上が problem として拒まれ、拒否の文面に値が出ない
  - コミット: `feat(record): save command anchors on dead ends (T02)`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/record.test.ts test/record-state.test.ts test/record-replies.test.ts` → pass 100 / fail 0。`bun run verify` → exit 0（受け入れ 142 件 pass）

- [ ] T03: read と検索でコマンドの anchor を見せる
  - 種別: 追加
  - 計画: S5
  - 依存: T01（読む unit_command の表が要る）
  - 変更: `server/src/read.ts`, `server/test/read.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/read.test.ts` → read が commands をファイルの Code 欄と分けて出し、search がコマンドの語で記録を見つける
  - コミット: `feat(read): show and search dead ends' command anchors (T03)`

- [x] T04: trace と harvest の Skill に commands と教訓の書き方を足す
  - 種別: 変更
  - 計画: S6
  - 依存: T02（Skill が案内する commands 欄を record server が受けないと保存が拒まれる）
  - 変更: `plugin/skills/trace/SKILL.md`, `plugin/skills/harvest/SKILL.md`
  - 完了条件: `bun run verify:ai` → 0 で終わる
  - コミット: `docs(trace): write dead ends as lessons and anchor them to commands (T04)`
  - 結果: `bun run verify:ai` → exit 0。`bun run verify` → exit 0（T02 と同じコミット）

## P2: 一致したコマンドを 1 回だけ止める

コマンドの anchor に一致した呼び出しを、その会話で 1 回だけ deny する。

- [ ] T05: 行ごと・語ごとの照合の関数
  - 種別: 追加
  - 計画: S3
  - 依存: なし
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/deliver.test.ts` → `pnpm test --watch` が一致し、`pnpm test`・`--watch=false`・`bun testing`・行をまたぐ並び・引用符の付いた語は一致せず、`echo pnpm test --watch` と `echo 'note pnpm test --watch now'` は一致として固定される
  - コミット: `feat(deliver): match command anchors by whole tokens per line (T05)`

- [ ] T06: 止める・知らせる配信と予算、COMMIT の後だけの deny
  - 種別: 追加
  - 計画: S4, S7
  - 依存: T02（commands 付きの記録を作る経路が要る）, T05（照合の関数が要る）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`, `server/test/deliver-codex.test.ts`, `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`, `server/test/acceptance-cases.test.ts`
  - 完了条件: `bun run acceptance` → plan の A3 の観点が全部通る（受け入れケースを先に足し、実装の前に意図した理由で落ちることを確かめてから実装する）
  - コミット: `feat(deliver): stop the first call that repeats a recorded dead end's command (T06)`

## P3: 速さと効果を測る

全件の照合の速さと、anchor の有無での効果を測る。

- [ ] T07: scale の fixture にコマンドの anchor を入れる
  - 種別: 変更
  - 計画: S8
  - 依存: T06（測る配信の経路が要る）
  - 変更: `server/evals/scale/run.ts`
  - 完了条件: `node server/evals/scale/run.ts` → 記録 1 万件でコマンドの照合を含む 1 回が 1 秒以内
  - コミット: `test(scale): measure command anchor matching at 10,000 records (T07)`

- [ ] T08: eval の課題と fixture（anchor あり / なし）
  - 種別: 追加
  - 計画: S9
  - 依存: T04（trace の書き方で作った dead_end を使う）, T06（deny の経路が要る）
  - 変更: `server/evals/cloud/tasks.json`, `server/evals/cloud/fixture.ts`
  - 完了条件: `bun run verify` → 0 で終わり、eval-loop の build で anchor あり・なしの 2 本の slot ができる
  - コミット: `test(eval): add a task whose first command is a recorded dead end (T08)`

## P4: 両ホストで確かめて出す準備

実機で deny の理由が届くかを確かめ、届かないホストは知らせるだけに戻して README に書く。

- [ ] T09: 両ホストの実機の確認と README
  - 種別: 変更
  - 計画: S10, S11
  - 依存: T06（確かめる配信が要る）
  - 変更: `README.md`, `server/src/deliver.ts`
  - 完了条件: `bun run verify` → 0 で終わり、README に deny の振る舞いと（あれば）ホストの差が書いてある
  - コミット: `docs(readme): describe stopping a call that repeats a recorded dead end (T09)`

## 記録
2026-10-14 / T01 / plan の unit_command に retired_at と「live な一意」を書いたが、退役の経路を作らず update も禁じるので列は常に NULL になる / retired_at を置かず、一意は (unit_id, command) にした。退役を足すときに migration で列を足す
2026-10-14 / T02 / extract.ts は check と save の共通の経路のままで変える必要が無かった / 変更欄から `server/src/extract.ts` を外した
2026-10-14 / T02, T04 / `bun run pairs` が、save が受ける欄（commands）を trace の Skill の表が書いていないと落とした / T04 を T02 と同じコミットで終えた
