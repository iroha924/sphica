---
kind: tasks
plan: 21-process-tiers-375.plan.md
branch: chore/process-tiers-375
base: main
---

# #375: plan ファイルとローカルのレビューを戻しにくい変更に絞り、依存の 2 ファイルだけの変更は CI の tarball 比較で同じならリリースを求めない のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 規範

plan ファイルと grill-codex を戻しにくい変更に絞り、ローカルのレビューの要否をリリースの種別と分けて書く。

- [x] T01: CLAUDE.md の「Before implementing」と「Review」を書き換える
  - 種別: 変更
  - 計画: S1
  - 依存: なし
  - 変更: `CLAUDE.md`
  - 完了条件: `bun run verify:ai` → 0 で終わる。`rg -n "grill-codex" CLAUDE.md` → 戻しにくい変更の一覧と一緒の 1 か所
  - コミット: `docs(claude): require plans and local reviews only for hard-to-undo changes (T01)`
  - 結果: 「Before implementing」は plan と grill-codex を戻しにくい変更の一覧に限り、ほかは PR 本文に判断・棄却した案・検証を書く、verify・red・最終判断は省かないとした。「Review」は review-shipping を package の入力・依存・バージョン・検査・リリースの仕組みの変更（種別が none でも）、codex-review を戻しにくい領域とそれらに触れる PR に限った。`bun run verify:ai` → 0。`rg -n "grill-codex" CLAUDE.md` → 62 行目の 1 か所

- [x] T02: 関連の Skill・Agent・テンプレート・rule を合わせる
  - 種別: 変更
  - 計画: S2
  - 依存: T01（CLAUDE.md の新しい言い回しに合わせる）
  - 変更: `.claude/skills/codex-review/SKILL.md`, `.github/pull_request_template.md`, `.claude/agents/review-shipping.md`
  - 完了条件: `bun run verify:ai` → 0 で終わる。`bun run rule-scopes` → 0 で終わる
  - コミット: `docs(review): match the review and release docs to the new rules (T02)`
  - 結果: codex-review の description と起動条件を CLAUDE.md「Review」の範囲に絞り、ほかの PR は GitHub の Codex に任せると書いた。PR テンプレートは GitHub の Codex を全 PR、ローカルは求められたときと分けた。review-shipping の description を依存・リリースの仕組み・種別 none を含む形に直した。`bun run verify:ai` → 0、`bun run rule-scopes` → 0

## P2: tarball の比較

CI で pack した tarball を npm の前のリリースと比べ、判定を JSON と artifact に残す。

- [x] T03: tarball を比べる `scripts/lib/tarball-diff.mjs` とテスト
  - 種別: 追加
  - 計画: S3
  - 依存: なし
  - 変更: `scripts/lib/tarball-diff.mjs`, `scripts/lib/tarball-diff.d.mts`, `server/test/tarball-diff.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/tarball-diff.test.ts` → 取得の失敗・未公開・中身・実行ビット・notices・README だけ・バージョンだけの違いの各ケースが pass
  - コミット: `feat(release): compare a packed tarball with the published one (T03)`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/tarball-diff.test.ts` → 4 件 pass（バージョンと README だけの違いは same、バイト・notices・バージョン以外の欄・ファイルの追加・実行ビットは differs、未公開・integrity の不一致・取得の失敗・別の場所を指す tarball は unknown）。実物でも試した: main の pack を npm の 0.6.65 と比べて same、0.6.64 と比べて differs（THIRD_PARTY_NOTICES.md、dist/mcp-record.js、dist/mcp.js）

- [x] T04: 判定を書く `scripts/release-verdict.mjs` と、CI の static での比較と artifact
  - 種別: 追加
  - 計画: S3, S4
  - 依存: T03（比較の関数が要る）
  - 変更: `scripts/release-verdict.mjs`, `scripts/lib/release-verdict.mjs`, `scripts/lib/release-verdict.d.mts`, `server/test/release-verdict.test.ts`, `.github/workflows/check.yml`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/release-verdict.test.ts` → pass。`bun run pairs` → 0 で終わる
  - コミット: `feat(release): record whether the packed tarball matches the last release in CI (T04)`
  - 結果: 判定は `scripts/lib/release-verdict.mjs`（取得を差し替えられる）と薄い CLI に分けた。`cd server && node --import ./test/isolate-home.ts --test test/release-verdict.test.ts` → 1 件 pass（判定、npm の name・version・integrity、checkout・tree・base・run を記録）。check.yml の static は pack を `$RUNNER_TEMP/pack` に置き、Node 24.15 の行だけ判定を書いて artifact `release-verdict` に上げる。`mise exec -- actionlint .github/workflows/check.yml` → 0、`bun run pairs` → 0、knip・typecheck・lint → 0

## P3: 検査の免除

依存の 2 ファイルだけの変更は、pre-commit では保留し、CI と main と release:plan では確かめた判定が same のときだけ bump を求めない。

- [x] T05: バージョンの検査に保留と判定を入れ、CI の早い段階・pack の後・pre-commit から呼ぶ
  - 種別: 変更
  - 計画: S4, S5
  - 依存: T04（判定の JSON の形が要る）
  - 変更: `scripts/check-mcp-version.mjs`, `scripts/lib/release-scope.mjs`, `scripts/lib/release-scope.d.mts`, `server/test/check-mcp-version.test.ts`, `.github/workflows/check.yml`, `lefthook.yml`, `scripts/lib/verify-pairs.mjs`, `server/test/verify-pairs.test.ts`, `.agents/skills/plugin-release/SKILL.md`, `.claude/rules/verification.md`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/check-mcp-version.test.ts` → 引数なしは今の規則、`--defer-deps` は依存の 2 ファイルだけを保留、`--verdict` は same のときだけ免除、ほかのパスと unknown と tree の不一致は bump を求める。`bun run verify` → 0 で終わる
  - コミット: `feat(release): let a dependency-only change skip the bump when CI found the tarball unchanged (T05)`
  - 結果: `DEPENDENCY_INPUTS` を release-scope に置き、`--defer-deps` と `--verdict` を足した（引数なしは今の規則）。`cd server && node --import ./test/isolate-home.ts --test test/check-mcp-version.test.ts` → 13 件 pass（引数なしは失敗、--defer-deps は依存の 2 ファイルだけ通す、ほかのパスが混ざれば両方とも失敗、--verdict は same・同じ tree・同じ base のときだけ通し differs・unknown・別の tree・別の base・読めないファイルは失敗、bump 済みは verdict に関係なく通る）。check.yml の早い検査に --defer-deps、Node 24.15 の static の判定の後に --verdict の検査、lefthook の bundle に --defer-deps。verify-pairs は、保留する検査の後に pack・判定・判定を読む検査が floor の static で揃うことを検査（`test/verify-pairs.test.ts` 15 件 pass）。最初の `bun run verify` はテストの no-template-curly-in-string で exit 1、抑止を足して `bun run verify` → exit 0（acceptance 151 件 pass）

- [ ] T06: release:plan が確かめた判定を読む
  - 種別: 変更
  - 計画: S6
  - 依存: T04（artifact の名前と形が要る）
  - 変更: `scripts/release-plan.mjs`, `scripts/lib/release-scope.mjs`, `scripts/lib/release-scope.d.mts`, `server/test/release-plan.test.ts`, `server/test/release-scope.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/release-plan.test.ts test/release-scope.test.ts` → index と判定の tree・base が一致し実行元を確かめた same のときだけ none、ほかは plugin と理由
  - コミット: `feat(release): report none for a dependency-only change only on a verified same verdict (T06)`

- [ ] T07: main の same-tree が判定を照合してから検査する
  - 種別: 変更
  - 計画: S7
  - 依存: T05（検査の --verdict が要る）
  - 変更: `scripts/same-tree.mjs`, `scripts/lib/same-tree.mjs`, `server/test/same-tree.test.ts`, `.github/workflows/check.yml`, `scripts/lib/verify-pairs.mjs`, `server/test/verify-pairs.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/same-tree.test.ts test/verify-pairs.test.ts` → 判定の tree・baseline・run が合うときだけ渡し、合わない・読めないときは渡さない。`bun run verify` → 0 で終わる
  - コミット: `feat(release): carry the tarball verdict to the push to main (T07)`

## 記録

- 2026-10-21 / 全体 / 持ち主が S1〜S7 を全部まとめて進めると決めた（Go） / タスクごとの Codex レビューは、挙動を変える T04〜T07 で行う
- 2026-10-21 / T02 / plugin-release の Shipping と依存 PR の節、verification.md の Release は依存の免除（3B）の説明なので、免除を入れる T05 に移した / T02 の変更欄から 2 件を外し、T05 に足した
- 2026-10-21 / T04 / 判定の書き出しをテストできるよう lib と CLI に分け、verify-pairs の構造の検査は最終の検査と一緒に T05 で足す / T04 の変更欄を `scripts/release-verdict.mjs`, `server/test/release-verdict.test.ts`, `.github/workflows/check.yml`, `scripts/lib/verify-pairs.mjs`, `server/test/verify-pairs.test.ts` から上の値に、完了条件から verify-pairs のテストを外した
- 2026-10-21 / T05 / 変更欄に `scripts/lib/release-scope.mjs`, `scripts/lib/release-scope.d.mts`, `server/test/verify-pairs.test.ts` を足した / 免除の対象の集合を release-scope に置き、verify-pairs のテストを足したため
- 2026-10-21 / T04 / Codex のタスクレビュー（high）: 指摘 0 件。指定のテストは Codex の sandbox で mkdtemp が EPERM になり走らせられなかった（手元では pass） / 対応なし
