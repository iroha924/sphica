---
kind: plan
status: approved
codex_session: 01a10215-6f9a-7480-a3ee-587d012a7042
codex_rounds: 2
approved_at: 2026-10-03
---

# Fix the four review findings of the cloud evaluation loop (#239) before the next loop

## 要点

- gold 条件の run で gold フックが gold の record を返していなければ、その run を excluded にする（Claude と Codex の両方）。今は返していなくても `presented` が付き、採点が「見せた」として扱う
- report は、`bundle` が無いか空の grades ファイルを、ファイル名を出して拒否する。今は全部欠けていると「同じ bundle」として通る
- Codex のイベントログに壊れた行があっても、確かなヒットは `yes` のまま残す。今は前後どちらにあっても `unknown` になる
- collect と grade から `--out` を消し、成果物は必ずビルドディレクトリに置く。次の段はそこにある `tasks.json` を読むため
- 変えないもの: パッケージ（release:plan は none）、バージョン、`server/evals/cloud/` とそのテスト以外

## 持ち主の決定

- #239 の 4 件を、次の評価ループの前に直す
- 1 件ずつ、今のコードで落ちるテストから始める
- 範囲は `server/evals/cloud/` と `server/test/eval-grade.test.ts`。リリースしない。PR は 1 本

## 目的

次の評価ループで、gold が届かなかった run は gold の結果として採点されない。bundle の分からない grades ファイルは report を通らない。壊れた行のある Codex ログでも、見えていたヒットが失われない。collect → grade → report が、常に同じビルドの `tasks.json` で流れる。

## 対象外

- `foundInCodexEvents`: 壊れた行の後も読み続け、ヒットを先に返しているので、この不具合に当たらない
- Claude の run を collect で通すテスト: リモートの `claude/eval-*` ブランチの用意が要る。判定は Codex と同じヘルパーを通るので、ヘルパーの単体テストと Codex 経路の collect テストで押さえ、配線はレビューで見る
- #239 で「別のビルドに置いた成果物にビルドの場所を持たせる」案（下の棄却を参照）

## 前提

- `server/evals/cloud/collect.ts:61` の `presentedOf` は条件と task だけで決まり、フックの出力を見ない（3e842e19 で確認）
- 同じフックの出力は Claude では receipts の `name: "gold"` の行（`collect.ts` の `goldOut`）、Codex では `gold-receipt.txt`。`judge.ts` の `deliveredSignal` は、出力が無いか gold のキーを含まなければ既に `no` を返す
- `report.ts` の CLI 部分（199〜203 行）は ID を確かめた後で `new Set(builds.map((b) => b.bundle))` を比べるので、全部 `undefined` や全部 `""` だと 1 要素になって通る
- `judge.ts` の `goldSignalsFromCodex` は壊れた行や結果の無い Sphica 呼び出しで `readable = false` にして `break` し、`seen()` は `!readable` のとき常に `unknown` を返す。Codex が 3e842e19 で再現: ヒットの後に壊れた行があっても、その逆の順でも `in_search` は `unknown`
- grade は `dirname(--loop)/tasks.json`、report は `dirname(grades)/tasks.json` を読む。eval-loop Skill（`.claude/skills/eval-loop/SKILL.md` の 60・66・74 行）は既定の場所しか使わず、`--out` を渡すのはテストだけ（`eval-grade.test.ts:508` ほか collect のテスト）
- excluded の行は grade で採点されず、report では started と excluded に数えられて平均から外れる（`grade.ts`、`report.ts` の `summary`）

## 方針

- F1: `judge.ts` に、条件・gold のキー・フックの出力を受けて「gold 条件なのにフックが gold を返していない」かを返す関数を export する（判定は `deliveredSignal` と同じく、出力が gold のキーを含むか）。collect は Claude の run と Codex の run の両方で、これが真なら `excludedRow(..., "gold hook returned no record")` にする。excluded にならなかった gold の run は、今までどおり `presentedOf` で `presented` を付ける
- F2: report の CLI で、ID の検査の後、bundle の比較の前に、`bundle` が文字列でないか空の grades ファイルがあれば、そのファイル名を出して throw する
- F3: `goldSignalsFromCodex` は壊れた行・object でない行・結果の無い Sphica 呼び出しで `break` せず、読めないことを覚えて読み続ける。`seen()` は、集めた結果がそのキーとツールを示していれば `yes`、それ以外で読めない行があれば `unknown`、どちらでもなければ `no`
- F4: collect.ts と grade.ts の `parseArgs` から `out` を消し、出力先をそれぞれ `<build>/loop.json` と `dirname(--loop)/grades.json` に固定する。先頭の Run: の行も直す。`parseArgs` は strict なので、`--out` を渡すと出力を書く前に失敗する
- テスト（すべて `server/test/eval-grade.test.ts`）
  - F1: collect を子プロセスで流す。Codex の gold の run（status 0）で、`gold-receipt.txt` が無い・空・関係ないテキストの 3 つは excluded と理由。gold のキーを含むものは excluded にならず、反事実の task なら `presented` が付く。`presented` を見るには gold スロットの `.tools/gold.json` が要り、スロットがあると collect が `git fetch` するので、一時ディレクトリの bare リポジトリを origin にし、`plan.json` も置く（ネットワークに出ない）。既存の swapped の gold のテストには、`trace:s-en-dates-local/local` を含む `gold-receipt.txt` を足す
  - F2: report を子プロセスで流す。ID が別々で `tasks.json` もそろった 2 つの grades ファイルで、`bundle` が両方無い場合と両方空の場合に、非 0 で終わってファイル名を出す
  - F3: search と read のそれぞれで、ヒットの後に壊れた行、壊れた行の後にヒット、の両方が `yes`。ヒットの無いキーとツールは `unknown` のまま
  - F4: collect（リポジトリも run も無いビルド）と grade（行 0 件の loop.json と tasks.json）に、ビルドの外を指す `--out` を渡すと非 0 で終わり、そこにファイルができない。`--out` を渡していた既存のテストは既定の場所を読むように直し、既定の場所に書くことの確認を残す
- red は、どれも 3e842e19 の上で、狙った理由で落ちることを確かめてから直す。新しい export が無いことによる import エラー、関係ないフィクスチャの失敗、`tasks.json` の欠けは red に数えない

## 採った案と棄却した案

- 採用: フックが gold を返さなかった gold の run を excluded にする。棄却: run を残して `presented` を null にする（gold 条件が掛かっていない run を gold の結果に数え、`receiveGrade` での `followed` の扱いも変わる）
- 採用: collect と grade の `--out` を消す。棄却: 成果物にビルドディレクトリの絶対パスを書き、次の段がそれを読む（誰も使っていないオプションのために、パスを持つ欄と古い成果物の扱いが増える）
- 採用: report の検査を子プロセスで試す。棄却: 検査を `checkBuilds` として export する（既存の report の CLI のテストが子プロセスで足りている）

## 手順

- S1: F3（`goldSignalsFromCodex` が確かなヒットを優先する）
- S2: F1（gold を返さなかった gold の run を excluded にする）
- S3: F2（report が bundle の欠けを拒否する）
- S4: F4（collect と grade の `--out` を消す）

## 完了条件

- A1: `bun run verify` → 0 で終わる
- A2: `git checkout 3e842e19 -- server/evals/cloud; (cd server && node --test test/eval-grade.test.ts); git checkout HEAD -- server/evals/cloud` → T01〜T04 で足したテストだけが、各タスクの red に書いた理由で落ちる
- A3: `rg -n -- '--out' server/evals/cloud/collect.ts server/evals/cloud/grade.ts server/test/eval-grade.test.ts` → collect と grade の出力先としての `--out` が残っていない（Codex の `--output-schema` と、`--out` の拒否のテストは別）
- A4: `gh pr checks --watch` → 必須のチェックがすべて pass

## リスク

- F1 で、これまでの gold の run の一部が excluded に変わる → 結果の数え方が変わるのは意図どおり。#238 のループでは全部の gold の run に record が届いていたこと（#239 本文）を PR 本文に書く
- gold スロット付きの collect テストが git の操作で重くなるか不安定になる → 一時ディレクトリの bare リポジトリだけを使い、`childEnv` で HOME を一時ディレクトリにする。それでも不安定なら `presented` の確認だけ `presentedText` の単体テストへ下ろし、記録節に書く

## 未解決

なし

## 変更履歴
