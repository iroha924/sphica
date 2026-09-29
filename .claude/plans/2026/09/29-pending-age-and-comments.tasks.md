---
kind: tasks
plan: 29-pending-age-and-comments.plan.md
branch: feat/pending-age-and-comments
base: main
---

# 30 日より古い未 trace のセッションを待ちに数えず、Skill の allowed-tools に読み取りツールをそろえ、コメント規則から参照と経緯を外す（0.6.5） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 古い plan を片付け、コメント規則を書き換える

参照と経緯を書かない規則が機械で守られ、既存の違反が無くなる

- [x] T01: 既存の plan と tasks 14 ファイルを消す
  - 種別: 削除
  - 計画: S8
  - 依存: なし
  - 変更: `.claude/plans/2026/09/`
  - 完了条件: `find .claude/plans -type f` → この計画の 2 ファイルだけ
  - コミット: `chore(plans): remove finished plans and task lists`
  - 結果: `git rm` で 14 ファイルを消し、`find .claude/plans -type f` → この計画の plan と tasks の 2 ファイルだけ

- [x] T02: コメント規則を書き換え、共通の 3 行が両ファイルで一致することを検査する
  - 種別: 変更
  - 計画: S5
  - 依存: なし
  - 変更: `.claude/rules/comments.md`, `AGENTS.md`, `scripts/check-ai-config.mjs`
  - 完了条件: `bun run verify:ai` → 0 で終わる。`comments.md` の共通の 3 行を 1 字変えると落ちる（戻す）
  - コミット: `docs(rules): keep references and history out of code comments`
  - 結果: `bun run verify:ai` → 0。`comments.md` の comment-length の行に空白を 1 つ足すと「AGENTS.md: the comment-length line differs」で落ち、戻して 0。新しい 2 行に invariant `comment-refs`・`comment-history` を付け、印の集合の検査にも載せた

- [x] T03: 既存の違反コメントを直す
  - 種別: 変更
  - 計画: S7, S9
  - 依存: T02（直す基準の文面が要る）
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `server/src/forget.ts`, `server/test/forget.test.ts`, `server/evals/acceptance/load.ts`, `db/migrations/0002.sql`, `db/migrations/0003.sql`, `scripts/check-sql-live.mjs`, `scripts/lib/release-gate.mjs`, `server/test/github.test.ts`, `scripts/bundle.mjs`, `server/src/capture.ts`, `scripts/check-ai-config.mjs`, `scripts/check-tarball.mjs`, `db/schema.sql`, `scripts/release-finish.mjs`
  - 完了条件: `bun run check` → 0 で終わる。`bun run --cwd server test -- test/migrate.test.ts` → 通る（migration の SQL は変わらない）
  - コミット: `refactor: drop issue numbers, plan paths, and history from comments`
  - 結果: 14 ファイルのコメントを直し、4 つのファイルを 0.6.5 にした（`bun run release:plan -- --base v0.6.4` → `plugin`）。`bun run check` → 0。`node --test test/migrate.test.ts test/forget.test.ts test/github.test.ts` → 29 pass / 0 fail

- [x] T04: コメントの参照を落とす `bun run comments` を足す
  - 種別: 追加
  - 計画: S6
  - 依存: T03（既存の違反が残ると検査が落ちる）
  - 変更: `scripts/check-comments.mjs`, `scripts/lib/comment-refs.mjs`, `scripts/lib/comment-refs.d.mts`, `scripts/lib/english.mjs`, `scripts/lib/english.d.mts`, `server/test/comments-check.test.ts`, `server/test/github.test.ts`, `scripts/check-english.mjs`, `package.json`
  - 完了条件: `bun run comments` → 0 で終わる。`bun run --cwd server test -- test/comments-check.test.ts` → 落ちる例と通る例がすべて期待どおり
  - コミット: `feat(check): fail on issue numbers and plan paths in comments`
  - 結果: `bun run check` → 0（`comments: 129 JavaScript and TypeScript files, 3 SQL files`）。`node --test test/comments-check.test.ts test/english.test.ts` → 12 pass / 0 fail。`server/src/text.ts` に `// see issue #1`・`// see .claude/plans/x`・`// Closes #2` を 1 つずつ足すと exit 1、戻して 0

## P2: 30 日より古い未 trace のセッションを分ける（#226）

セッション開始の件数から古いものが外れ、pending と status が古いものを別に示す

- [x] T05: 最後のオーナー発言で最近と古いを分け、件数・pending・status を変える
  - 種別: 変更
  - 計画: S1, S2
  - 依存: なし
  - 変更: `server/evals/acceptance/`, `server/src/status.ts`, `server/src/trace.ts`, `server/src/extract.ts`, `server/src/deliver.ts`, `server/src/mcp-record.ts`, `server/test/`
  - 完了条件: `bun run --cwd server test` → 31 日・29 日・30 日ちょうど・古い未 trace と新しい trace 済みの 4 件と、`sources: true`・`asked: true` での検索が通る。`bun run acceptance` と `bun run sql:reach` → 0 で終わる。先に足した 31 日前の acceptance case は、実装前のコードで待ちの件数に入って落ちることを確かめてから実装する
  - コミット: `feat(trace): stop counting sessions idle for over 30 days as waiting`
  - 結果: red: status-07 を足して実装前に `bun run acceptance` → status-07 だけが `actual: 1, expected: 0`（31 日後でも最近の待ちに数えた）で落ちた。実装後: `bun run verify` → 0（テスト 410 pass、acceptance 68 pass、`SQL: tests ran 171 / 171 sites`）

- [x] T09: コメント規則の一致の検査と SQL コメントの行番号を直す
  - 種別: 修正
  - 計画: S5, S6
  - 依存: T02（直す検査が要る）, T04（直す検査が要る）
  - 変更: `scripts/check-ai-config.mjs`, `scripts/lib/comment-refs.mjs`, `server/test/comments-check.test.ts`
  - red: 直す前のコードで、`comments.md` の comment-refs の行の後ろに 1 字違いの同じ印の行を足して `bun run verify:ai` → 通ってしまう。`referenceProblems("-- a\r-- issue #2", "sql")` → 行番号 1
  - 完了条件: `bun run verify:ai` → 0。同じ印の行を重複させると「keep exactly one line」で落ちる。`node --test test/comments-check.test.ts` → CR だけの改行で行番号 2
  - コミット: `fix(check): require one line per comment rule and count CR line breaks in SQL`
  - 結果: red は上のとおり再現（重複でも verify:ai が 0、行番号 1）。直した後: 重複で「keep exactly one line for invariant comment-refs in each」で落ち、戻して 0。`node --test test/comments-check.test.ts` → 4 pass / 0 fail

- [x] T10: 待ちの件数と一覧を、セッションごとの索引で引く形にする
  - 種別: 修正
  - 計画: S2
  - 依存: T05（直す問い合わせが要る）
  - 変更: `server/src/trace.ts`, `server/src/status.ts`
  - red: 500 セッション × 200 オーナー発言の一時 DB で、直す前の `pendingCount` → 1 回 36.6 ms、`pendingSessions` → 101.5 ms（プロジェクトの全オーナー発言を GROUP BY で集計する）
  - 完了条件: 同じ DB で `pendingCount` が数 ms に下がり、件数が直す前と同じ。`bun run verify` → 0
  - コミット: `fix(trace): read each untraced session through its own messages`
  - 結果: 同じ DB で `pendingCount` → 1.84 ms、`pendingSessions` → 15.9 ms。件数は直す前と同じ最近 268・古い 232。測定用のテストファイルは消した。`bun run verify` → 0

- [x] T06: trace の Skill に古い群の説明を足す
  - 種別: 変更
  - 計画: S3
  - 依存: T05（説明する出力の形が要る）
  - 変更: `plugin/skills/trace/SKILL.md`
  - 完了条件: `bun run verify:ai` → 0 で終わる
  - コミット: `docs(trace): say pending lists older sessions apart`
  - 結果: 手順 1 に古い群の説明を 2 行足した。`bun run verify:ai` → 0、`bun run english` → 0

## P3: Skill の allowed-tools をそろえる

どの Skill でも読み取りツールが拒否されず、本文と許可のずれが検査で落ちる

- [x] T07: 全 Skill に読み取りツールを許可し、本文と許可のずれを検査する
  - 種別: 修正
  - 計画: S4
  - 依存: なし
  - 変更: `plugin/skills/trace/SKILL.md`, `plugin/skills/harvest/SKILL.md`, `plugin/skills/glean/SKILL.md`, `plugin/skills/rules/SKILL.md`, `plugin/skills/forget/SKILL.md`, `plugin/skills/review/SKILL.md`, `scripts/check-ai-config.mjs`
  - red: 検査を先に足して `bun run verify:ai` → rules・harvest・review などで `status` などが許可に無い、trace で `AskUserQuestion` が許可に無い、で落ちる
  - 完了条件: `bun run verify:ai` → 0 で終わる。どれか 1 つの Skill から `mcp__plugin_sphica_sphica__status` を消すと落ちる（戻す）
  - コミット: `fix(skills): allow the read tools in every Skill and check body against allowed-tools`
  - 結果: red: 検査を先に足して `bun run verify:ai` → 6 つの Skill で `status` が無い、review で `search`・`read`・`review_select`・`review_check` が無い、trace で `AskUserQuestion` が無い、で落ちた。直した後: `bun run verify:ai` → 0。rules から `status` を消すと「allowed-tools lacks mcp__plugin_sphica_sphica__status」、登録の無い `mcp__plugin_sphica_sphica__nope` を足すと「which no Sphica server registers」で落ち、戻して 0。`bun run verify` → 0

## P4: 0.6.5 として出す

- [x] T11: allowed-tools の検査の見逃しを直す
  - 種別: 修正
  - 計画: S4
  - 依存: T07（直す検査が要る）
  - 変更: `scripts/check-ai-config.mjs`, `scripts/lib/english.mjs`
  - red: `bun run verify:ai` → 直す前の検査で、`server/src/mcp.ts` に `// server.registerTool("ghost")` を足し rules に `mcp__plugin_sphica_sphica__ghost` を許可 → 通る。rules の本文に `mcp__plugin_sphica_record__forget_apply` を書いて許可しない → 通る。rules の allowed-tools を YAML の配列にする → `TypeError: ... split is not a function`
  - 完了条件: 同じ 3 つの入力で、1 と 2 は検査が名指しで落ち、3 は 0 で終わる。`bun run check` → 0
  - コミット: `fix(check): skip commented registrations, read full tool ids and YAML lists`
  - 結果: red は上のとおり再現。直した後: 1 は「which no Sphica server registers」、2 は「allowed-tools lacks mcp__plugin_sphica_record__forget_apply」で落ち、3 は 0。`bun run check` → 0

- [-] T08: リリースの種別を確かめ、バージョンをそろえる
  - 種別: 変更
  - 計画: S9
  - 依存: T04（ステージする変更が要る）, T05（ステージする変更が要る）, T07（ステージする変更が要る）
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run release:plan -- --base v0.6.4` → `plugin`、4 つのファイルが 0.6.5。`bun run verify` → 0 で終わる
  - コミット: `chore(release): 0.6.5`

## 記録
2026-09-29 / T03 / `server/test/migrate.test.ts:2` の「fixture は v0.5.7 の schema」は経緯ではなく fixture の出どころの説明だった / 直さず、変更欄から `server/test/migrate.test.ts` を外した（前: 含む、後: 含まない）
2026-09-29 / T03, T08 / pre-commit の bundle 検査が、パッケージに入るファイルを変えるコミットにバージョンの上げを求めた / バージョンの上げを T03 に移し、T03 の変更欄に 4 つのバージョンファイルを足した。T08 は最後に release:plan で種別とバージョンの一致を確かめるだけにする
2026-09-29 / T04 / 検査を流すと `server/test/github.test.ts:254` の「closes #14」が当たった。テスト用の関数を置く `scripts/lib/comment-refs.mjs` と型宣言も要った / コメントを直し、T04 の変更欄に `scripts/lib/comment-refs.mjs`・`scripts/lib/comment-refs.d.mts`・`scripts/lib/english.d.mts`・`server/test/github.test.ts` を足した
2026-09-29 / T05 / reader の authorizer が `sum` を許可していなかった / 許可リストは広げず `count(case when ... then 1 end)` で書いた
2026-09-29 / T05 / テストの発言の既定日時（2026-09-10）が実際の時計では 10 月 10 日以降に古くなる / 件数・一覧・status を呼ぶテストに固定の now を渡し、時刻を差し込めないセッション開始のテストは発言を今日の日時にした。SQL の呼び出し箇所はすべてテストが流したので `scripts/lib/sql-call-sites.mjs` は変えず、変更欄から外した

2026-09-29 / T09 / T02・T04 の Codex レビュー: 同じ印の行が重複すると後ろの違いを見逃す（低）、SQL の複数行の文字列の中の `--` 行を誤検出（中）、CR だけの改行で行番号がずれる（低） / 1 件目と 3 件目は T09 を足して直した。2 件目は見送り: 誤検出は検査が落ちるだけで黙って通らず、今の SQL にそういう文字列は無く、直すには SQL の文字列の解釈が要る
2026-09-29 / T07 / trace の本文は AskUserQuestion をバッククォートなしで書いていて、インラインコードだけを拾う形では当たらなかった / AskUserQuestion は普通の単語と紛れないので、本文のどこにあっても拾うようにした
2026-09-29 / T10 / T05 の Codex レビュー: セッション開始のたびにプロジェクトの全オーナー発言を集計する（中、Codex の簡易測定で旧クエリの約 50 倍） / T10 を足し、未 trace のセッションを EXISTS で絞ってから、そのセッションの発言だけを索引で引く形に直した
2026-09-29 / T08 / 取りやめ。S9 のバージョン上げは pre-commit の求めで T03（d091e11）に入った。`bun run release:plan -- --base v0.6.4` → `plugin`、npm・plugin・marketplace・Codex がすべて 0.6.5 を確かめた
2026-09-29 / T03 / 計画欄 前: S7、後: S7, S9 / T03 のコミットがバージョン上げ（S9）を実際に担ったので、欄を事実に合わせた
2026-09-29 / T11 / T07・T10 の Codex レビュー: T10 は差なし。T07 の検査に、コメント中の登録を数える（中）、本文の完全なツール名を見落とす（中）、YAML の配列で例外（低）、「使わない」と書いた AskUserQuestion も許可を求める（低）、reviewer 本文と起動時のツール表のずれを見ない（中） / 前の 3 件は T11 で直した。4 件目は見送り（誤検出は落ちるだけで黙って通らない）。5 件目は見送り（計画で対象外とした別の検査）
