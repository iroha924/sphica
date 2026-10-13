---
kind: plan
status: approved
codex_session: 01a13458-b3a5-77b2-9a0c-a9f56c3e1034
codex_rounds: 3
approved_at: 2026-10-13
---

# search に as_of を、read に timeline を足す（issue #217）

## 要点

- `search` に `as_of`（時刻）を足す。その時点で Sphica が保存していた記録だけを、その時点の状態・anchor・alias・置き換え・権威で判定して返す。並び順だけは今の索引の順位に依る
- `read` に `timeline: true` を足す。全文の代わりに、その記録が乗っている置き換えの連なりと、同じ run か同じ場所の finding・dead end・question を、時刻順の概要で返す。各行に理由と source の ref が付く
- DB の schema、書き込みの経路、hook、CLI、record サーバーは変えない。`as_of` も `timeline` も渡さない呼び出しの返信は、frame の id を揃えて比べて差分 0
- 評価の道具を直す: ツール別の Sphica の呼び出しの数、as_of と timeline の使用回数、timeline で名前が出た記録の signal を集計に足す
- 評価のタスクを 1 つ足し（以前は何に決まっていて、なぜ変わったか）、変更の前と後の bundle を同じ fixture で両モデルに解かせる。出す条件は「このタスクもほかも点が下がらない」。点が上がったか（issue の仮説）は結果として分けて書く
- 0.6.55 として 1 つの PR で出す。読み取り MCP サーバーの変更なので Claude Code と Codex に同じものが届く
- 測らないもの: as_of がエージェントの答えを良くするか。評価はタスクの prompt を固定の文字列として使う今の方式のままにし、fixture ごとの時刻を prompt に差し込む仕組みは対象外にする。as_of は決定的なテストで正しさだけを確かめる

## 持ち主の決定

- issue #217 をやる（2026-10-13）
- #217 は追加したい機能で、無くて困った事例が無いことを理由に落とさない（記録 `trace:cbc0dbe8-014d-4719-9165-5a39fdb1e53f/wanted-features-stay-open`）
- Sphica は Claude Code と Codex で、各ホストが許す限り同じ機能を持つ（CLAUDE.md の host-parity）
- epic #200 の方針: 実験は PR ブランチで merge の前に測る
- 評価で新しいタスクの点が上がらなくても、下がらず、ほかも下がらなければ出す。epic #200 の「基準に届かなければ出さない」の例外で、issue にそう書く（議論の後に持ち主が追加、2026-10-13）

## 目的

- エージェントが `search` に時刻を渡すと、その時点で有効だった決定が、その時点の状態で返る。後から保存された記録は数えられず、名前だけが別に出る
- エージェントが `read` に `timeline: true` を渡すと、ある決定がどの決定を置き換え、何に置き換えられ、その run や場所で何が見つかっていたかを、1 回の返信で時刻順に読める
- 変更の前と後で、「以前は何に決まっていて、なぜ変わったか」のタスクの採点と呼び出しの数が表で比べられる

## 対象外

- `read` の `as_of`。続きの ref に時刻を持たせる必要があり、`s<id>` での意味も決まらない
- `sources: true` と `asked: true` の as_of
- 発言の時刻（source の `created_at`）で「その時点で決まっていたこと」を出すこと。PR の本文は後から編集され、`available_at` が null の改訂もある（db/schema.sql:74-78）
- as_of の時点の順位の再現。bm25 は今の索引全体の統計に依る
- as_of を日付で問う評価のタスク。fixture の記録は build の時刻に保存されるので、問いに入れる時刻は fixture ごとに変わる。タスクの prompt は固定の文字列として firing.ts、build.ts（gold）、slot-scripts.ts、grading.ts、codex.ts、claude.ts がそのまま使うので、差し込みの仕組みは今回作らない
- 採点の項目の追加（grading.ts の schema）。過去の採点との比較が変わる
- `source.available_at` の扱い（読むか消すか）

## 前提

- `readUnit(db, projectId, ref, root, asOf?)` は as-of を持つが、MCP の `read` は渡していない（server/src/read.ts:37-85, 550、server/src/mcp.ts:215-246）
- as-of の規則は read.ts:237-251 と 389-449: 状態は `unit_state.at <= asOf` の最後、evidence・adoption・anchor・link・field・alias は `added_at <= asOf`、置き換えは `unit_replacement` の `[started_at, ended_at)`。権威は `authorityOf(db, ids, asOf)`（server/src/authority.ts:35）
- `searchUnits` は今の `unit_fts` を語の OR で引き、`judgeUnits` が語の過半で判定する。`liveSuccessors` は `ended_at is null` だけを見る（server/src/search.ts:62-224、server/src/text.ts:140-143）
- `unit_fts` の ident は引退していない anchor だけ、alias は今の content_hash の最新の 1 組（db/schema.sql:1071-1085）。本文と選択肢は保存後に変わらない
- 時刻不明の置き換えは `unit_replacement_gap` にあり、`read` は「発効しなかった提案」と分けて出す（read.ts:413-446）
- 記録の保存は実時計（server/src/record.ts:1143）。受け入れケースの driver は書き込みの間に 2 ms 待って時刻を控える（server/evals/acceptance/driver.ts:728-730, 781-785）
- zod 4.6.5 の `z.iso.datetime({ offset: true })` は `0000-01-01T00:00:00+09:00` を通し、`toISOString()` は `-000001-12-31T15:00:00.000Z` を返す。`9999-12-31T23:59:59-14:00` は 6 桁の年になる。日付だけ・秒の無い形・オフセットの無い形は断る（2026-10-13 に実測）
- `framed()` は呼び出しごとに乱数の id を作る（server/src/frame.ts）。`READ_BUDGET` は 32 KiB（server/src/reply-budget.ts:15）
- 評価: `build.ts` は自分の checkout の tasks.json を読み、`--dist` と `--fixture` を受ける（server/evals/cloud/build.ts:39-42, 75-85, 232-237）。`report.ts --compare` は fixture とタスク定義が同じでないと断る（report.ts:299-304）。collect の signals は search の回数だけを数える（collect.ts:131-138）。judge は read の行 `<key> (u<id>, revision <n>)` だけを read と認める（judge.ts:80-88）
- SQL の呼び出し箇所の台帳は自動の走査で、手で足すものは無い（scripts/lib/sql-call-sites.mjs）
- 持ち主の DB（2026-10-13、読み取り専用で数えた、revision 12）: 記録 582 件はすべて trace 由来。`unit_replacement` 22 行、終わった行 0、2 段以上の連なり 2 つ。引退した anchor を持つ記録 5 件、alias の組が 2 つ以上の記録 0 件。保存と根拠の最初の発言の時刻の差は 1 日未満 516 件、1〜7 日 66 件。決定・制約 260 件のうち、finding か dead end と同じ場所に anchor があるもの 52 件、同じ run にあるもの 248 件（平均 4.7、最大 22）
- 既存の pnpm → npm の記録（受け入れケース、`trace:s-en-npm/npm`）は、変わった理由を自分の `why` に持つ。これを問うタスクは今の `search` だけで答えられる
- 未検証: timeline の「同じ run」が実際の質問でどれだけ雑音になるか。評価の実行の記録で見る

## 方針

### A. search の as_of（server/src/search.ts、server/src/mcp.ts）

1. 引数 `as_of`（省略可）。`z.iso.datetime({ offset: true })` で受け、`new Date(v).toISOString()` で直し、結果が `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$` でなければ断る。ミリ秒より細かい桁は切り捨てる。断るときの文に受ける形を書く
2. `sources: true`・`asked: true` と一緒に渡されたら、エラーで断る
3. 時刻は保存の時刻（`unit.created_at`、`unit_state.at`、各 `added_at`）で、`readUnit` の asOf と同じ規則
4. `searchUnits` の `UnitQuery` に `asOf` を足す。渡されたとき:
   - `u.created_at <= asOf`
   - lifecycle は `unit_state.at <= asOf` の最後の `to_state`（無ければ candidate）。`lifecycles` の絞り込みと並びもこの値
   - anchor は `added_at <= asOf` かつ（`retired_at` が null か `> asOf`）。`path` の絞り込みも同じ
   - alias は `added_at <= asOf` の最新の組、field は `added_at <= asOf`
   - `liveSuccessors` は `started_at <= asOf` かつ（`ended_at` が null か `> asOf`）の行をたどる
   - 権威は `authorityOf(db, ids, asOf)`
5. 候補: 今の `unit_fts` の候補に、「asOf より後に引退した anchor を持つ記録」と「asOf の時点の alias の組が今の組と違う記録」を足す。id で重複を除き、id の昇順、上限 200 件、順位は索引の候補の後ろ。上限に当たったら返信に書く
6. 返信:
   - frame の外の先頭に `As of <時刻>: which records existed and their states, anchors, and replacements are as Sphica held them then; the order follows today's index. read shows each record as it is now, with its dated history.`
   - ヒットの lifecycle はその時点の値。今と違えば `, now <今の値>` を足す
   - その時点より後に保存され、今の判定で当たる記録は、frame の外に `Saved after this time and not counted: u12 (saved <時刻>), …`（保存の古い順、最大 10 件、超えた分は件数）
   - 0 件の文にも `as of <時刻>` を入れる
7. `as_of` が無いときは、今のコードと同じ SQL と同じ返信

### B. read の timeline（server/src/read.ts、server/src/mcp.ts）

1. 引数 `timeline`（省略可の真偽値）。`false` は省略と同じ。`true` のとき ref ごとに処理し、記録でない ref（`s<id>`、続きの ref）と見つからない ref は、その ref の 1 行のエラーにして、ほかの ref は続ける
2. 連なり: 入口の記録から `supersedes` の link を両方向にたどる。上限 20 件（入口に近い順）。上限で止めたときは、止めた境目の記録を `u<id>` で名指し（最大 10 件）、「その先はたどっていない、全体の件数は分からない」と書く。数えていない残りを数えたようには出さない。各辺は 3 つに分ける
   - 発効した期間がある（`unit_replacement` の行。期間ごとに開始と終了のイベント。終了には `end_reason`）
   - 発効しなかった提案（行も gap も無い）: `proposed`
   - 発効の時刻が記録されていない（`unit_replacement_gap`）: 時刻順の並びの外（末尾）に `at some time (not recorded)`
3. 連なりの記録ごとのイベント:
   - 保存: `<時刻> <key> (u<id>) saved: <kind stance>, <本文の preview 200 バイト>`、あれば `Why: <preview 200 バイト>`、`Evidence: s12, s15`（最大 5 つ）、`Adoption: s12 (the owner)`。この行に載せる根拠と adoption は、保存の時点にあったもの（`added_at <= unit.created_at`）だけ。後から足されたものを保存の行にさかのぼらせない
   - 状態の変化（`unit_state` の `to_state` と `reason`）
   - 保存より後に足された根拠・adoption（その追加の時刻のイベントにだけ載せる）、根拠・adoption の撤回（元の引用の source と、撤回の理由を分けて書く）、保存より後の anchor の追加、anchor の引退と移動
   - source の ref を付けるのは、その操作の source が直接記録されているイベントだけ。anchor の追加は source を持たないので `no source recorded for this change`、引退の理由の source が forget で消えていれば `its source is no longer kept` と書く。記録の一般の根拠を、その操作の原因として流用しない
   - `conflicts` の追加と解決
   - どの run が起こしたイベントでも、連なりの記録に付くものは入れる
4. 結び付く記録（連なりの外の finding・dead end・question）: 連なりの記録と同じ run で保存されたもの（`same run`）、今生きている anchor の場所（path と symbol が同じ。どちらにも symbol が無ければ path）が同じもの（`same place`）。両方に当たれば 1 行に両方のラベル。保存の 1 行（preview 200 バイト）だけ。上限 30 件
5. 連なりの記録の run が書いた、連なりの外の記録の状態の変化（question が `answered by <key>` で閉じた、など）
6. 並び: 時刻、次にイベントの種類の固定の順（保存、根拠、adoption、状態、置き換えの開始、置き換えの終了、anchor、衝突）、次にその表の主キー（複合の主キーはその列の順）。先頭に 1 行: 概要であって引用そのものではない、結び付く記録は原因と確かめられた関係ではない、引用の確認は `read`
7. 予算: timeline は概要で、完全な時系列を約束しない。入らないときは、入口の記録の保存の行といちばん新しい置き換えの開始・終了を必ず残し、次に連なりのイベントを新しい順に、最後に結び付く記録を新しい順に、入るだけ入れる。表示は古い順。省いた記録は frame の外に `u<id>` で名指すが、一覧は最大 20 件までで、超えた分は件数だけを言う（一覧だけで予算を超えないようにする）。続きの ref は作らない
8. 保存された文字列（key、本文、理由、path）はすべて frame の中で `inline` と `preview` を通し、注記と省略の一覧まで含めて `fitCount` で測る
9. 読み取りは reader 接続の select だけ

### C. 文面と対の修正

- `server/src/mcp.ts` の `search` と `read` の description・引数の describe: as_of が約束する範囲（候補と状態はその時点、並びは今の索引）、ミリ秒より細かい桁の切り捨て、`read` の全文と timeline（概要）の違い、as_of の検索の後の `read` は今の状態を返すこと。サーバーの `instructions` は変えない
- `README.md` と `plugin/README.md` の機能の説明に 1 項目
- `rg` で `search(`・`read(`・`lifecycles` を引く plugin の Skill と reviewers を確かめ、要るものだけ直す

### D. テスト

- `server/test/search.test.ts`（実 SQLite）: 置き換えの前後、anchor の引退の前後、後から保存された記録と `Saved after` の行、`lifecycles` と `path` の絞り込み、その時点の alias でだけ当たる記録、alias が空に置き換わった後、後から足された field・alias の語で当たらないこと、権威の変化、cutoff が開始・終了の時刻と等しい場合、足した候補の上限
- property: `as_of` を今より後にすると、`as_of` 無しと同じヒット（`now` の注記と `Saved after` が無い）
- timeline: 3 段の連なり、終わった置き換えと複数の期間、提案だけの置き換え、時刻不明の置き換え（gap）、同じ run と同じ場所の finding（両方に当たる記録は 1 行）、question が閉じる行、同じ時刻のイベントの並び（複合の主キーと、同じ行の開始と終了を含む）、連なりの上限と境目の表示、予算での省略と必ず残す行、省いた ref の一覧の上限、保存より後の持ち主の adoption が保存の行に出ないこと、source の無いイベントと source が消えたイベントの表示、複数の ref と記録でない ref の混在
- MCP の inputSchema と handler を通すテスト: 形の違う `as_of`（日付だけ、オフセット無し、年の端）、`sources`・`asked` との組み合わせ、未知の引数、`timeline` と `s<id>`
- 受け入れケース 2 件（as-of の検索、timeline）と driver の step。対応する実装より先に足し、意図した理由で落ちることを確かめる
- 評価の道具のテスト: collect のツール別の数と unknown、judge の `in_timeline`

### E. 評価

- 受け入れの world に、評価用の連なりを足す: 3 段の置き換えで、変わった理由が後の決定の `why` ではなく同じ run の finding と dead end にあり、同じ run に関係の無い finding も 1 つある。tasks.json の `fixture` に足す
- タスク 1 つ（tsundoku、コードを変えずに答える、日付を問わない）: その題材が最初に何に決まり、どう変わってきたか、それぞれの理由。`expect` に、各段の決定・理由・確かめられる記録の名前を列挙し、記録に無い理由を足した答えを良い答えとしないと書く
- 集計に足す（collect.ts、report.ts）: 実行ごとの Sphica のツール呼び出しの数をツール別に、`as_of` 付きの search の数、`timeline` 付きの read の数。呼び出しの単位が取れないログは unknown。`report.ts --compare` に平均と各実行の値
- judge.ts: timeline の行で名前が出た記録を `in_timeline` として数え、read とは数えない
- 流し方（eval-loop の「A local loop」）: base commit（評価を始めるときの main の先頭。SHA を控えて固定する）の worktree で `bun run bundle`。ブランチの `build.ts --dist <前の dist>` で前のビルド、`build.ts --fixture <前のビルド>/fixture.db` で後のビルド。canary と probe は両方のビルドで流す
- 回数: 新しいタスクは search 条件で、両モデル・前後・各 3 回（12 回）。pilot-display と conflict-cover は各 2 回（16 回。conflict-cover は inject 条件）。ほかに `node evals/retrieval/run.ts --compare <base>`
- 基準（測る前に固定）
  - 出す条件: 新しいタスクの採点の平均が両モデルで下がらず、ほかの 2 タスクの採点の平均と retrieval の数字も下がらない
  - issue の仮説の成否: 新しいタスクの採点の平均が両モデルで上がれば成立。点が同じで呼び出しだけ減った場合は成立と呼ばず、呼び出しの数を別の結果として書く
  - 3 回は preliminary と書く。未採点や欠測で「下がらない」が言えないセルがあれば保留にして、持ち主に聞く
- 実行と採点はコードを変えないので手順には置かず、完了条件 A6 で流す。結果は PR 本文と issue に書く

### F. 出し方

- ブランチ `feat/as-of-search-timeline`、PR 1 つ、0.6.55。`bun run release:plan -- --base b38325c6`（v0.6.54 のコミット）
- バージョンは、パッケージに入るファイルを最初に変えるタスクのコミットで上げる

## 採った案と棄却した案

- 採用: as_of の時刻は保存の時刻。棄却: 発言の時刻（置き換えや撤回の時刻を発言の側から導けず、編集された PR を誤って過去に置く）
- 採用: 後から保存された記録は「数えていない」と名前だけ出す。棄却: 「その時点より前に言われていた」と出す（source の時刻は引用が書かれた時刻ではない）
- 採用: `read` に `timeline` の引数。棄却: 新しいツール（両ホストの全セッションのツール一覧が 1 つ増える）、`read` の返信に常に足す（どの read も長くなる）
- 採用: `read` に as_of を足さない。棄却: 足す（続きの ref に時刻が要る）
- 採用: 今の索引に、後から語が消えた記録を候補として足す。棄却: 今の索引だけを引く（後の出来事で過去の検索の結果が黙って変わる）
- 採用: 並び順は今の索引に依ると書く。棄却: as_of の時点の語から順位を計算し直す（索引を別に持つことになる）
- 採用: 結び付く記録は同じ run と同じ場所の両方。棄却: 同じ場所だけ（持ち主の DB で決定 260 件のうち 52 件にしか当たらない）
- 採用: timeline は概要で、省いた記録を上限つきで名指す。棄却: 完全な時系列と続きの ref（公開契約が増える）、省いた ref を全部並べる（5000 件で 50 KB になり、一覧だけで 32 KiB の予算を超える）
- 採用: 日付だけの as_of は断る。棄却: その日の終わり（UTC）と読む（利用者の時間帯とずれる）
- 採用: 仮説の成否は issue のとおり点が上がることで判定し、出すかどうかは持ち主の決定（下がらなければ出す）に従う。棄却: 点が同じでも呼び出しが減れば仮説が成立したと呼ぶ（issue の基準と違う）
- 採用: 前と後のビルドはブランチの `build.ts` に bundle を渡して作る。棄却: main の worktree の `build.ts` で前を作る（新しいタスクが無く、`report.ts --compare` がタスク定義の違いで断る）

## 手順

- S1: `search` の as_of（方針 A）。受け入れケース 1 件と driver の step、D の search と MCP の入力のテストを先に書き、直す前のコードで意図した理由で落ちることを確かめてから実装する。バージョンを 0.6.55 に上げる
- S2: `read` の timeline（方針 B）。受け入れケース 1 件と driver の step、D の timeline のテストを先に書き、同じく落ちることを確かめてから実装する
- S3: tool の description、README、対の文面（方針 C）
- S4: 評価の集計（collect、report、judge）とそのテスト
- S5: 評価用の連なりとタスク（world、tasks.json）

## 完了条件

- A1: `bun run verify` → 終了コード 0
- A2: `node --import ./test/isolate-home.ts --test test/search.test.ts test/timeline.test.ts test/plugin.test.ts` → 足したテストが落ち、元からあるテストは通る（base commit の worktree の `server/` に、足したテストだけを写して流す）
- A3: `node <scratchpad>/replies.ts <base の worktree の dist/mcp.js> <ブランチの dist/mcp.js> <fixture.db>` → 差分 0（その場で書く比較のスクリプト。両方の読み取り MCP サーバーを stdio で起動し、同じ DB に対して `search`（既定、各絞り込み、0 件、sources、sources の 0 件、asked、asked の 0 件、断られる path）と `read`（記録、source、長い記録と続きの ref、予算での省略、見つからない ref）を呼び、返信の content と isError を、frame の id を揃えて比べる）
- A4: `bun run sql:reach` → 未到達 0
- A5: `bun run release:plan -- --base b38325c6` → `plugin`。`npm view sphica@0.6.55 version` → 無い
- A6: `node evals/cloud/report.ts --compare <前>/grades.json <後>/grades.json` → 表が出て、採点・ツール別の呼び出しの数・as_of と timeline の使用回数が、両モデル・n・除外・未採点つきで PR 本文にある
- A7: `gh pr checks <PR>` → 全項目 pass。`gh pr view <PR> --json reviewThreads`（または GraphQL）→ 未解決の thread が 0
- A8: リリース後、インストールされた 0.6.55 で `search`（as_of）と `read`（timeline）を、一時の DB に対して `claude -p` と `codex exec` の両方から呼ぶ → どちらも新しい返信が返る。`bun run release:status` → `release ledger is consistent`

## リスク

- 評価で点が上がらない（今の `search` と `read` も置き換えと日付を出す） → 下がっていなければ出す（持ち主の決定）。仮説は成立しなかったと issue と PR に書き、採点と呼び出しの数を分けて載せる
- 評価で点が下がる → 出さずに止め、実行の記録から原因を見て持ち主に報告する
- 「同じ run」が関係の薄い finding を並べる → ラベルと先頭の注意書きと上限で抑え、評価の実行の記録で実際に読まれた行を確かめる
- as_of の候補を足す SQL が大きい project で遅い → 上限 200 件。`node server/evals/scale/run.ts` の対象ではないので、テストで 1 万件の記録に対して時間を測る
- description が長くなり、ほかのタスクでの search の使い方が変わる → 回帰の 2 タスクで見る

## 未解決

なし

## 変更履歴
