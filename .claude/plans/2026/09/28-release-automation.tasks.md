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

- [x] T01: release-gate が判定の通過時に `GITHUB_OUTPUT` へ PR 番号を書く
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `scripts/release-gate.mjs`, `server/test/release-gate-cli.test.ts`
  - 完了条件: `bun run --cwd server test -- --test-name-pattern "release-gate"` → 偽の git・gh・npm を PATH の先頭に置いた子プロセスで、通過時に `pull=7` が書かれ、落ちたときは `GITHUB_OUTPUT` が空のまま。スクリプトの変更を外すと前者が落ちる
  - コミット: `feat(release): write the PR number to GITHUB_OUTPUT when the gate passes`
  - 結果: red: 変更前のスクリプトで通過のケースが `'' !== 'pull=7\n'` で落ちた（status 0、出力なし）。変更後 `bun run --cwd server test -- --test-name-pattern "release-gate"` → 270 pass / 0 fail（新しい 2 件を含む）

- [x] T02: `npm-release` 環境の設定を検査する release-env
  - 種別: 追加
  - 計画: S2
  - 依存: なし
  - 変更: `scripts/lib/release-env.mjs`, `scripts/lib/release-env.d.mts`, `scripts/release-env.mjs`, `server/test/release-env.test.ts`, `.github/workflows/release.yml`
  - 完了条件: `bun run --cwd server test -- --test-name-pattern "release-env"` → オーナー 1 人・`prevent_self_review: false`・`can_admins_bypass: false`・`v*` の tag ポリシー 1 件で通り、レビュアーの追加、別人、`prevent_self_review: true`、`can_admins_bypass: true`、ポリシーの追加・変更、API の失敗でそれぞれ落ちる
  - コミット: `feat(release): check that only the owner can approve npm-release`
  - 結果: `node --test test/release-env.test.ts` → 9 pass / 0 fail（別人、2 人目、Team、規則なし、prevent_self_review、admin bypass、ポリシー 4 通りと保護ブランチ、API の失敗）。`bun run --cwd server typecheck`、`bun run knip`、`actionlint release.yml` → exit 0

- [x] T03: merge 後の仕上げを行う release-finish
  - 種別: 追加
  - 計画: S3
  - 依存: なし
  - 変更: `scripts/lib/release-finish.mjs`, `scripts/lib/release-finish.d.mts`, `scripts/release-finish.mjs`, `server/test/release-finish.test.ts`, `.github/workflows/release.yml`
  - 完了条件: `bun run --cwd server test -- --test-name-pattern "release-finish"` → tag を merge していない merge コミットで exit 1、Release を作る、既にあれば作らない、ノートが無ければ exit 1、ツリーが違えば exit 1、`--dry-run` で作成もコメントもしない
  - コミット: `feat(release): verify a merged release and create its GitHub Release from a script`
  - 結果: `node --test test/release-finish.test.ts` → 7 pass / 0 fail（作成とコメント、再実行で作らない、merge 違い・ツリー違い・attestation なし・latest 違い・ノートなし・コメントだけのノートで exit 1 かつ作成もコメントもなし、dry run、引数の拒否、ノートの抽出、merge の特定）。実データ: `GITHUB_REPOSITORY=iroha924/sphica node scripts/release-finish.mjs --dry-run` → `v0.5.3: tree, attestation, npm latest, and Release notes check out (dry run)`。`gh attestation verify` は `--source-ref refs/tags/v0.5.2` にすると exit 1（空振りしない）。typecheck、knip、actionlint → exit 0

## P2: 1 つの run で承認から完了まで

tag push の run が、承認待ちを PR に知らせ、承認の後に publish・merge・仕上げまで進み、落ちたら公開の有無を添えて PR に知らせる。PR の CI ではお試し実行と分かる名前で流れる。

- [x] T04: release.yml を新しいジョブの流れにする
  - 種別: 変更
  - 計画: S4
  - 依存: T01（prepare の output の `pull`）, T02（prepare と publish が流す環境の検査）, T03（finish と finish-dry-run が流すスクリプト）
  - 変更: `.github/workflows/release.yml`
  - 完了条件: `mise exec -- actionlint .github/workflows/release.yml` → exit 0。`rg -n "ubuntu-latest|npm stage" .github/workflows/release.yml` → 0 件。`rg -n 'run:' -A20 .github/workflows/release.yml | rg '\$\{\{'` → 0 件（値は `env:` 経由）。各ジョブの `permissions` が plan の方針どおり
  - コミット: `feat(release): publish, merge, and finish in one run after the owner's approval`
  - 結果: `mise exec -- actionlint .github/workflows/release.yml` → exit 0。`rg -n "ubuntu-latest|npm stage" .github/workflows/release.yml` → 0 件。`run:` ブロック内の `${{` を数えるスクリプト → 0 件。permissions: notify-approval は `pull-requests: write`、publish は `contents/pull-requests/actions: read` と `id-token/attestations: write`、merge は `contents/pull-requests: write`、finish は `contents/pull-requests: write` と `attestations: read`、report-failure は `pull-requests: write`、finish-dry-run は read だけ。zizmor はローカルに無いので PR の CI で確かめる（A7）

## P3: 手順・検査・公開の説明を揃えて 0.5.4 にする

Skill と検査と公開の説明が新しい流れだけを語り、この PR が 0.5.4 として新しい流れで出せる状態になる。

- [x] T05: npm と 3 つのマニフェストを 0.5.4 に揃える
  - 種別: 変更
  - 計画: S6
  - 依存: なし
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run release:plan -- --base v0.5.3` → 4 つのバージョンが 0.5.4
  - コミット: `chore(release): bump to 0.5.4`
  - 結果: `bun run release:plan -- --base v0.5.3` → `version: npm 0.5.4 / plugin 0.5.4 / marketplace 0.5.4 / Codex 0.5.4`（kind はパッケージの入力がまだ変わっていないので `none`。README を変える T06 で `plugin` になる）

- [x] T06: Skill、check-ai-config、release-plan、release-status、AGENTS.md、verification.md、PR テンプレート、README を新しい流れに揃える
  - 種別: 変更
  - 計画: S5
  - 依存: T04（手順が新しいジョブの流れを前提に書く）, T05（README はパッケージの入力なので、pre-commit のバージョン検査がバージョンの上がった状態を要る）
  - 変更: `.agents/skills/plugin-release/SKILL.md`, `scripts/check-ai-config.mjs`, `scripts/release-plan.mjs`, `scripts/release-status.mjs`, `AGENTS.md`, `.claude/rules/verification.md`, `.github/pull_request_template.md`, `README.md`, `scripts/lib/release-gate.mjs`, `server/test/release-gate.test.ts`
  - 完了条件: `bun run verify` → exit 0。`rg -n -- "npm stage|Staged Packages|--tag next|dist-tag add sphica@<version> latest|registry next|promotion to latest" .github scripts .agents AGENTS.md .claude/rules README.md` → 0 件。`bun run release:plan -- --base v0.5.3` → `release kind: plugin`、オーナーの action が環境の承認だけ
  - コミット: `docs(release): describe the single GitHub approval and direct publish`
  - 結果: `bun run verify` → exit 0（acceptance 55 pass を含む）。`rg -n -- "npm stage|Staged Packages|--tag next|dist-tag add sphica@<version> latest|registry next|promotion to latest" …` → check-ai-config の「Shipping に npm stage を書かない」検査自身の 2 行だけ（検査の文字列で、手順の記述ではない）。`bun run release:plan -- --base v0.5.3` はコミット後に流す（README がコミットに入るまでは none）

- [x] T07: release-finish が tag とコミット、PR と tag のコミットの一致を確かめ、コードブロック内の見出しを読まないようにする
  - 種別: 修正
  - 計画: S3
  - 依存: T03（直す対象のスクリプト）
  - 変更: `scripts/release-finish.mjs`, `scripts/lib/release-finish.mjs`, `server/test/release-finish.test.ts`
  - red: `node --test server/test/release-finish.test.ts` → tag が別のコミットを指す、PR の head が tag のコミットでない、コードブロック内の `## Release notes` の 3 ケースが、変更前のコードでは通ってしまって落ちる
  - 完了条件: `bun run --cwd server test -- --test-name-pattern "release-finish"` → 3 ケースを含めて全件 pass
  - コミット: `fix(release): tie release-finish to the tag's commit and PR, and skip fenced headings`
  - 結果: red: 変更前のコードで `FAKE_TAG_COMMIT` のケースが status 0、お試し実行が別の PR（#6）を拾う、コードブロック内の見出しを節として読む、の 3 件が落ちた。変更後 `node --test server/test/release-finish.test.ts` → 7 pass / 0 fail。実データの `node scripts/release-finish.mjs --dry-run` → v0.5.3 で通る

- [x] T08: release-finish が remote の tag と PR の実際の merge コミットを確かめる
  - 種別: 修正
  - 計画: S3
  - 依存: T07（同じスクリプトの検査の並びに足す）
  - 変更: `scripts/release-finish.mjs`, `server/test/release-finish.test.ts`
  - red: `node --test server/test/release-finish.test.ts` → remote の tag が別のコミットを指すケースが、変更前のコードでは status 0 で落ちる
  - 完了条件: `bun run --cwd server test -- --test-name-pattern "release-finish"` → remote の tag 違い、PR が未 merge、PR の merge コミット違いで exit 1 を含めて全件 pass
  - コミット: `fix(release): check the remote tag and the PR's own merge commit before creating the Release`
  - 結果: red: 変更前のコードで `FAKE_REMOTE_TAG` のケースが status 0 で落ちた。変更後 `node --test server/test/release-finish.test.ts` → 7 pass / 0 fail。実データの `node scripts/release-finish.mjs --dry-run` → v0.5.3（PR #181 の merge コミット）で通る

## 記録
- 2026-09-28 / T02 / knip がどこからも呼ばれないスクリプトを落とすので、release.yml の「承認者がいるか」のステップを release-env に置き換える変更を T02 に入れた。型宣言 `release-env.d.mts` も要った / 変更欄を前: `scripts/lib/release-env.mjs`, `scripts/release-env.mjs`, `server/test/release-env.test.ts` から、後: それに `scripts/lib/release-env.d.mts`, `.github/workflows/release.yml` を足した値へ
- 2026-09-28 / T01 / Codex のタスクレビュー（333a550）: 指摘 0 件。Codex は sandbox で一時ディレクトリを作れずテストを流せなかったが、red と green は手元で実測済み / 採る指摘なし
- 2026-09-28 / T03 / 仕上げは push:main で起動せず release.yml から引数付きで呼ぶ形になったので、「release でないときに何もしない」は当てはまらない。knip のため PR 用の `finish-dry-run` ジョブを T03 で release.yml に足し、型宣言も要った / 完了条件を前: 「release でないときに何もしない、…」から、後: 「tag を merge していない merge コミットで exit 1、…」へ。変更欄に `scripts/lib/release-finish.d.mts`, `.github/workflows/release.yml` を足した
- 2026-09-28 / T02 / Codex のタスクレビュー（0a3bf53）: 指摘 0 件（sandbox でテストは流せず、手元で実測済み） / 採る指摘なし
- 2026-09-28 / T06 / release-gate の lib とテストに stage の言い回しが残っていた / 変更欄に `scripts/lib/release-gate.mjs`, `server/test/release-gate.test.ts` を足した
- 2026-09-28 / T03 / Codex のタスクレビュー（19244ee）: 3 件。F1 `--tag` と `--commit` の一致を見ていない、F2 `--pull` の PR が tag のコミットを head に持つかを見ていない、F3 コードブロック内の見出しを節の区切りに読む（再現あり） / 3 件とも採る。修正タスク T07 を足した
- 2026-09-28 / T04 / Codex のタスクレビュー（6ac17a4）: 2 件。F1 承認依頼のコメントが落ちても report-failure が走らない、F2 同じ tag の run が 3 件重なると待機中の run が取り消される / どちらも見送る。F1 はコメントが便利のためのもので、run の URL は Claude が Skill の手順 5 で必ず渡す。F2 は対策の `concurrency.queue: max` を固定の actionlint 1.7.12 が拒否し（実測）、同じ tag を打ち直さない規則と tag のルールセットのもとでは 3 件重なる入力が起きにくい
- 2026-09-28 / 全体 / Codex の全差分レビュー: 3 件。1 publish 後に remote の tag が動いても気づかない、2 渡された merge コミットが PR の実際の merge か確かめない、3 既存の Release の本文が PR のノートと違っても成功扱い / 1 と 2 を採り、修正タスク T08 を足した。3 は Release を手で書き換えたときだけの入力で、オーナーの意図した修正で再実行を落とす副作用があるので見送る
