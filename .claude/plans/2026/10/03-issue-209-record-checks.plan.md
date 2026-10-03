---
kind: plan
status: approved
codex_session: 01a0ff77-4a94-7ca1-abd4-f01f35542c17
codex_rounds: 3
approved_at: 2026-10-03
---

# Record checks warn about wrong anchors, read shows moved files and aliases, unsourced records say they cannot become active, and glean replaces aliases

## 要点

- `record_check`（trace・harvest・glean）で、作業ツリーに無いパス、ディレクトリ、ファイルに見つからない symbol を problem（警告）として出し、近いパスを添える。保存は止めず、anchor も落とさない
- `read` で、ファイルが無くなった anchor に commit があれば `git diff -M` で移動先の候補を出す。記録の aliases（検索用）も出し、as-of の read では当時の組を出す
- unsourced の記録への `add_evidence` / `adopt` に「active にならず、フラグも消えない」と problem を出す。glean Skill に、出典が見つかったら後継で置き換える手順を書く
- glean に `replace_aliases` op を足す（#174）。引用は不要、revision は既存のトリガーで上がる
- 実験 3 項目は入れない。#209 は開いたままにする
- schema と delivery は変えない。0.6.25 で出す

## 持ち主の決定

- epic #200 の次は #209 の Fix 部分（「うん、#209で問題ない」）
- 実験項目をこの計画に入れるかは Codex との議論で決める（議論で入れないと決めた）

## 目的

- 存在しないパス・ディレクトリ・見つからない symbol に anchor を付けた記録を保存しようとすると、check と save の出力に理由と近いパスが出る
- ファイルが移動して missing になった anchor を `read` すると、移動先の候補か「rename not checked」が出る
- unsourced の記録に出典や採用を足したとき、active にならないことと、candidate なら後継で置き換える手順が出力と Skill で分かる
- glean の `replace_aliases` で、新しい alias で記録が見つかり、外した alias で見つからなくなる。as-of の read では変更前の組が見える

## 対象外

- 実験 3 項目（後の取り消しの警告、同じセッションで delivery された記録の言い直しを新しい記録として保存することの検出、秘密の形の追加）: どれも fixture か持ち主のトレースでの測定が要り、Fix と同じ PR では測定待ちになる。#209 に残し、別の計画にする
- delivery が rename を追うこと、保存済みの anchor を書き換えること: 表示だけにする
- commit の中身での symbol の検査: 間違いの例が見つかっていないのに、anchor ごとに git を 1 回増やすことになる
- 追跡されていない移動先の rename: `git diff` が拾わない。制限として書く
- unsourced のフラグを消すこと（棄却した案を参照）
- read の MCP に as-of の引数を足すこと

## 前提

- anchor の検査は形だけで、ファイルや symbol があるかは見ない: `server/src/record.ts:520-556`。`symbolAt` は保存のときに行番号を埋めるだけ（record.ts:884-901）
- check と save は同じ `checkRecord` / `checkGlean` を通る（`server/src/extract.ts:409`, `:435`）。`Checked.errors` は保存を止め、`problems` は止めない（record.ts:175-185）
- 作業ツリーと git はロックの前に `RepoFacts`（`server/src/repo-facts.ts`）で読む。ロックの中では `refresh` でファイルを読み直し、ハッシュを比べるだけ（record.ts:887、glean.ts:737）
- `evidence` anchor は、同じセッションに同じパスの `edit_observation` があれば、それに結び付く（record.ts:542-553）。implementation はこれを根拠に active になれる（`db/schema.sql:573`）。この edit_observation はファイルの削除も含む
- `fileState` はファイルの種類を返さず、`readRepoText` はディレクトリ・大きいファイル・symlink を読めないものとして扱う（`server/src/anchors.ts:25`, `:135`。Codex が実測: `server/src` は present / text undefined / unknown）
- `commitHolds`（`server/src/git.ts:16`）は ls-tree でファイルがあることを見るだけ。`cleanGit` は同期で、出力は既定 1 MiB まで、10 秒で打ち切る
- unsourced: `db/schema.sql:283` の CHECK と `:478` のトリガーで active にならず、`unit_text_frozen`（:296-299）で更新できない。立てるのは `server/src/glean.ts:288-294` だけ。glean の `adopt` は採用の引用を保存し、active にできないエラーを受け止めて candidate のまま返す（glean.ts:649, :719, :888）。withdrawn の unsourced もある（`server/test/extract.test.ts:827`）
- supersedes の根拠は evidence か adoption の引用でよく（record.ts:468）、adoption が要るのは decision と constraint だけ（record.ts:490）
- alias の insert は `unit_rev_alias_i`（schema.sql:871）で revision を上げる。`unit_alias` は content_hash の一致が必須で（:597）、更新はできない（:603）。検索は hash の一致する最新の組だけ（:889, :917）
- trace の aliases は trim と重複除去をし、空と 40 文字超の要素を problem として捨てる（record.ts:591-596, :671）
- `read`（`server/src/read.ts:72`）は aliases を読まない。受け入れケースの driver は readUnit の asOf を使える（`server/evals/acceptance/driver.ts:582`）
- `git diff <commit>` は commit と作業ツリーを比べる。`-M` は似ているかで rename を推し量り、`-l` で総当たりの数を抑えられる（https://git-scm.com/docs/git-diff 、Codex が 2026-10-03 に確認）
- version は `plugin/package.json`、`plugin/.claude-plugin/plugin.json`、`plugin/.codex-plugin/plugin.json`、`.claude-plugin/marketplace.json` で、今は 0.6.24

## 方針

1. anchor の検査（`checkRecord` と、`checkGlean` の `anchor` / `replace_anchor` の行き先）
   - `RepoFacts` に、パスごとの種類 `file` / `directory` / `gone` / `unknown` を足す。`unknown` は root が無い、repo の外へ出る symlink、権限エラー。大きいファイルやバイナリは `file` として扱い、symbol は見ない（本文が読めない）
   - 検査しない anchor: repository が持つ commit（`commitHeld` が真）付きの anchor（過去の証拠。symbol も見ない）。`gone` で、role が `evidence` で、このセッションにそのパスの `edit_observation` がある anchor（セッションで消したファイル）。`unknown`
   - problem（保存は続け、anchor も残す）
     - `gone`: `<key>: anchor path <p> is not in the working tree` に、`git ls-files -z` から近いパスを最大 3 件添える（同じ basename を先に、次にパスの編集距離が小さい順）。`ls-files` は `gone` のときだけ、ロックの前に 1 回流す
     - `directory`: `<key>: anchor path <p> is a directory; anchor a file`
     - `file` で symbol が見つからない（`findSymbol` が -1）: `<key>: symbol <s> is not found in <p>`
     - 文には「直して check し直す。正しいと分かっているならそのまま保存してよい」を添える
   - ロックの中で `refresh` が中身の変化を見つけたら、種類と symbol をもう一度判定して save の出力に problem を出す。ロールバックはしない。近いパスはロックの中では探さず、「near paths not checked」と書く
   - masked symbol の扱いと `repoPath` の形の検査は変えない
2. `read`
   - `checkAnchor` が `missing` で、ファイル自体が無く、`commit_sha` がある anchor について、1 回の read の中で commit ごとに 1 回だけ `git diff -M -l1000 --name-status -z <commit> --` を流し、anchor の間で結果を使い回す。`R<score>` の行で元のパスが一致したら `may have moved to <new> since <commit 12 桁>` を足す。commit が無い・タイムアウト・出力の上限を超えたら `rename not checked`。commit_sha の無い anchor は追わない
   - 記録の今の alias の組を `aliases (search only): ...` の 1 行で出す。readUnit の as-of では、content_hash が一致し、その時刻までに足された最新の組を出す。空の組なら出さない
3. unsourced
   - glean の `add_evidence` か `adopt` の対象が unsourced なら problem `<unit> is unsourced and cannot become active; adding evidence or adoption does not clear the flag`。対象が candidate なら「後継で置き換える」案内を続ける。引用は今どおり保存する
   - glean Skill に手順を書く。GitHub の出典なら `glean_fetch` で取り、取った ref を後継の evidence に引く。ファイルの出典なら、古い記録に `add_evidence` で抜粋を足し、`read` でその抜粋の source ref を見て後継に引く。supersedes の根拠の引用は後継の evidence か adoption に入れる。adoption が要るのは decision と constraint を active にするときだけ
4. `replace_aliases`（#174）
   - `{ op: "replace_aliases", unit, revision, aliases: string[] }`。引用は無い
   - trim と重複除去は trace と同じにする。空の要素、40 文字超の要素、13 件以上は error（捨てない）。消すのは明示の `[]` だけ
   - 今の `content_hash` で `unit_alias` に 1 行足す。revision の検査と project の検査は今の glean の経路に乗る
   - glean Skill の op の表に、使う場面（翻訳が欠けた、alias が広すぎて検索が埋まる）と一緒に足す
5. テスト
   - 4 つの Fix それぞれ、直す前のコードで落ち、直した後に通るテストを、実 SQLite（`server/test/temp-db.ts`）で書く
   - ケース: 存在しないパス（近いパス付き）、ディレクトリ、存在するファイルで symbol が違う（編集したファイル `src/date.ts` に `toStored`、symbol `toStore`）、セッションで消したファイルの evidence anchor（problem なし）、commit 付きの古い harvest（problem なし）、root が無い、`unknown`、check と save の間の削除、ロック中に git を流さない（今の Probe の形）、rename が見つかる / 見つからない / 失敗する、unsourced への add_evidence と adopt、unsourced の decision と finding を後継で置き換える、aliases（本文に無い alias で検索、as-of の read、`[]` で消す、古い revision、空白だけの要素、41 文字、13 件）
   - 受け入れケースを足す: anchor の problem、`replace_aliases`、unsourced への add_evidence。`server/test/acceptance-cases.test.ts` の glean の件数を直す
6. リリース: version を直す前に `bun run release:plan -- --base v0.6.24` を流し、`plugin` なら npm と 3 つの manifest を 0.6.25 にする

## 採った案と棄却した案

- 採用: 間違った anchor は problem にして anchor を残す。棄却: error で保存を止める（セッションで消したファイルの証拠や、古い PR の harvest が保存できなくなる）。棄却: problem にして anchor を落とす（記録が届く場所が黙って減る）
- 採用: edit_observation で検査しないのは、`gone` の evidence anchor だけ。棄却: edit_observation があれば検査しない（編集したファイルの symbol の打ち間違いを見逃す）
- 採用: repository が持つ commit 付きの anchor は検査しない。棄却: commit の blob で symbol を見る（間違いの例が無いのに、anchor ごとに git を 1 回増やす）
- 採用: unsourced への `adopt` は problem にし、引用は保存する。棄却: error にする（今は保存を受け止めて candidate で返している。同じ保存の他の op まで止まる）
- 採用: unsourced のフラグは消さず、後継で置き換える。棄却: 会話の外の出典を足したらトリガーでフラグを消す（`unit_text_frozen` が保存のときの中身を凍らせる規則が崩れ、schema revision が要る）
- 採用: `replace_aliases` で不正な要素は error。棄却: trace と同じく捨てる（`[" "]` が空の組になり、今の aliases を黙って消す）
- 採用: 実験 3 項目は別の計画にする。棄却: この PR に入れる（測定が終わるまで Fix を出せない）

## 手順

- S1: `RepoFacts` にパスの種類と `ls-files` の近いパスを足し、`checkRecord` と `checkGlean` で anchor の problem を出す。ロックの中での再判定。テストと受け入れケース。trace と glean Skill の文
- S2: `read` で rename の候補を出す。テスト
- S3: `read` と as-of の read で aliases を出す。テスト
- S4: unsourced への `add_evidence` / `adopt` の problem と、glean Skill の後継の手順。テストと受け入れケース
- S5: glean の `replace_aliases` op、テスト、受け入れケース、glean Skill
- S6: `release:plan`、version を 0.6.25 に、リリースノート

## 完了条件

- A1: `bun run verify` → exit 0
- A2: `git worktree add <tmp> main` に S1・S4・S5 の新しいテストだけを写して `cd server && node --test test/extract.test.ts test/record.test.ts` → 落ちる（パスが無い・ディレクトリ・symbol が違う anchor が problem 無しで保存される / unsourced への add_evidence に problem が出ない / `replace_aliases` が unknown discriminator で拒まれる）。ブランチでは通る
- A3: 同じ worktree に S2・S3 のテストを写して `cd server && node --test test/record.test.ts` → 落ちる（移動先と aliases の行が出ない）
- A4: `cd server && node --test --test-name-pattern="replace_aliases" test/extract.test.ts` → 新しい alias で見つかる、外した alias で見つからない、古い revision は拒まれる、as-of の read で前の組が出る
- A5: `bun run release:plan -- --base v0.6.24` → `plugin`。npm と 3 つの manifest が 0.6.25
- A6: `npm pack` を repository の外で展開し `node <展開先>/package/dist/cli.js --version` → `0.6.25`。`rg -c replace_aliases <展開先>/package/dist/mcp-record.js` → 1 以上

## リスク

- 今の trace で、ディレクトリや移動したファイルに付けていた anchor に problem が増える → 保存は止まらない。文に直し方を書く。受け入れケースで、problem の出ない例（消したファイル、commit 付き）を固定する
- 大きいリポジトリで `git ls-files` が遅い → `gone` のときだけ、ロックの前に 1 回。10 秒を超えたら近いパスを付けずに problem を出す
- `git diff -M` が大きい履歴で遅い → `-l1000`、commit ごとに 1 回、失敗したら `rename not checked`

## 未解決

なし

## 変更履歴
