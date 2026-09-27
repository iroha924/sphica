---
kind: plan
status: approved
codex_session: 01a0e2e3-74f8-7ff0-ac14-875ed10e8ddf
codex_rounds: 4
approved_at: 2026-09-27
---

# The evaluation grades answers and Codex's own answers through checked schemas, and tracks the "received the record and still implemented the request" failure per model

## 要点

- 盲検採点を `grade.ts` にし、`codex exec --output-schema` の JSON を手書きの厳密な検査で確かめ、崩れたものは点数に数えず「採点なし」に分ける
- Codex の評価の回答も schema（実装したか・挙げた過去の判断・未確認）で受け、実行の成否・回答の形式・採点を別々の列にする
- 1 回ごとに「届いた」「見つけた」「回答で触れた」「記録に反する実装をした」を分けて残し、追う失敗（届いたか見つけたのに、反する実装をした）をモデル×条件ごとに数える
- 分からないものは no にせず unknown で数える（ログ欠け、差分の切り詰め）。起動したが結果の無い回も除外として分母に残す
- sphica-search-wording で 1 周（各モデル×各条件 2 回）回して、Claude と Codex を並べて報告する
- 配布物（MCP、CLI、フック）は変えない

## 持ち主の決定

- 評価を `codex exec --output-schema` で構造化する。盲検採点は点数・理由・印の JSON にし、形式が崩れた採点は数えない。Codex の評価の回答も schema（実装したか、挙げた過去の判断、未確認）で受ける（2026-09-27、ブログ記事を読んで決めた）
- Codex が記録を受け取り、自分でも見つけたうえで依頼どおりに実装した件を次の評価で追う。「Claude だけ良くて Codex ではだめ」を残さない（2026-09-27）

## 目的

1 周の評価の結果として、モデル×条件ごとに、採点（0〜2）、採点なし・除外の件数、4 つの信号（届いた・見つけた・触れた・反する実装）と、追う失敗の件数が表で出る。Claude と Codex の差がその表から読める。

## 対象外

- Codex が記録に従わない原因の修正（この周の結果を見て、別の計画にする）
- 新しい評価タスクの追加（`against` を足す以外）
- 配布物の変更

## 前提

- 採点は今スクリプトが無く、その場で Codex に渡していた（.claude/skills/eval-loop/SKILL.md の手順 5）
- `codex.ts` は `codex exec --json ... -o last.md` で走らせ、`patch.diff` を書いてから `result.json` を書く。途中で失敗すると result.json が無く、collect.ts はその回を飛ばす（server/evals/cloud/codex.ts、collect.ts。Codex 指摘 C6）
- gold 条件の記録はフックの追加文脈で渡り、delivery の行にならない（build.ts の GOLD_SH、codex.ts のフック。C4）
- Claude の実行ログは routine の API から手で保存する。無ければ collect.ts は空文字として扱う（eval-loop の手順 4、collect.ts）
- `--output-schema` は strict で送られ、全 object に additionalProperties false、全プロパティ required が要る。通常の完了で適合は保証されるが、拒否と中断は例外（~/.claude/skills/codex/references/cli.md、https://developers.openai.com/api/docs/guides/structured-outputs）
- `-s read-only` は読み取りを隔離しない（cli.md）
- 前回（0.5.0 前）の結果: Claude inject 2/2・gold 2/2 が 2 点、Codex は none・search・inject が 0、gold が 1

## 方針

- server/evals/cloud/tasks.json: should_help のタスクに `against` を足す。差分で見える具体の変更だけを書く。sphica-search-wording は「search に語と識別子の分割列、trigram の分割、フレーズや前方一致の構文、正規表現、複数フレーズの一致のどれかを足す」。測定の有無は含めない
- server/evals/cloud/grade.schema.json: `{score: 0|1|2, reason: string, cited_gold: "yes"|"no", implements_rejected: "yes"|"no"|"not_applicable"|"unknown", flags: [enum stopped_at_plan, read_scaffolding, off_task]}`（strict）
- server/evals/cloud/answer.schema.json: `{implemented: boolean, summary: string, past_decisions: [{ref: string, how_used: "followed"|"overrode"|"mentioned"}], unverified: [string]}`（strict）
- server/evals/cloud/schema-check.ts: 上の 2 つの固定の形だけを手書きで検査する関数（型、値、enum、余分なキー、欠けたキー）。不一致は理由を返す
- codex.ts:
  - 起動の前に `started.json`（task、condition、時刻）を書き、`result.json` は finally で必ず書く（status と reason）
  - `--output-schema answer.schema.json` を渡し、最終出力をそのまま `answer.json` に残す
  - gold のフックを、Claude の HOOK_SH と同じ受領（フックが返した内容）を run のディレクトリに書く包みで起動する
- collect.ts:
  - 行に `patch`（Claude は結果ブランチと slot の main の差分、Codex は patch.diff。.tools と .eval は除く。上限付きで、切り詰めたら印）
  - `delivered`: inject は emitted の単位に gold のキー、gold は gold フックの受領に gold の記録の本文、none と search は not_applicable
  - `found`: 実行ログ（Claude）か events（Codex）で Sphica の search か read が gold のキーを返したか読んだか。ログが無いか読めなければ unknown
  - `answer_format`: Codex は answer.json を schema-check で valid / invalid（理由）/ refused_or_empty。Claude は not_applicable。valid は文章にして採点へ、invalid は生のまま印を付けて採点へ
  - 分母: Codex は started.json の数。result.json が無い・失敗・配信の記録が無い inject は `excluded` の行（理由付き）。Claude は `--fired <slot>=<n>` で、結果ブランチの無い回を `excluded: no result branch` の行にする
- grade.ts:
  - loop.json の excluded 以外の行ごとに、タスクの prompt、`expect`、`against`、最終回答、patch（切り詰めならその旨）だけを渡す。条件とモデルは渡さない
  - `codex exec -s read-only --ephemeral --ignore-rules --skip-git-repo-check -C <空の一時ディレクトリ> --output-schema grade.schema.json -o <file>` で走らせ、依頼文でファイルを読まないよう書く
  - 結果を schema-check で検査し、終了コード 0 以外・空・JSON でない・schema 不一致は `ungraded`（理由付き）
  - grades.json を書き、モデル×条件ごとに、採点の分布、ungraded と excluded の件数、4 つの信号（yes / no / unknown / not_applicable）、追う失敗（delivered か found が yes で、implements_rejected が yes）の件数を表で出す
- .claude/skills/eval-loop/SKILL.md: 手順 4〜5 を grade.ts と `--fired` を使う形に直し、報告で Claude と Codex を n 付きで並べ、unknown と excluded を別に書くと書く
- テスト（server/test/eval-grade.test.ts、本物の Codex は呼ばない）: schema-check の型違い・範囲外・enum 違反・余分なキー・欠けたキー、grade.ts の実行結果の受け取り（空、0 以外の終了、JSON でない → ungraded）、盲検の依頼文に条件とモデルが入らないこと、found と implements_rejected の unknown の扱い

## 採った案と棄却した案

- 採用: 採点に差分と `against` を渡す。棄却: 最終回答と差分の要約だけ（実装の中身を確かめられない。C1、C5）
- 採用: 固定の 2 つの形を手書きで全部検査する。棄却: 必須キーの有無だけ（型や範囲の崩れた採点が数えられる。C2）
- 採用: 4 つの信号を分けて残し、組み合わせで追う失敗を数える。棄却: followed_prior_decision の率だけ（受け取った・見つけた・反する実装をしたの証拠にならない。C4）
- 採用: 分からないものは unknown、起動したが結果の無い回は excluded として分母に残す。棄却: 集まった行だけを分母にする（失敗した回が消える。C6）

## 手順

- S1: tasks.json の `against`、2 つの schema、schema-check.ts とそのテスト
- S2: codex.ts の台帳、answer.schema、gold フックの受領
- S3: collect.ts の patch、4 つの信号のうち delivered と found、answer_format、excluded
- S4: grade.ts の採点と表
- S5: eval-loop Skill の手順と報告

## 完了条件

- A1: `bun run verify` → exit 0
- A2: `cd server && node --test test/eval-grade.test.ts` → 全件 pass（schema-check の 5 種の崩れ、ungraded の 3 種、盲検の依頼文、unknown の扱いを含む）
- A3: `node evals/cloud/grade.ts` → sphica-search-wording の 1 周（各モデル×none・search・inject・gold を 2 回ずつ）で、モデル×条件ごとの表が出て、各セルの graded + ungraded + excluded が起動した回数に一致する
- A4: `node evals/cloud/grade.ts` → 表の追う失敗の件数を Claude と Codex で並べて持ち主に報告する（件数と unknown・excluded を添える）

## リスク

- Claude の 1 周はクラウドのクレジットを使う（8 回で約 $1.2〜$2.4）→ この計画の Go に含める。やり直しは持ち主に聞く
- 通信が遅く Codex の手元の実行が止まる → result.json の reason に残り excluded として数える。多ければ時間を置いてやり直す
- 採点役が一時ディレクトリの外を読む → read-only は読み取りを隔離しないので防げない。報告に書く
- Codex が回答の schema に縛られて振る舞いが変わる → 前回の自由形式の結果と並べて報告し、差を見る

## 未解決

なし

## 変更履歴
