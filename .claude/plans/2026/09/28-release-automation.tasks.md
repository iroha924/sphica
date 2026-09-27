---
kind: tasks
plan: 28-release-automation.plan.md
branch: feat/release-automation
base: main
---

# リリースを GitHub の承認 1 回に絞り、承認の後の publish・merge・検証・GitHub Release を 1 つの run で自動にする のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: リリースの判定を行うスクリプト

ワークフローが呼ぶ 3 つのスクリプト（PR 番号の受け渡し、環境の検査、merge 後の仕上げ）が、偽の外部コマンドを使ったテスト付きでそろう。

- [ ] T01: release-gate が判定の通過時に `GITHUB_OUTPUT` へ PR 番号を書く
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `scripts/release-gate.mjs`, `server/test/release-gate-cli.test.ts`
  - 完了条件: `bun run --cwd server test -- --test-name-pattern "release-gate"` → 偽の git・gh・npm を PATH の先頭に置いた子プロセスで、通過時に `pull=7` が書かれ、落ちたときは `GITHUB_OUTPUT` が空のまま。スクリプトの変更を外すと前者が落ちる
  - コミット: `feat(release): write the PR number to GITHUB_OUTPUT when the gate passes`

- [ ] T02: `npm-release` 環境の設定を検査する release-env
  - 種別: 追加
  - 計画: S2
  - 依存: なし
  - 変更: `scripts/lib/release-env.mjs`, `scripts/release-env.mjs`, `server/test/release-env.test.ts`
  - 完了条件: `bun run --cwd server test -- --test-name-pattern "release-env"` → オーナー 1 人・`prevent_self_review: false`・`can_admins_bypass: false`・`v*` の tag ポリシー 1 件で通り、レビュアーの追加、別人、`prevent_self_review: true`、`can_admins_bypass: true`、ポリシーの追加・変更、API の失敗でそれぞれ落ちる
  - コミット: `feat(release): check that only the owner can approve npm-release`

- [ ] T03: merge 後の仕上げを行う release-finish
  - 種別: 追加
  - 計画: S3
  - 依存: なし
  - 変更: `scripts/lib/release-finish.mjs`, `scripts/release-finish.mjs`, `server/test/release-finish.test.ts`
  - 完了条件: `bun run --cwd server test -- --test-name-pattern "release-finish"` → release でないときに何もしない、Release を作る、既にあれば作らない、ノートが無ければ exit 1、ツリーが違えば exit 1、`--dry-run` で作成もコメントもしない
  - コミット: `feat(release): verify a merged release and create its GitHub Release from a script`

## P2: 1 つの run で承認から完了まで

tag push の run が、承認待ちを PR に知らせ、承認の後に publish・merge・仕上げまで進み、落ちたら公開の有無を添えて PR に知らせる。PR の CI ではお試し実行と分かる名前で流れる。

- [ ] T04: release.yml を新しいジョブの流れにする
  - 種別: 変更
  - 計画: S4
  - 依存: T01（prepare の output の `pull`）, T02（prepare と publish が流す環境の検査）, T03（finish と finish-dry-run が流すスクリプト）
  - 変更: `.github/workflows/release.yml`
  - 完了条件: `mise exec -- actionlint .github/workflows/release.yml` → exit 0。`rg -n "ubuntu-latest|npm stage" .github/workflows/release.yml` → 0 件。`rg -n 'run:' -A20 .github/workflows/release.yml | rg '\$\{\{'` → 0 件（値は `env:` 経由）。各ジョブの `permissions` が plan の方針どおり
  - コミット: `feat(release): publish, merge, and finish in one run after the owner's approval`

## P3: 手順・検査・公開の説明を揃えて 0.5.4 にする

Skill と検査と公開の説明が新しい流れだけを語り、この PR が 0.5.4 として新しい流れで出せる状態になる。

- [ ] T05: npm と 3 つのマニフェストを 0.5.4 に揃える
  - 種別: 変更
  - 計画: S6
  - 依存: なし
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run release:plan -- --base v0.5.3` → 4 つのバージョンが 0.5.4
  - コミット: `chore(release): bump to 0.5.4`

- [ ] T06: Skill、check-ai-config、release-plan、release-status、AGENTS.md、verification.md、PR テンプレート、README を新しい流れに揃える
  - 種別: 変更
  - 計画: S5
  - 依存: T04（手順が新しいジョブの流れを前提に書く）, T05（README はパッケージの入力なので、pre-commit のバージョン検査がバージョンの上がった状態を要る）
  - 変更: `.agents/skills/plugin-release/SKILL.md`, `scripts/check-ai-config.mjs`, `scripts/release-plan.mjs`, `scripts/release-status.mjs`, `AGENTS.md`, `.claude/rules/verification.md`, `.github/pull_request_template.md`, `README.md`
  - 完了条件: `bun run verify` → exit 0。`rg -n -- "npm stage|Staged Packages|--tag next|dist-tag add sphica@<version> latest|registry next|promotion to latest" .github scripts .agents AGENTS.md .claude/rules README.md` → 0 件。`bun run release:plan -- --base v0.5.3` → `release kind: plugin`、オーナーの action が環境の承認だけ
  - コミット: `docs(release): describe the single GitHub approval and direct publish`

## 記録
