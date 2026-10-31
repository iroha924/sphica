---
kind: plan
status: approved
codex_session: 01a19060-662f-7b32-9497-f5f6c1e3518f
codex_rounds: 2
approved_at: 2026-10-31
---

# GitHub Actions の workflow lockfile を全ワークフローに入れ、Action の取得元を実行時に照合させる

## 要点

- `.github/workflows/actions.lock` を `gh actions-lock`（v0.4.0）で作り、6 本のワークフローを載せる。Action とその推移的な依存が、元のリポジトリの同一性（owner_id / repo_id）と、タグから辿れるコミットで実行時に照合される
- `uses:` 行は今の 40 桁 SHA と `# vX.Y.Z` のコメントのまま残す（リリース済みの zizmor と Scorecard が SHA の行を見るため）。ツールが出す `sha-as-ref` の警告は受け入れる
- lockfile は `gh actions-lock --no-narrow` で作る。`uses:` 行を書き換えず、key が SHA（ref に完全なタグを記録）のエントリになる
- `zizmor.yml` に `actions-lock` ジョブ（`gh actions-lock --verify`）を足す。`release.yml` の PR の起動条件に `actions.lock` を足し、lockfile の変更で dry run が走るようにする
- `ASSURANCE.md` の供給網の記述に lockfile と、その対象外（reusable workflow、コンテナイメージ、run で取るツール）を書く
- 確かめ方: CLI の `--verify`、PR の各ジョブの取得ログ、使い捨ての draft PR で依存を欠かせた負例
- 変えないもの: パッケージ（release kind は none）、リポジトリ設定（Require lockfile ポリシー、ruleset の必須チェック）、Dependabot の設定、osv-scanner の reusable workflow の固定方法

## 持ち主の決定

- 「これ対応できるならした方が良さそう」（2026-10-31、Zenn の lockfile の記事と @IT の GitHub の脆弱性の傾向の記事を読んで）
- 進め方は「計画を Codex と詰める → Go → PR」。「OK、進めて」（2026-10-31）
- Require lockfile ポリシーの有効化と ruleset の必須チェックの変更は範囲外。しばらく運用してから別に判断する（同じ提案への「OK」で決まった）

## 目的

- 6 本のワークフローのすべての Action（推移的な依存を含む）が lockfile に載り、`gh actions-lock --verify` が valid になる
- runner が lockfile で照合して Action を取る。依存が lockfile に無いジョブは初期化で落ちる
- SHA 固定だけでは防げない、fork にしかないコミット（impostor commit）と、リポジトリ名の乗っ取り（repojacking）を実行前に止める

## 対象外

- Require lockfile ポリシーと ruleset の必須チェック（持ち主の決定）。`actions-lock` ジョブは必須にしない
- `uses:` 行をタグに移すこと。zizmor の lockfile 対応（zizmor PR #2463、2026-10-23 merge）がリリースされ、Scorecard も対応した後に別途判断する
- osv-scanner の reusable workflow（`jobs.<id>.uses`）。lockfile の対象外なので、今の SHA 固定のまま
- scorecard-action のコンテナイメージ（`ghcr.io/ossf/scorecard-action:v2.5.0`、digest なし）。上流の問題で、lockfile は固定しない
- 拡張のバージョンを `check-pairs.mjs` の組に足すこと。書くのは 1 か所だけなので比べる相手が無い

## 前提

- lockfile の仕様: https://docs.github.com/actions/concepts/security/workflow-dependency-lockfiles 、https://docs.github.com/en/actions/how-tos/secure-your-work/lock-workflow-dependencies （2026-10-31 閲覧）。reusable workflow と runner image は対象外。onboard したワークフローは全依存が lockfile に要る。Dependabot は onboard 済みのワークフローの更新 PR で lockfile のエントリを作り直す
- GA: https://github.blog/changelog/2026-10-28-github-actions-workflow-lockfiles-are-generally-available （2026-10-31 閲覧）
- 拡張: https://github.com/github/gh-actions-lock （github org、2026-04-22 作成）。v0.4.0 は 2026-10-23 公開で immutable release。`--verify` は書き込まずに「runner が拒む pin」まで見る。`--verify-local` は網羅だけで来歴を見ない
- 実測（2026-10-31、v0.4.0、main = dafe5b40 の使い捨て worktree）: 今の main は `not-pinned` 22 件で valid=false。`gh actions-lock` は 5 本の YAML の SHA の行をタグの行へ書き換え（61 行）、lockfile の key はタグ（例 `actions/checkout@v7.0.1`、`commit: sha1-3d3c42e…`）。推移的な依存として `github/codeql-action@2892aa5…`（`ref: v4.38.2`、zizmor-action 経由）が入る。`osv-scanner.yml` は `[]`。YAML を SHA の行に戻すと `--verify` は valid（警告は `sha-as-ref` 21 件と `container-image` 1 件）。SHA の行のまま `gh actions-lock` を流すと、またタグの行に書き換える。この書き換えは既定の narrow の動き（`--no-narrow` で止まる。下の実測）
- 上流がタグを動かしたとき（v0.4.0 の `internal/pipeline/parity.go` は `exactTag` を lockfile の key の側で判定し、`parity_test.go` の `TestMovedTagFinding` が full-SHA の pin を扱う）: key が SHA なので `tag-commit-mismatch` にはならない。固定したコミットが動いた先のタグの履歴に残れば `ref-moved` の警告で、GitHub は固定したコミットのまま受け付ける。残らなければ `unreachable-pin` のエラー。`--relock` は SHA の `uses:` を変えないので、新しいコミットに進めるには `uses:` の SHA と版のコメントを書き換えてから方針 1 で作り直す。別のリポジトリへの置き換え（`repo-replaced`）もエラー
- zizmor: 固定している 1.30.1 と最新の 1.31.1 は lockfile を読まず、`unpinned-uses` は `uses:` の hash で判定する。Scorecard v5.6.0（scorecard-action v2.5.0）の Pinned-Dependencies も `uses:` の SHA を見る（Codex が上流のソースで確認）
- 必須チェック（ruleset `main`）: `check (24.15)`、`check (26)`、`windows`、`verification-section`。zizmor.yml のジョブは必須ではない
- `release.yml`: `pull_request.paths`（:16〜）に `actions.lock` は無い。publish ジョブ（:321、push だけ）の中で `actions/attest`（:410）が `npm publish`（:419）より前にある。PR の dry run では attest は走らない
- release kind: `.github/` と `ASSURANCE.md` は `scripts/lib/release-scope.mjs` のパッケージの入力に無い（Codex が分類関数で none を確認。実装でステージ後に `bun run release:plan` で確かめる）
- 実測（2026-10-31、PR #398 の最初の push 8d613c65〜df19c187）: key がタグの lockfile と SHA の行の組み合わせは、GitHub がワークフローの読み込みで拒んだ。4 本の PR の run がすべて `startup_failure`、`gh workflow run scorecard.yml` は HTTP 422「references actions not present in the lockfile: step-security/harden-runner@dc2769ab…」。GitHub は `uses:` の参照をそのまま key として lockfile を引く。手元の `--verify` はこの組み合わせを valid としたので、CLI の valid は GitHub が受け付けることの裏付けにならない
- 実測（同日）: `gh actions-lock --no-narrow` は `uses:` 行を変えず、key が `owner/repo@<40 桁 SHA>`、`ref` が完全なタグ（例 `v7.0.1`）のエントリを書く。`--verify` は valid（警告は `sha-as-ref` 21 と `container-image` 1）。上流 issue #130 でメンテナーが SHA の行を保つ方法として案内している。SHA を key にしたエントリで fork にしかないコミットが通った問題（上流 #174）は、v0.3.0 のリリースノートで CLI 側の修正（#186）が出ており、GitHub 側はその前に直したとメンテナーが書いている
- 未検証: GitHub が SHA の key を受け付けるか（A5、A8）。Dependabot が SHA の行と SHA の key を保つか。attest の runner での照合

## 方針

1. lockfile の作り方（初回と、人が Action を上げるとき）: 作業ツリーで `gh actions-lock --no-narrow` を流す。`uses:` 行は変わらず、`actions.lock` だけが変わる。流した後、`gh actions-lock --verify --json` が valid（error 0）で、`git diff -- '.github/workflows/*.yml'` に意図した変更しか無いことを確かめる。`--no-narrow` を付け忘れると SHA の行がタグに書き換わるので、その差分は取り込まない
2. `uses:` 行は 40 桁 SHA と `# vX.Y.Z` のまま。`sha-as-ref` と `container-image` の警告は受け入れる
3. `zizmor.yml` に `actions-lock` ジョブを足す: `runs-on: ubuntu-latest`、`timeout-minutes: 10`、`permissions: contents: read`、ジョブの `env: GH_TOKEN: ${{ github.token }}`（install と verify の両方に効かせる）、harden-runner（`egress-policy: audit`）と `actions/checkout`（`persist-credentials: false`）は他のジョブと同じ SHA、`gh extension install github/gh-actions-lock --pin v0.4.0`、`gh actions-lock --verify`。zizmor ジョブの fork 除外の `if` は写さない（fork の PR でも read 権限で走らせる）。新しいジョブ自体も lockfile に載るので、ジョブを足してから方針 1 で lockfile を作る
4. `release.yml` の `pull_request.paths` に `.github/workflows/actions.lock` を足す。attest を解決させるだけの `if: false` のステップは足さない（attest も他と同じ「SHA の行 + SHA の key」で照合され、その組み合わせは PR で runner が受け入れることを確かめる。`--verify` が release.yml の依存を静的に照合する。照合で落ちても publish ジョブの初期化で落ち、`npm publish` より前なので npm には何も出ない）
5. 説明の範囲: 「必須の check ジョブ自身の依存の不整合は runner が拒む。全ワークフローの整合は zizmor.yml の actions-lock ジョブで見る（必須ではない）」。lockfile が古いと必須チェックが全部落ちる、とは書かない
6. `ASSURANCE.md:53` の「Third-party actions are pinned to commit SHAs」を直し、Action とその推移的な依存は lockfile でリポジトリの同一性とタグから辿れるコミットまで照合すること、reusable workflow・コンテナイメージ・run で取るツールは対象外であることを英語で書く。:77 の表の「Pinned actions」も合わせる
7. Dependabot: 設定は変えない。最初の更新 PR で、SHA と版のコメント、lockfile の commit/ref、推移的な依存、owner_id/repo_id、`--verify`、CI を確かめる。タグの行に変えてきたら自動では取り込まず、方針 1 の手順で SHA の行に戻して lockfile を作り直す（この計画の PR の後のことなので、手順だけを PR 本文に残す）
8. 負例（runner が本当に照合していることの確認）: 作業 PR の最終 head から使い捨てのブランチを切り、base=main の draft PR を出す。差分は lockfile の `workflows` の `.github/workflows/check.yml` の一覧から `oven-sh/setup-bun@v2.2.0` を外す 1 行だけ（共有の `dependencies` の定義は残す）。合格は、setup-bun を使う `part` などのジョブが「Set up job」で依存が無いことを理由に落ちること（集約の `check` の失敗だけでは足りない）。PR のタイトル・本文・コミットのメッセージに「意図的な検証で、採用も merge もしない」と、目的・欠かせた依存・期待する失敗を書き、関連付けは `Refs` だけ（`Closes`/`Fixes` は使わない）。確かめたら実測（head、run の URL、失敗の理由）を本文に足し、PR を閉じてブランチを消す。作業 PR の本文にも負例の PR・head・run・結果を残す。draft PR の本文と作るコミットは外へ出すものなので、出す前に文面を持ち主に見せる
9. release kind は none の見込み。変更をステージしてから `bun run release:plan -- --base v0.6.70` で確かめる。none でも review-shipping と Codex のレビュー（`codex-review` Skill）を通す

## 採った案と棄却した案

- 採用: `uses:` 行は SHA のまま、lockfile を足す。棄却: ツールの既定どおりタグの行に移す（リリース済みの zizmor 1.30.1 の `unpinned-uses` と Scorecard の Pinned-Dependencies が SHA の行を見るので、検査の結果が悪くなる。lockfile が効かない経路への保険も無くなる）
- 採用: `--no-narrow` で作り、key を SHA にする。棄却: 既定（narrow）で作った key がタグの lockfile を SHA の行と組み合わせる（GitHub がワークフローの読み込みで拒んだ。PR #398 の最初の push で実測）。棄却: 使い捨ての worktree で既定のまま作り lockfile だけを写す（上の理由で使えない形の lockfile になる）
- 採用: `zizmor.yml` に独立したジョブ。棄却: `check.yml` に入れる（集約 `check` の条件と same-tree / release-verdict の判定に触れる）、新しいワークフロー（`.github/**` の起動条件をもう 1 本持つことになる）
- 採用: 拡張は `--pin v0.4.0`（immutable release のタグ）。棄却: コミット SHA で入れる（`gh extension install --pin` はバイナリ拡張ではリリースのタグからアセットを選ぶ）
- 採用: attest は静的な `--verify` と、同じ形の Action が runner で通ることで確かめ、未実走と明記する。棄却: release.yml に `if: false` の解決用ステップを足す（使わないステップを保守し続ける費用に見合わない。落ちても publish より前）
- 採用: 負例は使い捨ての draft PR で確かめる。棄却: 作業 PR に壊したコミットと戻すコミットを積む（リリースは merge commit で入るので、壊したコミットが main の履歴に残る）

## 手順

- S1: `zizmor.yml` に `actions-lock` ジョブ、`release.yml` の `pull_request.paths` に `actions.lock` を足し、方針 1 で lockfile を作って入れる
- S2: `ASSURANCE.md` の供給網の記述を直す

PR の CI での正常例（A5）と使い捨ての draft PR での負例（A6、方針 8）は、コードを変えないので手順に入れず、完了条件で確かめる。

## 完了条件

- A1: 作業ツリーで `gh actions-lock --verify --json` → exit 0、`valid: true`、error 0（警告は `sha-as-ref` と `container-image` だけ）
- A2: `git diff main -- '.github/workflows/*.yml' | rg '^[-+]\s+(- )?uses:'` → actions-lock ジョブで足した harden-runner と checkout の `+` の 2 行だけ（既存の `uses:` 行は変えていない）
- A3: `bun run release:plan -- --base v0.6.70` → kind が none（変更をステージした状態で流す）
- A4: `mise exec -- bun run verify` → exit 0
- A5: `gh pr checks <作業 PR>` → check.yml・zizmor.yml（actions-lock を含む）・release.yml（dry run）・pr-body.yml の全ジョブが pass。加えて `gh run view <check.yml の run> --log | rg "Download action repository"` と release.yml の dry run の run で同じことを流す → 取得した Action の SHA が lockfile の `commit` と一致する。`actions/attest` は runner で未実走と PR 本文に書く
- A6: `gh run view <負例の run> --log-failed` → `part` のジョブが「Set up job」で、setup-bun の依存が lockfile に無いことを理由に落ちている。run の URL と失敗の行を作業 PR の本文に残す。続けて `git ls-remote origin <負例のブランチ>` → 空（draft PR は閉じてある）
- A7: `gh api 'repos/iroha924/sphica/code-scanning/alerts?ref=refs/pull/<作業 PR>/merge&state=open&tool_name=zizmor' --jq '[.[] | select(.rule.id | test("unpinned-uses"))] | length'` → 0
- A8: `gh workflow run scorecard.yml --ref ci/actions-lockfile` と `gh workflow run osv-scanner.yml --ref ci/actions-lockfile` の後、`gh run view <各 run> --log | rg -n "Download action repository|lockfile"` → 両方の run の各ジョブが「Set up job」を通っている（lockfile で拒まれていない）。scorecard の結果の公開など、それより後のステップがブランチの上で落ちるのは対象外。PR では走らないこの 2 本を merge 前に runner に当てる

## リスク

- GitHub が SHA の key も拒む → A5・A8 と dispatch の 422 で分かる。lockfile を外して終わりにはせず、タグの行に移す案と A7 を見直して持ち主に戻す
- 負例でジョブが落ちない（runner が lockfile を見ていない）→ 目的が満たせない。Require lockfile ポリシーが要るのかを公式資料で確かめ、持ち主に戻す（ポリシーの有効化は範囲外なので勝手に入れない）
- 上流の pin が到達できなくなる、またはリポジトリが置き換わる → 全 CI が落ちる。それが狙い。`--accept-moved` は上流の履歴を確かめてから人が流し、自動化では使わない
- 上流がタグを動かす → 先へ進んだだけなら警告で、固定したコミットのまま動く（止まらないことを不具合と取り違えない）。履歴から外れたら `unreachable-pin` で actions-lock ジョブが落ちる。どちらも上流のリリースノートと履歴を確かめてから、`uses:` の SHA を人が書き換える。`--accept-moved` は自動化では流さない
- publish ジョブだけの依存（attest）が runner で拒まれる → 最初のリリースで publish の初期化で落ちる。npm には出ないので、直して次のバージョンで出す
- Dependabot が SHA の行をタグの行に変える → 方針 7 の手順で戻す

## 未解決

なし

## 変更履歴
2026-10-31 / 完了条件に A8 を足した / review-shipping の指摘: scorecard.yml（docker の Action と codeql-action のサブパス）と osv-scanner.yml（reusable workflow、lockfile では `[]`）は PR では走らず、runner での照合が merge 後まで分からない / Go 不要（確かめる項目を足すだけで、範囲・公開契約・依存・データは変わらない）
2026-10-31 / 前提の 47 行目、A2、リスクの「SHA の行でタグが進む」を直した / 全差分の Codex レビュー F1（lock の key が完全なタグなら SHA の行でも tag-commit-mismatch のエラーになる。v0.4.0 の parity.go で確認）と F2（A2 の期待が T01 の正しい結果と食い違う） / Go 不要（記述と完了条件の期待を実装に合わせるだけ）
2026-10-31 / lockfile を `--no-narrow` で作り直し、key を SHA にした。前提・方針 1・採った案・リスクを直した / key がタグの lockfile と SHA の行の組み合わせを GitHub がワークフローの読み込みで拒んだ（PR #398 の全 run が startup_failure、dispatch が 422） / 持ち主に 3 案（--no-narrow で続ける / タグの行に移す / 閉じる）を示し、「1」（--no-narrow）の Go を受けた
2026-10-31 / 前提（タグが動いたときの扱い、narrow の書き換え）とリスクを直した / T04 の Codex レビュー F1（key が SHA なら tag-commit-mismatch にならず、先へ進んだタグは警告。`--relock` は SHA の uses を変えない。v0.4.0 の parity.go と parity_test.go で確認）と F2（「書き換えを止めるフラグは無い」が誤り） / Go 不要（記述を実装と上流のソースに合わせるだけ）
