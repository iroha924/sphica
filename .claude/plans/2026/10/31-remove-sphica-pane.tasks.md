---
kind: tasks
plan: 31-remove-sphica-pane.plan.md
branch: chore/remove-sphica-pane
base: main
---

# sphica-pane を出荷物・マーケットプレイス・リポジトリから外す のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: マーケットプレイスとリリースの仕組みから pane を外す

pane のエントリが消えて renames が残り、版をそろえる対象が 4 つになり、0.6.71 に上がる。

- [x] T01: marketplace のエントリを renames に替え、release-scope と pane の検査から pane を外して 0.6.71 に上げる
  - 種別: 変更
  - 計画: S1, S2, S5
  - 依存: なし
  - 変更: `.claude-plugin/marketplace.json`, `scripts/check-ai-config.mjs`, `scripts/lib/release-scope.mjs`, `scripts/lib/release-scope.d.mts`, `scripts/release-plan.mjs`, `scripts/release-status.mjs`, `server/test/release-scope.test.ts`, `server/test/release-plan.test.ts`, `server/test/check-mcp-version.test.ts`, `scripts/check-pane.mjs`, `scripts/lib/pane-report.mjs`, `scripts/lib/pane-report.d.mts`, `server/test/pane-report.test.ts`, `package.json`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`
  - 完了条件: `bun run verify:ai` → 0。`node --test server/test/release-scope.test.ts server/test/release-plan.test.ts server/test/check-mcp-version.test.ts`（server/ で）→ 全件 pass。`bun run release:plan -- --base a58ee28214634317d721f6d64fd4b752ca9732cc` → kind plugin、4 つの版が 0.6.71
  - コミット: `chore(release): drop sphica-pane from the marketplace and release sources, bump to 0.6.71`
  - 結果: `bun run verify:ai` → 0。release-scope・release-plan・check-mcp-version のテスト → 29 件 pass。`bun run release:plan -- --base a58ee282…` → kind plugin、npm / plugin / marketplace / Codex がすべて 0.6.71

## P2: pane の本体とそのための道具を消す

pane/、ピン留めした CLI、そのテストと CI の手順、設定の pane の行が無くなる。

- [x] T02: pane/ とピン留めした Claude Code CLI、そのテスト・CI・設定の行を消す
  - 種別: 削除
  - 計画: S3
  - 依存: T01（check-pane が pane/ と scripts/claude-cli.mjs を使うので、先に消えていないと check が落ちる）
  - 変更: `pane/`, `server/test/pane-sift.test.ts`, `scripts/claude-cli.mjs`, `scripts/claude-cli.d.mts`, `server/test/claude-cli.test.ts`, `tools/claude-cli/`, `package.json`, `.github/workflows/check.yml`, `lefthook.yml`, `.gitignore`, `scripts/check-english.mjs`, `scripts/oxfmt.mjs`, `scripts/oxlint.mjs`, `scripts/check-license-headers.mjs`
  - 完了条件: `git ls-files pane tools/claude-cli` → 空。`bun run setup` → 0。`bun run check` → 0
  - コミット: `chore(pane): remove the pane plugin and the pinned Claude Code CLI that checked it`
  - 結果: `git ls-files pane tools/claude-cli` → 空。`bun run setup` → 0。`bun run check` → 0（english 177 件、license headers 357 件、knip まで通過）

## P3: 文書から pane を外す

README は以前入れた人への案内だけを残し、規範と release の Skill から pane が消える。

- [x] T03: README・CLAUDE.md・AGENTS.md・verification.md・plugin-release の pane の記述を直す
  - 種別: 変更
  - 計画: S4
  - 依存: なし
  - 変更: `README.md`, `CLAUDE.md`, `AGENTS.md`, `.claude/rules/verification.md`, `.agents/skills/plugin-release/SKILL.md`
  - 完了条件: `bun run verify:ai` → 0。`git grep -n -i "sphica-pane" -- README.md CLAUDE.md AGENTS.md .claude/rules .agents` → README のアンインストールの節だけ
  - コミット: `docs: drop sphica-pane from the README, the rules, and the release Skill`
  - 結果: `bun run verify:ai` → 0。`git grep -n -i "sphica-pane" -- README.md CLAUDE.md AGENTS.md .claude/rules .agents` → README.md:221 のアンインストールの節の 1 行だけ

## 記録

- 2026-10-31: T01 のコミット欄を `chore(release): drop sphica-pane from the marketplace and the release sources, and bump to 0.6.71` から `chore(release): drop sphica-pane from the marketplace and release sources, bump to 0.6.71` に変えた。commit-msg が件名の 100 字超えを止めたため
