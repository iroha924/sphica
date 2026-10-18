---
kind: tasks
plan: 18-auto-trace-eval-259.plan.md
branch: feat/auto-trace-eval-259
base: main
---

# #259 の stage 1: 自動 trace の実績を固定した母集団で測り、今のままでよいかを決める のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 評価のスクリプト

入力を固定し、トークンと時間を下限と上限で数え、40 件と採用の全行を抜き出し、ラベルから 3 つの基準を判定するスクリプトができる。

- [x] T01: 入力を固定し、記録と費用の 2 つの母集団を抽出・保存・照合する（`--freeze`）
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `server/evals/trace/auto-trace.ts`, `server/test/auto-trace.test.ts`, `knip.json`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 全件 pass。一時 DB と一時の transcript・rollout から、auto: true の record_context の run が draft_id で結ばれ窓と origin で絞られる、Codex の function_call と McpToolCall も読み引用の中の引数は数えない、No run の id がエラーと一緒に残る、DB の backup と写しの sha256 が保存される、行を消した DB では違いを報告して 0 以外で終わる、足りない引数は名指しで止まる
  - コミット: `feat(eval): freeze the automatic trace population for #259 (T01)`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 5 件 pass（message.id ごとの応答と結果・エラー文、Codex の McpToolCall を直前の応答に結び exec の中の文字列は読まない、窓と auto で絞った run と記録・No run の id・区間の始まり、照合の違いの 4 種、CLI で固定 → 2 回目は同じと報告 → 記録を消すと 0 以外で終わり baseline は変わらない、足りない引数の名指し）。`bun run check` → 0

- [x] T02: 応答ごとのトークンと時間を、帰属の下限と上限で数える（`--usage`）
  - 種別: 追加
  - 計画: S2
  - 依存: T01（呼び出しの読み取りと固定した入力が要る）
  - 変更: `server/evals/trace/auto-trace.ts`, `server/test/auto-trace.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 全件 pass。同じ message.id の行は 1 回だけ数え id の無い応答は欠測、Codex の重なった累積値を落とし差の不一致を欠測にする、区間の始まりと終わりの境目、2 つの run を処理する応答と開いた run が 1 つ・2 つの間のツールだけの応答・推論だけの応答の帰属、結果不明の run、欠測を 0 にしない、の各 fixture で下限と上限が期待どおり
  - コミット: `feat(eval): count tokens and time of automatic traces with attribution bounds (T02)`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 9 件 pass（同じ message.id の 2 行は最後の usage を 1 回、id の無い応答は gap、Codex は同じ response_id を落とし累積の不一致を gap、区間は trace_pending から最後の save を読む応答まで（後の持ち主の作業と次のターンは外れる）、2 つの run を処理する応答は上限だけ、開いた run が 2 つの間の推論だけの応答は帰属不明・1 つの間のツールだけの応答と推論だけの応答はその run、結果の無い run は不明で上限だけ、owner_work は下限から外れ上限に残る、時間の重なりの合算、CLI の `--usage` と足りない引数）。`bun run check` → 0

- [x] T07: 母集団を固定した DB から取り、別のプロジェクトの自動 trace を区間と No run から外す
  - 種別: 修正
  - 計画: S1
  - 依存: T01（直す対象の固定と抽出）
  - 変更: `server/evals/trace/auto-trace.ts`, `server/test/auto-trace.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 読み取りと固定の間に本番の DB から記録を消すと baseline の母集団が固定した DB と食い違う、cwd が別のプロジェクトの trace_pending と No run が母集団に入る、の 2 件が落ちる
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 全件 pass。新しく固定するときは backup と写しの後にそこから抽出し、区間と No run は呼び出しの cwd（引数か、その行・ターンの cwd）が `--root` かその下のものだけ
  - コミット: `fix(eval): pin the automatic trace population from the frozen copy and own calls (T07)`
  - 結果: red: 直す前のコードで `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 2 件が落ちた（cwd が /elsewhere の trace_pending o2 が区間に入る、読み取りと固定の間に記録を消すと baseline の run の記録が固定した DB と食い違う）。直した後、同じコマンド → 11 件 pass。`bun run check` → 0

- [ ] T03: 40 件の抜き取り、agent の追加の組、採用の監査の一覧、シートを出す（`--sample`）
  - 種別: 追加
  - 計画: S3
  - 依存: T01（保存した記録の母集団が要る）
  - 変更: `server/evals/trace/auto-trace.ts`, `server/test/auto-trace.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 全件 pass。保存した母集団と seed で 2 回流すと同じ 40 件が同じ順に出る、抜き取りに入らなかった agent の記録だけが追加の組になる、採用の全行が監査の一覧に出る、シートに本文・採用の引用と route・引用元の前後が入る
  - コミット: `feat(eval): sample automatic trace records and list adoptions to audit (T03)`

- [ ] T04: 2 軸のラベルを集約し、3 つの基準と次の手を出す（`--decide`）
  - 種別: 追加
  - 計画: S4
  - 依存: T03（抜き取りと監査の一覧の形が要る）
  - 変更: `server/evals/trace/auto-trace.ts`, `server/test/auto-trace.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 全件 pass。2 軸の組み合わせごとの確定と可能性、28 件の境目（確定 28 は pass、可能性 27 は fail、間は undecided）、取り違えの確定・未確定、0.3 ちょうどは超えない・指標や両端が割れると undecided・欠測で境界をまたぐと undecided・分母 0 は undecided、次の手の集合、語彙の外のラベルは名指しで拒む
  - コミット: `feat(eval): decide the three automatic trace bars from settled labels (T04)`

## P2: 測定と報告

持ち主の DB と会話の記録で測り、ラベルを確定して判定し、結果を #259 に出す。

- [ ] T05: 本番のデータを固定し、トークンと時間を数え、40 件と監査の一覧を出す
  - 種別: 追加
  - 計画: S5
  - 依存: T02（トークンの集計が要る）, T03（抜き取りが要る）
  - 変更: `server/evals/trace/auto-trace-baseline.json`
  - 完了条件: `jq -c '{runs: .population.records.runs, records: .population.records.units, sample: (.sample | length), audit: (.audit | length)}' server/evals/trace/auto-trace-baseline.json` → 固定した入力からの値が出て、sample は 40。固定先はリポジトリの外で、transcript の写しをコミットしない
  - コミット: `test(eval): pin the 2026-10-04..18 automatic trace population and its usage (T05)`

- [ ] T06: Claude と Codex がラベルと監査を付け、持ち主が確定し、判定して #259 に書く
  - 種別: 追加
  - 計画: S5, S6
  - 依存: T04（判定が要る）, T05（抜き取った 40 件と監査の一覧が要る）
  - 変更: `server/evals/trace/auto-trace-baseline.json`
  - 完了条件: `jq '[.sample[] | select(.claude and .codex and .owner and .settled)] | length' server/evals/trace/auto-trace-baseline.json` → 40。`jq -c '.verdict, .actions' server/evals/trace/auto-trace-baseline.json` → 3 つの基準の判定と次の手が出る。#259 のコメント（文面は持ち主の承認の後）の URL が note にある
  - コミット: `test(eval): record the #259 automatic trace baseline and its verdict (T06)`

## 記録

- 2026-10-18 / T01 / Codex のログで record のツールは McpToolCall の item だけに出て、function_call の名前に record のツールは 0 件だった（~/.codex/sessions と archived_sessions を grep）。code mode の exec の入力の文字列にも run と auto が出るが、引用と同じく数えない / plan の「function_call と McpToolCall」のうち McpToolCall だけを読む。Codex の応答の区切りは token_usage_record（response_id と応答ごとの usage を持つ）にした。T02 で usage もこれから取り、turn_token_usage の累積との一致で欠落を見る
- 2026-10-18 / T07 / T01 の Codex のレビューで P2 が 2 件（本番の DB から抽出してから別の接続で backup するので間の変更で再現できない、Codex のログはプロジェクトをまたぐので別のプロジェクトの自動 trace_pending が区間に入る。後者は再現あり）。どちらも採る / 修正タスク T07 を T03 の前に足した
