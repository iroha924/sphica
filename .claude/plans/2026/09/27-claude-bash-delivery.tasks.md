---
kind: tasks
plan: 27-claude-bash-delivery.plan.md
branch: feat/claude-bash-delivery
base: main
---

# Claude Code gets decisions when a Bash command names an anchored file, as Codex does, shipped as 0.5.1 のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 計画の追跡

計画ファイルを git で追跡し、この plan と tasks を作業ブランチに入れる。

- [x] T01: .claude/plans/ を追跡に変え、過去の計画を消して plan と tasks を入れる
  - 種別: 変更
  - 計画: S5
  - 依存: なし
  - 変更: `.gitignore`
  - 完了条件: `git check-ignore -q .claude/plans/2026/09/27-claude-bash-delivery.plan.md; echo $?` → 1（無視されない）、`git ls-files .claude/plans` → この plan と tasks の 2 件だけ
  - コミット: `chore(plans): track .claude/plans and drop the old plan files`
  - 結果: `git check-ignore -q` → 1（無視されない）。過去の計画ファイル 22 件を削除（追跡されていなかった）。`git ls-files .claude/plans` はこのコミットで plan と tasks の 2 件。`bun run english` / `verify:ai` / `biome ci` / `naming` → 通過

## P2: Claude の Bash での配信

Claude Code の Bash がファイルを名指ししたら配信し、フックと検査と README をそろえて 0.5.1 にする。

- [x] T05: 版を 0.5.1 に揃える
  - 種別: 変更
  - 計画: S4
  - 依存: なし
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run release:plan -- --base v0.5.0` → release kind plugin、4 か所が 0.5.1
  - コミット: `chore(release): bump to 0.5.1`
  - 結果: `bun run release:plan -- --base v0.5.0` → 4b13e5f の時点で release kind none、version は npm / plugin / marketplace / Codex とも 0.5.1。T02 を積んだ d116709 の時点で同じコマンド → release kind plugin

- [x] T02: deliver.ts で Claude の Bash を名指しの読み取りにし、テストを足す
  - 種別: 変更
  - 計画: S1
  - 依存: T05（pre-commit の版のゲートが、版を上げずに配布物を変えるコミットを止める）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - 完了条件: `cd server && node --test test/deliver.test.ts test/deliver-codex.test.ts` → 全件 pass（Claude の Bash の名指し、何も名指ししない Bash、Read の後の Bash、patch 形式の Bash の 4 件を含む）
  - コミット: `feat(deliver): deliver when a Claude Code Bash command names an anchored file`
  - 結果: 新しいテストは変更前のコードで「trace:ext-s1/map が出ない」で失敗。変更後 `node --test test/deliver.test.ts test/deliver-codex.test.ts test/review-bridge.test.ts` → pass 22 / fail 0。`tsc --noEmit` 通過

- [x] T03: hooks.json の matcher に Bash を足し、Claude 側の matcher を検査する
  - 種別: 変更
  - 計画: S2
  - 依存: T02（フックが Bash を渡しても deliver.ts が Claude の Bash を扱わないと何も起きない）
  - 変更: `plugin/hooks/hooks.json`, `scripts/check-ai-config.mjs`
  - 完了条件: `bun run verify:ai` → exit 0。matcher から Bash を外すと同じコマンドが Claude の matcher の違反で落ちる
  - コミット: `feat(hooks): run Claude Code delivery before Bash commands`
  - 結果: 検査を足した直後（matcher に Bash が無い状態）で `bun run verify:ai` → 「the PreToolUse delivery matcher must cover Read and Bash」で exit 1。Bash を足した後 → exit 0

- [x] T04: README（英・日）を両ホスト共通の書き方に直す
  - 種別: 変更
  - 計画: S3
  - 依存: T03（README が書く挙動がフックに入っていないと、書いた内容が実際と違う）
  - 変更: `README.md`, `README.ja.md`, `server/evals/acceptance/cases.json`
  - 完了条件: `rg -n "Limits in 0.5.1|0.5.1 の限界" README.md README.ja.md` → 各 1 件。`bun run english` → exit 0
  - コミット: `docs(readme): say Claude Code also gets decisions for shell commands that name a file`
  - 結果: `rg -n "Limits in 0.5.1|0.5.1 の限界" README.md README.ja.md` → 各 1 件。`bun run english` → exit 0。`biome ci` → 通過

- [x] T06: Sphica の置き場所を SPHICA_HOME で切り替えられるようにする
  - 種別: 追加
  - 計画: S6
  - 依存: なし
  - 変更: `server/src/sqlite.ts`, `server/src/capture.ts`, `server/src/project.ts`, `server/src/cli.ts`, `server/test/capture.test.ts`
  - 完了条件: `cd server && node --test test/capture.test.ts test/project.test.ts test/cli.test.ts` → 全件 pass（SPHICA_HOME で DB・spool・状態・プロジェクト表が一時ディレクトリに向くテストを含む）
  - コミット: `feat(paths): let SPHICA_HOME move Sphica's files for tests and measurements`
  - 結果: 新しいテストは変更前で dbFile が ~/.sphica を返して失敗。変更後 `node --test test/capture.test.ts test/project.test.ts test/cli.test.ts` → pass 40 / fail 0。`tsc`、`architecture`、`knip` → 通過

## 記録
2026-09-27 / T05, T02 / pre-commit の版のゲートが、版を上げずに server/src/deliver.ts を変えるコミットを止めた / T05 を T02 の前へ移し、T05 の依存を「T04」から「なし」に、T02 の依存を「なし」から「T05」に変えた
2026-09-27 / T05 / 完了条件の半分（release kind plugin）を満たす前に [x] にした。4b13e5f 単体では `release:plan` が none（配布物のコードが未変更）、版は 4 か所 0.5.1 / plugin の判定は T02 以降を積んだ後に完了条件 A2 で確かめる
2026-09-27 / T04 / cases.json の note が T01 で消した過去の計画ファイルを指していた / 変更欄を「README.md, README.ja.md」から「README.md, README.ja.md, server/evals/acceptance/cases.json」にして参照を外した
2026-09-27 / T06 / 一時 HOME で Claude のサインインが効かず、公開前の実測（A3）が止まった / 持ち主の判断で SPHICA_HOME を足す T06 を追加し、plan に S6 を足した
