---
kind: tasks
plan: 05-markdown-checks.plan.md
branch: ci/markdown-checks
base: main
---

# 配る Markdown とリポジトリの Markdown を markdownlint-cli2 と lychee で検査し、手書きのリンク検査を置き換える のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: Markdown の構造の検査

markdownlint-cli2 が、リポジトリの Markdown の構造の崩れを pre-commit と verify で落とす

- [ ] T01: F2 の plan と tasks を消す
  - 種別: 削除
  - 計画: S1
  - 依存: なし
  - 変更: `.claude/plans/2026/10/05-f2-init-project.plan.md`, `.claude/plans/2026/10/05-f2-init-project.tasks.md`
  - 完了条件: `git ls-files .claude/plans/2026/10/05-f2-init-project.*` → 0 件
  - コミット: `chore(plans): remove the finished F2 plan`
- [ ] T02: markdownlint-cli2 を入れ、構造の規則だけで全文書を検査し、0.6.33 に上げる
  - 種別: 追加
  - 計画: S2
  - 依存: なし
  - 変更: `server/package.json`, `server/bun.lock`, `.markdownlint-cli2.jsonc`, `scripts/lib/markdown-files.mjs`, `scripts/check-markdown.mjs`, `package.json`, `lefthook.yml`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run markdown` → 終了コード 0。`[x]()` を足した一時的な変更で → MD042 で落ちる（戻す）。依存を stage した後の `bun run release:plan -- --base 30245523` → plugin、4 か所が 0.6.33。`bun run verify` → 終了コード 0
  - コミット: `ci(docs): lint the structure of Markdown with markdownlint-cli2`

## P2: リンクの検査

lychee が、相対リンク・画像・見出しアンカーと自分のリポジトリへの絶対 URL を、pre-commit・verify:ai・CI で落とす

- [ ] T03: lychee を mise と CI に入れ、check-links.mjs を verify:ai と lefthook から流す
  - 種別: 追加
  - 計画: S3
  - 依存: T02（Markdown の一覧の共通の関数が要る）
  - 変更: `mise.toml`, `lychee.toml`, `scripts/check-links.mjs`, `package.json`, `lefthook.yml`, `.github/workflows/check.yml`, `.github/workflows/release.yml`, `scripts/check-pairs.mjs`
  - 完了条件: `bun run verify:ai` → 終了コード 0。README.ja.md の見出しを指すアンカーを壊した一時的な変更で `node scripts/check-links.mjs` → 落ちる（戻す）。check.yml の lychee のバージョンだけを変えた一時的な変更で `bun run pairs` → 落ちる（戻す）。`actionlint` → 指摘なし。`bun run verify` → 終了コード 0
  - コミット: `ci(docs): check Markdown links and anchors offline with lychee`
- [ ] T04: check-ai-config.mjs の checkLocalLinks を消す
  - 種別: 削除
  - 計画: S4
  - 依存: T03（同じファイルを lychee が見ていることが要る）
  - 変更: `scripts/check-ai-config.mjs`
  - 完了条件: `git grep -n checkLocalLinks -- scripts` → 該当なし（終了コード 1）。存在しないファイルへの相対リンクを `.agents/skills` の SKILL.md に足した一時的な変更で `bun run verify:ai` → 落ちる（戻す）。`bun run verify` → 終了コード 0
  - コミット: `refactor(ai-config): leave link checks to lychee`

## P3: 配る Markdown の検査

展開した tarball の Markdown に両方がかかり、package の外を指す相対リンクが落ちる

- [ ] T05: 包含の判定の関数とテストを書く
  - 種別: 追加
  - 計画: S5
  - 依存: なし
  - 変更: `scripts/lib/link-containment.mjs`, `scripts/lib/link-containment.d.mts`, `server/test/link-containment.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/link-containment.test.ts` → 成功と失敗の混ざった JSON、package の外の既存ファイル、正常な `../trace/SKILL.md` の各テストが pass
  - コミット: `feat(tarball): find relative links that resolve outside the package`
- [ ] T06: check-tarball で展開した package に markdownlint と lychee をかけ、包含を確かめる
  - 種別: 追加
  - 計画: S5
  - 依存: T02（markdownlint の設定が要る）, T03（lychee と設定が要る）, T05（包含の判定が要る）
  - 変更: `scripts/check-tarball.mjs`
  - 完了条件: `bun run bundle && (cd plugin && npm pack)` の tarball で `node scripts/check-tarball.mjs <tgz>` → 終了コード 0。package の外の既存ファイルを指す相対リンクを plugin の Markdown に足して同じ手順 → 包含の判定で落ちる（戻す）。`bun run verify` → 終了コード 0
  - コミット: `ci(tarball): lint and link-check the packed Markdown`

## P4: 文書

- [ ] T07: CLAUDE.md の command の節に lychee と Markdown の検査を書く
  - 種別: 変更
  - 計画: S6
  - 依存: T03（書く対象の検査が要る）
  - 変更: `CLAUDE.md`
  - 完了条件: `bun run verify:ai` → 終了コード 0
  - コミット: `docs(claude): mention lychee and the Markdown checks in the commands`

## 記録
