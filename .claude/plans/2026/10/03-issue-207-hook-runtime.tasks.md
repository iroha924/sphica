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

- [ ] T03: doctor が Windows で npm・claude・動いている MCP を、調べられなかった理由付きで出す
  - 種別: 修正
  - 計画: S4
  - 依存: なし
  - 変更: `server/src/plugin.ts`, `server/test/plugin.test.ts`
  - red: `cd server && node --test --test-name-pattern Windows test/plugin.test.ts` → 足したテストが、win32 で `ps`・`npm` を名前で起動する・調べられなかった行が無い（期待の不一致）で落ちる
  - 完了条件: `bun run test` → pass、`bun run sql:live` → exit 0
  - コミット: `fix(doctor): report what could not be inspected on Windows`

## P2: bundle を小さく保つ

deliver.js から zod を外し、サイズの上限と zod の混入を bundle のたびに落とす。

- [ ] T04: findings の schema を review-findings.ts に移し、deliver.js から zod を外す
  - 種別: 変更
  - 計画: S2
  - 依存: なし
  - 変更: `server/src/review.ts`, `server/src/review-findings.ts`, `server/src/mcp.ts`, `server/evals/acceptance/driver.ts`
  - 完了条件: `bun run bundle && grep -c ZodError plugin/dist/deliver.js` → 0、`bun run test` → pass
  - コミット: `perf(deliver): keep zod out of the delivery hook bundle`

- [ ] T05: bun の metafile から bundle ごとの上限と zod の混入を検査する
  - 種別: 追加
  - 計画: S2
  - 依存: T04（上限の定数は zod を外した後のサイズから決める。外す前は zod の検査が落ちる）
  - 変更: `scripts/bundle.mjs`, `scripts/lib/bundle-budget.mjs`, `scripts/lib/bundle-budget.test.mjs`, `.gitignore`, `package.json`
  - 完了条件: `node --test scripts/lib/bundle-budget.test.mjs` → 落ちる例を含め全件 pass、`bun run bundle` → exit 0
  - コミット: `build: check bundle size budgets and keep zod out of hook bundles`

## P3: パックしたフックを定義どおりに動かして測る

Windows の CI で、フックの起動の上乗せを測り、パックした hooks.json から capture と deliver を最後まで動かす。

- [ ] T06: フックの起動を、直接と PowerShell 経由で測る道具を足し、Windows の CI で流す
  - 種別: 追加
  - 計画: S5
  - 依存: なし
  - 変更: `scripts/measure-hook-launch.mjs`, `.github/workflows/check.yml`
  - 完了条件: `node scripts/measure-hook-launch.mjs` → 手元で直接起動の中央値を出して exit 0、`actionlint .github/workflows/check.yml` → 指摘なし
  - コミット: `ci: measure hook launch time directly and through PowerShell on Windows`

- [ ] T07: パックした hooks.json の定義どおりに capture と deliver を起動する check-hooks-live を足す
  - 種別: 追加
  - 計画: S6
  - 依存: T01（PowerShell の PreToolUse で記録が出ることを確かめる）, T02（Stop の切り離した送信を Windows で確かめる対象）
  - 変更: `scripts/check-hooks-live.mjs`, `package.json`, `.github/workflows/check.yml`
  - 完了条件: `bun run bundle && bun run hooks:live` → exit 0、`actionlint .github/workflows/check.yml` → 指摘なし
  - コミット: `test: launch packed hooks as hooks.json defines them`

- [ ] T08: Windows の計測で exec form を決め、hooks.json・check-ai-config・README・doctor をそろえる
  - 種別: 変更
  - 計画: S7
  - 依存: T06（判定に使う計測値が要る）, T07（決めた形で起動して確かめる）, T03（(a) のとき doctor が claude を見つけて版を読む）
  - 変更: `scripts/check-ai-config.mjs`, `plugin/hooks/hooks.json`, `README.md`, `server/src/plugin.ts`, `server/test/plugin.test.ts`
  - 完了条件: `bun run verify` → exit 0、`gh pr checks` → windows を含め全件 pass
  - コミット: `build: identify Claude hooks by their exact launch definition`

## 記録
