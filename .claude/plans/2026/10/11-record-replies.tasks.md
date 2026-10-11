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

- [ ] T01: 予算の部品を `reply-budget.ts` に移し、record サーバーの SDK のエラーを予算に収める。バージョンを 0.6.50 に上げる
  - 種別: 修正
  - 計画: S1, S10
  - 依存: なし
  - 変更: `server/src/reply-budget.ts`, `server/src/read.ts`, `server/src/mcp.ts`, `server/src/mcp-record.ts`, `server/test/record-replies.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - red: `node --import ./test/isolate-home.ts --test test/record-replies.test.ts` → 直す前は、record サーバーへの 40 KB の未知のツール名のエラーが 32,768 バイトを超えて落ちる
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(record): keep the record server's SDK errors within the reply budget, and bump to 0.6.50`

- [ ] T02: 結果の置き場（2 枠、行を分割して固定）と、続きを読む `record_more` を足す
  - 種別: 追加
  - 計画: S2
  - 依存: T01（`reply-budget.ts` の予算と `preview` が要る）
  - 変更: `server/src/result-pages.ts`, `server/src/mcp-record.ts`, `server/test/result-pages.test.ts`, `server/test/record-state.test.ts`
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `feat(record): add record_more to read the rest of a result`

## P2: record_context

ページがバイトで切られ、長い発言・長い見出し・長い最後の部分があっても、どのページも 32 KiB に収まって最後まで読める。

- [ ] T03: `record_context` のページをできあがった返答のバイト数で切り、見出しの文字列を制限し、長い発言を UTF-8 の境目で切る
  - 種別: 修正
  - 計画: S3
  - 依存: T01（`reply-budget.ts` の予算と `preview` が要る）
  - 変更: `server/src/extract.ts`, `server/test/record-replies.test.ts`, `server/test/record-state.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/record-replies.test.ts` → 直す前は、日本語の発言が続くページと、1 件が長い発言のページが 32,768 バイトを超えて落ちる
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(record): cut record_context pages by the bytes of the finished reply`

- [ ] T04: `record_context` の最後の部分を、run ごとの写しとカーソル（`t<hex8>.<n>`）でページにする
  - 種別: 修正
  - 計画: S4
  - 依存: T03（バイトで切るページの組み立てが要る）
  - 変更: `server/src/extract.ts`, `server/src/mcp-record.ts`, `server/test/record-replies.test.ts`, `server/test/record-state.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/record-state.test.ts` → 直す前は、最後の部分が 1 ページを超えると行が「left out」で落とされ、続きを読むカーソルが無くて落ちる
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(record): page the closing part of record_context with a cursor of the run`

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
