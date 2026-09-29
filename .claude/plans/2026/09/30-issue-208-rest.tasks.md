---
kind: tasks
plan: 30-issue-208-rest.plan.md
branch: fix/issue-208-rest
base: main
---

# #208 の残り 5 項目を 1 つの PR・1 リリースで終わらせる のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: harvest の穴

2 度目の harvest で前に見た source が分かり、逆向きの範囲と応答しない gh で harvest が止まらない

- [x] T01: harvest の行に `(harvested before)` を付け、バージョンを上げる
  - 種別: 修正
  - 計画: S1, S7
  - 依存: なし
  - 変更: `server/src/github.ts`, `server/src/extract.ts`, `server/test/extract.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - red: `cd server && node --test --test-timeout=60000 test/extract.test.ts` → 保存済みの harvest の後に同じ PR へ新しいコメントを足して context を取るテストで、前の source の行に `(harvested before)` が無く落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/extract.test.ts` → 前の source にだけ印が付き、新しいコメントと本文の新しい revision には付かない。`bun run release:plan -- --base v0.6.10` → `plugin`、npm と 3 つの manifest が同じ新しいバージョン。`bun run verify` → 0
  - コミット: `fix(harvest): mark sources an earlier run looked at`
  - 結果: 直す前の `node --test --test-name-pattern='marks the sources' test/extract.test.ts` → `## s2 pr_comment pr:3 by kai (MEMBER) 2026-03-02T00:00:00.000Z` が `(harvested before)` に一致せず落ちた。直した後 `node --test --test-timeout=60000 test/extract.test.ts test/github.test.ts` → 30 pass / 0 fail（前のコメントにだけ印、新しいコメントと本文の revision 2 には無し）。npm と 3 つの manifest を 0.6.11。`bun run verify` → 0

- [x] T02: 逆向き・側違いの行範囲を終わりの行だけにする
  - 種別: 修正
  - 計画: S2
  - 依存: なし
  - 変更: `server/src/github.ts`, `server/test/github.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/github.test.ts` → `start_line > line` の偽の応答で storeItems が CHECK で落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/github.test.ts` → 逆向きと `start_side !== side` は `[line, line]`、同じ側の順向きは `[start_line, line]` で保存され、harvest がほかの source も保存する。`bun run verify` → 0
  - コミット: `fix(harvest): keep only the end line of a reversed or two-sided comment range`
  - 結果: 直す前の `node --test --test-name-pattern='runs backwards' test/github.test.ts` → `CHECK constraint failed: line_end >= line_start` で落ちた。直した後 `node --test --test-timeout=60000 test/github.test.ts` → 12 pass / 0 fail（逆向き 9→3 と LEFT→RIGHT 2→5 は終わりの行だけ、RIGHT の 4→6 はそのまま、start_line が null は 7→7、本文も保存）。`bun run verify` → 0

- [x] T03: `gh api` の呼び出しに 60 秒のタイムアウトを付ける
  - 種別: 修正
  - 計画: S3
  - 依存: なし
  - 変更: `server/src/github.ts`, `server/test/github.test.ts`, `server/test/extract.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/github.test.ts` → sleep する偽 gh と短い timeout を渡すテストが、gh の終了を待ってテストの時間切れで落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/github.test.ts test/extract.test.ts` → `gh()` が `<path> did not answer within ...` で失敗し、glean_fetch の経路がそのエラーを返す。`bun run verify` → 0
  - コミット: `fix(github): stop a gh api call that does not answer`
  - 結果: 直す前の `node --test --test-timeout=20000 --test-name-pattern='never answers fails|glean: sourced' test/github.test.ts test/extract.test.ts` → 2 件とも `test timed out after 20000ms` で落ちた（timeout を受け取らず gh を待ち続ける）。直した後 同じコマンドに `size cap` を足して 3 pass / 0 fail（SIGTERM を無視する偽 gh でも `pulls/1/comments did not answer within 0.5 seconds`、glean_fetch も `issues/9 did not answer ...` で失敗）。`bun run verify` → 0

## P2: 保存でロックを持つ時間

保存の重いファイル・git の検査がロックの前に済み、ロックの中は内容のハッシュ比較だけになる

- [x] T04: anchors.ts の伏せ字の判定と symbol 探しを、読んだ内容を受け取る関数に分け、時間を測る
  - 種別: 変更
  - 計画: S4, S5
  - 依存: なし
  - 変更: `server/src/anchors.ts`, `server/test/record.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/record.test.ts` → 既存の masksSymbol / locate のケースを内容を受け取る関数にも流して同じ結果。2 MB のファイルで「読み取り＋sha256」と「判定＋symbol 探し」の時間を測り、結果行に残す（読み取りが判定と同程度なら止めて plan を見直す）。`bun run verify` → 0
  - コミット: `refactor(anchors): judge and locate a symbol in text already read`
  - 結果: `node --test --test-timeout=60000 test/record.test.ts test/search.test.ts` → 38 pass / 0 fail（伏せ字の例・範囲外・読めない・無いファイルの 8 ケースで、1 回読んだ内容への判定と位置が読み取り付きの関数と一致、同じ長さの書き換えでハッシュが変わる）。計測（Node 24、2.00 MB、7 回の中央値）: 普通のコード 読み取り＋sha256 1.0 ms / 伏せ字の判定 7.1 ms / symbol 探し 16.7 ms、行ごとにキーのあるファイル 0.9 ms / 16.7 ms / 25.2 ms。読み取りは判定の 1/7 以下なので方針 4 のまま進める。`bun run verify` → 0

- [ ] T05: trace・harvest の保存で、ファイル・git の検査をロックの前に済ませ、ロックの中は anchor ごとにハッシュを比べる
  - 種別: 修正
  - 計画: S5
  - 依存: T04（内容を受け取る判定と位置の関数が要る）
  - 変更: `server/src/extract.ts`, `server/src/record.ts`, `server/test/record.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/record.test.ts` → 書き換えていないファイルの anchor を保存するテストで、`begin immediate` から commit までに判定関数と commitHolds が呼ばれて落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/record.test.ts test/extract.test.ts` → ロックの中で判定関数と commitHolds が呼ばれない。準備の後・ロックの前の同じ長さの書き換えと、前の anchor の挿入の後の書き換えで、伏せ字の対象になった symbol が保存されない。record_check の結果が変わらない。`bun run verify` → 0
  - コミット: `fix(record): check files and commits before taking the write lock`

- [ ] T06: glean の保存で、readExcerpt と anchor の検査をロックの前に済ませる
  - 種別: 修正
  - 計画: S5
  - 依存: T05（準備の `RepoFacts` と saveText の分け方が要る）
  - 変更: `server/src/glean.ts`, `server/src/extract.ts`, `server/test/record.test.ts`
  - red: `cd server && node --test --test-timeout=60000 test/record.test.ts` → file を引く add_evidence の glean 保存で、ロックの中で git が読まれて落ちる
  - 完了条件: `cd server && node --test --test-timeout=60000 test/record.test.ts` → ロックの中で readExcerpt と判定関数が呼ばれない。unit が無い・revision が違う操作では準備のエラーが出ず、今と同じエラーになる。anchor の挿入の前の書き換えで伏せ字の対象になった symbol が保存されない。`bun run verify` → 0
  - コミット: `fix(glean): read excerpts and anchors before taking the write lock`

## P3: harvest の fork 実験

harvest を Claude Code の fork で動かしたときの文脈の増え方と保存結果が測れていて、採否が決まっている

- [ ] T07: harvest Skill を `context: fork` にし、会話履歴なしで動く文面にして計測する
  - 種別: 変更
  - 計画: S6
  - 依存: T01（計測の harvest に新しい印とバージョンが入った状態で比べる）, T05（計測する保存経路を最終の形にする）
  - 変更: `plugin/skills/harvest/SKILL.md`
  - 完了条件: plan の方針 5 の手順で前面実行と fork 実行を 1 回ずつ流し、結果行に background か否か、`$ARGUMENTS` と `disable-model-invocation` と保存行の確認、文脈の増加の 2 つの値、source の 4 つ組の一致、unit の比較、採否を残す。採らないときは SKILL.md を元に戻して `[-]` にし、記録に理由と #208 に書く文面を残す。`bun run verify` → 0
  - コミット: `feat(harvest): run the skill in a forked subagent in Claude Code`

## 記録

- 2026-09-30 / T03 / mcp-record.ts は gh() の既定値で足り、変える必要が無かった / 変更欄から `server/src/mcp-record.ts` を外した（前: github.ts, mcp-record.ts, github.test.ts, extract.test.ts）
- 2026-09-30 / T01 / Codex のレビュー F1: 後から始まった別 run が先に保存すると、先の run の context にも印が付く / 棄却。印は「context を読んだ時点で、どこかの run がもう見た」を表し、trace の `(traced before)` と同じ扱い。同じ PR を並行で harvest する場合に限られる
- 2026-09-30 / T02 / Codex のレビュー: 指摘なし（7 種類の応答の形を確かめた）/ そのまま
- 2026-09-30 / T03 / Codex のレビュー: 指摘なし。60 秒は --paginate の全ページの合計で、実際の余裕は未検証 / そのまま
- 2026-09-30 / 持ち主の指示で、終わった 29-custom-fields の plan と tasks を同じ PR で消した
