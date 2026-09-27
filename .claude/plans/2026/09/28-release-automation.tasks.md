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

- [x] T09: report-failure が公開の有無を publish ジョブの結果で決め、Skill に npm のキャッシュ待ちを書く
  - 種別: 修正
  - 計画: S4, S5
  - 依存: T04（直す対象のジョブ）
  - 変更: `.github/workflows/release.yml`, `.agents/skills/plugin-release/SKILL.md`
  - red: `rg -n 'npm view "sphica@' .github/workflows/release.yml` → 変更前は report-failure が npm の答えだけで公開の有無を決めていた（publish 直後のキャッシュで E404 なら no と書く）。ワークフローの外では流せないので、判定のシェルを取り出して確かめる
  - 完了条件: `mise exec -- actionlint .github/workflows/release.yml` → exit 0。判定のシェルを PUBLISH=success / skipped / cancelled / failure で流す → yes / no / no / npm にあれば yes、なければ unknown
  - コミット: `fix(release): take whether npm has the version from the publish job`
  - 結果: actionlint → exit 0。判定のシェル → `success -> yes`、`skipped -> no`、`cancelled -> no`、`failure -> yes`（v0.5.3、npm にある）、`failure(v9.9.9) -> unknown`。`node scripts/check-ai-config.mjs` → exit 0

- [x] T10: Release notes から HTML コメントを取り除く処理が、入れ子の記号でコメントの開始記号を残さないようにする
  - 種別: 修正
  - 計画: S3
  - 依存: T07（直す対象の抽出処理）
  - 変更: `scripts/lib/release-finish.mjs`, `server/test/release-finish.test.ts`
  - red: `node --test server/test/release-finish.test.ts` → コメントの開始記号を入れ子にしたノートで、変更前のコードは開始記号が残った本文を返して落ちる
  - 完了条件: `bun run --cwd server test -- --test-name-pattern "release-finish"` → 入れ子の記号と閉じないコメントで null を含めて全件 pass。PR の CodeQL に新しい指摘が無い
  - コミット: `fix(release): remove Release note comments until none is left`
  - 結果: red: 変更前のコードで、開始記号が残った本文（`x` と `Hidden` の 2 行）が返って落ちた。変更後 `node --test server/test/release-finish.test.ts` → 7 pass / 0 fail。実データの `node scripts/release-finish.mjs --dry-run` → v0.5.3 で通る。CodeQL は push 後に確かめる

- [x] T11: tag push のときだけ動くジョブの名前を、式ではなく固定の文字列にする
  - 種別: 修正
  - 計画: S4
  - 依存: T04（直す対象のジョブ）
  - 変更: `.github/workflows/release.yml`
  - red: `gh pr checks 182` → スキップされたジョブの名前が `github.event_name == 'push' && format('release {0}: publish', …` のように式のまま表示された（GitHub はスキップしたジョブの name を評価しない）
  - 完了条件: `mise exec -- actionlint .github/workflows/release.yml` → exit 0。push 後の `gh pr checks 182` にスキップされたジョブの式が出ない
  - コミット: `fix(release): name tag-only jobs with plain text`
  - 結果: `mise exec -- actionlint .github/workflows/release.yml` → exit 0。`gh pr checks` は push 後に確かめる

- [x] T12: tag のゲートが PR の `release`（お試し実行）の成功も条件にする
  - 種別: 修正
  - 計画: S1, S5
  - 依存: T01（同じゲート）
  - 変更: `scripts/lib/release-gate.mjs`, `server/test/release-gate.test.ts`, `server/test/release-gate-cli.test.ts`, `.agents/skills/plugin-release/SKILL.md`
  - red: `node --test server/test/release-gate.test.ts` → release の run が失敗・未実行でも、変更前のコードは問題なしと返して落ちる
  - 完了条件: `bun run --cwd server test -- --test-name-pattern "release-gate"` → 全件 pass
  - コミット: `fix(release): require the PR's release dry run before a tag may publish`
  - 結果: red: 変更前のコードで「release dry run failed or did not run」のテストが落ちた。変更後 `node --test test/release-gate.test.ts test/release-gate-cli.test.ts` → 11 pass / 0 fail。`node scripts/check-ai-config.mjs` → exit 0

- [x] T13: リリースのスクリプトのテストで、子プロセスに一時 HOME を渡す
  - 種別: 修正
  - 計画: S1, S2, S3
  - 依存: T12（同じテストファイル）
  - 変更: `server/test/release-gate-cli.test.ts`, `server/test/release-env.test.ts`, `server/test/release-finish.test.ts`
  - red: `rg -n "HOME" server/test/release-gate-cli.test.ts server/test/release-env.test.ts server/test/release-finish.test.ts` → 変更前は 0 件（子の HOME が無く、Node はアカウントのホームを使う）
  - 完了条件: 3 ファイルの子プロセスの env に `HOME` がテストの一時ディレクトリで入り、`bun run --cwd server test` → 全件 pass
  - コミット: `test(release): give release-script children a temporary HOME`
  - 結果: red: 変更前は 3 ファイルとも `HOME` の指定が 0 件。変更後 `rg -n "HOME: dir" server/test/release-*.test.ts` → 3 件（USERPROFILE も同じ一時ディレクトリ）。`node --test test/release-gate-cli.test.ts test/release-env.test.ts test/release-finish.test.ts` → 18 pass / 0 fail

- [x] T14: merge の直前と finish で、PR の base が main であることを確かめる
  - 種別: 修正
  - 計画: S3, S4
  - 依存: T10（同じスクリプト）
  - 変更: `.github/workflows/release.yml`, `scripts/release-finish.mjs`, `server/test/release-finish.test.ts`
  - red: `node --test server/test/release-finish.test.ts` → base が main でない PR でも、変更前のコードは通って落ちる
  - 完了条件: `bun run --cwd server test -- --test-name-pattern "release-finish"` → base 違いで exit 1 を含めて全件 pass。`mise exec -- actionlint .github/workflows/release.yml` → exit 0
  - コミット: `fix(release): require main as the PR base when merging and finishing`
  - 結果: red: 変更前のコードで `FAKE_BASE: release` のケースが status 0 で落ちた。変更後 `node --test test/release-finish.test.ts` → 7 pass / 0 fail。actionlint → exit 0。実データの `--dry-run` → v0.5.3 で通る

- [x] T15: Release notes の抽出で、コードブロックの区切りを開始の記号の種類と長さで対応づける
  - 種別: 修正
  - 計画: S3
  - 依存: T14（同じテストファイル）
  - 変更: `scripts/lib/release-finish.mjs`, `server/test/release-finish.test.ts`
  - red: `node --test server/test/release-finish.test.ts` → 4 つのバッククォートの中に 3 つの行と見出しがある本文で、変更前のコードは見出しを節として読んで落ちる
  - 完了条件: `bun run --cwd server test -- --test-name-pattern "release-finish"` → 全件 pass
  - コミット: `fix(release): close a code fence only with a matching delimiter`
  - 結果: red: 変更前のコードで、4 つのバッククォートの中の見出しを節として読み `Example` 以下を返して落ちた。変更後 `node --test test/release-finish.test.ts` → 7 pass / 0 fail。実データの `--dry-run` → v0.5.3 で通る

- [x] T16: 承認の前にノートを検査してハッシュを記録し、finish はそのノートと一致するときだけ Release を作る
  - 種別: 修正
  - 計画: S3, S4
  - 依存: T15（同じスクリプト）
  - 変更: `scripts/release-finish.mjs`, `server/test/release-finish.test.ts`, `.github/workflows/release.yml`, `.agents/skills/plugin-release/SKILL.md`
  - red: `node --test server/test/release-finish.test.ts` → 承認の後に書き換えたノートでも、変更前のコードは Release を作って落ちる
  - 完了条件: `bun run --cwd server test -- --test-name-pattern "release-finish"` → ノートのハッシュ違いで exit 1、`--notes-digest` でノートが無ければ exit 1、を含めて全件 pass。`mise exec -- actionlint .github/workflows/release.yml` → exit 0
  - コミット: `fix(release): create the Release only from the notes the owner saw before approving`
  - 結果: red: 変更前のスクリプトは `--approved-notes` と `--notes-digest` を知らず 5 件落ちた。変更後 `node --test test/release-finish.test.ts` → 9 pass / 0 fail（ハッシュの出力、ノートなしで exit 1、承認後に変えたノートで exit 1 かつ作成もコメントもなし）。actionlint → exit 0。実データ: `--notes-digest --pull 181` → 64 桁のハッシュ、`--dry-run` → v0.5.3 で通る

- [x] T17: release-finish の冒頭コメントを 3 行に収める
  - 種別: 修正
  - 計画: S3
  - 依存: T16（直す対象の冒頭コメント）
  - 変更: `scripts/release-finish.mjs`
  - red: `sed -n 2,7p scripts/release-finish.mjs` → 変更前は 6 行のコメント（リポジトリの規範 comment-length は 1〜3 行）
  - 完了条件: 冒頭のコメントが 3 行以下で、引数と検査の説明は Skill を指す。`bun run --cwd server test -- --test-name-pattern "release-finish"` → 全件 pass
  - コミット: `fix(release): keep release-finish's header within three lines`
  - 結果: 冒頭コメント 3 行（引数と検査は Skill の Shipping 手順 5 と 8 を指す）。`node --test test/release-finish.test.ts` → 9 pass / 0 fail

- [x] T18: report-failure は publish が成功していないとき npm に聞き、公開済みのバージョンを「なし」と書かない
  - 種別: 修正
  - 計画: S4
  - 依存: T09（直す対象の判定）
  - 変更: `.github/workflows/release.yml`
  - red: `PUBLISH=skipped GITHUB_REF_NAME=v0.5.3 bash -c '<report-failure の判定>'` → 変更前は npm にあるバージョンでも `no`
  - 完了条件: `mise exec -- actionlint .github/workflows/release.yml` → exit 0。判定のシェル → success は yes、skipped と cancelled は npm にあれば yes・なければ no、failure は npm にあれば yes・なければ unknown
  - コミット: `fix(release): ask npm whenever publish did not succeed in this run`
  - 結果: `mise exec -- actionlint .github/workflows/release.yml` → exit 0。判定のシェルを 6 通りで流す → `success v9.9.9 -> yes`、`skipped v0.5.3 -> yes`、`skipped v9.9.9 -> no`、`cancelled v9.9.9 -> no`、`failure v0.5.3 -> yes`、`failure v9.9.9 -> unknown`

- [x] T19: Release notes の本文のどこかにコメントの開始記号が残っていたら受け付けない
  - 種別: 修正
  - 計画: S3
  - 依存: T15（同じ抽出処理）
  - 変更: `scripts/lib/release-finish.mjs`, `server/test/release-finish.test.ts`
  - red: `node --test server/test/release-finish.test.ts` → 見出しより前に閉じないコメントがある本文で、変更前のコードは `Not reviewed` を返して落ちる
  - 完了条件: `bun run --cwd server test -- --test-name-pattern "release-finish"` → 全件 pass
  - コミット: `fix(release): refuse notes with an unclosed comment anywhere in the PR body`
  - 結果: red: 変更前のコードで `actual: 'Not reviewed'` で落ちた。変更後 `node --test test/release-finish.test.ts` → 9 pass / 0 fail。実データの `--dry-run` → v0.5.3 で通る、`--notes-digest --pull 182` → ハッシュが出る

- [x] T20: publish の直前にもノートのハッシュを比べ、承認依頼のコメントの失敗で run を落とさない
  - 種別: 修正
  - 計画: S4
  - 依存: T16（比べる相手のハッシュ）
  - 変更: `.github/workflows/release.yml`
  - red: `rg -n "notes-digest" .github/workflows/release.yml` → 変更前は prepare の 1 か所だけで、publish の前に比べていない
  - 完了条件: `mise exec -- actionlint .github/workflows/release.yml` → exit 0。publish の比較のシェルを、PR #181 の実物のハッシュで流すと exit 0、違うハッシュで exit 1
  - コミット: `fix(release): recheck the approved notes before publishing and keep a failed comment from failing the run`
  - 結果: `mise exec -- actionlint .github/workflows/release.yml` → exit 0。比較のシェルを流す → 実物のハッシュで `exit=0`、`0000` で「notes changed」を出して `exit=1`。承認依頼のコメントのステップは `continue-on-error: true`

## 記録
- 2026-09-28 / T02 / knip がどこからも呼ばれないスクリプトを落とすので、release.yml の「承認者がいるか」のステップを release-env に置き換える変更を T02 に入れた。型宣言 `release-env.d.mts` も要った / 変更欄を前: `scripts/lib/release-env.mjs`, `scripts/release-env.mjs`, `server/test/release-env.test.ts` から、後: それに `scripts/lib/release-env.d.mts`, `.github/workflows/release.yml` を足した値へ
- 2026-09-28 / T01 / Codex のタスクレビュー（333a550）: 指摘 0 件。Codex は sandbox で一時ディレクトリを作れずテストを流せなかったが、red と green は手元で実測済み / 採る指摘なし
- 2026-09-28 / T03 / 仕上げは push:main で起動せず release.yml から引数付きで呼ぶ形になったので、「release でないときに何もしない」は当てはまらない。knip のため PR 用の `finish-dry-run` ジョブを T03 で release.yml に足し、型宣言も要った / 完了条件を前: 「release でないときに何もしない、…」から、後: 「tag を merge していない merge コミットで exit 1、…」へ。変更欄に `scripts/lib/release-finish.d.mts`, `.github/workflows/release.yml` を足した
- 2026-09-28 / T02 / Codex のタスクレビュー（0a3bf53）: 指摘 0 件（sandbox でテストは流せず、手元で実測済み） / 採る指摘なし
- 2026-09-28 / T06 / release-gate の lib とテストに stage の言い回しが残っていた / 変更欄に `scripts/lib/release-gate.mjs`, `server/test/release-gate.test.ts` を足した
- 2026-09-28 / T03 / Codex のタスクレビュー（19244ee）: 3 件。F1 `--tag` と `--commit` の一致を見ていない、F2 `--pull` の PR が tag のコミットを head に持つかを見ていない、F3 コードブロック内の見出しを節の区切りに読む（再現あり） / 3 件とも採る。修正タスク T07 を足した
- 2026-09-28 / T04 / Codex のタスクレビュー（6ac17a4）: 2 件。F1 承認依頼のコメントが落ちても report-failure が走らない、F2 同じ tag の run が 3 件重なると待機中の run が取り消される / どちらも見送る。F1 はコメントが便利のためのもので、run の URL は Claude が Skill の手順 5 で必ず渡す。F2 は対策の `concurrency.queue: max` を固定の actionlint 1.7.12 が拒否し（実測）、同じ tag を打ち直さない規則と tag のルールセットのもとでは 3 件重なる入力が起きにくい
- 2026-09-28 / 全体 / Codex の全差分レビュー: 3 件。1 publish 後に remote の tag が動いても気づかない、2 渡された merge コミットが PR の実際の merge か確かめない、3 既存の Release の本文が PR のノートと違っても成功扱い / 1 と 2 を採り、修正タスク T08 を足した。3 は Release を手で書き換えたときだけの入力で、オーナーの意図した修正で再実行を落とす副作用があるので見送る
- 2026-09-28 / 全体 / review-shipping: 出してよい。指摘 1 件: npm のレジストリは CDN のキャッシュ（max-age=300）を返すので、publish 直後の finish が落ちうる、merge の失敗時に report-failure が誤って「npm にない」と書きうる（推測、未観測） / report-failure の誤りは T09 で直す。finish は再実行で直るので、Skill に数分待ってから再実行と書くだけにする
- 2026-09-28 / 全体 / Codex の修正分の再レビュー（99435b5..7fff62b）: 指摘 0 件 / 対応なし
- 2026-09-28 / 全体 / PR #182 の CI: 必須チェックとお試し実行、zizmor、actionlint は pass。CodeQL が `scripts/lib/release-finish.mjs:5-7` の HTML コメントの除去を「不完全な複数文字のサニタイズ」（high）として落とした。スキップされたジョブの名前が式のまま出た / T10 と T11 を足した。CodeQL の件は、影響（Release のノートの一部が隠れうる。GitHub が HTML をサニタイズするので実行には至らない見込み）と修正案をオーナーに報告してから直した
- 2026-09-28 / 全体 / GitHub Codex のレビュー（edc1a65）: 5 件（P1 2、P2 3）。ゲートがお試し実行の成功を見ない、テストの子に一時 HOME が無い、merge 前に base を見ない、コードブロックの区切りを種類と長さで対応づけない、承認後に書き換えたノートで Release を作りうる / 5 件とも採り、T12〜T16 を足した
- 2026-09-28 / 全体 / GitHub Codex のレビュー（f462d16）: 4 件（P1 1、P2 3）。冒頭コメントが 6 行、既存の Release の本文を確かめない、公開済みで prepare が落ちると no と誤報、コードブロック内の HTML コメントの例も消す / 冒頭コメントと誤報を T17・T18 で直す。既存の Release（先に誰かが作ったときだけ）とコードブロック内のコメントの例（まれな入力）は見送る
