---
kind: plan
status: approved
codex_session: 01a11016-401e-79b3-b1aa-3e60336cdf8b
codex_rounds: 3
approved_at: 2026-10-06
---

# release の run で、承認の前に出すリビジョンを OSV でスキャンし、merge の後に main の OSV と Scorecard を走らせ直す（#268）

## 要点

- release.yml に `osv` ジョブを足す。タグのコミット（dry run では PR の merge リビジョン）の依存を OSV でスキャンし、run の summary にスキャンした SHA・件数・パッケージの表を出す。見つかっても、スキャンが失敗しても落とさない
- 結果は `found`（N 件）/ `none` / `unavailable`（結果なし・壊れている）の 3 つに分け、承認を頼む PR のコメントに 1 行で載せる。publish はこのジョブを待つので、スキャンが終わる前に承認の待ちに入らない
- merge の後に `refresh-scans` ジョブが `gh workflow run` で main の osv-scanner.yml と scorecard.yml を起こす（両方に `workflow_dispatch` を足す）。起こした run の URL を summary に出し、Claude が plugin-release の 9 段目でその run を最後まで見る
- dispatch の失敗は警告だけで release を落とさない（npm と merge は終わっている）
- plugin-release Skill の 5・7〜9 段と、失敗からの戻し方を直す
- 変えないもの: 持ち主の操作（npm-release の承認 1 回）、シークレットなしの publish、GITHUB_TOKEN での merge、パッケージ（リリースなし）、zizmor

## 持ち主の決定

- 次の作業は Phase 02 の R1 #268 にする（おすすめの提示に「OK、それやろう」）
- #268 の項目: 承認の前に、タグを打ったリビジョンの依存をスキャンして run に結果を出す（今と同じく、見つかっても落とさない）。release の merge の後に OSV と Scorecard の結果を新しくする
- 既存の決定: 持ち主の操作は npm-release の承認 1 回だけで、Claude は代わりに承認しない。release はシークレットを持たず OIDC で publish し、merge は run のトークンで行う

## 目的

- タグの push で走る release の run の summary に、そのタグのコミットのスキャン結果（SHA・状態・件数・表）があり、承認を頼む PR のコメントに 1 行の要約がある
- 同じ run の merge の後に、main を対象にした osv-scanner と scorecard の run が workflow_dispatch で 1 本ずつ起き、その URL が summary にある
- 結果が無いときに「脆弱性なし」と出ない

## 対象外

- zizmor の走らせ直し（#268 は OSV と Scorecard だけを挙げている。zizmor は .github/** を変える PR で走る）
- 承認前のスキャン結果を code scanning に上げること（タグの ref にアラートが付き、閉じる経路が無い）
- 見つかった脆弱性で release を止めること
- check.yml が release の merge の後に main で走らないこと
- GITHUB_TOKEN での dispatch の実走。workflow_dispatch はトリガーが main にあるときだけ起こせるので、この PR では走らない。次の本物のリリースの run で、summary にタグのコミットのスキャン結果、PR のコメントに 1 行の要約、refresh-scans の summary に 2 本の run の URL があり、その 2 本が成功するのを Claude が見てから #268 を閉じる（この plan の完了には含めない）

## 前提

- `.github/workflows/release.yml:368`: merge は GITHUB_TOKEN で行い、ほかの workflow を起こさない。u168 の記録も同じ（2026-10-02）
- GitHub の docs: GITHUB_TOKEN が起こしたイベントは新しい run を作らないが、`workflow_dispatch` と `repository_dispatch` は例外（https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow 、Codex が 2026-10-06 に確認）。workflow_dispatch はそのトリガーが既定ブランチの workflow にあるときだけ起こせる
- google/osv-scanner-action の reusable workflow（a345acff…、v2.6.0）は、スキャンが結果ファイルを書かずに失敗するとジョブを落とす。呼び出す側のジョブには continue-on-error を書けない。中で使う scanner の action は `osv-scanner-action/osv-scanner-action@7f58dd6750d78fc29a900ba64b1a0f946f62fba4`（docker、SARIF は上げない）
- `scripts/lib/release-gate.mjs:61`: タグを打つ head で release（dry run）が成功していることを求める。dry run のジョブが落ちると release に進めない
- ossf/scorecard-action（2d114668…、v2.4.4）の README: 対応するトリガーは push と schedule（既定ブランチ）で、`workflow_dispatch` は experimental。publish_results を有効にした dispatch の run を Scorecard の API が受けるかは未検証
- `gh workflow run` は、作った run の URL を返せるときは返す（gh 2.97.0 の help）。ランナーの gh のバージョンで返るかは未検証
- `bun run release:plan -- --base v0.6.37` → `release kind: none`（2026-10-06）

## 方針

S1: 承認の前のスキャン
- `scripts/lib/osv-summary.mjs` に、OSV の JSON（`--format=json` の出力の文字列、または読めなかったこと）から `{ status, count, markdown }` を作る関数を置く。`status` は `found` / `none` / `unavailable`。ファイルが無い・空・JSON でない・`results` の形が違うときは `unavailable`。`count` は脆弱性 ID の重複を除いた数（aliases はまとめない）。表は package@version ごとに ID を並べる。markdown の見出しにスキャンした SHA を入れる
- `scripts/osv-summary.mjs <results.json> <sha>` が上の関数を呼び、markdown を stdout と `$GITHUB_STEP_SUMMARY` に出し、`status` と `count` を `$GITHUB_OUTPUT` に書く。結果が読めないことでは 0 以外で終わらない
- テストは `server/test/osv-summary.test.ts`。fixture: ファイルなし、空、壊れた JSON、形の違い、0 件、1 件、1 つの ID が 2 パッケージ、複数
- release.yml の `osv` ジョブ: タグの push と pull_request の両方で走る。fork の PR は osv-scanner.yml と同じ条件で外す。`permissions: contents: read`。harden-runner（audit）→ checkout（persist-credentials: false、ref は既定）→ scanner の action（`scan-args` は `--output=results.json`、`--format=json`、`-r`、`./`、`continue-on-error: true`）→ setup-node → `node scripts/osv-summary.mjs results.json "$(git rev-parse HEAD)"`。外から来る値は env で渡し、スクリプトの中に埋め込まない
- `notify-approval` は `needs: [prepare, osv]` にし、コメントに 1 行足す: `OSV scan of <sha>: N known vulnerabilities` / `no known vulnerabilities` / `results unavailable (see the run summary)`
- `publish` は `needs: [sbom, prepare, osv]` にし、条件を `!cancelled()`・タグの push・sbom と prepare の成功にする（osv の結果は問わない）。`notify-approval` も `!cancelled()`・タグの push・prepare の成功にする。osv はジョブ単位で `continue-on-error: true` にする（scanner のイメージの取得は準備処理で、ステップの continue-on-error が効かない）
- release.yml の `pull_request.paths` に `scripts/osv-summary.mjs` と `scripts/lib/osv-summary.mjs` を足す

S2: merge の後のスキャン
- osv-scanner.yml と scorecard.yml の `on` に `workflow_dispatch:` を足す
- release.yml に `refresh-scans` ジョブ: `needs: merge`、タグの push だけ、`permissions: actions: write`、`timeout-minutes: 5`、harden-runner（audit）、checkout なし。`GH_TOKEN: ${{ github.token }}`。osv-scanner.yml と scorecard.yml に 1 回ずつ `gh workflow run <file> --repo "$GITHUB_REPOSITORY" --ref main` を流し、それぞれの出力（run の URL）を summary とログに書く。URL が返らなければ「dispatched; run URL not returned」。失敗は `::warning::` と summary の行にして、もう一方も試し、ジョブは 0 で終わる。report-failure の needs には入れない

S3: plugin-release Skill
- 5 段目: prepare と並んで osv がタグのコミットをスキャンし、summary と PR のコメントに結果が出ること。見つかっても止まらないこと。持ち主は承認の前に run の summary で読める
- 7〜8 段目: merge の後に refresh-scans が main の OSV と Scorecard を起こすこと
- 9 段目: Claude は refresh-scans の summary にある run を `gh run watch <id> --exit-status` で最後まで見る。URL が無ければ未検証と報告し、前の run で代用しない
- 失敗からの戻し方: refresh-scans の失敗は publish のやり直しを意味しない。`gh workflow run <file> --ref main` を手で流す

## 採った案と棄却した案

- 採用: scanner の action を普通のジョブで直接呼び、失敗を `unavailable` として扱う。棄却: OSV の reusable workflow を release.yml から呼ぶ（スキャンの失敗でジョブが落ち、dry run の失敗でタグを打てなくなる。上げない SARIF のために security-events: write が要る）
- 採用: publish が osv を needs で待ち、osv の結果は問わない条件にする。棄却: publish が osv を待たない（スキャンの前に承認・publish に進める）、osv の成功を既定の条件で求める（イメージの取得や準備の失敗で release が止まる）
- 採用: GITHUB_TOKEN の workflow_dispatch で main の workflow を起こす。棄却: merge を PAT か GitHub App のトークンにする（シークレットのない release にシークレットが入る）、release.yml の中で ref: main のスキャンを走らせる（SARIF が呼び出し側のタグの ref で上がり、main のアラートは更新されない）
- 採用: dispatch の失敗は警告だけで、summary の run URL を Claude が見届ける。棄却: dispatch を Node のスクリプトにして偽の gh でテストする（警告だけの 2 行のために足すスクリプトで、トークンの権限や Scorecard の受け付けは偽の gh では確かめられない）
- 採用: Scorecard の dispatch が API に拒まれたら dispatch のときだけ publish_results を切る。棄却: Scorecard を走らせ直しの対象から外す（#268 の項目が残る）

## 手順

- S1: 承認の前のスキャン（要約のライブラリと CLI とテスト、release.yml の osv ジョブ、notify-approval と publish の needs、paths）
- S2: merge の後のスキャン（2 つの workflow の workflow_dispatch、release.yml の refresh-scans）
- S3: plugin-release Skill の 5・7〜9 段と失敗からの戻し方

## 完了条件

- A1: `bun run verify` → 成功。`server/test/osv-summary.test.ts` の全ケースが pass
- A2: `gh run view <この PR の最後の release run の id> --log --job <osv のジョブ id> | grep "OSV scan of"` → PR の merge リビジョンの SHA と、found / none / unavailable のどれかの行が出る（CLI は summary と同じ markdown を stdout にも出す）
- A3: `gh pr checks <PR 番号>` → check、actionlint、zizmor、release（dry run）を含む全項目が pass
- A4: `gh workflow run osv-scanner.yml --repo iroha924/sphica --ref main` → run の URL が返り、`gh run watch <その id> --exit-status` が exit 0（この PR の merge の後に流す）
- A5: `gh workflow run scorecard.yml --repo iroha924/sphica --ref main` → run の URL が返り、`gh run watch <その id> --exit-status` が exit 0（この PR の merge の後に流す。失敗したらリスクの 1 行目）

## リスク

- Scorecard の API が workflow_dispatch の run の publish_results を拒む → A4 で分かる。scorecard.yml の `publish_results` を `${{ github.event_name != 'workflow_dispatch' }}` にする修正を PR で出し、SARIF の code scanning への送信は残す。PR と #268 にそう書く
- ランナーの gh が run の URL を返さない → summary は「run URL not returned」になり、9 段目の見届けは未検証と報告する。#268 は閉じず、run の ID を取る方法を別に考えて #268 に残す
- scanner の docker イメージが取れずにスキャンが失敗する → `unavailable` で表示し、release は止めない。持ち主は承認の前に summary で見る

## 未解決

なし

## 変更履歴
- 2026-10-06 / publish と notify-approval の条件を osv の結果によらないものにし、osv をジョブ単位の continue-on-error にした / T02 のレビューで、scanner のイメージの取得はステップの外で行われ、ステップの continue-on-error が効かないと分かった / Go 不要（範囲・持ち主の操作・止めない約束は同じ）
