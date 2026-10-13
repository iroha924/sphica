---
kind: plan
status: approved
codex_session: 01a133e8-b8e7-78f0-aca5-0e376e925b6b
codex_rounds: 2
approved_at: 2026-10-13
---

# parseDiff が、削除されたファイルの後ろのファイルの added 行と行番号を失わないようにする（#336）

## 要点

- **修正**: `parseDiff`（`server/src/review.ts`）は、削除されたファイルの hunk の行を数えずに残すので、次のファイルの `@@` 行が前の hunk の行として読まれ、次のファイルの added 行が消える（削除 1 行）か、行番号がずれる（削除 3 行以上）。hunk の行は、そのファイルを残すかどうかによらず数えて消費するように直す
- **テストを 3 つ足す**: issue の例の単体テスト、property（削除ファイルの行数と中身が何でも、後ろのファイルの結果は単独のときと同じ）、実際の git リポジトリで review の前の配信に記録が入ること。3 つとも、直す前のコードで落ちることを先に確かめる
- **出し方**: 0.6.54 として 1 つの PR（npm と 3 つの manifest）。`mcp.js`（`review_select` / `review_check`）と `deliver.js`（review の前の配信）に入るので、Claude Code と Codex の両方に同じ修正が届く
- **速度**: `review.ts` に手を入れるので、`node server/evals/scale/run.ts` を変更の前と後に流し、両方の表を PR 本文に載せる
- **変えないもの**: `FileDiff` の形、パスの読み方、rename・binary・mode だけの変更の扱い、DB、hook の設定、Skill の文面

## 持ち主の決定

- issue #336 を直す（2026-10-13「issue の #336 をやりたい」）
- 挙動を変える変更は PR を通し、パッケージに入る変更は npm と 3 つの plugin manifest を同じバージョンに上げて同じ PR で出す（CLAUDE.md `version-sync`）
- 観測された事例の無い防止策は計画に入れない（memory `observed-need-before-building`）
- Claude Code と Codex は、各ホストが許す限り同じ機能を持つ（CLAUDE.md `host-parity`）
- npm への公開は release.yml だけが行い、`npm-release` environment の承認は持ち主だけが行う（`.claude/rules/verification.md` `release-owner-steps`）

## 目的

- `parseDiff(削除ファイルの patch + X の patch)` の X の `added` と `lines` が、`parseDiff(X の patch)` と同じになる。削除ファイルが何行でも、何個続いても
- 削除ファイルは今までどおり `gone: true`、`added: []`、`lines: []` で残る
- 実際の `git diff` の出力で、1 行の削除ファイルの後ろに並ぶファイルの added 行が名指す location-free の don't の記録が、review の前の配信の文面に入る
- 0.6.54 が npm の latest になり、Claude Code と Codex のキャッシュに届き、issue #336 が閉じている

## 対象外

- hunk の行数が実際と合わない diff（途中で切れた、手で書き換えた）への耐性。残すファイルでも今すでに同じことが起きるが、観測された事例が無い
- combined diff（`diff --cc`）
- 受け入れケース（`server/evals/acceptance/cases.json`）への追加。driver の `diffOf`（`server/evals/acceptance/driver.ts:245-247`）は `{path, add}` から 1 ファイル分を組み立てる形で、削除ファイルを前に置けない
- すでに行われた review の結果の見直し

## 前提

実測は 2026-10-13、main（07b07030）、macOS、Node は mise の固定バージョン。

- 再現（`node` で `parseDiff` を直接呼んだ。`src/gone.ts` の削除の後ろに、`@@ -10,3 +10,4 @@` で `  const y = 2;` を足す `src/kept.ts`）
  - 単独: `[{"path":"src/kept.ts","added":["  const y = 2;"],"lines":[11]}]`
  - 削除 1 行の後ろ: kept は `added: []`、`lines: []`
  - 削除 3 行・5 行・40 行の後ろ: kept は `added: ["  const y = 2;"]`、`lines: [2]`
  - kept の後ろに削除: kept は単独と同じ。既存のテストの `DIFF`（`server/test/review.test.ts:44-63`）は削除ファイルが最後なので通っていた
- 原因（コードを読んだ）: `server/src/review.ts:104` が `+++ /dev/null` で `cur = null` にし、`:108-113` が hunk の `oldLeft` を立てる。`:72` の条件は `cur && (oldLeft > 0 || newLeft > 0)` なので、`cur` が null の間は 1 行も消費されない。次のファイルの `+++` で `cur` が入ると、残っていた `oldLeft` のせいで次の `@@` 行が文脈行として読まれ、その hunk の `line` と残り行数が設定されない
- 下流の影響（コードを読んだ。未実測で、T01 の red で実測する）: `server/src/review.ts:168-170,198` は `added` の本文だけで location-free の記録を当てるので、added が空になると当たらない。`server/src/review-findings.ts:111` は `file.lines.includes(e.line)` なので、行番号がずれると正しい行の finding が拒まれる
- 配信の文面は行番号を使わない（`server/src/review-bridge.ts:191-199` は `files` を `selectForReview` に渡すだけ）。行番号のずれは配信のテストでは見られず、単体テストで見る
- unified diff を読むコードは `parseDiff` だけ（`grep '@@ -' server/src scripts plugin/skills plugin/hooks` で `server/src/review.ts:108` の 1 件）。呼ぶのは `server/src/mcp.ts:425,478` と `server/src/review-bridge.ts:191`
- `scripts/release-plan.mjs:44` は `git diff --name-only <ref> --cached` から種別を決める。stage していない変更は判定に入らない
- `server/evals/scale/run.ts:781` は流した時点の作業ツリーを bundle する。変更の前の値は、`server/src` が main と同じ状態で取る
- `scripts/release-finish.mjs:158-176` は、PR の `closingIssuesReferences` にある issue のうち OPEN のものだけを閉じる
- 公開済みの最新は 0.6.53（`npm view sphica dist-tags --json` → `{"latest": "0.6.53"}`、タグ `v0.6.53` = 38d53832）。`plugin/package.json`、`plugin/.claude-plugin/plugin.json`、`plugin/.codex-plugin/plugin.json`、`.claude-plugin/marketplace.json` は 0.6.53
- pre-commit は、main と同じバージョンのままパッケージの入力を変えるコミットを拒む（memory `version-bump-in-first-package-commit`。今回は未実測）

## 方針

1. `parseDiff` の hunk の中の分岐（`server/src/review.ts:72-84`）を、`cur` の有無によらず `oldLeft > 0 || newLeft > 0` で入るようにする。`+` の行は `cur` があるときだけ `added` と `lines` に積み、`line` と `newLeft` は常に進める。`-` と文脈行の数え方は今のまま。`:61` のコメントに、削除されるファイルの hunk も数える理由（数えないと次のファイルの `@@` が前の hunk の行になる）を足す
2. `server/test/review.test.ts` に単体テストを足す。削除 1 行と削除 3 行の `src/gone.ts` の後ろの `src/kept.ts`（`@@ -10,3 +10,4 @@` で 1 行足す）が、単独のときと同じ `added` / `lines` を持ち、`gone.ts` は `gone: true` で残る。削除ファイルが 2 つ続く場合も入れる
3. `server/test/text-properties.test.ts` に property を足す。削除ファイルの行を 1〜20 行、その後ろに新規ファイルの追加行を 1〜20 行。行の生成器は既存の property（`:107-110`）と同じ（改行を除いた任意の文字列と、`--- a/x` / `+++ b/y` / `diff --git a/z b/z` / `@@ -1 +1 @@`）で、削除側には `-`、追加側には `+` を付け、hunk の宣言行数を実際の行数に合わせる。`parseDiff(gone + kept)` の kept の要素が `parseDiff(kept)` の要素と `deepEqual`
4. `server/test/review-bridge.test.ts` に、実際の git リポジトリのテストを足す。追跡済みで 1 行だけの `src/a-gone.ts` を削除し、パスの順でその後ろに来る追跡済みのファイルに、location-free の don't の記録の option を名指す行を足す。`deliver` の review の文面にその記録の key が入る。テストの中で、`git diff --name-only` の順で削除ファイルが前に来ることを assert する
5. 順序は次のとおり。作業ブランチ → plan と tasks のコミット → 変更の前の `node server/evals/scale/run.ts`（`server/src` が main と同じ状態で）→ テスト 3 種を足す → `server/src/review.ts` が未修正のまま 3 種を流し、足したテストがそれぞれ意図した理由で落ちることを確かめる（単体: 削除 1 行で `added` が空、3 行で `lines` が `[2]`。property: 反例が出る。配信: 記録の key が文面に無い）→ 修正 → 同じコマンドで fail 0 → stage → `bun run release:plan -- --base v0.6.53` が `release kind: plugin` → `npm view sphica versions --json` に 0.6.54 が無い → 4 か所を 0.6.54 に上げて stage し直す → `bun run verify` → 変更の後の `node server/evals/scale/run.ts` → `review-shipping` → 1 コミット（前後の表と red の記録を tasks の結果行に入れる）
6. PR 本文は `.github/pull_request_template.md` に従い、1 行目に `Closes #336` を置く。速度の表（前と後）、red の記録、Codex のレビューの結果、Release notes を入れる
7. merge の前に Codex の全差分のレビュー（`codex-review` Skill）を通し、PR 作成後に GitHub の Codex のレビューの指摘を PR で読んで、直すか退けるかを決めて thread を閉じる
8. plan と tasks は作業ブランチの最初のコミットに入れ、レビューが終わったら PR の最後のコミットで消して PR 本文に名前を書く。その最終 head で CI とレビューを確かめてから、`plugin-release` Skill の手順でタグ・リリース・到着の確認をする

## 採った案と棄却した案

- 採用: hunk の行を、ファイルを残すかどうかによらず消費する。棄却: 次の `+++` / `diff --git` の header で残り行数を 0 に戻す（削除ファイルの hunk の行が header の正規表現に当たらないことに頼り続け、hunk を数える場所が 2 つに分かれる）
- 採用: 実際の git のテストを `review-bridge.test.ts` に足す。棄却: 受け入れの driver を複数ファイルの diff に広げる（この 1 件のために driver の形を変えることになり、git が実際に出す順は driver では確かめられない）
- 採用: 配信のテストは削除ファイルを 1 行に固定する。棄却: 数行の削除ファイルにする（削除 3 行以上では added が残るので、直す前のコードでも記録が当たってテストが通る。Codex の指摘 C1）
- 採用: テスト・修正・バージョン上げを 1 コミットにし、red は修正の前に作業ツリーで取る。棄却: テストだけ先にコミットする（そのコミットの時点でテストが落ちる）、修正の後に `git stash` で戻して red を取る（直す前に確かめたことにならない。Codex の指摘 C2）

## 手順

- S1: テスト 3 種を足して未修正のコードで red を確かめ、`parseDiff` を直す（方針 1〜4）
- S2: 修正を stage して `release:plan` を流し、バージョンを 0.6.54 に上げる（方針 5）
- S3: `node server/evals/scale/run.ts` を変更の前と後で流し、表を残す（方針 5）

PR・レビュー・plan と tasks の削除・リリース・到着の確認（方針 6〜8）はコードを変えないので、手順の ID を振らず、完了条件 A5〜A8 で確かめる。

## 完了条件

- A1: `cd server && node --import ./test/isolate-home.ts --test test/review.test.ts test/text-properties.test.ts test/review-bridge.test.ts` → fail 0
- A2: `gh pr view <PR> --json body --jq .body` → Verification の節に、未修正の `server/src/review.ts` で流した red（コマンドと、落ちたテスト名・失敗の内容）が、修正の前に取ったものとして書いてある。同じ内容が tasks の T01 の結果行にある
- A3: `bun run verify` → 終了コード 0
- A4: 修正を stage した状態で `bun run release:plan -- --base v0.6.53` → `release kind: plugin`
- A5: plan と tasks を消したコミットを含む最終 head で `gh pr checks <PR>` → 全項目 pass。未解決の review thread が 0
- A6: `bun run release:status` → npm の latest、リモートのタグ、グローバルの CLI、marketplace、Claude と Codex のキャッシュが 0.6.54
- A7: PR 本文の 1 行目が `Closes #336`。release の `finish` が成功した後、`gh issue view 336 --json state` → `CLOSED`
- A8: `gh pr view <PR> --json body --jq .body` → 変更の前と後の `node server/evals/scale/run.ts` の表が両方ある

## リスク

- 修正で bundle が上限（`scripts/lib/bundle-budget.mjs`）を超える → `plugin/dist` の前後のバイト数と metafile の差で、増えたのがこの修正の分だけかを確かめる。そうだと確かめられたときだけ、根拠を tasks の結果行に残して必要な分だけ上限を上げる。ほかの原因なら止めて持ち主に報告する
- 実際の git のテストで、削除ファイルが後ろのファイルより前に並ばない → パスの名前で順を決め、テストの中で `git diff --name-only` の順を assert する
- 直す前のコードで、足したテストのどれかが落ちない → そのテストは不具合を見ていないので、修正に進まず入力を見直す。見直しても落ちないなら止めて持ち主に報告する
- 0.6.54 がすでに npm にある → 次の空いているバージョンにし、tasks の記録節に書く

## 未解決

なし

## 変更履歴
