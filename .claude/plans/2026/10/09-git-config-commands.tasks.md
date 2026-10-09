---
kind: tasks
plan: 09-git-config-commands.plan.md
branch: fix/git-config-commands
base: main
---

# Sphica の git 呼び出しで、エージェントのリポジトリの設定がコマンドを走らせないようにする（GHSA-gmmq-h5f6-8jrc） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 中身を読まない git の呼び出しを固める

元のリポジトリで流す git が、エージェントの設定のコマンド（fsmonitor、hook、fetch）を走らせず、git の起動場所が git.ts に限られる。

- [x] T01: git.ts を操作ごとの関数と共通の起動に作り直し、中身を読まない呼び出しを置き換える
  - 種別: 修正
  - 計画: S1
  - 依存: なし
  - 変更: `server/src/git.ts`, `server/src/project.ts`, `server/src/plugin.ts`, `server/src/glean.ts`, `server/src/rule-files.ts`, `server/src/worktree.ts`, `server/src/review-bridge.ts`, `server/test/git-safety.test.ts`
  - red: `cd server && node --test test/git-safety.test.ts` → 直す前の本体で、`core.fsmonitor`（`.git/config` と `include.path` 先）を仕込んだリポジトリの `repoFiles`・`identify`・`ruleFiles` が印を付けて失敗する。欠けたオブジェクトと promisor remote を仕込んだ `catFileBlob` 相当（glean の読み取り）が `ext::` の印を付けて失敗する
  - 完了条件: `cd server && node --test test/git-safety.test.ts` → 中身を読まない操作の経路が全件 pass（陽性対照は素の git で印が付く）。`bun run verify` → exit 0
  - コミット: `fix(git): run git for reads with command-running config switched off (T01)`
  - 結果: `cd server && node --test test/git-safety.test.ts` → 直す前の本体で 2 件失敗した（`repoFiles` が仕込んだ fsmonitor を走らせた、glean の読み取りが promisor remote から fetch した）
  - 結果: `cd server && node --test test/git-safety.test.ts test/project.test.ts test/capture.test.ts test/review-bridge.test.ts test/rule-files.test.ts test/plugin.test.ts test/read.test.ts test/record.test.ts` → 228 件 pass

- [x] T02: gh と ghUser を空の一時ディレクトリで、GIT_* を除いた環境で起動する
  - 種別: 修正
  - 計画: S4
  - 依存: なし
  - 変更: `server/src/github.ts`, `server/test/github.test.ts`
  - red: `cd server && node --test --test-name-pattern="gh starts outside the repository" test/github.test.ts` → 直す前の本体で、偽の `gh` が記録した cwd が呼び出し元の作業ディレクトリで、環境に `GIT_DIR` が残って失敗する
  - 完了条件: `cd server && node --test test/github.test.ts` → 全件 pass
  - コミット: `fix(github): start gh outside the repository without GIT_ variables (T02)`
  - 結果: `cd server && node --test --test-name-pattern="gh starts outside the repository" test/github.test.ts` → 直す前の本体で 1 件失敗した（偽の gh の cwd が `/Users/shunichi/Projects/sphica/server`）
  - 結果: `cd server && node --test test/github.test.ts` → 16 件 pass

- [x] T03: check-architecture.mjs で、git を起動するのが git.ts と git-worker.ts だけであることを検査する
  - 種別: 追加
  - 計画: S5
  - 依存: T01（ほかのモジュールの直接の起動が消えていないと検査が通らない）
  - 変更: `scripts/check-architecture.mjs`, `server/test/architecture.test.ts`
  - 完了条件: `bun run architecture` → exit 0。`cd server && node --test test/architecture.test.ts` → `server/src` に `execFileSync("git", …)` を足した写しで検査が exit 1 になるテストが pass
  - コミット: `test(architecture): allow git to start only from git.ts and the git worker (T03)`
  - 結果: `bun run architecture` → exit 0（git starters: only server/src/git.ts and server/src/git-worker.ts start git）
  - 結果: `cd server && node --test test/architecture.test.ts` → 1 件 pass（execFileSync・spawn・exec の 3 形で `stray.ts starts git` の exit 1、git.ts を空にすると `no module starts git` の exit 1）

- [x] T09: T01 のレビューの指摘を直す（commit 間の変更ファイルの取得の上限を 16 MB に戻す、ruleFiles の安全性テストで中身と incomplete を確かめる）
  - 種別: 修正
  - 計画: S1
  - 依存: T01（直す対象）
  - 変更: `server/src/worktree.ts`, `server/test/capture.test.ts`, `server/test/git-safety.test.ts`
  - red: `cd server && node --test --test-name-pattern="more than a megabyte" test/capture.test.ts` → T01 の本体で 1 件失敗する（`changed` が 0 件を返す）
  - 完了条件: `cd server && node --test test/capture.test.ts test/git-safety.test.ts` → 全件 pass
  - コミット: `fix(git): keep the listing limits and check rule files fully (T09, T10)`
  - 結果: `cd server && node --test --test-name-pattern="more than a megabyte" test/capture.test.ts` → T01 の本体で 1 件失敗した（actual: 0, expected: 200）
  - 結果: `cd server && node --test test/capture.test.ts test/git-safety.test.ts test/github.test.ts` → 89 件 pass

- [x] T10: T02 のレビューの指摘を直す（gh の起動場所を一時ディレクトリから HOME に変え、作成と削除の失敗が gh の結果を上書きしないようにする）
  - 種別: 修正
  - 計画: S4
  - 依存: T02（直す対象）
  - 変更: `server/src/github.ts`, `server/test/github.test.ts`
  - red: `cd server && node --test --test-name-pattern="gh starts at HOME" test/github.test.ts` → T02 の本体で、temp に書けないときに `ghUser()` が `{ ok: false, reason: "missing" }` を返して失敗する
  - 完了条件: `cd server && node --test test/github.test.ts` → 全件 pass
  - コミット: `fix(git): keep the listing limits and check rule files fully (T09, T10)`
  - 結果: `cd server && node --test --test-name-pattern="gh starts at HOME" test/github.test.ts` → T02 の本体（github.ts を stash して確認）で 1 件失敗した（actual: { ok: false, reason: 'missing' }）
  - 結果: `cd server && node --test test/github.test.ts` → 16 件 pass

- [x] T11: T03 のレビューの指摘を直す（git の起動の検査を字句で読み、`exec("git status")`・変数・テンプレート経由の起動を取りこぼさず、コメントだけの git.ts を通さない）
  - 種別: 修正
  - 計画: S5
  - 依存: T03（直す対象）
  - 変更: `scripts/check-architecture.mjs`, `server/test/architecture.test.ts`
  - red: `cd server && node --test test/architecture.test.ts` → T03 の検査で失敗する（`--root` で写しを見られず、取りこぼしの形を落とせない）
  - 完了条件: `cd server && node --test test/architecture.test.ts` → pass（9 つの起動の形がどれも `stray.ts starts git`、起動しない文言は通る、コメントだけの git.ts は `names no git to start`）。`bun run architecture` → exit 0
  - コミット: `test(architecture): read git starts as tokens, past variables and templates (T11)`
  - 結果: `cd server && node --test test/architecture.test.ts` → T03 の検査（check-architecture.mjs を stash して確認）で 1 件失敗した（最初の形で exit 0）
  - 結果: `cd server && node --test test/architecture.test.ts` → 1 件 pass。`bun run architecture` → exit 0

## P2: 作業ツリーの比較を別の git ディレクトリと子プロセスへ移す

status と作業ツリー対 commit の diff が、`~/.sphica/git/` の隔離先で子プロセスから流れ、どの設定のフィルタ・diff ドライバ・hook も走らない。

- [x] T04: git-worker.ts と親の非同期の入口を足し、bundle の entry にする
  - 種別: 追加
  - 計画: S2
  - 依存: T01（共通の起動の引数と環境、`revParse` などの操作が要る）
  - 変更: `server/src/git-worker.ts`, `server/src/git.ts`, `scripts/bundle.mjs`, `scripts/lib/bundle-budget.mjs`, `knip.json`, `server/test/git-worker.test.ts`, `server/test/architecture.test.ts`
  - 完了条件: `cd server && node --test test/git-worker.test.ts` → 隔離先の検査（HOME の外へのリンク、作業ツリーや temp との重なりで失敗）、入力の読み取り（FIFO・リンク・上限超えで失敗）、config の正規化（型に合わない値を書かない）、unborn HEAD と index 無し、締め切りでの打ち切り、古い残りの掃除が全件 pass。`bun run bundle` → `plugin/dist/git-worker.js` ができる
  - コミット: `feat(git): add a worker that runs worktree comparisons in an isolated git directory (T04)`
  - 結果: `cd server && node --test test/git-worker.test.ts` → 5 件 pass（隔離先: HOME の外へのリンク・hooks が空でない・作業ツリーや temp との重なりで失敗。読み取り: リンク・ディレクトリ・FIFO・上限超えで失敗。config: 改行で節を足す値と型に合わない値で失敗。unborn HEAD と index 無しで未追跡とステージ済みが出る。締め切り 1 ms で null。1 時間より古い残りだけ消える）
  - 結果: `bun run bundle` → `plugin/dist/git-worker.js` 10.94 KB。`echo '{"root":…,"ops":[{"kind":"status"}],"max":1048576}' | node plugin/dist/git-worker.js` → `{"ok":true,"out":["? a\u0000"]}`

- [x] T05: 作業ツリーの比較（snapshot の status、renamesSince、localChange の diff）を子プロセスの入口へ置き換え、capture と read の呼び出しを非同期にする
  - 種別: 修正
  - 計画: S3
  - 依存: T04（子プロセスの入口が要る）
  - 変更: `server/src/worktree.ts`, `server/src/git.ts`, `server/src/review-bridge.ts`, `server/src/capture.ts`, `server/src/read.ts`, `server/src/deliver.ts`, `server/src/github.ts`, `server/package.json`, `server/test/isolate-home.ts`, `server/test/git-safety.test.ts`, `server/test/capture.test.ts`, `server/test/review-bridge.test.ts`, `server/evals/acceptance/driver.ts`
  - red: `cd server && node --test test/git-safety.test.ts` → 直す前の本体で、`filter.<名前>.clean`・`filter.<名前>.process`・`.git/info/attributes` だけのフィルタ・`diff.<名前>.command` を仕込んだリポジトリの `snapshot`・`renamesSince`・`localChange` が印を付けて失敗する
  - 完了条件: `cd server && node --test test/git-safety.test.ts test/capture.test.ts` → 全件 pass。`bun run verify` → exit 0
  - コミット: `fix(git): compare the worktree only through the isolated git worker (T05)`
  - 結果: `cd server && node --test test/git-safety.test.ts` → 直す前の本体で 1 件失敗した（`snapshot runs the planted clean`）
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/*.test.ts` → 1068 件中 1066 件 pass の段階で、残る 2 件（review-bridge）は index のコピーの更新時刻が新しく、直前の変更を git が見落としたためと分かった。コピーに元の index の更新時刻を付けて直し、`test/review-bridge.test.ts test/git-worker.test.ts test/git-safety.test.ts test/capture.test.ts` を 3 回続けて 97 件 pass

- [x] T12: T04 のレビューの指摘を直す（git と worker を HOME で起動する、掃除を隔離先の検査の後にする、worker の git に締め切りを渡しプロセスグループごと止める、HEAD の commit が欠けたら失敗を返す、JSON の膨らみを上限に数える、空の `core.excludesFile` を区別する）
  - 種別: 修正
  - 計画: S2
  - 依存: T04（直す対象）
  - 変更: `server/src/git.ts`, `server/src/git-worker.ts`, `server/test/git-worker.test.ts`
  - red: `cd server && node --test test/git-worker.test.ts` → T04 の git.ts と git-worker.ts で 6 件失敗する（起動場所、リンクの先の掃除、残る git、欠けた HEAD、空の excludesFile、制御文字の名前）
  - 完了条件: `cd server && node --test test/git-worker.test.ts` → 全件 pass
  - コミット: `fix(git): compare the worktree only through the isolated git worker (T05, T12)`
  - 結果: `cd server && node --test test/git-worker.test.ts` → T04 の git.ts と git-worker.ts（HEAD から戻して確認）で 7 件失敗した（6 件の指摘と、引数の形を変えた掃除のテスト）
  - 結果: `cd server && node --test test/git-worker.test.ts` → 11 件 pass

- [x] T13: T05・T12 のレビューの指摘を直す（rename の検出で commit の解決と worker が 1 つの締め切りを分ける、テストを 1 ファイルだけ直接流しても HOME を一時ディレクトリへ向ける、攻撃テストで安全側の答えの中身を確かめる）
  - 種別: 修正
  - 計画: S3
  - 依存: T05（直す対象）
  - 変更: `server/src/git.ts`, `server/src/git-worker.ts`, `server/test/isolate-home.ts`, `server/test/read.test.ts`, `server/test/record.test.ts`, `server/test/review-bridge.test.ts`, `server/test/git-safety.test.ts`, `server/test/git-worker.test.ts`
  - red: `cd server && node --test test/git-safety.test.ts` → T06 の本体で 1 件失敗する（中身を確かめると、clean を仕込んだリポジトリの `renamesSince` が null）
  - 完了条件: `cd server && node --test test/git-safety.test.ts test/git-worker.test.ts test/read.test.ts test/review-bridge.test.ts` → 全件 pass。`.sphica/git` を通常のファイルにした HOME で read・record・review-bridge のテストを 1 ファイルずつ直接流して全件 pass
  - コミット: `fix(git): share deadlines, round worker timeouts, and keep direct test runs off HOME (T13)`
  - 結果: `cd server && node --test --test-name-pattern="filters, diff drivers" test/git-safety.test.ts` → T06 の本体で 3 回とも失敗した（`renamesSince with clean`）。worker が `The value of "timeout" is out of range ... Received 7939.60009765625` を返していた（締め切りの 8 割が小数になる）
  - 結果: `.sphica/git` を通常のファイルにした HOME で `node --test test/read.test.ts`・`test/record.test.ts`・`test/review-bridge.test.ts` → 直す前は 1・2・12 件失敗、直した後は 0 件
  - 結果: `cd server && node --test test/git-safety.test.ts test/git-worker.test.ts test/read.test.ts test/review-bridge.test.ts` → 2 回とも 37 件 pass

- [x] T14: T11 のレビューの指摘を直す（node:child_process を読み込めるモジュールを一覧に限り、その中で git を起動するのを git.ts と git-worker.ts に限る。文字列はエスケープを戻し、テンプレートの各部分も見る）
  - 種別: 修正
  - 計画: S5
  - 依存: T11（直す対象）
  - 変更: `scripts/check-architecture.mjs`, `server/test/architecture.test.ts`
  - red: `cd server && node --test test/architecture.test.ts` → T11 の検査で失敗する（`spawn("\x67it", [])` を通す）
  - 完了条件: `cd server && node --test test/architecture.test.ts` → pass。`bun run architecture` → exit 0
  - コミット: `test(architecture): allow child processes in five modules and git in two (T14)`
  - 結果: `cd server && node --test test/architecture.test.ts` → T11 の検査（HEAD から戻して確認）で 1 件失敗した（`spawn("\x67it", [])` で exit 0）
  - 結果: `cd server && node --test test/architecture.test.ts` → 1 件 pass。`bun run architecture` → exit 0（5 つのモジュールが子プロセスを起動し、git は 2 つだけ）

## P3: 攻撃テストを広げ、CI の全 OS と Git 2.34 で流す

残りの経路と互換の形式をテストに入れ、macOS・Windows・ubuntu:22.04 の job で流す。

- [x] T06: 残りの経路（submodule、hook、config で定義した hook、持ち主の global のフィルタ、config.worktree）と互換の形式（linked worktree、split index、sparse checkout、SHA-256、submodule のポインタの変化、64 MB の index の時間）をテストに足す
  - 種別: 追加
  - 計画: S6
  - 依存: T05（全部の公開関数が新しい入口を通っていないと、安全側の出力を比べられない）
  - 変更: `server/test/git-safety.test.ts`
  - 完了条件: `cd server && node --test test/git-safety.test.ts` → 全件 pass。各経路で、陽性対照の素の git が印を付ける
  - コミット: `test(git): cover submodules, hooks, global filters, and repository formats (T06)`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/git-safety.test.ts` → 5 件 pass。陽性対照: 素の git で clean・process・info/attributes のフィルタ・外部 diff・textconv・diff.external・.git/hooks の post-index-change・submodule の fsmonitor・config.worktree の fsmonitor・持ち主の global のフィルタが印を付けた（config で定義した hook は git 2.54 で印を付けた）。互換: linked worktree・split index・sparse checkout・SHA-256・submodule の commit の変化で、隔離した status が素の git の status と一致
  - 結果: 64 MB の index（42 万エントリー、全部 skip-worktree）で `inIsolation(root, [{ kind: "status" }])` → 259〜313 ms（3 回）。同じリポジトリの素の `git status` は 30 ms。締め切り 5 秒に収まる（手で測った値。CI のテストには入れていない）

- [x] T07: CI の macOS と Windows の job で git-safety.test.ts を流し、ubuntu:22.04 のコンテナの job を足す
  - 種別: 追加
  - 計画: S6
  - 依存: T06（流すテストが要る）
  - 変更: `.github/workflows/check.yml`
  - 完了条件: `actionlint .github/workflows/check.yml` → 指摘なし。push の後の `gh pr checks <PR 番号>` で、新しい job と macOS・Windows の job が pass し、ubuntu:22.04 の job のログに `git version 2.34`
  - コミット: `ci: run the git safety tests on macOS, Windows, and Git 2.34 (T07)`
  - 結果: `actionlint .github/workflows/check.yml` → 指摘なし。macOS の job に git-safety と git-worker、Windows の job に git-safety（worker のテストは FIFO・POSIX シェルの偽の git・制御文字のファイル名に頼るので macOS と Linux だけ）、ubuntu:22.04（ダイジェストで固定）の job に両方を足した。CI での実走は、持ち主の決定（全部終えてから push）により push の後に確かめる

- [x] T15: T06 のレビューの指摘を直す（足した攻撃のケースで Sphica の答えの中身も確かめる、submodule の中のフィルタの経路を足す、Windows でも hook の陽性対照を必須にする）
  - 種別: 修正
  - 計画: S6
  - 依存: T06（直す対象）
  - 変更: `server/test/git-safety.test.ts`
  - red: worktreeStatus を一時的に null を返す形にして `cd server && node --test --test-name-pattern="hooks, a submodule" test/git-safety.test.ts` → T06 のテストは通るが、直したテストは失敗する
  - 完了条件: `cd server && node --test test/git-safety.test.ts` → 全件 pass（submodule の fsmonitor とフィルタの両方の陽性対照を含む）
  - コミット: `test(git): check answers and cover a submodule's filter in the attack tests (T15)`
  - 結果: worktreeStatus を一時的に null にして `node --test --test-name-pattern="hooks, a submodule" test/git-safety.test.ts` → 1 件失敗した（`snapshot answers`）。元に戻して確かめた
  - 結果: `cd server && node --test test/git-safety.test.ts` → 5 件 pass

- [x] T16: T14 のレビューの指摘のうち、エスケープの戻し方を JavaScript と同じにする（`\t` などの制御文字、`\0`、行の継続）
  - 種別: 修正
  - 計画: S5
  - 依存: T14（直す対象）
  - 変更: `scripts/check-architecture.mjs`, `server/test/architecture.test.ts`
  - red: `cd server && node --test test/architecture.test.ts` → T14 の検査で失敗する（`exec("git\tstatus")` を通す）
  - 完了条件: `cd server && node --test test/architecture.test.ts` → pass。`bun run architecture` → exit 0
  - コミット: `test(architecture): decode string escapes as JavaScript does (T16)`
  - 結果: `cd server && node --test test/architecture.test.ts` → T14 の検査（HEAD から戻して確認）で 1 件失敗した（`exec("git\tstatus")` で exit 0）
  - 結果: `cd server && node --test test/architecture.test.ts` → 1 件 pass。`bun run architecture` → exit 0

## P4: リリース

- [x] T08: 0.6.43 にバージョンを上げる（挙動の変化（LFS と replace refs）は PR 本文の Release notes に書く）
  - 種別: 変更
  - 計画: S7
  - 依存: なし
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run release:plan -- --base v0.6.42` → plugin。`bun run verify` → exit 0（バージョンの同期の検査を含む）
  - コミット: `chore(release): 0.6.43 (T08)`
  - 結果: `bun run release:plan -- --base v0.6.42` → release kind: plugin（inputs: git.ts ほか 7 ファイル）
  - 結果: `bun run verify` → exit 0（T01 と同じコミットで、4 つのファイルを 0.6.43 にした）

## 記録

- 2026-10-09 / T01 / 変更欄から `server/src/repo-facts.ts` を外した（前: 含む、後: 含まない）。repo-facts.ts は `commitHolds` と `repoFiles` を名前で読むだけで、git.ts の側で同じ名前のまま直したので変える所が無かった
- 2026-10-09 / T01 / 作業ツリーを比べる操作（status、作業ツリー対 commit の diff、renamesSince）も、T05 までの間は git.ts の関数として固定のキーを打ち消して流す。T05 で子プロセスへ移す
- 2026-10-09 / T08 / pre-commit の bundle の検査が、出荷物の入力を変えたコミットにバージョンの同期を求めて T01 のコミットを止めた。T08 の依存を「T07」から「なし」に変え、T01 と同じコミットで 0.6.43 に上げた
- 2026-10-09 / T01 / Codex のタスクレビュー（a3b9c9f2）: F1（commit 間の変更ファイルの上限が 1 MB に下がった、P2）と F2（ruleFiles の失敗をテストが通す、P2）を採用し、T09 を足した。Codex の実走は read-only のため mkdtemp で失敗しており、テストの通過は Claude 側で確かめた
- 2026-10-09 / T02 / Codex のタスクレビュー（2f578e1b）: F1（一時ディレクトリの削除の失敗が gh の結果を上書きする、P2）と F2（作成の失敗を gh が無いと扱う、P2）を採用し、T10 を足した。一時ディレクトリをやめて HOME で起動する形にした（HOME の git リポジトリは持ち主のもので、エージェントは HOME に書けない前提に収まる）
- 2026-10-09 / T04 / 変更欄の `scripts/check-tarball.mjs` を `scripts/lib/bundle-budget.mjs` に替えた。tarball は dist を丸ごと載せるので一覧の変更は要らず、新しい entry には予算（13,000 バイト）と hook と同じ zod の禁止が要った
- 2026-10-09 / T04 / 変更欄に `knip.json`（git-worker.ts を entry に、mkfifo をテストの外部コマンドに）と `server/test/architecture.test.ts`（git を起動するのが 2 ファイルになったので、両方を空にして検査が落ちるのを見る）を足した
- 2026-10-09 / T03 / Codex のタスクレビュー（50d2f5ac）: F1（`exec("git status")`・変数・テンプレート経由の起動を取りこぼす、P2）と F2（コメントや無関係な呼び出しで空振り防止が通る、P2）を採用し、T11 を足した。T09・T10 のレビュー（7931d317）は指摘なし
- 2026-10-09 / T04 / Codex のタスクレビュー（160c7cba）: F1（Windows で作業ツリーの git.exe が先に走る、P1）、F2〜F6（P2）を採用し、T12 を足した。F1 は T01 の元のリポジトリでの git にもあった
- 2026-10-09 / T05 / 隔離先と temp の重なりの検査（計画の子プロセス節 1 の (3)）で、HOME を temp の中に作るテストの作業ツリーの比較が全部失敗した。新しい会話で Codex に相談し、検査は残す（外すと TMPDIR が `~/.sphica` にある構成を拒めない）、テストの配置を直す、で決めた。テストは `--import ./test/isolate-home.ts` で、どのテストも HOME と temp を別の一時ディレクトリに向けて始める
- 2026-10-09 / T05 / review-bridge などのテストが HOME を差し替えずに作業ツリーの比較を流し、持ち主の `~/.sphica/git/hooks`（空）を作っていた。最初に作ったのは手で流した `plugin/dist/git-worker.js`。空であることを確かめて消し、上の isolate-home で再発を止めた
- 2026-10-09 / T05 / HOME が無いテスト（`HOME=/nonexistent`）で git が起動できなくなった。起動場所は HOME が無ければ Node の置き場所にした。gh も同じ起動場所にした
- 2026-10-09 / T05 / 締め切りのテストが並行の実行でときどき落ちた（worker と親の締め切りが同じで、親が先に worker を止めると孫の git が残る）。worker の締め切りを親の 8 割にし、POSIX ではプロセスグループごと止める
- 2026-10-09 / T05 / 変更欄に `server/evals/acceptance/driver.ts` を足した。onHook が非同期になり、driver の呼び出しを lint（noFloatingPromises）が見つけたので await した
- 2026-10-09 / T06 / hook の陽性対照で、テスト用の素の git（update-index）が hook を走らせて印が付き、Sphica が走らせたように見えた。index を作り直した後に印を消してから測る形にした
- 2026-10-09 / T05 / Codex のタスクレビュー（9fb9740c）: F1（rename の検出の事前処理が締め切りの外、P2）、F2（テストを直接流すと HOME が隔離されない、P2）、F3（攻撃テストが失敗の答えでも通る、P2）を採用し、T13 を足した。F3 を直したテストが、締め切りの 8 割が小数になって worker が失敗する不具合を見つけた
- 2026-10-09 / T11 / Codex のタスクレビュー（dac3b908）: F1〜F3（P2）を採用し、T14 を足した。字句の検査では実行時に組み立てる名前まで捕まえられないので、子プロセスを起動できるモジュールを 5 つに絞り、残りはレビューで見る、と検査のコメントに書いた
- 2026-10-09 / T06 / Codex のタスクレビュー（f91611bc）: F1（足したケースが失敗の答えでも通る、P2）、F2（submodule の中のフィルタが未テスト、P2）、F3（Windows で hook の陽性対照を省く、P2）を採用し、T15 を足した
- 2026-10-09 / T14 / Codex のタスクレビュー（d5c5a704）: F1（エスケープの戻し方が JavaScript と違う、P2）を採用し T16 を足した。F2（文字列の一致を読み込みとみなす誤検出と、空振り防止が実際の読み込みを確かめない、P2）は見送った。誤検出は子プロセスを起動しない側に倒れるだけで、空振り防止は字句の検査では証明にならない（検査のコメントに限界として書いてある）。この検査への指摘は 3 回目で、字句の検査を詰めるのはここで止める
