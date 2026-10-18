---
kind: plan
status: approved
codex_session: 01a14d88-1b56-72c2-b1ea-752b64d815a8
codex_rounds: 4
approved_at: 2026-10-18
---

# #259 の stage 1: 自動 trace の実績を固定した母集団で測り、今のままでよいかを決める

## 要点

- 0.6.30（PR #273）から動いている自動 trace の実績を、2026-10-04〜10-18 の固定した母集団で測る。母集団は、会話の記録で record_context が auto: true で呼ばれた run（68 回、記録 149 件）
- 機械で数える: 空振り（記録 0 件）の割合と、会話の記録の usage から取ったトークン（購読の消費量ではなく、決めた代わりの指標）と時間
- 149 件から seed 固定で 40 件を抜き取って役に立つかを見る。採用（持ち主 59 行、AI 6 行）は全件、話者と引用を確かめる。Claude と Codex が先に付け、持ち主が確定する
- ラベルの前に固定した 3 つの基準（役に立つ 70%、取り違えた持ち主の採用 0 件、空振りのトークン 3 割）を別々に判定し、次の手を集合で出して #259 に書く
- 抜き取りと集計のスクリプト `server/evals/trace/auto-trace.ts` とテストを足す。配信・trace・schema・record サーバー・パッケージは変えない（リリースなし）

## 持ち主の決定

- 抜き取りは 40 件、AI の決定は全件見る（2026-10-18）
- 基準はラベルの前に固定する: 役に立つ記録が 70% 以上、持ち主の発言を取り違えた採用が 0 件、空振りの回の利用量が自動 trace 全体の 3 割を超えたら機械の絞り込みを実験する（2026-10-18）
- 自動 trace は既定でオン、止める設定あり（#273 と u339 で決定済み。この評価で前提を変えない）
- 実験は測ってから決める（epic #200 の Policy）

## 目的

- 自動 trace が残した記録のうち役に立つものの割合（抜き取り 40 件）、取り違えた採用の件数（全件）、空振りに使ったトークンの割合と時間が、保存した入力から再計算できる形で `server/evals/trace/auto-trace-baseline.json` にある
- 3 つの基準それぞれに pass / fail / undecided が出て、次の手の集合が決まっている
- #281（AI の決定の取り下げ）の判断に使う、AI の決定の件数・誤採用の件数・中身が分かる

## 対象外

- 自動 trace の挙動の変更（機械の絞り込み、既定の切り替え、抜き出し方の修正）。結果を見て別の計画にする
- #281 の判断。件数と評価を渡すだけ
- 手動の trace（持ち主が /trace で起動したもの）の評価
- 購読の消費量そのもの。公式に換算の方法が無い（https://learn.chatgpt.com/docs/pricing 、https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code 、Codex が 2026-10-18 に確認）

## 前提

- 自動かどうかは DB に残らない。`auto` は trace_pending と record_context の引数だけ（`server/src/mcp-record.ts:124`, `:225`）。extraction_run に auto の列は無い（`db/schema.sql:256`）
- 会話の記録には残る。Claude Code の transcript（`~/.claude/projects/-Users-shunichi-Projects-sphica/*.jsonl`）の tool_use の input、Codex の rollout（`~/.codex/sessions/2026/10/`）の function_call と McpToolCall（`payload.item.type=McpToolCall`, `arguments.auto=true`）に `auto` と `run` がある
- run id は extraction_run.draft_id（`server/src/extract.ts:59` で生成、`server/src/trace.ts:132` で保存）
- 窓 [2026-10-04T00:00:00.000Z, 2026-10-18T06:00:00.000Z)、origin = trace で、auto: true の run 引数 70 個のうち 68 個が DB に一致する。空振り 38、記録 149、採用は owner_statement 59 行（49 記録）と agent 6 行（6 記録）。呼んだ host は Claude Code 66 / Codex 2、対象の host は Claude Code 65 / Codex 3（Codex が sqlite3 -readonly と構造化した読み取りで集計、2026-10-18。持ち主の判断のときに見せた 50 回・109 件は、ターンの持ち主の発言で見分けた暫定の数）
- 一致しない 2 個は、誤った run 引数で No run になった実呼び出し（`8c8dba6b-…jsonl:6240`、`bd134cd6-…jsonl:155`）
- Claude Code の transcript は 1 つの応答を複数行に分けて書き、各行に同じ usage を繰り返す（`cbc0dbe8-…jsonl:159-163` は同じ message.id と requestId で output_tokens 4254。2026-10-18 に確認）。Codex の rollout の token_count は total_token_usage（累積）と last_token_usage を持ち、同じ累積値の event が重なることがある（`rollout-2026-10-14T15-06-43-01a13905-….jsonl:77,78`）
- 2 つの run を同じ応答で並行して処理する例がある（`cbc0dbe8-…jsonl:135-151`。一方は記録 0 件、もう一方は 10 件）
- 前例: #346 の `server/evals/delivery/sample.ts`（母集団の固定と sha256、mulberry32、シート、判定の式）、#219 の `server/evals/post-write/replay.ts:202`（mulberry32）と `server/evals/post-write/transcript.ts`（transcript の読み方、SQLite の backup と sha256 で入力を固定する freeze）

## 方針

### スクリプト（`server/evals/trace/auto-trace.ts`）

- DB は reader の接続で読み取り専用に開く。DB、transcript のディレクトリ、rollout のディレクトリ、固定先のディレクトリは引数で受け、既定を置かない。足りない引数は名指しして止まる
- モード: `--freeze`（入力の固定と母集団の保存）、`--usage`（トークンと時間）、`--sample`（抜き取りとシート）、`--decide`（ラベルから判定）
- `--freeze`: 一貫した SQLite の backup と、読んだ transcript・rollout の写しを、リポジトリの外の固定先へ書く。baseline にはその sha256、実装の commit、project key、条件、読めなかった行を残す。保存した入力からの再計算と、生のデータとの差分の確認は別のモードにし、差分があれば報告して 0 以外で終わる
- 呼び出しの読み取り: Claude Code の tool_use、Codex の function_call と McpToolCall を構造として読む。引用された文の中の引数は数えない。呼んだ host と対象の host は別の欄にする

### 母集団

- 記録の母集団: record_context が auto: true で呼ばれた run id を draft_id で extraction_run に結び、origin = trace、started_at が窓の中のもの。一致しない id は、受けたエラーと一緒に一覧に残す
- 費用の母集団: auto: true の trace_pending の呼び出しから始まる区間（下記）。No run のエラー、やり直し、失敗、run を始めなかった区間も含む
- 並び: run は (started_at, id)、記録は (created_at, id) の昇順に固定してからシャッフルする

### トークンと時間（`--usage`）

- 1 つの応答を数える単位にする。Claude Code は message.id（無ければ requestId）ごとに usage を 1 回だけ取る（その id の最後の行）。両方無い応答は欠測
- Codex は累積値が直前と同じ event を落とし、カウンターごとに隣り合う累積値の差が last_token_usage と一致するかを確かめる。一致しない、基準の値が無い、累積値が戻る、のどれも欠測にする。欠測を 0 にしない
- 区間: auto: true の trace_pending を出した応答から始まり、同じターンでその流れの最後の record サーバーの結果を読む応答（ふつうは trace の終わりの報告）で終わる。先にターンが終われば、そのターンの最後の応答で終わる。窓の終わりで開いたままの区間は打ち切りとし、その run の結果は不明
- 区間の中の応答は全部、分母に残す。帰属:
  - record サーバーの呼び出しを出すか、その結果を読む応答は、その呼び出しの run id を持つ。trace_pending と、run を返さなかった trace_begin は selection
  - record サーバーの呼び出しも結果も無い応答は、ちょうど 1 つの run が開いている間（trace_begin の結果の後、record_save の結果の前）ならその run に帰属し、開いている run が 0 か 2 つ以上なら帰属不明
  - owner_work は、その応答の本文か呼び出しが持ち主の依頼のためだとラベルのときに確かめ、理由を書いたときだけ yes。ツールの種類では決めない。決められなければ帰属不明
- 空振りの割合の下限: run id の集合が空でなく、空振りと確定した run だけを含み、owner_work・selection・帰属不明のどれも no の応答。上限: 空振りか結果不明の run に触れる応答と、selection か帰属不明の応答の全部
- 指標は host ごとに 2 つ。(a) output tokens、(b) 処理した全トークン（Claude Code は input + cache_creation + cache_read + output、Codex は input + output で cached input を二重に足さない）。モデル別の内訳も保存する。host をまたいで足さない
- 時間: run ごとの begin から save まで、重なりを除いた区間の実時間、selection の時間。合計・中央値・最大

### 抜き取りとラベル（`--sample`）

- 149 件（agent を含む全部）から mulberry32、seed 20261018 で先頭 40 件。役に立つ割合はこの 40 件だけで出す。40 件に入らなかった agent の記録は、別の監査の組として足す（割合には入れない）
- 採用の監査: 母集団の採用の行を全部（owner_statement と agent）、話者・引用の範囲・答えている提案の 3 つで確かめる
- シート: 記録の本文・kind・採用の引用と route、引用元の発言とその前後、run の対象セッション
- ラベルの軸は 2 つ
  - 正しさ: correct / wrong（中身が会話に無い、kind が違う、採用の取り違え）/ unknown
  - 価値（保存した時点で、この project の後のセッションに要るか）: useful / not-needed / unknown。先に保存された live な記録と同じ中身なら not-needed
- Claude と Codex が別々に付ける（Codex には read-only でシートを渡す）。持ち主は、どちらかが問題を挙げた行・2 者が食い違った行・抜き取りの 40 件の全部を確かめて確定する

### 判定（`--decide`、ラベルの前に固定）

- 結果は「決めた代わりのトークンの指標による判定」と書き、購読の消費量の 3 割とは書かない
- 役に立つ割合（抜き取りの 40 件）: 確定した useful = 正しさ correct かつ価値 useful。useful の可能性 = 正しさが wrong でなく、価値が not-needed でない。確定が 28 以上なら pass、可能性が 28 未満なら fail、それ以外は undecided
- 取り違えた持ち主の採用（全件の監査）: 確定した取り違えが 1 件以上なら fail、0 件で未確定が 0 なら pass、未確定が残れば undecided。AI の誤採用は件数 / 監査した件数で報告する（基準は無い）
- 空振りのトークン（Claude Code の run で判定。Codex の run は報告だけ）: 2 つの指標の両方で、下限と上限の両方が 0.3 を超えれば実験に進む。両方で両端とも 0.3 以下なら進まない。それ以外は undecided。ちょうど 0.3 は超えない扱い。欠測で境界をまたぎうる場合と分母 0 は undecided
- 次の手は集合で出す: 役に立つ割合が fail → 抜き出し方を直す計画、取り違えが fail → 修正の issue、空振りが実験に進む → #259 の stage 1（機械の絞り込み）の実験の計画。全部 pass で実験なし → 今のまま。undecided は持ち主が決める
- 報告: 記録 1 件以上の run の数、抜き取りで確定した useful を 1 件以上持つ run の数と未判定の run の数

### 結果（`server/evals/trace/auto-trace-baseline.json`）

- `precision-baseline.json` の形に合わせる: note, window, inputs（固定した入力の sha256、commit、project key）, population（記録と費用の 2 つ、件数・一覧の sha256、一致しない id）, usage（host・モデル・指標・下限と上限・欠測）, time, sampling（方法・seed・件数）, labels（定義）, sample（記録ごとに claude / codex / owner / settled の 2 軸と理由）, audit（採用の行ごと）, result, verdict（基準ごと）, actions

## 採った案と棄却した案

- 採用: 自動の見分けを会話の記録の auto: true で行い、draft_id で DB に結ぶ。棄却: 呼んだターンの持ち主の発言に trace が無いかで見分ける（スラッシュコマンドの展開や AskUserQuestion の回答で揺れ、20 回が決まらなかった）
- 採用: 代わりのトークンの指標 2 つを host ごとに出し、両端・両指標が揃ったときだけ判定する。棄却: input + cache_creation + output を利用量とみなす（購読の消費量との対応が公式に無い）
- 採用: 応答を単位にし、並行する run と共有した分は下限と上限で出す。棄却: trace_begin で区切って run に割り当てる（同じ応答が 2 つの run を処理する例がある）
- 採用: 区間の応答は全部分母に残し、帰属できないものは帰属不明にする。棄却: record と read 以外のツールだけの応答を持ち主の作業として外す（trace のためのコードの確認も落ちる）
- 採用: 149 件から無作為に 40 件、agent は別の監査の組。棄却: agent を除いてから 40 件（自動 trace の記録全体の割合にならない）
- 採用: 採用の行は全件を監査する。棄却: 40 件の中だけで取り違え 0 件を見る（母集団について 0 件と言えない）
- 採用: 正しさと価値の 2 軸。棄却: useful / not-needed / wrong の 1 軸（useful と wrong が重なる）

## 手順

- S1: `server/evals/trace/auto-trace.ts` の `--freeze`（入力の固定、2 つの母集団の抽出・保存・照合、呼び出しの構造的な読み取り）とテスト。knip の入口に足す
- S2: `--usage`（応答の重複の除去、Codex の累積値の照合と欠測、区間と帰属、下限と上限、時間）とテスト
- S3: `--sample`（抜き取り、agent の追加の組、採用の監査の一覧、シート）とテスト
- S4: `--decide`（2 軸の集約、3 つの基準の判定、次の手の集合）とテスト
- S5: 本番のデータで固定・集計・抜き取りを流し、Claude と Codex がラベルと監査を付け、持ち主が確定し、判定して `auto-trace-baseline.json` に書く
- S6: 結果と次の手を #259 に書く（文面を持ち主に見せてから）

## 完了条件

- A1: `bun run verify` → 通る
- A2: `cd server && node --import ./test/isolate-home.ts --test test/auto-trace.test.ts` → 全件 pass。次を含む: 同じ message.id の行が何行あっても usage を 1 回だけ数える、Codex の累積値の重なりを落とし差の不一致を欠測にする、1 つの応答が 2 つの run を処理すると下限と上限に分かれる、開いている run が 1 つの間のツールだけの応答はその run に、2 つの間は帰属不明に、No run のやり直しが費用の母集団に入る、保存した母集団と seed で 2 回抜き取ると同じ順、違う母集団では違いを報告して 0 以外で終わる、2 軸の組み合わせごとの集約、28 件と 0.3 の境目
- A3: `jq '[.labels.sample[] | select(.claude and .codex and .owner and .settled)] | length' server/evals/trace/auto-trace-baseline.json` → 40。`jq '[.labels.audit[] | select(.settled)] | length' server/evals/trace/auto-trace-baseline.json` → 採用の行の数（固定した入力から再計算した値。2026-10-18 の見込みは 65）
- A4: `cd server && node evals/trace/auto-trace.ts --decide --frozen "$FROZEN" --baseline evals/trace/auto-trace-baseline.json` → 固定した入力とラベルから出し直した result・verdict・actions が baseline と一致すると報告して 0 で終わる（`$FROZEN` は S5 の固定先）
- A5: `gh issue view 259 --comments` → 結果と次の手を書いたコメントがある

## リスク

- Codex の rollout の usage が読めない・欠測が多い → Codex の run は報告だけなので判定は Claude Code の run で行い、欠測の件数を出す
- 40 件では割合の幅が広い → undecided を持ち主に見せる
- ラベルの基準が持ち主と AI で違う → 持ち主が確定する行を広めに取る（問題あり・食い違い・抜き取りの全部）
- transcript の写しに会話の中身が入る → 固定先はリポジトリの外。baseline には sha256 と件数だけを入れ、本文は記録のキーと引用の位置で指す

## 未解決

なし

## 変更履歴
- 2026-10-18 / A3 の jq を `.sample[]`・`.audit[]` から `.labels.sample[]`・`.labels.audit[]` に直した / ラベルは抜き取りの行とは別に labels の下に置く作りにしたため / 完了条件のコマンドの誤りで範囲は変わらないので Go は不要
