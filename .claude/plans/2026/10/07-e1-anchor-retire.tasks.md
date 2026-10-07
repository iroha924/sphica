---
kind: tasks
plan: 07-e1-anchor-retire.plan.md
branch: feat/e1-anchor-retire
base: main
---

# glean で anchor を退かせて持ち主の引用を理由として残し、指示や参照のために読まれるファイルへのパスだけの anchor に check と save で警告する（#209 の E1） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 退いた理由を残す schema と権限

revision 12 の表 `unit_anchor_retirement` ができ、ingest が書け、forget で理由だけが消える。

- [x] T01: schema revision 12 で unit_anchor_retirement を足し、バージョンを 0.6.41 に上げる
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `db/schema.sql`, `db/migrations/0012.sql`, `server/src/sqlite.ts`, `server/src/db-types.ts`, `server/src/db-write.ts`, `server/test/fixtures/schema-rev11.sql`, `server/test/schema.test.ts`, `server/test/migrate.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/schema.test.ts test/migrate.test.ts` → pass。挿入の拒否（退いていない anchor、別 project の source と run、範囲外と文字境界でない span、owner 以外の source）、更新の拒否、revision の増加、session_cited による削除の拒否、11→12 の移行が新規作成と一致のテストを含む。`bun run codegen:check` → pass
  - コミット: `feat(schema): keep why an anchor was retired, in revision 12`
  - 結果: `node --test test/schema.test.ts test/migrate.test.ts` → 102 pass / 0 fail（新しい表の拒否・revision・forget 相当の source 削除で理由だけ消える・session_cited、11→12 の移行）。`npm test`（server 全体）→ 958 pass / 0 fail。`bun run codegen:check` → 一致。`bun run check` → exit 0

- [x] T02: ingest に新しい表への挿入を許し、forget で理由の行だけが消えて件数に出るようにする
  - 種別: 追加
  - 計画: S2
  - 依存: T01（新しい表が要る）
  - 変更: `server/src/db-write.ts`, `server/src/forget.ts`, `server/test/db.test.ts`, `server/test/forget.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/db.test.ts test/forget.test.ts` → pass。ingest は挿入だけでき更新と削除は拒否、forget の preview と apply に retired-anchor reasons の件数、replace A→B→C の A→B の理由の source を forget しても A・B の retired_at と replaced_by、C の live が残るテストを含む
  - コミット: `feat(forget): drop a retired anchor's reason with its source and count it`
  - 結果: `node --test test/db.test.ts test/forget.test.ts` → 45 pass / 0 fail（ingest は挿入だけ、更新と削除は not authorized。replace A→B→C の A→B の理由を forget すると理由 1 件だけ消え、A・B の退去と置き換え、C の live、記録の active が残り、preview と結果に 1 件と出る）。`npm test`（server 全体）→ 960 pass。`bun run check` → exit 0

## P2: glean で anchor を退かせ、read で履歴を見せる

持ち主の引用で anchor を退かせられ、read が退いた anchor を理由付きで出す。

- [x] T03: glean に retire_anchor と from.role を足し、検査を実行順で行い、retire と replace の理由を保存する
  - 種別: 追加
  - 計画: S3
  - 依存: T02（ingest が理由を書ける権限が要る）
  - 変更: `server/src/glean.ts`, `server/test/extract.test.ts`, `server/evals/acceptance/cases.json`, `server/test/acceptance-cases.test.ts`, `plugin/skills/glean/SKILL.md`
  - red: 受け入れのケースを先に足して `bun run acceptance` → retire_anchor のケースが未知の op の拒否で失敗
  - 完了条件: `cd server && node --test --test-timeout=60000 test/extract.test.ts` → pass。retire の成功、owner 以外の引用の拒否、引用の不一致、再退去の拒否、role での特定と曖昧な組の拒否、同じ anchor への二重の操作の拒否、入力が replace A→B・retire B の順でも通る、理由の挿入の失敗で退去も rollback、唯一の evidence anchor を退かせたら candidate、replace_anchor も理由を残す、のテストを含む。`bun run acceptance` → pass
  - コミット: `feat(glean): retire an anchor on the owner's words, and keep the reason`
  - 結果: red: glean-19 を足して実装前に流すと、save が「ops.0.op: Invalid discriminator value」で拒否され失敗。実装後 `node --test test/extract.test.ts` → 38 pass / 0 fail（新しいテストで、owner 以外・引用の不一致・no live anchor・2 本ある組の内訳付き拒否・同じ anchor への二重操作の拒否、replace→retire の入力順でも通る、理由の保存、唯一の evidence を退かせて candidate、保存時の理由の拒否で退去も rollback）。`bun run acceptance` → 132 pass。`npm test`（server 全体）→ 961 pass（下の記録の 1 件を除く）。`bun run check` → exit 0

- [x] T04: read で退いた anchor を理由付きの履歴として出す
  - 種別: 追加
  - 計画: S4
  - 依存: T01（理由の表が要る）
  - 変更: `server/src/read.ts`, `server/test/read.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/read.test.ts` → pass。Retired anchors の節（置き換え先、引用、理由が無いときの reason not recorded）、asOf ではその時点で退いていたものだけ、返答が READ_BUDGET 以内、のテストを含む
  - コミット: `feat(read): show retired anchors with the words that retired them`
  - 結果: `node --test test/read.test.ts --test-name-pattern="retired anchors"` → pass（理由付き・移動先付き・reason not recorded の行、asOf では退去前の状態、退いた anchor 300 本と長い理由でも readRefs の返答が READ_BUDGET 以内で続きの案内付き）。`npm test`（server 全体）→ 962 pass / 0 fail。`bun run acceptance` → 132 pass。`bun run check` → exit 0

- [x] T07: glean の Skill の retire_anchor の説明を、path に live な applies_to が残る限り配信は止まらない、に直す
  - 種別: 修正
  - 計画: S3
  - 依存: T03（直す記述が T03 で入った）
  - 変更: `plugin/skills/glean/SKILL.md`
  - red: `grep -c "no longer shown when that file is read or edited" plugin/skills/glean/SKILL.md` → 1（誤った説明がある）
  - 完了条件: 同じ grep → 0。`bun run check` → exit 0
  - コミット: `fix(skills): say a retired anchor stops delivery only when no live anchor stays on the path`
  - 結果: red: 直す前の grep → 1。直した後 → 0。`bun run check` → exit 0

## P3: 参照用ファイルへの anchor の警告（試し）

CLAUDE.md・AGENTS.md・`.claude/rules`・SKILL.md へのパスだけの applies_to anchor に check と save で警告し、持ち主の判定で採否を決める。

- [x] T05: referenceFile と警告を足し、trace・harvest・glean の check と save に出す
  - 種別: 追加
  - 計画: S5
  - 依存: T03（glean の検査と保存の流れを T03 で組み替えるので、その上に警告を載せる）
  - 変更: `server/src/rule-files.ts`, `server/src/record.ts`, `server/src/glean.ts`, `server/test/record.test.ts`, `server/test/extract.test.ts`, `server/evals/acceptance/cases.json`, `server/test/acceptance-cases.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/record.test.ts test/extract.test.ts` → pass。trace・harvest・glean の check と save の両方で同じ警告が出て保存は成功、伏せ字で symbol が落ちた anchor にも出る、symbol 付き・evidence・対象外のファイル（plugin.json、.claude/plans/）には出ない、のテストを含む。`bun run acceptance` → pass
  - コミット: `feat(record): warn on a path-only anchor on a file agents read for instructions`
  - 結果: `node --test test/record.test.ts`（新しいテスト）→ CLAUDE.md・sub/AGENTS.md・.claude/rules・.agents/skills と plugin/skills の SKILL.md で check と save に 1 件ずつ出て active で保存、伏せ字で symbol が落ちた CLAUDE.md にも出る、symbol 付き・evidence・plugin.json・.claude/plans・README.md・skills 配下の SKILL.md 以外には出ない。`node --test test/extract.test.ts`（新しいテスト）→ glean の anchor と replace_anchor で check と save の両方に出る、symbol 付き・evidence には出ない。acceptance glean-20（check に警告、保存は active のまま）pass。`npm test`（server 全体）→ 964 pass / 0 fail。`bun run acceptance` → 133 pass。`bun run check` → exit 0。harvest は trace と同じ checkRecord と saveRecord を通るので、harvest 専用のテストは足していない

- [x] T08: trace と harvest の保存の返答で、check と save の両方が出す同じ警告を 1 行にする
  - 種別: 修正
  - 計画: S5
  - 依存: T05（2 行になる警告が T05 で入った）
  - 変更: `server/src/extract.ts`, `server/test/extract.test.ts`
  - red: `cd server && node --test --test-timeout=60000 --test-name-pattern="said once" test/extract.test.ts` → 失敗（CLAUDE.md の警告が 2 回）
  - 完了条件: 同じコマンド → pass。`npm test` と `bun run acceptance` → pass
  - コミット: `fix(extract): say a warning check and save both give once in the save's reply`
  - 結果: red: 直す前に同じテスト → fail（警告が 2 行）。直した後 → pass。`npm test`（server 全体）→ 965 pass / 0 fail。`bun run acceptance` → 133 pass。`bun run check` → exit 0

- [x] T09: 保存の返答で 1 つにまとめるのを警告の行だけにし、同じ文面の変更の行は操作ごとに残す
  - 種別: 修正
  - 計画: S5
  - 依存: T08（まとめすぎが T08 で入った）
  - 変更: `server/src/extract.ts`, `server/test/extract.test.ts`
  - red: `cd server && node --test --test-timeout=60000 --test-name-pattern="both reported" test/extract.test.ts` → 失敗（glean の 2 つの anchor 操作の「anchor added」が 1 行）
  - 完了条件: 同じコマンドと「said once」のテスト → pass。`npm test` と `bun run acceptance` → pass
  - コミット: `fix(extract): merge only repeated warnings in the save's reply, never two changes`
  - 結果: red: 直す前に同じテスト → fail。直した後、「both reported」と「said once」→ 2 pass。`npm test`（server 全体）→ 966 pass（1 回目は rename limit だけ落ち、流し直して 966 pass）。`bun run acceptance` → 133 pass。`bun run check` → exit 0

- [x] T06: 試しを持ち主が判定し、採否に合わせて Skill と案内を仕上げる
  - 種別: 追加
  - 計画: S6, S7
  - 依存: T03（retire_anchor を Skill に書く）, T05（警告の採否を決める対象が要る）
  - 変更: `server/src/delivery-view.ts`, `server/src/overview.ts`, `server/src/record.ts`, `server/src/glean.ts`, `server/src/rule-files.ts`, `server/test/delivery-view.test.ts`, `server/test/extract.test.ts`, `server/test/record.test.ts`, `server/evals/acceptance/cases.json`, `server/test/acceptance-cases.test.ts`
  - 完了条件: plan の S7 の SQL の 1 本目 → 対象の ID 集合を記録節に書く。持ち主の判定と採否を記録節と #209（文面は承認の後）に残す。不採用なら T05 の警告を外す（`git diff main -- server/src/record.ts | grep referenceAnchorWarning` → 何も出ない）。`bun run verify` → pass
  - コミット: `refactor(record): take out the reference-file warning the owner's judgment did not adopt`
  - 結果: S7 の SQL の 1 本目 → 14 件（u1, u2, u32, u53, u54, u57, u59, u71, u76, u85, u132, u148, u165, u218）で、事前に数えた集合と同じ。持ち主の判定は「外す・付け直す」5 件（u1, u2, u76, u71, u54 の AGENTS.md）で過半数に届かず、不採用（2026-10-07、持ち主が Claude の案に同意）。#209 に結果をコメント（承認の後、issuecomment-6032717654）。T05 の警告をコードとテストと glean-20 から外した: `grep -rn "referenceFile\|referenceAnchorWarning\|glean-20" server/src server/test server/evals` → 0 件。T08 のテストを既存の「パスが作業ツリーに無い」警告で書き直し、まとめる処理を一時的に外すと 2 行出て落ちることを確かめた。delivery ビューと look ビューの締めの文を「trace か glean」に。`npm test`（server 全体）→ 964 pass / 0 fail。`bun run acceptance` → 132 pass。`bun run check` → exit 0

## 記録

- 2026-10-07 / T01 / 新しい表を足すと、forget の接続が source の削除からの cascade を authorizer で拒否し、server のテスト 23 件が落ちた。ingest の revision の trigger 一覧（INGEST_TRIGGER_WRITES）も新しい trigger を求める / forget の削除許可と trigger 一覧の追加を T02 から T01 に移した。T01 の変更欄: 前 db-write.ts なし → 後 db-write.ts あり。T02 は ingest の挿入許可と forget の件数とテストを担う
- 2026-10-07 / T01・T02 / Codex のタスクごとのレビュー（0d2ed77f、0f1fc74f）は指摘 0 件。Codex 側は sandbox で一時ディレクトリを作れず、テストは走らせていない / 採ることなし
- 2026-10-07 / T03 / pairs の検査が glean の Skill の op 表に retire_anchor を求めた / Skill の retire_anchor の行を T06 から T03 に移した。T03 の変更欄: 前 Skill なし → 後 `plugin/skills/glean/SKILL.md` あり
- 2026-10-07 / T03 / server 全体のテストで record.test の「rename limit」が 5 回中 2 回失敗し、単独では毎回通った。git の rename 検出の時間が負荷で延びるためと推測（未検証）。今回の変更は read と rename の経路に触れていない / 直さずに残す
- 2026-10-07 / T03 / Codex のレビュー（0d0d517a）の P2: Skill が「1 本退かせればそのファイルでの配信が止まる」と書いていたが、配信は path で選ぶので、同じ path に live な applies_to が残れば続く（deliver.ts:261 で確認）/ 採用。修正タスク T07 を足して直した。ほかの観点（実行順・from の特定・理由の保存・touched）は指摘なし
- 2026-10-07 / T05 / trace の保存の返答に同じ警告が 2 行出ることを、自分で一時スクリプトを流して見つけた。Codex のレビュー（9260e2dd）も同じ 1 件を指摘 / 採用。修正タスク T08 を足し、saveText の返答の同じ行を 1 つにまとめて直した。T04 のレビュー（9717fa60）は指摘 0 件
- 2026-10-07 / T08 / Codex のレビュー（19378da3）の P2: 返答全体を Set でまとめたため、glean の別々の操作の同じ文面の ✓ 行が 1 行に減る（glean.ts は操作ごとに同じ文面を changed に足す）/ 採用。修正タスク T09 で、まとめる対象を警告の行だけにした
- 2026-10-07 / T09 / Codex のレビュー（5252a8da）の P2: 先頭 80 文字が同じ 2 つの symbol がどちらも見つからないと警告が同じ文面になり、1 行にまとまる / 見送り。まとまる 2 行は文字まで同じで、失うのは回数だけ。80 文字を超える symbol が 2 つ同時に見つからない端の入力
- 2026-10-07 / T06 / 警告は不採用になり、trace と harvest の Skill に書く警告の読み方は不要になった。look ビュー（overview.ts）にも同じ締めの文があり、対になる箇所として一緒に直した / T06 の変更欄: 前 glean・trace・harvest の SKILL.md と delivery-view.ts → 後 警告を外したファイル一式と delivery-view.ts・overview.ts と delivery-view.test.ts。コミットの件名も変えた
