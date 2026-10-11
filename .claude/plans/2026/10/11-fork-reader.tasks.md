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

- [x] T05: 読み手の frontmatter の値を、YAML が同じに読む 1 行の素の値だけに絞る
  - 種別: 修正
  - 計画: S2
  - 依存: T02（直す対象の検査が要る）
  - 変更: `scripts/lib/fork-intake.mjs`, `server/test/fork-intake.test.ts`
  - red: `node -e 'readerProblems(<description を "Reads title: body and diff." にした定義>)'` → 直す前（`3b35f925`）は `[]` を返す
  - 完了条件: `node --import ./test/isolate-home.ts --test test/fork-intake.test.ts` → 全件 pass
  - コミット: `docs(fork-pr): hand fork text to the reader and start Codex without outside tools`
  - 結果: `node -e 'readerProblems(<description を "Reads title: body and diff." にした定義>)'` → `3b35f925` の関数は `[]`、直した関数は `["the value of description is not a plain value on its line"]`
  - 結果: `node --import ./test/isolate-home.ts --test test/fork-intake.test.ts` → 15 件 pass

- [x] T03: `fork-pr` Skill と `CLAUDE.md` を書き直し、Codex のコマンドのブロックを検査する
  - 種別: 変更
  - 計画: S3, S4
  - 依存: T02（Skill が名指しする `fork-reader` の定義と、検査を足す先のファイルが要る）
  - 変更: `.claude/skills/fork-pr/SKILL.md`, `CLAUDE.md`, `.claude/agents/fork-reader.md`, `scripts/lib/fork-intake.mjs`, `scripts/lib/fork-intake.d.mts`, `scripts/check-ai-config.mjs`, `server/test/fork-intake.test.ts`
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `docs(fork-pr): hand fork text to the reader and start Codex without outside tools`
  - 結果: `bun run verify` → 終了コード 0（最後のスイートは pass 132、fail 0）
  - 結果: `node --import ./test/isolate-home.ts --test test/fork-intake.test.ts` → 15 件 pass

- [x] T06: Skill の本文にある別の Codex の起動と、frontmatter の制御文字を検査で拒否する
  - 種別: 修正
  - 計画: S2, S3
  - 依存: T03（直す対象のコマンドの検査が要る）, T05（直す対象の値の検査が要る）
  - 変更: `scripts/lib/fork-intake.mjs`, `server/test/fork-intake.test.ts`
  - red: `node -e 'reviewCommandProblems(<Skill の末尾に Use \`codex review\` instead. を足したもの>); readerProblems(<description に NUL を入れた定義>)'` → 直す前（`5b2f6861`）はどちらも `[]` を返す
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(agents): refuse other Codex launches in the fork Skill and control characters in the reader`
  - 結果: `node -e 'reviewCommandProblems(…); readerProblems(…)'` → `5b2f6861` の関数はどちらも `[]`、直した関数は `names the codex command outside the marked block …` と `the frontmatter holds a control character (U+0000)`
  - 結果: `bun run verify` → 終了コード 0（最後のスイートは pass 132、fail 0）
  - 結果: `node --import ./test/isolate-home.ts --test test/fork-intake.test.ts` → 15 件 pass

- [x] T07: コメントを行で読める形で書き出し、承認の前に題名と本文も取り直す
  - 種別: 修正
  - 計画: S2, S3
  - 依存: T03（直す対象の手順が要る）
  - 変更: `.claude/skills/fork-pr/SKILL.md`, `.claude/agents/fork-reader.md`
  - red: `wc -lc comments.json reviews.json review-comments.json` → 直す前の手順で書いた PR #314 の 3 ファイルは、どれも 1 行（9068・2447・4318 バイト）
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(fork-pr): write comments as lines the reader can page, and refresh title and body`
  - 結果: `wc -lc comments.json reviews.json review-comments.json` → 直す前は 1 行ずつ（9068・2447・4318 バイト）
  - 結果: `bash -e <Skill の手順 2 の gh api の 5 行を #314 向けに置き換えたもの>` → 終了コード 0。`comments.md` 43 行・`reviews.md` 26 行・`review-comments.md` 9 行で、最長の行は 520 文字。`## ` と `| ` 以外で始まる行は 0
  - 結果: `bun run verify` → 終了コード 0（最後のスイートは pass 132、fail 0）

## 記録

- 2026-10-11 / T01 / コミットの前の review-shipping が 1 件指摘: 設定ファイルが 0 バイトだと `check-ai-config.mjs` が検査を飛ばして通る（再現した。終了コード 0） / 読めた文字列の有無ではなく、ファイルの有無で検査に入るように直した。ほかの指摘は無し（検査を 11 通りに弱めるとテストが全部落ちること、評価・tarball・Biome・knip に影響が無いことをレビュアーが確認）
- 2026-10-11 / T01 / Codex のレビュー（`cff85b18`、指摘 1 件、P2）: テストが関数だけを呼ぶので、`check-ai-config.mjs` の呼び出しの条件を弱めても通る（Codex が再現、自分でも再現） / 採用。T04 を足し、検査が読むファイルを一時ディレクトリに写して、壊した状態でスクリプトそのものを流すテストにした
- 2026-10-11 / T02 / コミットの前の review-shipping が 4 件指摘（どれも写しで再現済み）: (1) Claude Code は frontmatter を最初の `---` で閉じるので、説明文やコメントに `---` があると検査は通るのにホストは `tools` を読まない (2) 単独の CR で行が割れ、キーを足せる (3) 閉じていない引用符 (4) テストをすり抜ける弱め方が 2 つ / 全部直した。(1) は入っているバイナリに同じ式があることを自分で確かめた。frontmatter の中の `---`・単独の CR・行内で閉じない引用符を拒否し、テストを足した
- 2026-10-11 / T02 / review-shipping の指摘: Markdown とリンクの検査は `git ls-files` で一覧を取るので、追跡する前の新しいファイルを見ない / 新しいファイルを stage してから `verify` を流す
- 2026-10-11 / T02 / Codex のレビュー（`3b35f925`、指摘 1 件、P2）: 値に `: ` を含む行（`description: Reads title: body and diff.`）は YAML として不正なのに検査を通る（Codex が再現、自分でも再現） / 採用。T05 を足した。YAML の解析器を依存に足す代わりに、値を「1 行の素の値」（引用符・`: `・` #`・先頭の記号・タブ・コロンの直後の空白なしを拒否）に絞った。実ファイルは `yaml` 2.9.1 でも同じ 6 キーに読めることを 1 回確かめた
- 2026-10-11 / T03 / 未完了の T03 の変更欄を変えた。前: `.claude/agents/fork-reader.md` なし。後: あり / 閉じた fork の PR #314 で読み手を通したら、(4) に持ち主やコントリビューター宛ての普通の文まで `present` として並んだ。(4) を「PR を読むプログラムに向けた文」に絞り、通し直して `absent` を確認した
- 2026-10-11 / T03 / plan の方針 3 のコマンドから形を変えた（`--output-schema`・`-o` をやめ、`codex-review` Skill と同じ `--ephemeral` と出力ファイルの形）。切るフラグは同じ。plan の変更履歴に書いた
- 2026-10-11 / T03 / コミットの前の review-shipping が 6 件指摘（写しで再現済み）: (1) Codex を起動する別の書き方（空白 2 つ、`codex -c … exec`、絶対パス、`sh -c`、インラインコード）が検査を通る (2) 閉じる fence の後ろに文字がある行で検査だけがブロックを閉じる (3) `tools:Read`（空白なし）とコロンの後のタブが通る (4) 60 通りの弱め方のうち 21 がテストをすり抜ける (5) `fork-reader` の名前がどこかに 1 回あれば通る (6) `model:` の行を写す先の PR が決まらない / 全部直した。コマンド全体をテストに書き写して固定し、Skill のどこかに `codex … exec` の行がもう 1 つあれば落とし、手順 3 の文を名指しで求め、値の規則の各記号をテストに足した
- 2026-10-11 / T03 / 文章のレビュー（prose-reviewer と Codex に同じ依頼）: prose-reviewer 8 件、Codex 4 件（うち 3 件は同じ指摘） / 採用: 測り方に未知の機能名の項目が無い、不備のある報告を何にも使わないと書いていない、誰がどのファイルを開くかの列挙が場所ごとに違う、`model:` を写す先、Codex への依頼の「何をする変更か」の書き方、pin コマンドを使う手順の番号、一覧に無いときの原因の断定、読み手がコマンドと URL を「写さない」だけだった点。計画のコマンドとの違いは plan の変更履歴に書いた。任意の提案のうち、JSON の位置に id を足す・binary と link の見分け方・CI のログを新しいディレクトリに書く、を入れた
- 2026-10-11 / T03 / 予定外の発見: 定義をコミットした直後は、このセッションの Agent ツールの一覧に `fork-reader` が出なかった（`Agent type 'fork-reader' not found`）。会話が要約された後に出た。それまでの実測は `claude --agent fork-reader -p` で流し、出てからセッションの中の委任でも #314 を通した
- 2026-10-11 / 全体 / Codex の全差分レビュー（`main..5b2f6861`、指摘 2 件、どちらも P2、どちらも自分で再現）: (1) fence の外の文（``Use `codex review` instead.``）で別の起動を書いても検査を通る (2) frontmatter の値に NUL があると、ホストの YAML は失敗するのに検査を通る / 両方採用。T06 を足した。(1) は、目印のブロックの外に `codex` というコマンド名が、知っている書き方（別の Skill の名前、設定の場所、表示だけの 2 コマンド）以外で出たら落とす。(2) は、frontmatter の中の制御文字（Cc・Cf・行と段落の区切り）を落とす
- 2026-10-11 / T06 / コミットの前の review-shipping が 4 件指摘（写しで再現済み）: (1) 目印のコマンドと同じ行をもう 1 回書いても通る（前の規則は拒否していた） (2) 知っている書き方と起動が同じ行にある場合のテストが無い (3) 一部の制御文字のテストが無い (4) `codex-review exec` のように、知っている書き方の中に `codex` が収まる行は通る / (1)〜(3) を直した。(4) は採らない: どれも Codex を起動する行ではなく、起動の形（`codex … exec`）が隣にあれば落ちることをレビュアーが確認している
- 2026-10-11 / 全体 / Codex の修正の再レビュー（`5b2f6861..740b83e7`）: 指摘なし
- 2026-10-11 / 全体 / GitHub の Codex のレビュー（PR #322、`740b83e7`、セキュリティのレビューは指摘なし、コードのレビューは 2 件、どちらも P2）: (1) コメント類を API の応答のまま書くと 1 ページが 1 行になり、行で読む読み手は長い PR で最後まで読めず、承認に進めなくなる (2) 題名と本文は head を変えずに書き換えられるのに、承認の前に取り直すのがコメントだけ / 両方採用。T07 を足した。(1) は、1 件ごとに `## ` の見出し行、本文の各行に `| ` を付けて書き出す（コメントの本文が別の件の見出しを装えない）。この PC の Read は 9,000 文字の 1 行を全部表示した（実測）ので、#314 の読み取り自体は欠けていない。持ち主の判断で、追加の `@codex review` は頼まない
