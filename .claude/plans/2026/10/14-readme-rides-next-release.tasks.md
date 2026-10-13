---
kind: tasks
plan: 14-readme-rides-next-release.plan.md
branch: feat/readme-rides-next-release
base: main
---

# README.md だけの変更を、バージョンを上げずに main へ出せるようにする のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 検査と doctor を変える

README.md だけの変更がバージョン検査を通り、doctor がそれを食い違いと言わなくなる。

- [x] T01: README.md をバージョン検査の入力から外す
  - 種別: 変更
  - 計画: S1
  - 依存: なし
  - 変更: `scripts/lib/release-scope.mjs`, `lefthook.yml`, `server/test/release-scope.test.ts`, `server/test/check-mcp-version.test.ts`
  - 完了条件: テストを先に足し、`scripts/lib/release-scope.mjs` を直す前に `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 test/check-mcp-version.test.ts test/release-scope.test.ts` → 足したテストが失敗する（red として結果行に残す）。直した後に同じコマンド → 全部通る
  - コミット: `feat(release): let a change to README.md alone go without a version bump`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 test/check-mcp-version.test.ts test/release-scope.test.ts` → red: `scripts/lib/release-scope.mjs` と `lefthook.yml` を直す前は 3 件失敗（check-mcp-version の新しいテストが exit 1 で「for example README.md」、`releaseKind(["README.md"])` が `plugin`、glob の検査が「README.md is in the bundle glob」）。直した後は 12 件 pass、0 件 fail。review-shipping の指摘 2 件（glob の否定の検査が同じ綴りしか見ない、テストの題が古い）を同じコミットで直した

- [ ] T02: doctor がリポジトリと比べるときだけ README.md を外し、0.6.56 にする
  - 種別: 変更
  - 計画: S2
  - 依存: なし
  - 変更: `server/src/plugin.ts`, `server/test/plugin.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 test/plugin.test.ts` → 全部通る。`bun run release:plan -- --base origin/main` → `plugin`、4 か所が 0.6.56
  - コミット: `fix(doctor): do not count README.md when comparing the repository with an install`

## P2: 規範と README を合わせる

規範と手順が新しい検査と同じことを言い、書き換えた README が入る。

- [x] T03: 規範と手順の文書に README.md だけの例外を書く
  - 種別: 変更
  - 計画: S3
  - 依存: T01（検査が README.md を入力から外していないと、文書が先に違うことを言う）
  - 変更: `CLAUDE.md`, `AGENTS.md`, `.claude/rules/verification.md`, `.claude/agents/review-shipping.md`, `.agents/skills/plugin-release/SKILL.md`, `CONTRIBUTING.md`
  - 完了条件: `bun run verify:ai` → 通る。`rg -n "README.md" CLAUDE.md AGENTS.md .claude/rules/verification.md .claude/agents/review-shipping.md .agents/skills/plugin-release/SKILL.md CONTRIBUTING.md` → 6 つのファイルすべてに例外の行がある
  - コミット: `docs: say that a change to README.md alone ships with the next release`
  - 結果: `bun run verify:ai` → 通った（AI config: 28 invariants、リンクのエラー 0）。`rg -c "README.md" CLAUDE.md AGENTS.md .claude/rules/verification.md .claude/agents/review-shipping.md .agents/skills/plugin-release/SKILL.md CONTRIBUTING.md` → 6 つのファイルすべてに例外の行がある（CLAUDE.md は 2 行）

- [x] T04: README.md と README.ja.md の書き換えを入れる
  - 種別: 変更
  - 計画: S4
  - 依存: T01（README.md が入力のままだと、後から足すコミットがバージョン検査の対象になる）
  - 変更: `README.md`, `README.ja.md`
  - 完了条件: `node scripts/check-markdown.mjs README.md README.ja.md` → 0 件。`mise exec -- node scripts/check-links.mjs` → エラー 0
  - コミット: `docs: center the README header, gather the settings, and drop history notes`
  - 結果: `node scripts/check-markdown.mjs README.md README.ja.md` → 0 issues in 0 files。`mise exec -- node scripts/check-links.mjs` → エラー 0（日本語版の `#インストール`・`#設定`・`#セキュリティ` を含む）。prose-reviewer の指摘 6 件のうち、英日の食い違いと削りで落ちた但し書きを直した

## 記録

- 2026-10-14 / T01 / Codex のコミットのレビュー（c48b8dec、新しい会話）は指摘 0 件。read-only のためテストの実走は未検証と返った / 採否なし
- 2026-10-14 / T03 / T02 の出荷レビューを待つ間に T03 を先にコミットした（依存は T01 だけ） / 並びはそのまま
