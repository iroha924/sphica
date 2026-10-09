---
kind: plan
status: approved
codex_session: 01a11faa-78b7-7493-b3b8-d375f0b3ba83
codex_rounds: 4
approved_at: 2026-10-09
---

# Sphica の git 呼び出しで、エージェントのリポジトリの設定がコマンドを走らせないようにする（GHSA-gmmq-h5f6-8jrc）

## 要点

- git の起動を `server/src/git.ts` の操作ごとの関数に集め、ほかのモジュールは git を起動しない（機械の検査で止める）
- 作業ツリーの中身を読まない操作（rev-parse、ls-files、cat-file など）は元のリポジトリで流し、コマンドを名指す固定のキーを打ち消し、fetch とプロンプトを止める
- 作業ツリーを中身で比べる操作（status、作業ツリー対 commit の diff）は、Sphica が `~/.sphica/git/` に作る別の git ディレクトリで、別の Node プロセスから流す。エージェントや持ち主の設定のフィルタ・diff ドライバ・hook は読まれない
- `gh` は空の一時ディレクトリを cwd に、GIT_* を除いた環境で起動する
- 攻撃テストを、鍵ごとの陽性対照付きで Linux・macOS・Windows と Git 2.34 で流す
- 0.6.43 で出し、届いたのを確かめてから advisory を公開する
- 変えないもの: Sphica の MCP ツール・CLI・DB の形。変わる挙動: LFS と replace refs は作業ツリーの比較で効かなくなる

## 持ち主の決定

- 直し方の方向: すべての git 呼び出しで、コマンドを動かす設定を打ち消す。パッチリリースで出す
- advisory は非公開の draft（GHSA-gmmq-h5f6-8jrc、severity high）で作った。公開は修正版が届いてから
- 作業ツリーの比較の準備と実行は子プロセスに分け、締め切りで打ち切る（Codex との議論の後に持ち主が選んだ。「子プロセスに分ける (Recommended)」）

## 目的

- エージェントが `.git/config`、`include.path` の先、`config.worktree`、`.gitattributes`、`.git/info/attributes`、submodule の設定、`.git/hooks` に何を書いても、Sphica のフック・MCP サーバー・CLI の git 呼び出しで、その内容のコマンドが走らない。攻撃テストの印のファイルが空のままであることで観測する
- 同じテストで、素の git では印が付くこと（陽性対照）を確かめる
- 前提: エージェントは HOME のうち `~/.sphica/git/` に、どの書き込み経路（シェル、ファイル編集ツール、追加の書き込み許可）からも書けない。HOME に書けるならシェルの起動ファイルなどで既に外へ出られるので、この修正の対象外として advisory に書く

## 対象外

- 評価の runner（`server/evals/`）の git。`pinCheckout` / `checkoutGit` で別に塞いである
- HOME に書けるエージェント（目的の前提を参照）
- 観測中に index や objects が書き換わって出力が食い違うこと。読み取り失敗として扱う
- 持ち主の global / system の設定のうち、作業ツリーの比較以外の操作で読まれるもの（中身を読まない操作では、コマンドを走らせる経路を固定のキーと操作の制限で塞ぐ）

## 前提

- git を起動している箇所: `server/src/git.ts:7`（`cleanGit`、glean.ts と rule-files.ts もこれを通る）、`server/src/review-bridge.ts:53`、`server/src/project.ts:65`、`server/src/worktree.ts:15`、`server/src/plugin.ts:100`。`gh` は `server/src/github.ts:69` と `:95`（cwd 未指定）
- 実測（git 2.54.0、Apple Git-157、2026-10-09）:
  - `core.fsmonitor` は `ls-files`（`--deleted`、`--cached --others` を含む）・`status`・`diff HEAD` で走り、`rev-parse`・`config --list` では走らない
  - `filter.<名前>.clean` は `status` と `diff HEAD` で走る（index の stat の状態で走らないこともある）。`.git/info/attributes` だけで指定しても `diff` で走った
  - `diff.<名前>.command` は `diff HEAD` で走る
  - `-c core.fsmonitor=` 系の空の値で止まる。`include.path` 先の `core.fsmonitor` も止まる
  - 一時ディレクトリに `HEAD`・最小の `config`・index のコピー・空の `refs/` `objects/` `info/` を置き、`GIT_DIR`・`GIT_WORK_TREE`・`GIT_OBJECT_DIRECTORY` で流すと、`status --porcelain=v2`・`diff HEAD --stat`・`diff -M --name-status HEAD --` は正しく出力し、フィルタは走らない。`refs/` と `objects/` が無いと git はリポジトリと認めない
  - 64 MB のファイルの `fs.copyFileSync` は 1 回 40 ms（APFS）。`node -e 0` の起動は 20 ms
- Git 2.35.1 以前は `core.fsmonitor` の true / false を hook のパスとして扱う（https://git-scm.com/docs/git-config 、Codex が git v2.34.0 の config.c で確認）。空の値は両方で無効
- 欠けたオブジェクトを読むと promisor remote への fetch が走り得る。空の `GIT_ALLOW_PROTOCOL` は古い git でも remote helper の起動前に効く（Codex が v2.34.0 の transport.c で確認）
- `status` は index を書き直すことがあり、そのとき `post-index-change` hook が走る（Codex が v2.34.0 の read-cache.c で確認）。Git 2.54 は config で定義した hook（`hook.<名前>.command`）も持つ
- `-c` の値は最初の `=` でキーと値に分かれるので、`=` を含む名前は打ち消せない（Codex、config.c）
- `--attr-source` は `.git/info/attributes` を差し替えない（Codex、attr.c）
- Claude Code と Codex のサンドボックスは temp に書ける（https://code.claude.com/docs/en/sandboxing 、https://learn.chatgpt.com/docs/permissions ）。両ホストで `~/.sphica/git/` が書けないことの実地確認は未検証
- CI の macOS と Windows の job は選んだテストだけを流す（`.github/workflows/check.yml:107`、`:145`）

## 方針

### 入口（`server/src/git.ts`）

任意の `string[]` を受ける入口は置かない。操作ごとの関数が argv を中で組む。

- 中身を読まない操作（元のリポジトリで流す）: `revParse`（固定の形だけ: `--show-toplevel`、`--git-common-dir`、`--git-path <固定名>`、`--verify -q <oid か ref>^{commit}`、`--abbrev-ref` 系、`--is-inside-work-tree`）、`mergeBase`、`isAncestor`、`lsTree`、`catFileSize`、`catFileBlob`（`--filters` と `--textconv` は使わない）、`lsFiles`（`--cached`・`--others`・`--deleted`・`--exclude-standard` の組み合わせだけ。`--modified` は使わない）、`remoteUrl`（origin のみ）、`commitDiffNames`（検証済みの 2 つの OID の間の `--name-only`）、`configGet`（固定のキーの読み取りだけ）
- これらの共通の起動:
  - 引数: `-c core.fsmonitor= -c core.hooksPath=<~/.sphica/git/hooks> --no-pager --no-optional-locks`。diff には `--no-ext-diff --no-textconv --ignore-submodules=dirty --submodule=short`
  - 環境: 親の環境から `/^GIT_/i` を除き、`GIT_ALLOW_PROTOCOL=`（空）、`GIT_NO_LAZY_FETCH=1`、`GIT_TERMINAL_PROMPT=0`、`GIT_NO_REPLACE_OBJECTS=1` を足す
  - timeout と `killSignal: "SIGKILL"`
  - これらの操作は index を書く経路を通らないので、config で定義した hook が走る機会は無い（split index の sharedindex の mtime は更新され得る）
- 作業ツリーを比べる操作（非同期、子プロセス）: `worktreeStatus`、`worktreeDiff`（作業ツリー対 commit の差分本文と `--name-only`）、`worktreeRenames`（`-M --name-status`）。1 回の観測（snapshot、review の localChange）で使う複数の操作は、1 つの子プロセスと 1 つの隔離状態で流す

### 子プロセス（`server/src/git-worker.ts`、`plugin/dist/git-worker.js` に bundle する）

- 親は `spawn(process.execPath, [<worker>], { stdio })` で起動し、要求を JSON で stdin に渡し、結果を stdout から読む。締め切りを過ぎたら失敗を返し、子に SIGKILL を送り、子の終了を待たない（`unref`）
- 子がすること:
  1. 隔離先を作る: `H = fs.realpathSync(os.homedir())`。`~/.sphica/git/` と `<ランダム>`（`fs.mkdtempSync`）と `hooks`（空）を作り、(1) 解決済みの実パスが H の中、(2) H から下の各段（`.sphica`、`git`、`<ランダム>`、`hooks`）を `lstat` してリンクでない、(3) 実パスが作業ツリーのルートと `os.tmpdir()` の実パスのどちらとも重ならない、を確かめる。崩れたら失敗を返し、元のリポジトリでは流さない。0700 は保護の根拠にしない
  2. 入力を読む: 元のリポジトリの index（`revParse --git-path index`）、split index の `sharedindex.*`、`info/exclude`、`info/attributes`、`info/sparse-checkout`、global の除外ファイル。どれも `fs.openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)` で開き、`fs.fstatSync(fd)` が通常ファイルでサイズが上限以下（index と sharedindex は 256 MB、ほかは 1 MB）のときだけ、上限までのバッファで fd から読む（`readFileSync` は使わない）。読んだ量が上限を超えたら失敗。Windows では `lstat` で通常ファイルを確かめてから開き、開いた後の `fstat` の dev / ino と照らす
  3. 隔離の git ディレクトリを書く: `HEAD`（`revParse` で解決した OID。unborn なら `ref: refs/heads/sphica-unborn`）、`config`（Sphica が書く）、index とその sharedindex（無ければ置かない）、`info/exclude`・`info/attributes`・`info/sparse-checkout`（データとしてだけ読まれる）、global の除外ファイルのコピー、空の `refs/` と `objects/`
  4. `config` の中身: `[core] repositoryformatversion`（`extensions.objectFormat` が sha256 なら 1）、`bare = false`、`quotePath = false`、元のリポジトリの有効値から写すキー: `core.ignorecase`・`core.precomposeunicode`・`core.filemode`・`core.symlinks`・`core.trustctime`・`core.sparseCheckout`・`core.sparseCheckoutCone`・`index.sparse`（boolean は true / false に正規化）、`core.autocrlf`（true / false / input）、`core.eol`（lf / crlf / native）、`core.checkStat`（default / minimal）、`extensions.objectFormat`（sha1 / sha256）。型に合わない値は書かない（その操作は失敗にする）。値の文字列をそのまま連結しない
  5. git を流す: `GIT_DIR=<隔離先>`、`GIT_WORK_TREE=<作業ツリー>`、`GIT_OBJECT_DIRECTORY=<revParse --git-common-dir>/objects`、`GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=<os.devNull>`、ほかは上の共通の環境と同じ。引数は共通のものに `-c core.excludesFile=<隔離先のコピー>`。status には `--ignore-submodules=dirty`（`--submodule=short` は渡さない）
  6. 隔離先を消す。親は起動のたびに、`~/.sphica/git/` の下の 1 時間より古い残り（打ち切られた子の分）を消す
- 締め切り: 配信フックとキャプチャの観測は全体で 5 秒、MCP の read の rename 検出は 10 秒（今の値に合わせる）

### 呼び出しの置き換え

- `worktree.ts` の `snapshot` と `changed` の status は `worktreeStatus`。commit 間の diff は `commitDiffNames`。`capture.ts` の `openTurn` / `closeTurn` は非同期になる
- `git.ts` の `renamesSince` は `worktreeRenames`。`read.ts` の `movedTo` は非同期になる
- `review-bridge.ts` の `localChange` は `worktreeDiff`（本文と名前を 1 つの子プロセスで）と `lsFiles`。`core.quotePath=false` は生成 config と共通の引数で保つ
- `project.ts`、`plugin.ts`、`glean.ts`、`rule-files.ts`、`repo-facts.ts` は中身を読まない操作の関数へ
- `github.ts` の `gh` と `ghUser`: cwd を空の一時ディレクトリに、環境は `/^GIT_/i` を除く

### 機械の検査

`scripts/check-architecture.mjs` に足す: `server/src` の中で `"git"` を子プロセスとして起動する（`execFile`・`execFileSync`・`spawn`・`spawnSync` の第 1 引数が `"git"`）のは `git.ts` と `git-worker.ts` だけ。違反を仕込んだテストで検査が落ちることも確かめる。

### テスト（`server/test/git-safety.test.ts`）

- 印を付けるプログラムは Node で作る（POSIX シェルに頼らない）。キーごとに別の印
- 仕込む経路: `core.fsmonitor`（`.git/config`、`include.path` 先、`config.worktree`）、`filter.<名前>.clean`、`filter.<名前>.process`（git-filter v2 のハンドシェイク前に印を付ける）、`diff.<名前>.textconv`、`diff.<名前>.command`、`diff.external`、`.git/info/attributes` だけで指定したフィルタ、`post-index-change` hook（`.git/hooks` と `hook.<名前>.command`）、欠けたオブジェクトと promisor remote（`ext::` で印）、submodule の中の `core.fsmonitor` とフィルタ、持ち主の global 設定のフィルタがリポジトリ内のスクリプトを呼ぶ形
- index は `update-index --add --cacheinfo` で stat の無いエントリにして、内容の比較を必ず起こす。各実行の前に index と印を作り直す
- 陽性対照: 同じ状態で素の git を流すと、その経路の印が付く。付かなければテストを落とす（skip しない）
- 安全側の出力も確かめる: 各公開関数が、仕込みの無いリポジトリと同じ結果（変更・未追跡・rename・差分）を返す。失敗を返しただけで印が付かなかった、という合格を防ぐ
- 互換: 通常、unborn HEAD（未追跡だけ、ステージ済み）、index 無し、linked worktree、split index、sparse checkout、SHA-256、submodule のポインタの変化
- 隔離先の検査: `~/.sphica` が HOME の外へのリンク、作業ツリーや temp と重なる場合に失敗を返す
- 子プロセスの打ち切り: 子が止まる状態を作り、締め切りで失敗が返る
- テストの HOME は一時ディレクトリにし、隔離先の検査を通る配置にする（検査をテストのために無効にしない）。`SPHICA_DB`・`SPHICA_HOME` は渡さない

### CI（`.github/workflows/check.yml`）

- macOS と Windows の job で `git-safety.test.ts` を流す
- Linux の専用 job を `ubuntu:22.04` のコンテナで足し、`git --version` が 2.34 系であることを確かめて（違えば落とす）、`git-safety.test.ts` を流す。config で定義した hook の陽性対照は、対応する新しい git の job に置く

## 採った案と棄却した案

- 採用: 作業ツリーの比較を別の git ディレクトリで流す。棄却: 呼ぶ直前にフィルタや diff ドライバの名前を列挙して `-c` で空にする（列挙の後に足されたものが走る。`=` を含む名前は打ち消せない）
- 採用: 別の git ディレクトリは Sphica が書く最小の config と index のコピーと `GIT_OBJECT_DIRECTORY`。棄却: git ディレクトリ全体を毎回複製する（重い）／`GIT_COMMON_DIR` を空の config の一時ディレクトリに向けて objects と refs をリンクでつなぐ（Windows のリンクで壊れやすい）
- 採用: `--attr-source` を使わない。棄却: 空の tree を属性源にしてフィルタを止める（`.git/info/attributes` は差し替わらず、最優先で読まれる）
- 採用: 作業ツリーの比較では global / system の設定も読まない。棄却: 持ち主の global のフィルタ（LFS を含む）を残す（エージェントが `.gitattributes` でそのフィルタを選び、フィルタが呼ぶリポジトリ内のスクリプトを書き換えられる）
- 採用: `core.fsmonitor=`（空）。棄却: `core.fsmonitor=false`（Git 2.35.1 以前は `false` という名前の hook として扱う）
- 採用: 隔離先は `~/.sphica/git/` の下で、実パスと各段を検査する。棄却: `os.tmpdir()`（両ホストのサンドボックスが temp に書ける）
- 採用: 操作ごとの関数。棄却: サブコマンド名だけを許可する汎用の入口（`diff HEAD` や `cat-file --filters` が通る）
- 採用: global の除外ファイルは隔離先へコピーして `-c core.excludesFile` で指す。棄却: `info/exclude` の後ろに連結する（git の優先順位が逆になる）
- 採用: 準備と git の実行を子プロセスに分ける（持ち主の選択）。棄却: 同じプロセスで fd の検査と経過時間の確認だけをする（同期の I/O は打ち切れない）
- 採用: submodule は `--ignore-submodules=dirty`。棄却: `--ignore-submodules=all`（コミットされたポインタの変化まで消える）
- 採用: `--no-pager`。棄却: `-c core.pager=cat`（`cat` の有無に依存する）

## 手順

- S1: `git.ts` を操作ごとの関数と共通の起動（引数・環境・timeout）に作り直し、中身を読まない呼び出し（project.ts、plugin.ts、glean.ts、rule-files.ts、repo-facts.ts、worktree.ts と review-bridge.ts の commit 間・ref の操作）を置き換える
- S2: `git-worker.ts`（隔離先の検査、入力の読み取り、config の生成、git の実行、後始末）と親の非同期の入口、bundle の entry を足す
- S3: 作業ツリーの比較（worktree.ts の status、renamesSince、localChange の diff）を S2 の入口へ置き換え、capture.ts と read.ts の呼び出しを非同期にする
- S4: `gh` と `ghUser` の cwd と環境
- S5: `check-architecture.mjs` に git の起動場所の検査を足す
- S6: `git-safety.test.ts` と CI の job（macOS、Windows、ubuntu:22.04）
- S7: 0.6.43 のリリース（plugin-release Skill の手順）と advisory の更新・公開

## 完了条件

- A1: `bun run verify` → exit 0
- A2: `cd server && node --test test/git-safety.test.ts` → 全件 pass。各経路の陽性対照が素の git で印を付け、Sphica の関数では印が空
- A3: `bun run architecture` → exit 0。`server/src` に `execFileSync("git", …)` を足した作業ツリーでは exit 1（テストで確かめる）
- A4: `gh pr checks <PR 番号>` → 全項目 pass。ubuntu:22.04 の job のログに `git version 2.34`、macOS と Windows の job に `git-safety.test.ts` の pass
- A5: `bun run release:plan -- --base v0.6.42` → plugin。npm と 3 つのマニフェストが 0.6.43
- A6: リリースの後、`npm view sphica version` → 0.6.43
- A7: `sphica doctor` → Claude Code と Codex のプラグインが 0.6.43 で起動している
- A8: `gh api repos/iroha924/sphica/security-advisories/GHSA-gmmq-h5f6-8jrc --jq '.state, .vulnerabilities[0].patched_versions'` → published と 0.6.43

## リスク

- 隔離の git ディレクトリの出力が、元のリポジトリと食い違う形式がある（linked worktree、split index、sparse index、SHA-256、reftable、`core.untrackedCache`）→ テストの互換ケースで見つけたら、写すキーを足すか、その形式では失敗を返す
- LFS 管理のファイルと replace refs は作業ツリーの比較で効かなくなる → リリースノートと advisory に書く
- 子プロセスの起動で観測ごとに 20 ms ほど遅くなる。大きな index（64 MB 以上）では準備が伸びる → 64 MB の index で全体の時間を測り、締め切りに収まらなければ持ち主に戻す
- 両ホストで `~/.sphica/git/` が実際に書けないことは未検証 → 実装中に Claude Code と Codex のサンドボックスから書き込みを試して確かめ、書けるなら持ち主に戻す
- Git for Windows で hooksPath と O_NOFOLLOW の扱いが違う → Windows の job の攻撃テストで確かめる
- `capture.ts` の `openTurn` / `closeTurn` を非同期にすると、ターンの境目の順序のテストが崩れる → 既存のテストを先に流して崩れた箇所を直す。順序の意味は変えない

## 未解決

なし

## 変更履歴
