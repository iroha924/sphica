---
kind: plan
status: approved
codex_session: 01a0e48e-8dd5-7f23-954b-a5b537e4d66e
codex_rounds: 6
approved_at: 2026-09-28
---

# リリースを GitHub の承認 1 回に絞り、承認の後の publish・merge・検証・GitHub Release を 1 つの run で自動にする（#176、#175）

## 要点

- オーナーの作業は、PR のコメントのリンクから `npm-release` 環境を GitHub で承認する 1 回だけにする。npm の stage と 2FA 承認、`npm dist-tag add` は通常の手順から消える
- release.yml（tag push）の 1 つの run で、prepare → PR へ承認待ちのコメント → 承認 → `npm publish --tag latest`（OIDC、トークンなし）→ PR の merge → 仕上げ（ツリー比較、attestation 検証、`latest` の確認、GitHub Release の作成、PR へのコメント）まで進む。どこかで落ちたら、公開されたかどうかを添えて PR に知らせる
- 承認が唯一の関門になるので、prepare と publish の最初で `npm-release` 環境の設定（レビュアーがオーナー 1 人、admin bypass オフ、tag ポリシー `v*`）を検査し、崩れていたら止まる
- PR の CI ではジョブ名で「お試し実行」と分かるようにし、仕上げの検査も読み取り権限だけで前回のリリースに対して流す。runner は `ubuntu-24.04` に固定し、ref 単位の `concurrency` を足す
- Skill・検査・release-plan・release-status・AGENTS.md・verification.md・PR テンプレート・README の Security 節を新しい流れに揃える。README が変わるので、この PR が 0.5.4 のリリースになり、新しい流れの初回の実測を兼ねる
- 変えないもの: 承認者はオーナーだけ、シークレットとトークンを足さない、trusted publisher のリポジトリ・ワークフロー・環境、`check.yml` と ruleset の必須チェック

## 持ち主の決定

- #176 と #175 を 1 つの計画・1 つの PR で進める（2026-09-28）
- リリースの CI は「リッチで運用が楽、自動化に近いもの」にする（2026-09-28）
- 通常のリリースで npm にはアクセスしない。オーナーの承認は GitHub 上の 1 回だけにし、CI が trusted publishing で直接 publish する。npm の 2FA の関門を外すことを受け入れる（2026-09-28、4 往復の合意の後に持ち主が方針を変更）
- この PC の `gh` はオーナーの `repo`・`workflow` スコープのトークンなので、エージェントが技術的には環境承認の API を叩ける。これを fine-grained トークンや npm 承認で塞がず、「Claude は承認しない」の規範で守る（2026-09-28）
- 承認は GitHub Mobile ではなく GitHub（run のページ）で行う（2026-09-28）

## 目的

0.5.4 のリリースで、オーナーの操作が「PR のコメントのリンクから run を開いて承認」の 1 回だけになり、その run が publish・merge・GitHub Release の作成まで成功して、PR に結果のコメントが付く。`npm view sphica dist-tags --json` の `latest` が 0.5.4 を指す。Claude の手作業は tag push と手元への反映だけになる。

## 対象外

- `check.yml` の分割（1 ジョブ約 1.5 分で短縮の余地が小さく、ruleset の必須チェック名と release-gate の `check` の名前が変わる）
- `cache-mode: none`（リポジトリ固定の actionlint 1.7.12 が未知のキーとして拒否する）
- GitHub Release への tarball・SBOM の添付と immutable releases
- tag push の自動化（tag の作成はルールでオーナーに限り、`GITHUB_TOKEN` で作った tag では release.yml が起動しない）
- エージェントが承認できる経路の技術的な遮断（持ち主の決定。プロジェクトの settings.json の deny もコマンドの書き方ですり抜けられるので入れない）
- `next` の削除（npm の操作が要るので、オーナーの都合のよいときに任意で行う）
- リポジトリ設定のうち、workflow execution protections と SHA 固定の強制（別に提案する）

## 前提

- trusted publisher の設定ごとに直接 `npm publish` を許可でき、「disallow tokens」は OIDC に効かず、GitHub Actions からは provenance が自動で付く。npm は stage-only を強く勧めている。既存の接続は編集できず、消して作り直す（https://docs.npmjs.com/trusted-publishers/ 、2026-09-28）
- 公開したバージョンは unpublish しても使い直せない（https://docs.npmjs.com/policies/unpublish/ 、Codex が確認）
- `npm-release` 環境（2026-09-28 の `gh api`）: 必須レビュアー iroha924 のみ、`prevent_self_review: false`、`can_admins_bypass: true`。`deployment-branch-policies` の実際の応答は `{"name":"v*","type":"tag"}` の 1 件（ドキュメントの例には `type` が無いが、実物は返す）
- 環境の必須レビュアーは誰か 1 人の承認で通る。承認は run のページ、GitHub Mobile、REST API（`pending_deployments`、必須レビュアー本人のトークン）でできる（GitHub のドキュメント）
- この PC の `gh` はオーナーのアカウントで、スコープは `repo`、`workflow` ほか（`gh auth status`）
- `GITHUB_TOKEN` による merge などのイベントは新しい run を起動しない（https://docs.github.com/en/actions/concepts/security/github_token ）。そのため merge の後の仕上げは同じ run で行う
- merge の API は `contents: write` のインストールトークンで使え、head SHA を条件に付けられる。ruleset の必須チェックはそのまま効く（Codex が確認。このリポジトリでの実走は未検証）
- main の ruleset: PR 必須、merge 方式は `merge` のみ、必須チェック `check (24.15)`・`check (26)`・`windows`・`codex-review`、strict
- 依存が失敗したジョブは、`always()` や `failure()` の条件を付けないと走らない（GitHub のワークフロー構文）
- stage（今後は publish）のジョブは、prepare の SHA-512 と照合してから `actions/attest` で署名する。npm の tarball の attestation が通れば、prepare が検査した tarball と同じバイト列
- `gh attestation verify` に `--source-ref` がある（Codex が確認）
- ジョブ名の式は全体を引用する（引用しないと `:` で YAML が壊れる。actionlint 1.7.12 で Codex が実測）
- `ubuntu-latest` は 2026-10-19〜11-19 に 26.04 へ移る。harden-runner の許可リストは 24.04 で観測したもの
- README.md:199-201 は「npm に stage し、メンテナーが 2FA で承認する」と公開している。README はパッケージの入力（`scripts/lib/release-scope.mjs:12-13`）なので、直すと release kind が `plugin` になる
- 旧手順を名指ししている箇所: `release.yml`、`.agents/skills/plugin-release/SKILL.md` の Shipping、`scripts/check-ai-config.mjs`（`releaseOrder`、オーナー手順のアンカー、release-plan のオーナー action、verification.md の必須文言、release-status の `npm@11.19.0 stage`、`npm stage approve`、`npm publish` の検査）、`scripts/release-plan.mjs:59-75`、`scripts/release-status.mjs`（stage の一覧、`next`）、`AGENTS.md:49`、`.claude/rules/verification.md:8-9`、`.github/pull_request_template.md:36`、`README.md:199-201`

## 方針

### 1 回のオーナーの設定（0.5.4 の tag の前）

- npmjs.com: 今の stage-only の trusted publisher を消し、同じリポジトリ `iroha924/sphica`・ワークフロー `release.yml`・環境 `npm-release` で、直接 `npm publish` を許可した設定を作り直す。「require 2FA and disallow tokens」はそのまま
- GitHub: `npm-release` 環境の admin bypass をオフにする
- どちらも Skill の「最初のリリースの前に一度だけ」の一覧に書く

### 環境の検査

- `scripts/lib/release-env.mjs`（判定だけ）と `scripts/release-env.mjs`（`gh api` で環境とポリシー一覧を取る）
- 通る条件: `required_reviewers` の規則がちょうど 1 つ、レビュアーがちょうど 1 人で種類 User・login `iroha924`、`prevent_self_review == false`、`can_admins_bypass == false`、`deployment_branch_policy.custom_branch_policies == true`、ポリシー一覧がちょうど `{name: "v*", type: "tag"}` の 1 件。API の失敗は落とす
- prepare（承認の前）と publish の最初で流す。今の prepare の「承認者がいるか」のステップはこれに置き換える

### release.yml（tag push の run）

- ジョブの流れ: `sbom` → `prepare` → `notify-approval` と `publish`（環境 `npm-release`）→ `merge` → `finish`、どこかで落ちたら `report-failure`
- `prepare`: 今の検査に環境の検査を足す。release-gate は通過時に `GITHUB_OUTPUT` へ `pull=<N>` を書き、`pull` を prepare の output にする。job summary に「v<version> waits for the owner's approval of npm-release: <run URL>」と SHA-512
- `notify-approval`: `pull-requests: write` だけ、checkout なし。PR に summary と同じ行をコメントする。値は `env:` 経由で、本文はファイルで渡す。publish はこのジョブに依存しない
- `publish`: 環境 `npm-release`、`id-token: write`・`attestations: write`・`contents: read`・`actions: read`・`pull-requests: read`（環境の検査と release-gate の再確認が読む）。環境の検査、release-gate の再確認、SHA-512 の照合、SBOM の attestation、`npm publish "$RUNNER_TEMP/release/$TGZ" --tag latest --provenance`。harden-runner は block のまま、publish の宛先で許可リストを確かめ直す
- `merge`: `contents: write`・`pull-requests: write`。PR が開いていて head が tag のコミットであることを確かめ、`gh pr merge <N> --merge --match-head-commit <sha>`（`GITHUB_TOKEN`）
- `finish`: `contents: write`・`pull-requests: write`（`attestations: read` の要否は実装時に確かめる）。`scripts/release-finish.mjs`
- `report-failure`: `needs: [prepare, publish, merge, finish]`、依存の失敗でも走る条件（`if: always() && github.event_name == 'push' && contains(needs.*.result, 'failure')`）、`pull-requests: write` だけ。`npm view sphica@<version> version` で公開済みか（yes / no / unknown）を確かめ、どのジョブが落ちたか、公開の有無、Skill の復旧の節を PR にコメントする
- 共通: ジョブ名をイベントで切り替える（例: `name: "${{ github.event_name == 'push' && format('release {0}: publish', github.ref_name) || 'dry run: prepare' }}"`、式は全体を引用）、全ジョブ `runs-on: ubuntu-24.04`、ワークフローに `concurrency: { group: release-${{ github.ref }}, cancel-in-progress: false }`、1 ファイルのまま
- PR の run: `sbom`、`prepare`（環境の検査と gate は tag push のときだけ）、`finish-dry-run`（`contents: read` だけ。`npm view sphica version` の公開済みバージョンと main 上のその merge コミットに対して、`release-finish.mjs --dry-run` を流し、Release の作成とコメントはしない）

### release-finish

- ロジックは `scripts/release-finish.mjs`（git・gh・npm を呼ぶ）と `scripts/lib/release-finish.mjs`（判定だけ）
- 検査（順に）
  1. `git diff --exit-code <tag のコミット> <merge コミット>`
  2. `npm pack sphica@<version>` を一時ディレクトリに取り、`gh attestation verify <tgz> --repo iroha924/sphica --predicate-type https://cyclonedx.org/bom --signer-workflow iroha924/sphica/.github/workflows/release.yml --source-ref refs/tags/v<version>`
  3. `npm view sphica dist-tags --json` の `latest` が `<version>`
  4. `commits/<tag のコミット>/pulls` から PR を引き、本文の `## Release notes` 節を取り出す。無いか空なら失敗
  5. `gh release view v<version>` があれば作らない（再実行で重複しない）。無ければ `gh release create v<version> --verify-tag --title v<version> --notes-file <file>`
- 本文はファイルに書いて渡し、シェルに展開しない。`check-tarball.mjs` は流さない（attestation の一致で prepare の検査を引き継ぐ）
- 成功したら結果を PR にコメントする（`--dry-run` ではしない）

### 手順と検査を揃える

- Skill の Shipping
  - オーナーの表は「`npm-release` 環境を run のページで承認する」の 1 行だけ（と、到着後の `/reload-plugins`）
  - 手順: バージョンを揃える → PR と CI と Codex レビュー → Claude が PR の head に tag を push → run を見守り、PR の承認待ちのコメント（run の URL）をオーナーに渡す → オーナーの承認 → run の成功を確かめる（publish、merge、finish）→ 到着の確認
  - 復旧の節
    - publish の前に落ちた: 何も公開されていない。直して、バージョンを上げて tag を打ち直す（同じ `v<version>` を打ち直さない規則は残す）
    - publish の後、merge で落ちた: オーナーが `latest` を直前のバージョンに戻すかを決める（`npm dist-tag add sphica@<直前> latest`、npm の操作が要る）。Claude は PR を直し、新しいバージョンで出す。公開したバージョンは使い直さない
    - merge の後、finish で落ちた: 何も公開し直さない。Claude が finish のジョブを再実行するか、残した手動のコマンド（`git diff --exit-code`、`npm pack` と `gh attestation verify`、`gh release create`）で失敗した検査をやり直す
  - stage、Staged Packages、`npx -y npm@11.19.0 stage`、`npm dist-tag add`（通常手順）、`next` の記述を消す
- `scripts/check-ai-config.mjs`
  - `releaseOrder`: `git tag v<version> <head>` → tag の run の成功を確かめる手順、の順を見る。stage と dist-tag の項目を外す
  - オーナー手順のアンカー: 「The owner approves the `npm-release` environment」だけにする
  - release-plan に要るオーナー action: 「owner: approve the npm-release environment」だけにする
  - verification.md の必須文言の「the tarball `.github/workflows/release.yml` stages」を新しい文言に合わせる
  - release-status の `npm@11.19.0 stage` の検査と `npm stage approve` の検査を外す
  - `npm publish` の検査は「Shipping に Claude が流す `npm publish` を書かない」（publish は CI だけ）にする
  - 「Claude が承認する文」を拒む検査は残す
- `scripts/release-plan.mjs` の actions: tag push → run の URL をオーナーに渡す → owner: approve the npm-release environment → run の成功を確かめる → `bun run release:status` → キャッシュの更新
- `scripts/release-status.mjs`: stage の一覧と `next` の表示・比較を外す
- `AGENTS.md:49` と `.claude/rules/verification.md:8-9`: オーナーの手順は「`npm-release` 環境の承認」だけ。Claude は承認しない（API も含む）
- `.github/pull_request_template.md:36`: 「After promotion to latest」を新しい流れに合わせる
- `README.md` の Security 節: 「PR の head の tag から GitHub Actions が作り、メンテナーが GitHub で承認すると trusted publishing で公開する。npm のページから、作ったワークフローとコミットを辿れる」に直す
- バージョン: npm と 3 つのマニフェストを 0.5.4 に揃える（`release:plan` の判定に従う）

## 採った案と棄却した案

- 採用: GitHub の承認 1 回 + OIDC での直接 publish。棄却: npm の stage と 2FA 承認を残す（持ち主が npm へのアクセスをやめたい）、GitHub Mobile で承認（持ち主が取りやめた）、npm の承認だけにして merge を定期ワークフローで自動にする（npm へのアクセスが残る）
- 採用: トークンなしの trusted publishing。棄却: bypass-2FA のトークンを secrets に置く（トークンを盗まれたら publish でき、期限の管理も要る）
- 採用: エージェントの承認は規範で防ぐ（持ち主の決定）。棄却: `gh` を Deployments 書き込みなしの fine-grained トークンにする（持ち主が選ばなかった）、settings.json の deny（すり抜けられる見せかけになる）
- 採用: publish・merge・finish を tag の run の中で続けて行う。棄却: main への push で別のワークフローを起動する（`GITHUB_TOKEN` の merge では起動しない）、定期ワークフロー（publish が CI の中なので待つ相手がない）
- 採用: 環境の設定をレビュアーの同一性まで検査して落とす。棄却: レビュアーが 1 人以上いるかだけを見る（誰でも 1 人の承認で通るので、オーナー以外が足されても気づかない）
- 採用: 落ちたときの通知は独立した `report-failure` で、公開の有無を添える。棄却: finish だけがコメントする（merge で落ちると finish が走らない）
- 採用: release.yml は 1 ファイルのままジョブ名を切り替える。棄却: 再利用ワークフローに分ける（npm は呼び出し元のファイル名で照合するので利点がなく、publish を外に出すと信頼の範囲が広がる）
- 採用: finish は attestation で prepare の検査を引き継ぎ、`check-tarball.mjs` を流さない。棄却: `check-tarball.mjs` にバージョンを渡して流す（検査の重複と分岐の増加）
- 採用: release-gate の出力は子プロセスのテストで確かめる。棄却: 出力行を作る関数の単体テストだけ（スクリプトが実際に書くかを見ない）
- 採用: この PR を 0.5.4 として新しい流れで出す。棄却: README を直さずに後回しにする（公開の説明が実態と食い違う）

## 手順

- S1: release-gate が `GITHUB_OUTPUT` に PR 番号を書く（偽の git・gh・npm を使う子プロセステスト付き）
- S2: 環境の検査（`scripts/lib/release-env.mjs`、`scripts/release-env.mjs`、単体テスト）
- S3: release-finish（`scripts/lib/release-finish.mjs`、`scripts/release-finish.mjs`、単体テストと子プロセステスト）
- S4: release.yml を新しいジョブの流れにする（ジョブ名、`ubuntu-24.04`、`concurrency`、環境の検査、`notify-approval`、`publish`、`merge`、`finish`、`report-failure`、`finish-dry-run`）
- S5: Skill、check-ai-config、release-plan、release-status、AGENTS.md、verification.md、PR テンプレート、README を揃える
- S6: バージョンを 0.5.4 に揃える

## 完了条件

- A1: `bun run verify` → exit 0
- A2: `bun run --cwd server test -- --test-name-pattern "release-gate"` → 通過時に `GITHUB_OUTPUT` に `pull=<N>` が書かれ、落ちたときは何も書かれない。変更前のスクリプトでは前者が落ちる
- A3: `bun run --cwd server test -- --test-name-pattern "release-env"` → オーナー 1 人・bypass オフ・`v*` の 1 件で通り、レビュアーの追加、別人、`prevent_self_review: true`、`can_admins_bypass: true`、ポリシーの追加・変更、API の失敗でそれぞれ落ちる
- A4: `bun run --cwd server test -- --test-name-pattern "release-finish"` → release でないときに何もしない、Release を作る、既にあれば作らない、ノートが無ければ exit 1、ツリーが違えば exit 1、`--dry-run` で作成もコメントもしない
- A5: `rg -n -- "npm stage|Staged Packages|--tag next|dist-tag add sphica@<version> latest|registry next|promotion to latest" .github scripts .agents AGENTS.md .claude/rules README.md` → 0 件
- A6: `bun run release:plan -- --base v0.5.3` → `release kind: plugin`、4 つのバージョンが 0.5.4
- A7: `gh pr checks <PR>` → `check (24.15)`、`check (26)`、`windows`、`codex-review`、`dry run: sbom`、`dry run: prepare`、`dry run: finish`、zizmor がすべて pass。`gh api "repos/iroha924/sphica/code-scanning/alerts?ref=refs/pull/<PR>/merge&state=open&tool_name=zizmor"` → 0 件
- A8: 0.5.4 の tag の run で `gh pr view <PR> --comments` → 承認待ちのコメントがあり、URL が承認待ちの run を指す。承認の後に `gh run view <run> --json jobs` → `publish`、`merge`、`finish` が success、`report-failure` が skipped。`npm view sphica dist-tags --json` → `latest` が 0.5.4。`gh pr view <PR> --json state` → MERGED。`gh release view v0.5.4` → PR 本文の Release notes と同じ本文。`bun run release:status` → 残りなし

## リスク

- エージェントがオーナーのトークンで環境を承認し publish する → 持ち主の決定として規範で守る。check-ai-config が「Claude が承認する」文を拒む。起きたら、その run のバージョンを deprecate し、`gh` のトークンを絞る判断に戻す
- 承認が唯一の関門なので、環境の設定が変わると無防備になる → prepare と publish の最初で環境の検査が落とす
- publish の後に merge できない（main が動いた、チェックが外れた）→ `report-failure` が公開済みとコメントする。オーナーが `latest` を戻すかを決め、新しいバージョンで出す
- `GITHUB_TOKEN` の merge が ruleset に拒まれる（未検証）→ 0.5.4 で確かめる。拒まれたら Claude が `--match-head-commit` で手で merge し、finish を手動の手順で行って、この計画を開き直す
- `GITHUB_TOKEN` の merge では main への push のワークフロー（`check` のバージョン検査など）が走らない → 同じコミットを PR の CI が検査済みで、strict で main が祖先であることも gate が確かめている
- npm の trusted publisher を作り直す間に、設定の不一致で publish が失敗する → publish の前は何も公開されない。直して新しいバージョンで出す
- tag push でしか走らない経路（gate の出力、通知、publish、merge、finish、report-failure）は PR の CI では流れない → 0.5.4 のリリースが実測になる。それまでは未検証と PR に書く

## 未解決

なし

## 変更履歴

- 2026-09-28 / npm の stage と 2FA 承認をやめ、GitHub の承認 1 回と直接 publish、同じ run での merge と仕上げに変えた。README が変わるので 0.5.4 のリリースを含めた / 持ち主が npm へのアクセスをやめると決めた / 要（Go の前）（Go 済み 2026-09-28）
