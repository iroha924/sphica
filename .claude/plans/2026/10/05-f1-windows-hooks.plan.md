---
kind: plan
status: approved
codex_session: 01a109d3-e45a-7030-9c22-2161d058875a
codex_rounds: 3
approved_at: 2026-10-05
---

# Codex のフックを特殊な文字を含むプラグインパスでも Windows で動かし、doctor が Codex のフックの信頼の状態を出す（#262・#276）

## 要点

- `plugin/hooks/codex.json` の 9 つの `commandWindows` を、`powershell.exe -NoProfile -NonInteractive -EncodedCommand <base64>` に変える。中身は固定のスクリプトで、パスは Codex が入れる環境変数 `PLUGIN_ROOT` から読む。外側のシェルにはパスが現れない。`command`（POSIX）は変えない
- 直す前に、パックした codex.json の全エントリを、Codex が使いうる外側のシェル（Windows: powershell.exe・pwsh・cmd.exe・COMSPEC・Git Bash、POSIX: sh）と、空白や `$`・`%PATH%` を含むプラグインのパスで起動する検査を check-hooks-live に足し、Windows の CI で red を見てから直す
- `sphica doctor` に「Codex hooks」の行を足す。`$CODEX_HOME/config.toml` の `[hooks.state]` の `trusted_hash` を、Codex 0.160.0 と同じ計算で今の codex.json から出したハッシュと比べ、trusted / modified / untrusted と disabled を件数で出す。検証済みの Codex（0.160.0 だけ）以外や読めないときは unknown と `/hooks` の案内。config.toml は読むだけ
- TOML の読み取りに `smol-toml` を依存に足す
- 1 つの PR・1 回のリリース（0.6.31）。ハッシュが変わるのは Windows だけなので、リリースノートで Windows の利用者に `/hooks` での信頼し直しを案内する
- 変えないもの: Claude Code の hooks.json、Codex のフックのイベント・matcher・timeout・同期（async にしない）、POSIX の `command`、doctor の終了コードの決まり

## 持ち主の決定

- #262 と #276 を 1 つの計画・1 つの PR・1 回のリリースにまとめる（GitHub Project「Sphica」Phase 01、PR bundle「F1 Windows hooks」）
- codex.json を変える案は 1 回のリリースにまとめる（記録 u99: 利用者の hook の信頼し直しを 1 回で済ませるため）
- #262 は、直す前のコードで落ちる Windows CI の検査（空白入りの PLUGIN_ROOT で出荷する commandWindows を全部実行する）を先に作り、red を確かめてから直す
- #276 は Codex 0.160.0 の `[hooks.state]` の `trusted_hash` を Codex と同じ計算で今の定義と比べる。比べられないときは unknown と `/hooks` の案内にし、信頼の状態は書き換えない（記録 u250）
- テストは一時的な HOME で行い、`~/.codex` に触らない
- 作業は main から切った別の worktree で行う
- Codex の capture は同期のまま（記録 codex-capture-stays-sync）

## 目的

- Windows で、プラグインのパスに空白・`&`・括弧・`'`・`$`・バッククォート・`%` を含む利用者でも、Codex の capture と delivery のフックが、セッションのシェルが PowerShell・pwsh・cmd・Git Bash のどれでも動く
- `sphica doctor` を見れば、Codex が User の config で Sphica の今のフックを信頼しているか（していなければ何件が modified / untrusted / disabled か）が分かり、分からないときは理由と `/hooks` の案内が出る

## 対象外

- POSIX の `command`（`node "${PLUGIN_ROOT}/dist/<x>.js" codex`）: Codex が引用符の中へパスを文字列で置き換えるので、`$`・バッククォート・`$()` を含むパスは今も壊れる。今回は変えずリスクに記す
- managed（System・MDM・クラウド管理）のフック、`bypass_hook_trust`、セッションフラグ（`-c`）の hooks.state: doctor が読める入力ではない。User 層の config.toml だけを見て、行にそう書く
- 0.160.0 以外の Codex での比較: ハッシュの計算が版ごとの実装で、変わると doctor が誤って trusted を出しうる。版を足すのは、その版のソースを読み直してからの別の変更
- 信頼の状態を書き換える機能（`/hooks` の代わり）
- Claude Code の hooks.json の変更

## 前提

- `plugin/hooks/codex.json` の 9 エントリ（SessionStart 2、SubagentStart 1、UserPromptSubmit 2、PostToolUse 1、Stop 1、Interrupt 1、PreToolUse 1）の `commandWindows` は全部 `powershell.exe -NoProfile -NonInteractive -Command node $env:PLUGIN_ROOT/dist/<capture|deliver>.js codex`。導入は #93（3374082b）で、理由の記録は無い。内側の PowerShell が `-Command` の後ろを繋いで解析し直すので、空白でパスが割れる（#207 のコメント issuecomment-5903218915、pwsh 7.5.3 on Linux で `Cannot find module '.../plug'`）
- Codex rust-v0.160.0（2026-10-05 取得）
  - `hooks/src/engine/discovery.rs`: Windows では `command_windows.unwrap_or(command)` を選ぶ（:506-513）。`${PLUGIN_ROOT}`・`${CLAUDE_PLUGIN_ROOT}`・`${PLUGIN_DATA}`・`${CLAUDE_PLUGIN_DATA}` を文字列で置換し（:567）、同じ値を env に入れる（:264-270）。0.130.0 は `commandWindows` を見ない
  - ハッシュ（`hook_hash` :775、`config/src/fingerprint.rs` の `version_for_toml`）: `{event_name: <snake の名前>, matcher?: <UserPromptSubmit・Stop・Interrupt では捨てる。common.rs:112>, hooks: [{type: "command", command: <OS で選んだ置換前の文字列>, timeout: <通常は指定値を 1 以上に、無ければ 600。SessionEnd・Interrupt は 1..3、無ければ 1>, async: <bool>, statusMessage?: <あるときだけ>, additionalContextLimit?: <PreToolUse・PostToolUse・SessionStart・UserPromptSubmit・SubagentStart で 2500 以外のときだけ>}]}` を TOML 値にし、JSON にしてキーを再帰的に並べ、詰めた JSON の SHA-256 を `sha256:<hex>` にする
  - キー: `<plugin_id>:<source_relative_path>:<event の snake 名>:<group の添字>:<handler の添字>`（`hooks/src/lib.rs:113`、`declarations.rs` の `plugin_hook_key_source`）。plugin_id は `sphica@<marketplace>`、キャッシュは `plugins/cache/<marketplace>/<plugin>/<version>`
  - 状態（discovery.rs:795-820）: 一致で Trusted、不一致で Modified、無しで Untrusted。`enabled = false` は別に無効。状態を読むのは User 層とセッションフラグだけで、キーは trim する（`config_rules.rs:15-65`）。実行されるのは enabled かつ Trusted（:713）
  - 起動（`hooks/src/engine/command_runner.rs:384-437`、`core/src/shell.rs:22-49`、`core/src/session/mod.rs:5183`）: セッションのシェルを通す。PowerShell は `<shell> -NoProfile -Command <command>`、cmd は `<shell> /c "<command>"`（raw_arg で外側に引用符）、Bash は `<shell> -c <command>`、シェルが無ければ `%COMSPEC% /C "<command>"`
  - `codex --version` も引数の解析の前に `CODEX_HOME/tmp/arg0` を作る（`cli/src/main.rs:1013`、`arg0/src/lib.rs:343`、Codex が確認）
- 実測（2026-10-05、この PC、codex-cli 0.160.0、プラグイン 0.6.30、macOS）: 上の計算のプロトタイプが `~/.codex/config.toml` の Sphica の 9 件の trusted_hash と全部一致した（読み取りのみ）。新しい commandWindows では POSIX の 9 件は不変、Windows の 9 件は全部変わる（Codex が独立に計算）
- `scripts/check-hooks-live.mjs:106` は hooks.json だけを起動し、子の PATH を node・git・System32 に組み直す（:44-68）。`scripts/check-ai-config.mjs:269-302` が codex.json の commandWindows の文字列を固定している
- Windows の CI は `.github/workflows/check.yml:94-154`。verify は流さず、パックした tarball で init・doctor の DB の行・MCP・check-hooks-live を流す
- 記録 u193: Windows の CI で PowerShell を通すフックの起動は直接より 1 回 177〜234 ms 遅い（今の commandWindows も払っている）
- doctor の Codex の行は `server/src/plugin.ts` の `observe()`（:297-312）と `report()`（:532-541）。`say` は warn と fail を issues へ、fail だけを failures へ入れ、`server/src/cli.ts:104` は failures だけで終了コード 1 にする。既存のテストの `observe()` は一時の CODEX_HOME を渡していない（`server/test/plugin.test.ts:330,380`）
- TOML のパーサーは依存に無い。`smol-toml` 1.9.0（BSD-3-Clause、2023-05 作成、ランタイム依存なし、週 4,657 万ダウンロード、npm registry と配布元の package.json で確認、2026-10-05）。CLI の bundle の上限は `scripts/lib/bundle-budget.mjs:10` の 582,000 バイト
- 未検証: Windows PowerShell 5.1 で、`-EncodedCommand` の中の node へ stdin が渡るか（PowerShell 7.5.3 のソースからの推定では渡る）。CI の spool の検査で確かめる

## 方針

### #262: 検査（先に入れて red を見る）

1. `scripts/check-hooks-live.mjs` に Codex の部を足す（同じ一時 HOME と init 済みの DB を使う）
   - パックした `hooks/codex.json` の全エントリについて、Codex と同じく win32 では `commandWindows ?? command`、それ以外は `command` を選び、`${PLUGIN_ROOT}`・`${CLAUDE_PLUGIN_ROOT}`・`${PLUGIN_DATA}`・`${CLAUDE_PLUGIN_DATA}` を置換し、同じ値を env に入れる
   - 外側のシェル: win32 は `powershell.exe -NoProfile -Command <cmd>`、`pwsh -NoProfile -Command <cmd>`、`cmd.exe /c "<cmd>"`（`windowsVerbatimArguments`）、`%COMSPEC% /C "<cmd>"`、Git Bash の `bash.exe -c <cmd>`（`C:\Program Files\Git\bin`）。POSIX は `/bin/sh -c <cmd>`。各シェルの絶対パスを親の PATH から先に解決し、無ければ失敗にする（skip しない）
   - 子の PATH: node・git・System32・`System32\WindowsPowerShell\v1.0`（内側の powershell.exe 用）・試すシェルのディレクトリ
   - プラグインのコピー: 特殊な文字の無い対照（パス全体）、`plugin root & (x) it's`、`$`・バッククォート・`%PATH%` を名前に含むもの
   - 各（シェル × コピー）で、固有の目印（非 ASCII を含む）を入れた UserPromptSubmit の JSON を UTF-8 で stdin に渡して閉じ、終了コード 0 と、その起動の直後に spool にその目印が書かれたことを確かめる。他のエントリは終了コード 0 を確かめる
2. red: この検査だけのコミットを PR に push し、Windows の CI で、対照が powershell.exe と pwsh で通り、空白入りのコピーが `Cannot find module` で落ちることを見る（今の commandWindows は Git Bash では `$env` を解釈されて対照でも落ちうるので、red のコミットで対照を確かめるのは PowerShell の 2 つだけ）。macOS の verify は通る

### #262: 直し

3. codex.json の 9 つの `commandWindows` を `powershell.exe -NoProfile -NonInteractive -EncodedCommand <base64>` にする。base64 は次の固定のスクリプトの UTF-16LE:
   `& node "$env:PLUGIN_ROOT/dist/<capture|deliver>.js" codex; if ($null -eq $LASTEXITCODE) { exit 1 }; exit $LASTEXITCODE`
   新しい powershell.exe では node が終わるまで `$LASTEXITCODE` が `$null` なので、node が見つからない・起動できないときは 1 で終わる
4. 検査に、`dist/capture.js` が env の値で終了する仮のパッケージで包みだけを試すケースを足す: 0 → 0、7 → cmd.exe と Git Bash の外側で 7、PowerShell の外側では 0 以外（0/1 への変換は PowerShell の仕様）、PATH に node が無い → どの外側でも 0 以外
5. `scripts/check-ai-config.mjs`: 全 9 件の commandWindows を正確な文字列で固定し、base64 を復号したスクリプトの文面も固定する（読み手が平文を検査の中で読める）。capture の async の禁止は残す

### #276: doctor

6. 新しいモジュール `server/src/codex-trust.ts`（純粋関数）: codex.json の中身・plugin_id・相対パス・platform・hooks.state を受け、エントリごとに key・現在のハッシュ・状態（trusted / modified / untrusted）・enabled を返す。command 以外の type・空の定義・読めない形は全体を unknown にし、「0 件 trusted」にしない
7. `observe()`
   - Codex の install がちょうど 1 つのとき、その `.codex-plugin/plugin.json` の `hooks` をプラグインのルートの下で解決し、ルートからの相対パスを `/` 区切りで出す（ルートの外なら unknown）。plugin_id は `sphica@<キャッシュの marketplace のディレクトリ名>`
   - `$CODEX_HOME/config.toml` を smol-toml で読み、`hooks.state` を渡す。ファイルが無ければ全部 untrusted。読めない・解析できない・`hooks.state` が表でない → unknown
   - Codex の版: observe の `env` 引数（PATH・PATHEXT・CODEX_HOME）で PATH を順に `codex` を探す。win32 では最初に当たったのが `codex.exe` ならそれを、npm の `codex.cmd`・`codex.ps1` で `<dir>/node_modules/@openai/codex/bin/codex.js` があれば `process.execPath <codex.js>` を、`--version` で起動する（stdin を閉じ、timeout 10 秒、env は observe の `env`）。POSIX は `codex --version`。出力を `/^codex-cli (\d+\.\d+\.\d+)$/m` で読む。読めない・検証済みの一覧（`["0.160.0"]`）に無い → unknown
8. `report()`: 「Codex hooks」の行。User の config（`$CODEX_HOME/config.toml`）での状態だと分かる文にする
   - 全部 trusted かつ enabled → ✓ と「9 of 9 trusted」
   - modified・untrusted → △（issues に入る、failures には入れない）、件数と「open /hooks in Codex and trust Sphica's hooks」
   - disabled → △、件数と「enable them in /hooks if that was not intended」。意図した無効化は変えない
   - unknown → ○、理由と `/hooks` の案内（install が無い・複数、Codex の版が読めない・未検証、config.toml が読めない、形が想定外）
9. テスト（一時の HOME・USERPROFILE・CODEX_HOME、`~/.codex` に触らない）
   - `server/test/codex-trust.test.ts`: 0.6.30 の codex.json とこの PC の 9 件の trusted_hash を固定のフィクスチャにして全部 trusted。手で書いた正規化済みの JSON の文字列とその sha256 を、POSIX の選択と今回出荷する Windows の EncodedCommand の選択の両方で持ち、計算と一致する。境界: timeout の省略 → 600、0 → 1、Interrupt の省略 → 1・0 → 1・5 → 3、UserPromptSubmit・Stop・Interrupt の matcher は捨てる、statusMessage あり、additionalContextLimit の省略・2500（捨てる）・100（残す）・context を出せないイベント（捨てる）、複数の group と handler の添字、キーの trim、1 文字の変更で modified、キーが無いと untrusted、`enabled = false` で disabled、command 以外の type・空の定義で unknown
   - `server/test/plugin.test.ts`: 既存の `observe()` の呼び出し全部に一時の CODEX_HOME を渡す。一時の CODEX_HOME（キャッシュと config.toml）と偽の `codex`（受け取った CODEX_HOME を書き残し、`codex-cli 0.160.0` を出す）で、`observe()` と `report()` の各状態の行。偽の codex が一時の CODEX_HOME を受け取ったこと、config.toml の中身と mtime が変わらないこと
   - CLI の子プロセス（`server/test/cli.test.ts`）: 一時の HOME・USERPROFILE・CODEX_HOME と PATH の先頭の偽の `codex` で `sphica doctor` を流し、trusted・modified・disabled の 3 つの状態の行と、その行で終了コードが 1 にならないこと
   - Windows の CI: パックした CLI で、一時の CODEX_HOME（`plugins/cache/sphica/sphica/<version>` にパックしたプラグイン、手で書いた Windows の期待値の config.toml）と npm の形の偽の `codex.cmd` と `node_modules/@openai/codex/bin/codex.js` を作り、「Codex hooks」の行が ✓ と「9 of 9 trusted」で unknown でないことを確かめる。config.toml の 1 件の trusted_hash を変え、1 件を `enabled = false` にして流し直し、1 modified と 1 disabled と `/hooks` の案内を確かめる
10. README.md と README.ja.md の `/hooks` の段落に、`sphica doctor` の「Codex hooks」の行で確かめられることを足す

### リリース

11. `bun run release:plan -- --base f5103885`（0.6.30 のリリースのコミット）で plugin を確かめ、npm と 3 つの manifest を 0.6.31 に揃える。依存を足すので `bun run notices` を通す。PR 本文の Release notes に「On Windows, open /hooks in Codex and trust Sphica's hooks again」を書く。以降は plugin-release の手順どおり（npm-release の承認は持ち主）

## 採った案と棄却した案

- 採用: commandWindows を `-EncodedCommand` にし、パスは内側の PowerShell が環境変数から読む。棄却: commandWindows を消して `command` を使う（パスが外側のシェルのコードに埋め込まれ、`$`・バッククォート・`$()`・`%NAME%` が展開される。起動 1 回あたり約 200 ms 速くなる利点はあった）
- 採用: 比べるのは検証済みの Codex の版（0.160.0）だけ。棄却: 0.160.0 以上を比べる（計算が変わると保存済みのハッシュと古い計算が一致し、doctor が誤って trusted を出す）
- 採用: Windows の npm 版 Codex は PATH の順を守り、npm の codex.js を `process.execPath` で起動する。棄却: `codex.exe` だけを探す（npm 版で常に unknown か、別の Codex の版を読む）
- 採用: TOML は smol-toml で読む。棄却: `[hooks.state."<key>"]` の行を正規表現で読む（ドット区切りのキー・インラインテーブル・エスケープを数え落とす）
- 採用: Codex の検査を check-hooks-live に足す。棄却: 別のスクリプト（一時 HOME と init のフィクスチャを二重に持つ）
- 採用: modified・untrusted・disabled は △（issues）で、終了コードは変えない。棄却: ✗（failures）にする（今回の要求は状態の報告）

## 手順

- S1: Codex のフックを外側のシェルとプラグインのパスごとに起動する検査を足し、Windows の CI で red を見る
- S2: codex.json の commandWindows を EncodedCommand にし、包みのケースと check-ai-config を直す
- S3: smol-toml を足し、codex-trust の純粋関数とテスト
- S4: doctor の observe / report、既存テストの隔離、CLI の子プロセスのテスト、README
- S5: Windows の CI のパックした doctor の検査
- S6: 0.6.31 へのバージョンの揃えと Release notes

## 完了条件

PR の準備ができた:

A1〜A8 は PR の準備、A9・A10 はリリースの完了。

- A1: `gh run view <S1 のコミットの check の run> --log-failed` → Windows のジョブの check-hooks-live の Codex の部で、対照が powershell.exe・pwsh で通り、空白入りのコピーが `Cannot find module` で落ちている（red）
- A2: `gh run view <最終 head の check の run> --log` → Windows のジョブで、全コピー・全外側のシェルで Codex の全エントリが終了コード 0、各ケースの目印が spool に届き、包みのケースが期待どおり
- A3: `gh run view <最終 head の check の run> --log` → Windows のジョブで、パックした doctor の「Codex hooks」の行が ✓「9 of 9 trusted」、変更後に 1 modified・1 disabled
- A4: `bun run verify` → 終了コード 0
- A5: `cd server && node --test test/codex-trust.test.ts` → 固定の 9 件が trusted、手書きの期待値と一致して全件 pass
- A6: `bun run notices && bun run bundle` → 終了コード 0（全 entry が上限内）
- A7: `bun run verify:ai` → 終了コード 0（codex.json の commandWindows 9 件を EncodedCommand の文字列と復号した文面で固定）
- A8: `gh pr checks <PR>` → 全項目 pass、`gh api graphql` で未解決のレビューのスレッドが 0
- A9: `gh run watch <release の run> --exit-status` → publish・merge・finish まで成功し、`bun run release:status` に残りの手順が無い
- A10: `sphica doctor` → この PC（macOS）で更新後に「Codex hooks」の行が ✓「9 of 9 trusted」のまま（POSIX のハッシュは変わらない）

## リスク

- POSIX の `command` は、`$`・バッククォート・`$()` を含むプラグインのパスで今も壊れる → 今回は変えない既存の制約として残す。報告が来たら POSIX も環境変数で渡す形を別の計画で考える
- Windows PowerShell 5.1 で stdin が node へ渡らない → A2 の spool の検査で落ちる。落ちたら同じ session で Codex と方針を見直す
- Codex が 0.160.0 から上がると doctor の行が unknown になる → 理由に「0.160.0 だけ検証した」と出す。版を足すのはソースを読み直してからの変更
- Codex の起動の仕方が変わると、CI が通っても実機で落ちうる（CI は Codex 本体ではなく同じ形でシェルを起動する） → 前提にソースの行を記し、Codex の版を足すときに見直す
- node が PATH に無いと、内側の powershell.exe が見つからないと言うまで Windows の CI で 24〜39 秒かかる（外側によらない） → 実機では Codex のフックの timeout で止まり、今の commandWindows も同じ形なので退行ではない。検査の上限だけ 120 秒にする
- 外側が PowerShell のときフックの終了コードは 0/1 に丸まる → 今のフックは 0 以外を使い分けていないので影響は無い

## 未解決

なし

## 変更履歴

- 2026-10-05 / リスクに node の無い PATH での PowerShell の遅さを足した / T03 の head の Windows の CI で ETIMEDOUT を観測し、T07 で所要時間を測った / Go 不要（製品は変えず検査の上限だけ）
