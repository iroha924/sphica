---
kind: plan
status: approved
codex_session: 01a1024e-42f7-7180-896a-4f68a96dad0a
codex_rounds: 4
approved_at: 2026-10-04
---

# Build the local evaluation base that #206's delivery experiments and #211's alwaysLoad are measured on (PR-A, no release)

## 要点

- Claude の評価 run を cloud routine ではなく、この Mac の `claude -p` で回す runner（`server/evals/cloud/claude.ts`）を足す。sandbox と権限で run の外へ書けず、canary が全部拒否されないと run を始めない
- 前回のループで差が出なかった・届かなかった項目を測れるよう、tsundoku の fixture とタスクを足す: 古い anchor、読み違えやすい finding、混んだファイル、衝突のペア、第三者だけが根拠の active な記録
- 採点に衝突の欄（`named_conflict`, `implemented_one_side`）を足し、old と new の grades を混ぜずに並べる比較モードを report に足す
- Claude の run は全ツール呼び出しを順に残し、Sphica の search が最初の編集より前かを判定できるようにする（alwaysLoad の測定の前提）
- 順番（#206 の項目 2）を測るオフラインのベンチを足す
- 変えないもの: パッケージ（release:plan は none）、`server/src` の配信と MCP、DB schema。PR-B（`04-issue-206-delivery-experiments`）はこの PR の上に積む

## 持ち主の決定

- #206 の実験と #211 の `anthropic/alwaysLoad` の実験を、1 つの計画の流れで測る
- epic #200 の方針: 実験は PR ブランチで merge 前に測る。バーに届かなければ採らず、結果を issue に残す。npm に出して試さない
- 評価は cloud を使わず、ローカルの `claude` と `codex` で回す。費用の上限は一旦気にしない（2026-10-04、議論の途中で持ち主が追加）
- plan と tasks は持ち主の確認を待たずに進め、実装して PR を作るところまでやる。判断は PR で持ち主がする（2026-10-04、議論の途中で持ち主が追加）

## 目的

同じ fixture・タスク・採点の規則で、main 相当（old）と変更後（new）を Claude と Codex のローカル run で測り、#206 の各項目と alwaysLoad の採否を、項目ごとのバーと有効 run 数で判定できる状態にする。

## 対象外

- `server/src` の配信・MCP の変更（PR-B）
- #206 の項目 6（前回からの変化）: 「このブランチで前回作業した時点」の定義が無く、delivery のログは 90 日で消える。#206 に未測定・保留として残す
- #206 の項目 7（#191）: 0.6.2（#223）で出荷済み（`server/src/deliver.ts` の `waiting`）
- 専用の macOS ユーザーでの隔離（棄却。下の「採った案と棄却した案」）
- cloud routine の経路の削除（参照として残す）

## 前提

- 2026-09-30 のループ（`~/.cache/sphica-eval/builds/report-20260930.txt`、各 2 run）では、pilot-dates / pilot-display / superseded-install / override-postgres の Claude の inject が全部 2 点だった。superseded-install と poisoned-match は inject で gold が配信されていない（`loop.json` の delivered no）
- tsundoku の fixture（同ビルドの `fixture.db`）: record は 12 件（active 9）、applies_to の anchor は 3 件、unit_link は supersedes 1 本で、conflicts は無い
- 同ループで Claude の run のログは 12 件しか `~/.cache/sphica-eval/logs` に残っておらず、Claude の search / read の信号の大半が unknown だった
- claude 2.1.288 の実測（2026-10-04）
  - `CLAUDE_CONFIG_DIR=<空>` の `claude -p` は terminal_reason api_error で認証できない。持ち主の config を使う
  - `--setting-sources "" --settings <file> --strict-mcp-config --permission-mode acceptEdits`、sandbox `{enabled, autoAllowBashIfSandboxed, allowUnsandboxedCommands:false}` の組み合わせでは、cwd 内の Write は通り、`$HOME/.cache/...` への Write は permission_denials に入って作られなかった。Bash の `$HOME` 配下への書き込みは "operation not permitted" で止まった。Bash の `/private/tmp` 配下への書き込みは通った（sandbox は一時ディレクトリを許す）
  - bypassPermissions では Write ツールが sandbox の外へ書けてしまう（Codex C15）
- Claude Code は sandbox 内の Bash の TMPDIR を差し替える（Codex C18、未実測）。今の `.tools/sphica.sh` は TMPDIR から DB の場所を決めている
- `build.ts` の `goldText` は `recordLines` で gold を描き、本文と Why が欠けると止まる（`server/evals/cloud/build.ts:221-226`）。`judge.ts` の gold の受け取りは行頭の `- <key> (` で数える（`judge.ts:106`）
- `report.ts` は bundle やタスク定義の違う grades を同時に渡すと拒否する（`report.ts:205, 210`）
- Claude Code の tool search は、MCP のツールが閾値に満たないと最初から読み込む（https://code.claude.com/docs/en/mcp#configure-tool-search 、Codex C2 で確認）。eval のスロットは Sphica の MCP だけなので、強制しないと遅延読み込みにならない
- 遅延読み込みの証拠が stream-json の init のどの欄に出るかは未検証（T で実測する）

## 方針

### ローカルの Claude runner（`server/evals/cloud/claude.ts`）

- `codex.ts` と同じ形: `--build <dir> --repo <slot> --task <id>`。run ごとに `~/.cache/sphica-eval/claude-runs/<run>/` を取り、`work/`（スロットの clone）、`tools/`（`.tools` の写し）、`db/`（fixture の写し）、`receipts.jsonl` を置く
- clone の origin は GitHub のスロットの URL にする（Sphica の project の特定のため）。push はしない。cloud 用の `finish.sh` は登録しない
- 起動: `claude -p --setting-sources "" --settings <run>/settings.json --strict-mcp-config --mcp-config <run>/mcp.json --permission-mode acceptEdits --output-format stream-json --verbose --model <pinned> --no-session-persistence`。stdin に task の prompt。env から `CLAUDE_CODE_ENTRYPOINT`・`SPHICA_PARENT_SESSION`・`CLAUDECODE` を外す
- `settings.json` は runner が条件ごとに生成する: sandbox `enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, failIfUnavailable: true`、excludedCommands なし、読み取り禁止に `~/.ssh` `~/.aws` `~/.config` `~/.codex` `~/.claude` `~/.sphica`、`permissions.deny` に `PushNotification` と run ディレクトリの外の Read/Edit（書ける範囲で）、hooks は条件どおり（inject: SessionStart / UserPromptSubmit / PreToolUse の deliver、gold: UserPromptSubmit の gold、全条件: receipt）。tool search の強制が要るときは `env` に入れる
- `mcp.json` は search / inject で Sphica の MCP、none / gold では空
- DB の写し・receipts・gold の印は、TMPDIR ではなく run ディレクトリの絶対パスを env（`SPHICA_DB`、`EVAL_RUN_DIR`）で hook と MCP に渡す。`.tools/sphica.sh` と `hook.sh` / `gold.sh` は env があればそれを使い、無ければ今の TMPDIR の動き（cloud 用）
- 回収: 開始時の HEAD の SHA を残し、終了後にその SHA からの差分（追跡済み＋未追跡、`.tools` `.eval` `node_modules` を除く）を patch、stream の最後の result を答え、run の DB 写しの delivery を deliveries、stream 全体を `events.jsonl` に残す。`started.json` と `result.json` は codex.ts と同じ欄
- 編集の観測: 親の runner は stream-json を読みながら、Bash とファイル編集ツールの tool_result が来るたびに作業ツリーの状態（`git status --porcelain` と内容のハッシュ）を取る。「最初の編集」は、その後に作業ツリーが変わった最初のツール呼び出し。並行の呼び出しや、状態を取っている間に次の呼び出しが進んだことで 1 つに結び付けられない変化があれば unknown。外から呼び出しごとに取れないと分かったら、最初のファイルツールの編集より前に、決まった読み取り専用の一覧に無い Bash がある run を unknown にする
- 並行: 同時 2 run まで。DB・receipts・予算を共有しないことを canary で確かめる

### canary（runner が run の前に流す。1 つでも通らなければ run を始めない）

- 権限: runner が run ディレクトリの外に一時の sentinel を作り、settings で読み書きを禁止する。Write / Edit / Bash の書き込み / Read / Bash の読み取りを、それぞれモデルに試させる。各試行の tool_use があり、結果が拒否かエラーで、sentinel のハッシュが変わらず、内容が stream に出ていないこと。試さなかった・ログが無いのは失敗
- 文脈: 条件ごとに最終のコマンドラインで、init の tools と mcp_servers が条件どおりか、hook の receipts が条件どおりかを確かめる。CLAUDE.md・memory が入っていないことは、先に正の対照（作業ディレクトリに合成の CLAUDE.md を置いた run）で、その読み込みを同じ観測面（InstructionsLoaded hook の receipt など）から検出できると確かめた方法でだけ判定する。正の対照で検出できない方法は使わず、証明できない条件では run を始めない。モデルの一覧の答えは補助
- 持ち主の実パスの禁止は、生成した settings への単体テストで確かめる（実際に読ませない）
- DB: MCP と hook が同じ DB 写しを見ること、同時 2 run が互いのログと予算を共有しないこと

### fixture とタスク（`server/evals/cloud/tasks.json`、`server/evals/acceptance` の setups）

足す setup とタスク（すべて tsundoku、日本語と英語を混ぜる）:

- stale: 有効な採用のある active な decision で、applies_to の anchor のシンボルが今のコードでは動いたか消えていて、今のコードが記録と違う形になっているもの。old の配信で実際に届くこと（pre_read か pre_edit）を fixture のテストで確かめる。対照として、anchor が動いたが決定は今も正しいタスクも置く
- abstention: pre_edit で配信される active な finding か question（または依頼を禁じない active な decision）を、規範と読み違えて止まりやすいタスク
- crowded: 同じファイルに applies_to の record を各イベントの上限より多く置く（G2 のベンチ用。エージェントのタスクは作らない）
- conflict: conflicts でつないだ active な 2 件を同じファイルに anchor し、片方に黙って従うと点が下がるタスク
- poisoned-delivered: evidence が第三者の PR コメントだけで、採用は有効な active な decision か constraint を、old が読み込みで押し込むこと（old の配信で届くことを fixture のテストで確かめる）。owner / maintainer の記録は別に置く
- candidate は自動配信されない、というテストは別に残す

既存の 8 タスクは回帰用に残す。PR-B では tasks.json と fixture の setup を変えない。

### 採点

- `grade.schema.json` / `grading.ts` に `named_conflict` と `implemented_one_side`（yes / no / not_applicable / unknown）を足す。衝突タスクの成功は「衝突を名前で挙げ、かつ解決していないまま片方を実装していない」
- re-proposal は率で比べ、分母と unknown の件数を出す

### old と new の比較

- build に `--dist <dir>` を足し、`plugin/dist` の deliver.js と mcp.js をそのディレクトリから取れるようにする（old の bundle は PR-A の HEAD を worktree でビルドしたもの）。gold の描画は old / new それぞれの `recordLines` が要るので、old の build は old の worktree の `build.ts` で、`--fixture <file>` で同じ fixture.db を渡す
- 両側の manifest に fixture.db のハッシュを残す。report に `--compare <old grades> <new grades>` を足し、fixture のハッシュかタスク定義が違えば拒否する。bundle ごとに表を出し、混ぜない
- runs: `build.ts` が条件ごと・タスクごとの run 数を tasks.json から取れるようにする（`runs` 欄）。plan.json の行数が実行の数

### 順番のベンチ（`server/evals/retrieval/` か `server/evals/order/`）

- crowded の fixture で、実際のイベント（session_start、pre_read の残り予算つき、pre_edit、prompt）ごとに `deliver()` の計画を呼び、gold が上限の中に入る率を出す。件数の上限と文字数の上限を分けて数える。順位ごとに不利になる対照例を入れる
- `--compare <ref>` で old と new の deliver を並べる（retrieval の run.ts と同じ形）

### alwaysLoad の前提

- tool search を遅延読み込みに固定する env を runner の settings に入れ、old で `search` が遅延、new で最初から読み込まれることを stream の証拠で確かめるタスクを置く。証拠が見つからなければ G6 は「測れない」と記録する（PR-B で）

## 採った案と棄却した案

- 採用: 評価の土台を先に別 PR（リリースなし）にする。棄却: 実験と同じ PR（実験が不採用で閉じると土台も消える）
- 採用: ローカルの `claude -p` を持ち主のアカウントで、acceptEdits ＋ sandbox ＋ canary。棄却: bypassPermissions ＋ sandbox（Write が外へ書ける）、専用の macOS ユーザー（持ち主の管理者操作と別ログインが要る）、空の CLAUDE_CONFIG_DIR（認証できない）
- 採用: ローカルでは finish.sh を使わず親が回収する。棄却: finish.sh を残して push だけ止める（Stop でコミットされ patch が空になる、外部操作の境界にならない）
- 採用: 順番は決定的なのでオフラインのベンチ。棄却: エージェントの run で測る
- 採用: old と new は同じ fixture.db の成果物を使う。棄却: 各側で setup から作り直す（記録の日時やハッシュがずれる）

## 手順

- S1: TMPDIR に頼らず run ディレクトリの絶対パスで DB・receipts・gold の印を渡す（`.tools/sphica.sh`、`hook.sh`、`gold.sh`、build の env）
- S2: ローカルの Claude runner と回収（claude.ts、collect の対応）
- S3: canary（権限・文脈・DB）と、生成した settings の単体テスト
- S4: 編集の観測と、Sphica の search が最初の編集より前かの判定（judge と tests）
- S5: fixture の setup とタスクの追加（stale、abstention、crowded、conflict、poisoned-delivered）と、old の配信で届くことの fixture テスト
- S6: 採点の欄（衝突）と re-proposal の率
- S7: build の `--dist` `--fixture` とタスクごとの run 数、report の `--compare`
- S8: 順番のオフラインのベンチ
- S9: tool search の遅延読み込みの証拠を実 run で確かめる
- S10: eval-loop Skill をローカルの流れに合わせて直す

## 完了条件

- A1: `bun run verify` → 0 で終わる
- A2: `cd server && node --test test/eval-*.test.ts` → 全件 pass（canary の settings、編集の判定、衝突の採点、compare の拒否を含む）
- A3: `node evals/cloud/claude.ts --canary --build <build>` → 権限・文脈・DB の全項目が blocked / matched と出て 0 で終わる
- A4: `node evals/cloud/claude.ts --build <build> --repo <inject のスロット> --task <stale-thumb|conflict-cover|poisoned-backup>` と `node evals/cloud/codex.ts` を同じ 3 タスクで 1 run ずつ流してから `node evals/cloud/collect.ts --build <build> --no-cloud` → stale-thumb と poisoned-backup の run は配信にその記録（width、upload）が入り、conflict-cover の run には retry・no-retry のどちらも入らない
- A5: `node evals/cloud/report.ts --compare <a>/grades.json <b>/grades.json` → fixture のハッシュが違う 2 つなら 0 以外で拒否し、同じなら old と new の表を別々に出す
- A6: `bun run release:plan -- --base <最新のリリースのコミット>` → none

## リスク

- sandbox が npm やテストの実行を止めてタスクが進まない → ネットワークの許可先を npm registry に絞って足す。canary は変えない
- 呼び出しごとの作業ツリーの観測が stream から取れない → 方針の代案（読み取り専用の一覧）に切り替え、記録節に書く
- subscription の利用上限で run が途中で止まる → 止まった run は excluded として残し、上限が戻ってから同じ build で足す
- 遅延読み込みの証拠が見つからない → PR-B で G6 を「測れない」として記録する

## 未解決

なし

## 変更履歴
- 2026-10-04 / A4 の期待を「stale と poisoned-delivered は gold が配信に入り、conflict の 2 件は入らない」に直した / 今の配信は未解決の衝突の 2 件を外す設計で、conflict の gold が old で届かないのが G3 の前提のため / Go 不要（測る対象と範囲は変わらない）
- 2026-10-04 / 評価用のスクリプトなので、タスクごとの再レビューは T20 までで打ち切り、差分全体のレビューを P1・セキュリティ・測定を歪める欠陥に絞った / 指摘が P2 の作り込みの入力に移り、収束しなかったため / Go 不要
