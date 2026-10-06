---
kind: tasks
plan: 06-h2-userconfig.plan.md
branch: feat/h2-userconfig
base: main
---

# review コマンド名と自動 trace の停止を Claude Code plugin の userConfig で設定できるようにする（#280） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: hook が userConfig の値を読む

review コマンド名と自動 trace の停止を、hook が `CLAUDE_PLUGIN_OPTION_*` から読み、無ければ今の env で動く。

- [x] T01: review コマンド名を userConfig から読み、無ければ SPHICA_REVIEW_COMMANDS を使う
  - 種別: 追加
  - 計画: S1, S5
  - 依存: なし
  - 変更: `server/src/review-bridge.ts`, `server/test/review-bridge.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `cd server && node --test test/review-bridge.test.ts` → 全件 pass。足した option のケースが、option を読まない今のコードでは落ちる（結果欄に red の実測を残す）。`bun run release:plan -- --base v0.6.37` → `release kind: plugin` で、4 か所が 0.6.38
  - コミット: `feat(review): read review command names from userConfig, falling back to the env (T01)`
  - 結果: `bun run release:plan -- --base v0.6.37` → `release kind: plugin`、`version: npm 0.6.38 / plugin 0.6.38 / marketplace 0.6.38 / Codex 0.6.38`。red: 実装前に `node --test --test-name-pattern=review_commands test/review-bridge.test.ts` が option の `audit` で配信が空（`actual: ''`）で落ちた。実装後 `node --test test/review-bridge.test.ts` → 11 pass, 0 fail。`bun run verify` → exit 0

- [x] T02: 自動 trace を userConfig と SPHICA_AUTO_TRACE のどちらかの off で止める
  - 種別: 追加
  - 計画: S2
  - 依存: なし
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - 完了条件: `cd server && node --test test/deliver.test.ts` → 全件 pass。足した option の false のケースが、今のコードでは落ちる（結果欄に red の実測を残す）
  - コミット: `feat(deliver): stop the automatic trace when userConfig or SPHICA_AUTO_TRACE turns it off (T02)`
  - 結果: red: 実装前に `node --test --test-name-pattern="auto_trace and SPHICA" test/deliver.test.ts` が option "false" で自動 trace の依頼が出たまま（`1 earlier session ... waits to be traced`）で落ちた。実装後 `node --test test/deliver.test.ts` → 44 pass, 0 fail。`bun run verify` → exit 0

- [x] T06: テストを親の env から隔離し、レビューで足りなかったケースを足す
  - 種別: 修正
  - 計画: S1, S2
  - 依存: T01（review の option を読むテストが要る）, T02（auto_trace の option を読むテストが要る）
  - 変更: `server/test/deliver.test.ts`, `server/test/review-bridge.test.ts`
  - red: `cd server && CLAUDE_PLUGIN_OPTION_AUTO_TRACE=false node --test test/deliver.test.ts` → 既定オンの既存テスト（a new interactive Claude Code session asks the agent to trace）が 1 件落ちる。`SPHICA_AUTO_TRACE=off` でも同じ
  - 完了条件: `cd server && node --test test/deliver.test.ts test/review-bridge.test.ts` → env なし・`CLAUDE_PLUGIN_OPTION_AUTO_TRACE=false`・`SPHICA_AUTO_TRACE=off`・`CLAUDE_PLUGIN_OPTION_REVIEW_COMMANDS=zzz` のどれを付けて流しても全件 pass
  - コミット: `test(deliver): isolate the auto trace settings and cover the review and auto trace fallbacks (T06)`
  - 結果: red: 直す前に `CLAUDE_PLUGIN_OPTION_AUTO_TRACE=false` と `SPHICA_AUTO_TRACE=off` のそれぞれで 54 pass, 1 fail（既定オンの既存テスト）。直した後は 4 通りとも 55 pass, 0 fail。`bun run verify` → exit 0

## P2: plugin の設定として出す

plugin.json に userConfig を足し、対話の dialog の動きを実測して、README に設定のしかたを書く。

- [x] T03: plugin.json に review_commands と auto_trace の userConfig を足し、対話の dialog を実測する
  - 種別: 追加
  - 計画: S3
  - 依存: T01（実測で option の値が review に効くのを見る）, T02（実測で option の値が自動 trace に効くのを見る）
  - 変更: `plugin/.claude-plugin/plugin.json`
  - 完了条件: `claude plugin validate plugin` → `Validation passed`。`bun run verify` → exit 0。2.1.291 の対話（一時の CLAUDE_CONFIG_DIR とローカルの marketplace）で、新規と更新のそれぞれ、dialog を確定した後と取消した後の plugin の有効状態・hook・既存の env の効き方を結果欄に書く。既存の設定が消えるか設定を終えられないなら、ここで止めて持ち主に戻す
  - コミット: `feat(plugin): declare review_commands and auto_trace as userConfig (T03)`
  - 結果: `claude plugin validate plugin` → `Validation passed`。`bun run verify` → exit 0
  - 結果: `claude plugin install uctest@local` → dialog は出ず「2 userConfig options not yet set」と出るだけ。expect で対話を起動しても dialog は出ず、hook が走り env はそのまま届き、`CLAUDE_PLUGIN_OPTION_*` は無い（2.1.291、一時の HOME と CLAUDE_CONFIG_DIR、ローカルの marketplace、userConfig を持つ probe plugin、settings.json の env に `SPHICA_AUTO_TRACE=off` と `SPHICA_REVIEW_COMMANDS=deploy`）
  - 結果: `claude plugin update uctest@local` → userConfig の無い 0.0.1 から 0.0.2 への更新で dialog は出ない。plugin は有効のまま、hook は 0.0.2 で走り、env はそのまま届く
  - 結果: `/plugin install uctest@local` → 対話で出た Configure の dialog を Esc で取消すと「Installed uctest. Plugin is now active.」、plugin は有効、pluginConfigs は無し、env は残る
  - 結果: `/plugin install uctest@local` → 対話で出た Configure の dialog を空と default のまま Save configuration で確定すると「Installed and configured uctest.」、pluginConfigs は `{"auto_trace": true}` だけ、次の起動の hook に `CLAUDE_PLUGIN_OPTION_AUTO_TRACE="true"` と env の `SPHICA_AUTO_TRACE=off` が両方届く（どちらかが off で止める読み方なので止まったまま）。どの経路でも既存の設定は消えず、設定を終えられないことも無かったので release へ進める

- [x] T04: README.md と README.ja.md に /config での設定と env との関係を書く
  - 種別: 変更
  - 計画: S4, S6
  - 依存: T03（dialog の実測で、README に書いてよい操作が決まる）
  - 変更: `README.md`, `README.ja.md`
  - 完了条件: `bun run verify:ai` → exit 0。`rg -n "review_commands|auto_trace|2\.1\.269" README.md README.ja.md` → 両ファイルの自動 trace と review の段落に出る
  - コミット: `docs(readme): describe the review_commands and auto_trace plugin settings (T04)`
  - 結果: `bun run verify:ai` → exit 0（verify に含まれる）。`rg -n "review_commands|auto_trace|2\.1\.269" README.md README.ja.md` → README.md:23・115・116、README.ja.md:23・113・114 に出る。`bun run verify` → exit 0。T03 の実測で取消でも plugin は有効のままだったので、README には /config と env の書き方だけを書き、dialog の操作は書いていない

## P3: 0.6.38 として出す

バージョンを上げ、release run で #268 の確認も済ませる。

- [-] T05: npm と 3 つの manifest を 0.6.38 に上げる
  - 種別: 変更
  - 計画: S5, S6
  - 依存: T04（パッケージに入る変更が全部入ってから上げる）
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run release:plan -- --base v0.6.37` → `release kind: plugin` で、4 か所が 0.6.38。`bun run verify` → exit 0
  - コミット: `chore(release): bump to 0.6.38`

## 記録
2026-10-06 / T01 / pre-commit の bundle 検査が、パッケージに入るファイルを変えるコミットにバージョンの引き上げを求めて止めた（前回の PR も最初のコードのコミットで上げていた） / T01 の欄を変えた。計画 S1 → S1, S5。変更に 4 つのバージョンのファイルを足した。完了条件に release:plan の行を足した
2026-10-06 / T05 / バージョンの引き上げを T01 に移したので不要になった / [-] にした。S6 は T04 の計画（S4 → S4, S6）に移した
2026-10-06 / T01 / Codex のタスクごとのレビューで P3: option 未設定のフォールバックと env 側の正規化・複数名を両経路で見ていない / 採用。T06 で直した
2026-10-06 / T02 / Codex のタスクごとのレビューで P2: 新しい option と SPHICA_AUTO_TRACE をファイル全体で隔離しておらず、親の env で既存テストが落ちる（再現した）。P3: option が on のときの resume と subagent を見ていない / 両方採用。T06 を足して直した
2026-10-06 / T06 / 完了条件が「`<command>` → <期待>」の書式でなく tasks の検査に落ちていた（T06 のコミットで見落とした） / 中身は変えずに書式だけを直した
2026-10-06 / T03 / Codex のタスクごとのレビュー: 指摘なし / なし
2026-10-06 / T03 / 結果欄の実測の行が「`<command>` → <観測>」の書式でなく tasks の検査に落ちていた / 中身は変えずに書式だけを直した
