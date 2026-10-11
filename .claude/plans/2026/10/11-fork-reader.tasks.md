---
kind: tasks
plan: 11-fork-reader.plan.md
branch: chore/fork-reader
base: main
---

# fork の PR の文章を、承認の前は読む道具しか持たないエージェントに読ませ、持ち込むコマンドを設定で断る のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 設定と読み手を置く

`gh pr checkout` とその別名を設定が断り、読む道具しか持たない `fork-reader` が使えるようになる。どちらも、形が崩れると検査が落ちる。

- [ ] T01: `.claude/settings.json` に deny の 3 行を置き、その形を検査する
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `.claude/settings.json`, `scripts/lib/fork-intake.mjs`, `scripts/lib/fork-intake.d.mts`, `scripts/check-ai-config.mjs`, `server/test/fork-intake.test.ts`
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `chore(agents): deny gh pr checkout and its aliases in the project settings`

- [ ] T02: 読む道具しか持たないエージェント `fork-reader` を置き、その frontmatter を検査する
  - 種別: 追加
  - 計画: S2
  - 依存: T01（検査の関数とテストを足す先の `scripts/lib/fork-intake.mjs` と `server/test/fork-intake.test.ts` が要る）
  - 変更: `.claude/agents/fork-reader.md`, `scripts/lib/fork-intake.mjs`, `scripts/lib/fork-intake.d.mts`, `scripts/check-ai-config.mjs`, `server/test/fork-intake.test.ts`
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `chore(agents): add a fork-reader agent that holds only read tools`

## P2: 受け入れの手順を新しい形にする

`fork-pr` Skill が、承認の前の読み取りを `fork-reader` に渡し、Codex を外へつながる道具なしで起動する手順になる。

- [ ] T03: `fork-pr` Skill と `CLAUDE.md` を書き直し、Codex のコマンドのブロックを検査する
  - 種別: 変更
  - 計画: S3, S4
  - 依存: T02（Skill が名指しする `fork-reader` の定義と、検査を足す先のファイルが要る）
  - 変更: `.claude/skills/fork-pr/SKILL.md`, `CLAUDE.md`, `scripts/lib/fork-intake.mjs`, `scripts/lib/fork-intake.d.mts`, `scripts/check-ai-config.mjs`, `server/test/fork-intake.test.ts`
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `docs(fork-pr): hand fork text to the reader and start Codex without outside tools`

## 記録
