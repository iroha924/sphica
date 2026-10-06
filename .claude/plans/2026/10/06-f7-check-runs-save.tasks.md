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

- [x] T05: acceptance に check の結果の行と、judge の後の拒否の case を足す
  - 種別: 追加
  - 計画: S5
  - 依存: T03（judge の後の拒否が要る）
  - 変更: `server/evals/acceptance/cases.json`, `server/test/acceptance-cases.test.ts`
  - 完了条件: `cd server && node --test test/acceptance-cases.test.ts` → pass。足した 2 つの case が今のコードで通り、結果の行の case は T02 の前のコード、judge の後の拒否の case は T03 の前のコードで落ちる（そのコミットの一時の worktree で確かめる）
  - コミット: `test(acceptance): pin record_check's preview lines and the post-judge refusal (T05)`
  - 結果: reconcile-09（結果の行）と reconcile-10（同じ glean の中の 2 つの採用の拒否）を足した。今のコードで `--test-name-pattern="reconcile-(09|10)" evals/acceptance/run.ts` → pass 2。一時の worktree で、reconcile-09 は T01 のコミット c247a0a7 で落ち、reconcile-10 は T02 のコミット 32150823 で「check did not say ...」で落ちた。`cd server && node --test test/acceptance-cases.test.ts` → pass 4。`bun run verify` → 終了コード 0

- [x] T08: lock の中で見つかった同じ anchor の警告を、check の返答で 1 回だけ出す
  - 種別: 修正
  - 計画: S2
  - 依存: T07（lock の中の anchor の警告を check に出すのは T07 から）
  - 変更: `server/src/extract.ts`, `server/test/extract.test.ts`
  - red: `cd server && node --test --test-name-pattern="check shows what save would quarantine" test/extract.test.ts` → 同じファイルと symbol に役割の違う anchor を 2 つ置くと、lock の中の警告が 2 行出て落ちる
  - 完了条件: `cd server && node --test test/extract.test.ts` → pass。役割の違う 2 つの anchor でも、check の返答の警告は 1 行
  - コミット: `fix(record): show each anchor warning found under the lock once in record_check (T08)`
  - 結果: red は直す前のコードで落ちた（警告が 2 行、actual 2 / expected 1）。lock の中の警告だけでなく、準備の時点でファイルが変わっていた 2 回目の check では検証の problems の側にも同じ警告が 2 つ入るので、両方を重ねないようにした。`cd server && node --test test/extract.test.ts test/record.test.ts` → pass 102 / fail 0。`bun run verify` → 終了コード 0

- [x] T09: lock を持つ子プロセスのテストを、時間の長さではなく順序で確かめ、子の失敗でも止まらないようにする
  - 種別: 修正
  - 計画: S4
  - 依存: T04（直すテストが T04 にある）
  - 変更: `server/test/reconcile.test.ts`
  - red: `node <scratchpad>/held.mjs` → 今のテストと同じ spawn と準備待ちの形で子を準備の前に `process.exit(1)` させると、準備待ちの Promise が終わらず「pending」と出る
  - 完了条件: `cd server && node --test test/reconcile.test.ts` → pass。親が lock を求めた時刻 < 子が lock を外す時刻 <= 親が lock を取れた時刻 を確かめ、子が準備の前に終わるとテストは失敗で終わる
  - コミット: `test(record): check the lock wait by order, and never hang on the lock holder (T09)`
  - 結果: red は scratchpad の再現（今の形で子が準備の前に `process.exit(1)` する）で「pending」と出た。直した後は、親が lock を求めた時刻 <= 子が外した時刻 <= 親が取れた時刻 を確かめ、子が準備の前に終わると準備待ちが失敗し、finally で子を止めて終了を待つ。`cd server && node --test test/reconcile.test.ts` → pass 7 / fail 0。`bun run verify` → 終了コード 0

- [x] T06: trace・harvest・glean の Skill と record_check のツールの説明を直す
  - 種別: 変更
  - 計画: S6
  - 依存: T02（返答の形が決まっている必要がある）
  - 変更: `plugin/skills/trace/SKILL.md`, `plugin/skills/harvest/SKILL.md`, `plugin/skills/glean/SKILL.md`, `server/src/mcp-record.ts`
  - 完了条件: `bun run verify:ai` → 終了コード 0。`rg -n "would be active|rolled back|rolls back" plugin/skills/trace/SKILL.md plugin/skills/harvest/SKILL.md plugin/skills/glean/SKILL.md server/src/mcp-record.ts` → 4 ファイルとも一致
  - コミット: `docs(skills): say record_check previews the save and what it reports (T06)`
  - 結果: `bun run verify:ai` → 終了コード 0。`rg -n "would be active|rolled back|rolls back" ...` → 4 ファイルとも一致。`bun run verify` → 終了コード 0

- [x] T10: Windows の手順が、選んだ 4 つのテストを実際に流したことを数で確かめる
  - 種別: 修正
  - 計画: S4
  - 依存: T04（直す手順が T04 にある）
  - 変更: `.github/workflows/check.yml`
  - red: `cd server && node --test --test-timeout=60000 --test-name-pattern="no-such-name-xyz" test/db.test.ts test/reconcile.test.ts` → 一致するテストが無くても終了コード 0
  - 完了条件: `actionlint .github/workflows/check.yml` → 指摘なし。手順と同じコマンドを bash の `-eo pipefail` で流して終了コード 0、パターンを一致しない名前に変えると `grep` で終了コード 1
  - コミット: `ci(windows): fail the rollback step when its pattern runs fewer tests (T10)`
  - 結果: red: 一致しない名前でも終了コード 0（TAP の集計は `# pass 2`）。直した後: `actionlint .github/workflows/check.yml` → 指摘なし。手順と同じコマンドを `bash -eo pipefail` で流し、今の名前で終了コード 0、一致しない名前で 1。`bun run verify` → 終了コード 0

- [x] T11: lock を持つ子プロセスが、親が lock を求めた後で外すようにする
  - 種別: 修正
  - 計画: S4
  - 依存: T09（直すテストが T09 の形）
  - 変更: `server/test/reconcile.test.ts`
  - red: `node <scratchpad>/old-order.mjs` → 子が起動から 1500 ms で外す形で親が 1700 ms 遅れると「order holds false」
  - 完了条件: `cd server && node --test test/reconcile.test.ts` → pass。子は親が `begin immediate` の直前に書くファイルを見てから 500 ms 後に外し、順序の確認が親の遅れによらない
  - コミット: `test(record): let the lock holder go only after the check asks for the lock (T11)`
  - 結果: red は再現スクリプトで「asked 1791259237351 released 1791259237149 ... order holds false」。直した後 `cd server && node --test test/reconcile.test.ts` → pass 7 / fail 0。`bun run verify` → 終了コード 0

- [x] T12: lock を求めた時刻を合図の前に記録し、子に待つ時間の上限を付ける
  - 種別: 修正
  - 計画: S4
  - 依存: T11（直すテストが T11 の形）
  - 変更: `server/test/reconcile.test.ts`
  - red: `node <scratchpad>/signal-order.mjs` → 合図を書いてから時刻を記録する形で、その間に親が 1200 ms 止まると「order holds false」
  - 完了条件: `cd server && node --test test/reconcile.test.ts` → pass。時刻を記録してから合図を書き、子は親が lock を求めないまま 30 秒たつと終了コード 2 で終わる
  - コミット: `test(record): time the ask before signalling the lock holder, and bound its wait (T12)`
  - 結果: red は再現スクリプトで「asked 1791259571121 released 1791259570428 ... order holds false」。直した後 `cd server && node --test test/reconcile.test.ts` → pass 7 / fail 0（上限のタイマーを `unref` しないと子が 30 秒残ることを一度踏み、直した）。`bun run verify` → 終了コード 0

- [x] T13: lock を持つ子プロセスの出力を、stdio が閉じてから読む
  - 種別: 修正
  - 計画: S4
  - 依存: T12（直すテストが T12 の形）
  - 変更: `server/test/reconcile.test.ts`
  - red: `gh run view 37412503421` → PR #291 の Windows の job で「asked 1791259933225, released NaN, began 1791259933860」で落ちた（子の `exit` を待った時点で、最後の出力がまだ読めていない）
  - 完了条件: `cd server && node --test test/reconcile.test.ts` → pass。子の終わりを `close`（stdio が閉じた後）で待つ。Windows の CI の job が通る
  - コミット: `test(record): read the lock holder's output after its stdio closes (T13)`
  - 結果: 手元で `cd server && node --test test/reconcile.test.ts` → pass 7 / fail 0、Windows の手順と同じコマンドを `bash -eo pipefail` で流して終了コード 0。`bun run verify` → 終了コード 0。Windows の CI は push の後に確かめる

## 記録
2026-10-06 / T02 / 変更欄と red を直した。変更: `server/src/extract.ts`, `server/test/extract.test.ts` → 4 ファイル（`server/test/record.test.ts` は呼び出し元のテストの置き場、`server/test/temp-db.ts` は全部の表を取り出す `dump`）。red: 3 つのテスト名 → 2 つ（glean の problems は今のコードでも check に出るので red にならない。成功のテストの中で確かめる）/ 欄を直して進めた
2026-10-06 / T01 / Codex のレビュー（c247a0a7）: 指摘 0 件。Codex の環境では db.test.ts が一時ディレクトリを作れず流れなかったので、手元で流した pass 27 で確かめた / 直すものなし
2026-10-06 / T03 / red と完了条件を直した。red: `--test-name-pattern="issue 275" test/extract.test.ts` → `--test-name-pattern="check and save agree" test/record.test.ts`（テスト名に issue 番号を入れず、場面のテストは record.test.ts の save の補助関数で作った。場面 3 は T02 で check も拒否するようになったので、red は文面の違い）。完了条件の rg: `claimed|takes|implemented` → `const (claimed|takes|implemented)\b`（前からあるコメントの「takes the write lock」に一致するため）/ 欄を直して進めた
2026-10-06 / T03 / record.test.ts を置き換えるときに、同じ文字列が前の別のテストにもあり、別のテスト 2 つを消した。HEAD の record.test.ts に戻し、1 回だけ一致することを確かめる形でやり直した / 消えたテストは無い（`git diff` の `-test(` は名前を変えた 1 件だけ）
2026-10-06 / T02 / Codex のレビュー（32150823）: P2 1 件、check の返答に save の quarantined の結果と、lock の中で見直した anchor の警告が出ない（Codex が再現）/ 採用。修正タスク T07 を T04 の前に足した
2026-10-06 / T03 / Codex のレビュー（447bd831）: 指摘 0 件（Codex の環境ではテストが一時ディレクトリを作れず、メモリ上の SQLite で 4 つの場面と 6 種類の記録を確かめた）/ 直すものなし
2026-10-06 / T04 / 変更欄に `server/test/extract.test.ts` を足した（Probe で git と最初の準備が lock の前に起きることは、既存の anchor の lock のテストを check にも広げて確かめる）。途中で check が ENOENT を返したが、テストの probe が同じファイルを `force` なしで 2 回消していたためで、製品の不具合ではない（main とこのブランチで同じ場面を check と save に流し、どちらも通ることを確かめた）/ commit 付きの anchor を消さないファイルに置いた
2026-10-06 / T05 / 変更欄から `server/evals/acceptance/driver.ts` を外した（既存の `check_notes_contain` と `save_refused_contains` で書けた）。完了条件: 「2 つとも T03 の前のコードで落ちる」→「結果の行の case は T02 の前、拒否の case は T03 の前で落ちる」（結果の行は T02 で入ったので、T02 のコードでは通るのが正しい）/ 欄を直して進めた
2026-10-06 / T04 / Codex のレビュー（a3b35a14）: P2 2 件。子プロセスが lock を持つ 400 ms と親の待ち時間の計測が同期していない（CI が遅いと正しく待っても落ちる）、子が準備の前に終わると準備待ちが終わらず、check が例外を投げると子を待たずに後片付けに進む（Codex が再現）/ 2 件とも採用。修正タスク T09 を足した
2026-10-06 / T07 / Codex のレビュー（1ce324f1）: P2 1 件、同じファイルと symbol に役割の違う anchor が 2 つあると、lock の中の警告が check に 2 行出る（Codex が再現。save も同じく 2 行出す前からの動き）/ 採用。plan の「同じ警告は 2 回出ない」に合わせ、check の返答の中で重ねない。修正タスク T08 を足した
2026-10-06 / 全体 / review-shipping（main...347a59c1）: 出してよい。指摘 1 件（低リスク）、Windows の手順は `--test-name-pattern` に一致するテストが無くても緑で通る（再現済み）/ 採用。修正タスク T10 を足した
2026-10-06 / 全体 / Codex の全差分のレビュー（high、main...347a59c1）: P2 1 件、T09 の後も子が起動から 1500 ms で lock を外すので、CI で親が遅れると順序の確認が落ちる（Codex が縮めた形で再現）。ほかの check と save の食い違い、権限の問題は見つからなかった / 採用。修正タスク T11 を足した。プロセス間の合図はファイルにした（親は lock を待つ間ブロックするので、stdin への書き込みは届く保証が無い）
2026-10-06 / T10, T11 / Codex の再レビュー（347a59c1..1ecbedbe）: T10 は直っている。T11 に P2 1 件、合図を書いてから時刻を記録しているので、その間に親が止まると順序の確認が落ちる（Codex が縮めた形で再現）。子に待つ時間の上限が無い / 採用。修正タスク T12 を足した。レビューの往復はここで閉じ、以降は GitHub の Codex と CI に任せる
2026-10-06 / T13 / PR #291 の CI で Windows の job だけが落ちた。lock を持つ子の「released」の行が読めておらず、Node の `exit` は stdio が閉じる前に来ることがあるため（macOS では起きなかった）/ 修正タスク T13 を足した
