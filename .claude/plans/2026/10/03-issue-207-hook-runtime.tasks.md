---
kind: tasks
plan: 03-issue-207-hook-runtime.plan.md
branch: fix/issue-207-hook-runtime
base: main
---

# フックを Windows の PowerShell でも動かし、deliver.js から zod を外して、doctor を Windows で正しく報告させる のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: Windows で配信と doctor が働く

PowerShell のコマンドにも記録が出て、doctor が Windows で黙らずに理由を出し、切り離した送信がコンソールを開かない。

- [x] T01: PowerShell ツールのコマンドにも配信し、終わった計画を消して 0.6.26 にそろえる
  - 種別: 修正
  - 計画: S1, S8, S9
  - 依存: なし
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`, `plugin/hooks/hooks.json`, `scripts/check-ai-config.mjs`, `README.md`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - red: `cd server && node --test --test-name-pattern PowerShell test/deliver.test.ts` → 足した PowerShell のテストが、記録が出ない（期待の不一致）で落ちる
  - 完了条件: `bun run test` → pass、`bun run verify:ai` → exit 0
  - コミット: `fix(deliver): deliver records for PowerShell tool commands`
  - 結果: red `node --test --test-name-pattern PowerShell test/deliver.test.ts` → 空文字が返り `/trace:ext-s1\/map /` に一致せず落ちた。直した後 `bun run test` → 613 pass、`bun run verify:ai` → exit 0。matcher から PowerShell を外すと verify:ai が「must cover Read, Bash, and PowerShell」で落ちるのを確かめた

- [x] T02: capture の切り離した送信に windowsHide を付ける
  - 種別: 修正
  - 計画: S3
  - 依存: なし
  - 変更: `server/src/capture.ts`
  - red: `grep -c windowsHide server/src/capture.ts` → 0（Windows で送信のたびにコンソールが開き得る）
  - 完了条件: `grep -c windowsHide server/src/capture.ts` → 1、`bun run test` → pass
  - コミット: `fix(capture): hide the console window of the detached flush on Windows`
  - 結果: red `grep -c windowsHide server/src/capture.ts` → 0。直した後 → 1、`bun run test` → 613 pass。コンソールが出ないことは Windows の実機が無く確かめていない（T07 の Stop の送信で起動の成否だけ見る）

- [x] T03: doctor が Windows で npm・claude・動いている MCP を、調べられなかった理由付きで出す
  - 種別: 修正
  - 計画: S4
  - 依存: なし
  - 変更: `server/src/plugin.ts`, `server/test/plugin.test.ts`
  - red: `cd server && node --test --test-name-pattern Windows test/plugin.test.ts` → 足したテストが、win32 で `ps`・`npm` を名前で起動する・調べられなかった行が無い（期待の不一致）で落ちる
  - 完了条件: `bun run test` → pass、`bun run sql:live` → exit 0
  - コミット: `fix(doctor): report what could not be inspected on Windows`
  - 結果: red 新しいテストを今のコードに当てると、Windows のテストが `running` が配列のまま（期待の不一致）で落ちた（findExe・npmCli の import を外した写しで実行）。直した後 `bun run test` → 615 pass、`bun run sql:live` → exit 0。手元の `sphica doctor` は node の隣の npm-cli.js で global の 0.6.25 を見つけた

## P2: bundle を小さく保つ

deliver.js から zod を外し、サイズの上限と zod の混入を bundle のたびに落とす。

- [x] T04: findings の schema を review-findings.ts に移し、deliver.js から zod を外す
  - 種別: 変更
  - 計画: S2
  - 依存: なし
  - 変更: `server/src/review.ts`, `server/src/review-findings.ts`, `server/src/mcp.ts`, `server/evals/acceptance/driver.ts`, `server/test/review.test.ts`
  - 完了条件: `bun run bundle && grep -c ZodError plugin/dist/deliver.js` → 0、`bun run test` → pass
  - コミット: `perf(deliver): keep zod out of the delivery hook bundle`
  - 結果: `bun run bundle && grep -c ZodError plugin/dist/deliver.js` → 0。deliver.js は 1,066,559 → 389,999 バイト。`bun run test` → 615 pass、`bun run architecture` と `bun run sql:reach`（203 / 203）も通った

- [x] T05: bun の metafile から bundle ごとの上限と zod の混入を検査する
  - 種別: 追加
  - 計画: S2
  - 依存: T04（上限の定数は zod を外した後のサイズから決める。外す前は zod の検査が落ちる）
  - 変更: `scripts/bundle.mjs`, `scripts/lib/bundle-budget.mjs`, `scripts/lib/bundle-budget.d.mts`, `server/test/bundle-budget.test.ts`, `.gitignore`, `server/src/plugin.ts`
  - 完了条件: `bun run test` → bundle-budget の落ちる例を含め全件 pass、`bun run bundle` → exit 0
  - コミット: `build: check bundle size budgets and keep zod out of hook bundles`
  - 結果: `bun run test` → 620 pass（bundle-budget 5 件を含む）、`bun run bundle` → exit 0、`bun run knip` → 指摘なし。deliver.ts に `export const probe = z.string()` を一時的に足すと `bun run bundle` が「1066228 bytes, over its budget of 429000」と「bundles zod」で exit 1 になり、戻すと通った

- [x] T09: doctor の Windows のテストを手元の node の配置から切り離し、npm i -g が入っていないときも行を出す
  - 種別: 修正
  - 計画: S4
  - 依存: T03（直す対象の doctor の観察）
  - 変更: `server/src/plugin.ts`, `server/test/plugin.test.ts`
  - red: `cd server && node --test --test-name-pattern "not installed" test/plugin.test.ts` → 「npm i -g CLI  not installed」の行が無く落ちる
  - 完了条件: `bun run test` → pass
  - コミット: `fix(doctor): show a missing npm i -g CLI and test Windows apart from the local node`
  - 結果: red は上のとおり落ちた（Input に npm i -g の行が無い）。テストの環境依存（node の隣に npm-cli.js がある Windows で別の結果になる）は手元の macOS では再現しない（Codex がメモリ上で再現）。observe に execPath を引数で渡せるようにし、テストは npm の無い一時ディレクトリの node.exe を渡す。`bun run test` → 621 pass

## P3: パックしたフックを定義どおりに動かして測る

Windows の CI で、フックの起動の上乗せを測り、パックした hooks.json から capture と deliver を最後まで動かす。

- [x] T06: フックの起動を、直接と PowerShell 経由で測る道具を足し、Windows の CI で流す
  - 種別: 追加
  - 計画: S5
  - 依存: なし
  - 変更: `scripts/measure-hook-launch.mjs`, `.github/workflows/check.yml`
  - 完了条件: `node scripts/measure-hook-launch.mjs` → 手元で直接起動の中央値を出して exit 0、`actionlint .github/workflows/check.yml` → 指摘なし
  - コミット: `ci: measure hook launch time directly and through PowerShell on Windows`
  - 結果: `node scripts/measure-hook-launch.mjs` → 手元の macOS で deliver.js 直接 47.7 ms・sh 経由 50.7 ms、capture.js 直接 39.2 ms・sh 経由 42.5 ms（20 組）で exit 0。`actionlint .github/workflows/check.yml` → 指摘なし。Windows の値は PR の CI で取る

- [x] T07: パックした hooks.json の定義どおりに capture と deliver を起動する check-hooks-live を足す
  - 種別: 追加
  - 計画: S6
  - 依存: T01（PowerShell の PreToolUse で記録が出ることを確かめる）, T02（Stop の切り離した送信を Windows で確かめる対象）
  - 変更: `scripts/check-hooks-live.mjs`, `package.json`, `.github/workflows/check.yml`
  - 完了条件: `bun run bundle && bun run hooks:live` → exit 0、`actionlint .github/workflows/check.yml` → 指摘なし
  - コミット: `test: launch packed hooks as hooks.json defines them`
  - 結果: `bun run bundle && bun run hooks:live` → exit 0（約 1 秒）。capture.js の切り離した送信を止めた写しでは「did not put the owner's prompt in the database within 30 seconds」で落ち、戻すと通った。`actionlint .github/workflows/check.yml` → 指摘なし。`bun run verify` → exit 0（acceptance 103 pass）。Windows の PowerShell の道は PR の CI で確かめる

- [x] T10: Windows の CI で check-hooks-live を plugin/ の中から正しいパスで起動する
  - 種別: 修正
  - 計画: S6
  - 依存: T07（直す対象の CI の手順）
  - 変更: `.github/workflows/check.yml`
  - red: `gh run view 37099886316 --job 111137193065 --log` → 「Cannot find module 'D:\a\sphica\sphica\plugin\scripts\check-hooks-live.mjs'」で windows が落ちた
  - 完了条件: `actionlint .github/workflows/check.yml` → 指摘なし（windows の pass は plan の A5 で確かめる）
  - コミット: `ci: start check-hooks-live from the repository root path on Windows`
  - 結果: red は上のとおり（その手順は `cd plugin` の後に流れる）。`../scripts/check-hooks-live.mjs` にし、`actionlint .github/workflows/check.yml` → 指摘なし。windows の pass は plan の A5（push の後の CI）で確かめる

- [x] T11: 起動の計測を同じ node でそろえて回数を確かめ、check-hooks-live の git を親の設定から切り離す
  - 種別: 修正
  - 計画: S5, S6
  - 依存: T06（直す対象の計測）, T07（直す対象の検査）
  - 変更: `scripts/measure-hook-launch.mjs`, `scripts/check-hooks-live.mjs`
  - red: `node scripts/measure-hook-launch.mjs --pairs 0` → NaN を出して exit 0。親に `GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=true GIT_CONFIG_KEY_1=gpg.program GIT_CONFIG_VALUE_1=/usr/bin/false` を置いて `node scripts/check-hooks-live.mjs` → 「gpg failed to sign the data」で落ちる
  - 完了条件: `node scripts/measure-hook-launch.mjs --pairs 0` → exit 2、同じ git の設定を置いた `node scripts/check-hooks-live.mjs` → exit 0
  - コミット: `fix(scripts): use one node for launch timing and isolate the hooks fixture from git config`
  - 結果: red は上のとおり。直した後 `--pairs 0` → 「--pairs must be a whole number from 1 to 1000」で exit 2、`--pairs 6` → 測れた。シェル経由も process.execPath を起動する。署名の設定を置いた親から `node scripts/check-hooks-live.mjs` → 通った（fixture の git は GIT_CONFIG_NOSYSTEM と一時の GIT_CONFIG_GLOBAL だけを読む）

- [x] T08: Windows の計測で exec form を決め、hooks.json・check-ai-config・README・doctor をそろえる
  - 種別: 変更
  - 計画: S7
  - 依存: T06（判定に使う計測値が要る）, T07（決めた形で起動して確かめる）, T03（(a) のとき doctor が claude を見つけて版を読む）
  - 変更: `scripts/check-ai-config.mjs`, `plugin/hooks/hooks.json`, `README.md`, `server/src/plugin.ts`, `server/test/plugin.test.ts`
  - 完了条件: `bun run verify` → exit 0（windows を含む CI の全件 pass は plan の A5 で確かめる）
  - コミット: `build: identify Claude hooks by their exact launch definition`
  - 結果: 計測が 100 ms を超えたので (a)。hooks.json の全 entry を `"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/dist/<x>.js"]` にし、timeout・async・matcher はそのまま。check-ai-config は event ごとの定義を丸ごと照合する。shell form、違う script、args 無し、PowerShell の無い matcher、timeout の変化、async の欠落、余分な引数の 7 通りに壊すと、どれも `verify:ai` が落ちた。doctor の 2.1.139 未満の ✗ は、テストを先に足して期待の不一致で落ちることを確かめてから入れた。手元の doctor は「✓ Claude Code app 2.1.288」。README の Requirements に 2.1.139 以上を書いた。`bun run verify` → exit 0（hooks:live は exec form で起動）

## 記録
2026-10-03 / T01 / Codex のタスクレビュー F1（Windows でパスの大文字・小文字を変えたコマンドに記録が出ない）/ 見送り。namedInCommand の照合は Bash（macOS でも同じ）と Read に共通の仕様で、PowerShell の道で入った欠陥ではない
2026-10-03 / T02 / Codex のタスクレビュー / 指摘なし
2026-10-03 / T04 / 変更欄に `server/test/review.test.ts` を足した（前: 4 ファイル、後: 5 ファイル）/ checkFindings の import 元が変わるため
2026-10-03 / T05 / 変更欄と完了条件を直した（前: `scripts/lib/bundle-budget.test.mjs` と `package.json`、`node --test scripts/lib/bundle-budget.test.mjs`。後: `server/test/bundle-budget.test.ts` と `scripts/lib/bundle-budget.d.mts`、`bun run test`）/ scripts/lib のモジュールは server/test から試す慣習に合わせた
2026-10-03 / T05 / knip が T03 で足した `Unknown` 型の export を未使用と指摘したので、T05 のコミットで export を外した（変更欄に `server/src/plugin.ts` を足した）
2026-10-03 / T03 / Codex のタスクレビュー F1（Windows のテストが node の隣の npm-cli.js の有無に依存）と F2（npm i -g が入っていないとき行が無い）/ 両方採り、修正タスク T09 を足した
2026-10-03 / T07 / Stop の入力に prompt_id が無いと capture は送信を始めない（ターン id が要る）。本物の Claude Code は Stop にも prompt_id を付けるので、検査の入力に付けた
2026-10-03 / T07 / 子の PATH を node と git の場所だけにしたので sh が見つからなかった。POSIX は /bin/sh、Windows は SystemRoot の powershell.exe を絶対パスで起動する
2026-10-03 / T06 / Windows の CI（run 37099886316）の計測: deliver.js 直接 112.3 ms・PowerShell 経由 343.7 ms（差 231.3 ms）、capture.js 直接 114.2 ms・PowerShell 経由 340.8 ms（差 226.6 ms）。基準の 100 ms を超えたので T08 は (a) exec form にする
2026-10-03 / T08 / 完了条件を変えた（前: `bun run verify` と `gh pr checks` の全件 pass。後: `bun run verify`、CI は plan の A5）/ CI はこのコミットを push した後にしか走らず、チェックを付けるコミットの中で確かめられないため
\n
2026-10-03 / T06 / Codex のタスクレビュー F1（直接とシェル経由で別の node を使い得る）と F2（--pairs を確かめない）/ 両方採り T11 で直した
2026-10-03 / T07 / Codex のタスクレビュー F1（Windows の CI のパス）は T10 で直し済み。F2（fixture の git が親の設定を引き継ぐ）は採り T11 で直した。sql:live の live-harness の makeRepo にも同じ形があるが、この PR の範囲の外なので変えない
2026-10-03 / T09 / Codex のタスクレビュー / 指摘なし
2026-10-03 / T04, T05 / Codex のタスクレビュー / 指摘なし
