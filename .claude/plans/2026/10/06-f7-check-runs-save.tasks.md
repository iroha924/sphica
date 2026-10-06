---
kind: tasks
plan: 06-f7-check-runs-save.plan.md
branch: fix/f7-check-runs-save
base: main
---

# record_check と glean の check が、save と同じ処理を流してロールバックし、save と同じ結果を返す（#275）のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: ロールバックの土台

save と同じ処理を流して必ず戻すトランザクションの助けを作り、バージョンを 0.6.37 に上げる。

- [x] T01: `inRolledBack` を足し、npm と plugin の manifest 3 つを 0.6.37 に上げる
  - 種別: 追加
  - 計画: S1, S7
  - 依存: なし
  - 変更: `server/src/db.ts`, `server/test/db.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `cd server && node --test test/db.test.ts` → pass。fn の書き込みが rollback で消える、fn が throw しても接続が返る、成功の側の rollback の失敗が throw になる、同じ接続で重ねた呼び出しが入れ子のエラーにならずに順に流れる、止めている間に別の接続はコミット済みの状態だけを読む。`bun run release:plan -- --base v0.6.36` → `plugin`
  - コミット: `feat(db): add a transaction that always rolls back, for previews (T01)`
  - 結果: `cd server && node --test test/db.test.ts` → pass 27 / fail 0（足した 3 つ: 書き込みが戻る・throw の後に接続が使える、fn の中で commit すると「no transaction is active」で throw、重ねた preview・save・preview が順に流れ reader はコミット済みだけを読む）。biome と tsc は指摘なし。release:plan はコミットの後に流す

## P2: check が save を流す

check が save と同じ準備・検証・書き込み・judge を流して戻し、save と同じ結果の行を返す。#275 の 4 件のずれをなくす。

- [x] T02: save の処理を共通の実行に切り出し、check をそれで流してロールバックする
  - 種別: 修正
  - 計画: S2
  - 依存: T01（`inRolledBack` が要る）
  - 変更: `server/src/extract.ts`, `server/test/extract.test.ts`, `server/test/record.test.ts`, `server/test/temp-db.ts`
  - red: `cd server && node --test --test-name-pattern="check reports what save would|check or save from another session" test/extract.test.ts test/record.test.ts` → 別のセッションからの check が通ってしまう、check の返答に `would be active` の行が無い、で落ちる
  - 完了条件: `cd server && node --test test/extract.test.ts` → pass。別のセッションからの check が save と同じく拒否される。check の返答に save と同じ結果の行が `would ...` で出て、glean の problems も出る。check の前後で全部の表の中身・`sqlite_sequence`・検索の結果が同じ（trace の work と source_processing、glean のファイルの抜粋の source を含む）。check、check、save の順で、表示しただけの source が source_processing に入る
  - コミット: `fix(record): run the save in a rolled-back transaction for record_check (T02)`
  - 結果: red は直す前の `server/src/extract.ts`（HEAD）に一時的に戻して流し、2 つとも落ちた（`would be active` の行が無い、別のセッションからの check で「Missing expected rejection」）。直した後は 2 つとも pass。`cd server && node --test test/extract.test.ts test/record.test.ts test/auto-pending.test.ts test/forget.test.ts` → pass 119 / fail 0（テストを足す前）。`bun run verify` → 終了コード 0

- [x] T03: 場所を待つ後継の拒否を judge の後の 1 か所に移し、check の予測のコードを消す
  - 種別: 修正
  - 計画: S3
  - 依存: T02（check が save を流していないと、場面 3 で check が拒否しない）
  - 変更: `server/src/record.ts`, `server/src/glean.ts`, `server/test/extract.test.ts`, `server/test/record.test.ts`
  - red: `cd server && node --test --test-name-pattern="check and save agree" test/record.test.ts` → 場面 1 と 2 と 4 で check が予測で拒否する、場面 3 で拒否の文面が「another record in this save already supersedes」でない、で落ちる
  - 完了条件: `cd server && node --test test/extract.test.ts test/record.test.ts` → pass。4 件の場面が plan の期待どおりで、どれも check の前後で DB が同じ。`rg -n "const (claimed|takes|implemented)\b" server/src/record.ts` → 一致なし
  - コミット: `fix(record): refuse a successor left waiting for a held place after judging, for every origin (T03)`
  - 結果: red は直す前のコードで 5 件とも落ちた（場面 1 の 2 通りと 4 は check が予測で拒否、2 は「glean:sqlite: another record in this save already supersedes」、3 は文面が「(in effect)」）。直した後 `cd server && node --test --test-name-pattern="check and save agree" test/record.test.ts` → pass 5。`cd server && node --test test/record.test.ts test/extract.test.ts` → pass 101 / fail 0。`rg -n "const (claimed|takes|implemented)\b" server/src/record.ts` → 一致なし。`bun run verify` → 終了コード 0

## P3: 計測と契約と文書

check が lock を持つ時間を測って予算に収め、acceptance の case と Skill の説明を新しい返答に合わせる。

- [x] T07: check の返答に、save の quarantined の結果と、lock の中で見直した anchor の警告を出す
  - 種別: 修正
  - 計画: S2
  - 依存: T02（check が save を流している必要がある）
  - 変更: `server/src/extract.ts`, `server/test/extract.test.ts`
  - red: `cd server && node --test --test-name-pattern="check shows what save would quarantine" test/extract.test.ts` → check の返答に `would be quarantined` の行と、lock の中で symbol が消えた anchor の警告が無い、で落ちる
  - 完了条件: `cd server && node --test test/extract.test.ts` → pass。根拠の無い記録で check が `△ would be quarantined:` を出し、lock の中で anchor のファイルが変わると check も save と同じ警告を出す。同じ警告は 2 回出ない
  - コミット: `fix(record): show quarantined records and anchors judged under the lock in record_check (T07)`
  - 結果: red は直す前のコードで落ちた（check の返答が「will be quarantined」だけで、`would be quarantined` の行と lock の中の anchor の警告が無い）。直した後 `cd server && node --test test/extract.test.ts test/record.test.ts` → pass 102 / fail 0。`bun run verify` → 終了コード 0

- [x] T04: check の lock の中の時間を測るテストと、Windows の job の手順を足す
  - 種別: 追加
  - 計画: S4
  - 依存: T02（check が lock を取るのは T02 から）
  - 変更: `server/test/reconcile.test.ts`, `server/test/extract.test.ts`, `.github/workflows/check.yml`
  - 完了条件: `cd server && node --test test/reconcile.test.ts` → pass。3,200 件の場面で `begin immediate` の成功から rollback までが 200 ms 以内、lock を待った時間を別に出す。Probe で git と最初の準備が `begin immediate` の前に起きる。lock を持つ子プロセスがいる間、check は save と同じように待つ。`actionlint .github/workflows/check.yml` → 指摘なし
  - コミット: `test(record): bound how long record_check holds the write lock, and run it on Windows (T04)`
  - 結果: `cd server && node --test test/reconcile.test.ts` → pass 7 / fail 0。3,200 件の場面で record_check が lock を持ったのは 10.8 ms（待ち 0.0 ms）、save は 10.7 ms。lock を 400 ms 持つ子プロセスがいる間、check は 200 ms を超えて待ってから通った。anchor の lock のテストで、check でも git（holds）は lock の前だけに呼ばれた。`actionlint .github/workflows/check.yml` → 指摘なし。Windows の手順と同じコマンド（`--test-name-pattern="rolled-back|record_check waits"`）を手元で流して pass 4。`bun run verify` → 終了コード 0

- [ ] T05: acceptance に check の結果の行と、judge の後の拒否の case を足す
  - 種別: 追加
  - 計画: S5
  - 依存: T03（judge の後の拒否が要る）
  - 変更: `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`, `server/test/acceptance-cases.test.ts`
  - 完了条件: `cd server && node --test test/acceptance-cases.test.ts` → pass。足した 2 つの case が T03 の前のコードでは落ち、今のコードでは通る（`git stash` ではなく T02 のコミットに戻した一時の worktree で確かめる）
  - コミット: `test(acceptance): pin record_check's preview lines and the post-judge refusal (T05)`

- [ ] T06: trace・harvest・glean の Skill と record_check のツールの説明を直す
  - 種別: 変更
  - 計画: S6
  - 依存: T02（返答の形が決まっている必要がある）
  - 変更: `plugin/skills/trace/SKILL.md`, `plugin/skills/harvest/SKILL.md`, `plugin/skills/glean/SKILL.md`, `server/src/mcp-record.ts`
  - 完了条件: `bun run verify:ai` → 終了コード 0。`rg -n "would be active|rolled back|rolls back" plugin/skills/trace/SKILL.md plugin/skills/harvest/SKILL.md plugin/skills/glean/SKILL.md server/src/mcp-record.ts` → 4 ファイルとも一致
  - コミット: `docs(skills): say record_check previews the save and what it reports (T06)`

## 記録
2026-10-06 / T02 / 変更欄と red を直した。変更: `server/src/extract.ts`, `server/test/extract.test.ts` → 4 ファイル（`server/test/record.test.ts` は呼び出し元のテストの置き場、`server/test/temp-db.ts` は全部の表を取り出す `dump`）。red: 3 つのテスト名 → 2 つ（glean の problems は今のコードでも check に出るので red にならない。成功のテストの中で確かめる）/ 欄を直して進めた
2026-10-06 / T01 / Codex のレビュー（c247a0a7）: 指摘 0 件。Codex の環境では db.test.ts が一時ディレクトリを作れず流れなかったので、手元で流した pass 27 で確かめた / 直すものなし
2026-10-06 / T03 / red と完了条件を直した。red: `--test-name-pattern="issue 275" test/extract.test.ts` → `--test-name-pattern="check and save agree" test/record.test.ts`（テスト名に issue 番号を入れず、場面のテストは record.test.ts の save の補助関数で作った。場面 3 は T02 で check も拒否するようになったので、red は文面の違い）。完了条件の rg: `claimed|takes|implemented` → `const (claimed|takes|implemented)\b`（前からあるコメントの「takes the write lock」に一致するため）/ 欄を直して進めた
2026-10-06 / T03 / record.test.ts を置き換えるときに、同じ文字列が前の別のテストにもあり、別のテスト 2 つを消した。HEAD の record.test.ts に戻し、1 回だけ一致することを確かめる形でやり直した / 消えたテストは無い（`git diff` の `-test(` は名前を変えた 1 件だけ）
2026-10-06 / T02 / Codex のレビュー（32150823）: P2 1 件、check の返答に save の quarantined の結果と、lock の中で見直した anchor の警告が出ない（Codex が再現）/ 採用。修正タスク T07 を T04 の前に足した
2026-10-06 / T03 / Codex のレビュー（447bd831）: 指摘 0 件（Codex の環境ではテストが一時ディレクトリを作れず、メモリ上の SQLite で 4 つの場面と 6 種類の記録を確かめた）/ 直すものなし
2026-10-06 / T04 / 変更欄に `server/test/extract.test.ts` を足した（Probe で git と最初の準備が lock の前に起きることは、既存の anchor の lock のテストを check にも広げて確かめる）。途中で check が ENOENT を返したが、テストの probe が同じファイルを `force` なしで 2 回消していたためで、製品の不具合ではない（main とこのブランチで同じ場面を check と save に流し、どちらも通ることを確かめた）/ commit 付きの anchor を消さないファイルに置いた
