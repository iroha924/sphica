---
kind: plan
status: approved
codex_session: 01a15315-1ae0-7511-872a-d27972ce265f
codex_rounds: 2
approved_at: 2026-10-19
---

# #355: trace が、提案が変わった後の最終版への持ち主の返事を採用に引くようにする

## 要点

- trace・harvest・glean の 3 つの Skill の採用の説明に、「返事の後で提案が変わったら、最終版への返事を引く。前の版への返事は採用にならない。最終版に答えた返事が無ければ adoption を外す」を足す。trace では持ち主の採用に限り、AI の採用の規則とはぶつけない
- trace の record_check / record_save に警告を 1 つ足す: 人の採用の発言が、記録が unit-level の `proposes` で引く発言より前の時刻しか無いとき。保存の結果（active / candidate）は変えない
- acceptance case を先に 2 件足し、直す前のコードで警告が出ないことを確かめてから実装する
- 0.6.62 として plugin をリリースする（npm と 3 つのマニフェスト）
- 変えないもの: 何が active になるかの規則、DB の schema、harvest と glean の検査（文面だけ変える）、既存の記録

## 持ち主の決定

- #355 を進める（2026-10-19、「OK、#355進めよう」）
- 持ち主の採用の取り違えは、#259 の基準どおり修正の issue にする（記録 trace:bd134cd6-e5ba-4fdf-bcf1-2e21ee79aded/issue-355）。issue の Proposed fix の文面が出発点

## 目的

- trace を回す AI が、Skill の文面で「提案が変わったら最終版への返事を引く」と読める（3 つの Skill に同じ趣旨がある）
- trace の新しい記録で、人の採用の発言が、記録が `proposes` で引く発言より前にあるとき、check と save の両方に警告が 1 行出て、記録はそのまま保存される

## 対象外

- 既存の記録（u670、u147）の書き換え。直すには持ち主の言葉で glean の `retract_adoption` と `adopt` が要るので、持ち主に聞いてから別に行う
- harvest と glean の機械の警告。GitHub の source の `created_at` は編集後の版でも最初の時刻のままで（`server/src/github.ts:477`）、引いた版の前後を時刻で決められない。glean の ops は既存の記録への別の経路（`server/src/glean.ts:449`）
- option の evidence の `proposes`。「A を採用 → B を提案 → B を却下」のような正しい記録まで警告してしまう
- Skill の文面が効いたかの LLM での実測。取り違えは 59 行中 1 件で、少ない回数のリプレイでは差を測れない。完了条件で未検証と書く
- 採用の意味の判定。check は言葉の位置だけを見る（`ASSURANCE.md:83`）

## 前提

- `plugin/skills/trace/SKILL.md:115` の `adoption` 行は「the words that settle it」とだけ言い、提案が変わったときにどの返事を引くかを言わない（事実）
- Claude Code と Codex は同じ `plugin/skills/` を読む（`plugin/.codex-plugin/plugin.json:11`）（事実）
- 持ち主の DB を読み取りのみで数えた（2026-10-19）: trace の決定と制約のうち、生きた owner_statement の採用を持つものは 294 件。そのうち、どの採用の発言よりも後の発言を unit-level の `proposes` で引くものは 3 件で、option-level は 0 件（事実）
  - u670（s3573 を採用に引き、後の s3574 を proposes に引く）: 取り違え。#355 の件
  - u147（s713 を採用に引き、後の s715 の「1 つの PR に」を proposes に引く）: 同じ形。具体的な案は採用の後に出ている
  - u655（s3507「中: カバレッジを片方に」を採用に引き、後の s3508 の言い換えを proposes に引く）: 持ち主は選択肢を選んでいて、採用は正しい。誤検出
- 警告は `checkRecord` の `problems` に足せば、trace と harvest では check と save の両方に出る（`server/src/record.ts:308`、`server/src/extract.ts:815`、`server/src/extract.ts:903`）。引用と話者を確かめた後の evidence は `server/src/record.ts:501`、adoption は `server/src/record.ts:576` 付近で組み立てている（事実。Codex も確かめた）
- session_message の `created_at` は会話の発言の時刻（`server/src/trace.ts:207`）（事実）
- acceptance case の driver は、`check_problem_contains`・`check_problem_absent`・`save_notes_contain`・`result_lines` で警告を確かめられる（`server/evals/acceptance/driver.ts:1547`〜`1579`）。層ごとの件数は `server/test/acceptance-cases.test.ts:18` で固定している（事実）
- `.agents/skills/knowledge-schema/SKILL.md` は、新しい挙動には先に acceptance case を足し、意図した理由で落ちることを確かめるよう求めている（事実）

## 方針

- 文面（英語）
  - trace の `adoption` 行に足す: "For the owner's adoption: when the proposal changed after an owner reply (narrowed, widened, or replaced), quote the owner's reply to the final version; a reply to an earlier version does not adopt it. When no owner reply answers the final version, leave the adoption out."
  - 同じ行か Flow の Check の段に、警告への対処を足す: "When check says the adoption is older than the proposal it cites, look at what changed: if the proposal really changed, quote the owner's reply to the final version or leave the adoption out; if the later message only explains what was already adopted, cite it as `explains`; if the adoption is right as it is, keep it."
  - harvest の Who adopts: 同じ趣旨を owner と maintainer の返事として 1 文で足す。glean の `adopt`: 同じ趣旨を 1 文で足す
- 警告
  - 場所は `checkRecord` の中で、`target.origin === "trace"` のときだけ
  - 比べるもの: unit の adoption のうち route が `owner_statement` か `explicit` のものの source の `created_at` の最大と、unit-level（option_id なし）の role `proposes` の evidence の source の `created_at` の最大。どちらも、引用と話者の検査を通った後の行だけを使う
  - 「proposes の最大 > 採用の最大」（厳密な不等号）のときだけ `problems` に 1 行足す。同じ時刻、どちらかが無い、route `agent` だけ、のときは出さない
  - 文面: `<key>: its adoption (s<a>) is older than the proposal it cites (s<p>); if the proposal changed, quote the owner's reply to the final version or leave the adoption out; keep it if the adoption is right`（`s<a>` は最も新しい採用、`s<p>` は最も新しい proposes）
  - 保存の結果、schema、DB に書く行は変えない
- テスト
  - acceptance case を `capture` 層に 2 件足す（capture-06 と同じ、人の採用の層。件数 18 → 20）。(a) 提案 → 持ち主の返事 → 狭めた提案（proposes）→ 持ち主の「OK」の会話で、前の返事を採用に引くと check と save の両方に警告が出て、記録は active のまま。(b) 同じ会話で「OK」を引くと警告が出ない。日本語と英語で 1 件ずつ
  - `server/test/record.test.ts` に、本物の SQLite で境界の例: 採用なし、proposes なし、同じ時刻、複数の採用（最大で比べる）、agent の採用だけ、option の後の proposes、harvest の run では出ない、check は何も書かない
- リリース: 0.6.62 への版の変更は package を変える最初のコミットに入れ（pre-commit の `bundle` が、main と同じ版のままの package の変更を止める）、そのコミットの後に `bun run release:plan -- --base <0.6.61 のリリースのコミット>` で `plugin` を確かめる（release:plan はコミット済みの履歴だけを読む）

## 採った案と棄却した案

- 採用: 警告にとどめる。棄却: 候補に留める（u655 のような正しい採用まで止まる。当たった 3 件のうち 1 件が誤検出）
- 採用: Skill の文面と機械の警告の両方。棄却: 文面だけ（次に同じ誤りを止めるものが無い）
- 採用: 警告は trace の新しい記録だけ。棄却: harvest と glean にも入れる（GitHub の版の時刻が取れず、glean の ops は別の経路）
- 採用: unit-level の proposes だけ。棄却: option の proposes も含める（却下した別案の提案時刻で、正しい採用まで警告する）
- 採用: 文面は 3 つの Skill で揃える。棄却: trace だけ（harvest と glean も採用を独自に説明していて、同じ誤りが起こりうる）
- 採用: 警告への対処は、変わったか・説明か・正しいかで分ける。棄却: 一律に「最終版を引くか adoption を外す」（role を変えるだけで警告を消せ、正しい採用を保てない）
- 採用: LLM の実測はしない。棄却: 旧文面と新文面のリプレイを比べる（1/59 の頻度では少ない回数で差が出ない）

## 手順

- S1: acceptance case を 2 件足し、直す前のコードで警告が無い理由で落ちることを確かめる
- S2: `checkRecord` に警告を足し、`record.test.ts` に境界の例を足す
- S3: trace・harvest・glean の Skill の文面を足す
- S4: release:plan を流し、0.6.62 に上げる（npm と 3 つのマニフェスト）

## 完了条件

- A1: `bun run verify` → 0 で終わる
- A2: `rg -n "check did not report" .claude/plans/2026/10/19-adoption-final-reply.tasks.md` → S1 のタスクの結果欄に 1 行以上（警告を足す前のコードで、警告が無い理由で落ちた記録）
- A3: `bun run release:plan -- --base <0.6.61 のリリースのコミット>` → `plugin`。`rg -n '"version": "0.6.62"' plugin/package.json plugin/.claude-plugin/plugin.json plugin/.codex-plugin/plugin.json .claude-plugin/marketplace.json` → 4 ファイルすべてに当たる
- A4: `npm pack --pack-destination <リポジトリの外の一時ディレクトリ>`（`plugin/` で）を展開し、`rg -l "reply to the final version" <展開先>/package/skills/{trace,harvest,glean}/SKILL.md` → 3 ファイル、`rg -c "is older than the proposal it cites" <展開先>/package/dist/mcp-record.js` → 1 以上
- A5: `gh pr checks <PR>` → 全ジョブが pass
- A6: 持ち主が npm-release を承認した後、`npm view sphica@0.6.62 version` → `0.6.62`。plugin-release Skill の両ホストの確認手順で、Claude Code と Codex の両方の record_check が警告を出す。承認の前は「公開済み」と報告しない
- A7: `gh pr view <PR> --json body --jq .body | rg -c "unverified"` → 1 以上（Skill の文面が AI の引用の選び方を変えたかは未検証と書いてある）

## リスク

- 警告が誤検出（u655 の形）で出て、AI が正しい採用を外す → 文面で「正しければ残す」と言う。外された記録は candidate に残るだけで、消えはしない
- 警告の文言を変えると acceptance case がずれる → case は警告の文の一部（`is older than the proposal it cites`）で確かめる
- 計測中の #353（10-26 ごろ）と #218（10-29 ごろ）に混ざる → この変更は配信を変えないので混ざらない見込み（推測）。リリースの日付は PR 本文に書いて、計測で見分けられるようにする

## 未解決

なし

## 変更履歴

- 2026-10-19 / 方針のリリースの手順を「版を編集する前に release:plan」から「版を入れたコミットの後に release:plan」へ / release:plan はコミット済みの履歴だけを読み、作業ツリーの変更では none と出た（実測） / Go 不要（範囲は変わらない）
