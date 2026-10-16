---
kind: tasks
plan: 16-delivery-precision-346.plan.md
branch: feat/delivery-precision-346
base: main
---

# #346 の手順 1: 自動配信の当たる率を抜き取りで測り、終わった計画を外す計画に進むかを決める のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 抜き取りのスクリプト

母集団を保存して同じ 80 組を出し直せ、ラベル用のシートが出て、ラベルから判定が出るスクリプトができる。

- [x] T01: 母集団を抽出して保存し、保存したものと照合する（`--db`）
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `server/evals/delivery/sample.ts`, `server/test/delivery-sample.test.ts`, `knip.json`
  - 完了条件: `node --test server/test/delivery-sample.test.ts` → 一時 DB から窓・project・outcome で絞った (delivery.id, unit_id) の一覧と sha256 が保存され、行を消した DB で抽出し直すと違いを報告して 0 以外で終わる
  - コミット: `feat(eval): extract and pin the delivery population for the #346 sample (T01)`
  - 結果: `node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts`（server/）→ 4 件 pass（窓・project・outcome の絞り込みと並び、照合の 4 種の違い、子プロセスで 2 回目は同じと報告・行を消した DB では 0 以外で終わり保存ファイルは変わらない、足りない引数の名指し）。`bun run check` → 0

- [x] T06: 窓の時刻を正規化し、プロジェクトを一意な key で選ぶ
  - 種別: 修正
  - 計画: S1
  - 依存: T01（直す対象の抽出と保存）
  - 変更: `server/evals/delivery/sample.ts`, `server/test/delivery-sample.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts` → ミリ秒なしの from で境界の行が抜ける、同じ名前の 2 プロジェクトで片方を黙って選ぶ、の 2 件が落ちる
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts` → 全件 pass。ミリ秒の有無で同じ組が出て、日時でない値は名指しで止まり、`--project` は key で選ぶ
  - コミット: `fix(eval): normalize the window and pick the project by key (T06)`
  - 結果: red: `cd server && node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts` に直す前のコードで流した → ミリ秒なしの from で境界の行が 0 件（expected 1）、key を渡すと `no project named git:gitlab.com/o/r` で落ちた。直した後 `cd server && node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts` → 9 件 pass（ミリ秒なしでも 4 組・窓は正規化して保存、`yesterday` は名指しで止まる、gitlab の key でそちらの組だけ）。T02 と同じコミット

- [x] T02: 保存した母集団から seed で 80 組を抜き取り、ラベル用のシートを出す（`--sample`）
  - 種別: 追加
  - 計画: S1
  - 依存: T01（保存した母集団の形が要る）
  - 変更: `server/evals/delivery/sample.ts`, `server/test/delivery-sample.test.ts`
  - 完了条件: `node --test server/test/delivery-sample.test.ts` → 同じ母集団と seed で 2 回流すと同じ組が同じ順に出る。一時の Claude Code と Codex の会話の記録から依頼と動きがシートに入り、記録の無い組は「記録なし」で残る
  - コミット: `feat(eval): sample delivered records and write labelling sheets (T02)`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts` → 9 件 pass（同じ seed で同じ 80 組・同じ順、2 回の `--sample` の出力が一致、sha256 を書き換えた母集団で止まる、Claude Code の main とサブエージェント・Codex の会話から依頼と動きがシートに入り、記録の無い組は no transcript found）

- [x] T03: ラベルから判定を出す（`--decide`）
  - 種別: 追加
  - 計画: S1
  - 依存: T01（sample.ts の引数の受け方が要る）
  - 変更: `server/evals/delivery/sample.ts`, `server/test/delivery-sample.test.ts`
  - 完了条件: `node --test server/test/delivery-sample.test.ts` → (8,7,1,0) は進む、(10,8,2,0) と (8,0,8,0) は undecided、F < 8 は判定できない、R >= 2 は進まない
  - コミット: `feat(eval): decide the finished-plan gate from settled labels (T03)`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts` → 12 件 pass（(F,I,U,R)=(8,7,1,0) は go、(10,8,2,0) と (8,0,8,0) は undecided、F=7 は too few、R>=2 は not adopted。F=8〜30 の全ての分け方で unknown を両方に解決した結果と一致。順番の飛びと語彙の外を名指しで拒む）。`bun run check` → 0

- [x] T07: シートを Codex の子スレッドの会話で書き、次のプロンプトまでの動きを数で切らず、差し込みのタグだけを外す
  - 種別: 修正
  - 計画: S1
  - 依存: T02（直す対象のシートの作成）
  - 変更: `server/evals/delivery/sample.ts`, `server/test/delivery-sample.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts` → 子スレッドの配信に親のログを選ぶ、配信の後 12 件の呼び出しの 11 件目以降が消える、`<task>` で始まる依頼が消える、の 3 件が落ちる
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts` → 全件 pass。子スレッドはその id のログ、配信の後は次のプロンプトまで（多ければ先頭と省いた件数）、外すのは environment_context・skill・external_codex_apps_open_page・user_instructions で始まるものだけ
  - コミット: `fix(eval): read Codex child threads and whole turns in labelling sheets (T07)`
  - 結果: red: `cd server && node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts` → 直す前は 3 件が落ちた（配信の後 actual 10 / expected 13、`<task>` の依頼が actual []、子スレッドの配信に親の rollout を選んだ）。直した後 `cd server && node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts` → 15 件 pass。`bun run check` → 0。配信の後は 30 行まで出し、残りは件数を書く

- [x] T08: Codex が差し込む AGENTS.md の本文をプロンプトから外す
  - 種別: 修正
  - 計画: S1
  - 依存: T07（直す対象の差し込みの判定）
  - 変更: `server/evals/delivery/sample.ts`, `server/test/delivery-sample.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts` → `# AGENTS.md instructions for ...` で始まる user メッセージがプロンプトに残り、差し込みのテストが落ちる
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts` → 全件 pass。AGENTS.md の差し込みは外れ、その後の本当の依頼がターンの始まりになる
  - コミット: `fix(eval): leave the AGENTS.md text Codex injects out of prompts (T08)`
  - 結果: red: `cd server && node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts` → 直す前は差し込みのテストが落ちた（`# AGENTS.md instructions for /Users/o/r` と `# AGENTS.md instructions` の 2 件がプロンプトに残った）。直した後 `cd server && node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts` → 15 件 pass。`bun run check` → 0

- [x] T09: Claude Code のタスクの通知とサブエージェントの報告を、ターンを始めるプロンプトにしない
  - 種別: 修正
  - 計画: S1
  - 依存: T02（直す対象の Claude Code の読み方）
  - 変更: `server/evals/delivery/sample.ts`, `server/test/delivery-sample.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts` → origin が task-notification の行がターンを始めるプロンプトになり、持ち主の依頼が消えるテストが落ちる
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts` → 全件 pass。origin が task-notification と peer の行は notice としてターンの中に出て、ターンを始めるのは持ち主の依頼（origin が human か無い行）だけ
  - コミット: `fix(eval): keep task notices and subagent reports inside the owner's turn (T09)`
  - 結果: red: `cd server && node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts` → 直す前は通知と報告が prompt になりテストが落ちた（actual prompt, prompt / expected notice, notice）。直した後 `cd server && node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts` → 16 件 pass。`bun run check` → 0

- [x] T10: 最初の依頼より前の配信では、その後の最初の依頼とそのターンをシートに出す
  - 種別: 修正
  - 計画: S1
  - 依存: T09（直す対象のターンの区切り）
  - 変更: `server/evals/delivery/sample.ts`, `server/test/delivery-sample.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts` → 依頼より前の配信で、依頼が無いことになり配信の後も空になるテストが落ちる
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts` → 全件 pass。依頼より前の配信は、その後の最初の依頼と、次の依頼までの動きが出て、そうだと分かる見出しが付く
  - コミット: `fix(eval): show the first turn for a delivery made before any prompt (T10)`
  - 結果: red: `cd server && node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts` → 直す前は依頼より前の配信で prompt が undefined（expected first request）。直した後 `cd server && node --import ./test/isolate-home.ts --test test/delivery-sample.test.ts` → 17 件 pass。`bun run check` → 0

## P2: 測定と報告

持ち主の DB の直近 7 日から 80 組を抜き取ってラベルを付け、判定と防げた例を #346 に出す。

- [x] T04: 持ち主の DB から母集団を保存し、80 組を抜き取ってシートを作る
  - 種別: 追加
  - 計画: S2
  - 依存: T02（抜き取りとシートが要る）
  - 変更: `server/evals/delivery/population-2026-10-16.json`
  - 完了条件: `node server/evals/delivery/sample.ts --sample --population server/evals/delivery/population-2026-10-16.json --seed 20261016 --size 80 --out <scratchpad>/drawn.json` → 2 回流して同じ 80 組が同じ順に出る。`--sheet` でシートを scratchpad に書き、コミットしない
  - コミット: `test(eval): pin the 2026-10-09..16 delivery population (T04)`
  - 結果: `node server/evals/delivery/sample.ts --db ~/.sphica/sphica.db --project git:github.com/iroha924/sphica --from 2026-10-09T00:00:00Z --to 2026-10-16T00:00:00Z --population server/evals/delivery/population-2026-10-16.json` → 3093 pairs pinned、もう一度流して 3093 pairs, the same。`--sample ... --seed 20261016 --size 80` を 2 回 → 標準出力と JSON が `cmp` で一致。`--sheet` → 80 件、うち 18 件（Codex の 16 セッション）は no transcript found

- [ ] T05: 2 者のラベルと原因の分類を付けて判定し、結果を #346 に書く
  - 種別: 追加
  - 計画: S2, S3
  - 依存: T03（判定が要る）, T04（抜き取った 80 組が要る）, T07（ラベルに使うシートの直し）, T08（ラベルに使うシートの直し）, T09（ラベルに使うシートの直し）, T10（ラベルに使うシートの直し）
  - 変更: `server/evals/delivery/precision-baseline.json`
  - 完了条件: `jq '[.sample[] | select(.claude and .codex and .settled and .class and .class_reason)] | length' server/evals/delivery/precision-baseline.json` → 80。#346 のコメント（文面は持ち主の承認の後）の URL が JSON の note にある
  - コミット: `test(eval): record the #346 delivery precision baseline and its gate (T05)`

## 記録

- 2026-10-16 / T10 / 直したシートで、セッションの開始の配信など 7 項目は最初の依頼より前に届くので、依頼が無く配信の後も空になり、ラベルの材料が無かった / 修正タスク T10 を足し、T05 の依存に T10 を足した（前: T03, T04, T07, T08, T09、新: T03, T04, T07, T08, T09, T10）
- 2026-10-16 / T09 / 直したシートで、Claude Code の 11 項目のターンの始まりが `<task-notification>`（origin が task-notification）だった。サブエージェントの報告（origin が peer）も同じ形で入る / 修正タスク T09 を足し、T05 の依存に T09 を足した（前: T03, T04, T07, T08、新: T03, T04, T07, T08, T09）
- 2026-10-16 / T08 / ラベルを付け始めて、Codex が AGENTS.md の本文を `# AGENTS.md instructions` で始まる user メッセージとして差し込み、シートがそれを依頼と読んで本当の依頼の手前でターンを切ることに気付いた（直近 400 ログで 401 回、シートの 6 項目）。古いシートで始めた Codex のラベルは止めた / 修正タスク T08 を足し、T05 の依存に T08 を足した（前: T03, T04, T07、新: T03, T04, T07, T08）
- 2026-10-16 / T07 / Codex のレビューは指摘なし
- 2026-10-16 / T07 / T06・T02 の Codex のレビューで P2 が 3 件（Codex の子スレッドに親のログを使う、配信の後の動きを 10 件で切る、`<` で始まる依頼を全部外す）。どれも再現できる指摘として採る。窓の Codex の配信に子スレッドの行は 0 件なので今回の測定には響かない。差し込みのタグは直近のログで environment_context 302、skill 5、external_codex_apps_open_page 2 だった / 修正タスク T07 を足し、T05 の依存に T07 を足した（前: T03, T04、新: T03, T04, T07）
- 2026-10-16 / T03 / Codex のレビューは指摘なし（91,881 通りで判定式を直接確かめた）
- 2026-10-16 / T04 / 抜き取った 80 組のうち 18 組は Codex の 16 セッションで、~/.codex/sessions と archived_sessions のどこにもその id のログが無い（ephemeral の codex exec と推測、未確認） / 計画どおり除かずに「記録なし」で残し、件数を結果に書く
- 2026-10-16 / T04 / 完了条件のコマンドに `--out` が無かった（`--sample` は書き出し先が要る）。前: `--size 80` まで、新: `--out <scratchpad>/drawn.json` を足し、シートは `--sheet` で書く / 欄を直した
- 2026-10-16 / T06 / T01 の Codex のレビューで P2 が 2 件（窓の時刻を文字列のまま比べる、一意でない名前でプロジェクトを選ぶ）。どちらも再現できる指摘として採る / 修正タスク T06 を T02 の前に足した
