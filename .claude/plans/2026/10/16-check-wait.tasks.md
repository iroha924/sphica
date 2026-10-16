---
kind: tasks
plan: 16-check-wait.plan.md
branch: chore/check-wait-348
base: main
---

# 検査の待ち時間を CI・pre-push・release で縮め（#348）、README の Features を中心の 5 つから始める（#347） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 受け入れテストを別プロセスで並行に走らせる

手元の verify で最も長い受け入れテスト（271 秒）を、ケースを分けたファイルの並行で縮める。

- [x] T01: 受け入れテストの driver が親の CLAUDE_ENV_FILE へ書かないようにする
  - 種別: 修正
  - 計画: S1
  - 依存: なし
  - 変更: `server/evals/acceptance/driver.ts`
  - red: `f=$(mktemp); CLAUDE_ENV_FILE=$f SPHICA_ACCEPTANCE_LAYER=capture bun run acceptance; wc -c < $f` → 0 より大きい（SessionStart が `export SPHICA_PARENT_SESSION=…` を追記する）
  - 完了条件: `f=$(mktemp); CLAUDE_ENV_FILE=$f SPHICA_ACCEPTANCE_LAYER=capture bun run acceptance; wc -c < $f` → acceptance が成功し、`wc -c` が 0
  - コミット: `fix(eval): keep acceptance cases from writing the parent's CLAUDE_ENV_FILE (T01)`
  - 結果: red: 直す前に `CLAUDE_ENV_FILE=<一時ファイル> SPHICA_ACCEPTANCE_LAYER=capture bun run acceptance` → pass 18、ファイルが 538 バイト（`export SPHICA_PARENT_SESSION=s-ja-storage` ほか）。直した後に同じコマンド → pass 18 / fail 0、ファイル 0 バイト

- [x] T02: 受け入れテストをシャードのファイルに分け、ルートの acceptance で並行に走らせる
  - 種別: 変更
  - 計画: S1
  - 依存: なし
  - 変更: `server/evals/acceptance/cases-run.ts`, `server/evals/acceptance/run.ts`, `server/evals/acceptance/shard-1.ts`, `package.json`, `server/test/acceptance-cases.test.ts`, `knip.json`, `scripts/check-english.mjs`
  - 完了条件: `caffeinate -i bun run acceptance` → pass 148 / fail 0 で、時間が 271 秒より短い（選んだ N・並行数と、比べた値を結果に書く）。`cd server && node --import ./test/isolate-home.ts --test test/acceptance-cases.test.ts` → pass。`bun run --cwd server acceptance` → pass 148
  - コミット: `test(eval): run the acceptance cases as parallel shards (T02)`
  - 結果: `node --test --test-timeout=60000 --test-concurrency=<c> server/evals/acceptance/shard-*.ts` → N と並行数を変えて（この Mac 12 コア、caffeinate -i）全部 pass 148 / fail 0。N=8・既定の並行数（11）42 秒、N=12・11 で 50 秒、N=16・16 で 36 秒、N=4・3 で 116 秒、N=8・3 で 95 秒。N=8、並行数は既定を採った（CI の 4 vCPU では既定が 3）
  - 結果: `bun run acceptance` → 44 秒、tests 148 / pass 148 / fail 0（基準 271 秒）。`bun run --cwd server acceptance` → 250 秒、pass 148。`node --import ./test/isolate-home.ts --test test/acceptance-cases.test.ts` → pass 6。`bun run sql:reach` → 266 / 266。knip・english・lint・typecheck → 0

- [x] T08: bun run acceptance がシャードのファイルを名指しし、どれかが無ければ落ちるようにする
  - 種別: 修正
  - 計画: S1
  - 依存: T02（シャードのファイルと acceptance のスクリプトが要る）
  - 変更: `package.json`, `server/test/acceptance-cases.test.ts`
  - red: `node --test --test-timeout=60000 server/evals/acceptance/does-not-exist-*.ts` → tests 0 で exit 0（glob が何にも当たらないと 0 件で成功する。bun run の Bun Shell 経由でも同じく rc=0 を実測）
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/acceptance-cases.test.ts` → package.json の acceptance が shard-1..N をちょうど名指しするテストが pass
  - コミット: `ci: split check into parallel part jobs behind the required check names (T03, T04, T08)`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/acceptance-cases.test.ts` → pass 7 / fail 0。存在しないファイルを名指しすると node --test は exit 1（Codex のレビューで確認）

## P2: CI の check を部分ごとの並行のジョブにする

check の壁時計を、部分（static / unit / acceptance）のうち最も長いものにする。必須の check 名と、verify と同じ検査の集合は保つ。

- [x] T03: 部分ジョブの結果をまとめる判定スクリプト
  - 種別: 追加
  - 計画: S2
  - 依存: なし
  - 変更: `scripts/check-parts.mjs`, `scripts/lib/check-parts.mjs`, `scripts/lib/check-parts.d.mts`, `server/test/check-parts.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/check-parts.test.ts` → 全部 success で 0、failure / cancelled / skipped / 欠けのそれぞれで失敗するケースが pass
  - コミット: `ci: add the check that every part job succeeded (T03)`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/check-parts.test.ts` → pass 3 / fail 0（success で 0、failure / cancelled / skipped / 欠け / 想定外 / 壊れた NEEDS で失敗）。knip が check.yml から呼ばれるまで未使用と出すので T04 と同じコミットにした

- [x] T04: check.yml を部分ジョブと集約に分け、check-pairs で verify との一致・lychee・no-cache を見る
  - 種別: 変更
  - 計画: S2, S3
  - 依存: T03（集約ジョブが判定スクリプトを呼ぶ）
  - 変更: `.github/workflows/check.yml`, `package.json`, `scripts/check-pairs.mjs`, `scripts/lib/verify-pairs.mjs`, `scripts/lib/verify-pairs.d.mts`, `server/test/verify-pairs.test.ts`
  - 完了条件: `bun run pairs` → 0。`mise exec -- actionlint .github/workflows/check.yml` → 0。`cd server && node --import ./test/isolate-home.ts --test test/verify-pairs.test.ts` → 部分・コマンド・lychee・no-cache を消した写しで失敗するケースが pass
  - コミット: `ci: split check into parallel part jobs behind the required check names (T04)`
  - 結果: `bun run pairs` → 0。`mise exec -- actionlint .github/workflows/check.yml` → 0。`cd server && node --import ./test/isolate-home.ts --test test/verify-pairs.test.ts` → pass 7 / fail 0（部分・コマンド・重複・lychee の欠落と条件と版・no-cache・集約の if とスクリプトを消した写しで失敗）。lint・typecheck・knip・english・headers・comments・markdown・verify:ai・rule-scopes → 0

## P3: release の prepare を bundle の経路にする

タグの push の prepare から verify の重複（約 10 分）を外し、PR の dry run で同じ経路を実走する。

- [x] T05: release.yml の prepare から verify を外し、plugin-release の説明を合わせる
  - 種別: 変更
  - 計画: S4
  - 依存: T04（check-pairs が release.yml の verify の行を要求しなくなる）
  - 変更: `.github/workflows/release.yml`, `.agents/skills/plugin-release/SKILL.md`
  - 完了条件: `bun run pairs && bun run verify:ai` → 0。`mise exec -- actionlint .github/workflows/release.yml` → 0。`rg -n "bun run verify" .github/workflows/release.yml` → ヒットなし
  - コミット: `ci(release): build and check the tarball in prepare without rerunning verify (T05)`
  - 結果: `bun run pairs && bun run verify:ai` → 0。`mise exec -- actionlint .github/workflows/release.yml` → 0。`rg -n "bun run verify" .github/workflows/release.yml` → ヒットなし（rc=1）。捨てる clone（07f850b7 に新しい release.yml）で `CI=1 bun run setup && bun run bundle && git diff --exit-code HEAD` → npm pack → `node scripts/check-tarball.mjs` → 55 ファイル、CLI 0.6.60 が起動して DB を作成

## P4: worktree が共有の hook を書き換えないようにする

setup は依存の install scripts を流さず、hook はメインの作業ツリーで CI でないときだけ入れる。

- [x] T06: setup を --ignore-scripts にし、install-hooks で hook を入れる
  - 種別: 修正
  - 計画: S5
  - 依存: なし
  - 変更: `package.json`, `scripts/install-hooks.mjs`, `server/test/install-hooks.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/install-hooks.test.ts` → テストを先に書いて今の setup の形で流すと、worktree のケースが、共有の `.git/hooks/pre-commit` が worktree の node_modules を指すことで落ちる（捨てるリポジトリでは 2026-10-16 に再現済み）
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/install-hooks.test.ts` → main で入る / CI で入らない / worktree で前後のハッシュが同じ・無ければ作られない / install の失敗で 1、が pass。`bun run setup` → 0 で、`.git/hooks/pre-commit` がこのリポジトリの server/node_modules を指す
  - コミット: `fix(setup): install the git hooks only from the main working tree (T06)`
  - 結果: `env -u CI bun run setup` → red: 捨てる clone（19dbe3ea）の main と worktree で流すと、共有の pre-commit が main を 0 回・worktree を 2 回指す（worktree が書き換えた）
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/install-hooks.test.ts` → pass 4 / fail 0。worktree の判定を外した写しでは worktree のケースが落ちることを確かめて戻した
  - 結果: `env -u CI bun run setup` → 捨てる clone で main は hook を main へ向け、worktree は「not installed from the worktree」で 3 つの hook のハッシュが前後で同じ、`CI=1` は「not installed in CI」。このリポジトリでも rc=0 で pre-commit がこのリポジトリの server/node_modules を指す。lint・typecheck・knip・english・headers・comments・pairs・verify:ai → 0

## P5: README の Features を中心の 5 つから始める

- [ ] T07: README.md と README.ja.md の Features を並べ替える
  - 種別: 変更
  - 計画: S6
  - 依存: なし
  - 変更: `README.md`, `README.ja.md`
  - 完了条件: `for f in README.md README.ja.md; do awk '/^## (Features|できること)/{p=1;next} /^## /{p=0} p' $f | grep -c '^- \*\*'; done` → 17 と 17。`bun run verify:ai && bun run markdown` → 0
  - コミット: `docs(readme): lead the features with the core five (T07)`

## 記録

- 2026-10-16 / T02 / 変更欄の `shard-*.ts` は検査が実在のパスを要るので `shard-1.ts` で代表させ、knip.json（シャードを入口に）と check-english.mjs（cases-run.ts を English だけのファイルに）を足した / 変更欄を直した
- 2026-10-16 / T01, T02 / Codex のレビュー（high）: F1「glob に当たるシャードが 0 件だと受け入れテストが走らずに成功する」を採った。Codex は Bun Shell なら失敗すると書いたが、手元で `bun run` の当たらない glob が tests 0・rc=0 になるのを確かめた / 修正タスク T08 を足した
- 2026-10-16 / T03, T04 / T03 の変更欄に `scripts/lib/check-parts.d.mts`、T04 の変更欄に `package.json`（ci:<part>）と `scripts/lib/verify-pairs.d.mts` を足した（既存の .mjs は .d.mts で型を持つ）。T03 は knip の未使用を避けるため T04 と同じコミット / 変更欄を直した
