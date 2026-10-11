---
kind: tasks
plan: 11-record-replies.plan.md
branch: fix/record-replies
base: main
---

# record サーバーの返答を、状態と持ち主の確認を失わずに 32 KiB に収める（#324） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 共通の部品（予算、結果の置き場、record_more）

両サーバーが同じ予算の部品を使い、record サーバーのエラーが 32 KiB に収まり、収まらなかった結果の続きを読むツールができる。

- [x] T01: 予算の部品を `reply-budget.ts` に移し、record サーバーの SDK のエラーを予算に収める。バージョンを 0.6.50 に上げる
  - 種別: 修正
  - 計画: S1, S10
  - 依存: なし
  - 変更: `server/src/reply-budget.ts`, `server/src/read.ts`, `server/src/mcp.ts`, `server/src/mcp-record.ts`, `server/test/record-replies.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - red: `node --import ./test/isolate-home.ts --test test/record-replies.test.ts` → 直す前は、record サーバーへの 40 KB の未知のツール名のエラーが 32,768 バイトを超えて落ちる
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(record): keep the record server's SDK errors within the reply budget, and bump to 0.6.50`
  - 結果: `node --import ./test/isolate-home.ts --test test/record-replies.test.ts` → 直す前（部品を移しただけで、record サーバーの送信を包む前）は 1 件 fail（40 KB の未知のツール名のエラーが 40,033 バイト）、包んだ後は pass
  - 結果: `bun run verify` → 終了コード 0

- [x] T02: 結果の置き場（2 枠、行を分割して固定）と、続きを読む `record_more` を足す
  - 種別: 追加
  - 計画: S2
  - 依存: T01（`reply-budget.ts` の予算と `preview` が要る）
  - 変更: `server/src/result-pages.ts`, `server/src/mcp-record.ts`, `server/test/result-pages.test.ts`, `server/test/record-state.test.ts`
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `feat(record): add record_more to read the rest of a result`
  - 結果: `node --import ./test/isolate-home.ts --test test/result-pages.test.ts test/record-state.test.ts` → 8 件 pass（置き場 7 件、MCP 経由の `record_more` 1 件）
  - 結果: `bun run verify` → 終了コード 0

## P2: record_context

ページがバイトで切られ、長い発言・長い見出し・長い最後の部分があっても、どのページも 32 KiB に収まって最後まで読める。

- [x] T03: `record_context` のページをできあがった返答のバイト数で切り、見出しの文字列を制限し、長い発言を UTF-8 の境目で切る
  - 種別: 修正
  - 計画: S3
  - 依存: T01（`reply-budget.ts` の予算と `preview` が要る）
  - 変更: `server/src/extract.ts`, `server/test/record-replies.test.ts`, `server/test/record-state.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/record-replies.test.ts` → 直す前は、日本語の発言が続くページと、1 件が長い発言のページが 32,768 バイトを超えて落ちる
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(record): cut record_context pages by the bytes of the finished reply`
  - 結果: `node --import ./test/isolate-home.ts --test test/record-replies.test.ts` → 直す前（`5a1f4904`）は 3 件 fail: 日本語の発言が続くページが 55,092 バイト、長い 1 件の発言のページが 47,154 バイト、長い見出しのページが 80,464 バイト。直した後は pass
  - 結果: `bun run verify` → 終了コード 0

- [x] T04: `record_context` の最後の部分を、run ごとの写しとカーソル（`t<hex8>.<n>`）でページにする
  - 種別: 修正
  - 計画: S4
  - 依存: T03（バイトで切るページの組み立てが要る）
  - 変更: `server/src/extract.ts`, `server/src/mcp-record.ts`, `server/test/record-replies.test.ts`, `server/test/record-state.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/record-state.test.ts` → 直す前は、最後の部分が 1 ページを超えると行が「left out」で落とされ、続きを読むカーソルが無くて落ちる
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(record): page the closing part of record_context with a cursor of the run`
  - 結果: `node --import ./test/isolate-home.ts --test test/record-replies.test.ts test/record-state.test.ts` → 直す前（`5a1f4904`）は、最後の部分が長いページが 46,660 バイトで fail（行は「left out」で落とされる）。直した後は 15 件 pass
  - 結果: `bun run verify` → 終了コード 0

## P3: 結果を返すツール

check・save・fetch・forget の返答が、結論と件数を先頭に出して 32 KiB に収まり、続きを `record_more` で読める。

- [ ] T05: `record_check`・`record_save` の返答を、結論と件数が先頭・拒否も固定・続きは `record_more` にする
  - 種別: 修正
  - 計画: S5
  - 依存: T02（結果の置き場と `record_more` が要る）
  - 変更: `server/src/extract.ts`, `server/src/mcp-record.ts`, `server/test/record-replies.test.ts`, `server/test/record-state.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/record-replies.test.ts` → 直す前は、エラーの多い record の check と、40,000 文字の未知のキーの check が 32,768 バイトを超えて落ちる
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(record): lead check and save replies with the verdict, and page the rest`

- [ ] T06: `glean_fetch` の返答を、件数が先頭・続きは `record_more` にする
  - 種別: 修正
  - 計画: S6
  - 依存: T02（結果の置き場と `record_more` が要る）
  - 変更: `server/src/extract.ts`, `server/src/mcp-record.ts`, `server/test/record-replies.test.ts`, `server/test/record-state.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/record-replies.test.ts` → 直す前は、コメント 300 件の issue の fetch が 32,768 バイトを超えて落ちる
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(glean): lead the fetch reply with the count, and page the list of sources`

- [ ] T07: `forget_preview`・確認ダイアログ・`forget_apply` が、全 source・件数・注意書きを必ず出し、記録は 4 種類の件数とページにする
  - 種別: 修正
  - 計画: S7
  - 依存: T02（結果の置き場と `record_more` が要る）
  - 変更: `server/src/forget.ts`, `server/src/mcp-record.ts`, `server/test/forget.test.ts`, `server/test/record-replies.test.ts`, `server/test/record-state.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/record-replies.test.ts` → 直す前は、数百件の記録が引用する source の preview が 32,768 バイトを超えて落ちる
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(forget): always show every source and the count, and page the affected records`

## P4: 受信バッファの上限

受信バッファが 10 MiB を超えたとき、両サーバーが黙って終わらず、stderr の 1 行と終了コード 1 で終わる。

- [ ] T08: 受信バッファの上限超過のときだけ、stderr に 1 行を書いて終了コード 1 で終わる（両サーバー）
  - 種別: 修正
  - 計画: S8
  - 依存: なし
  - 変更: `server/src/stdio-limit.ts`, `server/src/mcp.ts`, `server/src/mcp-record.ts`, `server/test/stdio-limit.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/stdio-limit.test.ts` → 直す前は、10 MiB を超える要求で両サーバーが終了コード 0・stderr 空で終わって落ちる
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(mcp): exit with an error when the receive buffer passes its limit`

## P5: Skill と文書

trace・harvest・glean・forget の Skill が、新しい返答の形とカーソルに沿って最後まで進める。

- [ ] T09: 4 つの Skill の allowed-tools に `record_more` を足し、結論が先頭の形・`t` のカーソル・続きの読み方に合わせる。README も合わせる
  - 種別: 変更
  - 計画: S9
  - 依存: T04（`t` のカーソルの形が要る）, T05（check と save の返答の形が要る）, T06（fetch の返答の形が要る）, T07（forget の返答の形が要る）
  - 変更: `plugin/skills/trace/SKILL.md`, `plugin/skills/harvest/SKILL.md`, `plugin/skills/glean/SKILL.md`, `plugin/skills/forget/SKILL.md`, `README.md`, `README.ja.md`
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `docs(skills): follow the record server's paged replies and record_more`

## 記録
- 2026-10-11 / T01・T02 / 1 回目の `bun run verify` が 1 件 fail: `plugin.test.ts` の「全ツールが未知の引数を名前で断る」が、新しい `record_more` の正しい引数を持っていなかった / テストの一覧に `record_more` を足した（ツールの一覧を固定するテストにも足した）
- 2026-10-11 / T02 / コミットの前の Codex のレビュー（作業ツリーと `2dab50c9` の差分、新しい会話）が 3 件指摘、どれも再現: (1) P2: 行位置が 7 桁になると、サーバー自身が出した続きのカーソルを断る (2) P2: 枠付きの結果は、同じカーソルで枠の id が毎回変わり同じページにならない (3) P3: 分割した最後の断片が 4,096 バイトを 4 バイト超える / 3 件とも採用。先に落ちるテストを書いた。(1) は位置を 15 桁まで、(2) は枠の id を結果を持つときに 1 回だけ引く（`frame.ts` の `framed` が id を受け取れるようにした。`frame.ts` は変更欄に無いが、この直しに要る）、(3) は印の 4 バイトを数える
- 2026-10-11 / T01・T02 / コミットの前の review-shipping（出荷は可の判定）が 4 件: (1) レビュー中に作業ツリーが動いた（上の Codex の直し。取り直して全部やり直したとのこと） (2) `pieces` が分割しないように弱めると、テストが落ちずに終わらなくなる (3) `deliver.js` が 64 バイト増えた（`withinBudget` の注意書きの文字列が hook の bundle に入る。残り 1,545 バイト） (4) 4 つの Skill の allowed-tools に `record_more` が無い / (2) はテストの読み進めに「カーソルが必ず前へ進む」の検査を足した。(3) は注意書きの文字列を関数の中で作る形にした。(4) は T09 で入れる（同じ PR・同じリリース）。review-shipping の実測: pack した `mcp-record.js` はツール 11 個、40 KB の未知のツール名のエラーは 32,768 バイトで `isError`、`mcp.js` の出力はバージョン以外 main と同じ
- 2026-10-11 / T03・T04 / 同じ関数（`contextText`）の書き換えなので 1 つのコミットにした。ページの大きさを文字数で前提にしていた既存のテスト 6 件（`extract.test.ts` 4 件、`auto-pending.test.ts` 2 件）を、バイトの上限と `t` のカーソルに合わせて直した。「最後の部分が長いと行を落とす」を固定していたテストは、「落とさずにカーソルで続く」に書き換えた
- 2026-10-11 / T03 / 計画の説明と違った点: 英数字が中心のセッションでは 1 ページがむしろ大きくなる（UTF-16 で 20,000 文字 ≒ 20 KB から 32 KiB へ）。自動の trace が 1 回に読む量は、日本語では減り、英語では増える。PR の本文に両方向として書く
- 2026-10-11 / T03・T04 / コミットの前の Codex のレビュー（作業ツリーと `5a1f4904` の差分、新しい会話）が 2 件指摘、どちらも再現: (1) P1: 発言の中の端末の制御の列（閉じていないもの、切れ目にかかるもの）で、枠の `plain` が後ろをまとめて消し、切った位置の案内・カーソル・次の発言が消える。見せていない発言まで見た扱いになる (2) P2: 同じ run の最初のページを並行で読むと、先に返したカーソルが無効になる / 両方採用。先に落ちるテストを書いた。(1) は発言ごとに `plain` にかけ、切る位置は `read` と同じ規則（列の中で切らない）にした（`read.ts` に `shownStart` を足し、`readRefs` と同じ `cutEnd` を使う。`read.ts` は変更欄に無いが、この直しに要る）。(2) は、await の後で `shownTo` の今の値を取り直して同じ run の状態を共有する。(1) は直す前のコードでも起きる（review-shipping が HEAD で再現）
- 2026-10-11 / T03・T04 / コミットの前の review-shipping（手数の上限で一度止まり、報告を頼み直した。最初の写しと、上の直しの後の写しの両方を見たとのこと。後のほうは出荷可の判定）: 実際の record サーバーに 4 通りの大きな入力（trace: 45 KB の session id・4,000 件の編集・200 件のフィールド、harvest: 24 KB の artifact、glean、自動の trace を 16 回）を流し、最大のページは 32,536 バイト、上限超えは 0、全 source と最後の部分の全行に届く。同じ入力で直す前は最大 110,746 バイト。`read s<id>@<byte>` の続きは 15 通りで `plain(保存された本文)` と一致。指摘 3 件: (1) 列の中で切るケースを通すテストが無い（`cutEnd` に列の範囲を渡さなくても全部通る） (2) 最後の部分を毎回作り直す・`t` のページでページ数を増やす、の 2 通りの弱め方を落とすテストが無い (3) `contextText` の上のコメントが古い / 3 件とも採用。(1) は `shownStart` を全部の room の値で確かめるテストを足し、弱めると落ちることを自分で確かめた。(2) は、最後の部分を読んだ後に編集を足しても同じページが返ること、最後の部分を読んだ後も対象のページが同じことを確かめるテストを足した。Skill の古くなった文の一覧は T09 で使う
