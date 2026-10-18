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

- [x] T03: 40 件の抜き取り、agent の追加の組、採用の監査の一覧、シートを出す（`--sample`）
  - 種別: 追加
  - 計画: S3
  - 依存: T01（保存した記録の母集団が要る）
  - 変更: `server/evals/trace/auto-trace.ts`, `server/test/auto-trace.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 全件 pass。保存した母集団と seed で 2 回流すと同じ 40 件が同じ順に出る、抜き取りに入らなかった agent の記録だけが追加の組になる、採用の全行が監査の一覧に出る、シートに本文・採用の引用と route・引用元の前後が入る
  - コミット: `feat(eval): sample automatic trace records and list adoptions to audit (T03)`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 14 件 pass（同じ seed で同じ抜き取り・別の seed で別、抜き取りに入らなかった AI の採用の記録だけが追加の組、監査は自動の run が書いた採用の行だけで後の run の行は入らない、シートは根拠と採用をバイトの範囲で引き、採用の前後と直前の発言を出す、CLI は 1 回だけ抜き取り別の seed を拒み、数でない seed と足りない引数を名指し）。`bun run check` → 0

- [x] T08: 応答の時刻をその最後の行で取り、窓の終わりより後の応答を区間から外す
  - 種別: 修正
  - 計画: S2
  - 依存: T02（直す対象の区間と時間）
  - 変更: `server/evals/trace/auto-trace.ts`, `server/test/auto-trace.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 2 行に分かれた最後の応答で区間の終わりが最初の行の時刻になる、窓の終わりの後の応答が区間と上限に入る、の 2 件が落ちる
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 全件 pass。区間の終わりと時間は応答の最後の行の時刻、窓の終わり以降の応答は数えず区間は打ち切り
  - コミット: `fix(eval): end responses at their last line and cut spans at the window's end (T08)`
  - 結果: red: 直す前のコードで `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 区間の終わりが 00:00:19（最初の行）で 00:00:49 にならず落ちた。窓の側は同じテストの順を入れ替えた写しを流し、窓の終わりの後の m7〜m10 が残って落ちた。直した後、同じコマンド → 15 件 pass。`bun run check` → 0

- [x] T04: 2 軸のラベルを集約し、3 つの基準と次の手を出す（`--decide`）
  - 種別: 追加
  - 計画: S4
  - 依存: T03（抜き取りと監査の一覧の形が要る）
  - 変更: `server/evals/trace/auto-trace.ts`, `server/test/auto-trace.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 全件 pass。2 軸の組み合わせごとの確定と可能性、28 件の境目（確定 28 は pass、可能性 27 は fail、間は undecided）、取り違えの確定・未確定、0.3 ちょうどは超えない・指標や両端が割れると undecided・欠測で境界をまたぐと undecided・分母 0 は undecided、次の手の集合、語彙の外のラベルは名指しで拒む
  - コミット: `feat(eval): decide the three automatic trace bars from settled labels (T04)`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 20 件 pass（確定 28 は pass・27 は fail・unknown を含む 27+1 は undecided・wrong は useful に数えない、持ち主の採用の取り違え 1 件で fail・unknown で undecided・AI の採用は件数だけ、0.3 ちょうどは超えない・両指標と両端が割れると undecided・gap と分母 0 も undecided、次の手の集合、別の行や語彙の外のラベルを拒む、CLI はラベルを 1 回だけ取り込み 2 回目は固定した入力から同じ結果と報告・書き換えた結果は 0 以外で終わる）。`bun run check` → 0

- [x] T09: 窓の終わりをまたぐ最後の応答で区間を打ち切り、時間を窓の終わりまでにする
  - 種別: 修正
  - 計画: S2
  - 依存: T08（直す対象の窓の打ち切り）
  - 変更: `server/evals/trace/auto-trace.ts`, `server/test/auto-trace.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 始まりが窓の中で最後の行が窓の後の応答で、区間が打ち切りにならず終わりが窓の外になるテストが落ちる
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 全件 pass。最後の行が窓の終わり以降なら区間は打ち切りで、終わりの時刻は窓の終わり
  - コミット: `fix(eval): cut a span whose last response runs past the window's end (T09)`
  - 結果: red: 直す前のコードで `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 始まり 00:00:19・最後の行 00:00:49 の m10 に窓の終わり 00:00:30 を当てると truncated が false で落ちた。直した後、同じコマンド → 20 件 pass（打ち切りで終わりは 00:00:30）。`bun run check` → 0

- [x] T10: 役に立つ割合を 40 件の抜き取りのときだけ 28 件で判定し、判定できない run の数を結果に出す
  - 種別: 修正
  - 計画: S4
  - 依存: T04（直す対象の判定）
  - 変更: `server/evals/trace/auto-trace.ts`, `server/test/auto-trace.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 10 件の抜き取りで 7 件が useful だと pass になる、結果に判定できない run の数が無い、の 2 件が落ちる
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 全件 pass。抜き取りが 40 件でなければ役に立つ割合は undecided、結果の runs に記録を残した run のうち確定した useful が抜き取りに無い run の数がある
  - コミット: `fix(eval): judge the useful rate on 40 records only and count undetermined runs (T10)`
  - 結果: red: 直す前のコードで `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 10 件の抜き取りで 7 件 useful が pass になり落ちた。直した後、同じコマンド → 21 件 pass（40 件でなければ undecided、runs に undetermined 1）。CLI のテストの 2 件の抜き取りは pass から undecided に直した。`bun run check` → 0

- [x] T11: シートの直前の発言は末尾を省かずに出し、採用の前後は文字の境目で切る
  - 種別: 修正
  - 計画: S3
  - 依存: T03（直す対象のシート）
  - 変更: `server/evals/trace/auto-trace.ts`, `server/test/auto-trace.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 末尾に選択肢がある長い直前の発言で選択肢がシートから消える、マルチバイトの文字の途中で前後が切れて置換文字が出る、の 2 件が落ちる
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 全件 pass。長い直前の発言は省いたバイト数を書いて末尾を残し、前後の文脈に置換文字が出ない
  - コミット: `fix(eval): keep the end of the message before an adoption and cut context on characters (T11)`
  - 結果: red: 直す前のコードで `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 末尾の「1. SQLite / 2. Postgres」がシートに無く落ちた。置換文字の側は選択肢の assert を外した写しを流し、置換文字が出て落ちた。直した後、同じコマンド → 22 件 pass。`bun run check` → 0

## P2: 測定と報告

持ち主の DB と会話の記録で測り、ラベルを確定して判定し、結果を #259 に出す。

- [x] T05: 本番のデータを固定し、トークンと時間を数え、40 件と監査の一覧を出す
  - 種別: 追加
  - 計画: S5
  - 依存: T02（トークンの集計が要る）, T03（抜き取りが要る）, T09（本番のデータは区間の打ち切りを直した後で数える）, T11（ラベルに使うシートの直し）
  - 変更: `server/evals/trace/auto-trace-baseline.json`
  - 完了条件: `jq -c '{runs: .population.records.runs, records: .population.records.units, sample: (.sample | length), audit: (.audit | length)}' server/evals/trace/auto-trace-baseline.json` → 固定した入力からの値が出て、sample は 40。固定先はリポジトリの外で、transcript の写しをコミットしない
  - コミット: `test(eval): pin the 2026-10-04..18 automatic trace population and its usage (T05)`
  - 結果: `--freeze`（窓 2026-10-04T00:00Z〜10-18T06:00Z、root /Users/shunichi/Projects/sphica、固定先は scratchpad の frozen-259、417 MB）→ 68 runs, 149 records, 41 spans, 2 unmatched。`--usage` → Claude Code の空振りの割合 output 0.085〜0.192・全トークン 0.257〜0.552・gap 0、Codex output 0〜0.113・全トークン 0〜0.153。`--sample --seed 20261018 --size 40` → 40 件・追加の AI の決定 5 件・監査 65 行。`jq -c '{runs: (.population.runs | length), records: .population.units, sample: (.sample | length), audit: (.audit | length)}' server/evals/trace/auto-trace-baseline.json` → {"runs":68,"records":149,"sample":40,"audit":65}。もう一度本番のデータから抽出 → 同じと報告。窓の中の自動の呼び出し 147 件のうち --root で外れたものは 0 件。`bun run check` → 0（baseline は Biome で整形）

- [x] T06: Claude と Codex がラベルと監査を付け、持ち主が確定し、判定して #259 に書く
  - 種別: 追加
  - 計画: S5, S6
  - 依存: T04（判定が要る）, T05（抜き取った 40 件と監査の一覧が要る）, T10（直した判定が要る）
  - 変更: `server/evals/trace/auto-trace-baseline.json`
  - 完了条件: `jq '[.labels.sample[] | select(.claude and .codex and .owner and .settled)] | length' server/evals/trace/auto-trace-baseline.json` → 40。`jq -c '.verdict, .actions' server/evals/trace/auto-trace-baseline.json` → 3 つの基準の判定と次の手が出る。#259 のコメント（文面は持ち主の承認の後）の URL が note にある
  - コミット: `test(eval): record the #259 automatic trace baseline and its verdict (T06)`
  - 結果: Claude と Codex が 40 件・追加 5 件・監査 65 行を別々にラベルし、抜き取りの 33 件が一致、監査は 63 行が一致。持ち主が食い違いと問題ありの行（S4・S12・S14・S18・S24・S25・S39・X42・A14・A65）をおすすめどおり確定し、40 件を確認した。`--decide --labels` → 役に立つ 31/40 pass、持ち主の採用の取り違え 1（A65）fail、空振りのトークンは undecided（Claude Code の output 0.085〜0.192、全トークン 0.257〜0.552）。持ち主の判断: 絞り込みの実験には今は進まない、取り違えは issue にする（#355）。`--decide --frozen --baseline`（ラベルなし）→ 同じ結果と報告して 0。`jq '[.labels.sample[] | select(.claude and .codex and .owner and .settled)] | length' server/evals/trace/auto-trace-baseline.json` → 40。`jq -c '.result.adoption.bar, .result.actions' server/evals/trace/auto-trace-baseline.json` → "fail" と次の手。#259 のコメントの URL は note にある

- [x] T12: 最後の行に usage の無い応答を欠測にし、確定を持ち主のラベルに合わせ、出し直しでトークンと時間も比べる
  - 種別: 修正
  - 計画: S2, S4
  - 依存: T06（直す対象の判定と baseline）
  - 変更: `server/evals/trace/auto-trace.ts`, `server/test/auto-trace.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 最後の行に usage が無い応答が前の行の値で数えられ gap にならない、持ち主のラベルと違う settled が通る、トークンの合計を書き換えた baseline でも出し直しが同じと報告する、の 3 件が落ちる
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 全件 pass。最後の行に usage が無ければ usage は null で gap、持ち主のラベルがある行は settled がそれと同じでないと拒む、出し直しは result・usage・time のどれかが違えば 0 以外で終わる。今の baseline で `--decide --frozen --baseline` が 0 で終わる
  - コミット: `fix(eval): count a lost final usage as a gap, tie settled to owner labels, recheck usage (T12)`
  - 結果: red: 直す前のコードで `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 3 件が落ちた（最後の行に usage が無い応答が output 3 のまま、持ち主と違う settled が通る、span_seconds_merged を 0 にした baseline でも出し直しが 0 で終わる）。直した後、同じコマンド → 24 件 pass。今の baseline で `--decide --frozen --baseline` → 同じと報告して 0。`bun run check` → 0

## 記録

- 2026-10-18 / T01 / Codex のログで record のツールは McpToolCall の item だけに出て、function_call の名前に record のツールは 0 件だった（~/.codex/sessions と archived_sessions を grep）。code mode の exec の入力の文字列にも run と auto が出るが、引用と同じく数えない / plan の「function_call と McpToolCall」のうち McpToolCall だけを読む。Codex の応答の区切りは token_usage_record（response_id と応答ごとの usage を持つ）にした。T02 で usage もこれから取り、turn_token_usage の累積との一致で欠落を見る
- 2026-10-18 / T07 / T01 の Codex のレビューで P2 が 2 件（本番の DB から抽出してから別の接続で backup するので間の変更で再現できない、Codex のログはプロジェクトをまたぐので別のプロジェクトの自動 trace_pending が区間に入る。後者は再現あり）。どちらも採る / 修正タスク T07 を T03 の前に足した
- 2026-10-18 / T08 / T02 の Codex のレビューで P2 が 2 件（Claude Code の応答の時刻を最初の行で取るので区間の終わりが早く出る、実ログで 33 秒、再現あり。窓の終わりで打ち切りの印を付けるだけで窓の外の応答も数える、再現あり）。どちらも採る / 修正タスク T08 を T04 の前に足した
- 2026-10-18 / T07 / T07 の Codex のレビューで P2 が 1 件（--root の外にある worktree からの呼び出しが外れる。合成したログで再現）。断る: 同じレビューで実ログの自動の呼び出し 147 件は全部残り、外の worktree からの自動の呼び出しは 1 件も無かった。T05 で --root で外れた自動の呼び出しの数を数え、0 でなければ直す / 記録だけ残した
- 2026-10-18 / T09 / T08 の Codex のレビューで P2 が 1 件（始まりが窓の中で最後の行が窓の後の応答だと、打ち切りにならず窓の外の時間が入る。実ログに窓を当てて再現、計画の窓では観測なし）。採る: 計画の決まり（窓の終わりで打ち切り）に反する / 修正タスク T09 を足した。T03 と T08 のレビューは依頼文の SHA が空になり 2 件とも HEAD を見ていたので、T03 を SHA を付けて頼み直した
- 2026-10-18 / T05 / 依存の欄を変えた。前: T02, T03、新: T02, T03, T09 / 本番のデータは直した区間の決め方で数えるため
- 2026-10-18 / T10 / T04 の Codex のレビューで P2 が 2 件（28 件の基準を件数の 7 割で出すので 40 件でない抜き取りでも pass が出る、再現あり。計画にある判定できない run の数が結果に無い）。どちらも採る / 修正タスク T10 を足し、T06 の依存を変えた。前: T04, T05、新: T04, T05, T10
- 2026-10-18 / T11 / T03 の Codex のレビューで P2 が 1 件と P3 が 1 件（直前の発言を先頭 1500 バイトで切るので、採用の「1」が答えた末尾の選択肢が消える。前後 400 バイトで切るので UTF-8 の文字が壊れ、本番のシートで 6 か所 11 文字）。どちらも再現あり、採る。抜き取りの偏りや監査の行の過不足は無かった（本番で 40 件・追加 5 件・監査 65 行） / 修正タスク T11 を足し、T05 の依存を変えた。前: T02, T03, T09、新: T02, T03, T09, T11
- 2026-10-18 / T06 / 完了条件の欄を変えた。前: `jq '[.sample[] | …]'`、新: `jq '[.labels.sample[] | …]'`。`jq -c '.verdict, .actions'` も結果の置き場に合わせて `.result` の下で確かめた / ラベルは labels の下、判定は result の下に置く作りにしたため
- 2026-10-18 / T12 / 全差分の Codex のレビュー（high）で P2 が 3 件（応答の最後の行に usage が無いと前の行の値が残り gap にならない、settled が持ち主のラベルと食い違っても通る、出し直しが result だけを比べトークンと時間の書き換えを見逃す）。3 件とも再現あり、採る。今の baseline はどれにも当たらない（同じレビューで固定した入力と一致を確認） / 修正タスク T12 を足した
