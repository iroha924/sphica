---
kind: tasks
plan: 29-export-decisions.plan.md
branch: feat/export-decisions
base: main
---

# 持ち主が選んだ有効な決定を、引用と置き換えの連なり付きで、コミットできる Markdown に書き出す（#198、0.6.6） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 書き出しの本体

選んだ決定を引用と連なり付きの Markdown にし、不適格な入力と危ない保存先を拒む

- [x] T01: `export.ts` で文書の組み立てと保存先の検査を作り、0.6.6 に上げる
  - 種別: 追加
  - 計画: S1, S4
  - 依存: なし
  - 変更: `server/src/export.ts`, `server/src/read.ts`, `server/test/export.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `node --test test/export.test.ts` → 引用と 2 段の連なり、不適格なキー・深さ・大きさ・保存先の各失敗、Markdown の注入の各テストが通る。`bun run release:plan -- --base v0.6.5` → `plugin`、4 つのファイルが 0.6.6。`bun run verify` → 0
  - コミット: `feat(export): build a Markdown export of chosen live decisions`
  - 結果: `node --test test/export.test.ts` → 7 pass / 0 fail（引用と 2 段の連なり、取り消した引用を出さない、不適格なキーの全体失敗、深さ 20 ちょうどは全部出て 21 で失敗、60 KiB 超で失敗、注入で見出しが増えずフェンスが閉じない、保存先の各場合）。`bun run release:plan -- --base v0.6.5` → `plugin`、4 つのファイルを 0.6.6 に。`bun run verify` → 0（`SQL: tests ran 176 / 176 sites`）

## P2: 入口

読み取りの MCP と明示起動の Skill から書き出せる

- [x] T02: 読み取りの MCP に `export` ツールを登録する
  - 種別: 追加
  - 計画: S2
  - 依存: T01（組み立てと検査の関数が要る）
  - 変更: `server/src/mcp.ts`, `server/test/plugin.test.ts`, `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`, `server/test/acceptance-cases.test.ts`
  - 完了条件: `bun run --cwd server test` → ツール一覧のテストが通る。`bun run acceptance` → export の case が通る。`bun run verify` → 0
  - コミット: `feat(mcp): add the export tool to the read server`
  - 結果: `node --test test/plugin.test.ts` → 28 pass / 0 fail（ツール一覧に export、本物の読み取りサーバーで export を呼ぶと登録の無いディレクトリを拒む）。`bun run acceptance` → 69 pass（export-01: 引用、`trace:s-ja-postgres/postgres supersedes trace:s-ja-storage/storage`、置き換え済みの記録は拒否）。`bun run verify` → 0

- [x] T03: `/sphica:export` Skill を足す
  - 種別: 追加
  - 計画: S3
  - 依存: T02（`allowed-tools` の検査が登録済みのツール名を求める）
  - 変更: `plugin/skills/export/SKILL.md`, `plugin/skills/export/agents/openai.yaml`, `README.md`, `README.ja.md`
  - 完了条件: `bun run verify:ai` → 0。`bun run english` → 0
  - コミット: `feat(skills): add /sphica:export to write chosen decisions to a file`
  - 結果: `bun run verify:ai` → 0（plugin Skills 7、export の allowed-tools と openai.yaml がそろう）。`bun run english` → 0。`bun run verify` → 0

- [x] T04: 別プロジェクトの同じキー、大きな引用、ファイルを通る保存先を直す
  - 種別: 修正
  - 計画: S1
  - 依存: T01（直す関数が要る）
  - 変更: `server/src/export.ts`, `server/test/export.test.ts`
  - red: `node --test test/export.test.ts` → 直す前のコードで、別プロジェクトに先に同じキーがあると「trace:ext-s1/ok: no such record in this project」、「`a」を 20 万回くり返した引用で `RangeError: Maximum call stack size exceeded`、`docs/decisions.md/x.md` で「not a folder」が出ない、の 3 件が落ちる
  - 完了条件: `node --test test/export.test.ts` → 7 pass。`bun run verify` → 0
  - コミット: `fix(export): scope keys to the project, count backticks without spreading, refuse file ancestors`
  - 結果: red は上のとおり 3 件とも再現。直した後: `node --test test/export.test.ts` → 7 pass / 0 fail、`bun run verify` → 0

- [x] T05: 返答の保存先を検査したパスと一致させ、失敗には isError を付け、返答の形を 1 行の案内 + 文書に固定する
  - 種別: 修正
  - 計画: S1, S2, S3
  - 依存: T02（直す入口が要る）, T03（直す Skill の手順が要る）
  - 変更: `server/src/export.ts`, `server/src/mcp.ts`, `server/test/export.test.ts`, `server/test/plugin.test.ts`, `plugin/skills/export/SKILL.md`
  - red: `node --test test/export.test.ts test/plugin.test.ts` → 直す前のコードで、`docs/safe\u200b.md`・`docs/a\nb.md`・制御文字・タブのパスが通る（返答では別の名前に見える）、登録の無いディレクトリへの export が `isError` なしで返る、で落ちる
  - 完了条件: `node --test test/export.test.ts test/plugin.test.ts` → 通る。`bun run verify` → 0
  - コミット: `fix(export): name the checked path exactly, mark every failure, keep one instruction line`
  - 結果: red は上のとおり再現（export のテストは path の検査で、plugin のテストは `isError` で落ちた）。直した後: `node --test test/export.test.ts test/plugin.test.ts` → 36 pass / 0 fail、`bun run verify` → 0

- [x] T06: 延期の見直し条件と引用元の URL を書き出し、`..` で始まる名前を通す
  - 種別: 修正
  - 計画: S1
  - 依存: T01（直す関数が要る）
  - 変更: `server/src/export.ts`, `server/test/export.test.ts`
  - red: `node --test test/export.test.ts` → 直す前のコードで、`revisit_when` のある延期の決定に `revisit when:` が出ない、URL のある引用に URL が出ない、`..notes.md` が「The path leaves the repository.」で拒否される、で落ちる
  - 完了条件: `node --test test/export.test.ts` → 9 pass。`bun run verify` → 0
  - コミット: `fix(export): keep revisit conditions and quote URLs, accept names starting with two dots`
  - 結果: red は上のとおり再現。直した後: `node --test test/export.test.ts` → 9 pass / 0 fail、`bun run verify` → 0

- [x] T07: 引用の改行を保ち、途中の変更と、ハードリンク・ファイルを指すリンクの保存先を拒み、上限で組み立てを止める
  - 種別: 修正
  - 計画: S1
  - 依存: T01（直す関数が要る）
  - 変更: `server/src/export.ts`, `server/test/export.test.ts`
  - red: `node --test test/export.test.ts` → 直す前のコードで、改行を含む引用が `"Use:   bun test ``` Decided."` と 1 行につぶれる、読み取りの途中で根拠を取り消しても文書が返る、ハードリンクの `hard.md` が `{ exists: true }` で通る、で落ちる。ファイルを指すシンボリックリンクを通る `filelink/new.md` は、直す前の `exportPath` が `{"relative":"filelink/new.md","exists":false}` を返した
  - 完了条件: `node --test test/export.test.ts` → 11 pass。`bun run verify` → 0
  - コミット: `fix(export): keep quote line breaks, refuse changed records, hard links, and file links`
  - 結果: red は上のとおり再現。直した後: `node --test test/export.test.ts` → 11 pass / 0 fail、`bun run verify` → 0（`SQL: tests ran 177 / 177 sites`）。上限で組み立てを止める直しは、返す失敗が変わらないので red は無い

- [x] T08: エージェントが指示として読むファイルへの書き出しを拒む
  - 種別: 修正
  - 計画: S1
  - 依存: T01（直す関数が要る）
  - 変更: `server/src/export.ts`, `server/src/rule-files.ts`, `server/test/export.test.ts`
  - red: `node --test test/export.test.ts` → 直す前のコードで `CLAUDE.md` などが保存先として通り、落ちる
  - 完了条件: `node --test test/export.test.ts` → `CLAUDE.md`・`claude.md`・`AGENTS.md`・`AGENTS.override.md`・`.claude/`・`.agents/`・`.codex/` の中が拒否される。`bun run verify` → 0
  - コミット: `fix(export): refuse files agents load as instructions`
  - 結果: red は上のとおり再現。直した後: `node --test test/export.test.ts test/overview.test.ts` → 19 pass / 0 fail、`bun run verify` → 0

## 記録
2026-09-29 / T01 / 引用の切り出しと話し手の表記を使い回すため `read.ts` の `cut` と `speaker` を export した。SQL の呼び出し箇所はテストがすべて流したので台帳は変えなかった / 変更欄 前: `scripts/lib/sql-call-sites.mjs` を含む、後: 外して `server/src/read.ts` を足した
2026-09-29 / T02 / acceptance の driver は MCP を起動せず、各ツールと同じ関数を直接呼ぶ作りだった / export の step も `exportPath` と `exportDecisions` を直接呼び、本物の入口は plugin のテストで export を呼んで確かめた。書き出しが成功する経路を本物の入口で通すのは A5 の headless 実行で見る
2026-09-29 / T03 / README と README.ja に各 Skill の説明行があった / 同じ形で export の行を足し、変更欄に `README.md`・`README.ja.md` を足した
2026-09-29 / T04 / T01 の Codex レビュー: 検査と書き込みの間のシンボリックリンクのすり替え（高）、制約を置き換えた決定の連なりに制約が出る（中）、別プロジェクトの同じキー（中）、大きな引用でスタックがあふれる（中）、ファイルを通るパス（低） / 後の 3 件は T04 で直した。1 件目は見送り: すり替えられるのはそのリポジトリにすでに書ける人だけで、検査は持ち主の入力の誤りを止めるためのもの。2 件目は見送り: 置き換えられたものは種類を問わず経緯で、`kind: constraint` と明記して出る
2026-09-29 / T05 / T02・T03 の Codex レビュー: 返答の保存先が見えない文字を除いて表示され検査したパスと違い得る（高、両方）、Skill の「1 行目のあと全部が文書」と実際の返答の 2 行の案内が合わない（中）、プロジェクトが無いときだけ isError が無い（中）、acceptance が本物の MCP の入口を通らない（中） / 前の 3 件は T05 で直した。4 件目は見送り: 成功の経路は A5 の headless 実行で、パッケージした 0.6.6 の入口から返った文書が 2 回ともそのままファイルになったことを確かめた
2026-09-29 / T06 / 全差分の Codex レビュー: 延期の決定の見直し条件が出ない（中）、PR コメントなどの引用元 URL が落ちる（中）、`..` で始まる名前を拒否する（低） / 3 件とも T06 で直した。採用の引用にも出どころ（種類と artifact）を足した
2026-09-29 / T07 / GitHub の Codex レビュー（cecb8cb、P1 なし、P2 6 件）: ハードリンクの保存先、Windows の予約名、ファイルを指すリンクの途中のフォルダー、引用の改行がつぶれる、読み取りの途中の変更、上限の判定が組み立ての後 / 予約名以外の 5 件を T07 で直した。途中の変更は reader の authorizer がトランザクションを許さないため、使った記録の revision を最後に読み直して違えば失敗にした。予約名は見送り: 書き込みが失敗するだけで、黙って別の場所に書かない端の入力
2026-09-29 / T08 / GitHub の Codex レビュー（45ccca1、P1 なし、P2 3 件）: 指示ファイルへ書き出せる（Security Review）、検査のあとに作られたファイルの上書き、1 件の決定の巨大な根拠で上限の前にメモリを使う / 1 件目を T08 で直した。大文字と小文字を区別せず、`.claude`・`.agents`・`.codex` の中全体と、解決した実際の書き込み先も見る。2 件目は見送り: 同じリポジトリで競合して書く別プロセスという端の入力で、Claude Code の Write は読んでいない既存ファイルの上書きを拒む。3 件目は見送り: glean を重ねた極端な記録という端の入力
