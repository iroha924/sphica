---
kind: plan
status: approved
codex_session: 01a114e5-a955-7301-b659-6d361a75e3d9
codex_rounds: 3
approved_at: 2026-10-07
---

# glean で anchor を退かせて持ち主の引用を理由として残し、指示や参照のために読まれるファイルへのパスだけの anchor に check と save で警告する（#209 の E1）

## 要点

- glean に op `retire_anchor` を足す。live な anchor を 1 本（path・symbol・role で特定）、置き換え先を作らずに退かせる。持ち主の発言の引用が必須
- schema revision 12 で表 `unit_anchor_retirement` を足し、retire_anchor と replace_anchor の両方で、退いた理由（run・source・span）を残す。read は退いた anchor を履歴として出す。理由の source を forget すると、理由の行だけが消え、anchor の退去は残る
- 試し: CLAUDE.md・AGENTS.md・`.claude/rules`・SKILL.md へのパスだけの `applies_to` anchor に、trace・harvest・glean の check と save で警告する（保存は止めない）。symbol を足しても read の配信は減らないので、symbol は勧めず「外すか、決定が支配するコードへ付け直す」を勧める
- 試しの採否は merge 前に精度で決める: 判定に当たる持ち主 DB の記録 14 件を固定し、持ち主が 1 件ずつ判定して、過半数が「外す・付け直す」なら採用
- リリース後に、持ち主の言葉で u1・u2・u76・u81 を glean で手入れし、7 日後の配信を観測として #209 に残す（採否の条件ではない）
- 変えないもの: 配信の選び方と予算、unit_anchor の列と trigger、既存の anchor の自動の書き換え。#209 の前からある試し 2 つは別の計画

## 持ち主の決定

- epic #200 の次の作業を E1 #209 にする（2026-10-07、「ok」）
- 対象は #209 の 2026-10-07 のコメントで足した 2 項目: glean で anchor を退かせる（持ち主の言葉を引用し、退いた anchor は履歴として残す）、指示や参照用のファイルへのパスだけの applies_to anchor への record_check の警告（試し。delivery ビューで配信件数を測る）
- 1 項目目が入ったら、u1・u2 の SKILL.md の anchor と u76 の CLAUDE.md・AGENTS.md の anchor を退かせ、u81 を `server/src/deliver.ts` の `CONFIRM` に絞る

## 目的

- 持ち主の発言を引いて、記録の anchor を置き換え先なしで退かせられる。退いた anchor は、read で理由の引用（無ければ not recorded）とともに見える
- 指示や参照用のファイルにパスだけの applies_to anchor を付けようとすると、check と save の両方で警告が出る。保存は成功する
- 警告の採否が、固定した 14 件への持ち主の判定で #209 に残る

## 対象外

- #209 の前からある試し 2 つ（後で取り消された発言の引用、同じセッションで先に配信した記録に近い候補）。それぞれ別の正解データと基準が要るので、別の計画にする
- 秘密の形の型付きプレースホルダ（#209 の 3 つ目の試し）
- 配信の選び方を symbol で絞ること（読む前・編集前の配信は path で選ぶ。変えると配信全体の挙動が変わる）
- read に anchor の ID を出すこと（role で絞れば足りる。持ち主 DB で曖昧な組は 0）
- 既存の記録の anchor の一斉の書き換え、`instructionFile` の判定の変更
- 持ち主の本番 DB への、ブランチのコードでの書き込み

## 前提

- `unit_anchor` は `retired_at` と null 可の `replaced_by` を持ち、`unit_anchor_frozen` は退去を 1 回だけ許す（`db/schema.sql:660-701`）。退くだけの anchor は今の schema で表せる
- replace_anchor は引用が持ち主の発言かを検査するが（`server/src/glean.ts:436-438`）、引用はどこにも残らない。glean は `source_processing` も書かない
- read は live な anchor だけを出す（`server/src/read.ts:275`）
- ingest が更新できる unit_anchor の列は `retired_at` と `replaced_by` だけ（`server/src/db-write.ts:171`）
- 読む前・編集前の配信は path と role で選び、symbol を見ない（`server/src/deliver.ts:261-268` の `anchoredTo`）。プロンプトの配信は symbol か path の名指し（`deliver.ts:577`）。applies_to の anchor が 1 本も無い constraint は SessionStart の候補になる（`deliver.ts:664-676`）
- `instructionFile`（`server/src/rule-files.ts:158`）は AI の採用を止める広い判定で、plugin/.claude-plugin/plugin.json や .claude/plans/ にも当たる。`isRuleFile`（`rule-files.ts:16`）は CLAUDE.md・AGENTS.md・AGENTS.override.md・`.claude/rules/**/*.md`
- glean の save は check の problems を出さない。保存時の anchor の警告は `units.anchorProblems` から出る（`server/src/extract.ts:745-751`、`glean.ts:774`）。trace と harvest は保存直前に symbol を判定し直す（`server/src/record.ts:1068` 付近）
- glean の検査は、replace の先にある操作を入力の index で判断する（`glean.ts:577-597`）。保存は replace を先に流す（`glean.ts:702-706`）
- session の直接の削除を止める trigger は、引用している source を表ごとに列挙している（`db/schema.sql:138-147`）
- evidence の削除・追加は記録の revision を上げる（`db/schema.sql:1004` 付近）。source と run の project の一致は `db/schema.sql:884`、span の UTF-8 の境界は `:891` で検査している
- 持ち主の DB（2026-10-07、読み取り専用で数えた）:
  - active な記録の live な applies_to anchor のうち、isRuleFile か末尾が SKILL.md のパスに付いたものは、全部 symbol なし。記録は 14 件（u1, u2, u32, u53, u54, u57, u59, u71, u76, u85, u132, u148, u165, u218。decision 10、finding 4、constraint 0）
  - 同じ記録・path・symbol・role で live な anchor が 2 本以上ある組は 0
  - delivery ビュー（7 日）: u1 は 215 セッション、u2 は 214、u76 は 67、u81 は 64 に配信され、言及は 0
- 未検証: forget の authorizer が、source の削除から新しい表への cascade を今の規則のまま通すか（S2 で実 DB の検査で確かめる）

## 方針

### S1 schema revision 12

`db/schema.sql` に足し、`db/migrations/0012.sql` に同じ文を置く。unit_anchor は作り直さない。

```sql
create table unit_anchor_retirement (
  anchor_id integer primary key not null references unit_anchor (id) on delete cascade,
  run_id integer not null references extraction_run (id),
  source_id integer not null references source (id) on delete cascade,
  span_start integer not null check (span_start >= 0),
  span_end integer not null check (span_end > span_start),
  added_at text not null check (strftime('%Y-%m-%dT%H:%M:%fZ', added_at) is added_at)
) strict;
create index unit_anchor_retirement_run on unit_anchor_retirement (run_id);
create index unit_anchor_retirement_source on unit_anchor_retirement (source_id);
```

trigger:
- 挿入: anchor が退いている（`retired_at is not null`）、source が anchor の記録と同じ project、run が同じ project、span が source の text のバイト長の内側で UTF-8 の文字境界、source の `author_kind = 'owner'`。違えば abort
- 更新はすべて拒否。削除は source か anchor の削除からの cascade だけを許す（evidence の削除の許し方と同じ形）
- 挿入と削除で、anchor の記録の `unit.revision` を上げる
- `session_cited`（`db/schema.sql:138`）に `unit_anchor_retirement.source_id` を足す
- `pragma user_version = 12`、`SCHEMA_REVISION` を 12 に。`bun run codegen` で `db-types.ts` を作り直す。`server/test/fixtures/` に revision 11 の schema を置く

### S2 権限と forget

- ingest: `unit_anchor_retirement` への insert を許す（`server/src/db-write.ts`。更新・削除は許さない）
- forget: source の削除から新しい表の行が cascade で消える経路を、evidence と同じに通す。forget の preview と apply の件数に「retired-anchor reasons」を足す（`server/src/forget.ts`）
- 実 DB の検査: replace A→B→C の A→B の理由の source を forget しても、A と B の `retired_at`・`replaced_by`、C の live が残り、read の履歴で A→B の理由が not recorded になる

### S3 glean の retire_anchor

- 入力: `{ op: "retire_anchor", unit, revision, from: { path, symbol?, role? }, source, quote }`。replace_anchor の `from` にも任意の `role` を足す
- 検査（replace_anchor の from と共通の関数にまとめる）: path・symbol・role で live な anchor がちょうど 1 本。0 本なら「no live anchor on …」、2 本以上なら「… live anchors on …; give from.symbol or from.role」（commit 違いと行範囲の違いを内訳として出す）。引用は owner の発言だけ（「only the owner's words can retire an anchor」）
- 同じ batch で同じ anchor を 2 回退かせる・置き換える組み合わせは拒否（replace 用の Map を retire と共用）
- 検査も保存も、retire → replace → anchor の順で判断する。検査の「後の操作が先の anchor を動かす」の判定（`glean.ts:577-597`）を入力の index ではなくこの実行順で行う。入力が replace A→B、retire B の順でも通る
- 保存: `retired_at = now`、`replaced_by = null` に更新し、同じ transaction で `unit_anchor_retirement` に理由を入れる。replace_anchor も理由を入れる。理由の挿入が失敗したら退去も rollback
- 保存の後は既存どおり reconcile（`settleSaved`）。実装の唯一の evidence anchor を退かせたら candidate に戻る
- 変更行: `<unit>: anchor retired`

### S4 read の履歴

read（`server/src/read.ts`）は、live な anchor の「Code」の後に「Retired anchors」を出す。1 行 1 本で、path・symbol・role・退いた日時・置き換え先（あれば path と symbol）・理由（`s<id>` と引用、持ち主、日時。理由の行が無ければ `reason not recorded`）。`asOf` のときは、その時点で退いていたものだけ。返答の上限（`READ_BUDGET`）の中で、既存の切り詰めの仕組みに乗せる

### S5 警告

- `server/src/rule-files.ts` に `referenceFile(rel)`: `isRuleFile(rel)` か、最後の要素が `SKILL.md`。`instructionFile` は変えない
- `server/src/record.ts` に `referenceAnchorWarning(a: { path, symbol, role }): string | null`。applies_to かつ symbol なし（伏せ字で落ちた後の、実際に保存する anchor で判定）かつ referenceFile のとき、次の文を返す:
  `anchor ${path} is a file agents read for instructions or reference, so the record is offered every time that file is read or edited; unless the record decides how that file itself changes, retire the anchor or anchor the code the decision governs`
- anchorProblem の早期 return（作業ツリーなし、commit 保持）とは別に呼ぶ
- trace・harvest: checkRecord の anchor 検査（`record.ts:600-680`）と、保存直前の判定し直し（`record.ts:1068` 付近）の両方で problems / anchorProblems に足す。glean: anchor と replace_anchor の検査と保存（`glean.ts:774`）で足す
- check と save で同じ警告が出て、保存は成功する

### S6 Skill と案内

- `plugin/skills/glean/SKILL.md`: retire_anchor の行、replace_anchor の from.role、退いた理由が read に出ること、警告の読み方
- `plugin/skills/trace/SKILL.md` と `plugin/skills/harvest/SKILL.md`: 警告の読み方（そのファイル自体を変えるときの決定ならそのまま、そうでなければ anchor を外すか付け直す）
- `server/src/delivery-view.ts` の締めの文「Change a record only through /sphica:trace」を、trace か glean と言う文にする
- 受け入れのケース（`server/evals/acceptance/cases.json`）に retire_anchor と警告のケースを足す（件数の検査 `server/test/acceptance-cases.test.ts` も直す）

### S7 試しの測定（merge 前）

- 仮説: この警告が指す記録の過半数は、anchor を外すか付け直す対象である
- 対象の固定: ブランチの時点の持ち主 DB で、下の SQL の 1 本目に当たる記録の ID 集合（2026-10-07 は 14 件）。後で条件を掛け直さず、この集合を追う
- 持ち主の判定: 各件を「外す・付け直す / そのまま」。Claude が各件を読んで日本語で要約と判断の案を付け、持ち主が決める
- 採用の基準: 過半数が「外す・付け直す」。届かなければ S5 の警告と Skill の記述を最終の差分から外し、S1〜S4 と S6 の残りだけを出す
- 表示: 「修正対象記録の過去の配信量」として、「外す・付け直す」になった記録の直近 7 日の配信件数（全イベント、イベント別、セッション数）。削減見込みとは呼ばない（別の anchor や別のイベントでも配信される）
- 結果は #209 にコメントする（文面は持ち主の承認の後）

集計の SQL（`sqlite3 -readonly ~/.sphica/sphica.db`）:

```sql
-- 1. 対象の記録
select distinct u.id from unit u join unit_anchor a on a.unit_id = u.id
where u.lifecycle = 'active' and a.retired_at is null and a.role = 'applies_to' and a.symbol is null
  and (a.path like '%CLAUDE.md' or a.path like '%AGENTS.md' or a.path like '%AGENTS.override.md' or a.path like '%SKILL.md'
    or a.path like '.claude/rules/%.md' or a.path like '%/.claude/rules/%.md')
order by u.id;
-- 2. 固定した集合（:ids）の直近 7 日の配信
select d.event, count(*) as deliveries, count(distinct d.session_id) as sessions
from delivery_unit du join delivery d on d.id = du.delivery_id
where du.unit_id in (:ids) and d.at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
group by d.event;
```

### S8 リリース後の手入れ（観測）

- リリースと手元の更新の後、持ち主がセッションで u1・u2・u76・u81 の手入れを言い、その発言を引いて glean で: u1・u2 の `.agents/skills/plugin-release/SKILL.md` を retire、u76 の CLAUDE.md と AGENTS.md を retire、u81 の `server/src/mcp.ts` を retire し、`server/src/deliver.ts` を `deliver.ts CONFIRM` に replace
- u81 の deliver.ts の配信は symbol に絞っても減らない（前提のとおり）。効果として見るのは mcp.ts を外した分
- 7 日後に S7 の SQL の 2 本目で、同じ 4 件の配信を前後で比べ、#209 に残す。採否の条件ではない

## 採った案と棄却した案

- 採用: 退いた理由を別表 `unit_anchor_retirement` に置く。棄却: 理由を残さず引用を検査だけする（read から根拠を確かめられない）、unit_anchor に列を足して forget で SET NULL（frozen trigger に例外が要り、表の作り直しになる）
- 採用: 警告専用の `referenceFile`（rule ファイルと SKILL.md）。棄却: `instructionFile` をそのまま使う（plugin.json や plans にも当たる）、plugin/ 以下を一括で外す（製品の Skill への正しい anchor と参照用を区別できない）
- 採用: 警告文は「外すか、決定が支配するコードへ付け直す」。棄却: symbol を勧める（read と edit の配信は path で選ぶので減らない）
- 採用: 採否は merge 前に、固定した集合への持ち主の判定（精度）で決める。棄却: PR ブランチの record server で 7 日間使って配信を比べる（持ち主の本番 DB にブランチの書き込みが入り、隔離 DB では配信が起きない）
- 採用: from に role を足して絞り、曖昧なら拒否。棄却: read に anchor の ID を出して ID で指す（今の DB に曖昧な組が無い）
- 採用: #209 の前からある試し 2 つは別の計画。棄却: 同じ PR に入れる（別の正解データと基準が要る）

## 手順

- S1: schema revision 12（表・index・trigger・session_cited・migration・codegen・fixtures）
- S2: ingest と forget の権限、forget の件数
- S3: glean の retire_anchor、from.role、検査の実行順、replace_anchor の理由の保存
- S4: read の退いた anchor の履歴
- S5: referenceFile と警告（trace・harvest・glean の check と save）
- S6: Skill 3 つ、delivery ビューの締めの文、受け入れのケース、バージョン
- S7: 試しの測定と持ち主の判定、採否

方針の S8（リリース後の手入れと観測）は、merge とリリースの後に行う持ち主の操作で、コミットを伴わないので手順の塊に入れない。

## 完了条件

- A1: `bun run verify` → 全項目 pass
- A2: `cd server && node --test test/migrate.test.ts` → revision 11 から 12 への移行が新しく作った DB と一致
- A3: `cd server && node --test --test-timeout=60000 test/extract.test.ts test/schema.test.ts test/db.test.ts test/forget.test.ts test/read.test.ts test/record.test.ts` → 全件 pass。中に次のテストがある: retire の成功、owner 以外の引用の拒否、引用の不一致、退いた anchor の再退去の拒否、role での特定と曖昧な組の拒否、入力が replace A→B・retire B の順でも通る、理由の挿入の失敗で退去も rollback、唯一の evidence anchor を退かせたら candidate、forget の後も退去と置き換えが残り理由が not recorded、session_cited による削除の拒否、警告が trace・harvest・glean の check と save の両方に出て保存は成功、symbol 付き・evidence・対象外のファイルには出ない
- A4: `bun run acceptance` → retire_anchor と警告のケースを含めて pass（実装前に同じケースが未知の op で失敗したことは、tasks の red の結果行に残す）
- A5: `bun run release:plan -- --base v0.6.40` → `plugin`。`bun run verify` の版の一致の検査が pass（npm と 3 つの manifest が同じバージョン）
- A6: `npm pack` → tarball を scratchpad に展開して中身を数え、plugin-release Skill の手順で起動すると、MCP サーバーと CLI が起動し、revision 12 の DB を作る
- A7: `gh issue view 209 --comments` → S7 の判定の結果と採否のコメントがある。採用しなかったときは `git diff main -- server/src/record.ts | grep referenceAnchorWarning` → 何も出ない
- A8: `gh pr checks <PR>` → 全項目 pass

## リスク

- forget の authorizer が新しい表への cascade を拒否する → S2 の実 DB の検査で見つけ、forget の許可に足す。足せないなら別表の案を Codex と見直す
- migration の後、古いプラグインの read が新しい revision で止まる → 既存の revision の扱い（reader は不一致で止まり、capture は生成だけを見る）どおり。リリースノートで更新を促す
- 持ち主の判定で過半数に届かない → 警告を最終の差分から外し、retire_anchor と履歴だけを出す
- read の返答が退いた anchor で長くなる → `READ_BUDGET` の切り詰めに乗せ、テストで上限内を確かめる

## 未解決

なし

## 変更履歴
