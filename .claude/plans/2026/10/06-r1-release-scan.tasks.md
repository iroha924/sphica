---
kind: tasks
plan: 06-r1-release-scan.plan.md
branch: ci/r1-release-scan
base: main
---

# release の run で、承認の前に出すリビジョンを OSV でスキャンし、merge の後に main の OSV と Scorecard を走らせ直す（#268）のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 承認の前のスキャン

タグのコミットのスキャン結果が run の summary と承認を頼む PR のコメントに出て、publish がスキャンを待つ。

- [x] T01: OSV の結果を found / none / unavailable と表に要約するライブラリと CLI を足す
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `scripts/lib/osv-summary.mjs`, `scripts/lib/osv-summary.d.mts`, `scripts/osv-summary.mjs`, `server/test/osv-summary.test.ts`
  - 完了条件: `cd server && node --test test/osv-summary.test.ts` → pass。ファイルなし・空・壊れた JSON・形の違いは unavailable、0 件は none、1 つの ID が 2 パッケージにあるときの件数は 1、CLI は結果が読めなくても exit 0 で `status` と `count` を `$GITHUB_OUTPUT` に書く
  - コミット: `feat(release): summarize OSV results as found, none, or unavailable (T01)`
  - 結果: `cd server && node --test test/osv-summary.test.ts` → 7 件 pass（unavailable の 7 通り、none の 2 通り、found 1 件、ID の重複を除いた 3 件、表のセルの `|` と改行、承認コメントの行、CLI が結果なしで exit 0 と出力 3 つ、SHA でない引数で 0 以外）

- [x] T05: 部分的な結果・読めない結果ファイル・セルの Markdown を直す
  - 種別: 修正
  - 計画: S1
  - 依存: T01（直す対象の要約が要る）
  - 変更: `scripts/lib/osv-summary.mjs`, `scripts/lib/osv-summary.d.mts`, `scripts/osv-summary.mjs`, `server/test/osv-summary.test.ts`
  - red: `cd server && node --test test/osv-summary.test.ts` → 3 件 fail（groups だけ残った結果が none、セルの `![x](...)` がそのまま、CLI が EISDIR で summary を書く前に exit 1）
  - 完了条件: `cd server && node --test test/osv-summary.test.ts` → pass。groups に ID があるのに vulnerabilities が無い・null・空なら unavailable、セルの Markdown の記号はバックスラッシュで無効、ENOENT 以外の読み取りエラーも unavailable で exit 0
  - コミット: `fix(release): report partial or unreadable OSV results as unavailable and escape cells (T05)`
  - 結果: red は上のとおり 3 件 fail（none、Markdown の残り、summary.md の ENOENT）を実測。直した後 `cd server && node --test test/osv-summary.test.ts` → 9 件 pass

- [x] T02: release.yml に osv ジョブを足し、notify-approval と publish に待たせ、paths に足す
  - 種別: 追加
  - 計画: S1
  - 依存: T01（ジョブが呼ぶ CLI が要る）
  - 変更: `.github/workflows/release.yml`
  - 完了条件: `actionlint .github/workflows/release.yml` → 出力なし。`bun run verify` → 成功
  - コミット: `ci(release): scan the tagged revision with OSV before approval (T02)`
  - 結果: `actionlint .github/workflows/release.yml` → 出力なし（exit 0）。`bun run verify` → exit 0（acceptance 130 件 pass を含む）。zizmor は手元に無く、CI で見る


- [x] T06: 表のセルをコードスパンにして、自動リンク・文字参照も効かないようにする
  - 種別: 修正
  - 計画: S1
  - 依存: T05（直す対象のエスケープが要る）
  - 変更: `scripts/lib/osv-summary.mjs`, `server/test/osv-summary.test.ts`
  - red: `cd server && node --test test/osv-summary.test.ts` → 5 件 fail（表の行がコードスパンでない。`www.example.org` と `&copy;` がそのまま Markdown として残る）
  - 完了条件: `cd server && node --test test/osv-summary.test.ts` → pass。各セルはコードスパンで、バッククォートは `'` に、`|` は `\|` になる
  - コミット: `fix(release): show OSV table cells as code spans (T06)`
  - 結果: red は上のとおり 5 件 fail を実測。直した後 `cd server && node --test test/osv-summary.test.ts` → 10 件 pass

- [x] T07: osv ジョブの失敗（イメージの取得・準備の失敗）で publish と dry run が止まらないようにする
  - 種別: 修正
  - 計画: S1
  - 依存: T02（直す対象の osv ジョブが要る）
  - 変更: `.github/workflows/release.yml`
  - red: `awk '/^  osv:/,/^  prepare:/' .github/workflows/release.yml | grep -c '^    continue-on-error: true'` → 0（ジョブ単位の continue-on-error が無く、publish と notify-approval は osv の成功を既定の条件で求める）
  - 完了条件: `actionlint .github/workflows/release.yml` → 出力なし。osv にジョブ単位の `continue-on-error: true`、publish は `!cancelled()` と sbom・prepare の成功、notify-approval は `!cancelled()` と prepare の成功だけを条件にする。`bun run verify` → 成功
  - コミット: `fix(release): keep a failed OSV job from blocking publish or the dry run (T07)`
  - 結果: red は T03 のコミットの release.yml で 0 を実測。直した後は 1。`actionlint .github/workflows/release.yml` → 出力なし（exit 0）。`bun run verify` → exit 0
## P2: merge の後のスキャン

release の merge の後に、main の OSV と Scorecard の run を workflow_dispatch で起こし、その URL を summary に出す。

- [x] T03: osv-scanner.yml と scorecard.yml に workflow_dispatch を足し、release.yml に refresh-scans を足す
  - 種別: 追加
  - 計画: S2
  - 依存: なし
  - 変更: `.github/workflows/osv-scanner.yml`, `.github/workflows/scorecard.yml`, `.github/workflows/release.yml`
  - 完了条件: `actionlint .github/workflows/release.yml .github/workflows/osv-scanner.yml .github/workflows/scorecard.yml` → 出力なし。`bun run verify` → 成功
  - コミット: `ci(release): dispatch OSV and Scorecard on main after the release merge (T03)`
  - 結果: `actionlint` の 3 ファイル → 出力なし（exit 0）。`bun run verify` → exit 0。refresh-scans の run の中身を偽の gh を PATH の先頭に置いて `bash -eo pipefail` で流した: URL が返る場合は URL、失敗は `::warning::` と「dispatch failed」の行、URL が返らない場合は「dispatched; run URL not returned」になり、どれも exit 0


- [x] T08: dispatch の失敗の警告で、gh の出力を workflow command のデータとしてエスケープする
  - 種別: 修正
  - 計画: S2
  - 依存: T03（直す対象の refresh-scans が要る）
  - 変更: `.github/workflows/release.yml`
  - red: refresh-scans の run の中身を、stderr に `failed 100%\r::error::forged` を出して exit 1 する偽の gh で流す → `::error::forged` が独立した行として 2 回出る
  - 完了条件: 同じ偽の gh で流す → `::error::forged` の行は 0、`%` は `%25`、CR は `%0D`、LF は `%0A` になり exit 0。`actionlint .github/workflows/release.yml` → 出力なし。`bun run verify` → 成功
  - コミット: `fix(release): escape gh's output in the dispatch warning (T08)`
  - 結果: red は上のとおり 2 行を実測。直した後は 0 行で、警告は `failed 100%25%0D::error::forged`、exit 0。actionlint → exit 0。`bun run verify` → exit 0
## P3: 手順書

plugin-release Skill が、スキャンの結果の読み方と、dispatch した run の見届け方、失敗したときの戻し方を書く。

- [x] T04: plugin-release Skill の 5・7〜9 段と失敗からの戻し方を直す
  - 種別: 変更
  - 計画: S3
  - 依存: T02（5 段目が osv ジョブを書く）, T03（7〜9 段目が refresh-scans を書く）
  - 変更: `.agents/skills/plugin-release/SKILL.md`
  - 完了条件: `bun run verify:ai` → 成功
  - コミット: `docs(release): describe the pre-approval scan and the scans after the merge (T04)`
  - 結果: `bun run verify:ai` → exit 0（AI config と lychee のリンク検査 0 Errors）。5 段目に osv と 3 つの状態、6 段目（持ち主の表と本文）に summary のスキャンを読むこと、7 段目に refresh-scans、9 段目に 2 本の run の見届け、失敗の節に手での dispatch を足した

## 記録

- 2026-10-06 / T01 / テストが TS から .mjs を読むのに型宣言が要り、pre-commit の typecheck で止まった / 変更欄に `scripts/lib/osv-summary.d.mts` を足した（前: 3 ファイル、後: 4 ファイル）
- 2026-10-06 / T05 / T01 の Codex のレビューで 3 件（groups だけ残った結果が none、ENOENT 以外の読み取りエラーで CLI が落ちる、セルの Markdown）を再現つきで受けた / 3 件とも直すことにして修正タスク T05 を T01 の後に足した
- 2026-10-06 / T02 / osv ジョブは contents: read だけで security-events を持たないので、osv-scanner.yml の fork PR の除外（security-events を fork に渡せないため）は理由が無くなった / plan にあった fork PR の除外は付けなかった
- 2026-10-06 / T06, T07 / T02 と T05 の Codex のレビュー: [P1] scanner の docker イメージの取得はステップの外の準備処理で、continue-on-error が効かずに osv が落ち、publish と dry run を止める。[P2] checkout・setup-node の失敗も同じ。[P2] バックスラッシュのエスケープでは GFM の自動リンクと文字参照が残る / 3 件とも採り、T06（セルをコードスパンに）と T07（osv をジョブ単位で continue-on-error、publish と notify-approval は osv の結果によらない条件）を足した
- 2026-10-06 / T08 / T03 の Codex のレビュー: [P2] 警告に入れる gh の出力の CR を除いておらず、CR の後ろが別の workflow command になり得る（再現つき） / 採って T08 を足した。T06・T07 のレビューは指摘なし
