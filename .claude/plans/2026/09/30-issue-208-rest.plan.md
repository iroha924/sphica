---
kind: plan
status: approved
codex_session: 01a0ee9b-ce66-7973-946f-fb6c486eb6dc
codex_rounds: 4
approved_at: 2026-09-30
---

# #208 の残り 5 項目を 1 つの PR・1 リリースで終わらせる

## 要点

- harvest の context で、前の run が見た source の行に `(harvested before)` を付ける
- review comment の行範囲が逆向き・左右の側が違うときは終わりの行だけにして、harvest 全体が CHECK で落ちないようにする
- `gh api` の呼び出し（harvest_begin と glean_fetch）に 60 秒のタイムアウトを付ける
- record_save で、git とファイルの重い検査を書き込みロックの前に済ませる。ロックの中では anchor ごとにファイルの内容のハッシュだけを比べ、変わったファイルだけ伏せ字の判定と位置をやり直す
- 実験: harvest Skill を Claude Code の `context: fork` で動かし、文脈の増え方と保存結果を測る。条件を満たさなければ外して結果を #208 に書く
- 変えないもの: schema、接続ロール、record の形、MCP ツールの引数

## 持ち主の決定

- #208 の残り 5 項目を 1 計画・1 PR・1 リリースで終わらせ、#208 を閉じる
- 済んでいる 2 項目（record_context のページ送り、trace_pending の件数）は issue のチェックを付ける。ページ送りが issue の書き方（`capped`、`_meta["anthropic/maxResultSizeChars"]`）と違う点は PR 本文に残す
- 修正は直す前のコードで落ちるテストを先に書く
- fork は実験として最後に置く

## 目的

- 2 度目の harvest で、前に見た source と新しい source を行の印で見分けられる
- GitHub が逆向きの範囲を返しても harvest_begin が保存まで進む
- 応答しない gh で harvest_begin と glean_fetch が 60 秒を超えて止まらない
- 保存でロックを持つ間に、コミットの読み取り（`commitHolds`、`readExcerpt`）と、内容の変わっていないファイルの伏せ字判定・symbol 探しが走らない
- fork の採否が、下の方針 5 の計測で決まっている

## 対象外

- #178（フックがログを書いてから答える順番）。同じロックを待つ側だが原因が別
- LEFT 側の行番号を新しいファイルの行へ読み替えること。source の行は表示にしか使っていない
- Codex 側の harvest。`context: fork` は Claude Code のフロントマターで、Codex での扱いは未検証（Codex では従来どおり前面で動く想定）

## 前提

- harvest の行は `server/src/extract.ts:211-233`。trace は `sessionSources` の `looked`（`server/src/trace.ts:128-150`、source_processing の exists）で `(traced before)` を付ける（`extract.ts:285`）。`pullSources`（`server/src/github.ts:501-560`）は looked を返さない
- 行範囲: `github.ts:286-288` が `[c.start_line ?? end, end]` を作り、`github.ts:454-455` で保存、`db/schema.sql:86` の CHECK `line_end >= line_start` に当たる。source の line_start は表示だけに使う（`extract.ts:230`、`server/src/read.ts:272`）。GitHub の docs は start_side と side を別々に LEFT/RIGHT と定義する（https://docs.github.com/en/rest/pulls/comments 、2026-09-30）。LEFT→RIGHT の範囲で start_line > line が実際に返るかは未検証
- `gh()`（`github.ts:66-81`）は maxBuffer だけ。`ghUser`（`github.ts:89-100`）は timeout 15 秒と SIGKILL。`gh(repo)` は harvest_begin と glean_fetch の両方に渡る（`server/src/mcp-record.ts:120-135,155-167`）
- 保存: `saveText`（`extract.ts:438-`）が `inTransaction`（`server/src/db.ts:48`、`begin immediate`）の中で checkRecord / checkGlean と saveRecord / saveGlean を呼ぶ。ロック中のファイル・git: `masksSymbol`・`commitHolds`（`server/src/record.ts:478-483`）、anchor の挿入直前の `masksSymbol`・`locateSymbol`（`record.ts:797-818`、`server/src/glean.ts:628-649`）、`readExcerpt`（`glean.ts:133`、呼び出し `glean.ts:293`。コミットの blob を読む）。masksSymbol と locate は別々にファイルを読む（`server/src/anchors.ts:18-110`）
- glean の検査は、unit が無い・revision が違う操作では `readExcerpt` の前で `continue` する（`glean.ts:269-293`）
- record_check（`checkText`、`extract.ts:412`）はトランザクションの外で同じ検査を呼ぶ
- issue の「anchor 1 つで約 86 ms（2 MB のファイル）」のうち、読み取りと伏せ字判定のどちらが重いかは未計測
- `context: fork` は Skill の本文をプロンプトに新しいサブエージェントを起動し、会話履歴は見えない。既定で background、`background: false` で結果を待つ。background のフォークは狭いツール集合で動く（https://code.claude.com/docs/en/skills 「Run skills in a subagent」、2026-09-30）。手元は Claude Code 2.1.285。MCP ツールが background のフォークで使えるかは未検証
- harvest Skill は「番号が無ければ持ち主に聞いて待つ」「持ち主の言語で報告する」と書いている（`plugin/skills/harvest/SKILL.md`）。どちらも fork では会話履歴が無く実行できない
- record の key が重複すると保存は拒否される（`record.ts:209-220`）。source の id は autoincrement（`db/schema.sql:53-61`）

## 方針

1. `(harvested before)`: `pullSources` に trace と同じ source_processing の exists で `looked` を足し、harvest の行の時刻の後に ` (harvested before)` を付ける。本文が編集されて revision が上がった source は新しい行なので付かない
2. 行範囲: `readPull` で、`start_line` が null・`start_line > line`・`start_side !== side` のどれかなら `[line, line]` にする。それ以外は今どおり `[start_line, line]`
3. タイムアウト: `gh(repo, timeout = 60_000)` に `timeout` と `killSignal: "SIGKILL"`（ghUser と同じ理由）。タイムアウトのエラーは `<path の ? より前> did not answer within 60 seconds`。テストは `gh()` 単体に sleep する偽 gh と短い timeout を渡すものと、glean_fetch がそのエラーを返すもの 1 件
4. ロックの外で検査する:
   - 準備（ロックの外、saveText の中で `inTransaction` の前）: 生の record を今と同じ zod で読み、anchor の作業ツリーのファイルを 1 回だけ読んで、その同じ内容から伏せ字の判定・symbol の位置・内容の sha256 を出す。`commitHolds` と glean の `readExcerpt` の結果も出す。anchors.ts の masksSymbol / locate は、読んだ内容を受け取る関数と、今の読み取り付きの関数に分ける
   - 準備の結果は「値かエラー」を持つ `RepoFacts` にし、checkRecord / checkGlean は DB の検査がその anchor・操作に着いたときだけ引く。未到達の操作の準備エラーを先に返さない
   - 書き込み（ロックの中）: DB の状態（source、unit の revision、forgotten）は今どおりロックの中で読む。anchor を 1 つ挿入する直前に、今と同じ読み取り経路でファイルを読んで sha256 を比べ、違えば（消えた・読めないも含む）その内容で伏せ字の判定と位置をやり直す。コミットの結果（commitHolds、readExcerpt）は確かめ直さない
   - record_check も同じ準備を通す
   - 実装の最初に、2 MB のファイルで「読み取り＋ハッシュ」と「伏せ字の判定＋symbol 探し」の時間を測って tasks に残す。読み取りが判定と同程度に重ければ、この方針を Codex と見直す
   - テスト: 準備の後・ロックの前に同じ長さで書き換えて symbol が伏せ字の対象になると symbol が保存されない / ロックの中で前の anchor を挿入した後に書き換えても同じ（挿入の間に書き換えるフックを差し込む）/ 書き換えないとき、ロックの中で判定関数が呼ばれない / glean の未到達の操作の準備エラーが出ない
5. fork 実験:
   - harvest の SKILL.md に `context: fork` を足す。まず既定（background）で試し、MCP ツールが使えなければ `background: false` で試す。PR 本文に、どちらで確かめたかを書く
   - 本文を会話履歴なしで動くようにする: 番号が無ければ何もせず「番号を渡して」と返す、報告は起動の引数の言語で、無ければ英語。外すときは元の文面に戻す
   - 確かめること: `/sphica:harvest <N>` で `$ARGUMENTS` が入る、`disable-model-invocation: true` のまま手で起動できる、返った報告に保存行がそのまま入る
   - 文脈の測り方: 新しいセッションで固定の事前プロンプトを 1 回送り、harvest の完了後に固定の事後プロンプトを送る。メインの transcript の、その 2 つの応答の usage（input_tokens + cache_read_input_tokens + cache_creation_input_tokens）の差を「文脈の増加」とする。途中で自動圧縮が起きた試行は外す
   - 保存結果の比べ方: 同じ初期状態の DB を 2 つ複製し、SPHICA_DB でそれぞれを指す別々のセッションで、前面実行と fork 実行を 1 回ずつ流す。PR は merge 済みで comment の多いもの（#199 か #232 のうち source の多い方）。両方の harvest_begin の後に source の (kind, external_id, revision, content_hash) の集合を比べ、違えばその試行は判定に使わない。引用先をこの 4 つ組に直し、unit の kind・引用文・evidence の role・adoption の有無を比べる。key と source の数値 id は比べない
   - 採用の条件: fork の文脈の増加が前面の 25% 以下、かつ前面の unit ごとに、kind が同じで引用文の半分以上が一致する unit が fork 側にある。外れた unit は PR 本文に並べて持ち主が判断する。満たさなければ fork を外し、計測結果を #208 に書く

## 採った案と棄却した案

- 採用: 逆向き・側違いは `[line, line]`。棄却: 範囲を落とす（位置が消える）、入れ替える（LEFT と RIGHT の行番号が混ざる）
- 採用: ファイル・git の結果を準備で先に出す。棄却: checkRecord 全体をロックの外で動かしてロックの中で全部やり直す（DB の検査が 2 回になる）
- 採用: ロックの中は anchor ごとに内容の sha256 を比べる。棄却: (size, mtime, ino) の比較（同じ長さの上書きと mtime の復元で見逃す）、ロックを取った直後に 1 回だけ比べる（挿入中の書き換えを見逃す）、伏せ字の判定をロックの中に残す（分ける効果が薄い）
- 採用: fork の比較は引用文と 4 つ組で。棄却: key と source の id で比べる（agent の命名と autoincrement で揺れる）

## 手順

- S1: `(harvested before)`
- S2: 行範囲
- S3: gh のタイムアウト
- S4: 読み取りと判定の時間の計測
- S5: 準備と書き込みの分離（record と glean、anchors.ts の分割）
- S6: fork 実験と Skill の文面
- S7: バージョン（npm と 3 つの manifest）

## 完了条件

- A1: `bun run verify` → 0 で終わる
- A2: `cd server && node --test --test-timeout=60000 test/github.test.ts test/extract.test.ts test/record.test.ts` → 新しいテストを含めて通る（直す前に意図した理由で落ちたことは tasks の red に記録する）
- A3: `bun run release:plan -- --base v0.6.10` → `plugin`、npm と 3 つの manifest が同じ新しいバージョン
- A4: `gh pr checks <PR>` → 全部 pass。PR の Codex Review Summary で head の Code Review が Completed、未解決のスレッドが 0
- A5: `gh pr view <PR> --json body -q .body` → fork の計測結果（文脈の増加、保存結果の比較、background か否か）と採否がある
- A6: release run の完了後に `bun run release:status` → npm・tag・Claude と Codex の cache が新しいバージョン
- A7: `gh issue view 208 --json state -q .state` → `CLOSED`

## リスク

- 計測で読み取りが判定と同程度に重い → 方針 4 を Codex と見直し、plan を直して Go を取り直す
- fork で MCP ツールが使えない・報告がメインに戻らない → background: false を試し、それでも駄目なら外して #208 に書く
- 準備の関数分けで伏せ字の判定が今と食い違う → 今の masksSymbol / locate のテストを、内容を受け取る関数にも流す

## 未解決

なし

## 変更履歴
