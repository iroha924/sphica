---
kind: tasks
plan: 22-delivered-pane.plan.md
branch: feat/delivered-pane
base: main
---

# Sphica が渡した記録を並べる読み取り専用の Claude Code mod を、任意のプラグイン `sphica-pane` として出す（#370）のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: ペインの mod

`pane/` が手元の `claude --plugin-dir pane` で動き、拾う関数が実際の配信文で検査される

- [ ] T01: `pane/` の骨組み（マニフェスト、types、README、LICENSE）と `sift.ts`（拾う関数と描画の割り付け）を足し、実際の deliver の出力で検査する
  - 種別: 追加
  - 計画: S2
  - 依存: なし
  - 変更: `pane/.claude-plugin/plugin.json`, `pane/types/index.d.ts`, `pane/hooks/sift.ts`, `pane/README.md`, `pane/LICENSE`, `server/test/pane-sift.test.ts`, `server/tsconfig.json`, `scripts/check-english.mjs`
  - 完了条件: `cd server && node --test test/pane-sift.test.ts` → pass（SessionStart・読む前・編集の前・プロンプト・SubagentStart・unavailable・#218 の deny の実際の出力を全部拾い、他のプラグインの文面と空を拾わない。`layout` が 8,000 文字と 1 件 1,500 文字に収め、省略の件数を返す）。`bun run typecheck`・`bun run lint`・`bun run english`・`bun run headers`・`bun run comments` → 0 で終わる
  - コミット: `feat(pane): add the sphica-pane plugin skeleton and the sift of Sphica's hook text (T01)`
- [ ] T02: `register.tsx`（5 つの classic hook、`/sphica-pane`、ペインの描画）と `register.test.tsx` を足す
  - 種別: 追加
  - 計画: S3
  - 依存: T01（`sift` と `layout`、state の型が要る）
  - 変更: `pane/hooks/hooks.json`, `pane/hooks/register.tsx`, `pane/hooks/register.test.tsx`
  - 完了条件: `claude plugin validate --strict pane` → 0 で終わる。`claude plugin test pane` → pass（5 つのイベントで、返り値が下流の結果と同じ、下流は 1 回、入力は変わらない、state の中身、同時の 2 配信が両方残る、`keep` が失敗しても結果を返す）
  - コミット: `feat(pane): register the classic hooks and draw the delivered pane (T02)`

## P2: CI で配る実物を検査する

固定した Claude Code CLI で、Linux と Windows の CI が `pane/` を validate と test にかけ、許可した hook と呼び出しの外に出たら落ちる

- [ ] T03: claude CLI の版を選んで固定し、入れ方を実測で決め、CI の Linux と Windows のジョブで `pane/` の validate と test を流す
  - 種別: 追加
  - 計画: S1
  - 依存: T02（CI で流す mod とテストが要る）
  - 変更: `scripts/lib/claude-cli.mjs`, `.github/workflows/check.yml`, `package.json`
  - 完了条件: `node -e 'import("./scripts/lib/claude-cli.mjs").then(m => console.log(m.CLAUDE_CLI_VERSION))'` → npm の公開時刻から 604800 秒以上たった版。`gh run view <run> --log` → Linux と Windows のジョブで、その版の `claude --version` と `claude plugin validate --strict pane`、`claude plugin test pane` が通っている。Windows で通らなければ、ここで止めて持ち主に戻す
  - コミット: `ci: pin the Claude Code CLI and validate and test the pane mod on Linux and Windows (T03)`
- [ ] T04: `scripts/check-pane.mjs` を足す（`git archive` で取り出した `pane/` に validate --strict --json と plugin test を流し、hook・calls・state を許可リストと突き合わせる）。`bun run pane:check` を check・ci:static・Windows のジョブに入れる
  - 種別: 追加
  - 計画: S4
  - 依存: T03（固定した CLI の版と入れ方が要る）
  - 変更: `scripts/check-pane.mjs`, `package.json`, `.github/workflows/check.yml`
  - 完了条件: `bun run pane:check` → 0 で終わる。`register.tsx` に許可していない `$.fs.read` を一時的に足して `bun run pane:check` → calls の違いを名指しして 1 で終わる（戻してからコミット）
  - コミット: `chore(scripts): check the archived pane mod against its allowed hooks and calls (T04)`

## P3: リリースに載せる

`pane/` の変更がリリースの判定・バージョンの検査・タグのゲート・到着の確認に掛かり、マーケットプレイスから入れられる

- [ ] T05: release-scope・check-mcp-version・release-plan・release-gate・release-status に pane のマニフェストと marketplace の ref を足し、version-sync の文書と plugin-release の Skill を直す
  - 種別: 変更
  - 計画: S5
  - 依存: T01（pane のマニフェストが要る）
  - 変更: `scripts/lib/release-scope.mjs`, `scripts/check-mcp-version.mjs`, `scripts/release-plan.mjs`, `scripts/release-gate.mjs`, `scripts/release-status.mjs`, `CLAUDE.md`, `AGENTS.md`, `.claude/rules/verification.md`, `.claude/skills/plugin-release/SKILL.md`, `.agents/skills/plugin-release/SKILL.md`, `server/test/release-scope.test.ts`
  - 完了条件: `node -e 'import("./scripts/lib/release-scope.mjs").then(m => console.log(m.releaseKind(["pane/hooks/register.tsx"])))'` → `plugin`。`cd server && node --test test/release-scope.test.ts` → pass。`bun run verify:ai` → 0 で終わる
  - コミット: `chore(release): treat the pane plugin as a package input and gate its version and ref (T05)`
- [ ] T06: marketplace に `sphica-pane` のエントリを足してバージョンを上げ、`check-pane.mjs` にエントリの照合を足し、README に入れ方・確かめた版・Codex には入れないこと・外し方を書く
  - 種別: 追加
  - 計画: S6
  - 依存: T04（エントリの照合を足す先の検査が要る）, T05（marketplace の ref を version として読む検査が要る）
  - 変更: `.claude-plugin/marketplace.json`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `pane/.claude-plugin/plugin.json`, `scripts/check-pane.mjs`, `README.md`
  - 完了条件: `bun run pane:check` → エントリの照合を含めて 0 で終わる。`ref` を `v0.0.0` に書き換えて `bun run pane:check` → ref の違いを名指しして 1 で終わる（戻してからコミット）。`bun run release:plan -- --base v0.6.65` → `plugin`。`bun run verify` → 0 で終わる
  - コミット: `feat(pane): list sphica-pane in the marketplace and document it (T06)`

## 記録
