---
kind: plan
status: approved
codex_session: 01a1420c-3ee4-7a00-b190-054fb7f4a1ce
codex_rounds: 3
approved_at: 2026-10-16
---

# 検査の待ち時間を CI・pre-push・release で縮め（#348）、README の Features を中心の 5 つから始める（#347）

## 要点

- 受け入れテスト 148 件を `shard-<k>.ts` の複数ファイルに分け、node --test が別々のプロセスで並行に走らせる。全件の入口 `run.ts` は残す
- CI の check を部分（static / unit / acceptance）ごとの並行のジョブにし、必須の check 名 `check (24.15)` `check (26)` は部分の結果をまとめるジョブとして残す。部分の和が verify と一致することを check-pairs で見る
- release.yml の prepare から verify を外し（PR の dry run もタグの push も）、bundle → 差分確認 → pack → check-tarball → SBOM の同じ経路にする。全検査はゲートが同じ head の check の成功で要求する
- `bun run setup` は依存の install scripts を流さず、hook はメインの作業ツリーで CI でないときだけ入れる
- 受け入れテストの driver が `CLAUDE_ENV_FILE` を退避する（既存の漏れ）
- README.md と README.ja.md の Features を、中心の 5 つ → 2 行の説明 → 残り 12 の順にする（文は変えない）
- 変えないもの: verify が流す検査の集合と順序、sql:reach の数え方、テストの一時的な HOME と DB、pre-push で verify 全体を流すこと、server/package.json（リリースを起こさない）、ruleset

## 持ち主の決定

- #348 と #347 を同じ PR で出す。main へ直接は出さない
- どの検査も外さない。テストを skip させない、sql:reach の数え方は変えない、テストは一時的な HOME と DB を使い続ける
- 案 5（pre-push で流すものを減らす）は、案 1〜3 で足りなかったときだけ、選択肢を添えて持ち主に聞く
- 案 4 は入れるかどうかも含めて Codex と詰める（→ 案 4' を採用）
- worktree の hook の件を同じ PR に入れる
- #347 の中心の 5 つ: Automatic recording / Records with their sources / Shown when it matters / Find what you asked before / Forget what should not have been kept。残り 12 は同じ README の下の見出しへ。文は消さない。README.ja.md も同じ（2026-10-16、案 A）
- 終わったら #348 と同じやり方で測り直し（CI は PR の check の各ジョブとステップの時間、手元は verify の部分ごとの時間）、前後の数字を PR 本文と #348 に残す。長い計測は caffeinate -i で包む

## 目的

- PR の check で最も遅いジョブの時間と、手元の `bun run verify` の時間が #348 の基準（CI 11.6 分、手元 約 6.6 分）より短くなり、同じやり方で測った前後の数字が PR 本文と #348 に残る
- タグの push の prepare が verify を流さず、PR の dry run が同じ経路を実走している
- worktree で `bun run setup` を流しても共有の `.git/hooks/*` が変わらず、メインの作業ツリーでは hook が入る
- README の Features が中心の 5 つから始まり、今の 17 の機能がすべて README に残る

## 対象外

- 案 5（pre-push で verify の一部だけを流す）。案 1〜3 で足りないときに持ち主に聞く
- 案 3 の修正。手元では再現せず原因を特定できなかった（前提）。A9 の計測で CI の部分ジョブの時間を残すところまで
- pre-commit（#348 の計測で 0.9 秒）
- macos / windows / git-2-34 のジョブ（verify を流していない）
- 手元の Node 26 で `hidden-runner.test.ts` の macOS の sandbox のテストが 1 件落ちる件（CI の macos ジョブは 24.15 だけ。今回の変更と無関係）

## 前提

- 受け入れテストは `server/evals/acceptance/run.ts` 1 ファイルで 148 件を順に走らせる。node --test は既定でファイルごとに別プロセス（https://nodejs.org/download/release/v24.15.0/docs/api/test.html#test-runner-execution-model）
- `createDriver`（`server/evals/acceptance/driver.ts:99-174`）はケースごとに `process.env` の HOME / USERPROFILE / PATH / TMPDIR / TMP / TEMP を書き換え、LEAKY（`:86-94`）を消し、`done()`（`:1597-1606`）で戻す。inject ごとに `CLAUDE_CODE_ENTRYPOINT` を切り替える（`:226-234`）。`respond` などを同じプロセスで呼び、env を読む。プロセス全体の状態に `server/src/extract.ts:79` の `shownTo`、`server/src/db-write.ts:28` の `ddl` がある → 同じプロセス内の並行は不可
- ケースごとの一時フォルダ・git リポジトリ・偽の gh と状態ファイル・DB は `dir` の下。`once.ts:22` も呼び出し時の tmpdir を使う。`given.case` の参照（98 か所）は自分の driver で手順を再生し、解決には全ケースの byId が要る（`run.ts:11`、`:22`）
- 例外: LEAKY に `CLAUDE_ENV_FILE` が無く、SessionStart で `server/src/capture.ts:553` がそのパスへ追記する。親で変数が立っていると、全ケースが同じ外のファイルへ書く（Codex がコードで確認）
- sql:reach は unit テストの V8 coverage だけを数える（`scripts/check-sql-reach.mjs:38-41`）。受け入れテストは含まない
- verify: `check && bundle && sql:reach && sql:live && hooks:live && codex-trust:live && acceptance`（`package.json:20`）
- check-pairs は check.yml と release.yml に `run: bun run verify` と、その前の同じジョブの Install lychee を要求する（`scripts/check-pairs.mjs:505-534`）。check-tarball も lychee を起動する（`scripts/check-tarball.mjs:80`）
- main の ruleset の必須 status check は `check (24.15)`、`check (26)`、`windows`、`verification-section`（`gh api repos/iroha924/sphica/rulesets/23916470`、2026-10-16）。needs の失敗・skip は後続へ伝わり、必須 check は skipped も通す（https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds 、https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-status-checks-before-merging）
- check.yml の verify の外の検査: 版の検査（`:56`、BASE）、コミット文（`:65`、RANGE）、fetch-depth: 0、TEST_ORDER（`:93`、Node 26 で unit の順をランダムに）、tarball の検査（`:98`）
- release のゲートは、タグのコミットで main が祖先であること（`scripts/lib/release-gate.mjs:32`）と、同じ head の PR の `check`、`pr-body`、`release` の最新 run の成功を要求する（`:8`、`:53-66`）。release.yml の pull_request の paths に `plugin/package.json` があり、リリースの PR は必ず dry run を走らせる
- setup-bun の `no-cache` は Bun の実行ファイルのキャッシュだけを無効にする（https://github.com/oven-sh/setup-bun/blob/0c5077e51419868618aeaa5fe8019c62421857d6/action.yml#L35）。prepare は付けているが check は付けていない
- `.agents/skills/plugin-release/SKILL.md:109` は prepare が verify の後に pack すると書いている（`.claude/skills/plugin-release` はここへの symlink）
- server/package.json と server/src/ はパッケージの入力（`scripts/lib/release-scope.mjs:8-18`）。ルートの package.json、check.yml、release.yml、server/evals、server/test、scripts/（licenses 以外）、README は入力ではない
- lefthook 2.1.14 の postinstall は、`CI` が立っていなければ `INIT_CWD` で `lefthook install` を流す。bun 1.4.0 は lefthook を信頼済みとして扱う（`bun pm untrusted` が 0 件）。server の依存で install 時のスクリプトを持つのは lefthook だけ（2026-10-16 に走査）。`--ignore-scripts` は信頼済みの依存のスクリプトも止める（https://bun.sh/docs/pm/cli/install#lifecycle-script-management）
- 実測（2026-10-16、捨てるリポジトリ）: worktree で `bun install` を流すと、共有の `.git/hooks/pre-commit` が worktree の `node_modules/lefthook-darwin-arm64/bin/lefthook` を指すように書き換わった。`--ignore-scripts` では hook が作られなかった
- 実測（2026-10-16、この Mac 12 コア）: unit テスト 1300 件の壁時計は Node 24.15.0 で coverage あり 109 秒 / なし 90 秒、26.10.0 で 95 秒 / 91 秒。CI の 1.6 倍は再現しない
- 公開リポジトリの ubuntu-latest は 4 vCPU（https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories）
- 未検証: シャードの数と並行数ごとの時間（S1 で測る）、prepare が 1〜2 分になる見込み、no-cache の追加で check の時間がどれだけ増えるか

## 方針

### 受け入れテスト（案 1）

- `run.ts` の中身（arrange と 1 件の実行）を `server/evals/acceptance/cases-run.ts` に移す。export: `shardOf(file)`（`shard-<k>.ts` のファイル名から k を返す。形が違えば throw）、`shardFiles()`（ディレクトリの `shard-*.ts` を数え、k が 1..N で欠けなく並ぶことを確かめて N を返す）、`assign(ids, k, n)`（ID の並び順の index が `% n === k - 1` のもの）、`registerCases(pick)`（全ケースで byId を作ってから、`pick` と `SPHICA_ACCEPTANCE_LAYER` で絞って `test()` を登録）
- `run.ts` は全件を登録する（server/package.json の `acceptance` はそのまま動く）。`shard-<k>.ts` は 1 行で自分の番号の分を登録する
- ルートの package.json の `acceptance` を、シャードのファイル全部を `node --test --test-timeout=60000` に渡す形にする。N と `--test-concurrency` は手元と CI で測って決め、選んだ値と測った時間を PR 本文に書く
- `server/test/acceptance-cases.test.ts` に「全シャードの割り当ての和が全ケース ID とちょうど一致し重複がない（layer で絞っても同じ）」「形の違うファイル名と番号の欠けで throw」を足す
- driver.ts の LEAKY に `CLAUDE_ENV_FILE` を足す

### CI の分割（案 2）

- check.yml の `check` ジョブを、matrix `node × part`（part: `static` / `unit` / `acceptance`、fail-fast: false）の部分ジョブにする。部分ジョブの名前は必須 check と重ならないものにする
  - static: 版の検査（BASE）、コミット文（RANGE）、fetch-depth: 0、Install lychee、setup、`bun run check && bun run bundle && bun run sql:live && bun run hooks:live && bun run codex-trust:live`、tarball の検査
  - unit: setup、`bun run sql:reach`（Node 26 では TEST_ORDER）
  - acceptance: setup、`bun run acceptance`
  - 全部分の setup-bun に `no-cache: true`
- 集約: `check`（matrix node、名前は今と同じ `check (<node>)`）は `needs` で部分ジョブを待ち、`if: always()`。needs を JSON で env に渡し、`scripts/check-parts.mjs`（仮）が全部の result が success のときだけ 0 で終わる。判定は `scripts/lib/` に置き、failure / cancelled / skipped / 欠けで失敗することを server/test のテストで確かめる
- check-pairs: verify の判定を `scripts/lib/` に切り出してテストする。見るもの: 各 node で、部分の matrix が選ぶ run の行の `&&` の和が verify の並びと過不足なく一致する / Install lychee が static の部分と release の prepare にある / check.yml と release.yml の setup-bun がすべて `no-cache: true`。解釈できない記法は失敗にする。部分・コマンドの削除と lychee の欠落で落ちることをテストする

### release の prepare（案 4'）

- prepare から `bun run verify` を、pull_request でも push でも外し、`bun run bundle` に置き換える。順序: setup（キャッシュなし）→ bundle → `git diff --exit-code HEAD` → npm pack → check-tarball → SBOM の照合。Install lychee は残す
- release.yml の冒頭コメントと該当のステップのコメントに「全検査は同じ head の PR の check の成功をゲートが要求する」を書く
- `.agents/skills/plugin-release/SKILL.md` の prepare の説明を合わせる

### setup と hook

- ルートの package.json の `setup` を `bun install --cwd server --frozen-lockfile --ignore-scripts && node scripts/install-hooks.mjs` にする
- `scripts/install-hooks.mjs`: `CI` が立っていれば何もしない。`git rev-parse --path-format=absolute --git-dir` と `--git-common-dir` が違えば（worktree）入れず、1 行で理由を出す。そうでなければ `process.execPath` で `server/node_modules/lefthook/bin/index.js install` を、cwd をリポジトリのルートにして起動する。git の判定と install の失敗は終了コード 1
- テスト（server/test、捨てるリポジトリと worktree、偽の lefthook）: main で hook が入る / CI では入らない / worktree では既存の hook が変わらず、無ければ作られない / install の失敗を返す

### README（#347）

- Features の先頭に中心の 5 つ（Automatic recording、Records with their sources、Shown when it matters、Find what you asked before、Forget what should not have been kept）、続けて今の末尾の 2 行（Records are never rewritten…）、その下に `### More features` と残り 12 を今の順で。README.ja.md も同じ並びで、見出しは `### その他の機能`

## 採った案と棄却した案

- 採用: ファイルを分けてプロセスで並行。棄却: 1 ファイル内の test の concurrency（env とプロセス全体の状態を共有する）
- 採用: シャード番号をファイル名から導き、全 ID の割り当てをテストする。棄却: 番号の連番確認だけ（番号の重複を防げない）
- 採用: server/package.json を変えず run.ts を全件の入口に残す。棄却: server の acceptance を書き換える（リリースが要る）
- 採用: 必須の check 名を `if: always()` の集約ジョブで残す。棄却: ruleset の必須 check を部分のジョブ名に変える（設定の変更が要る）、needs だけの集約（skip が必須 check を通す）
- 採用: 案 4'（prepare から verify を両イベントで外す）。棄却: 案 4''（verify を release.yml の別ジョブに残す。PR の重複と待ちが残る）、不採用（ゲートが同じ head の check を要求し、4' は dry run で同じ経路を実走するので理由が残らない）
- 採用: check の部分ジョブにも setup-bun の no-cache。棄却: 「lockfile のハッシュがあるのでキャッシュの有無は無関係」という根拠（no-cache は Bun の実行ファイルのキャッシュで、lockfile では検証できない）
- 採用: setup で `--ignore-scripts` と明示の install-hooks。棄却: server/package.json の trustedDependencies（リリースが要る）、worktree で CI=1 を立てる（lefthook の内部に頼る）、setup に `lefthook install` を足すだけ（worktree でも書き換える）
- 採用: 案 3 は原因未特定で修正不採用。棄却: coverage を原因と決めて手を入れる（手元で再現しない）

## 手順

- S1: driver の `CLAUDE_ENV_FILE`、cases-run.ts とシャード、ルートの acceptance、割り当てのテスト、N と並行数の計測
- S2: CI の部分ジョブと集約、集約の判定スクリプトとテスト
- S3: check-pairs の verify・lychee・no-cache の判定と、そのテスト
- S4: release.yml の prepare（案 4'）と plugin-release の Skill
- S5: setup と install-hooks とそのテスト
- S6: README.md と README.ja.md の並べ替え

## 完了条件

- A1: `caffeinate -i bun run verify` → 0 で終わり、acceptance の出力が pass 148 / fail 0
- A2: `CLAUDE_ENV_FILE=<空の一時ファイル> bun run acceptance` → 0 で終わり、そのファイルが空のまま
- A3: `cd server && node --import ./test/isolate-home.ts --test test/acceptance-cases.test.ts test/install-hooks.test.ts test/check-parts.test.ts test/verify-pairs.test.ts` → 0 で終わり、fail 0（割り当て、install-hooks、集約の判定、check-pairs の判定のテスト）
- A4: `bun run pairs` → 0。`test/verify-pairs.test.ts` に、部分の 1 つ・verify の 1 コマンド・Install lychee・no-cache を消した写しでそれぞれ失敗するケースがあり pass
- A5: `gh pr checks <PR>` → 部分ジョブ 6 つと `check (24.15)` `check (26)` が pass。`gh run view <run> --json jobs` で、最も遅い部分ジョブの所要が 11.6 分より短い
- A6: `gh run view <release の dry run> --json jobs` → `dry run: prepare` が success で、ステップに verify が無く、bundle・tarball の検査・SBOM の照合がある
- A7: `cd server && node --import ./test/isolate-home.ts --test test/install-hooks.test.ts` → worktree の setup の前後で共有の hook のハッシュが同じ、というケースが pass
- A8: `for f in README.md README.ja.md; do awk '/^## (Features|できること)/{p=1;next} /^## /{p=0} p' $f | grep -c '^- \*\*'; done` → 17 と 17。各ファイルの最初の 5 つの太字が持ち主の決めた 5 つ
- A9: 実装の後に手元（`caffeinate -i` で verify の部分ごと）と CI（PR の check の各ジョブとステップ）を測り直し、#348 のコメントは文面を持ち主が承認してから投稿する。`gh pr view <PR> --json body` と `gh issue view 348 --comments` → 前後の CI の各ジョブとステップの時間と、手元の verify の部分ごとの時間がある

## リスク

- シャードにしてから落ちるケース（前のケースの残りに頼っていた）→ 原因を直す。skip しない
- 並行の CPU の取り合いで 1 件が 60 秒を超える、または手元の Mac で時間が伸びる → 並行数を下げる
- 部分ジョブの setup の分だけ CI の総ランナー時間が増える → 公開リポジトリで無料。壁時計だけを目的にする
- 案 4' の後、24.21 で verify が流れないことで見逃す不具合 → check の 24.15 と 26、prepare の check-tarball（24.21 で tarball を起動し DB を作る）で受ける
- 案 1〜3 で手元の verify が十分に縮まない → 案 5 を選択肢つきで持ち主に聞く

## 未解決

なし

## 変更履歴
