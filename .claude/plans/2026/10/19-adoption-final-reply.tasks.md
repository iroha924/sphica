---
kind: tasks
plan: 19-adoption-final-reply.plan.md
branch: fix/adoption-final-reply-355
base: main
---

# #355: trace が、提案が変わった後の最終版への持ち主の返事を採用に引くようにする のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: check の警告

trace の新しい記録で、採用の発言が引いた提案より前なら check と save が警告する。0.6.62 に上げる。

- [ ] T01: 採用が引いた提案より前のときの警告を足し、0.6.62 に上げる
  - 種別: 修正
  - 計画: S1, S2, S4
  - 依存: なし
  - 変更: `server/evals/acceptance/cases.json`, `server/test/acceptance-cases.test.ts`, `server/src/record.ts`, `server/test/record.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - red: acceptance case 2 件と件数（capture 18 → 20）だけを足した状態で `bun run bundle && SPHICA_ACCEPTANCE_LAYER=capture bun run acceptance` → 前の返事を引く case が「check did not report "is older than the proposal it cites"」で落ち、最終版の返事を引く case は通る
  - 完了条件: `bun run verify` → 0 で終わる。`bun run release:plan -- --base bf7e146b` → `plugin`（版を編集する前に流す）
  - コミット: `fix(record): warn when a trace's adoption is older than the proposal it cites (T01)`

## P2: Skill の文面

trace・harvest・glean の Skill が、提案が変わったら最終版への返事を引くと言い、警告への対処を説明する。

- [ ] T02: 3 つの Skill に、最終版への返事を引く規則と警告への対処を足す
  - 種別: 修正
  - 計画: S3
  - 依存: T01（文面が名指す警告の文言が要る）
  - 変更: `plugin/skills/trace/SKILL.md`, `plugin/skills/harvest/SKILL.md`, `plugin/skills/glean/SKILL.md`
  - red: `rg -c "final version" plugin/skills/trace/SKILL.md plugin/skills/harvest/SKILL.md plugin/skills/glean/SKILL.md` → どれにも当たらない（今の文面は、提案が変わったときにどの返事を引くかを言わない）
  - 完了条件: 同じ `rg` → 3 ファイルすべてに当たる。`bun run verify` → 0 で終わる
  - コミット: `docs(skills): quote the reply to the final proposal as the adoption (T02)`

## 記録
