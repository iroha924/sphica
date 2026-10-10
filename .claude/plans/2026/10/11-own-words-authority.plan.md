---
kind: plan
status: approved
codex_session: 01a1264e-5aed-7672-b9c8-5ac091c3a8b8
codex_rounds: 4
approved_at: 2026-10-11
---

# 権限の根拠になる言葉を 1 つの検査に通し、引用の中の言葉を本人の言葉として受け付けない

## 要点

- 「持ち主（かメンテナー）本人の言葉」を権限の根拠にする全部の箇所を、1 つの関数に通す。対象は、新しい記録の採用、glean の 7 つの操作（adopt、replace_anchor、retire_anchor、retract_evidence、retract_adoption、withdraw、resolve_conflict）、項目の定義、見直す条件、harvest と glean の置き換え・衝突の根拠
- 引用の判定を作り直す。今の判定は、引用符の中の一部分や「導入文＋引用の行」を通し、別の行に引用符があるだけの本人の指示を拒む
- 確かめ済みの言葉だけを保存できる型にして、新しい箇所での付け忘れを型検査で止める。保存のときに位置を取り直さない
- 隔離された記録（引用が見つからない、出典が無い）が持つ「衝突」のリンクを、配信の判定に効かせない。既存のリンクにも効く（行は変えない）
- 既に DB にある行は自動では変えない。`sphica doctor --audit-quotes` が、新しい規則に通らない権限の行を一覧にし、種類ごとの直し方と直せない範囲を示す
- Skill（glean・harvest・trace）と ASSURANCE.md に、機械が確かめるのは引用の位置までで、採用の意味（言葉と記録の内容が合うか）は確かめないことを書く
- 変えないもの: 誰が採用できるかの規則、schema、通常の根拠（evidence）の扱い、既存の行、CLI のコマンドの数（init・doctor・uninstall）

## 持ち主の決定

- 「妥協は無し。何かあれば根本的にやること」（Sphica の記録 `trace:8c8dba6b-9f75-4ccb-b27f-661f99549b19/no-compromise-root-fix`）
- 引用（`>` の行）・コードブロック・同じ行の引用符の中の言葉は、持ち主の発言でも AI の返事でも採用の根拠にしない（Sphica の記録 `trace:02d1edcd-26b8-4e63-85a8-b10d404cd68d/quoted-words-never-adopt`）
- 「今の作業が終わった後にすぐやろう」（2026-10-10、バッジの PR #313 の後に着手する）
- 「通常の修正で良さそうだよね」（2026-10-11、advisory は出さず、リリースノートに書く。Codex の 3 往復目の後に持ち主が決定）
- 直している途中を公開の場に置かない。手元で直してレビューまで終えてから、まとめて push してリリースする
- API キーや追加の課金が要る機能にしない。CLI は init・doctor・uninstall だけ

## 目的

- 引用・コードブロック・同じ行の引用符の中だけにある言葉を権限の根拠に指定すると、上の全部の箇所で拒まれる（glean の操作・項目の定義・見直す条件は保存を拒む。新しい記録の採用は外れて候補に残る）
- 権限の表（`unit_adoption` など）へ書く処理は、共通の関数が返した型を受け取らないと型検査を通らない
- 隔離された記録の衝突のリンクがあっても、相手の記録は自動配信され、`read` の説明もそれと一致する
- `sphica doctor --audit-quotes` が、DB を 1 行も変えずに、新しい規則に通らない権限の行を示す

## 対象外

- 採用の意味の検査（言葉と記録の内容が合うか）。元から確かめておらず、別の話題への「OK」を根拠に指定すれば同じ記録を採用にできる（Codex が実際の SQLite で確認）。この修正が止めるのは、貼り付けられた他人の文を本人の言葉と取り違える誤りまで
- 引用符の無い貼り付け、インデントのコードブロック、入れ子の引用符、エスケープの検出（近似であることをコメントと ASSURANCE.md に書く）
- 既存の行の自動の無効化と、判定（judge・`authorityOf`）全体の再判定。規則は近似なので、本当の判断を誤って無効にする恐れがあり、無効化は置き換えの連鎖を動かす
- 項目の定義（`field_def`）を直す・取り下げる操作の追加。監査で該当が見つかったときに、持ち主へ聞いて別の計画にする
- 候補・取り下げ済み・置き換え済みの記録が持つ衝突のリンクの扱いの変更（今回は隔離された記録だけ）
- 通常の根拠（evidence）と、撤回の対象を選ぶための quote。引用の中でも今までどおり受け付ける
- advisory の公開。下書きのまま残っている GHSA-wvqq-5g4x-9pj8 の扱いは別に決める

## 前提

- 引用の検査は `quotedSpan`（`server/src/record.ts:204`）と `inlineQuoted`（`server/src/record.ts:225`）で、呼んでいるのは新しい記録の採用の 1 か所だけ（`server/src/record.ts:583`）。glean の新しい記録も `checkRecord` を通る（`server/src/glean.ts:305`）
- 発言者だけを見ている箇所: glean の adopt（`server/src/glean.ts:427`）、replace_anchor・retire_anchor（`server/src/glean.ts:452`）、retract_evidence・retract_adoption・withdraw・resolve_conflict（`server/src/glean.ts:541`）、項目の定義（`server/src/record.ts:418`）、見直す条件（`server/src/record.ts:500`）、置き換え・衝突の trusted（`server/src/record.ts:531`）。trusted は入力の quote が source に実在するかも見ない
- Codex が、メモリ上の SQLite に今の schema を当てて再現した（owner 接続）: 引用の中の文で glean の 7 つの操作が保存される、項目の定義が足される、見直す条件付きの決定が active になる、引用の中の assistant の発言を根拠にした finding の `supersedes` が効く
- 今の判定の抜け（Codex の実測）: `They said "please Drop this decision. now".` の `Drop this decision.` が通る。引用符ごと指定しても通る。`They said:\n> Drop this decision.` を全体で指定すると通る。`"A third party example."\nWithdraw it.\n"Another example."` の `Withdraw it.` が拒まれる
- 隔離された記録の `conflicts` は保存され（`server/src/record.ts:1134`）、配信の衝突の検索は相手の extraction を見ない（`server/src/deliver.ts:124`）。Codex の実測で、正常な記録が配信の対象から外れた。`supersedes` は効かない（`server/src/judge.ts:70`、`db/schema.sql:556`）
- 公開の `record_save` は、保存のトランザクションの中で検査し直す（`server/src/mcp-record.ts:254` → `server/src/extract.ts:741` → `:630` → `:639`）。検査を通らずに保存する道は見つかっていない
- 保存は位置を取り直している（`server/src/glean.ts:734` の `spanOf`）。`Planned` は確かめ済みの span を持たない（`server/src/glean.ts:223`）
- 既存の行で直せないもの（Codex の実測と `db/schema.sql`）: withdrawn は戻らない（`:627`）、撤回した同じ span の再登録は何も変えない（`:945`、`:983`）、外した anchor の行は更新できない（`:693`）、解決した衝突は同じ組で開き直せない（`:501`）、`field_def` は変更も取り下げもできない（`:859`）。withdraw と resolve_conflict の理由は span を保存していない（`server/src/glean.ts:910`、`:925`）。`unit_link` は権限の根拠の source と span を持たず、行 ID も無い（`db/schema.sql:481`、`:490`）
- 通常の doctor は `inspect` を通り、owner 接続で全文検索の整合性の検査（INSERT）を流す（`server/src/cli.ts:225`、`server/src/admin.ts:439`、`:442`）
- 未検証: 持ち主の実際の DB に該当の行があるか。ingest 接続と MCP ホストを通した再現（Codex の再現は owner 接続）

## 方針

**共通の関数**（新しいモジュール `server/src/own-words.ts`）

- `ownWords(source, quote, policy)` が、確かめ済みの span（型 `OwnWords`: source の id、開始、終了、採用の route）か、拒む理由を返す。`OwnWords` はこのモジュールだけが作れる（外から作れない型にする）
- policy は 4 つ: `owner`（持ち主だけ）、`maintainer`（持ち主かメンテナー。`pr_event` は不可）、`agent`（trace の AI 自身の判断。今の条件のまま）、`trusted`（harvest・glean の置き換え・衝突: 持ち主のセッションの発言、持ち主、メンテナー）
- 確かめること: quote が source に実在する、発言者が policy に合う、引用の規則に通る

**引用の規則**（source 全体から引用の範囲を求めて判定する）

- ブロックの引用: `>` で始まる行、フェンスの中と、フェンスの行そのもの。span が 1 行でも触れたら拒む。フェンスは開いた種類（バッククォートかチルダ）と長さを覚え、同じ種類で開き以上の長さの行だけを閉じとする
- 同じ行の引用符: 行ごとに開きと閉じを対にして範囲を求める（別の行の引用符とは対にしない）。`"`、`“”`、`‘’`、`「」`、`『』`、バッククォート。バッククォートは連続列を 1 つの区切りとして、同じ長さの列と対にする。ASCII の `'` は、開きは直前が行頭・空白・開き括弧のとき、閉じは直後が行末・空白・句読点のときだけ数える
- span からその範囲を除いたときに、Unicode の letter が残らなければ拒む。残れば通す（数字と記号だけが残る場合は拒む）
- 保証するのは「span はブロックの引用に触れず、同じ行の引用符の外に本人の言葉がある」まで。意味は保証しない

**権限になる箇所**（全部が `OwnWords` を受け取る）

- 新しい記録の採用（`owner` / `maintainer` / `agent`）: 通らなければ採用を外して候補に残す（今のまま problems）
- glean の adopt（`maintainer`）、replace_anchor・retire_anchor・retract_evidence・retract_adoption・withdraw・resolve_conflict（`owner`）: 通らなければ errors（保存を拒む）
- 項目の定義と見直す条件（`owner`）: 通らなければ errors
- `supersedes`・`conflicts` の trusted: evidence と adoption のうち `trusted` に通った span が 1 つ以上あること
- `Planned` と保存は `OwnWords` の span と route を使い、`spanOf` での取り直しをやめる
- 発言者の比較（`author_kind === "owner"`、`MAINTAINERS`）は、権限の用途では `own-words.ts` にだけ置く。`MAINTAINERS` の定義も 1 か所にする

**衝突のリンク**

- 配信の衝突の検索（`server/src/deliver.ts:124`）で、相手が隔離されている（`extraction != 'supported'` か `unsourced != 0`）リンクを効かせない。時点指定（asOf）にも同じ規則
- `read` の「自動配信を止めている」の説明（`server/src/read.ts:349`）を同じ判定に揃え、効かないリンクは消さずに理由付きで表示する

**監査**（`sphica doctor --audit-quotes`）

- 専用の分岐にして `inspect` を通さず、reader 接続だけを使う。`--reindex` と同時には指定できない
- 列挙: project、記録の key か項目の名前、表と行（`unit_link` は from・to・kind の組）、source と span、通らない理由、今効いているか履歴だけか
- 確かめられないものは別の件数: 置き換え・衝突の権限の根拠（保存されていない）、span の無い withdraw と resolve_conflict の理由
- 種類ごとの直し方と限界を出す: 採用は `retract_adoption`、anchor は付け直し、撤回は別の span か後継、withdraw は新しい key で作り直し、衝突の解決は後継との新しい衝突、見直す条件は根拠の撤回か後継、項目の定義は直せない（別名で定義し直すか、その発言を forget する。forget は定義だけでなく発言と関連する根拠も消す）
- 正常に終わっても「誤った採用は無い」とは表示しない
- 表示は `server/src/cli/view.ts` の部品を使う

**検査**

- `bun run architecture`: 権限の表（`unit_adoption`、`unit_anchor_retirement`、撤回、`field_def`、見直す条件の根拠）へ書く箇所と、`OwnWords` を作る箇所を限定する

**文面**

- `plugin/skills/glean/SKILL.md`、`plugin/skills/harvest/SKILL.md`、`plugin/skills/trace/SKILL.md`: 権限になる引用（採用、操作の理由、項目の定義、見直す条件、置き換え・衝突の根拠）には引用・コードブロック・同じ行の引用符の中の言葉が使えないこと、通常の根拠には使えること、位置は機械が確かめるが意味はエージェントが判断すること
- `ASSURANCE.md`: 守る範囲を書き直す（引用の位置は機械で確かめる。採用の意味は確かめない。規則は近似）
- リリースノート: 「引用・コードブロック・引用符の中の言葉を、権限の根拠として受け付けていた箇所を塞いだ。採用の意味は確かめない」と範囲を書く

**テスト**（実際の SQLite。直す前のコードで失敗することを先に確かめる）

- 規則の入力: 完全な引用、引用符の中の一部分、引用符ごと、導入文＋`>`、別の行の引用符、`1. "…"`、`Use "strict" mode.`、日本語の「」（全体は通り、中だけは拒む）、apostrophe（`I'll withdraw it; that's fine.` の `withdraw it` が通る）、2 文字のバッククォートの inline code、4 文字のフェンスの中の 3 文字の行
- 箇所ごと（`server/test/own-words-sites.test.ts`）: glean の 7 つの操作、項目の定義、見直す条件、置き換え・衝突の trusted（実在しない quote、引用の中の発言）、新しい記録の採用
- `record_check` を呼ばない `record_save`、正常な操作と不正な操作が混ざるバッチが全部戻ること
- 衝突: 既存のリンク、両方向、持ち主の採用の有無、現在と asOf、`read` の説明と配信の結果の一致
- 監査: 実行の前後で DB の全行の内容が同じ（`server/test/temp-db.ts` の dump）、列挙した行と件数の一致
- 型: `OwnWords` を通さない書き込みが型検査で落ちること

**リリース**

- 1 つの PR、1 回のリリース（`plugin`）。バージョンは着手時の main の次（`bun run release:plan` で決める）。手元でレビューまで終えてから push する

## 採った案と棄却した案

- 採用: 既存の行は変えず、読み取りだけの監査で示して持ち主が直す。棄却: 引用の規則で既存の権限を自動で無効にする（規則は近似で本当の判断を誤って無効にし得る。無効化は置き換えの連鎖を動かす。引用の外の言葉を使った誤りは見つけられない。追記だけの表を直すには schema の変更が要る）
- 採用: 引用の範囲を除いて本人の言葉（letter）が残れば通す。棄却: 引用符に触れた span を全部拒む（日本語は名前や強調に「」を日常的に使い、根拠が意味の無い断片になる）。棄却: 引用符の外の部分だけを保存する（連続しない span になり、schema の変更になる）
- 採用: 確かめ済みの span の型を共通の関数だけが作り、保存がそれを受け取る。棄却: 発言者の比較の場所を静的に検査するだけ（検査そのものを省いた書き込みは比較も現れないので止まらない）
- 採用: 今の 2 つの関数を、source 全体から範囲を求める判定に作り直す。棄却: 2 つの関数をそのまままとめる（部分の引用と、導入文＋引用の行を通す）
- 採用: 隔離された記録の衝突を、読むときに効かせない。棄却: 引用の検査だけで塞ぐ（実在する別の採用が trusted を満たす場合が残る）
- 採用: 監査は doctor の明示のオプション。棄却: 通常の doctor に足す（通常の doctor は owner 接続で書き込みを伴う検査を流す）
- 採用: 通常の修正として出す（持ち主の決定）。棄却: advisory を出す（Codex の見立て: ASSURANCE.md は誘導されたエージェントと第三者の文章による採用を守る対象に挙げている）
- 採用: 項目の定義を直す操作は足さない。棄却: 今回足す（schema・Skill・表示に及ぶ別の変更で、該当があるかも分かっていない）

## 手順

- S1: `server/src/own-words.ts` に引用の規則と `ownWords`・`OwnWords` を作り、規則の入力のテストを書く
- S2: 新しい記録の採用・項目の定義・見直す条件・trusted を `ownWords` に通し、`record.ts` の `quotedSpan`・`inlineQuoted` を消す
- S3: glean の 7 つの操作を `ownWords` に通し、`Planned` と保存が `OwnWords` を使う形にして `spanOf` での取り直しをやめる
- S4: 配信の衝突の検索と `read` の説明で、隔離された記録のリンクを効かせない
- S5: `sphica doctor --audit-quotes` を足す
- S6: `bun run architecture` に、権限の表へ書く箇所と `OwnWords` を作る箇所の検査を足す
- S7: Skill（glean・harvest・trace）と ASSURANCE.md の文面を直す
- S8: npm と 3 つの plugin manifest のバージョンを上げる
- S9: `plugin-release` スキルのとおりにリリースし、手元を更新して、持ち主の DB で監査を流して結果を報告する

## 完了条件

- A1: `bun run verify` → 通る
- A2: `rg -n "quotedSpan|inlineQuoted|spanOf" server/src` → 0 件
- A3: `rg -n "MAINTAINERS = " server/src` → 1 件（`server/src/own-words.ts`）
- A4: `cd server && node --import ./test/isolate-home.ts --test test/own-words.test.ts` → 通る（規則の入力の全部を含む）
- A5: `node --import ./test/isolate-home.ts --test test/own-words-sites.test.ts` → 直す前の main の一時的な worktree の `server/` に、新しいテストのファイルだけを写して流すと、引用の中の文を指定した各箇所のテストが失敗する
- A6: `node dist/cli.js doctor --audit-quotes` → `npm pack` をリポジトリの外で展開し、一時的な HOME で `init` した後に流して、終了コード 0、DB のファイルのハッシュが前後で同じ
- A7: `node dist/cli.js doctor --audit-quotes --reindex` → 拒まれる（終了コードが 0 でない）
- A8: `bun run architecture` → 通る。`OwnWords` を通さずに `unit_adoption` へ書く変更を一時的に入れると落ちる
- A9: リリース後、`bun run release:status` → 揃っている

## リスク

- 規則が厳しくなって、今まで通っていた正当な採用が候補に残る → Skill に引用の外の言葉を引くよう書き、`record_check` の理由に「引用の外の言葉を引く」と出す
- 規則が緩くなる箇所がある（別の行の引用符で拒んでいた入力が通る）→ 意図した変更。テストで固定する
- `OwnWords` への置き換えで保存する span が変わる → 置き換えの前後で、同じ入力から同じ span が保存されることをテストで確かめる
- 監査が大きい DB で遅い → reader 接続の読み取りだけなので止めても害は無い。件数が多いときは種類ごとの件数を先に出す
- 衝突の判定の変更で、今まで止まっていた記録が配信されるようになる → 意図した変更。`read` に理由を出し、リリースノートに書く
- 着手までに main が進んでバージョンがずれる → `release:plan` で決め直す

## 未解決

なし

## 変更履歴
