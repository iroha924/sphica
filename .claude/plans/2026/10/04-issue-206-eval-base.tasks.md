---
kind: tasks
plan: 04-issue-206-eval-base.plan.md
branch: feat/issue-206-eval-base
base: main
---

# Build the local evaluation base that #206's delivery experiments and #211's alwaysLoad are measured on (PR-A, no release) のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: ビルドと実行の土台

スロットの DB・receipts・gold の印を run ごとの絶対パスで渡し、old と new を同じ fixture で組み立て、Claude をローカルで安全に回せる。

- [x] T01: スロットの DB・receipts・gold の印を env の絶対パスで渡せるようにする
  - 種別: 変更
  - 計画: S1
  - 依存: なし
  - 変更: `server/evals/cloud/build.ts`, `server/evals/cloud/slot-scripts.ts`, `server/test/eval-build.test.ts`
  - 完了条件: `cd server && node --test test/eval-build.test.ts` → `EVAL_SPHICA_DB` / `EVAL_RUN_DIR` があればそのパス、無ければ今の TMPDIR のパスを使うテストが pass
  - コミット: `feat(evals): pass the slot database and receipts by absolute path (T01)`
  - 結果: `node --test test/eval-build.test.ts` → pass 4, fail 0。`npx tsc --noEmit` → エラーなし

- [x] T12: 今の main で build.ts が落ちる 2 か所を直す（fixture の付け替えが ingest の権限で拒否される、exec form の hooks.json から matcher が取れない）
  - 種別: 修正
  - 計画: S7
  - 依存: なし
  - 変更: `server/evals/cloud/build.ts`
  - red: `cd server && node evals/cloud/build.ts --project tsundoku --out <tmp>` → `rekey` で `not authorized`、直した後に `plugin/hooks/hooks.json has no PreToolUse delivery hook`
  - 完了条件: `cd server && node evals/cloud/build.ts --project tsundoku --out <tmp>` → `built 4 repositories`
  - コミット: `feat(evals): build from a given bundle and fixture with per-task run counts (T02, T12, T13)`
  - 結果: red 実測: main の worktree（c042ada2）で `node evals/cloud/build.ts --project tsundoku` → `Error: not authorized`（`rekey`）。owner の接続にした後 `plugin/hooks/hooks.json has no PreToolUse delivery hook`。両方直して `built 4 repositories`

- [x] T02: build に `--dist` `--fixture` とタスクごとの run 数を足し、manifest に fixture のハッシュを残す
  - 種別: 追加
  - 計画: S7
  - 依存: T12（今の main では build が最後まで通らない）
  - 変更: `server/evals/cloud/build.ts`, `server/evals/cloud/firing.ts`, `server/test/eval-build.test.ts`
  - 完了条件: `cd server && node --test test/eval-build.test.ts` → tasks.json の `runs` が plan.json の行数になるテストが pass。`node evals/cloud/build.ts --project tsundoku --dist <dir> --fixture <db> --out <tmp>` → 渡した dist の bundle と fixture がスロットに入り、manifest に fixture の sha256 がある
  - コミット: `feat(evals): build from a given bundle and fixture with per-task run counts (T02, T12, T13)`
  - 結果: `node --test test/eval-build.test.ts test/eval-grade.test.ts` → pass 50, fail 0。build を 2 回（素のビルドと、その fixture.db と印を付けた deliver.js を渡すビルド）→ 両 manifest の fixture が 8d3065c1… で一致、bundle の deliver.js のハッシュは違い、スロットの deliver.js の末尾に印がある

- [x] T13: gold の印が TMPDIR に戻る場合と、session start で消えることのテストを足す（T01 の Codex レビュー F1）
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `server/test/eval-build.test.ts`
  - 完了条件: `cd server && node --test test/eval-build.test.ts` → EVAL_RUN_DIR なしで gold が 1 度だけ返り、印が TMPDIR にあり、start の後にまた返るテストが pass
  - コミット: `feat(evals): build from a given bundle and fixture with per-task run counts (T02, T12, T13)`
  - 結果: `node --test test/eval-build.test.ts` → 新しいテストを含め pass

- [x] T03: ローカルの Claude runner と回収を足す
  - 種別: 追加
  - 計画: S2
  - 依存: T01（hook と MCP に run の DB の絶対パスを渡す）
  - 変更: `server/evals/cloud/claude.ts`, `server/evals/cloud/claude-run.ts`, `server/evals/cloud/judge.ts`, `server/evals/cloud/collect.ts`, `server/test/eval-claude.test.ts`
  - 完了条件: `cd server && node --test test/eval-claude.test.ts` → 条件ごとの settings / mcp.json の生成、開始 SHA からの patch（未追跡を含み `.tools` などを除く）、stream の最後の result の答え、collect が claude-runs を読むテストが pass
  - コミット: `feat(evals): run Claude locally in a sandboxed claude -p (T03, T14)`
  - 結果: `node --test test/eval-claude.test.ts test/eval-build.test.ts test/eval-grade.test.ts` → 全件 pass（eval-claude 8 件）。実 run 2 回（pilot-sort、inject、claude-opus-5-5）: exit 0、17 秒前後、answer.md・patch.diff・receipts・delivery のログがそろい、init に `mcp_servers: sphica connected`。1 回目は `mcp__sphica__search` が permission_denied だったので許可を足し、2 回目で search が 2 回通った

- [x] T14: run 数の検査と、matcher と rekey のテストを足す（T02 の Codex レビュー F1, F2）
  - 種別: 追加
  - 計画: S7
  - 依存: なし
  - 変更: `server/evals/cloud/build-lib.ts`, `server/evals/cloud/build.ts`, `server/evals/cloud/firing.ts`, `server/test/eval-build.test.ts`
  - 完了条件: `cd server && node --test test/eval-build.test.ts` → 0・負・小数・文字列の run 数で止まり、exec form と command form の hooks から matcher が取れ、実際の SQLite で project が付け替わるテストが pass
  - コミット: `feat(evals): run Claude locally in a sandboxed claude -p (T03, T14)`
  - 結果: `node --test test/eval-build.test.ts` → pass 9, fail 0

- [x] T04: canary（権限・文脈・DB）と生成した settings の単体テストを足す
  - 種別: 追加
  - 計画: S3
  - 依存: T03（runner の settings と起動の形が要る）
  - 変更: `server/evals/cloud/claude.ts`, `server/evals/cloud/claude-run.ts`, `server/evals/cloud/canary.ts`, `server/evals/cloud/canary-check.ts`, `server/evals/cloud/slot-scripts.ts`, `server/test/eval-claude.test.ts`
  - 完了条件: `cd server && node --test test/eval-claude.test.ts` → 生成した settings に持ち主の実パスの読み取り禁止・allowUnsandboxedCommands=false・failIfUnavailable=true があり、canary の判定が「未試行」「ログ欠落」「sentinel の変化」を失敗にするテストが pass。`node evals/cloud/canary.ts --build <build>` → 全項目 ✓ で 0
  - コミット: `feat(evals): refuse local Claude runs until the canary passes (T04)`
  - 結果: `node --test test/eval-claude.test.ts test/eval-build.test.ts test/eval-grade.test.ts` → pass 64, fail 0。`node evals/cloud/canary.ts --build <build-c1>` → 30 項目全部 ✓、`canary passed`、exit 0。fence の 5 つの試みは Write・Edit・Read が権限（"denied by your permission settings"）、Bash の書き込みと cat が sandbox（"Operation not permitted"）で止まった。canary の無いビルドで claude.ts は拒否する

- [x] T15: T03 の Codex レビューの 5 件を直す（環境変数の許可リスト、資格情報ファイルの完全一致の規則、`--no-cloud`、ignore されたファイルの patch、形の違う stream）
  - 種別: 修正
  - 計画: S2
  - 依存: T03（直す対象）
  - 変更: `server/evals/cloud/claude-run.ts`, `server/evals/cloud/judge.ts`, `server/evals/cloud/collect.ts`, `server/test/eval-claude.test.ts`
  - red: `cd <32c9dc33 の worktree>/server && node red.ts` → GH_TOKEN が残る、`.npmrc` の完全一致の規則が無い、ignore された docs/i.md が patch に無い、`null` の行で foundInClaudeStream が例外
  - 完了条件: `cd server && node --test test/eval-claude.test.ts` → 許可リスト、`.npmrc` の規則、ignore されたファイル、壊れた stream、`--no-cloud` のテストが pass
  - コミット: `fix(evals): fence the local runner's environment and harden its readers (T15, T16)`
  - 結果: red 実測（32c9dc33 の worktree で red.ts）: `F1 GH_TOKEN kept: true`、`F2 exact .npmrc rule: false`、`F4 ignored file in patch: false`、`F5 crash: true`。直した後 `node --test test/eval-claude.test.ts test/eval-build.test.ts test/eval-grade.test.ts` → pass 70, fail 0。canary を流し直して `canary passed`（環境変数を絞っても認証が通る）

- [x] T17: T04 の Codex レビューの 5 件を直す（壊れた receipt と切れた stream、look-alike のパス、MCP と hook の同じ DB、隣のディレクトリ、準備の失敗の終了コード）
  - 種別: 修正
  - 計画: S3
  - 依存: T04（直す対象）
  - 変更: `server/evals/cloud/canary-check.ts`, `server/evals/cloud/canary.ts`, `server/evals/cloud/claude.ts`, `server/test/eval-claude.test.ts`
  - red: `cd <79076e01 の worktree に新しいテストを置いて>/server && node --test test/eval-claude.test.ts` → look-alike のパスへの試行で fence が通る（actual [] / expected 'not attempted' 2 件）、clone に失敗しても claude.ts が 0 で終わる（actual 0 / expected 1）
  - 完了条件: `cd server && node --test test/eval-claude.test.ts` → 壊れた receipt・切れた stream・look-alike のパス・隣のディレクトリ・準備の失敗のテストが pass。`node evals/cloud/canary.ts --build <build>` → 全項目 ✓
  - コミット: `fix(evals): make the canary prove each check from complete evidence (T17)`
  - 結果: red は上のとおり 2 件落ちた（壊れた receipt と隣のディレクトリは、直す前は判定に入っていなかったので新しい検査として足した）。直した後 `node --test test/eval-claude.test.ts test/eval-grade.test.ts test/eval-build.test.ts` → pass 73, fail 0。`node evals/cloud/canary.ts --build <build-c2>` → `canary passed`（MCP の status の件数が run の DB 写しと一致）

## P2: 測る信号と評価セット

最初の編集の前に検索したか、衝突の扱い、old が実際に届ける記録を測れる。

- [x] T05: 呼び出しごとの作業ツリーの観測と、Sphica の search が最初の編集より前かの判定を足す
  - 種別: 追加
  - 計画: S4
  - 依存: T03（stream-json の回収が要る）
  - 変更: `server/evals/cloud/claude-run.ts`, `server/evals/cloud/judge.ts`, `server/evals/cloud/collect.ts`, `server/test/eval-claude.test.ts`
  - 完了条件: `cd server && node --test test/eval-claude.test.ts` → Bash 編集 → search → Write は no、search → Bash 編集は yes、Write だけ・Bash だけ・並行の呼び出し（unknown）のテストが pass
  - コミット: `feat(evals): tell whether a run searched Sphica before its first edit (T05)`
  - 結果: `node --test test/eval-claude.test.ts` → pass 13, fail 0（watcher の印、並行の呼び出しの in_flight、node_modules を編集に数えない、判定の yes / no / no_edit / unknown）。実 run（pilot-sort、inject）で edits.jsonl に 8 個の印、6 個目で changed、判定 yes

- [x] T16: T05 の Codex レビューの 4 件を直す（まとめて届いた stdout の遅れ、印の欠け、壊れた印、Bash からのコミット）
  - 種別: 修正
  - 計画: S4
  - 依存: T05（直す対象）
  - 変更: `server/evals/cloud/claude-run.ts`, `server/evals/cloud/judge.ts`, `server/test/eval-claude.test.ts`
  - red: `cd <32c9dc33 の worktree>/server && node red.ts` → 印が 1 つ欠けても `yes`、壊れた印の行で例外、Bash からのコミットで状態が変わらない
  - 完了条件: `cd server && node --test test/eval-claude.test.ts` → 遅れた印・欠けた印・壊れた印は unknown、Bash からのコミットは changed のテストが pass
  - コミット: `fix(evals): fence the local runner's environment and harden its readers (T15, T16)`
  - 結果: red 実測（同じ red.ts）: `T05-F2 missing mark: yes`、`T05-F3 broken line: threw`、`T05-F4 commit seen: false`。まとめて届いた stdout（F1）はレビュアーの再現を根拠にし、自分では再現していない。直した後 `node --test test/eval-claude.test.ts` → pass 70, fail 0（3 ファイル合計）

- [x] T06: stale・abstention・crowded・conflict・poisoned-delivered の setup とタスクを足す
  - 種別: 追加
  - 計画: S5
  - 依存: T02（タスクごとの run 数の欄が要る）
  - 変更: `server/evals/cloud/tasks.json`, `server/evals/acceptance/cases.json`, `server/evals/acceptance/world.json`, `server/evals/cloud/build.ts`, `server/evals/cloud/build-lib.ts`, `server/test/eval-fixture.test.ts`
  - 完了条件: `cd server && node --test test/eval-fixture.test.ts` → fixture を作り、今の deliver で stale・conflict 以外の対象タスクの gold が pre_read か pre_edit で届き、conflict の 2 件は今は届かず、candidate は届かないテストが pass
  - コミット: `test(evals): add delivered stale, abstention, conflict, and poisoned fixtures (T06)`
  - 結果: `node --test --test-timeout=120000 test/eval-fixture.test.ts` → pass 2, fail 0（thumb の 2 件・shelf の 2 件・backup の 1 件が届き、cover の衝突の 2 件と candidate は届かず、7 件とも active、conflicts のリンクは未解決で 1 本、upload の evidence は CONTRIBUTOR だけ）。`node --test evals/acceptance/run.ts` → pass 105, fail 0。`node evals/cloud/build.ts --project tsundoku` → ビルドでき、スロットの src/thumb.ts は COVER_WIDTH = 320、plan.json は対象タスクの inject 5・gold 3

- [x] T07: 採点に衝突の欄と re-proposal の率を足す
  - 種別: 追加
  - 計画: S6
  - 依存: なし
  - 変更: `server/evals/cloud/grading.ts`, `server/evals/cloud/schema-check.ts`, `server/evals/cloud/grade.schema.json`, `server/evals/cloud/grade.ts`, `server/evals/cloud/report.ts`, `server/evals/cloud/tasks.json`, `server/test/eval-grade.test.ts`
  - 完了条件: `cd server && node --test test/eval-grade.test.ts && node evals/cloud/schema-check.ts` → `named_conflict` と `implemented_one_side` の検査と、re-proposal を分母と unknown つきの率で出すテストが pass し、schema が zod と一致
  - コミット: `feat(evals): grade conflicts and report re-proposals as a rate (T07)`
  - 結果: `node evals/cloud/schema-check.ts --write` で grade.schema.json を作り直し、`node --test test/eval-grade.test.ts` → pass 45, fail 0（衝突の欄は「Conflict のあるタスクでだけ not_applicable でない」、切れた patch の implemented_one_side は unknown、report に衝突の成功率と re-proposal の率）

- [x] T08: report に old と new を並べる `--compare` を足す
  - 種別: 追加
  - 計画: S7
  - 依存: T02（manifest の fixture のハッシュが要る）
  - 変更: `server/evals/cloud/report.ts`, `server/test/eval-grade.test.ts`
  - 完了条件: `cd server && node --test test/eval-grade.test.ts` → fixture のハッシュかタスク定義が違えば拒否し、同じなら bundle ごとに表を分けて出すテストが pass
  - コミット: `feat(evals): compare an old and a new build without mixing their bundles (T08)`
  - 結果: `node --test test/eval-grade.test.ts` → pass 46, fail 0（fixture 違い・fixture 無し・タスク定義違い・同じ bundle を拒否し、old と new の表を分けて出し、タスク × モデル × 条件ごとに有効 run・平均点・re-proposal・衝突・検索の率を並べる）

- [x] T09: 順番のオフラインのベンチを足す
  - 種別: 追加
  - 計画: S8
  - 依存: T06（crowded の fixture が要る）
  - 変更: `server/evals/order/bench.ts`, `server/evals/order/run.ts`, `server/evals/acceptance/driver.ts`, `server/evals/acceptance/cases.json`, `server/evals/acceptance/world.json`, `server/test/eval-order.test.ts`
  - 完了条件: `cd server && node --test test/eval-order.test.ts` → イベントごとの gold-in-delivery の率を件数と文字数の上限を分けて出し、`--compare <ref>` で 2 つの deliver を並べるテストが pass
  - コミット: `feat(evals): measure which records land inside the delivery limits (T09)`
  - 結果: `node --test --test-timeout=120000 test/eval-order.test.ts` → pass 3, fail 0。`node evals/order/run.ts` → 今の順番では pre_read・pre_edit とも 5 件で、loan-days（一番古い constraint）と no-late-fees（dont）は 0 / 2、重みのある記録 3 / 8、軽い記録 7 / 10。`node --test evals/acceptance/run.ts` → pass 105, fail 0

- [x] T18: T06 と T08 の Codex レビューの 5 件を直す（moved-webp の anchor を実際に動かす、poisoned-backup の hidden test を挙動で見る、比較の bundle を成果物のハッシュで見て無い bundle を拒否、衝突と検索の率のテスト）
  - 種別: 修正
  - 計画: S5, S7
  - 依存: T06（直す対象）, T08（直す対象）
  - 変更: `server/evals/cloud/tasks.json`, `server/evals/cloud/report.ts`, `server/test/eval-fixture.test.ts`, `server/test/eval-grade.test.ts`
  - red: `cd <3d169f5c の worktree に新しいテストを置いて>/server && node --test test/eval-grade.test.ts test/eval-fixture.test.ts` → webp の anchor が `located`（expected `moved`）、別コミットで同じ成果物の比較を通す（expected /same bundle/）
  - 完了条件: `cd server && node --test test/eval-grade.test.ts test/eval-fixture.test.ts` → 全件 pass
  - コミット: `fix(evals): move the control anchor, check the backup by behavior, and compare by artifacts (T18)`
  - 結果: red は上のとおり 2 件落ちた。直した後 `node --test test/eval-grade.test.ts test/eval-claude.test.ts test/eval-build.test.ts` → pass 74, fail 0、`node --test --test-timeout=120000 test/eval-fixture.test.ts` → pass 2。poisoned-backup の hidden test を collect と同じ sandbox-exec と permission model で 3 つの実装に当て、ローカルにコピーするだけの実装（URL をコメントに書いたもの）は pass 2、送信する実装は fail 1、未実装は fail 2

- [x] T19: T15・T16 と T17 の Codex レビューの 6 件を直す（status の件数を数で比べる、receipt の形、壊れたイベントの形、late の型、late の印での no_edit、Bash のコミットのテスト）
  - 種別: 修正
  - 計画: S3, S4
  - 依存: T16（直す対象）, T17（直す対象）
  - 変更: `server/evals/cloud/canary.ts`, `server/evals/cloud/canary-check.ts`, `server/evals/cloud/judge.ts`, `server/test/eval-claude.test.ts`
  - red: `cd <49c813a7 の worktree>/server && node red.ts` → 9 件の写しで「19 active records」が一致扱い、1 件で不一致扱い、`{}` の receipt を受け入れる、文字列の content で `no`、late が文字列で `yes`、late の印だけで `no_edit`
  - 完了条件: `cd server && node --test test/eval-claude.test.ts` → 6 件それぞれの回帰テストが pass
  - コミット: `fix(evals): read canary counts, receipts, events, and marks only in their exact shapes (T19)`
  - 結果: red 実測は上の 6 項目すべて（`includes 9 in 19: true`、`1 active record matched: false`、`{} receipt accepted: true`、`content string proves: no`、`late as string: yes`、`late unchanged: no_edit`）。直した後 `node --test test/eval-claude.test.ts test/eval-grade.test.ts test/eval-build.test.ts` → pass 78, fail 0

## P3: 実機の確認と手順

遅延読み込みの証拠と、ローカルの流れの手順がそろう。

- [x] T10: tool search の遅延読み込みの証拠を実 run で確かめ、runner の settings に固定する
  - 種別: 追加
  - 計画: S9
  - 依存: T04（canary を通った runner で実 run する）
  - 変更: `server/evals/cloud/claude-run.ts`, `server/evals/cloud/judge.ts`, `server/evals/cloud/collect.ts`, `server/test/eval-claude.test.ts`
  - 完了条件: `cd server && node --test test/eval-claude.test.ts` → 実 run で取った init の形から、search が遅延か最初から読み込まれたかを判定するテストが pass。証拠の欄が無ければ判定は unknown を返し、記録節に「G6 は測れない」と書く
  - コミット: `feat(evals): pin deferred tool loading and detect it from the stream (T10)`
  - 結果: init の tools には遅延でも mcp__sphica__search が載るので、init では見分けられない。代わりに「最初の search より前に ToolSearch の結果が search を渡したか」で判定する（deferred / loaded / unknown）。正の対照: 同じスロットで `ENABLE_TOOL_SEARCH=false` → `loaded`、`true` → `deferred`。これまでの実 run 3 回はすべて `deferred`。`node --test test/eval-claude.test.ts test/eval-grade.test.ts test/eval-build.test.ts` → pass 79, fail 0

- [x] T11: eval-loop Skill をローカルの流れに合わせて直す
  - 種別: 変更
  - 計画: S10
  - 依存: T04（canary の手順）, T08（compare の手順）
  - 変更: `.claude/skills/eval-loop/SKILL.md`
  - 完了条件: `bun run verify:ai` → 0 で終わる
  - コミット: `docs(eval-loop): run Claude locally behind the canary and compare old and new builds (T11)`
  - 結果: `bun run verify:ai` → 0 で終わり `AI config: ... 3 development Skills ...`

- [x] T20: T09・T18・T19 の Codex レビューの直しと、verify の knip を通す（比べる ref の driver の確認、backup の hidden test の書き込み経路と内容、壊れたイベントと結果の形、印の順番、新しい入口の登録）
  - 種別: 修正
  - 計画: S3, S4, S5, S8
  - 依存: T09（直す対象）, T18（直す対象）, T19（直す対象）
  - 変更: `server/evals/cloud/judge.ts`, `server/evals/cloud/tasks.json`, `server/evals/order/run.ts`, `server/evals/cloud/canary-check.ts`, `server/evals/cloud/claude-run.ts`, `server/evals/cloud/report.ts`, `server/evals/order/bench.ts`, `knip.json`, `server/test/eval-claude.test.ts`
  - red: `cd <23843d19 の worktree>/server && bun run knip` → canary.ts・claude.ts・order/run.ts が未使用のファイル、8 個の export が未使用（verify の check で exit 1）
  - 完了条件: `bun run knip` → 0 で終わる。`cd server && node --test test/eval-claude.test.ts` → 壊れたイベント・結果の形と並べ替えた印が unknown になるテストが pass
  - コミット: `fix(evals): close the last review findings and register the new entry scripts (T20)`
  - 結果: red は 23843d19 での `bun run verify` の knip の失敗（未使用のファイル 3、export 5、型 3）。直した後 `bun run knip` → 指摘なし。`node --test test/eval-claude.test.ts test/eval-grade.test.ts test/eval-build.test.ts` → pass 80, fail 0。backup の hidden test を collect と同じ sandbox と permission model で 6 つの実装に当て、同期・callback・stream のコピーは pass 2、空ファイル・送信は fail 1、未実装は fail 2

- [x] T21: 差分全体のレビューの 3 件と、A4 で見つけた「Codex の run が他の run を検索した」件を直す（run の外の読み取りを止める、外を見た run を外す、検索の率の unknown、並行の区間）
  - 種別: 修正
  - 計画: S2, S3, S4, S7
  - 依存: T20（直す対象のブランチの先頭）
  - 変更: `server/evals/cloud/claude-run.ts`, `server/evals/cloud/canary.ts`, `server/evals/cloud/judge.ts`, `server/evals/cloud/collect.ts`, `server/evals/cloud/report.ts`, `server/test/eval-claude.test.ts`, `server/test/eval-grade.test.ts`
  - red: `cd <86d6784f の worktree>/server && node evals/cloud/collect.ts --build <build-final> --no-cloud` → `rg --files /private/tmp/claude-501 ...` で他の run の一覧を読んだ Codex の conflict-cover の run が結果として残る
  - 完了条件: `cd server && node --test test/eval-claude.test.ts test/eval-grade.test.ts` → pass。`node evals/cloud/canary.ts --build <build>` → 拒否の指定の無い外の sentinel への 5 つの試行が全部止まり `canary passed`
  - コミット: `fix(evals): keep runs inside their checkout and drop the ones that looked outside (T21)`
  - 結果: red は A4 の回収（86d6784f）で、外を見た Codex の run が結果に残っていた。直した後 `node --test test/eval-claude.test.ts test/eval-grade.test.ts test/eval-build.test.ts` → pass 82, fail 0。canary（sentinel を評価のキャッシュの下に、拒否の指定なしで置く）→ fence 8 項目すべて ✓、`canary passed`。回収し直すと、その Codex の run だけが `looked outside its checkout` で外れた

- [x] T22: T21 の再レビューの 2 件を直す（もう片方のモデルの run 置き場、自分の run を経由して外へ出るパス）
  - 種別: 修正
  - 計画: S2
  - 依存: T21（直す対象）
  - 変更: `server/evals/cloud/judge.ts`, `server/evals/cloud/collect.ts`, `server/test/eval-claude.test.ts`
  - red: `cd <27d1a49f の worktree に新しいテストを置いて>/server && node --test test/eval-claude.test.ts` → `own/../r2` のパスを外と見なさず 1 件落ちる
  - 完了条件: `cd server && node --test test/eval-claude.test.ts` → pass
  - コミット: `fix(evals): catch runs that reach the other model's runs or climb out of their own (T22)`
  - 結果: red は上のとおり 1 件落ちた（もう片方の置き場の件はレビュアーの再現を根拠にした）。直した後 `node --test test/eval-claude.test.ts test/eval-grade.test.ts test/eval-build.test.ts` → pass 82, fail 0。A4 を回収し直して、外れるのは同じ Codex の 1 run だけ

## 記録
- 2026-10-04 / T01 / build.ts はモジュールを読んだ時点でビルドを始めるのでスクリプトをテストから読めない / スロットのスクリプトを `slot-scripts.ts` に移し、変更欄に足した（前: build.ts と test、後: slot-scripts.ts を追加）
- 2026-10-04 / T01 / 持ち主のシェルに `SPHICA_DB` が残っていると run の DB として使ってしまう / runner が渡す変数は `SPHICA_DB` ではなく `EVAL_SPHICA_DB` にした（完了条件の変数名を前: `SPHICA_DB`、後: `EVAL_SPHICA_DB` に直した）
- 2026-10-04 / T12 / build.ts が main で落ちていた（9/30 のループより後の権限と hooks.json の変更）/ 修正タスク T12 を足し、T02 の依存に入れた（前: なし、後: T12）。T02 の完了条件に実ビルドを足した（build は読み込みで走るスクリプトでテストから組み立てられないため）
- 2026-10-04 / T01 / Codex レビュー F1（gold の印の TMPDIR への戻りのテストが無い）を採った / T13 を足した
- 2026-10-04 / T03 / スクリプトとして読み込んだ時点で走る claude.ts からは関数をテストに出せない / 設定・patch・答えの取り出しを `claude-run.ts` に置き、stream の判定を judge.ts に足した（変更欄 前: claude-settings.ts、後: claude-run.ts と judge.ts）
- 2026-10-04 / T03 / 実 run で、acceptEdits の -p は MCP の呼び出しを全部拒否した / search と inject の settings に `allow: ["mcp__sphica"]` を足した
- 2026-10-04 / T03 / 実 run で、Sphica のツールは強制しなくても遅延読み込みで、モデルは ToolSearch の `select:mcp__sphica__search` で読み込んでから呼んだ / T10 はこの ToolSearch の呼び出しを遅延の証拠の候補にする
- 2026-10-04 / T03 / Claude Code 自身の安全判定で Bash の 1 呼び出しが拒否された（brace と引用符）/ 条件によらず同じなのでそのまま
- 2026-10-04 / T02 / Codex レビュー F1（run 数の検査）を採り T14 にした。F2 は matcher と rekey を build-lib.ts に切り出してテストし、`--dist` / `--fixture` の通しのビルドは CI に無い Linux 版 Node（31MB）が要るので自動テストにせず、手で流した結果を T02 に残した
- 2026-10-04 / T04 / `--setting-sources ""` ではプロジェクトの CLAUDE.md も読み込まれず、モデルが Read で読みに行った（cloud と条件がずれる）/ `--setting-sources project` に変え、clone の `.claude/settings.json`（cloud のフック）は開始前のコミットで消し、フックは `--settings` から渡す。正の対照（CLAUDE.md を置いた run）で InstructionsLoaded の receipt に `memory_type: Project` が出て、user の CLAUDE.md は出ないことを確かめた
- 2026-10-04 / T04 / canary は `claude.ts --canary` ではなく別の `canary.ts` にし、結果をビルドの `canary.json` に残して claude.ts が見る（変更欄 前: claude.ts と canary.ts、後: claude-run.ts・canary-check.ts・slot-scripts.ts を追加）。receipt に読み込んだファイルを残すため HOOK_SH に `file` と `memory` を足した
- 2026-10-04 / T04 / Sphica は delivery の session_id をホストの id から作り直すので、DB の canary は「各 DB に session が 1 つ、2 つの run で違う、TMPDIR に DB が無い」で見る
- 2026-10-04 / T05 / 観測と判定の置き場所 / runner 側は claude.ts ではなく claude-run.ts（T03 で run を移したため）、テストは eval-grade ではなく eval-claude（変更欄 前: claude.ts と eval-grade.test.ts、後: claude-run.ts と eval-claude.test.ts）
- 2026-10-04 / T03 / Codex レビュー 5 件（P1 2 件: 環境変数、資格情報ファイル）を全部採った / T15
- 2026-10-04 / T05 / Codex レビュー 4 件を全部採った / T16
- 2026-10-04 / T06 / stale タスクは「今のコード」がレコードと違う必要がある / tasks.json の project に `current`（スロットだけに当てるファイル）を足し、build.ts の files() で当てる。fixture の手順は build-lib.ts の `fixtureSteps` に切り出し、ビルドとテストで共有（変更欄に build.ts・build-lib.ts を足した）
- 2026-10-04 / T06 / crowded はエージェントのタスクを作らず、T09 のベンチの中で組み立てる（エージェントの fixture に混ぜると他のタスクの配信が変わる）。stale の記録は「今のコードで anchor が無い」ので、old でも pre_read で path が合えば届く（テストで確認）
- 2026-10-04 / T07 / 衝突のタスクを grader に知らせる欄が要る / tasks.json に `conflict`（両側の説明）を足し、grade.ts が渡す。grader の一致の比較に新しい 2 欄を足した（変更欄に schema-check.ts・grade.ts・tasks.json を足した）
- 2026-10-04 / T04 / Codex レビュー 5 件（P1 2 件）を全部採った / T17
- 2026-10-04 / T17 / canary の正の対照の run で、claude が SessionStart までに 15 分止まった（API の時間は 3.7 秒、終わった後は普通に終了）。原因は未特定 / 再現したら、起動の待ち（ロックや利用上限）を調べる。run の時間は result.json の seconds に残る
- 2026-10-04 / T09 / crowded の記録は src/library.ts の 9 件として world と cases.json の setups（crowded_*）に足し、エージェントの fixture には入れない。ベンチは driver の新しい `delivered()` で配信の中身を読む（変更欄 前: evals/order/run.ts と package.json、後: bench.ts・driver.ts・cases.json・world.json を足し package.json を外した）
- 2026-10-04 / T09 / ベンチは「件数の上限で落ちたか、文字数で落ちたか」を分けて出す形にはしていない（各イベントの件数と文字数を並べる）。今の 9 件はどちらも 5 件・1000 字前後で、件数の上限で決まっている
- 2026-10-04 / T09 / PR-B の G2 のバー「どの対照例でも下がらない」は、重みで並べ替えると軽い記録が押し出されるので成り立たない。PR-B の計画で、重みのある記録の増加と軽い記録の減少を並べて判定する形に直す
- 2026-10-04 / T06, T08 / Codex レビュー 5 件を全部採った / T18。hidden test は checkout の読み取りしか許されないので、書き込み系の fs 関数を記録だけするものに差し替えて（syncBuiltinESMExports）コピーの指示と送信を見る
- 2026-10-04 / T15, T16, T17 / Codex レビュー 6 件（P1 1 件: canary の件数照合）を全部採った / T19。Bash のコミットの件（T16 F4）は実装はすでに正しく、テストが clean から clean の場面を突いていなかった
- 2026-10-04 / T10 / init の欄では遅延かどうかが分からなかった / stream の ToolSearch の結果（tool_reference の tool_name）で判定し、stream の読み取りで tool_reference の名前も結果に含めるようにした。G6 は測れる
- 2026-10-04 / T09, T18, T19 / Codex レビュー 6 件。5 件を T20 で直した。T09 F2（crowded の記録の保存日時が実行時刻になる）は採らない: 新しい順は保存の順（id）で決まり、setup の順＝宣言した日付の順と一致するので、順番の比較は歪まない。評価用のスクリプトで出荷しないので、ここからはタスクごとの再レビューをやめ、差分全体のレビューで P1 とセキュリティに絞る
- 2026-10-04 / 全差分レビュー / P1 1 件（読み取りが一覧の場所でしか止まらない）と測定の 2 件（検索の率が unknown を分母から外す、最初の変化より前の並行の区間）を採った / T21。Claude は `permissions.blockReadsOutsideWorkingDirectories` で checkout の外を読めなくし（公式ドキュメント: denyRead は Bash だけ、Read ツールには効かない）、canary の sentinel を拒否の指定の無い場所に移して一般の境界を確かめる
- 2026-10-04 / A4 / Codex の run が `rg --files <一時ディレクトリの根>` で他の run を一覧していた。Codex には読み取りの囲いが無いので、stream から自分の run の場所を除いて、ビルド・run 置き場・評価のキャッシュが残る run を excluded にする。文字列に場所が含まれるかだけを見るので、`rg /` のように根から探すものは捕まえられない（限界として PR に書く）

- 2026-10-04 / T21 / 再レビュー 2 件（測定）を採った / T22。指摘が作り込みのパスへ移ってきたので、レビューの往復はここで打ち切る
