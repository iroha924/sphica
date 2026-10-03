---
kind: tasks
plan: 03-issue-209-record-checks.plan.md
branch: fix/issue-209-record-checks
base: main
---

# Record checks warn about wrong anchors, read shows moved files and aliases, unsourced records say they cannot become active, and glean replaces aliases のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: anchor の警告

保存の前に、無いパス・ディレクトリ・見つからない symbol が近いパス付きで警告され、check と save の間の変化も save で警告される。

- [x] T01: パスの種類を RepoFacts に足し、trace・harvest・glean の anchor に problem を出す
  - 種別: 修正
  - 計画: S1, S6
  - 依存: なし
  - 変更: `server/src/repo-facts.ts`, `server/src/anchors.ts`, `server/src/record.ts`, `server/src/glean.ts`, `server/test/record.test.ts`, `server/test/extract.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - red: `cd server && node --test --test-name-pattern="anchor problem" test/record.test.ts test/extract.test.ts` → 無いパス・ディレクトリ・symbol 違い（`toStore`）の anchor で problem が出ず落ちる
  - 完了条件: `cd server && node --test --test-name-pattern="anchor problem" test/record.test.ts test/extract.test.ts` → 全件 pass（セッションで消したファイルの evidence、commit 付き、root なし、unknown は problem なし）
  - コミット: `fix(record): warn about anchors on a missing path, a directory, or a symbol not in the file (T01)`
  - 結果: red は直す前のコードで `anchor problem` が `actual: 0, expected: 1`（無いパスで problem が 0 件）、glean 側は `'✓ 0 records and 3 changes can be saved'` で落ちた。直した後は 2 件とも pass、`node --test test/record.test.ts test/extract.test.ts test/acceptance-cases.test.ts` → 57 pass、`bun run verify` → exit 0（acceptance 99 pass）。ロック中のテストの probe に `kind` を足し、ロックの中では呼ばれないことを確かめた。`bun run release:plan -- --base v0.6.24` → `release kind: plugin`、npm と 3 つの manifest を 0.6.25 にした

- [x] T02: 無いパスの problem に `git ls-files` の近いパスを最大 3 件添える
  - 種別: 追加
  - 計画: S1
  - 依存: T01（gone の判定と problem の文が要る）
  - 変更: `server/src/repo-facts.ts`, `server/src/git.ts`, `server/src/record.ts`, `server/src/glean.ts`, `server/test/record.test.ts`, `server/test/extract.test.ts`
  - 完了条件: `cd server && node --test --test-name-pattern="near paths" test/record.test.ts` → `src/date.ts` に `src/dates.ts` が添えられ、同じ basename が先に並ぶ。ls-files の失敗では候補なしで problem が出る
  - コミット: `feat(record): suggest near paths for an anchor path that is not in the working tree (T02)`
  - 結果: `node --test --test-name-pattern="near paths|anchor problem" test/record.test.ts` → 2 pass（`src/date.ts` に `"lib/date.ts", "src/data.ts", "src/dates.ts"`。距離が同じものは名前順。未追跡の `src/new.ts` も出る。遠いパスと git の無い作業ツリーでは候補なし）。`bun run verify` → exit 0（acceptance 99 pass）

- [x] T03: ロックの中の refresh で中身が変わったら、種類と symbol を判定し直して save に problem を出す
  - 種別: 修正
  - 計画: S1
  - 依存: T01（判定する関数が要る）
  - 変更: `server/src/record.ts`, `server/src/glean.ts`, `server/src/extract.ts`, `server/test/extract.test.ts`
  - red: `cd server && node --test --test-name-pattern="anchor changed after check" test/extract.test.ts` → check の後に消したファイルで save の出力に problem が無く落ちる
  - 完了条件: `cd server && node --test --test-name-pattern="anchor changed after check|lock" test/extract.test.ts` → 全件 pass（ロックの中で git と ls-files を呼ばない）
  - コミット: `fix(record): judge anchors again when a file changed between check and save (T03)`
  - 結果: red は直す前のコードで save の出力が `'✓ trace:ext-s1/look active\n✓ saved'`（problem なし）。直した後 `node --test test/record.test.ts test/extract.test.ts` → 55 pass。ロックの中で消えたファイルに `(near paths not checked)` 付きの problem、glean で symbol が消えたら problem。ロックの中で `holds`・`files`（git）は呼ばれない。既存のロックのテストは、変わったファイルで `kind`（stat）を呼ぶ形に期待を直した。`bun run verify` → exit 0（acceptance 99 pass）

- [ ] T04: anchor の problem の受け入れケースと、trace・glean Skill の文
  - 種別: 追加
  - 計画: S1
  - 依存: T02（ケースが近いパスを確かめる）, T03（ケースが save の出力を確かめる）
  - 変更: `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`, `server/test/acceptance-cases.test.ts`, `plugin/skills/trace/SKILL.md`, `plugin/skills/glean/SKILL.md`
  - 完了条件: `cd server && node --test test/acceptance-cases.test.ts` → pass。新しいケースが無いパスの problem と近いパスを、消したファイルの evidence で problem なしを確かめる
  - コミット: `test(acceptance): cover anchor problems and tell trace and glean how to answer them (T04)`

## P2: read の表示

read で、移動したファイルの移動先の候補と、記録の aliases（as-of では当時の組）が見える。

- [ ] T05: missing の anchor に commit があれば、`git diff -M` で移動先の候補を出す
  - 種別: 追加
  - 計画: S2
  - 依存: なし
  - 変更: `server/src/read.ts`, `server/src/git.ts`, `server/test/record.test.ts`
  - 完了条件: `cd server && node --test --test-name-pattern="rename" test/record.test.ts` → git mv した anchor に `may have moved to`、見つからなければ候補なし、commit が無いかタイムアウトでは `rename not checked`。同じ commit の anchor 2 つで git は 1 回
  - コミット: `feat(read): show where a missing anchor's file may have moved since its commit (T05)`

- [ ] T06: read と as-of の read で aliases を出す
  - 種別: 追加
  - 計画: S3
  - 依存: なし
  - 変更: `server/src/read.ts`, `server/test/record.test.ts`
  - 完了条件: `cd server && node --test --test-name-pattern="aliases in read" test/record.test.ts` → 今の組が `aliases (search only):` で出る。as-of では当時の組、空の組は行なし
  - コミット: `feat(read): show a record's search aliases, as of the time read (T06)`

## P3: unsourced の案内

unsourced の記録に証拠や採用を足すと active にならないと言われ、Skill に後継で置き換える手順がある。

- [ ] T07: unsourced への add_evidence と adopt に problem を出し、glean Skill に後継の手順を書く
  - 種別: 修正
  - 計画: S4
  - 依存: なし
  - 変更: `server/src/glean.ts`, `server/test/extract.test.ts`, `server/evals/acceptance/cases.json`, `server/test/acceptance-cases.test.ts`, `plugin/skills/glean/SKILL.md`
  - red: `cd server && node --test --test-name-pattern="unsourced cannot become active" test/extract.test.ts` → add_evidence で problem が出ず落ちる
  - 完了条件: `cd server && node --test --test-name-pattern="unsourced" test/extract.test.ts test/acceptance-cases.test.ts` → 全件 pass（candidate には後継の案内、withdrawn には無い。unsourced の decision と finding を後継で置き換えられる）
  - コミット: `fix(glean): say an unsourced record cannot become active when evidence or adoption is added (T07)`

## P4: replace_aliases

glean で保存済みの記録の aliases を置き換え、消せる。

- [ ] T08: glean に replace_aliases op を足す
  - 種別: 追加
  - 計画: S5
  - 依存: T06（as-of の read で前の組を確かめる）
  - 変更: `server/src/glean.ts`, `server/src/record.ts`, `server/test/extract.test.ts`, `server/evals/acceptance/cases.json`, `server/test/acceptance-cases.test.ts`, `plugin/skills/glean/SKILL.md`
  - 完了条件: `cd server && node --test --test-name-pattern="replace_aliases" test/extract.test.ts test/acceptance-cases.test.ts` → 新しい alias で見つかり、外した alias で見つからない。as-of で前の組、`[]` で消える、古い revision・空白だけ・41 文字・13 件は error
  - コミット: `feat(glean): replace a saved record's search aliases (T08)`

## P5: リリース

npm と 3 つの manifest を 0.6.25 にそろえる。

- [-] T09: release:plan を流し、version を 0.6.25 にする
  - 種別: 変更
  - 計画: S6
  - 依存: なし
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run release:plan -- --base v0.6.24` → `plugin`。`bun run verify` → exit 0
  - コミット: `chore(release): bump to 0.6.25 (T09)`

## 記録

- 2026-10-03 / T01, T09 / pre-commit の bundle 検査が、パッケージに入る変更と version の更新を同じコミットに求めた / T01 の計画欄を S1 から S1, S6 に、変更欄に 4 つの version ファイルを足し（前: ソースとテストだけ）、release:plan と 0.6.25 への更新を T01 で行った。T09 は取りやめ
- 2026-10-03 / T02 / ロック中のテストの probe にも `files` が要った / 変更欄に `server/test/extract.test.ts` を足した（前: なし）。候補には未追跡で ignore されていないファイルも入れる（`--others --exclude-standard`）
