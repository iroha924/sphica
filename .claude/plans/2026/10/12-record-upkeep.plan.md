---
kind: plan
status: approved
codex_session: 01a12c62-aa6d-77b3-82fd-fe67ec6e7be4
codex_rounds: 4
approved_at: 2026-10-12
---

# trace の保存 1 回で、答えの出た質問を閉じ、作業状況を複数まとめて直せるようにする

## 要点

- trace の unit に `answers`（質問のキーの配列）を足す。答えの記録が active になった保存の中で、その質問を取り下げる。持ち主が `/sphica:glean` を打たなくてよくなる
- 決定・制約で質問を閉じるには、持ち主かメンテナーの採用が要る。AI だけの決定では閉じない。取り下げは最終で、答えが後で取り下げられても質問は戻らない
- trace の `work` を、1 件でも 1〜10 件の配列でも受ける。既にあるキーは書いた項目だけを更新する（閉じるだけなら `{ key, status }`）
- trace の context に、開いた作業状況の全項目と、閉じた作業状況の直近 10 件を出す。trace をする AI が既にあるキーを使えるようにする（依頼に足した点）
- check と save が、質問ごと・作業状況のキーごとの結果を返す
- 変えないもの: schema と revision、`unit_link`、`judge.ts` の規則、glean と harvest の入力、CLI、配信

## 持ち主の決定

- 次の 2 つを 1 つの計画・PR・リリースにまとめる（2026-10-12、「そうだね、まとめて一気にやりたい」）: 決定が質問に答えたら同じ trace の中で質問を閉じる、作業状況を 1 回の保存で複数直せるようにする
- 実装の前に Codex と議論する（同日、「その前に codex と議論してもいい」）
- 記録の本文は書き換えない。CLI は `init`・`doctor`・`uninstall` の 3 つだけ。API キーや追加の課金を利用者に求めない（CLAUDE.md と ROADMAP.md の既存の決まり）

## 目的

- trace の保存 1 回で、質問に答えた記録が保存され、その質問が withdrawn になる。質問の `read` の履歴に `answered by <答えのキー>` が出る
- trace の保存 1 回で、複数の作業状況が更新・完了になる。閉じるだけの更新で本文を打ち直さない
- trace の context に作業状況のキーが出て、同じ作業に別のキーを作る重複が減る（無くなるとは言わない。閉じた作業状況は直近 10 件までしか出ない）
- 更新の前から動いている 0.6.50 の記録サーバーが残っていても、閉じた質問が開き直らない

## 対象外

- リンクの種類 `answers`、lifecycle の値 `answered`、`supersedes` の種類の組の拡張
- glean と harvest の unit での `answers`（glean には持ち主の言葉による `withdraw` が既にある）
- glean からの作業状況の更新（`work: only trace records work` のまま）
- 配信の量と並び、質問の自動検出、古い作業状況の自動判定、セッション開始と `status` の表示
- 検索の一覧で、取り下げられた質問に `answered by` を出すこと（`read` の履歴で足りる）

## 前提

- 記録サーバーは ingest の接続を最初の呼び出しで開いて持ち続け、revision は開くときにしか見ない（`server/src/mcp-record.ts:44-48`、`server/src/db-write.ts:345-360`）。revision を上げる案だと、古いサーバーが新しい規則の状態を古い `judge` で判定し直す
- withdrawn は最終で、今の `judge` はそのまま保つ（`server/src/judge.ts:113-115`、`db/schema.sql` の `unit_state` の trigger）。active / candidate → withdrawn は許されるが、superseded → withdrawn は許されない（`judge.ts` の `difference`）
- `settleSaved` は `withdraw` と `seeds` を受けて `reconcile` へ渡せる。glean の `withdraw` はこの経路で書く（`server/src/record.ts:849-864`、`server/src/glean.ts:939-964`）。`reconcile` の seeds に入れないと、その記録は再判定されない（`server/src/reconcile.ts:346`）
- 後継の質問を取り下げると、置き換えられていた古い質問は active に戻る（Codex が今の `judge` / `difference` で再現。`server/src/reconcile.ts:229-246` は置き換えの関係を両方向にたどる）
- `checkRecord` の呼び出し元は trace と harvest（`server/src/extract.ts:723`）と glean（`server/src/glean.ts:307`）。trusted の検査は `supersedes` と `conflicts` にだけかかる（`server/src/record.ts:499-506`）
- `work` は 1 件だけで、`goal` を含む全項目を上書きする。より新しいセッションの状態は、`work.run_id` が指すセッションの開始時刻と比べて守る（`server/src/record.ts:132-141`、`1101-1137`）。古い更新を省いても返答には出ない
- Zod の `partial()` は `next` の `default([])` を残すので、省略が `[]` になる（Codex が実測）
- trace の `record_context` は作業状況を出さない。live な記録の一覧は active と candidate だけ（`server/src/extract.ts`、`server/src/trace.ts` の `liveUnits`）
- prompt の配信は記録の種類を限らない（`server/src/deliver.ts:689-725`）。active な質問も配信され得る
- 0.6.50 の記録サーバーは、`answers` を未知のキー、配列の `work` を型の違い、部分更新を項目の不足として断る（Codex が今の `checkRecord` で実測）
- ingest の接続は `unit_state` の insert と `work` の insert・更新を既に許している（`server/src/db-write.ts:156`、`163`、`182`）
- 未検証: 新しい保存の経路を DB 越しに通した結果（実装が無いため）。実機の Claude Code と Codex での trace

## 方針

### 質問を閉じる（`answers`）

- 入力: unit に `answers`（記録のキーの配列、0〜5 件、既定は空）。`record.ts` の `Unit` に足す
- 受けるのは trace の保存だけ。harvest と glean の unit にあれば保存を断る（文面は `answers: only trace closes a question` の形）
- 書ける種類は decision・constraint・finding・implementation・dead_end。`question` の unit に書いたら断る（質問が質問を置き換えるのは今までどおり `supersedes`）
- キーの検証で断るもの: このプロジェクトの記録でない、種類が `question` でない、同じ unit の `supersedes` と同じキー
- 既に withdrawn か superseded の質問は変えず、「既に閉じている」と返す。答えの記録は保存する
- 答えの資格: 最初の判定で active になり、decision / constraint なら取り消されていない `owner_statement` か `explicit` の採用がある。資格が無ければ質問は開いたままにし、理由を返す（candidate に留まった理由、または AI の決定は質問を閉じないこと）
- 同じ保存の複数の unit が同じ質問を答えるときは、record の並びで最初に資格のある unit を理由にする
- 保存の手順（1 つの transaction の中）
  1. 今までどおり unit を書き、`settleSaved` で判定する
  2. 資格のある答えが指す、開いている質問の ID を `withdraw` と `seeds` に入れて `reconcile` を呼ぶ
  3. その changes から、superseded から active か candidate に戻った質問のうち、この保存で取り下げた質問から `supersedes` の from → to の向きでたどれるもの（祖先）を拾い、同じ答えで取り下げる。戻る祖先が無くなるまで繰り返す
  4. 3 の繰り返しは最大 10 回。使い切っても残れば保存全体を断る
- 祖先でない記録（同じ質問を置き換えようとしていた別の後継など）が動いても閉じない。結果に出すだけ
- 取り下げの理由: `answered by <答えのキー>: <引用の先頭 200 字>`。祖先は `answered by <答えのキー> (through <取り下げた質問のキー>): …`。引用と source は、decision / constraint なら資格の根拠になった採用、ほかは unit の最初の根拠
- 状態を書くのは `reconcile` だけ。`unit_state` を直接書かない
- check は同じ経路を rollback で走らせる。check と save の返答に、質問ごとの行（閉じた / 既に閉じている / 開いたままの理由）と、繰り返しの中で動いたほかの記録を出す。一覧は全部の繰り返しが終わった後の状態から作る

### 作業状況（`work`）

- 入力: `work` は 1 件のオブジェクトか、1〜10 件の配列。内部は配列に統一する。配列の中のキーの重複は保存を断る
- 1 件の形: `key` だけ必須。`title`・`goal`・`current`・`next`・`status` は省ける。既定値は付けない（省略は保持、明示した `next: []` は消去）
- 新規か更新かの判定と既存値の読み取りは、保存の transaction の中で行う
  - キーが無い: `title`・`goal`・`current`・`status` が要る（無ければ保存を断る）。`next` は省いたら空
  - キーがあり `key` だけ: 何も書かない（変更なし）
  - キーがあり値がある: まず今までの「より新しいセッションの状態が保存済みなら省く」検査を通す。通ったうえで、保存済みと全項目が同じなら `run_id` だけを進める（`updated_at` と `branch` は保つ）。違えば項目・`branch`・`run_id`・`updated_at` を進める
- 自動 run の規則は変えない（記録が 1 件も無い保存では作業状況を更新できない）。件数ではなく有無で見る
- check と save の返答に、キーごとの行を出す: 作った / 更新した / 同じ内容を確認した / 変更なし / より新しいセッションの状態があるので省いた

### trace の context

- `record_context` の closing part に、trace の run でだけ次を足す。既にあるページ送りに載せる
  - 開いた作業状況（active・blocked・paused）: キー・状態・題・goal・current・next・更新日。見出しで「同じ作業はこのキーで更新する。変える項目だけ書く」と伝える
  - 閉じた作業状況（done・abandoned）: 更新の新しい順に最大 10 件。キー・状態・題・更新日
- harvest と glean の context には出さない

### Skill と文書

- `plugin/skills/trace/SKILL.md`: 表に `answers` の行、`work` の行の書き直し、例の更新
  - `answers`: 質問に答えた記録に、その質問のキーを書く。採用が足りなくても答え自身は active になり得るが、質問を閉じる条件は別。提案や関連する話だけでは書かない。閉じた質問は戻らないので、まだ必要な問いは新しい質問として残す
  - `work`: context に出ているキーを使う。変える項目だけ書く。終わった作業は `done`、要らなくなった・重複した作業は `abandoned`。題が似ているだけで完了や統合にしない。会話で確かめられた更新だけ
  - サーバーが `answers`・配列の `work`・部分更新を未知の欄や項目の不足で断ったら、サーバーが Skill より古い。その欄を落として保存し直さず、再読み込み（Claude Code は `/reload-plugins`、Codex は開き直し）のあと context を読み直して保存する
- record の形を説明しているほかの場所を `rg` で全部拾い、対になる記述を直す（README.md・README.ja.md・MCP のツールの説明・`.agents/` の Skill）

### リリース

- revision は上げない。移行も無い
- パッケージに入る変更なので、最初のパッケージ入力のコミットで npm と 3 つの manifest を次のバージョンに上げる。`bun run release:plan -- --base 6a4d91c6`（v0.6.50）の結果に従う
- 受け入れケースを先に足し、直す前のコードで意図した理由（`answers` が未知の欄、`work` の配列が型の違い）で落ちることを確かめる。件数を固定している `server/test/acceptance-cases.test.ts` と、driver の expectation（キーごとの作業状況、質問の lifecycle）も直す

## 採った案と棄却した案

- 採用: 保存の中で質問を取り下げる（`answers`）。棄却: `supersedes` の種類の組を広げる（revision の更新が要り、古い記録サーバーが答えの決定を candidate に戻し得る。開いているセッションの配信も再読み込みまで止まる。1 つの記録が閉じられる質問は 1 件だけ）
- 採用: schema を変えない。棄却: リンク `answers` と lifecycle `answered` を足す（CHECK を持つテーブルの作り直しと、公開している lifecycle の値の変更が要る）
- 採用: `answers` は trace だけ。棄却: glean と harvest でも受ける（他人が書いた文章で質問が閉じ得る。glean 用の trusted の検査が要る）
- 採用: 既に閉じた質問は変えずに答えを保存する。棄却: 保存全体を断る（2 つ目の答えや、context を読んだ後に閉じた質問で保存が止まる）
- 採用: 取り下げで戻った祖先の質問も同じ答えで閉じる。棄却: 祖先を `answers` に明示させる（superseded の記録は context に出ないので AI から見えない）、戻った質問を結果に出すだけにする（言い換えた質問に答えると元の質問が開き直る）
- 採用: 判定の後に `reconcile` をもう 1 度呼ぶ。棄却: 純粋な `judge` で先に予測して 1 回にまとめる（予測と実際の判定を二重に持つ）
- 採用: `work` は単一か配列の両方を受ける。棄却: 配列だけ（古い Skill を読み込んだままのセッションの保存が止まる）、別の欄 `works`（同じものの入口が 2 つになる）
- 採用: 既にあるキーは部分更新。棄却: 全項目の上書きのまま context に `goal` を出すだけ（閉じるだけの更新で本文を打ち直し、打ち直しで `goal` が変わり得る）
- 採用: 値を明示した同じ内容の更新は `run_id` だけ進める。棄却: 何も書かない（あとから届く古いセッションの trace が状態を巻き戻せる）

## 手順

- S1: `release:plan` の結果に従ってバージョンを上げ、受け入れケースと件数の検査・driver の expectation を足す（実装の前に red を確かめ、実装と同じコミットに入れる）
- S2: `answers` の入力と検証（種類、キー、trace 限定）
- S3: `answers` の保存（資格の判定、取り下げ、祖先の繰り返し、上限）と check / save の結果の行
- S4: `work` の入力（単一か配列、部分更新の形、重複キー）
- S5: `work` の保存（新規と更新の判定、同じ内容の確認、古いセッションの検査、自動 run）とキーごとの結果の行
- S6: trace の context に作業状況を出す（開いたものと閉じたもの、ページ送り）
- S7: trace の Skill と、record の形を説明しているほかの記述

`npm pack` の確認・実機の確認・CI・配信の確認は、タスクではなく完了条件（A5〜A9）として実装の後に流す。リリースそのものは `plugin-release` Skill の手順で行う。

## 完了条件

- A1: `bun run verify` → 終了コード 0
- A2: `git diff --stat origin/main...HEAD -- db/ server/src/judge.ts server/src/sqlite.ts` → 出力なし（schema・移行・判定の規則・revision を変えていない）
- A3: `cd server && node --import ./test/isolate-home.ts --test --test-timeout=60000 test/record.test.ts test/extract.test.ts test/reconcile.test.ts` → 全件 pass。次を含む
  - `answers`: 質問でない対象、別プロジェクト、`question` の unit、harvest と glean での拒否、`supersedes` との同じキー
  - `answers`: 持ち主の採用のある決定で閉じる、agent の採用だけの決定では閉じない、根拠のある finding で閉じる、答えが candidate なら閉じない
  - `answers`: 既に閉じた質問、同じ保存の 2 つの答え、1 つの答えで質問 2 件、古い決定の `supersedes` と質問への `answers` の併用
  - `answers`: 質問の鎖 2 件と 11 件が全部 withdrawn、12 件は保存全体が rollback、candidate に戻った祖先も閉じる、祖先でない後継は閉じない
  - `answers`: 閉じた後に、質問か答えに届く別の保存をしても質問は withdrawn のまま
  - `work`: 配列 2 件、11 件の拒否、重複キーの拒否、古い形（全項目の単一）の受理、新規キーの項目の不足
  - `work`: `key` だけは何も書かない、`{ key, status }` でほかの項目を保つ、`next` の省略は保持・`next: []` は消去
  - `work`: 同じ内容の確認は `run_id` だけ進む、その後に届いた古いセッションの更新は省かれる、配列の中で省かれたキーと更新されたキーが結果に別々に出る
  - `work`: 自動 run で記録の無い保存は断られる。保存が断られたときは unit も作業状況も残らない
  - context: trace にだけ作業状況が出る、閉じたものは 10 件まで、長い日本語の本文でも 1 ページが 32,768 バイト以内でキーが欠けない
- A4: `bun run acceptance` → 全件 pass。足したケース（質問を閉じる、質問の鎖、作業状況 2 件、部分更新）を含む
- A5: `npm pack` → tarball をリポジトリの外で展開し、`plugin-release` Skill の手順で中身を数えて読み取りサーバーと記録サーバーを起動すると、両方がツールの一覧を返す
- A6: `/sphica:trace` → 一時の `SPHICA_HOME` で実機の Claude Code と Codex それぞれ 1 回通すと、質問 1 件が withdrawn、作業状況 2 件が更新され、返答に質問と作業状況の行が出る。1 回の成功の確認であって、AI が常に正しいキーを選ぶ保証ではない
- A7: `node ~/.claude/plugins/cache/sphica/sphica/0.6.50/dist/mcp-record.js` → 一時の DB で 0.6.50 の記録サーバーに新しい形（`answers`、配列の `work`、部分更新）を送ると、3 つとも断られ、unit も作業状況も保存されない
- A8: `gh pr checks <PR>` → 最終の head で全ジョブが pass
- A9: リリースの後に `bun run release:status` → npm・Claude Code・Codex のバージョンが一致
- A10: `python3 ~/.claude/skills/grill-codex/scripts/check_plan.py done .claude/plans/2026/10/12-record-upkeep.tasks.md` → 終了コード 0

## リスク

- AI が、答えになっていない記録に `answers` を書く → サーバーは意味を見られない。Skill の文面で「提案や関連する話では書かない」と伝え、質問の `read` の履歴に答えのキーが残るので後からたどれる。まだ必要な問いは新しい質問として残せる
- 取り下げが最終なので、誤って閉じた質問は戻せない → 新しい質問の記録を作る。頻度が高ければ、閉じる条件を持ち主の採用に絞ることを検討する
- 新しい Skill と古いサーバーの組み合わせで保存が断られる → Skill の手順（再読み込みして context を読み直す）に従う。欄を落として保存し直さない
- context に作業状況が増え、1 ページに収まる発言が減る → closing part のページ送りに載っているので欠けはしない。自動の trace が 1 回に読める量への影響は実機の確認で見る
- 祖先の繰り返しが 10 回を超える鎖 → 保存全体を断る。その質問を `answers` から外して保存し、持ち主の `withdraw` で閉じる

## 未解決

なし

## 変更履歴
