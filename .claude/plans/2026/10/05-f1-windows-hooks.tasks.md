---
kind: tasks
plan: 05-f1-windows-hooks.plan.md
branch: feat/f1-windows-hooks
base: main
---

# Codex のフックを特殊な文字を含むプラグインパスでも Windows で動かし、doctor が Codex のフックの信頼の状態を出す（#262・#276） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 先に red を見る

Windows の CI で、今の codex.json が空白入りのプラグインのパスで落ちることを、CI のバージョンの検査に邪魔されずに見られる

- [x] T01: release:plan で種別を確かめ、npm と 3 つの manifest を 0.6.31 に揃える
  - 種別: 変更
  - 計画: S6
  - 依存: なし
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run release:plan -- --base f5103885` → 4 か所が 0.6.31、`bun run verify` → 終了コード 0
  - コミット: `chore(release): bump to 0.6.31`
  - 結果: `bun run release:plan -- --base f5103885` → `version: npm 0.6.31 / plugin 0.6.31 / marketplace 0.6.31 / Codex 0.6.31`、kind は none（まだ package の入力を変えていない）。`bun run verify` → exit 0
- [x] T02: check-hooks-live に、Codex のフックを外側のシェルとプラグインのパスごとに起動する部を足す
  - 種別: 追加
  - 計画: S1
  - 依存: T01（バージョンを上げておかないと PR の CI がバージョンの検査で落ち、red の理由が混ざる）
  - 変更: `scripts/check-hooks-live.mjs`
  - 完了条件: `bun run hooks:live` → macOS で終了コード 0（sh の外側で全コピー・全エントリが通り、各ケースの目印が spool に届く）。push して PR を作り、Windows のジョブが Codex の部で落ちる（T03 の red）
  - コミット: `test(hooks): launch every Codex hook through each outer shell and plugin path`
  - 結果: `bun run hooks:live` → macOS で exit 0（sh × control・spaced で 18 件）。感度: 引用符を外した codex.json のコピーで `node scripts/check-hooks-live.mjs <copy>` → spaced/sh の 6 件だけが落ち、control は通った。Windows の red は push 後に T03 の red で確かめる

## P2: Codex のフックを直す

空白や `$`・`%` を含むプラグインのパスでも、Windows のどの外側のシェルからも Codex のフックが動く

- [x] T03: codex.json の commandWindows を EncodedCommand にし、包みのケースと check-ai-config を直す
  - 種別: 修正
  - 計画: S2
  - 依存: T02（直す前に落ちることを示す検査が要る）
  - 変更: `plugin/hooks/codex.json`, `scripts/check-hooks-live.mjs`, `scripts/check-ai-config.mjs`
  - red: `gh run view <T02 の head の check の run> --log-failed` → Windows のジョブで、対照が powershell.exe・pwsh で通り、空白入りのコピーが `Cannot find module` で落ちている
  - 完了条件: `bun run verify` → 終了コード 0。push 後の Windows のジョブ → 全コピー・全外側のシェルで全エントリが終了コード 0、各ケースの目印が spool に届き、包みのケースが期待どおり
  - コミット: `fix(hooks): pass the plugin root to Codex's Windows hooks through the environment`
  - 結果: red（T02 の head 383ba025、check の run 37257190619 の Windows のジョブ）→ `hooks: 70 failure(s)`。control は powershell.exe・pwsh・cmd.exe・COMSPEC で通り、spaced と expanding は powershell.exe・pwsh で `Cannot find module '...\plugin'`（空白で割れる）、Git Bash は control でも `...\repo\:PLUGIN_ROOT\dist\...`（`$env` を bash が読む）、cmd.exe・COMSPEC は全部通った。直した後: `bun run verify:ai` → exit 0、1 件の base64 を変えると `a SessionStart hook's commandWindows is not the encoded launch of its bundle` で落ちる。`bun run hooks:live` → macOS で exit 0（包みのケース: sh で 0 → 0、7 → 7、node なし → 0 以外）。Windows の green は push 後に plan の A2 で確かめる

- [x] T07: Codex の起動の検査の競合・タイムアウト・一時ディレクトリの空白を直す
  - 種別: 修正
  - 計画: S1
  - 依存: T03（直す対象の検査と、T02・T03 のレビューの指摘が要る）
  - 変更: `scripts/check-hooks-live.mjs`
  - red: `gh run view 37257640239 --job 111598032797 --log-failed` → Linux（Node 24.15）の check-hooks-live が `ENOTEMPTY, Directory not empty: /tmp/sphica-live-…` で落ちている
  - 完了条件: `for i in 1 2 3; do node scripts/check-hooks-live.mjs || exit 1; done` → 3 回とも exit 0。push 後の Linux の check の 2 つが pass
  - コミット: `test(hooks): keep the Codex launch check from racing detached sends and from Codex's timeouts`
  - 結果: red は T03 の head（084a5fc0）の Linux の check (24.15) で実測（check (26) は通った）。直した後: `bun run hooks:live` → exit 0、続けて `node scripts/check-hooks-live.mjs` を 3 回 → 3 回とも exit 0。sh の包みのケース: `node exiting 0 → 0 in 22 ms, node exiting 7 → 7 in 23 ms, without node → 127 in 3 ms`

- [x] T08: node の無い PATH で起動を試すケースの時間の上限を、Windows の PowerShell の実測に合わせる
  - 種別: 修正
  - 計画: S2
  - 依存: T07（所要時間を出す包みのケースが要る）
  - 変更: `scripts/check-hooks-live.mjs`
  - red: `gh run view 37257640239 --job 111598032701 --log-failed` → `the Codex launch line through powershell.exe, without node, exited null` と `spawnSync ... powershell.exe ETIMEDOUT`（60 秒）
  - 完了条件: `bun run hooks:live` → exit 0。push 後の Windows のジョブ → 包みのケースが全部期待どおり
  - コミット: `test(hooks): give a PowerShell without node time to report it`
  - 結果: T07 の head（08d15b11、run 37258408775）の Windows のジョブで node が無いケースの所要時間は powershell.exe 39,132 ms、pwsh 24,458 ms、cmd.exe 24,294 ms、COMSPEC 26,060 ms、Git Bash 24,373 ms（どれも終了コード 1）。上限を 60 秒から 120 秒にした。`bun run hooks:live` → exit 0

## P3: doctor が Codex のフックの信頼を出す

`sphica doctor` に「Codex hooks」の行が出て、trusted / modified / untrusted / disabled / unknown が分かる

- [x] T04: smol-toml を足し、Codex と同じハッシュを出す純粋関数とテストを書く
  - 種別: 追加
  - 計画: S3
  - 依存: T03（Windows の手書きの期待値は出荷する EncodedCommand の文字列から作る）
  - 変更: `server/package.json`, `server/bun.lock`, `server/src/codex-trust.ts`, `server/test/codex-trust.test.ts`, `server/test/fixtures/codex-trust/`
  - 完了条件: `cd server && node --test test/codex-trust.test.ts` → 固定の 9 件が trusted、手書きの期待値と境界のケースが全件 pass。`bun run notices` → 終了コード 0
  - コミット: `feat(doctor): compute Codex's hook trust hashes`
  - 結果: `cd server && node --test test/codex-trust.test.ts` → 7 件 pass（この PC の Codex 0.160.0 が書いた 9 件が全部 trusted、手書きの正規化済み JSON の sha256 と POSIX・Windows で一致、境界のケース）。`bun run notices` → `third-party notices: 103 packages`
- [x] T05: doctor の observe と report に「Codex hooks」の行を足し、既存のテストを隔離し、CLI の子プロセスのテストと README を足す
  - 種別: 追加
  - 計画: S4
  - 依存: T04（ハッシュと状態を出す関数が要る）
  - 変更: `server/src/plugin.ts`, `server/test/plugin.test.ts`, `server/test/cli.test.ts`, `server/test/fake-codex.ts`, `README.md`, `README.ja.md`
  - 完了条件: `bun run verify` → 終了コード 0（偽の codex が一時の CODEX_HOME を受け取り、config.toml の中身と mtime が変わらず、trusted・modified・disabled の行が出て、その行で終了コードが 1 にならない）
  - コミット: `feat(doctor): report whether Codex trusts Sphica's current hooks`
  - 結果: `bun run verify` → exit 0。plugin.test.ts の新しい 3 件と cli.test.ts の 1 件が pass（偽の codex が一時の CODEX_HOME を受け取る、config.toml の中身と mtime が変わらない、`✓ Codex hooks 9 of 9 trusted`、変更後 `△ … 8 of 9 trusted …; 1 modified, 1 disabled`、CLI の終了コードは 0 のまま、0.161.0・0.159.2 は unknown）。この PC の開発版の `node server/src/cli.ts doctor` → `✓ Codex hooks        9 of 9 trusted in ~/.codex/config.toml`
- [x] T09: Codex が読めない定義と、Codex と削り方の違う状態のキーで trusted と出さない
  - 種別: 修正
  - 計画: S3
  - 依存: T05（直す対象の関数と、T04・T05 のレビューの指摘が要る）
  - 変更: `server/src/codex-trust.ts`, `server/test/codex-trust.test.ts`
  - red: `cd server && node --test test/codex-trust.test.ts` → 新しいテストが `commandWindows` と `command_windows` の両方を書いた定義で unknown にならず落ちる
  - 完了条件: `cd server && node --test test/codex-trust.test.ts` → 8 件 pass
  - コミット: `fix(doctor): never call hooks trusted that Codex cannot read or keys it trims differently`
  - 結果: red を実測（直す前は 1 つ目の assert で `actual: false, expected: true`）。直した後: 8 件 pass、`bun run typecheck` → exit 0。600.0・6e2 の timeout、U+FEFF・U+0085 のキーは、直す前のコードでは JSON.parse が 600 にし、JS の trim が U+FEFF を削り U+0085 を残すので、どれも落ちる側だった（コードを読んでの判断で、assert ごとの red は見ていない）
- [x] T06: Windows の CI に、パックした doctor の「Codex hooks」の行を確かめる手順を足す
  - 種別: 追加
  - 計画: S5
  - 依存: T05（doctor の行が要る）
  - 変更: `.github/workflows/check.yml`, `scripts/check-codex-trust-live.mjs`, `package.json`
  - 完了条件: `actionlint` → 終了コード 0。push 後の Windows のジョブ → 行が ✓「9 of 9 trusted」で unknown でなく、変更後に 1 modified・1 disabled と `/hooks` の案内
  - コミット: `ci(windows): check doctor's Codex hooks row from the packed CLI`
  - 結果: `actionlint .github/workflows/check.yml` → exit 0。`node scripts/check-codex-trust-live.mjs` → macOS で `codex trust: doctor read 9 hooks of plugin through codex`。期待値の雛形の timeout を 1 ずらしたコピー → `expected all 9 Codex hooks trusted` と `expected 1 modified and 1 disabled` の 2 件で落ちた。Windows は push 後に plan の A3 で確かめる

## 記録

- 2026-10-05 / T09 / T04・T05 の Codex のレビュー（新しい会話、70f19166）: F1 `commandWindows` と `command_windows` の両方や `timeout: 600.0` など、Codex が読めない定義に trusted を返す、F2 状態のキーを JS の trim で削るので U+FEFF・U+0085 で Codex と食い違う。2 件とも採る。重複したキー一般（同じ名前を 2 回）は JSON.parse で見分けられず、出荷する codex.json は手で書き換えない限り起きないので扱わない。5f8b75ab（bundle の上限）には指摘なし / T09 を足して直した。T09 は T05 の後に足したので T06 の前に置いた

- 2026-10-05 / T06 / 検査は Windows に限らず macOS・Linux でも動く（POSIX では偽の `codex`、Windows では npm の形の `codex.cmd` と `codex.js`）ので、名前を `scripts/check-codex-trust-windows.mjs` から `scripts/check-codex-trust-live.mjs` に変え、`bun run verify` にも `codex-trust:live` として入れた。変更欄に `package.json` を足した

- 2026-10-05 / T08 / node が PATH に無いときの遅さは、外側のシェルによらず内側の powershell.exe が「見つからない」と言うまでの時間（24〜26 秒）で、外側が powershell.exe だと 39 秒になる。今の commandWindows も内側で PowerShell を起動していたので退行ではない（推測）。実機では Codex のフックの timeout（10 秒）で止まる / 製品は変えず、検査の上限だけを上げる（T08）。plan のリスクに足す

- 2026-10-05 / T04, T05 / T04 だけでは knip が T05 で使う export を未使用として落とすので、1 コミット（T04, T05）にした。T04 の変更欄 `bun.lock` → `server/bun.lock`、T05 の変更欄に `server/test/fake-codex.ts`（両方のテストが使う一時の CODEX_HOME と偽の codex）を足した。CLI の bundle が上限 582,000 を超えた（592,431。smol-toml 37,087、codex-trust 5,806）ので、別のコミット 5f8b75ab で上限を 625,000 にした

- 2026-10-05 / T01 / release:plan は package の入力（`plugin/`・`server/src/` など）が変わるまで kind none を返すので、完了条件の「kind が plugin」はこの時点で観測できない / 完了条件を「kind が plugin」から「4 か所が 0.6.31」に変えた。kind plugin は T03 の後に確かめる
- 2026-10-05 / T07 / T02・T03 の Codex のレビュー（新しい会話、084a5fc0）: F1 spool のファイルが読む前に detached send に消されて ENOENT、F2 検査のタイムアウトが codex.json の timeout を使っていない、F3 一時ディレクトリの親に空白があると control の throw で止まる。3 件とも採る（F3 は red を CI で見た後なので throw を外す）。T03 の head の CI では Linux の check (24.15) が一時ディレクトリの削除で ENOTEMPTY（Codex の部の Stop・Interrupt が起こした detached send が残る）/ T07 を足し、Codex の部の Stop・Interrupt は subagent の入力にして send を起こさない
- 2026-10-05 / T03 / T03 の head の Windows のジョブ: 15 通り（パス 3 × 外側のシェル 5）の全エントリが終了コード 0、各ケースの目印が spool に届いた。落ちたのは包みのケースの「powershell.exe の外側、PATH に node が無い」だけで、60 秒で ETIMEDOUT（cmd・pwsh・Git Bash の外側は時間内に 0 以外で終わった）/ 仮説（子の env に LOCALAPPDATA・PSModulePath が無く、Windows PowerShell 5.1 がコマンドを探すときにモジュールをキャッシュ無しで全部読む）は未検証。T07 で包みのケースの所要時間をログに出し、次の CI で確かめてから扱いを決める
- 2026-10-05 / T02 / 依存の理由に書いた「バージョンを上げないと CI がバージョンの検査で落ちる」は誤り。`scripts/check-hooks-live.mjs` は package の入力ではなく（`scripts/lib/release-scope.mjs`）、バージョンの検査は上げずに通る / 並び順は変えず、そのまま進める
