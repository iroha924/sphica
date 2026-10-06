---
kind: tasks
plan: 07-m1-hot-paths.plan.md
branch: perf/m1-hot-paths
base: main
---

# 記録数に比例して遅くなる配信（プロンプト・review・Bash）を計測で確かめて直し、計測を再現できる形で残す（#270） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 計測

本物の hook と同じ条件で、記録数ごとの配信と capture の吐き出しの時間と中身を測り、main の表が取れる。

- [x] T01: 計測スクリプトを足し、main で流して修正前の表を取る
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `server/evals/scale/run.ts`, `knip.json`
  - 完了条件: `node server/evals/scale/run.ts` → 表の頭に commit・node・OS・CPU・件数が出て、uniform 10,000 件のプロンプトの行が timeout か 1,000 ms 超え、capture の 50,000 件の行が送った件数 50,000・残り 0
  - コミット: `feat(evals): add a scale benchmark for delivery hooks and capture drain`
  - 結果: `node server/evals/scale/run.ts` → e5c7ec0e、node v24.15.0、Darwin 27.0.0 arm64、Apple M4 Pro x12 で、uniform 10,000 件のプロンプト 3 行が全部 timeout（5,008〜5,014 ms）、capture は 50,000 件で 8,171 ms・sent 50,000・left 0・rows 50,000
  - 結果: `node server/evals/scale/run.ts` → プロンプトの最大は 359 件で 479 ms、1,000 件で 1,248 ms、3,000 件で 3,812 ms。Bash は 10,000 件で 1,857 ms（stress 1,641 ms）、30,000 件で timeout。Read・Edit・review・SessionStart・SubagentStart は 30,000 件まで 139 ms 以下

## P2: 今の挙動を固定する

直す前の並び・一致・除外を、今のコードで緑になるテストで固定する。

- [x] T02: プロンプト配信の特徴づけのテスト
  - 種別: 追加
  - 計画: S2
  - 依存: なし
  - 変更: `server/test/deliver.test.ts`
  - 完了条件: `cd server && node --test --test-name-pattern "prompt delivery keeps" test/deliver.test.ts` → 今のコードで全部通る
  - コミット: `test(deliver): pin prompt delivery order, precedence, and matching before the rewrite`
  - 結果: `cd server && node --test --test-name-pattern "prompt delivery keeps" test/deliver.test.ts` → pass 1 / fail 0（e5c7ec0e のコードのまま）。5 件の一致は constraint・constraint・decision の順で出て、id 順ではなく kind 順だった

- [x] T03: review の選び出しの特徴づけのテスト
  - 種別: 追加
  - 計画: S2
  - 依存: なし
  - 変更: `server/test/review.test.ts`, `server/test/review-bridge.test.ts`
  - 完了条件: `cd server && node --test --test-name-pattern "review selection keeps" test/review.test.ts test/review-bridge.test.ts` → 今のコードで全部通る
  - コミット: `test(review): pin review selection and its delivery before the rewrite`
  - 結果: `cd server && node --test --test-name-pattern "review selection keeps" test/review.test.ts test/review-bridge.test.ts` → pass 2 / fail 0（e5c7ec0e のコードのまま）

## P3: 修正

プロンプト配信と review の選び出しが、記録数に比例する探し直しと、全件の id を並べる `in` をやめる。

- [x] T04: プロンプト配信の修正（32,767 件で空を返す件を含む）とバージョンの引き上げ
  - 種別: 修正
  - 計画: S3, S4, S8
  - 依存: T02（並びと一致を固定してから書き換える）
  - 変更: `server/src/deliver.ts`, `server/src/db.ts`, `server/test/deliver.test.ts`, `server/test/temp-db.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - red: `cd server && node --test --test-name-pattern "32,767" test/deliver.test.ts` → 一致する記録があるのにプロンプト配信が空を返して落ちる
  - 完了条件: `cd server && node --test test/deliver.test.ts` → 全部通る。`node server/evals/scale/run.ts` → uniform 10,000 件のプロンプトの最大が 1,000 ms 以内
  - コミット: `fix(deliver): match prompts per unit without scanning every anchor and option, and bind no id list`
  - 結果: red `cd server && node --test --test-name-pattern "32,767" test/deliver.test.ts` → 修正前のコードで `actual: ''` で落ちた。同じテストを 32,766 件にすると通った（上限が原因）
  - 結果: `cd server && node --test test/deliver.test.ts` → pass 46 / fail 0
  - 結果: `node server/evals/scale/run.ts --sizes 3000,10000 --no-stress --no-drain` → uniform 10,000 件のプロンプトの最大 133 ms・130 ms・177 ms（修正前は 3 行とも timeout）、3,000 件で最大 148 ms

- [x] T05: review の選び出しの修正（32,767 件で失敗する件を含む）
  - 種別: 修正
  - 計画: S3, S5
  - 依存: T03（選び出しと配信の結果を固定してから書き換える）
  - 変更: `server/src/review.ts`, `server/test/review.test.ts`
  - red: `cd server && node --test --test-name-pattern "32,767" test/review.test.ts` → 場所の無い dont / defer が 32,767 件で `too many SQL variables` になり落ちる
  - 完了条件: `cd server && node --test test/review.test.ts test/deliver.test.ts` → 全部通る
  - コミット: `fix(review): select location-free options through a subquery and group them per unit`
  - 結果: red `cd server && node --test --test-name-pattern "32,767" test/review.test.ts` → 修正前のコードで `Error: too many SQL variables` で落ちた
  - 結果: `cd server && node --test test/review.test.ts test/review-bridge.test.ts test/deliver.test.ts` → pass 74 / fail 0

- [ ] T06: 計測し直し、Bash の配信が 1 秒を超えていれば直す
  - 種別: 修正
  - 計画: S6
  - 依存: T01（計測スクリプトが要る）, T04（プロンプトの修正後の値で判断する）, T05（review の修正後の値で判断する）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - red: `node server/evals/scale/run.ts` → stress か uniform の 10,000 件で Bash の最大が 1,000 ms を超える（超えなければこのタスクは取りやめ）
  - 完了条件: `node server/evals/scale/run.ts` → 0 で終わり、10,000 件の両系統でプロンプト・review の 2 つの入口・Bash の最大が 1,000 ms 以内
  - コミット: `fix(deliver): name shell paths without one regex per anchored path`

## P4: 仕上げ

次に照合のコードを変える人が、同じ計測を前後で流すようにする。

- [ ] T07: `plugin-release` Skill の確認項目に計測の 1 行を足す
  - 種別: 追加
  - 計画: S7
  - 依存: T01（スクリプトのパスが要る）
  - 変更: `.agents/skills/plugin-release/SKILL.md`
  - 完了条件: `bun run verify:ai` → 0 で終わる
  - コミット: `docs(plugin-release): run the scale benchmark when changing delivery matching`

## 記録

- 2026-10-07 / T01 / 修正前の計測で stress の review 2 行が「期待した記録が無い」になった。review の配信は 1 回 5 件まで id 順で、差分に入れた 500 件共有のファイルの記録で埋まるため（仕様どおり） / stress の review の期待を「記録を出していること」（`trace:ext-b` を含む）に直した。uniform は最後の記録の key を引き続き見る

- 2026-10-07 / T03 / review の hook の結果のテストは、review の checkout の作り方を持つ `review-bridge.test.ts` に置くほうが合う / 変更欄を `server/test/review.test.ts`, `server/test/deliver.test.ts` から `server/test/review.test.ts`, `server/test/review-bridge.test.ts` に、完了条件のファイルも同じく変えた
- 2026-10-07 / T02 / plan の「position の順と id の順が違う選択肢」は作れない。選択肢は保存のときに配列の順で position = i + 1 として 1 文で入り（`record.ts`）、書き換えは trigger `unit_option_frozen` が止める / fixture に入れず、ここに残す
- 2026-10-07 / T04 / 配列の探し直しをやめても、新しいプロセスでのプロンプトの時間は変わらなかった（10,000 件で timeout のまま）。支配的だったのは記録ごとに作る `\p{L}` の正規表現の組み立てで、新しいプロセスで 30,000 個作るのに 11,498 ms、`includes` なら 3 ms（実測） / 正規表現を作る前に部分文字列で振り落とす判定を足した（含まれないなら正規表現も一致しないので、一致の規則は変わらない。anchor のパスは schema の CHECK で `\` を含まない）。変更欄に `server/src/db.ts`（`byUnit` を review と共有）と `server/test/temp-db.ts`（32,767 件を入れるヘルパー）を足した
