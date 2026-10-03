---
kind: plan
status: approved
codex_session: 01a10012-9b48-7483-8efc-ef4a9d3641bf
codex_rounds: 4
approved_at: 2026-10-03
---

# フックを Windows の PowerShell でも動かし、deliver.js から zod を外して、doctor を Windows で正しく報告させる

## 要点

- Claude Code の PowerShell ツールにも配信する（PreToolUse の matcher に `PowerShell`、deliver.ts で Bash と同じに扱う）
- `deliver.js` から zod を外し、bundle ごとのサイズの上限と zod の混入を `bun run bundle` で落とす
- capture の切り離した送信に `windowsHide: true`
- doctor は Windows で `npm`（.cmd）・`ps`・`lsof` を execFile しない。「入っていない」と「調べられなかった（理由）」を分けて出す
- パックした `hooks/hooks.json` の定義どおりにフックを起動する検査（`check-hooks-live`）を足し、verify と Windows の CI で流す
- exec form（`args`）は、Windows の CI で PowerShell を通す起動との差を測り、中央値で 100 ms 以上速いときだけ採る。それ以外は今の shell form のまま
- Codex の capture は同期のまま。`codex.json` は変えない（利用者がフックを信頼し直す必要なし）。終わった #209・#210 の plan と tasks を消す。0.6.26 で出す

## 持ち主の決定

- epic #200 の順番は #210、#209 の Fix、#207（「OK、その順番で進めるか。」）
- `codex.json` の変更は epic の中で 1 回のリリースにまとめる（記録 u99）
- 終わった plan と tasks のファイルは次の PR で消す（記録 delete-done-plans-in-pr）
- #207 で進める（「うん、それで進めよう」）

## 目的

- Git Bash の無い Windows（Claude Code が Bash ツールを登録しない）で、シェルのコマンドが記録のあるファイルを名指したときに配信される
- `plugin/dist/deliver.js` の metafile に `node_modules/zod/` の入力が無く、戻すと `bun run bundle` が落ちる
- Windows の `sphica doctor` が、npm のグローバルの CLI・Claude のプラグイン・動いている MCP サーバーについて、黙った「unknown」や空ではなく、値か「調べられなかった理由」を出す
- パックしたパッケージの `hooks/hooks.json` から起動した capture と deliver が、Windows の CI で、配信・spool・Stop の後の切り離した送信まで通る

## 対象外

- Codex の capture を async にすること（#207 の項目）: 採らない。`scripts/check-ai-config.mjs:281` が PR #93 から会話の順序を理由に禁じている。Codex の async のフックは始めた順に終わる保証が無く、セッションの終わりで打ち切られるので、UserPromptSubmit と Stop が作業ツリーの起点を取り合う（記録 one-baseline-race と同じ形）。理由を #207 に残す
- `module.enableCompileCache()`: 採らない。単一ファイルの bundle の中で有効にしても、その bundle 自身のコンパイルには間に合わず、初回は遅くなり得る（https://nodejs.org/api/module.html#module-compile-cache）。理由を #207 に残す
- Codex の `commandWindows`（`powershell.exe … node $env:PLUGIN_ROOT/...`）の変更
- #210 のターンの境目（記録 split-turn-boundaries で別の計画）
- 本物の Claude Code・Codex をホストにした結合の検査。check-hooks-live は定義どおりに起動する検査で、ホストそのものではない

## 前提

- `plugin/hooks/hooks.json`: 全部 shell form の `node "${CLAUDE_PLUGIN_ROOT}/dist/<x>.js"`。PreToolUse の配信の matcher は `Edit|Write|MultiEdit|NotebookEdit|Read|Skill|Bash`
- Claude Code の hooks の文書（https://code.claude.com/docs/en/hooks 、2026-10-03 取得）: PowerShell ツールの入力は Bash と同じく `command`。「Git Bash の無い Windows では Bash ツールを登録せず、Bash だけに当たる hook は発火しない」。shell form は Windows で Git Bash、無ければ PowerShell で動く。exec form は `args` があると `command` を PATH から直接起動し、Windows では実行ファイル（node.exe）である必要がある
- exec form は 2.1.139（2026-05-11）で入った（Claude Code の changelog）。実測（2026-10-03、公式の npm の 2.1.138 と darwin-arm64 のパッケージ、未ログインの一時 HOME で `-p hi --plugin-dir`）: 2.1.138 では shell form の SessionStart は走り、exec form は走らなかった。2.1.288 では両方走った。古いホストで exec form にすると capture も配信も黙って止まる。プラグインの manifest に Claude Code の最低バージョンを宣言する欄は無い（https://code.claude.com/docs/en/plugins-reference 、Codex が確認）
- 手元の起動時間（2026-10-03、macOS、15 回の中央値、一時 HOME、PreToolUse Read の入力）: deliver.js 61 ms、capture.js 43 ms、空の node 19 ms。Windows の PowerShell の起動の上乗せは未計測
- zod の経路: `server/src/deliver.ts:20` → `review.ts`（`selectForReview`）、`review-bridge.ts:7` → `review.ts`（`parseDiff`）。`review.ts:4` が zod を import し、`Finding`・`Findings` をモジュールの最上位で作る（`checkFindings` だけが使い、呼ぶのは `mcp.ts:443`）。手元の deliver.js は 1,066,559 バイト
- bun 1.4.0 の `bun build` は `--metafile=<path>` を持つ。出力ごとに `bytes` と寄与した `inputs` が出る（https://bun.sh/docs/bundler#metafile）
- `server/src/capture.ts:846`: `spawn(process.execPath, [argv1, "--flush"], { detached: true, stdio: "ignore" }).unref()`。Windows の detached の子は自前のコンソールを持つ（Node の文書）
- `server/src/plugin.ts`: `execFileSync("claude", …)`（231）、`("ps", …)`（265）、`("npm", ["root","-g"])`（302）、`("lsof", …)`（160、`/proc` の後）。global は「入っていない」と「調べられなかった」が両方 null で、report はその行を出さない（203、395、444 付近）。CLAUDE.md の invariant `windows`: `.cmd` を execFile しない
- `scripts/check-ai-config.mjs:309`、`:315`: Claude の配信の hook を `command.includes("/dist/deliver.js")` で見つけている。exec form にするとこの検査が全部外れる
- `scripts/lib/live-harness.mjs`: makeRepo・withTempDir はあるが、runCli・runHook は `server/src` を起動し（81、107）、fakeGh は POSIX 専用（38）、`GH_TOKEN` は消していない（67）。記録を種まきする道は無い
- `server/src/extract.ts:112-121`: trace_begin は送信待ちを同期で流す。`mcp-record.ts:48` はホストの作業場所（`CLAUDE_PROJECT_DIR`）を要る
- `.github/workflows/check.yml` の `windows`: tarball を pack して cli・init・doctor・MCP の tools/list を見るだけ。`pull_request` で走る

## 方針

1. PowerShell
   - `hooks.json` の PreToolUse の配信の matcher に `|PowerShell` を足す
   - `deliver.ts` でシェルのコマンドを指す `tool_name === "Bash"`（747 の pre_read の判定、767 の shell）を `Bash` か `PowerShell` にする。`shellPatch` は Codex 専用なので Bash のまま
   - テスト（`server/test/deliver.test.ts`）: `Get-Content .\src\a.ts`、`type src\a.ts`、`cat "C:\…\src\a.ts"` で記録が出る。Read との重複の判定と pre_read の行が Bash と同じ。名指しの無い PowerShell のコマンドでは何も出ない
   - `check-ai-config` は、Claude の PreToolUse の配信の matcher が `Read`・`Bash`・`PowerShell` を全部覆うことを求める
   - README の制限の行（142 行目の PowerShell の行）を消す
2. zod を deliver.js から外す
   - `Finding`・`Findings` と `checkFindings` を `server/src/review-findings.ts` に移す。`review.ts` はそれを import も re-export もしない。`mcp.ts` と acceptance の driver の import を直す
   - `scripts/bundle.mjs` は各 entry を `--metafile=<repo>/.build/meta-<entry>.json` 付きで build する（`.build/` を `.gitignore` に足す。`plugin/` の外なので出荷しない）
   - 純関数 `checkBundles(metas, budgets)` を `scripts/lib/bundle-budget.mjs` に置き、bundle.mjs の最後で呼ぶ。落とす条件: entry か metafile が無い、期待する JS の出力が無い、outputs が空、bytes が無いか有限でない、bytes が entry ごとの上限（変更後のサイズ +10% を定数で commit）を超える、deliver と capture の出力の inputs に区切りをそろえた `node_modules/zod/` を含むものがある
   - テスト: 作った metafile で上の各条件が落ちることと、正しいものが通ること。既存の review_check のテストが抽出後も通ること
   - 起動時間を変更の前後で測り（方針 5 の計測と同じ道具）、PR に書く
3. `capture.ts` の切り離した送信の spawn の options に `windowsHide: true`。確かめるのは check-hooks-live の Stop の送信が終わること（コンソールが出ないことまでは確かめられない）
4. doctor の Windows
   - global: npm の CLI を node の隣で探す（Windows: `<dirname(execPath)>/node_modules/npm/bin/npm-cli.js`、POSIX: `<dirname(execPath)>/../lib/node_modules/npm/bin/npm-cli.js`）。あれば `process.execPath` で `root -g` を 10 秒の上限で流す。無ければ POSIX だけ execFile(`npm`)、Windows は「調べられなかった: node の隣に npm の CLI が無い」。結果は「入っている（版）」「入っていない」「調べられなかった（理由）」の 3 つに分け、report は 3 つとも行を出す
   - claude: win32 では PATH を自分で走査して `claude.exe` だけを探す。無ければ「調べられなかった: PATH に claude.exe が無い（npm で入れると claude.cmd になる）」
   - 動いている MCP サーバー（ps・lsof）: win32 では「Windows では調べない」と出す
   - 集める関数は platform を引数で受ける。テストは集めた値と、出力の行の両方を見る
5. exec form の判定（ゲート）
   - `scripts/measure-hook-launch.mjs`: 同じ script・入力・cwd・環境・出力の扱いで、`node <script>` の直接起動と `powershell.exe -NoProfile -NonInteractive -Command node <script>` を、別々に温めてから 20 組交互に起動し、中央値を出す。Windows の CI の job で流して出力するだけ（落とさない）
   - 中央値の差が 100 ms 以上なら (a): 全 entry を `{"type":"command","command":"node","args":["${CLAUDE_PLUGIN_ROOT}/dist/<x>.js"]}` にし、timeout と async は今のまま。README に Claude Code 2.1.139 以上が要ること、それより古いと capture も配信も止まることを書き、doctor は Claude Code の版が 2.1.139 未満なら ✗ と更新の案内を出す（方針 4 の claude の見つけ方で `--version` を読む）
   - 100 ms 未満なら (b): shell form のまま。不採用の理由と計測値を #207 に残す
   - 100 ms は今回決めた基準で、技術的な境目ではない
   - どちらでも `check-ai-config` は Claude の hook を実行ファイルと引数の並び（(a)）か、正確なコマンドの文字列（(b)）で見分ける形に直し、309・315 の `includes` をやめる。落ちる例: script が無い、違う script、PowerShell の無い matcher、timeout・async の変化
6. check-hooks-live（`scripts/check-hooks-live.mjs`、`bun run hooks:live`）
   - 引数でパッケージの root（既定は `plugin/`）を受け、空白を含む一時ディレクトリに写してから使う。`hooks/hooks.json` を読み、ホストと同じ形で起動する: (a) なら command と args に `${CLAUDE_PLUGIN_ROOT}` を文字列で入れて直接起動、(b) なら shell form を POSIX は `sh -c` で、`CLAUDE_PLUGIN_ROOT` を環境に入れて文字列はそのまま渡す。Windows は Claude Code と同じく `${CLAUDE_PLUGIN_ROOT}` を `${env:CLAUDE_PLUGIN_ROOT}` に書き換えて PowerShell で起動する（https://code.claude.com/docs/en/hooks の PowerShell の節。ランナーに Git Bash があっても PowerShell の側を明示して流す）。どちらでもパスをシェルのコードに直接埋めない。matcher も manifest から読む
   - live-harness の makeRepo・withTempDir を使い、子の環境は許可の一覧で一から作る（PATH・SystemRoot・TEMP などの起動に要るものだけを親から写す）。HOME・USERPROFILE・`CODEX_HOME`・`CLAUDE_CONFIG_DIR` は一時ディレクトリ、`GH_CONFIG_DIR` は空のディレクトリ。`SPHICA_DB`・`SPHICA_HOME`・`GH_TOKEN`・`GITHUB_TOKEN`・`CLAUDE_PROJECT_DIR`・親のセッションの変数は写さず、要る子にだけ fixture の作業場所とセッションを入れる。fakeGh は使わない。CLI・MCP・フックはどれもパッケージの root の dist を起動する
   - 種まき: 別の fixture のセッションで capture にオーナーの発言を入れ、パッケージの `mcp-record.js` で trace_begin → record_context → record_check → record_save。オーナーの明示の決定を引用して adopt し、`src/a.ts` に anchor。active で出典ありになったことを確かめ、MCP のクライアントを閉じる。`CLAUDE_PROJECT_DIR` とセッションを明示で渡す
   - 計る回: 新しいセッションと一意のオーナーの発言で UserPromptSubmit → spool にある。PreToolUse の PowerShell `Get-Content .\src\a.ts` → 配信の文に記録があり、pre_read の行がある。Stop → 上限時間の中で DB にその発言が入るまで待つ。この回の間は trace_begin・glean_begin・runFlush を呼ばない（送信待ちを先に流すと、切り離した送信が空でも通ってしまう）
   - `bun run verify` に足し（`plugin/` に対して）、Windows の CI の job ではパックして展開した tarball に対して流す
   - bundle-budget のテストは `server/test/bundle-budget.test.ts` に置く（scripts/lib の他のモジュールと同じ形。`bun run test` と、verify の `sql:reach` が流す）
7. 終わった #209・#210 の plan と tasks の 4 ファイルを消す
8. `bun run release:plan -- --base v0.6.25` を流し、npm と 3 つの manifest を 0.6.26 にする（pre-commit の bundle の検査が package に入る変更と同じコミットでの更新を求めるので、最初の package に入るコミットで上げる）

## 採った案と棄却した案

- 採用: Codex の capture は同期のまま。棄却: UserPromptSubmit と PostToolUse を async（会話の順序と起点の取り合い、セッションの終わりで打ち切り）
- 採用: exec form は Windows の計測で 100 ms 以上速いときだけ。棄却: 無条件に exec form（2.1.139 より前で全フックが黙って止まる）。棄却: 今決めて shell form のまま（Windows の上乗せを測らずに捨てる）
- 採用: 古いホストへの対策は README と doctor の ✗。棄却: manifest で最低版を宣言（欄が無い）
- 採用: zod の schema を別モジュールに移す。棄却: deliver から selectForReview を外す（review.ts の他の部分も道になるので、zod の側を動かす方が狭い）
- 採用: npm は node の隣の npm-cli.js を process.execPath で。棄却: `APPDATA` や `npm_config_prefix` から推す（実際の npm の設定と一致する保証が無い）
- 採用: claude は win32 で claude.exe だけを PATH から探す。棄却: 今のまま名前で execFile（npm で入れた claude.cmd で黙って unknown）
- 採用: compile cache は採らない。棄却: bundle の先頭で `enableCompileCache()`（自分自身のコンパイルに間に合わない）
- 採用: 種まきはパッケージの mcp-record.js の trace。棄却: SQL で直接入れる道を足す（書き込みの経路を増やす）、glean（出典なしの規則が増える）
- 採用: metafile は `.build/` に。棄却: `plugin/dist` に置く（出荷物に入る）

## 手順

- S1: PowerShell の配信（方針 1）
- S2: zod の切り出し、metafile、サイズの上限と zod の検査（方針 2）
- S3: `windowsHide`（方針 3）
- S4: doctor の Windows（方針 4）
- S5: 起動の計測の道具と Windows の CI での計測（方針 5 の前半）
- S6: check-hooks-live と verify・Windows の CI への組み込み（方針 6）
- S7: 計測で exec form を決め、hooks.json・check-ai-config・README・doctor の版の検査を合わせる（方針 5 の後半）
- S8: 終わった plan と tasks を消す（方針 7）
- S9: release:plan と 0.6.26（方針 8）

## 完了条件

- A1: `bun run verify` → exit 0（hooks:live を含む）
- A2: `git worktree add <一時ディレクトリ> main` に新しいテスト（deliver と plugin の）だけを写して `bun run test` → PowerShell の配信と doctor の Windows の行のテストが、意図した理由（import の失敗でなく期待の不一致）で落ちる
- A3: `bun run bundle` → exit 0（checkBundles が deliver と capture に zod が無いことと上限を見る）。`bun run test` → bundle-budget の落ちる例を含め全件 pass
- A4: `node scripts/measure-hook-launch.mjs` → 変更前の bundle と後の bundle で流し、deliver.js と capture.js の中央値が両方 PR 本文にあり、deliver.js は後の方が小さい
- A5: `gh pr checks <PR>` → `windows` を含む全件 pass。`gh run view --log` の windows job に計測の中央値と hooks:live の成功の行がある
- A6: `npm pack` の tarball を repository の外で展開して `node scripts/check-hooks-live.mjs <展開先>/package` → exit 0。同じ展開先で `grep -c ZodError package/dist/deliver.js` → 0、`hooks/hooks.json` が S7 で決めた形
- A7: リリースの後 `bun run release:status` → すべて 0.6.26 で `release ledger is consistent`
- A8: `gh issue view 207 --comments` → 採らなかった項目（Codex の async、compile cache、(b) なら exec form）の理由と計測のコメントがある

## リスク

- Windows の CI のランナーの PowerShell の起動時間が、利用者の PC と違う → 計測値はランナーのものと PR と #207 に書く。判定の基準は変えない
- check-hooks-live の Stop の送信が CI で遅い → 上限時間は 30 秒（`FLUSH_BUDGET_MS`）にそろえ、超えたら失敗として出す。再現しない失敗は推測で直さない
- bundle の上限が依存の更新で超える → 上限の定数を上げるコミットで理由を書く（検査は残す）
- (a) を採ったあと古い Claude Code の利用者のフックが止まる → doctor の ✗ と README、リリースノートに書く

## 未解決

なし

## 変更履歴
2026-10-03 / bundle-budget のテストの置き場所を scripts/lib から server/test に変えた / scripts/lib のモジュールは server/test から試す慣習で、verify の sql:reach がそれを流すので verify に別の手を足さずに済む / Go 不要（範囲は同じ）
