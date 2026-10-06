---
kind: plan
status: approved
codex_session: 01a10f1e-fcda-7993-8ee1-49aa28d384c1
codex_rounds: 2
approved_at: 2026-10-06
---

# record_check と glean の check が、save と同じ処理を流してロールバックし、save と同じ結果を返す（#275）

## 要点

- `record_check` は、`record_save` と同じ準備・検証・書き込み・judge を 1 つのトランザクションの中で流し、最後に必ずロールバックする。check が自分の規則で save の結果を予測するのをやめるので、PR #273 で見送った 4 件のずれ（#275）は起きなくなる
- check の返答に、save が出すのと同じ記録ごとの結果（active になるか、candidate のまま残るならその理由、superseded、quarantined、glean の変更の行）を「would ...」の形で出す
- 「持ち主が採用した後継が、ほかの後継が持っている場所を待つことになったら名前を挙げて拒否する」規則を、check の予測から save の中の 1 か所（judge の後）へ移す。trace・harvest・glean で同じ規則になる
- 予測のためのコード（`checkRecord` の `claimed` / `holders` / `takes` / `implemented`、`checkGlean` の `adopt` の held の問い合わせ）を消す。入力の検証（対象があるか、すでに superseded か、種類、出どころの信頼）は残す
- 変えないもの: DB の schema、judge と reconcile の規則、save の返答の形、`record_call` と hook の観測（check でも残る）、`readOnlyHint`、busy timeout
- リリースは 0.6.37（npm と plugin の manifest 3 つ）

## 持ち主の決定

- 次の作業は GitHub Project の Phase 01 の束 F7（#275）にし、1 つの PR にする（「OK、それ進めよう」）
- PR #273 では check と save のずれ 4 件を直さずに出し、check が save と同じ judge を通す形は #275 で決める（記録 `trace:02d1edcd-…/ship-check-save-gaps`、「A1: 直さずに出す (Recommended)」）

## 目的

- 同じ run、同じ記録、同じ DB と作業ツリーの状態で、`record_check` が通るなら `record_save` も通り、check が拒否するなら save も同じ理由で拒否する。check が出す記録ごとの結果の行は、save の行と同じ内容になる
- #275 の 4 件の場面で、check と save がどちらも judge の結果どおりに動く（下の完了条件 A1）
- check の後の DB には、save の処理で書いたものが何も残らない（`record_call` と hook の観測を除く）。同じ run を何度 check しても、その後の save は check をしなかったときと同じ結果になる

保証の範囲: check は、今の入力と呼び出し元の権限で save の処理を流して戻すだけ。save は自分でもう一度検証してコミットするので、check と save の間に DB・作業ツリー・呼び出し元が変われば結果は変わり得る。COMMIT そのものの失敗は check では見えない。

## 対象外

- judge・reconcile・`unit_support`・schema の trigger の規則を変えること
- check を A 案（書かずに snapshot を組んで judge に通す）で作ること
- glean の add_evidence などで既存の後継が場所を待つことになる場合を拒否すること（今も拒否していない）
- すでに superseded の対象への supersedes の拒否、種類の組み合わせの拒否など、judge の予測ではない入力の検証を変えること

## 前提

- `server/src/extract.ts:572` `checkText` はトランザクションを開かずに `checkRecord` か `checkGlean` を流し、errors・problems・quarantine の警告と「N records can be saved」だけを出す。記録ごとの結果は出さない
- `server/src/extract.ts:601` `saveText` は lock の前に `bound`・`sameCaller`（`:612`、call id があるときだけ）・作業ツリーの準備（`prepareRecord` / `prepareGlean`）を行い、`inTransaction` の中で `bound`・`scopeOf`・`agentRun`・`checkRecord` / `checkGlean`・`saveRecord` / `saveGlean`・`finishRun` を流す。`shownTo.delete(id)` はコミットの後（`:672`）。check は `sameCaller` を呼ばない
- glean の save は `checkGlean` の problems を返答に集めない（`:624-631`）。trace と harvest は集める（`:636`）
- `server/src/db.ts:53` `inTransaction` は `db.connection().execute` で接続を確保し、`begin immediate` で始める。Kysely の SQLite の接続は 1 本で、ドライバーの mutex が同じ接続の並行の呼び出しを順に流す（`server/node_modules/kysely/dist/driver/runtime-driver.js:49`、Codex が確認）
- `server/src/record.ts:712-731` `checkRecord` は `claimed`（同じ save の中で同じ対象を置き換える後継は 1 つ）と `holders`（開いている `unit_replacement`）で、`takes` が真の後継を拒否する。対象は decision/constraint の agent 以外の採用、コードの根拠がある implementation、それ以外の種類の全部
- `server/src/glean.ts:419-435` `checkGlean` は `adopt` で、置き換え先を別の後継が持っていると拒否する。同じ束の `withdraw` だけを考慮する。`server/src/glean.ts:898` `saveGlean` は judge の後で、採用した記録が `settled.held` に入っていれば throw する
- `server/src/judge.ts:66-104` judge が「place held」で待たせるのは、unfit でない（sound、supported、置き換えの意図がある decision/constraint なら持ち主かメンテナーの採用がある）後継だけ。unsourced、quarantined、取り下げ済み、種類が合わない、対象が quarantined または取り下げ済みのものは、その前に別の理由で待つ。agent だけの採用は held にならない
- `server/src/reconcile.ts:194-198` `settled.held` は candidate のうち place held で待つものだけを持つ
- `server/src/mcp-record.ts:70-72` はツールの本体の前に `record_call` を書いてコミットする。`server/src/trace.ts:149-166` は本体が失敗してもその行を残す。`db/schema.sql:708-723` の `agent_ineligible_source` がそれを使う
- `server/src/record.ts:1098` save は lock の中で anchor のファイルを読み直す（隠すべき文字列になった symbol を保存しないため、`server/test/extract.test.ts:625`）
- `server/src/sqlite.ts:52` busy_timeout は 5000 ms。`server/src/deliver.ts:53` 配信のログは 250 ms、`server/src/capture.ts:1184` 観測の書き込みは 5 秒待つ
- `server/test/reconcile.test.ts:327` 3,200 件の置き換えで save を 200 ms 以内に収めるテストがある
- `.github/workflows/check.yml:135` Windows の job が流すテストは `test/file-lock.test.ts` だけ
- `server/test/record.test.ts:777`、`:2539` は `checkRecord` / `checkGlean` を直接呼んで競合の拒否を見ている。`server/test/extract.test.ts:1535`、`:2824` は save の拒否を見ている
- `server/evals/acceptance/driver.ts:430`、`:551` は `checkText` を直接呼ぶ（MCP のツールの包みは通らない。glean は call id なし）
- 前のリリースは v0.6.36（992d5f32）

## 方針

### 共通の実行（extract.ts）

- `saveText` の中身を、準備・検証・書き込み・結果を返す 1 つの関数に切り出す。構造で返す: 検証の errors、problems（trace・harvest・glean の全部。glean の unsourced の警告も）、quarantine の警告、成功したときの save の結果（active、理由付きの candidates、superseded、quarantined、anchor の問題、glean の変更の行）。検証は トランザクションの中で 1 回だけ流す
- lock の前の準備も共有する: `bound`、call id があれば `sameCaller`、`prepareRecord` / `prepareGlean`。lock の中で `bound` をもう一度、`scopeOf`、`agentRun`
- `saveText` は `inTransaction` で流してコミットし、今までどおり検証の errors では throw する。`checkText` は新しい `inRolledBack` で流し、errors と save の中の throw を「✗」の行にする。返答は 1 つの整形関数で作る
- check の成功の返答: 検証の problems と quarantine の警告、続いて `would be active: <key>`、`would stay a candidate: <key>: <why>`、`would be superseded: <key>`、`would be quarantined: ...`、glean は `would: <変更の行>`、最後に「✓ ... can be saved」。拒否のときは errors と problems だけで、結果の行は出さない
- check は `shownTo` を触らない

### ロールバックの助け（db.ts）

- `inTransaction` の隣に `inRolledBack(db, fn)` を置く。`db.connection().execute` で接続を確保し、`begin immediate`、fn にはトランザクションの接続だけを渡し、成功でも失敗でも `rollback` を待ってから接続を返す。成功の側で rollback が失敗したら、結果を返さずにその失敗を throw する
- busy timeout は save と同じ。`record_check` の `readOnlyHint: true` は変えない（コミットされる変化は監査の記録だけ）

### 場所を待つ後継の拒否（record.ts / glean.ts）

- judge と reconcile の後に 1 か所で見る: この save で書いた記録、または glean のこの束の `adopt` で採用した記録が `settled.held` に入っていたら throw する。held は fit な後継だけなので、採用の経路や `takes` は見ない。glean のほかの op（add_evidence など）は対象外（今のまま）
- 文面: 場所を持っている後継もこの save で書いたものなら `<key>: another record in this save already supersedes <target>`、それ以外は `<key>: <target> already has a successor, <holder> (in effect); withdraw it first, or supersede it instead`
- `saveRecord`（trace・harvest）と `saveGlean` の両方がこの 1 つの関数を使う。`settleSaved` の「check refuses it by name」のコメントを今の動きに直す
- `checkRecord` から `claimed`、`holders` の問い合わせ、`takes`、`implemented` を、`checkGlean` の `adopt` から held の問い合わせを消す。対象が無い、すでに superseded か withdrawn、種類が置き換えられない、出どころの信頼の規則は残す

### テスト

- #275 の 4 件を、期待する結果を書いた場面で作る。どれも今のコードで意図した理由で落ちることを先に確かめる
  1. glean の adopt で、同じ束が場所を持つ後継の採用を取り消す場合と、必要な根拠を取り消す場合: check も save も通り、採用した後継が active になる
  2. glean で unsourced になる implementation と、もう 1 つの有効な後継: check も save も通り、unsourced のものは candidate、有効なものが active
  3. 1 つの場所への持ち主の adopt 2 つ: check も save も名前を挙げて拒否する
  4. quarantined の記録の後継 2 つ: check も save も通り、どちらも「target quarantined」で candidate
  各場面で、check の返答の結果の行と、save の後にコミットされた状態を見る
- check が何も残さないこと: 全部の表の行を並べた中身（表ごとに並びのキーを使う。FTS の内部の表は rowid を仮定しない）と `sqlite_sequence` を check の前後で比べ、記録が足す語で検索して結果が変わらないことを見る。4 つの場面と、拒否される save に当てる。成功の場面として、trace の `work` と `source_processing`、glean のファイルの抜粋の source も見る
- 同じ run を check、check、save の順に流し、表示しただけで引用しない source が `source_processing` に入ることで `shownTo` が残っていることを確かめる
- `sameCaller`: ある呼び出し元のセッションで始めた run を別のセッションから check すると、save と同じように拒否される
- 並行: 同じサーバーの接続で check と check、check と save を重ねても、入れ子のトランザクションのエラーにならずに順に流れる。check を途中で止めている間、別の接続はコミット済みの状態だけを読む
- lock の時間: `reconcile.test.ts` の 3,200 件の場面で、`begin immediate` の成功から rollback までの時間を測り、save と同じ 200 ms の予算に収める。lock を待った時間は別に出す。Probe で git と最初の準備が `begin immediate` の前に起きることを確かめる（anchor のファイルの読み直しは lock の中で構わない）。外からの競合は、lock を持つ子プロセスで確かめる
- `record.test.ts:777`、`:2539` の予測の拒否のテストは、check と save を流す形に移し、拒否とロールバックの確認は残す。`extract.test.ts:1535`、`:2824` はそのまま
- acceptance: check の成功の返答（結果の行）と、judge の後の拒否の case を 1 つずつ足し、`acceptance-cases.test.ts` の層ごとの件数を直す
- Windows: `.github/workflows/check.yml` の Windows の job に、ロールバックと lock のテストを流す手順を足す

### 文書とリリース

- trace・harvest・glean の Skill の check の説明と、`record_check` のツールの説明を、結果の行を出すことと保証の範囲に合わせる
- `bun run release:plan -- --base v0.6.36` を流してから、最初の package の変更のコミットで npm と plugin の manifest 3 つを 0.6.37 に上げる

## 採った案と棄却した案

- 採用: B 案、本物の save をトランザクションの中で流してロールバックする。棄却: A 案、書かずに snapshot を組んで judge に通す（`unit_support` は SQL の view で、schema の trigger も拒否するので、書いていない記録について TS で作り直すと、規則の出どころがまた 2 つになる）。棄却: C 案、1 件ずつ直す（PR #273 のレビューのたびに同じ種類のずれが見つかった）
- 採用: 場所を待つ後継の拒否を、この save で書いた記録と glean の adopt の記録が `settled.held` に入るかだけで決める。棄却: 持ち主の採用がある記録だけを拒否する（今拒否している implementation・finding などの競合が、黙って candidate で通るようになる）
- 採用: check と save で準備・検証・整形まで共有する。棄却: トランザクションの中身だけを共有する（`sameCaller` と glean の problems の分だけ check と save がずれる）
- 採用: check の保証を「save の処理の変化をコミットしない」にし、`record_call` と hook の観測は残す。棄却: DB をまったく変えない（観測を消すと、record ツールを流したターンの返事を AI の採用に使わせない規則が弱まる）
- 採用: busy timeout と `readOnlyHint` は save と今のまま。棄却: check だけ待ち時間を短くする（check は hook ではなく agent が呼ぶ）
- 採用: lock の外に出すのは git と最初の準備だけ。棄却: ファイルの読み込みを全部 lock の前に出す（save が lock の中で anchor のファイルを読み直すのは意図した動き）

## 手順

- S1: `inRolledBack` と、その接続・rollback・並行・見え方のテスト
- S2: 準備・検証・書き込み・整形の共通の実行と、check をそれで流すこと（`sameCaller`、glean の problems、check が何も残さないこと、`shownTo` のテスト）
- S3: 場所を待つ後継の拒否を judge の後の 1 か所に移し、予測のコードを消す。4 件の場面のテストと、移すテスト
- S4: lock の時間の計測のテストと、Windows の job の手順
- S5: acceptance の case 2 つと件数
- S6: Skill 3 つとツールの説明
- S7: npm と plugin の manifest 3 つを 0.6.37 に上げる（最初の package の変更のコミットに入れる）

## 完了条件

- A1: `cd server && node --test test/extract.test.ts test/record.test.ts` → pass。#275 の 4 件の場面で、check の返答と save の後の状態が「目的」と「テスト」の期待どおり。check の前後で全部の表の中身・`sqlite_sequence`・検索の結果が同じ。check、check、save の順で `shownTo` が残る。別のセッションからの check が拒否される
- A2: `cd server && node --test test/db.test.ts` → pass（`inRolledBack` のテストを置くファイル）。重ねた check と save が順に流れ、止めている check の間は別の接続がコミット済みの状態だけを読む
- A3: `cd server && node --test test/reconcile.test.ts` → pass。3,200 件の場面で check の lock の中の時間が 200 ms 以内
- A4: `rg -n "claimed|takes|implemented" server/src/record.ts` と `rg -n "already has a successor" server/src/glean.ts server/src/record.ts` → 予測のコードが無く、拒否の文面は judge の後の 1 か所の関数にだけある
- A5: `bun run verify` → 終了コード 0（acceptance の case を含む）
- A6: `bun run release:plan -- --base v0.6.36` → `plugin`。npm と 3 つの manifest が 0.6.37
- A7: `cd plugin && npm pack --pack-destination <リポジトリの外の一時ディレクトリ>` → 展開した中身の数を数え、展開先の `dist/mcp-record.js` を MCP で起動し、一時の HOME の DB で begin → record_check → record_save を流すと、check が「would be active」の行を返し、check の後の DB に記録が無く、save の後に active で入る。CLI（`dist/cli.js doctor`）も別に起動する
- A8: `gh pr checks <PR 番号> --watch` → 必須の項目がすべて pass（Windows の job のロールバックと lock のテストを含む）

## リスク

- check が save と同じだけ書き込みの lock を持つので、capture の hook や配信のログが待つ → A3 で lock の中の時間を測り、save の予算に収める。収まらなければ、どこが遅いかを測ってから plan を直す
- check の返答の文面が変わり、trace・harvest・glean の Skill を読む agent の動きが変わる → Skill の説明を同じ PR で直し、acceptance の case で返答の形を固定する
- 拒否の文面が変わる場面（同じ save の中の競合が「another record in this save already supersedes」になる）で、既存のテストが文面に依存している → 移すテストで期待を直す
- rollback が失敗して、check の書き込みが残る → `inRolledBack` は rollback の失敗を throw し、接続を返さないままにしない。テストで確かめる

## 未解決

なし

## 変更履歴
