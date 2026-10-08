---
kind: plan
status: approved
codex_session: 01a11964-1a29-7052-828d-ccc985eca047
codex_rounds: 3
approved_at: 2026-10-08
---

# review が diff で決着しない決定を違反ではなく質問で返し、rules が Biome で検査できる決定に検査の下書きを付ける（E3: #220 と #257）

## 要点

- review の評価の土台を新しく作る（`server/evals/review/`）。fixture の repo と DB、(diff, 記録) ごとの正解、precedent の lane を Claude と Codex で流す専用の runner、機械の採点器。2 つの実験で共有する
- #220: precedent の reviewer が、選ばれた記録ごとに「この diff がこの決定に反する・従うことを、diff と今のツリーで観測できる条件で示せるか」を判定する。示せない記録は violation にせず、`undetermined` にして持ち主への質問として返す。review の Skill は質問を findings とは別の節で返す。`review_check` の契約と返答は変えない（だから #303 は入れない）
- #257: `/sphica:rules` が、持ち主の選んだ記録のうち直接の依存の禁止を定義したものに、Biome の `noRestrictedImports` の設定の下書きを付ける。それ以外の検査器と推移的な依存の禁止は下書きせず、理由を返す。ファイルは編集しない
- #257 の後半（overview の look が持ち主の挙げた検査ファイルを読み、marker の記録が置き換わったら知らせる）は、下書きの正しさの測定（M1）が基準に届いたときだけ作る
- 採否は issue ごとに、PR ブランチで測って決める。届かない実験は最終の差分から外し、結果を issue に残す
- 変えないもの: DB の schema、`review_select` の選び方、`review_check` の契約と返答、配信、validator を回す条件

## 持ち主の決定

- epic #200 の次の作業を Phase 04 の E3（#220 と #257）にする（2026-10-08、「OK」）
- #220 で `review_check` の出力が変わるなら、#303 を同じ計画に入れるかを決める（持ち主の依頼の範囲）
- epic #200 の方針: 実験は仮説・測り方・基準・届かなかったときの扱いを持ち、merge の前に PR ブランチで測る。基準に届かない実験は最終の差分から外して結果を issue に残す。測るために npm へ出さない
- 評価はローカルの claude と codex で回し、費用の上限は当面設けない（記録 trace:913af8a9-e6e3-4165-a76b-38f6a3422f57/eval-local-no-cap）
- 利用者に API キーや追加の課金を求める機能は作らない

## 目的

- review の結果で、diff だけでは決着しない決定が「Questions」の節に質問として並び、違反として返らない。本物の違反は今までどおり findings に出る
- `/sphica:rules` の出力に、直接の依存を禁じる記録について、貼り付ければそのまま動く Biome の設定の下書きが、記録の key の marker 付きで出る。下書きできない記録には理由が出る
- #220 と #257 の採否が、測定した数字とともに各 issue に残る

## 対象外

- #303（`review_check` の返答の大きさ）。今回は `review_check` のコード・説明・返答を変えないので、issue の見直しの条件に当たらない
- validator の追加の確認（issue にある「violation を別の角度から確かめる」）。validator を回す条件は今のまま
- `review_check` に outcome `question` を足すこと（公開の契約が変わる。質問は reviewer と launcher の出力で足りる）
- ESLint、dependency-cruiser、import-linter、リポジトリ自前のスクリプトに合わせた検査の下書き。推移的な依存（到達）の禁止の検査
- 言語一般の `rg` による import 検査への fallback
- 発言や diff の文字列による検査の自動の無効化
- #213（計画と編集の後の検出）と #216（他のエージェントの memory の点検）

## 前提

- `review_check` は outcome 4 つの値（violation / complies / unrelated / undetermined）を受け付け、violation と complies だけに変更箇所の根拠を求める（`server/src/review-findings.ts:14`、`:78`）。undetermined は今も、AI の決定から理由付きで離れる差分の注記に使う（`plugin/skills/review/reviewers/precedent.md:80`）
- review の Skill は findings の一覧と本文の件数を照合し（`plugin/skills/review/SKILL.md:289`）、completion 行に findings の数だけを持つ（`:304`）。DONE は fix criteria を満たす findings が残らない状態（`:425`）。validator には再現の無い finding だけを回す（`:337`）
- 受け入れケースは review の判定の良し悪しを測らない（`server/evals/acceptance/cases.json` の note）。review の判定を測る評価は今は無い
- 既存の評価の runner は変更作業用で、Claude は acceptEdits、Codex は workspace-write と実装用の回答 schema で起動する（`server/evals/cloud/claude-run.ts:105`、`server/evals/cloud/codex.ts:129`、`:134`）。review の precedent は Read / Grep / Glob と読み取り MCP で動く（`plugin/skills/review/SKILL.md:177`）
- Claude の runner の囲いは `blockReadsOutsideWorkingDirectories`、`sandbox.filesystem.denyRead`、`--setting-sources project`。MCP の子プロセスへ DB を `EVAL_SPHICA_DB` で渡す（`server/evals/cloud/claude-run.ts:66`、`:98`）。Codex の run には読み取りの囲いが無く、外を見た run は除外する規則（`.claude/skills/eval-loop/SKILL.md:125`）
- `--strict-mcp-config` は MCP の設定だけを限定し、設定元や hook は別の指定（https://code.claude.com/docs/en/cli-reference 、Codex が 2026-10-08 に確認）
- `scripts/check-architecture.mjs` の import の正規表現は、コメントや文字列の中の import も拾う（Codex が 2026-10-08 に最小のコマンドで実測）。任意の自前スクリプトの読み方は信頼できない
- tsundoku の fixture（`server/evals/acceptance/world.json` の `files`）に `package.json` は無い。Biome は server の lockfile で 2.5.14 に固定されている（Codex が起動と help を確認）。fixture の `biome.json` に向けて流す経路は未検証（S1 で確かめる）
- Biome の `noRestrictedImports` は import のパスを制限する（https://biomejs.dev/linter/rules/no-restricted-imports/javascript/ ）。推移的な依存は見ない
- overview の look は HTML コメントの marker だけを読み、MCP の入力に検査ファイルの指定は無い（`server/src/overview.ts:127`、`server/src/mcp.ts:340`）。instruction ファイルの読み取りには上限とパスの検査がある（`server/src/rule-files.ts:9`、`:66`）
- 独立な試行で失敗 0 回のときの片側 95% 上限は、n=20 で約 13.9%、n=59 で約 4.95%（Codex の計算）。同じ fixture の反復は未知のケースへの性能を保証しない

## 方針

### 評価の土台（`server/evals/review/`）

- fixture: tsundoku の world（`server/evals/acceptance/world.json`）の repo と、受け入れの流れで作る DB を元にし、足りない記録と diff を足す。記録の種類: コードで決まる dont（依存・API の禁止）、コードで決まる do、配置・CI の設定で決着する決定、手順・人・時期の決定（diff では決まらない）、コードの対象でも diff だけでは決着しない決定、AI の決定。diff の種類: 本物の違反、無害な言及（文書・コメント）、間接 import、宣言された例外、superseded の決定、持ち主の明示の上書き。diff は 8 件を目安にする
- 正解: (diff, 記録) ごとに「選ばれるか」「outcome」「質問が要るか」を分けて持つ。正解のファイルは checkout の外に置く。曖昧な正解は測る前に確定する
- runner（review 用、変更作業用の runner とは別）:
  - Claude: `claude -p --no-session-persistence --strict-mcp-config --setting-sources project`、組み込みツールは `--tools` で Read / Grep / Glob、MCP は読み取りサーバーだけ。囲いは `claude-run.ts` の settings（`blockReadsOutsideWorkingDirectories`、`sandbox.filesystem.denyRead`）を流用し、hook は入れない。MCP の子プロセスの env に `EVAL_SPHICA_DB` を明示する
  - Codex: `codex exec --ephemeral -s read-only`、隔離した CODEX_HOME、その MCP 設定で DB を明示する。読み取りは止められないので、eval-loop の除外の規則（他の run・build・評価の cache を名指す、checkout から 2 段以上上がる）に、正解のファイルのパスを名指すことを足して採点で除外する
  - どちらも cwd は fixture の repo、precedent の本文の全文を prompt の先頭に置き、diff はファイルで渡す。本文の hash、モデル、CLI のバージョン、終了状態、MCP の呼び出しログを残す
- 採点器（機械、モデルの採点者は使わない）: 各束で最後に成功した `review_check` の findings と全束の受領行、最終の報告の違反と質問を、正解と突き合わせる。未完了・未判定・ログの欠落は失敗として数え、0 件扱いにしない
- 流す前の検証: Claude では checkout の外に置いた無害なファイルを読めないこと。両ホストで変えた本文（hash）と fixture の DB が使われたこと（MCP の呼び出しログ）。親の hook・MCP が入らないこと。runner と採点器は、既知の成功と失敗のログで期待どおりに数えることを決定的なテストで確かめる

### 測定の回数

- 予備測定: 今の本文で k=5、同じ本文どうし（A/A）のばらつきも見る。本文を変える前に本測定の回数を固定する。出発点は 8 diff × 2 モデル × 2 本文 × k=10 = 320 run
- run の中の判定は相関するので、ばらつきは run 単位で扱う。モデル別・diff 別の件数を出す
- #257 の M1・M2 の回数は、それぞれの測定の前に別に固定する

### #220（review）

- `precedent.md` の Step 4: まず関連を確かめ、無関係なら unrelated。関連する記録について「この diff がこの決定に反する・従うことを、diff と今のツリーで観測できる条件で示せるか」を判定する。示せれば今どおり violation / complies。示せなければ undetermined にし、質問として返す。種類の名前（配置・運用など）では決めない
- 質問は記録の key、決着しない理由（何が観測できないか）、確かめたい事実を持つ。同じ記録で確認事項が違えば全部残す。その場で答えを補って判定しない。AI の決定から理由付きで離れる注記は今どおり注記で、質問にしない
- precedent の出力: First response に `questions: <count>` と質問の一覧。completion 行に `questions=<count>`
- `review/SKILL.md`: launcher が completion の `questions` と一覧の件数を照合する（合わなければ今の findings と同じく coverage UNKNOWN）。両モデルの質問を記録の key で畳み、Step 7 に「Questions」の節を足す。質問は fix criteria と validator の対象外で、continuation を変えない。DONE は質問への回答を意味しないと書く
- 採否の基準（モデル別）: 誤った violation（正解が violation でない記録への violation）が今の本文より 30% 以上減り、絶対件数も併記する。本物の violation の見逃しが、どのモデル・どの diff でも増えない。今の本文での誤った violation が両モデルとも 0 なら、仮説を測れないので不採用として記録する

### #257（rules）

- `rules/SKILL.md`: 持ち主の選んだ記録ごとに、検査を下書きするか、しない理由を出す。下書きするのは、記録が対象の範囲と禁止する直接の依存を明示しているときだけ
  - 型 1（直接の import の禁止）: `noRestrictedImports` の設定
  - 型 2（名前のある module から module への直接の依存の禁止）: `overrides` の `includes` で対象を絞った同じルール
  - 記録が推移的な依存（到達）を禁じていれば、Biome では検査できないので下書きしない
  - 別名・再 export・動的 import を Biome がどう扱うかを下書きに書く
  - 下書きは scope、例外、落ちるべき fixture 1 つ、通るべき fixture 1 つ、記録の key の marker を持つ
- 検査器の見つけ方: リポジトリの Biome の設定（`biome.json`、`biome.jsonc`）を探す。ESLint・dependency-cruiser・import-linter・自前スクリプトは、見つけても「今回の対応外」と言って下書きしない。Biome が無ければ下書きしない
- 上書きのケースは、持ち主が例外または検査の更新を承認して反映する段階として扱う。発言や diff の文字列で検査を無効にしない
- M1（下書きの正しさ）: 持ち主が選ぶ記録の集合に、下書きすべきか・すべきでないかの正解を持たせる。下書きした検査を、生成側とは別のケース（本物の違反、文書・コメントでの言及、間接 import、宣言された例外）で固定の Biome で流す。基準: 下書きすべきでない記録で下書きしない、誤った失敗 0、本物の違反の見逃し 0
- M2（変更タスクでの比較）は M1 が基準に届いたときだけ。既存の評価ループ（`server/evals/cloud/`）に、記録された依存の禁止に反しやすいタスクを足し、「ルール文だけ」と「ルール文＋検査」で比べる。タスクごとに、禁止された変更を避けながら達成すべき結果を隠しテストで先に定義する。「commit に届いた違反」は、最終の patch に禁止された import が残っているかを同じ Biome の設定で機械的に判定する
- M2 の基準（モデル別）: (1) 違反がルール文だけより減る、(2) 隠しテストの完了数が減らない、(3) 無害・上書きのケースで誤った失敗 0、(4) 導入は持ち主の貼り付け 1 手順、記録の変化（上書き・superseded・withdrawn）1 件ごとの修理は Lifecycle の知らせから 1 手順以内、(5) 記録の変化が無いのに同じ検査を 2 回以上直すことが 0。ケースの並び（導入 → 上書き → superseded → withdrawn）と回数は M2 の前に固定する
- Lifecycle（M1 が届いたときだけ）: overview の look に、持ち主が挙げる有限の相対パスの一覧（`checks: string[]`、件数と大きさに上限）を足す。読むのは一覧のファイルだけで、`rule-files.ts` と同じ上限とパスの検査を使い、読めなかった・無かった・範囲外の件数を出す。marker はファイルの言語で有効なコメント（`//`、`/* */`、`#`、`<!-- -->`）の中の `sphica: <record key>`。コメントを持てない形式は対応外。記録が superseded（後継付き）・withdrawn・別プロジェクトなら出す。ページ送りは今の look と同じカーソルを一覧に結び付け、返答は READ_BUDGET に収める。Markdown の今の走査は変えない
- M2 が不採用なら、下書きと Lifecycle の両方を最終の差分から外す

### 出荷

- 採用した変更だけを残し、`bun run verify`、Windows を含む CI、両ホストで変えた本文が使われる確認（plugin-agent-authoring の Verification）、`release:plan` → 版の同期 → `plugin-release` の手順

## 採った案と棄却した案

- 採用: 1 つの計画・1 つの PR、採否は issue ごと。棄却: #220 と #257 を別の PR に分ける（評価の土台と「diff で決着するか」の境界を共有する）
- 採用: `review_check` の 4 つの値のまま undetermined を質問に使う。棄却: outcome `question` を足す（公開の契約が変わり、#303 の見直しの条件にも当たる）
- 採用: 観測できる条件で決着を判定する。棄却: 配置・運用・手順などの種類名で判定する（CI や配置で決着する決定も、コードでも決着しない決定もある）
- 採用: Biome の `noRestrictedImports` だけ。棄却: 汎用の `rg` の fallback と自前スクリプトへの対応（コメント・文字列・別名・再 export を扱えず、fixture 1 組では正しさを示せない）
- 採用: review 専用の runner と既存の囲いの流用、Codex は除外の規則。棄却: 変更作業用の runner の MCP 設定だけを流用する（権限・ツール・回答の形が実際の review と違う）
- 採用: 予備測定の後に回数を固定し、k=10 から始める。棄却: 最初から k=20 に固定する（十分性を確かめた数字ではない）
- 採用: Lifecycle は M1 が届いたときだけ作る。棄却: 最初から作る（届かない実験のために公開の入力を足して外すことになる）
- 採用: モデル別の基準。棄却: 両モデルの合計で 30% 減（片方の悪化をもう片方が隠す）

## 手順

- S1: 評価の土台（fixture の repo と DB、正解、review 用 runner、採点器）、流す前の検証、Biome を fixture の `biome.json` に向けて流す経路の確認（型 1・型 2 が本物の import で落ち、コメント・文字列で落ちない）。届かなければ #257 を計画から外して持ち主に戻す
- S2: 予備測定（k=5、今の本文、A/A）、本測定の回数の固定、今の本文での本測定（baseline）
- S3: #220 の採否の記録（予備測定の結果で不採用。本文の変更と本測定は 2026-10-08 に取りやめ、変更履歴を参照）
- S4: #257 の `rules/SKILL.md` の変更と M1 の測定、採否の記録
- S5: M1 が届いたとき: Lifecycle（overview look の `checks`、marker の読み取り、決定的なテスト）、M2 のタスクと測定、採否の記録
- S6: 不採用の差分を外す、verify、Windows CI、両ホストでの本文の確認、`release:plan`、版の同期、release

## 完了条件

- A1: `gh issue view 220 --comments` → 測定の結果（モデル別の誤った violation と見逃しの件数、k、本文の hash）と採否のコメントがある
- A2: `gh issue view 257 --comments` → M1（と、行ったなら M2）の結果と採否のコメントがある
- A3: `bun run verify` → 0 で終わる
- A4: `gh pr checks <PR>` → Windows を含む全ジョブが pass
- A5: `/sphica:review`（#220 を採用したなら、更新後の Claude と Codex で 1 回ずつ）→ precedent の lane の prompt の先頭が変えた本文と一致する（hash）。不採用なら `git diff main -- plugin/skills/review` → 空
- A6: `/sphica:rules`（#257 を採用したなら、更新後の Claude と Codex で 1 回ずつ）→ Biome の下書きと marker が出る。不採用なら `git diff main -- plugin/skills/rules server/src/overview.ts server/src/rule-files.ts` → 空
- A7: `bun run release:plan -- --base <前の release のコミット>` → 採用があれば `plugin` で、npm と 3 つの plugin manifest の版が同じ。採用が無ければ `none`
- A8: release したなら `bun run release:status` → release ledger is consistent

## リスク

- precedent の lane は 1 run 2〜4 分で、320 run は数時間かかる → 並列で流し、予備測定で 1 run の時間を測ってから回数を固定する
- Codex の run が checkout の外を読む → 除外の規則で落とし、除外した数をモデル別に出す。除外が多ければ持ち主に戻す
- 今の本文での誤った violation が少なく、差が測れない → 不採用として記録する（基準に書いたとおり）。任意に測定を足さない
- fixture で Biome が期待どおりに落ちない・通らない → #257 を計画から外して持ち主に戻す
- 本文の変更で、本物の違反まで質問に流れる → 見逃しの基準で不採用にする

## 未解決

なし

## 変更履歴
- 2026-10-08 / #220 は予備測定（今の本文、diff 8 × 両モデル × 5 回 × 2 組 = 160 run）で打ち切り、本測定（S2 の残り）と本文の変更（S3）を行わず不採用として #220 に記録する。#257（S4 以降）は計画どおり続ける / 予備測定で誤った violation が Claude 1 件（80 graded）、Codex 0 件（77 graded、3 run は Codex 側の停止で failed）しか出ず、新しい本文で同じ変化が出ても A/A の揺れ（Claude 1 → 0）と区別できない。「両モデルとも 0」の条件には当たらないが、リスク欄の「差が測れない → 不採用として記録」に基づく打ち切りとする。不採用は「この fixture と基準では改善を評価できない」の意味で、#220 の価値の否定ではない。duplicate-names の正解は予備測定の後にあいまいとして外した。「Questions」の節の価値は別の仮説と基準が要るので今回の採否に入れない / Go が要る（持ち主が 2026-10-08 に Go。「Questions」の節は今は issue にしない）
- 2026-10-08 / #257 は M2 の予備の run で打ち切り、不採用として #257 に記録する。下書き（rules/SKILL.md の Checks の節）と Lifecycle（overview の look の checks、MCP の入力、rule-files、関連テスト）を最終の差分から外し、版も上げない。評価の仕組み（server/evals/review/ の M1・M2）と結果は残す / M1 は合格（m1b・m1c とも両ホスト各 10 run で全項目 0）したが、M2 の予備の run（ルール文だけ、タスク 3 つ × 両ホスト × 3 回 = 18 run）で違反が 0、完了 18/18 で、基準 (1)「違反がルール文だけより減る」を評価できない。check の条件と導入・修理の手間（(2)〜(5)）は測っていない。不採用は「この fixture と基準では改善を評価できない」の意味で、機能の価値の否定ではない。ルール文が読まれない状況での再実験は今回は issue にしない / Go が要る（持ち主が 2026-10-08 に Go）
