---
kind: plan
status: approved
codex_session: 01a0ed37-2df2-7f71-a74b-9048171a556a
codex_rounds: 4
approved_at: 2026-09-29
---

# プロジェクトごとのカスタム項目を、引用付きの値として trace の記録に持たせる期限付きの試作（#196、0.6.8）

## 要点

- DB に項目の定義（`field_def`）と記録ごとの値（`unit_field`）の表を足し、schema を revision 4 に上げる（移行 `0004.sql`）
- 定義も値も trace の `record_save` で書く。定義は持ち主の発言の引用が必須、値は引用の中にその表記がそのまままあるときだけ通る。harvest と glean からは受け付けない
- 値は検索の索引と判定に入り、`read` に引用付きで出る。定義の一覧と値の件数を表で見せる読み取りツール `fields` と `/sphica:fields` Skill を足す
- forget は定義・値の引用元を消すと、それらも消し、プレビューで件数を数える
- 試作中は再定義を受け付けない。出荷日 +28 日に、値の件数と役に立った検索の例を持ち主と見て、続けるかやめるかを決める
- 変えないもの: 固定の unit kind、既存の記録の書き換え不可、配信フック、review、export、harvest、CLI

## 持ち主の決定

- #196 本文（2026-09-28、Codex と合意し持ち主が受け入れ）: 定義の表と値の表をプロジェクトごとに持つ（型 text / enum / integer / date）。定義を Markdown の表で見せる Skill。trace は引用があるときだけ値を埋める。役に立つ検索や見せ方が出なければ本格実装せずにやめる
- 棄却済み（同上）: プロジェクトごとに ALTER TABLE で列を足す案、項目で動く review の観点
- #198 と別の PR にし、#198 を先に出す（記録 u56、2026-09-29）

## 目的

- 持ち主が会話で項目を定義すると、その trace で定義が保存され、以後の trace で引用できる値があるときだけ記録に値が付く
- 値の語だけで search すると、その値を持つ記録が結果に残る
- `read` で、値と、その source ref・引用文・話し手・日時が見える
- `/sphica:fields` で、定義と、項目ごとに値の付いた記録の件数が表で見える

## 対象外

- 組み込みの項目（MADR の Confirmation など）。持ち主が定義すればよい
- 再定義・定義の失効。続けると決めてから設計する（同名は unique にし、失効の規則が無いまま最新行を有効にすると、引用元の forget で古い定義が戻るため）
- 既存の記録に後から値を足すこと。値は記録と一緒に書く
- harvest と glean からの入力、export への表示、search の項目での絞り込み引数、配信フックと review での値の扱い。試作で役に立つと分かってから

## 前提

- 記録の書き込みは record MCP サーバーの run-bound ツールだけ（CLAUDE.md の invariant record-writes）。glean も `checkRecord` を通る（`server/src/glean.ts:202-212`、Codex 確認）
- unit_option は unit と一緒に、最初の state と alias より前にだけ書ける（`db/schema.sql:274-277`）
- save が集める引用の source は unit の evidence・adoption・option の引用だけで（`server/src/record.ts:191-213`）、集めなかった source は `no_unit` になる（`server/src/record.ts:720-724`）
- search は FTS の候補を `judgeUnits` で本文・options・anchors・aliases の語と照らし直し、半分を超える語を持つものだけを残す（`server/src/search.ts:45`、`224-284`）。索引に入れるだけでは値だけの一致が落ちる
- 子の表の変更で unit の revision を上げるトリガーがあり（`db/schema.sql:598-616`）、glean はその revision を照合する（`server/src/glean.ts:273-284`）
- forget 接続は書いてよい表を列挙している（`server/src/db-write.ts:140-162`）。unit_fts への INSERT・DELETE は今は許されず、値の削除トリガーが索引を作り直すと `not authorized` になる（Codex がメモリ内 SQLite で再現）。プレビューは unit_evidence と unit_adoption だけを数える（`server/src/forget.ts:85-125`）
- `inline()` は改行を空白にするが `|` は逃さない（`server/src/panel.ts:64-68`）。外から来た文字列の囲みは `framed`（`server/src/frame.ts:6-13`）
- 現在 revision 3（`db/schema.sql:755`、`server/src/sqlite.ts:16`）、最新のタグは v0.6.7。移行テストは前の schema を `server/test/fixtures/` に持つ（`server/test/migrate.test.ts`）

## 方針

### schema（revision 4、`db/schema.sql`、`db/migrations/0004.sql`）

- `field_def`: `id`、`project_id`、`name`（`[a-z][a-z0-9_]{0,39}`）、`type`（`text|enum|integer|date`）、`label`、`description`、`enum_values`（type が enum のときだけ、1〜30 件の文字列の JSON 配列）、`kinds`（unit kind の JSON 配列、空は全部）、`source_id`（source に on delete cascade）、`span_start`、`span_end`、`run_id`、`added_at`。unique(project_id, name)。update は拒否
- `unit_field`: `id`、`unit_id`（cascade）、`field_def_id`（cascade）、`value`（text）、`source_id`（cascade）、`span_start`、`span_end`、`run_id`、`added_at`。unique(unit_id, field_def_id)。update は拒否、unit が残るときの単独の delete は source の削除による cascade だけ
- トリガー: 定義の source が owner の種類であること。定義・値・unit・source・run のプロジェクトが一致すること。範囲が source 本文の内側。unit の kind が定義の kinds に入ること。値は unit の最初の state と alias より前にだけ書ける。型: integer は整数の文字列、date は `date(value) = value`、enum は定義の enum_values の中、text は 1〜200 文字
- `unit_search_text` の body に `<name> <value>` を足す。`unit_field` の insert と delete（unit が残るとき）で unit_fts を作り直すトリガー、revision を上げる `unit_rev_field_i` / `unit_rev_field_d`
- 移行はビューとそれを読むトリガーを落として作り直す（0003.sql と同じ形）。codegen、`server/test/fixtures/schema-rev3.sql`

### forget（`server/src/db-write.ts`、`server/src/forget.ts`）

- `FORGET_WRITES` の DELETE に `field_def`・`unit_field`・`unit_fts`、INSERT に `unit_fts` を足す
- プレビューに、消える定義の件数と、定義経由・引用経由で消える値の件数（重複なし）を足す

### 記録の入力（`server/src/record.ts`、`server/src/mcp-record.ts`）

- record に `field_defs: [{ name, type, label, description, enum?, kinds?, quote: { source, quote } }]`、unit に `fields: [{ name, value, quote: { source, quote } }]`
- 拒否（save 全体）: trace 以外の run に field_defs か fields がある。定義の引用が owner でない、見つからない。同名の定義が既にある、record の中で重複する。値の name がプロジェクトの定義にも同じ record の field_defs にも無い。型や kinds に合わない。引用が見つからない。値の表記が引用の中に無い
- 値の表記の規則: text は引用の部分文字列。enum と date は値の表記そのもの（大文字小文字も一致、日付の言い換えは認めない）。integer は、引用から数値表記全体（符号・小数点・指数を含む並び。数字の直前が ASCII の英字かアンダースコアならそこを開始としない。日本語は数字の直前に助詞が来るので、ほかの文字は数えない）を切り出し、どれかが値の文字列と完全一致すること。例: `p95=320ms` から `320` は通り、`95` は拒否。`-5` から `-5` は通り、`5` は拒否。`1.5` から `1`、`1e3` から `1` は拒否
- 定義と値の引用の source を refs と cited に含める（定義だけの save でも `units` になる）
- `record_context` に、このプロジェクトの定義（name、type、label、description、enum、kinds）を出す。無ければ出さない

### 読み取り（`server/src/read.ts`、`server/src/search.ts`、`server/src/mcp.ts`）

- `judgeUnits` の判定語に unit_field の name と value を足す
- `read` に `Fields:` として、name、値、source ref、引用文、話し手、日時を出す
- 読み取りツール `fields`（入力: cwd）: 定義ごとに name、type、label、enum、kinds、値の付いた記録の件数、定義の引用の Markdown 表。セルは改行を空白に、`|` を `\|` に、各 200 文字で切る。結果全体を `framed` で囲む
- `/sphica:fields` Skill: `fields` を呼んで表を見せる。書き込みはしない。`disable-model-invocation: true` と `agents/openai.yaml` の `allow_implicit_invocation: false` を対にする

### trace Skill と出荷

- `plugin/skills/trace/SKILL.md` に、持ち主が項目を定義したら field_defs に書くこと、定義があるときだけ値を埋めること、引用に値の表記が無ければ埋めないことを足す
- `release:plan` の kind に従い、0.6.8 で npm と 3 つのプラグインの manifest を揃える

### 試作の終わり

- 出荷日 +28 日に、`fields` の件数と、値で検索して役に立った例を持ち主と見る
- やめるなら、先に trace Skill と record の入力から項目を外すリリースで書き込みを止め、持ち主に確かめてから revision 5 で両表を消す（試作の値は捨てる）
- 続けるなら、再定義・harvest・export を別の計画にする

## 採った案と棄却した案

- 採用: 定義も trace の record_save で持ち主の引用付きで書く。棄却: `/sphica:fields` から書く専用の record ツール（書き込み経路と持ち主の確認の仕組みがもう 1 つ要る）
- 採用: 同名の再定義を拒否。棄却: 同名の最新行を有効にする（引用元の forget で古い定義が戻り、古い値と新しい型の関係が曖昧）
- 採用: 値は unit と一緒に封じる。棄却: 既存の unit へ後から追記（書き込み経路と revision の扱いが増える）
- 採用: 全型で値の表記が引用の中にあることを要求。棄却: text と integer の部分一致だけ（`p95=100` から `1`、enum と date は引用に無い値が通る）
- 採用: 索引に加えて検索の判定語にも値を入れる。棄却: 索引だけ（判定で弱い一致として落ちる）
- 採用: 入力は trace だけ。棄却: harvest と export も最初から（役に立つかを見る前に範囲が広がる）

## 手順

- S1: 失敗するテストを先に書く。acceptance（定義 → 値 → 値だけで search に残る、引用に表記の無い値が拒否、定義だけの save が `units`）、schema.test.ts（各トリガーの拒否）、integer の例、forget（定義の引用元・値の引用元を消すとプレビュー件数・cascade・索引から消える・古い revision の glean が拒否）、移行。意図した理由で落ちることを確かめる
- S2: schema revision 4、移行 0004.sql、codegen、fixture の rev3、forget の認可とプレビュー
- S3: record.ts の入力・検査・save（trace 以外の拒否、refs と cited）、record_context の定義、search の判定語
- S4: read の Fields、読み取りツール `fields`、`/sphica:fields` Skill
- S5: trace Skill の本文、バージョン、release

## 完了条件

- A1: `bun run verify` → 0 で終わる
- A2: `cd server && node --test --test-timeout=60000 test/migrate.test.ts` → revision 3 から移行した DB と新しい DB の schema が一致して通る
- A3: `cd server && node --test --test-timeout=60000 test/acceptance-cases.test.ts` → 新しい 3 件を含めて通る（S1 の時点で意図した理由で落ちたことは tasks の red に記録する）
- A4: `npm pack && tar -xzf sphica-*.tgz -C <repo の外の一時ディレクトリ>` → 展開先に `fields` ツールを持つ MCP サーバーと `/sphica:fields` Skill があり、そのサーバーを起動して `fields` を呼ぶと表が返る
- A5: `bun run release:plan -- --base v0.6.7` → `plugin`、npm と 3 つの manifest が 0.6.8

## リスク

- trace が値を作り話で埋める → 引用必須と表記の一致で止める。すり抜けた例が出たら規則を足す
- やめるときに消す移行が要る → 「試作の終わり」の 2 段で出す
- forget が新しい表で失敗する → 実際の forget 接続で 2 種類の削除をテストする

## 未解決

なし

## 変更履歴
2026-09-29 / integer の数値の開始の条件を「直前が Unicode の文字」から「直前が ASCII の英字」に狭めた / 「レイテンシは3件」のように、日本語では助詞の直後に数字が来て値を取れなかった（T03 のテストで判明）。`p95` の拒否は変わらない / Go 不要（合意した規則の意図の内側。T03 のレビューで Codex に判定を頼む）
