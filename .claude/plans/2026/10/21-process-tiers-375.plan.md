---
kind: plan
status: approved
codex_session: 01a15c9f-e74f-7341-9f52-c8084aa1f2bb
codex_rounds: 3
approved_at: 2026-10-21
---

# #375: plan ファイルとローカルのレビューを戻しにくい変更に絞り、依存の 2 ファイルだけの変更は CI の tarball 比較で同じならリリースを求めない

## 要点

- CLAUDE.md: plan と grill-codex は戻しにくい変更（schema・書き込みの経路・権限・セキュリティ・公開契約・リリースの仕組み）だけ。ほかは判断・棄却した案・検証を PR 本文へ。verify、red の確認、持ち主の最終判断は今のまま
- レビュー: GitHub の Codex は全 PR。手元の Codex（codex-review）と review-shipping は、戻しにくい領域と、package の入力・依存・バージョンの検査・リリースの仕組みに触れる PR だけ（リリースの種別が none でも対象）
- リリースの判定: 変わった package の入力が `server/package.json` と `server/bun.lock` だけのときに限り、PR の CI で実際に pack した tarball を npm の前のリリースと比べ、`same` なら bump を求めない。pre-commit はこの場合だけ判定を CI に任せる
- それ以外のパス（server/src、plugin/、db/、marketplace.json など）は今のパスの規則のまま。比べられないとき（npm に届かない、比較の失敗、判定と tree の不一致）は bump を求める
- 変えないもの: バージョンの一致と後退の検査、release-gate、fork PR の扱い、README だけの規則（u596）、持ち主の承認

## 持ち主の決定

- 2026-10-21、#375 の選択肢で 1 は B、2 は B、3 は B（「おすすめでいこう」）
- 「ここまで厳密にやる必要はないのでは」「改善できるところはしておきたい」。コントリビューターは 1 人いて、増えるかもしれない
- 3B が大きな作りになると伝えたうえで、S1〜S7 を 1 つの plan で全部進める（2026-10-21、「全部まとめて進める」）

## 目的

- dev の依存とその lockfile だけを変えた PR が、配布物が同じならバージョンを上げずに merge できる
- 戻しにくくない小さな変更は、plan ファイルと手元の Codex・review-shipping なしで PR にできる
- 配布物が変わる変更は、今までどおり bump なしでは CI を通らない

## 対象外

- pre-commit での tarball の比較（毎回の隔離した install・bundle・pack と npm の取得が重い。Codex と合意）
- server/src など依存の 2 ファイル以外の変更の免除（出力が同じ型だけの変更なども今は bump が要る）
- 案 D（lockfile を読んで実行時の依存の閉包を比べる）。root の optionalDependencies の追加で notices が変わるのに見逃す反例が出た（Codex が実測）。パッチや解決関係も扱えない
- グローバルの ~/.claude/CLAUDE.md（このリポジトリの外）

## 前提

- バージョンの検査は `scripts/check-mcp-version.mjs`。pre-commit（lefthook の bundle ジョブの後）と CI（`check.yml` の static で install より前、`same-tree` ジョブで main への push）で動く。release-scope は `scripts/lib/release-scope.mjs` で、`server/package.json` と `server/bun.lock` は package の入力（事実）
- CI の static は `npm pack` と `check-tarball.mjs` を verify の後に流す（`check.yml` 150 行付近）。`release.yml` の dry run は依存の 2 ファイルだけの PR では起動しない（paths に無い。Codex が確認）
- pull_request の checkout は試験用の merge commit。base は `HEAD^1`（`check.yml` 110 行）
- `release:plan` は base と index を比べる（`scripts/release-plan.mjs`、`server/test/release-plan.test.ts:84`）
- same-tree は親・tree・最新の成功した実行を確かめる（`scripts/lib/same-tree.mjs:40-60`）。内容の比較の判定はまだ扱わない
- 0.6.64 は dev の道具だけの変更で、公開した `dist/mcp.js` は 0.6.63 とバイト単位で同じだった（2026-10-21 実測）
- ローカルの Bun 1.4.3（PATH の先頭の `~/.bun/bin`）の bundle は CI の 1.4.0 と違う（2026-10-21 実測）。CI の比較は固定の Bun で走る
- 過去の記録 u102（#212 で「バージョンの検査を直す」を却下、理由は記録に無い）は、今回の持ち主の選択で変える

## 方針

### 規範（1B、2B）

- CLAUDE.md「Before implementing」: plan と grill-codex を戻しにくい変更の一覧に限る。それ以外の挙動の変更は、決めたこと・棄却した案と理由・検証を PR 本文に書く。plan が要らなくても、verify、修正の red の確認、持ち主の最終判断は要る（C10）
- CLAUDE.md「Review」: GitHub の Codex は全 PR（今のまま）。codex-review と review-shipping は、戻しにくい領域と、package の入力・依存・バージョンの検査・リリースの仕組み・検査のスクリプトに触れる差分だけ。リリースの種別で決めない（C9）
- 合わせて直す: `.claude/skills/codex-review/SKILL.md` の起動条件、`.github/pull_request_template.md` のレビューの行（GitHub とローカルを分ける）、`.claude/agents/review-shipping.md` の説明と本文のパスの判定、`.agents/skills/plugin-release/SKILL.md` の Shipping と依存 PR の節、`.claude/rules/verification.md` の Release（C11）

### リリースの判定（3B を CI に置く）

- 比較: `scripts/lib/tarball-diff.mjs`。入力は CI の static で作った tarball と、npm から取る base のバージョンの tarball（integrity を確かめる。取得は差し替えられる関数）。両方を同じ方法で展開し、パス・中身・意味のあるモード（実行ビット）を比べる。mtime・所有者・圧縮のバイトは比べない。`package.json` は 4 か所のバージョンの欄だけを揃える。`README.md` は除く（u596）。`THIRD_PARTY_NOTICES.md` は比べる（C4、C5）
- 判定は `same` / `differs`（パスつき）/ `unknown`（理由つき）。JSON に、比べた checkout の SHA と tree、base の SHA、npm の package・version・integrity、比較器と Node・Bun・npm のバージョン、run ID と attempt を残す（C23）。判定元は Linux の static ジョブ 1 つに固定する
- バージョンの検査: 早い段階（install の前）は、バージョンの一致・後退・ほかのパスの規則を今どおり検査し、「依存の 2 ファイルだけ」のときは保留にする。pack の後に同じジョブで比較と最終の検査を必ず流し、`same` でなければ bump を求める。この最終の検査は required check に含める（C22）
- pre-commit: 依存の 2 ファイルだけのときは、判定を PR の CI に任せると 1 行出して通す。証明ではない（C21）
- `release:plan`: index が判定した tree と一致し、base も一致するときだけ `none` を出す。判定は GitHub API で、実行元（リポジトリ、workflow、PR 番号、head のリポジトリと SHA、run ID と attempt、成功）を確かめた artifact から読む。fork の PR の artifact は使わない。合わないときは `plugin` と理由（C24、C25）
- main の same-tree: バージョンの検査の前に、確かめた判定と baseline を照合する。照合できなければ免除しない。check.yml が成功したことを `same` の代わりにしない。verify-pairs の順序と条件の検査も直す（C26）
- 再実行: 判定は run ID と attempt に結ぶ。比較のジョブが再実行されていなければ `unknown`。過去の成功で埋めない（C27）
- `unknown` は免除しないが、bump 済みの PR は今の経路で通す（C29）。release-gate は変えない（C28）

## 採った案と棄却した案

- 採用: tarball の比較を PR の CI の static の pack の後に置く（案 E）。棄却: pre-commit でも比べる（毎回の隔離した install・bundle・pack と通信が重い）
- 採用: npm の公開済みの tarball を基準にする。棄却: base のコミットを作り直して比べる（過去の依存とツールの再構築が要る）、リリースごとにダイジェストをコミットする（記録とその正しさの検証が増える）
- 採用: 免除は依存の 2 ファイルだけの変更に限る。棄却: 案 D の lockfile の閉包の比較（optionalDependencies、パッチ、解決関係の見逃し）
- 採用: レビューの要否はリリースの種別と別に決める。棄却: 種別が plugin のときだけローカルのレビュー（none の依存やリリースの検査の変更が外れる）

## 手順

- S1: CLAUDE.md の「Before implementing」と「Review」を 1B・2B に書き換える
- S2: codex-review、PR テンプレート、review-shipping、plugin-release、verification.md を合わせる
- S3: `scripts/lib/tarball-diff.mjs` とテスト（差し替えた取得、展開、比較、判定の JSON）
- S4: `check-mcp-version.mjs` の早い段階の保留と、pack の後の最終の検査。`check.yml` の static に比較と最終の検査を足す
- S5: pre-commit の保留の 1 行
- S6: `release:plan` が確かめた artifact の判定を読む
- S7: main の same-tree が判定を照合する。verify-pairs の検査を直す

## 完了条件

- A1: `bun run verify` → 0 で終わる
- A2: `gh pr checks <依存の 2 ファイルだけを変えた試しの PR>` → bump なしで全 pass。static の判定が `same`
- A3: server/src を変えて bump していない index で `node scripts/check-mcp-version.mjs` → 今どおり失敗する
- A4: `cd server && node --test test/tarball-diff.test.ts` → 取得の失敗・base が未公開・中身の違い・実行ビットの違い・notices の違い・README だけの違いで、それぞれ unknown / unknown / differs / differs / differs / same
- A5: `cd server && node --test test/release-verdict.test.ts` → 判定の後に stage した変更、後のコミット、base の更新、再実行、fork の PR の artifact、main の merge の tree の不一致で、どれも免除されない
- A6: `rg -n "grill-codex" CLAUDE.md` → 戻しにくい変更の一覧と一緒の 1 か所だけ

## リスク

- CI の判定の受け渡しの作りが大きくなる → 最初は main の same-tree と release:plan での再利用を unknown に倒し（免除しない）、static の同じジョブの中の免除だけを先に入れる手もある
- 固定の Bun でも bundle が揺れる → 同じ入力を 2 回作って一致を確かめるテストを足し、揺れたら differs に倒す
- npm の取得が遅い・落ちる → unknown で bump を求める。時間の上限を設ける

## 未解決

なし

## 変更履歴
