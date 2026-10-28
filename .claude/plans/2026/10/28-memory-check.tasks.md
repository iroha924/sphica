---
kind: tasks
plan: 28-memory-check.plan.md
branch: feat/216-memory-check
base: main
---

# Add a user-invoked memory-check Skill that lists memory and instruction lines going against live records (#216) のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: Skill

Bash を外したファイルツールの実測に合わせて Skill を書き、書き込みツールの外し漏れを機械で止める。

- [x] T01: ファイルツールの実測と memory-check Skill
  - 種別: 追加
  - 計画: S1, S2, S8
  - 依存: なし
  - 変更: `.claude/plans/2026/10/28-memory-check.plan.md`, `plugin/skills/memory-check/SKILL.md`, `plugin/skills/memory-check/agents/openai.yaml`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `pane/.claude-plugin/plugin.json`
  - 完了条件: `mise exec -- bun run verify:ai` → 終了コード 0。実測の結果が plan の「前提」にあり、Skill の上限と読む場所の記述がそれと合う。`bun run release:plan -- --base v0.6.68` → `plugin`、VERSION_SOURCES がすべて 0.6.69
  - コミット: `feat(skills): add memory-check to list memory lines against live records (T01)`
  - 結果: `claude -p` でプロジェクトの Skill を 4 回流して実測（plan の前提に記載）。`mise exec -- bun run verify:ai` → 0。`bun run release:plan -- --base v0.6.68` → `plugin`、npm / plugin / marketplace / Codex / pane / pane ref がすべて 0.6.69。`mise exec -- bun run verify` → 0（151 pass）。review-shipping: 指摘 1 件（ツールの除外は次のメッセージで解ける）を本文に反映

- [x] T02: record サーバーのツールが disallowed-tools から漏れたら落とす
  - 種別: 追加
  - 計画: S3
  - 依存: T01（検査する Skill の frontmatter が要る）
  - 変更: `scripts/check-ai-config.mjs`
  - 完了条件: `mise exec -- bun run verify:ai` → 終了コード 0。Skill の `disallowed-tools` から record サーバーのツールを 1 つ消すと、そのツール名を挙げて落ちる
  - コミット: `test(ai-config): fail when memory-check leaves a record tool available (T02)`
  - 結果: `node scripts/check-ai-config.mjs` → 0。`record_more` を消すと「disallowed-tools removes record tools but not mcp__plugin_sphica_record__record_more」で落ちた。YAML のリストで書いても 0（両ホストともリストを受け付ける）

## P2: 評価

固定ケースを両ホストで各 3 回流し、結果をリポジトリに残す。

- [ ] T03: Claude の plugin eval ケース 1〜7
  - 種別: 追加
  - 計画: S4
  - 依存: T01（流す Skill が要る）
  - 変更: `server/evals/plugin/cases/memory-check-*/`, `server/evals/memory-check/claude-runs.json`
  - 完了条件: `bun run eval:plugin` → memory-check の各ケースを 3 回流し、plan の A2 の期待をすべて満たす。結果が `server/evals/memory-check/claude-runs.json` にある
  - コミット: `test(evals): add memory-check plugin eval cases and Claude runs (T03)`

- [ ] T04: Codex を使い捨ての CODEX_HOME で流す手順と、その実行
  - 種別: 追加
  - 計画: S5
  - 依存: T03（同じケースの scaffold とメモリのファイルを使う）
  - 変更: `server/evals/memory-check/codex.ts`, `server/evals/memory-check/codex-runs.json`
  - 完了条件: `node server/evals/memory-check/codex.ts --runs 3` → plan の A3 の期待を満たす。結果が `server/evals/memory-check/codex-runs.json` にある
  - コミット: `test(evals): run memory-check cases on Codex in a throwaway home (T04)`

- [x] T05: README の段落
  - 種別: 追加
  - 計画: S6
  - 依存: T01（書くホストの違いが実測で決まる）
  - 変更: `README.md`, `README.ja.md`
  - 完了条件: `mise exec -- bun run verify:ai` → 終了コード 0（Markdown の構造とリンク）。両 README に、ホストのメモリとの関係、`memories.disable_on_external_context` の意味、ホストの違いの 3 点がある
  - コミット: `docs(readme): describe memory-check and how Sphica relates to host memories (T05)`
  - 結果: `node scripts/check-ai-config.mjs` → 0、`node scripts/check-links.mjs` → 62 ファイルのリンクがすべて解決。両 README の「できること」に機能と `memories.disable_on_external_context` の意味、「まだできないこと」にホストの違いを 1 行ずつ足した

## P3: 試行と採否

同じ PR head で持ち主が両ホストで試し、結果を残して採否を決める。

- [ ] T06: 持ち主の試行の記録
  - 種別: 追加
  - 計画: S7
  - 依存: T02（試す head に検査が入っている）, T04（両ホストの固定ケースが通っている）, T05（試す head を揃える）
  - 変更: `server/evals/memory-check/trial.json`
  - 完了条件: `node -e "JSON.parse(require('fs').readFileSync('server/evals/memory-check/trial.json','utf8'))"` → 終了コード 0。その中に、両ホストの flag ごとの判定（新しく知ったもの / 既知、正しい / 誤り / 判断保留）、10 単位の抜き取り、重複、失敗、所要時間、ツールの呼び出し回数がある。#216 へのコメントの文面を持ち主が承認している
  - コミット: `test(evals): record the owner's memory-check trial (T06)`

## 記録
2026-10-28 / T01, T02 / 検査が Skill の本文全体から MCP ツール名を拾うので、disallowed-tools に並べた record のツールが allowed-tools に無いとして落ちた / T02 の検査の変更を T01 と同じコミットに入れた（件名は T01, T02）
