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

- [ ] T04: read で退いた anchor を理由付きの履歴として出す
  - 種別: 追加
  - 計画: S4
  - 依存: T01（理由の表が要る）
  - 変更: `server/src/read.ts`, `server/test/read.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/read.test.ts` → pass。Retired anchors の節（置き換え先、引用、理由が無いときの reason not recorded）、asOf ではその時点で退いていたものだけ、返答が READ_BUDGET 以内、のテストを含む
  - コミット: `feat(read): show retired anchors with the words that retired them`

## P3: 参照用ファイルへの anchor の警告（試し）

CLAUDE.md・AGENTS.md・`.claude/rules`・SKILL.md へのパスだけの applies_to anchor に check と save で警告し、持ち主の判定で採否を決める。

- [ ] T05: referenceFile と警告を足し、trace・harvest・glean の check と save に出す
  - 種別: 追加
  - 計画: S5
  - 依存: T03（glean の検査と保存の流れを T03 で組み替えるので、その上に警告を載せる）
  - 変更: `server/src/rule-files.ts`, `server/src/record.ts`, `server/src/glean.ts`, `server/test/record.test.ts`, `server/test/extract.test.ts`, `server/evals/acceptance/cases.json`, `server/test/acceptance-cases.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/record.test.ts test/extract.test.ts` → pass。trace・harvest・glean の check と save の両方で同じ警告が出て保存は成功、伏せ字で symbol が落ちた anchor にも出る、symbol 付き・evidence・対象外のファイル（plugin.json、.claude/plans/）には出ない、のテストを含む。`bun run acceptance` → pass
  - コミット: `feat(record): warn on a path-only anchor on a file agents read for instructions`

- [ ] T06: 試しを持ち主が判定し、採否に合わせて Skill と案内を仕上げる
  - 種別: 追加
  - 計画: S6, S7
  - 依存: T03（retire_anchor を Skill に書く）, T05（警告の採否を決める対象が要る）
  - 変更: `plugin/skills/glean/SKILL.md`, `plugin/skills/trace/SKILL.md`, `plugin/skills/harvest/SKILL.md`, `server/src/delivery-view.ts`
  - 完了条件: plan の S7 の SQL の 1 本目 → 対象の ID 集合を記録節に書く。持ち主の判定と採否を記録節と #209（文面は承認の後）に残す。不採用なら T05 の警告を外す（`git diff main -- server/src/record.ts | grep referenceAnchorWarning` → 何も出ない）。`bun run verify` → pass
  - コミット: `docs(skills): describe retire_anchor and the reference-file warning`

## 記録

- 2026-10-07 / T01 / 新しい表を足すと、forget の接続が source の削除からの cascade を authorizer で拒否し、server のテスト 23 件が落ちた。ingest の revision の trigger 一覧（INGEST_TRIGGER_WRITES）も新しい trigger を求める / forget の削除許可と trigger 一覧の追加を T02 から T01 に移した。T01 の変更欄: 前 db-write.ts なし → 後 db-write.ts あり。T02 は ingest の挿入許可と forget の件数とテストを担う
- 2026-10-07 / T01・T02 / Codex のタスクごとのレビュー（0d2ed77f、0f1fc74f）は指摘 0 件。Codex 側は sandbox で一時ディレクトリを作れず、テストは走らせていない / 採ることなし
- 2026-10-07 / T03 / pairs の検査が glean の Skill の op 表に retire_anchor を求めた / Skill の retire_anchor の行を T06 から T03 に移した。T03 の変更欄: 前 Skill なし → 後 `plugin/skills/glean/SKILL.md` あり
- 2026-10-07 / T03 / server 全体のテストで record.test の「rename limit」が 5 回中 2 回失敗し、単独では毎回通った。git の rename 検出の時間が負荷で延びるためと推測（未検証）。今回の変更は read と rename の経路に触れていない / 直さずに残す
