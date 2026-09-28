---
kind: tasks
plan: 28-github-hardening.plan.md
branch: feat/github-hardening
base: main
---

# Codex レビューの完了をリリースの関門で機械的に確かめ、GitHub 側の設定とジョブの上限を締め、closingRefs が HTML コメントを読まないようにし、README のバッジから説明へ辿れるようにする（#184） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 配布物の修正

0.5.6 として、closingRefs が HTML コメントの中の参照を読まなくなり、README のバッジから説明へ辿れる。

- [x] T01: npm と 3 つの manifest のバージョンを 0.5.6 に上げる
  - 種別: 変更
  - 計画: S1
  - 依存: なし
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `grep -h '"version"' plugin/package.json plugin/.claude-plugin/plugin.json plugin/.codex-plugin/plugin.json .claude-plugin/marketplace.json` → 4 行とも 0.5.6
  - コミット: `chore(release): bump to 0.5.6`
  - 結果: `grep -h '"version"' ...` → 4 行とも "version": "0.5.6"

- [x] T02: closingRefs が HTML コメントの中の参照を読まないようにする
  - 種別: 修正
  - 計画: S2
  - 依存: T01（配布物の変更はバージョンを上げた後でないとコミットできない）
  - 変更: `server/src/github.ts`, `server/test/github.test.ts`
  - red: `cd server && node --test test/github.test.ts` → .github/pull_request_template.md の本文を読んだ PR が issue 12 を閉じる参照として返し失敗
  - 完了条件: `bun run test` → テンプレートの本文から参照が返らず、コメントの外の `Closes #3` は返り、閉じない開始記号の後ろは返らず、閉じない開始記号が多い入力でも線形の時間で終わる検査を含めて通る
  - コミット: `fix(github): ignore closing references inside HTML comments`
  - 結果: red を実測（`node --test test/github.test.ts` → `Error: no answer for issues/12`、テンプレートのコメントから issue 12 を読みに行った）。直した後 `bun run test` → 全件 pass（開始記号 20 万個の入力も 1 秒以内）

- [x] T03: 両方の README のバッジの下に説明への案内を足し、日本語版の Security 節を今の手順に直す（#184）
  - 種別: 変更
  - 計画: S6
  - 依存: T01（README は配布物に入るので、バージョンを上げた後でないとコミットできない）
  - 変更: `README.md`, `README.ja.md`
  - 完了条件: `sed -n 3,12p README.md README.ja.md` → バッジの行の直下に CI と来歴の節へのリンクがある。`rg -n "ステージ|2 要素認証" README.ja.md` → 0 件。`bun run verify:ai` → 通る
  - コミット: `docs(readme): point from the badges to what CI and releases check`
  - 結果: `sed -n 3,12p README.md README.ja.md` → バッジの直下に Contributing / Security（貢献 / セキュリティ）へのリンクと「通っていてもバグや脆弱性が無い意味ではない」の 1 行。`rg -n "ステージ|2 要素認証" README.ja.md` → 0 件。`bun run verify:ai` と `bun run english` → 通る

## P2: リリースの関門と GitHub の設定

リリースは Codex のレビューが head で完了していないと止まり、GitHub 側の設定の穴を手元の検査が見つける。

- [x] T04: release-gate が Codex の要約の完了と未解決のスレッド 0 件を確かめる
  - 種別: 追加
  - 計画: S3
  - 依存: なし
  - 変更: `scripts/lib/release-gate.mjs`, `scripts/lib/release-gate.d.mts`, `scripts/release-gate.mjs`, `server/test/release-gate.test.ts`, `server/test/release-gate-cli.test.ts`, `.github/workflows/release.yml`
  - 完了条件: `bun run test` → 要約の欠落・別の作者・headSha の不一致・running・マーカーの JSON の破損・未解決のスレッドのそれぞれで止め、すべてそろったときだけ通す検査を含めて通る
  - コミット: `feat(release): require a completed Codex review with no open threads on the head`
  - 結果: `node --test test/release-gate.test.ts test/release-gate-cli.test.ts` → 13 pass / 0 fail（要約なし・別の作者・type User・2 件・別の head・running・JSON の破損・未解決 1 件・isResolved 欠落で止め、CLI も running で exit 1）。PR #183 の本物のコメントとスレッドで判定を流し、head 8f892dc は問題 0 件、古い head f772ff3 は「tag commit のものではない」で止まった

- [x] T05: immutable releases と SHA 固定の強制を有効にし、release:plan と release:status で確かめる
  - 種別: 追加
  - 計画: S4, S7
  - 依存: なし
  - 変更: `scripts/lib/repo-settings.mjs`, `scripts/lib/repo-settings.d.mts`, `scripts/release-plan.mjs`, `scripts/release-status.mjs`, `server/test/repo-settings.test.ts`
  - 完了条件: `bun run test` → 200・404・それ以外、true・false の全分岐の検査を含めて通る。持ち主のトークンで両設定を有効にした後 `bun run release:status` → 両方とも有効と表示
  - コミット: `feat(release): check immutable releases and SHA pinning from release:plan and release:status`
  - 結果: 有効にする前の `bun run release:plan -- --base v0.5.5` と `bun run release:status` → 両設定とも off と表示して exit 1。`rg` で全 44 件の `uses:` が完全な SHA と確認してから `gh api -X PUT` で両設定を有効にし（204）、読み直して `{"enabled":true}` と `sha_pinning_required:true`。`bun run release:status` → 両方とも on。`bun run test` → 307 pass / 0 fail

- [x] T06: pr-body のジョブ名を verification-section にし、各ジョブに上限の時間を付ける
  - 種別: 変更
  - 計画: S5, S7
  - 依存: なし
  - 変更: `.github/workflows/pr-body.yml`, `.github/workflows/check.yml`, `.agents/skills/plugin-release/SKILL.md`
  - 完了条件: `actionlint .github/workflows/pr-body.yml .github/workflows/check.yml` → 指摘なし。`rg -n "codex-review" .github CLAUDE.md AGENTS.md .agents plugin` → ジョブ名としての参照が 0 件。main の必須チェックの付け替えは PR を開いて新しいチェックが走った後に行い、plan の A5 で確かめる
  - コミット: `ci: name the PR body check for what it checks and cap job times`
  - 結果: `actionlint .github/workflows/pr-body.yml .github/workflows/check.yml` → 指摘なし。`rg -n "codex-review" .github CLAUDE.md AGENTS.md .agents plugin` → Skill 名の参照 2 件だけ（CLAUDE.md:66、pr-body.yml のメッセージ内）。必須チェックの付け替えは PR の上で verification-section が走った後に行う

## P3: レビューの直し

タスクごとのレビューで出た指摘を直す。

- [x] T07: release-gate の CLI テストで、全ページを読むことと API の失敗で止まることを守る
  - 種別: 変更
  - 計画: S3
  - 依存: T04（守る対象の取得処理が要る）
  - 変更: `server/test/release-gate-cli.test.ts`
  - 完了条件: `cd server && node --test test/release-gate-cli.test.ts` → 2 ページ目の未解決スレッドで止まり、API の失敗で 0 以外で終わる検査を含めて通る
  - コミット: `fix: address task reviews of the gate, settings, and PR body wording`
  - 結果: `node --test test/repo-settings.test.ts test/release-gate-cli.test.ts` → 6 pass / 0 fail。`--paginate` を一時的に外すと release-gate-cli の 4 件中 3 件が落ちることを確かめてから戻した

- [x] T08: pr-body の文言を「Codex のレビューに触れているか」に狭める
  - 種別: 修正
  - 計画: S5
  - 依存: T06（直す対象の文言が要る）
  - 変更: `.github/workflows/pr-body.yml`
  - red: `rg -n "records the Codex review result" .github/workflows/pr-body.yml` → 2 件（結果が無くても「Codex」の文字だけで通るのに、記録を確かめたと言い切っている）
  - 完了条件: `rg -n "records the Codex review result" .github/workflows/pr-body.yml` → 0 件。`actionlint .github/workflows/pr-body.yml` → 指摘なし
  - コミット: `fix: address task reviews of the gate, settings, and PR body wording`
  - 結果: red を実測（`git show HEAD:.github/workflows/pr-body.yml | rg -c "records the Codex review result"` → 2）。直した後 `rg -n "records the Codex review result" .github/workflows/pr-body.yml` → 0 件、`actionlint` → 指摘なし

- [x] T09: immutable releases の 404 を off ではなく unknown として扱う
  - 種別: 修正
  - 計画: S4
  - 依存: T05（直す対象の判定が要る）
  - 変更: `scripts/lib/repo-settings.mjs`, `server/test/repo-settings.test.ts`
  - red: 直す前の scripts/lib/repo-settings.mjs で `cd server && node --test test/repo-settings.test.ts` → 404 が `off` になり失敗
  - 完了条件: `bun run test` → 404 が unknown になる検査を含めて通る。`bun run release:status` → 両設定とも on
  - コミット: `fix: address task reviews of the gate, settings, and PR body wording`
  - 結果: red を実測（actual `['off', 'on']`）。直した後 repo-settings と release-gate-cli のテスト → 6 pass / 0 fail、`bun run release:status` → 両方とも on

- [x] T10: release-gate が 1 MiB を超える PR のコメントでも止まらないようにする
  - 種別: 修正
  - 計画: S3
  - 依存: T07（直す対象の取得と、その CLI テストが要る）
  - 変更: `scripts/release-gate.mjs`, `server/test/release-gate-cli.test.ts`
  - red: `cd server && node --test --test-name-pattern="megabyte" test/release-gate-cli.test.ts` → 2 MB のコメントを返す偽の gh で `spawnSync gh ENOBUFS` になり失敗
  - 完了条件: `cd server && node --test test/release-gate-cli.test.ts test/release-gate.test.ts` → 1 MiB を超えるコメントでも通る検査を含めて通る
  - コミット: `fix(release): read PR comments past a megabyte in the release gate`
  - 結果: red を実測（`spawnSync gh ENOBUFS`）。直した後 `node --test test/release-gate-cli.test.ts test/release-gate.test.ts` → 15 pass / 0 fail

- [x] T11: 関門が要約の表の Code Review と Security Review の両方の完了を確かめ、手順書に最後の head での再レビューと、レビュー待ちで止まったときの流し直しを書き、関門のジョブに issues: read を足す
  - 種別: 修正
  - 計画: S3
  - 依存: T10（直す対象の関門の取得と判定が要る）
  - 変更: `scripts/lib/release-gate.mjs`, `server/test/release-gate.test.ts`, `server/test/release-gate-cli.test.ts`, `scripts/release-plan.mjs`, `.agents/skills/plugin-release/SKILL.md`, `.github/workflows/release.yml`
  - red: `cd server && node --test test/release-gate.test.ts` → Code Review の行が Running の要約でも問題 0 件で通り失敗
  - 完了条件: `bun run test` → 表の行が Running・別の commit・欠落のそれぞれで止める検査を含めて通る。PR #183 の本物のコメントで判定 → 問題 0 件。`actionlint .github/workflows/release.yml` と `bun run verify:ai` → 通る
  - コミット: `fix(release): require both Codex reviews done on the head and document re-review before tagging`
  - 結果: red を実測（actual ''）。直した後 `bun run test` → 309 pass / 0 fail、PR #183 の本物のデータで `[]`、`actionlint` と `bun run verify:ai` と `bun run check` → 通る

## 記録

- 2026-09-28 / - / 持ち主の指示で、.claude/plans の他の plan と tasks（27-claude-bash-delivery、27-eval-structured-grading、28-bind-github-owner、28-confirm-before-override、28-release-automation）を最初のコミットで削除する。ほかのファイルからの参照は 0 件（rg で確認）
- 2026-09-28 / T04 / release-gate の CLI テストの偽の gh も新しい API に答える必要があり、release.yml の関門の説明コメントも古くなった / 変更欄に release-gate-cli.test.ts と release.yml を足した
- 2026-09-28 / T02 のレビュー / F1（`<!-->` や途中に `--` を含む並びは GFM ではコメントにならず表示されるのに、参照を落とす。Codex が再現）は見送り: plan の「結び付きを落とす方向は安全」の範囲で、起きるのは結び付きの欠落だけ
- 2026-09-28 / T05 / immutable releases の GET は、無効でも 404 ではなく 200 で `enabled:false` を返した（docs の 404 と違う） / 両方を off として扱うようにした
- 2026-09-28 / T06 / plugin-release Skill の関門の説明が新しい判定（Codex の要約と未解決のスレッド、release:plan の設定の確認）を含まない / 変更欄に .agents/skills/plugin-release/SKILL.md を足した
- 2026-09-28 / T04 のレビュー / F1（CLI テストがページングと API の失敗を守っていない）を採用し T07
- 2026-09-28 / T06 のレビュー / F1（文言が検査の中身より強い）を採用し T08
- 2026-09-28 / T05 のレビュー / F1（404 を off と判定する）を採用し T09。F2（release:plan --json の CLI 全体のテストが無い）は見送り: release:plan は手元で人が読む道具で、判定は単体テストで押さえている
- 2026-09-28 / 差分全体の Codex レビュー / 指摘 1 件（gh の出力を execFileSync の既定 1 MiB で受け、長い PR で ENOBUFS。Codex が再現）を採用し T10
- 2026-09-28 / review-shipping / #1（手順書の順序ではレビュー後の push や main のマージで head が変わり、関門で止まってバージョンを 1 つ失う。#182 の本物のデータで再現）と #2（マーカーがどちらのレビューを追うか不明）を採用し T11。関門のジョブの issues: read（読めるか未確認）も T11 で足した。必須チェックの付け替えはタグの前に行う
