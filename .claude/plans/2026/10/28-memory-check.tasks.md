---
kind: tasks
plan: 28-memory-check.plan.md
branch: feat/216-memory-check
base: main
---

# Add a user-invoked memory-check Skill that lists memory and instruction lines going against live records (#216) のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: Skill

Bash を外したファイルツールの実測に合わせて Skill を書き、書き込みツールの外し漏れを機械で止める。

- [x] T01: ファイルツールの実測と memory-check Skill
  - 種別: 追加
  - 計画: S1, S2, S8
  - 依存: なし
  - 変更: `.claude/plans/2026/10/28-memory-check.plan.md`, `plugin/skills/memory-check/SKILL.md`, `plugin/skills/memory-check/agents/openai.yaml`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `pane/.claude-plugin/plugin.json`
  - 完了条件: `mise exec -- bun run verify:ai` → 終了コード 0。実測の結果が plan の「前提」にあり、Skill の上限と読む場所の記述がそれと合う。`bun run release:plan -- --base v0.6.68` → `plugin`、VERSION_SOURCES がすべて 0.6.69
  - コミット: `feat(skills): add memory-check to list memory lines against live records (T01)`
  - 結果: `claude -p` でプロジェクトの Skill を 4 回流して実測（plan の前提に記載）。`mise exec -- bun run verify:ai` → 0。`bun run release:plan -- --base v0.6.68` → `plugin`、npm / plugin / marketplace / Codex / pane / pane ref がすべて 0.6.69。`mise exec -- bun run verify` → 0（151 pass）。review-shipping: 指摘 1 件（ツールの除外は次のメッセージで解ける）を本文に反映

- [x] T02: record サーバーのツールが disallowed-tools から漏れたら落とす
  - 種別: 追加
  - 計画: S3
  - 依存: T01（検査する Skill の frontmatter が要る）
  - 変更: `scripts/check-ai-config.mjs`
  - 完了条件: `mise exec -- bun run verify:ai` → 終了コード 0。Skill の `disallowed-tools` から record サーバーのツールを 1 つ消すと、そのツール名を挙げて落ちる
  - コミット: `test(ai-config): fail when memory-check leaves a record tool available (T02)`
  - 結果: `node scripts/check-ai-config.mjs` → 0。`record_more` を消すと「disallowed-tools removes record tools but not mcp__plugin_sphica_record__record_more」で落ちた。YAML のリストで書いても 0（両ホストともリストを受け付ける）

- [x] T07: Codex のレビュー（002c5352）の指摘 F1〜F3 を直す
  - 種別: 修正
  - 計画: S2, S3
  - 依存: T01（直す Skill の本文）, T02（直す検査）
  - 変更: `scripts/check-ai-config.mjs`, `plugin/skills/memory-check/SKILL.md`, `README.md`, `README.ja.md`
  - red: memory-check の disallowed-tools から record サーバーのツールを全部消して `node scripts/check-ai-config.mjs` → 落ちずに終了コード 0
  - 完了条件: `node scripts/check-ai-config.mjs` → 0。同じ red の操作で record サーバーの 11 ツールを挙げて落ち、Edit だけ消しても落ちる。本文に search / read の失敗時の扱いと、パス・キーにも及ぶ文字の置き換えがある
  - コミット: `fix(skills): keep memory-check's removals required and cover search failures (T07)`
  - 結果: `node scripts/check-ai-config.mjs` → red の操作で終了コード 0（実測）。直した後は、全部消すと「disallowed-tools does not remove ...」が 11 件、Edit だけ消すと 1 件で落ち、元に戻すと 0。READ_ONLY_SKILLS の名前が plugin/skills に無ければ落ちる検査も足した。review-shipping（指摘 0 件）の補足を受けて、サブエージェントから書き込めないよう Agent も外し、両 README の記述を合わせた

- [x] T08: Codex がファイルを読む手段を本文に書く
  - 種別: 修正
  - 計画: S2
  - 依存: T07（直す本文）
  - 変更: `plugin/skills/memory-check/SKILL.md`
  - red: `node server/evals/memory-check/codex.ts --runs 3` → marker のケースが 3 回中 2 回、「Read / Glob が無く、シェルは禁じられている」として何も読まずに終わる（2026-10-28 実測）
  - 完了条件: `node server/evals/memory-check/codex.ts --runs 3 --case memory-check-marker` → 3/3 pass。`node scripts/check-ai-config.mjs` → 0
  - コミット: `fix(skills): tell Codex to read memory files with read-only shell commands (T08)`
  - 結果: red は `node server/evals/memory-check/codex.ts --runs 3` → marker 1/3（2 回は何も読まずに終了）。直した後 `node server/evals/memory-check/codex.ts --runs 3 --case memory-check-marker` → 3/3 pass（40s / 37s / 40s）。`node scripts/check-ai-config.mjs` → 0。review-shipping の指摘（Windows の PowerShell に head・wc が無い）を受けて PowerShell での読み方も足した

## P2: 評価

固定ケースを両ホストで各 3 回流し、結果をリポジトリに残す。

- [x] T03: Claude の plugin eval ケース 1〜7
  - 種別: 追加
  - 計画: S4
  - 依存: T01（流す Skill が要る）
  - 変更: `server/evals/plugin/cases/memory-check-*/`, `server/evals/memory-check/claude-runs.json`
  - 完了条件: `bun run eval:plugin` → memory-check の各ケースを 3 回流し、plan の A2 の期待をすべて満たす。結果が `server/evals/memory-check/claude-runs.json` にある
  - コミット: `test(evals): add memory-check plugin eval cases and Claude runs (T03)`
  - 結果: `bun run eval:plugin --case 'memory-check-*' --ablation none --runs 1` → 8c512d68 の本文で 3 回流して 21/21 pass（Claude Code 2.1.312、claude-sonnet-5-5、1 回 $0.67〜0.69、76〜100 秒）。注入ケースは Edit・Write・Bash・NotebookEdit・record サーバーの書き込みツールの呼び出しが 0、CLAUDE.md は変わらず。結果は `server/evals/memory-check/claude-runs.json`

- [x] T04: Codex を使い捨ての CODEX_HOME で流す手順と、その実行
  - 種別: 追加
  - 計画: S5
  - 依存: T03（同じケースの scaffold とメモリのファイルを使う）
  - 変更: `server/evals/memory-check/codex.ts`, `server/evals/memory-check/codex-runs.json`, `knip.json`
  - 完了条件: `node server/evals/memory-check/codex.ts --runs 3` → plan の A3 の期待を満たす。結果が `server/evals/memory-check/codex-runs.json` にある
  - コミット: `test(evals): run memory-check cases on Codex in a throwaway home (T04)`
  - 結果: `node server/evals/memory-check/codex.ts --runs 3` → 8c512d68 の本文で 21/21 pass（codex-cli 0.163.0、1 回 14〜66 秒）。21 回すべてで呼ばれた MCP ツールは read サーバーの status・search・read だけ、ファイルの変更と記録の表の変化は 0。record サーバーはプラグインの設定に宣言して入れたが、各回で読み込まれていたかはイベントから確かめていない（未確認）

- [x] T05: README の段落
  - 種別: 追加
  - 計画: S6
  - 依存: T01（書くホストの違いが実測で決まる）
  - 変更: `README.md`, `README.ja.md`
  - 完了条件: `mise exec -- bun run verify:ai` → 終了コード 0（Markdown の構造とリンク）。両 README に、ホストのメモリとの関係、`memories.disable_on_external_context` の意味、ホストの違いの 3 点がある
  - コミット: `docs(readme): describe memory-check and how Sphica relates to host memories (T05)`
  - 結果: `node scripts/check-ai-config.mjs` → 0、`node scripts/check-links.mjs` → 62 ファイルのリンクがすべて解決。両 README の「できること」に機能と `memories.disable_on_external_context` の意味、「まだできないこと」にホストの違いを 1 行ずつ足した

- [x] T09: GitHub の Codex のレビュー（85c17196）の指摘を Codex の eval に入れる
  - 種別: 修正
  - 計画: S5
  - 依存: T04（直すスクリプト）
  - 変更: `server/evals/memory-check/codex.ts`
  - red: `node -e` → codex.ts の judge の集計式に [true, null, null] を渡すと `true`（失敗した 2 票を数えず 1 票で通る）
  - 完了条件: 同じ集計で `[true, null, null]` → `null`、`[true, true, null]` → `true`。judge の子プロセスに SPHICA_DB・SPHICA_HOME・CODEX_HOME を渡さない。ファイルが変わった回は判定によらず落ちる。`mise exec -- bun run verify` → 0
  - コミット: `fix(evals): require a judge quorum and fail memory-check runs that change files (T09)`
  - 結果: `node -e` の集計で red は `true`、直した後は `[true,null,null]` → `null`、`[true,true,null]` → `true`、`[false,false,true]` → `false`。記録済みの 21 回はすべて有効な 3 票が PASS でファイルの変更も無いので、新しい規則でも結果は同じ（流し直していない）

- [x] T10: 持ち主の試行と固定ケースで見つかった読み方の欠陥を直し、search の上限を上げる
  - 種別: 修正
  - 計画: S2, S4, S5
  - 依存: T08（直す本文）, T09（流し直す Codex の eval）
  - 変更: `plugin/skills/memory-check/SKILL.md`, `.claude/plans/2026/10/28-memory-check.plan.md`, `server/evals/plugin/cases/memory-check-symlink/`, `server/evals/memory-check/claude-runs.json`, `server/evals/memory-check/codex-runs.json`
  - red: `bun run eval:plugin --case memory-check-symlink --ablation none --runs 3` → 直す前の本文で 3 回とも落ちる（2026-10-28 実測）。持ち主の試行では Claude Code が実在する `~/.codex/AGENTS.md`（リンク）を「見つからない」と報告し、Codex が search 80 回で打ち切った。固定ケース 8 を足すと、引数を渡した回で Claude Code が既定の場所を読まずに 3 回とも落ち、`~` を推測したホームに置き換えて読めない回もあった
  - 完了条件: `bun run eval:plugin --case 'memory-check-*' --ablation none --runs 1` を 3 回 → 8 ケースすべて pass。`node server/evals/memory-check/codex.ts --runs 3` → 24/24 pass。`node scripts/check-ai-config.mjs` → 0
  - コミット: `fix(skills): open named memory files by path and read the argument's paths as extra places (T10)`
  - 結果: `bun run eval:plugin --case 'memory-check-*' --ablation none --runs 1` → 3 回とも 8/8 pass（$0.87〜0.89、88〜112 秒）。`node server/evals/memory-check/codex.ts --runs 3` → 24/24 pass、MCP は read サーバーの status・search・read だけ、ファイルと記録の表の変化は 0。途中の流し直しでは、Claude Code が `~/.codex` を飛ばす回（3 回中 2 回）と、eval の環境で Read が拒否されて何も読めない回があった。後者でも Skill は not checked と報告し、flag 0 件では終えていない。review-shipping の指摘 2 件（リンクを飛ばすのは Claude Code の Glob だけ、not checked の使いどころの食い違い）は文言だけ直した。上の eval はこの 2 件を直す前の本文で流した

## P3: 試行と採否

同じ PR head で持ち主が両ホストで試し、結果を残して採否を決める。

- [x] T06: 持ち主の試行の記録
  - 種別: 追加
  - 計画: S7
  - 依存: T02（試す head に検査が入っている）, T04（両ホストの固定ケースが通っている）, T05（試す head を揃える）
  - 変更: `server/evals/memory-check/trial.json`
  - 完了条件: `node -e "JSON.parse(require('fs').readFileSync('server/evals/memory-check/trial.json','utf8'))"` → 終了コード 0。その中に、両ホストの flag ごとの判定（新しく知ったもの / 既知、正しい / 誤り / 判断保留）、10 単位の抜き取り、重複、失敗、所要時間、ツールの呼び出し回数がある。#216 へのコメントの文面を持ち主が承認している
  - コミット: `test(evals): record the owner's memory-check trial (T06)`
  - 結果: `node -e "JSON.parse(...trial.json...)"` → 終了コード 0。持ち主の手元で両ホストを 1 回ずつ流した（Claude Code 5 分 15 秒・$2.38・flag 1、Codex 5 分 25 秒・flag 1・search 80 回で打ち切り）。持ち主のラベルはすべて「わからない」、採否は Claude に任され、採った。#216 へのコメントは持ち主が文面を承認して投稿した（https://github.com/iroha924/sphica/issues/216#issuecomment-6468743458）

## 記録
2026-10-28 / T01, T02 / 検査が Skill の本文全体から MCP ツール名を拾うので、disallowed-tools に並べた record のツールが allowed-tools に無いとして落ちた / T02 の検査の変更を T01 と同じコミットに入れた（件名は T01, T02）
2026-10-28 / T07 / Codex による 002c5352 のレビューが F1（record のツールを全部消すと検査をすり抜ける、再現済み）、F2（status 成功後の search の失敗時の扱いが無い）、F3（パスとキーに文字の置き換えが無い）を出した / 3 件とも採り、修正タスク T07 を足して直した。eval は直した本文で 3 回流し直す
2026-10-28 / T07 / 変更欄に `README.md`, `README.ja.md` を足した（前: check-ai-config.mjs と SKILL.md だけ） / Agent を外したことを、T05 で書いた README のホストの違いの行に反映するため
2026-10-28 / T07 / Codex による 9349159e のレビューは指摘なし / 記録のみ
2026-10-28 / T08 / Codex の eval で marker のケースが 2/3 落ちた。本文が Read / Glob / Grep の名前でしか読み方を書いておらず、frontmatter の disallowed-tools の Bash を Codex がそのまま守った / 修正タスク T08 を足した。T03・T04 の結果は直した本文で流し直す
2026-10-28 / T04 / 変更欄に `knip.json` を足した（前: codex.ts と codex-runs.json だけ） / knip が新しい入口の codex.ts を未使用のファイルとして落としたため
2026-10-28 / T08 / Codex による 8c512d68 のレビューは指摘なし / 記録のみ
2026-10-28 / T09 / GitHub の Codex が 85c17196 に 3 件（judge の環境の分離、judge の定足数、ファイル変更で落とす）を出した / 3 件とも直した。judge の HOME は Claude のログインに要るので残し、ツール・設定・MCP の無い起動で届かないことを見送りの理由として PR 本文に書く
2026-10-28 / T10 / ケース 8 は初め Claude Code に `~/.codex/AGENTS.md` を読ませる形だったが、Claude Code が Codex の場所を飛ばす回があり判定がぶれた / 各ホストが自分の場所として読むユーザーの指示ファイル（`~/.claude/CLAUDE.md`、Codex home の AGENTS.md）をどちらもリンクにする形に組み替えた。飛ばす件は既知の制約として PR と #216 に書く
2026-10-28 / T09 / red の欄が検査器の書式（`<command>` → <期待>）に合っていなかった。T09 のコミットの前に検査の出力を見落とした / 中身は変えず書式だけを直した
2026-10-28 / T10 / Codex による b26eb506 のレビュー: F1（ケース 8 はどちらか片方のファイルで通るので、Claude Code が `~/.codex/AGENTS.md` を読み落としても合格する） / 見送り。Claude Code が `~/.codex` を飛ばすことは既知の制約として書き、ケースは各ホストが自分の場所のリンクを開けることを見る。引数のパスはほかの 7 ケースが `~/notes` の行の判定で見ている
