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

- [x] T06: release:plan が確かめた判定を読む
  - 種別: 変更
  - 計画: S6
  - 依存: T04（artifact の名前と形が要る）
  - 変更: `scripts/release-plan.mjs`, `scripts/lib/release-verdict.mjs`, `scripts/lib/release-verdict.d.mts`, `server/test/release-plan.test.ts`, `server/test/release-scope.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/release-plan.test.ts test/release-scope.test.ts` → index と判定の tree・base が一致し実行元を確かめた same のときだけ none、ほかは plugin と理由
  - コミット: `feat(release): report none for a dependency-only change only on a verified same verdict (T06)`
  - 結果: 実行の選び方（自分のリポジトリの check.yml の pull_request の最新の run が成功していること）と判定の照合（same、run と attempt、index の tree、base のリリースのバージョン）を `scripts/lib/release-verdict.mjs` の `latestRun` と `verdictMismatch` に置き、release:plan は依存の 2 ファイルだけのときに gh で artifact を読む。`cd server && node --import ./test/isolate-home.ts --test test/release-plan.test.ts test/release-scope.test.ts` → 5 件と 4 件 pass（same は none、differs・別の tree・別の attempt・別のバージョン・fork の run・失敗した run・実行中の run は plugin と理由、ほかの入力が混ざれば判定を読まない）。`bun run verify` → exit 0（acceptance 151 件 pass）

- [x] T07: main の same-tree が判定を照合してから検査する
  - 種別: 変更
  - 計画: S7
  - 依存: T05（検査の --verdict が要る）
  - 変更: `scripts/same-tree.mjs`, `scripts/lib/same-tree.mjs`, `scripts/lib/same-tree.d.mts`, `server/test/same-tree.test.ts`, `scripts/main-version-check.mjs`, `scripts/lib/main-version.mjs`, `scripts/lib/main-version.d.mts`, `server/test/main-version.test.ts`, `scripts/check-mcp-version.mjs`, `server/test/check-mcp-version.test.ts`, `.github/workflows/check.yml`, `scripts/lib/verify-pairs.mjs`, `server/test/verify-pairs.test.ts`, `.agents/skills/plugin-release/SKILL.md`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/same-tree.test.ts test/verify-pairs.test.ts` → 判定の tree・baseline・run が合うときだけ渡し、合わない・読めないときは渡さない。`bun run verify` → 0 で終わる
  - コミット: `feat(release): carry the tarball verdict to the push to main (T07)`
  - 結果: same-tree は引き継いだ run の id と attempt を出し、same-tree ジョブの版の検査は判定の後の `scripts/main-version-check.mjs` にした（引き継いだときは API の run・attempt・自分のリポジトリ・artifact の run が合えば --verdict、合わなければ今の規則、引き継がないときは --defer-deps で重いジョブの比較に任せる）。`--verdict` の照合は base のコミットから base のリリースのバージョンに替えた（PR と push で base のコミットが違うため）。`cd server && node --import ./test/isolate-home.ts --test test/same-tree.test.ts test/main-version.test.ts test/verify-pairs.test.ts test/check-mcp-version.test.ts` → pass（41 件と 1 件の追加分）。`bun run verify` → exit 0（acceptance 151 件 pass）

- [x] T08: T05 のレビューの指摘を直す（判定の tree を index と比べる、バージョンがずれたまま免除しない）
  - 種別: 修正
  - 計画: S4
  - 依存: T05（直す対象の検査）
  - 変更: `scripts/check-mcp-version.mjs`, `server/test/check-mcp-version.test.ts`
  - red: テストだけを足した `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern="staged after it|versions part" test/check-mcp-version.test.ts` → 2 件 fail（HEAD の same が後から stage した依存の変更を通す、npm だけ上げても --defer-deps と same の --verdict が通る）
  - 完了条件: 同じコマンド → 2 件 pass。`bun run verify` → 0 で終わる
  - コミット: `fix(release): hold the verdict to the staged tree and keep the versions together (T08)`
  - 結果: red は上のとおり 2 件 fail を実測。判定の tree は `git write-tree`（index）と比べ、免除は npm と plugin のバージョンが一致するときだけにした → `test/check-mcp-version.test.ts` 15 件 pass。`bun run verify` → exit 0（acceptance 151 件 pass）

- [x] T09: T06 のレビューの指摘を直す（gh の向き先を origin と照合する、run の一覧が欠けていれば使わない）
  - 種別: 修正
  - 計画: S6
  - 依存: T06（直す対象の release:plan）
  - 変更: `scripts/release-plan.mjs`, `server/test/release-plan.test.ts`
  - red: テストだけを足した `cd server && node --import ./test/isolate-home.ts --test test/release-plan.test.ts` → 新しい 1 件が fail（gh が fork/r を答え fork/r の run と artifact があると none、total_count 2 で 1 件しか返らない一覧でも none）
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/release-plan.test.ts` → 全件 pass
  - コミット: `fix(release): read the verdict only from origin's repository and a complete run list (T09)`
  - 結果: red は上のとおり fail を実測。gh の答えを `git remote get-url origin` の owner/name と照合し、一覧は same-tree の `runsFrom`（total_count と欄を検査）を通してから選ぶ。`cd server && node --import ./test/isolate-home.ts --test test/release-plan.test.ts` → 6 件 pass。実物の origin は `iroha924/sphica` と読めた

- [x] T10: 全差分のレビューの指摘を直す（再実行の後に古い attempt の判定を読む）
  - 種別: 修正
  - 計画: S6, S7
  - 依存: T07（直す対象の push の検査）, T09（直す対象の release:plan）
  - 変更: `.github/workflows/check.yml`, `scripts/release-plan.mjs`, `scripts/main-version-check.mjs`, `server/test/release-plan.test.ts`
  - red: attempt ごとの名前の artifact だけを返す偽の gh を足した `cd server && node --import ./test/isolate-home.ts --test test/release-plan.test.ts` → 2 件 fail（`-n release-verdict` では何も取れない）
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/release-plan.test.ts` → 全件 pass。`bun run verify` → 0 で終わる
  - コミット: `fix(release): name the verdict artifact per attempt and read that one (T10)`
  - 結果: red は上のとおり 2 件 fail を実測。artifact を `release-verdict-<attempt>` にし、release:plan は run の `run_attempt`、push の検査は same-tree の attempt でその名前を取る。`cd server && node --import ./test/isolate-home.ts --test test/release-plan.test.ts` → 7 件 pass。`bun run verify` → exit 0（acceptance 151 件 pass）

- [x] T11: review-shipping の指摘を直す（失敗したジョブだけの再実行で判定が読めない、main への直接のコミットで判定を CI に任せてしまう、古いコメント）
  - 種別: 修正
  - 計画: S4, S6, S7
  - 依存: T10（直す対象の artifact の名前）
  - 変更: `scripts/check-mcp-version.mjs`, `scripts/lib/release-verdict.mjs`, `scripts/lib/release-verdict.d.mts`, `scripts/release-plan.mjs`, `scripts/lib/main-version.mjs`, `scripts/lib/main-version.d.mts`, `scripts/main-version-check.mjs`, `lefthook.yml`, `server/test/check-mcp-version.test.ts`, `server/test/release-plan.test.ts`, `server/test/main-version.test.ts`
  - red: テストだけを足した `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern="on main, --defer-deps|re-running only failed|earlier attempt of the reused" test/check-mcp-version.test.ts test/release-plan.test.ts test/main-version.test.ts` → 3 件 fail（main でも --defer-deps が通す、attempt 2 の run に release-verdict-1 しか無いと none にならない、push の検査が前の attempt の判定を受けない）
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/check-mcp-version.test.ts test/release-plan.test.ts test/main-version.test.ts` → 全件 pass。`bun run verify` → 0 で終わる
  - コミット: `fix(release): read the latest attempt that holds a verdict, and decide on main at commit time (T11)`
  - 結果: red は上のとおり 3 件 fail を実測。main の上では --defer-deps を効かせない。release:plan と push の検査は run の最新の attempt から 1 まで下って最初に見つかった `release-verdict-<k>` を読み、判定の attempt が k で run の最新以下であることを確かめる。lefthook のコメントを直した。`cd server && node --import ./test/isolate-home.ts --test test/check-mcp-version.test.ts test/release-plan.test.ts test/main-version.test.ts` → 16 件・8 件・4 件 pass。`bun run verify` → exit 0（acceptance 151 件 pass）

- [x] T12: GitHub の Codex の指摘を直す（tarball のパスが job summary に Markdown や改行として出る）
  - 種別: 修正
  - 計画: S3
  - 依存: T04（直す対象の判定の CLI）
  - 変更: `scripts/lib/release-verdict.mjs`, `scripts/lib/release-verdict.d.mts`, `scripts/release-verdict.mjs`, `server/test/release-verdict.test.ts`
  - red: テストだけを足した `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern="escaped line" test/release-verdict.test.ts` → fail（行を作る関数が無く、CLI はパスをそのまま summary に書いていた）
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/release-verdict.test.ts` → 全件 pass。`bun run verify` → 0 で終わる
  - コミット: `fix(release): escape pull request text in the verdict line (T12)`
  - 結果: red は上のとおり fail を実測。`verdictLine` がパスと理由を JSON 文字列として 1 行にし、Markdown の記号をエスケープする。`cd server && node --import ./test/isolate-home.ts --test test/release-verdict.test.ts` → 2 件 pass（`dist/a\n\#\# T \[x\]\(u\)` のように出る）。`bun run verify` → exit 0（acceptance 151 件 pass）

- [x] T13: CodeQL の指摘を直す（判定の行のエスケープがバックスラッシュを二重にエスケープする）
  - 種別: 修正
  - 計画: S3
  - 依存: T12（直す対象のエスケープ）
  - 変更: `scripts/lib/release-verdict.mjs`
  - red: 0a605500 の PR の CI で `CodeQL` → fail（js の double escaping、high、`scripts/lib/release-verdict.mjs:92`）
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/release-verdict.test.ts` → 全件 pass。PR の CI の `CodeQL` → pass
  - コミット: `fix(release): leave backslashes to JSON's escaping in the verdict line (T13)`
  - 結果: red は上のとおり CodeQL の fail を観測。バックスラッシュは JSON の文字列化に任せ、Markdown のエスケープの対象から外した。`cd server && node --import ./test/isolate-home.ts --test test/release-verdict.test.ts` → 2 件 pass。CodeQL は push の後の CI で見る

## 記録

- 2026-10-21 / 全体 / 持ち主が S1〜S7 を全部まとめて進めると決めた（Go） / タスクごとの Codex レビューは、挙動を変える T04〜T07 で行う
- 2026-10-21 / T02 / plugin-release の Shipping と依存 PR の節、verification.md の Release は依存の免除（3B）の説明なので、免除を入れる T05 に移した / T02 の変更欄から 2 件を外し、T05 に足した
- 2026-10-21 / T04 / 判定の書き出しをテストできるよう lib と CLI に分け、verify-pairs の構造の検査は最終の検査と一緒に T05 で足す / T04 の変更欄を `scripts/release-verdict.mjs`, `server/test/release-verdict.test.ts`, `.github/workflows/check.yml`, `scripts/lib/verify-pairs.mjs`, `server/test/verify-pairs.test.ts` から上の値に、完了条件から verify-pairs のテストを外した
- 2026-10-21 / T05 / 変更欄に `scripts/lib/release-scope.mjs`, `scripts/lib/release-scope.d.mts`, `server/test/verify-pairs.test.ts` を足した / 免除の対象の集合を release-scope に置き、verify-pairs のテストを足したため
- 2026-10-21 / T04 / Codex のタスクレビュー（high）: 指摘 0 件。指定のテストは Codex の sandbox で mkdtemp が EPERM になり走らせられなかった（手元では pass） / 対応なし
- 2026-10-21 / T06 / 変更欄を `scripts/lib/release-scope.mjs`, `scripts/lib/release-scope.d.mts` から `scripts/lib/release-verdict.mjs`, `scripts/lib/release-verdict.d.mts` に替えた / DEPENDENCY_INPUTS は T05 で入れ、実行と判定の照合は T07 と共有するため release-verdict に置いた
- 2026-10-21 / T05 / Codex のタスクレビュー（high）: 2 件（P2）、どちらも Codex が再現 / 2 件とも採り、修正タスク T08 を足した
- 2026-10-21 / T06 / Codex のタスクレビュー（high）: 2 件（P1 1、P2 1）、どちらも Codex がモックで再現 / 2 件とも採り、修正タスク T09 を足した
- 2026-10-21 / T07 / 変更欄を足した（前の値は same-tree の 2 ファイルとテスト、check.yml、verify-pairs とテスト） / push の判定の読み取りを `scripts/main-version-check.mjs` と `scripts/lib/main-version.mjs` に分け、--verdict の base の照合をリリースのバージョンに替え、plugin-release に一文足したため
- 2026-10-21 / T07 / Codex のタスクレビュー（high）: 指摘 0 件 / 対応なし
- 2026-10-21 / 全体 / Codex の全差分のレビュー（high）: 1 件（P2）。gh run download は同名の artifact の先頭を取るので、再実行の後に古い attempt の判定を読み、正しい免除を断って main を赤くする / 採り、修正タスク T10 を足した。artifact の名前は plan の `release-verdict` から `release-verdict-<attempt>` に変えた
- 2026-10-21 / T10 / Codex の再レビュー（medium）: 直っていて新しい欠陥なし / 対応なし
- 2026-10-21 / 全体 / review-shipping: 3 件（失敗したジョブだけの再実行で static が再利用され release-verdict-<最新の attempt> が無く main が赤くなる、main への管理者の直接 push で依存だけの変更が pre-commit を通る、lefthook の古いコメント） / 3 件とも採り、修正タスク T11 を足した
- 2026-10-21 / 全体 / GitHub の Codex のレビュー（PR #377、99d20939）: 1 件（P2）。改行と Markdown を含むファイル名が job summary で見出しやリンクとして出る（Codex が再現） / 採り、修正タスク T12 を足した
- 2026-10-21 / T12 / PR の CI の CodeQL が high の double escaping を 1 件出した（JSON の文字列化の後にバックスラッシュをもう一度エスケープしていた） / 採り、修正タスク T13 を足した
