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

- [ ] T01: git.ts を操作ごとの関数と共通の起動に作り直し、中身を読まない呼び出しを置き換える
  - 種別: 修正
  - 計画: S1
  - 依存: なし
  - 変更: `server/src/git.ts`, `server/src/project.ts`, `server/src/plugin.ts`, `server/src/glean.ts`, `server/src/rule-files.ts`, `server/src/repo-facts.ts`, `server/src/worktree.ts`, `server/src/review-bridge.ts`, `server/test/git-safety.test.ts`
  - red: `cd server && node --test test/git-safety.test.ts` → 直す前の本体で、`core.fsmonitor`（`.git/config` と `include.path` 先）を仕込んだリポジトリの `repoFiles`・`identify`・`ruleFiles` が印を付けて失敗する。欠けたオブジェクトと promisor remote を仕込んだ `catFileBlob` 相当（glean の読み取り）が `ext::` の印を付けて失敗する
  - 完了条件: `cd server && node --test test/git-safety.test.ts` → 中身を読まない操作の経路が全件 pass（陽性対照は素の git で印が付く）。`bun run verify` → exit 0
  - コミット: `fix(git): run git for reads with command-running config switched off (T01)`

- [ ] T02: gh と ghUser を空の一時ディレクトリで、GIT_* を除いた環境で起動する
  - 種別: 修正
  - 計画: S4
  - 依存: なし
  - 変更: `server/src/github.ts`, `server/test/github.test.ts`
  - red: `cd server && node --test --test-name-pattern="gh starts outside the repository" test/github.test.ts` → 直す前の本体で、偽の `gh` が記録した cwd が呼び出し元の作業ディレクトリで、環境に `GIT_DIR` が残って失敗する
  - 完了条件: `cd server && node --test test/github.test.ts` → 全件 pass
  - コミット: `fix(github): start gh outside the repository without GIT_ variables (T02)`

- [ ] T03: check-architecture.mjs で、git を起動するのが git.ts と git-worker.ts だけであることを検査する
  - 種別: 追加
  - 計画: S5
  - 依存: T01（ほかのモジュールの直接の起動が消えていないと検査が通らない）
  - 変更: `scripts/check-architecture.mjs`, `server/test/architecture.test.ts`
  - 完了条件: `bun run architecture` → exit 0。`cd server && node --test test/architecture.test.ts` → `server/src` に `execFileSync("git", …)` を足した写しで検査が exit 1 になるテストが pass
  - コミット: `test(architecture): allow git to start only from git.ts and the git worker (T03)`

## P2: 作業ツリーの比較を別の git ディレクトリと子プロセスへ移す

status と作業ツリー対 commit の diff が、`~/.sphica/git/` の隔離先で子プロセスから流れ、どの設定のフィルタ・diff ドライバ・hook も走らない。

- [ ] T04: git-worker.ts と親の非同期の入口を足し、bundle の entry にする
  - 種別: 追加
  - 計画: S2
  - 依存: T01（共通の起動の引数と環境、`revParse` などの操作が要る）
  - 変更: `server/src/git-worker.ts`, `server/src/git.ts`, `scripts/bundle.mjs`, `scripts/check-tarball.mjs`, `server/test/git-worker.test.ts`
  - 完了条件: `cd server && node --test test/git-worker.test.ts` → 隔離先の検査（HOME の外へのリンク、作業ツリーや temp との重なりで失敗）、入力の読み取り（FIFO・リンク・上限超えで失敗）、config の正規化（型に合わない値を書かない）、unborn HEAD と index 無し、締め切りでの打ち切り、古い残りの掃除が全件 pass。`bun run bundle` → `plugin/dist/git-worker.js` ができる
  - コミット: `feat(git): add a worker that runs worktree comparisons in an isolated git directory (T04)`

- [ ] T05: 作業ツリーの比較（snapshot の status、renamesSince、localChange の diff）を子プロセスの入口へ置き換え、capture と read の呼び出しを非同期にする
  - 種別: 修正
  - 計画: S3
  - 依存: T04（子プロセスの入口が要る）
  - 変更: `server/src/worktree.ts`, `server/src/git.ts`, `server/src/review-bridge.ts`, `server/src/capture.ts`, `server/src/read.ts`, `server/src/deliver.ts`, `server/test/git-safety.test.ts`, `server/test/capture.test.ts`
  - red: `cd server && node --test test/git-safety.test.ts` → 直す前の本体で、`filter.<名前>.clean`・`filter.<名前>.process`・`.git/info/attributes` だけのフィルタ・`diff.<名前>.command` を仕込んだリポジトリの `snapshot`・`renamesSince`・`localChange` が印を付けて失敗する
  - 完了条件: `cd server && node --test test/git-safety.test.ts test/capture.test.ts` → 全件 pass。`bun run verify` → exit 0
  - コミット: `fix(git): compare the worktree only through the isolated git worker (T05)`

## P3: 攻撃テストを広げ、CI の全 OS と Git 2.34 で流す

残りの経路と互換の形式をテストに入れ、macOS・Windows・ubuntu:22.04 の job で流す。

- [ ] T06: 残りの経路（submodule、hook、config で定義した hook、持ち主の global のフィルタ、config.worktree）と互換の形式（linked worktree、split index、sparse checkout、SHA-256、submodule のポインタの変化、64 MB の index の時間）をテストに足す
  - 種別: 追加
  - 計画: S6
  - 依存: T05（全部の公開関数が新しい入口を通っていないと、安全側の出力を比べられない）
  - 変更: `server/test/git-safety.test.ts`
  - 完了条件: `cd server && node --test test/git-safety.test.ts` → 全件 pass。各経路で、陽性対照の素の git が印を付ける
  - コミット: `test(git): cover submodules, hooks, global filters, and repository formats (T06)`

- [ ] T07: CI の macOS と Windows の job で git-safety.test.ts を流し、ubuntu:22.04 のコンテナの job を足す
  - 種別: 追加
  - 計画: S6
  - 依存: T06（流すテストが要る）
  - 変更: `.github/workflows/check.yml`
  - 完了条件: `actionlint .github/workflows/check.yml` → 指摘なし。push の後の `gh pr checks <PR 番号>` で、新しい job と macOS・Windows の job が pass し、ubuntu:22.04 の job のログに `git version 2.34`
  - コミット: `ci: run the git safety tests on macOS, Windows, and Git 2.34 (T07)`

## P4: リリース

- [ ] T08: 0.6.43 にバージョンを上げる（挙動の変化（LFS と replace refs）は PR 本文の Release notes に書く）
  - 種別: 変更
  - 計画: S7
  - 依存: T07（出荷するコードとテストが揃っている必要がある）
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run release:plan -- --base v0.6.42` → plugin。`bun run verify` → exit 0（バージョンの同期の検査を含む）
  - コミット: `chore(release): 0.6.43 (T08)`

## 記録
