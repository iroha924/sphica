---
kind: tasks
plan: 11-fork-reader.plan.md
branch: chore/fork-reader
base: main
---

# fork の PR の文章を、承認の前は読む道具しか持たないエージェントに読ませ、持ち込むコマンドを設定で断る のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 設定と読み手を置く

`gh pr checkout` とその別名を設定が断り、読む道具しか持たない `fork-reader` が使えるようになる。どちらも、形が崩れると検査が落ちる。

- [x] T01: `.claude/settings.json` に deny の 3 行を置き、その形を検査する
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `.claude/settings.json`, `scripts/lib/fork-intake.mjs`, `scripts/lib/fork-intake.d.mts`, `scripts/check-ai-config.mjs`, `server/test/fork-intake.test.ts`
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `chore(agents): deny gh pr checkout and its aliases in the project settings`
  - 結果: `bun run verify` → 終了コード 0（最後のスイートは pass 132、fail 0）
  - 結果: `node --import ./test/isolate-home.ts --test test/fork-intake.test.ts` → 4 件 pass
  - 結果: `node scripts/check-ai-config.mjs` → 設定ファイルが空のとき終了コード 1（`not JSON`）、無いとき終了コード 1（ENOENT）、元に戻すと 0

- [x] T02: 読む道具しか持たないエージェント `fork-reader` を置き、その frontmatter を検査する
  - 種別: 追加
  - 計画: S2
  - 依存: T01（検査の関数とテストを足す先の `scripts/lib/fork-intake.mjs` と `server/test/fork-intake.test.ts` が要る）
  - 変更: `.claude/agents/fork-reader.md`, `scripts/lib/fork-intake.mjs`, `scripts/lib/fork-intake.d.mts`, `scripts/check-ai-config.mjs`, `server/test/fork-intake.test.ts`
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `chore(agents): add a fork-reader agent that holds only read tools`
  - 結果: `bun run verify` → 終了コード 0（最後のスイートは pass 132、fail 0）
  - 結果: `node --import ./test/isolate-home.ts --test test/fork-intake.test.ts` → 11 件 pass
  - 結果: `LC_ALL=C grep -a -o '/\^---\\s\*\\n(\[\\s\\S\]\*?)---\\s\*\\n?/' ~/.local/share/claude/versions/2.1.296` → 1 件（Claude Code が frontmatter を最初の `---` で閉じる式が、入っているバイナリにある）

- [x] T04: `check-ai-config.mjs` の呼び出し側を、壊した木の写しで実行するテストで押さえる
  - 種別: 修正
  - 計画: S1, S2
  - 依存: T01（押さえる対象の呼び出しが要る）
  - 変更: `server/test/fork-intake.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/fork-intake.test.ts` → 呼び出しの条件を `if (settingsText)`・`if (readerText)` に弱めると、足した 2 件が失敗する
  - 完了条件: `node --import ./test/isolate-home.ts --test test/fork-intake.test.ts` → 全件 pass
  - コミット: `chore(agents): add a fork-reader agent that holds only read tools`
  - 結果: `node --import ./test/isolate-home.ts --test test/fork-intake.test.ts` → 呼び出しの条件を弱めた状態で 10 件中 2 件 fail、設定の検査の呼び出しを空にした状態で 1 件 fail、元に戻して 10 件 pass（その後の追加で 11 件 pass）

## P2: 受け入れの手順を新しい形にする

`fork-pr` Skill が、承認の前の読み取りを `fork-reader` に渡し、Codex を外へつながる道具なしで起動する手順になる。

- [ ] T03: `fork-pr` Skill と `CLAUDE.md` を書き直し、Codex のコマンドのブロックを検査する
  - 種別: 変更
  - 計画: S3, S4
  - 依存: T02（Skill が名指しする `fork-reader` の定義と、検査を足す先のファイルが要る）
  - 変更: `.claude/skills/fork-pr/SKILL.md`, `CLAUDE.md`, `scripts/lib/fork-intake.mjs`, `scripts/lib/fork-intake.d.mts`, `scripts/check-ai-config.mjs`, `server/test/fork-intake.test.ts`
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `docs(fork-pr): hand fork text to the reader and start Codex without outside tools`

## 記録

- 2026-10-11 / T01 / コミットの前の review-shipping が 1 件指摘: 設定ファイルが 0 バイトだと `check-ai-config.mjs` が検査を飛ばして通る（再現した。終了コード 0） / 読めた文字列の有無ではなく、ファイルの有無で検査に入るように直した。ほかの指摘は無し（検査を 11 通りに弱めるとテストが全部落ちること、評価・tarball・Biome・knip に影響が無いことをレビュアーが確認）
- 2026-10-11 / T01 / Codex のレビュー（`cff85b18`、指摘 1 件、P2）: テストが関数だけを呼ぶので、`check-ai-config.mjs` の呼び出しの条件を弱めても通る（Codex が再現、自分でも再現） / 採用。T04 を足し、検査が読むファイルを一時ディレクトリに写して、壊した状態でスクリプトそのものを流すテストにした
- 2026-10-11 / T02 / コミットの前の review-shipping が 4 件指摘（どれも写しで再現済み）: (1) Claude Code は frontmatter を最初の `---` で閉じるので、説明文やコメントに `---` があると検査は通るのにホストは `tools` を読まない (2) 単独の CR で行が割れ、キーを足せる (3) 閉じていない引用符 (4) テストをすり抜ける弱め方が 2 つ / 全部直した。(1) は入っているバイナリに同じ式があることを自分で確かめた。frontmatter の中の `---`・単独の CR・行内で閉じない引用符を拒否し、テストを足した
- 2026-10-11 / T02 / review-shipping の指摘: Markdown とリンクの検査は `git ls-files` で一覧を取るので、追跡する前の新しいファイルを見ない / 新しいファイルを stage してから `verify` を流す
