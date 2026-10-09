---
kind: tasks
plan: 09-e4-post-write.plan.md
branch: feat/e4-post-write
base: main
---

# 書いた本文が名指しした記録を書いた直後に配る実験（#213）と、shell で変わったファイルの取りこぼしの測定（#219）（E4）のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 入口の検査（モデルを回さない）

過去の書き込みと shell の変更に今の記録を当てて、post_write を作る価値があるかと、#219 の取りこぼしを数字で決める。

- [x] T01: onPrompt の照合を関数に切り出す（挙動は変えない）
  - 種別: 変更
  - 計画: S3
  - 依存: なし
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/deliver.test.ts test/deliver-codex.test.ts` → 既存のプロンプトの照合のテストが全部 pass し、切り出した関数を任意の本文に当てるテストが pass
  - コミット: `refactor(deliver): match records named in any text with the prompt's rules`
  - 結果: `namedRecords()` を export し onPrompt はそれを呼ぶだけにした。`node --import ./test/isolate-home.ts --test --test-timeout=120000 test/deliver.test.ts test/deliver-codex.test.ts` → 52 pass（コードの本文で toStored・却下した option・`open()` を名指し、`reopen` の中の open は名指さない）。`bun run verify` → exit 0
- [x] T02: M0 の再生スクリプト（Claude Code の会話記録と Codex のセッションの書き込みに、今の記録を当てる）
  - 種別: 追加
  - 計画: S1
  - 依存: T01（post_write と同じ照合を使う）
  - 変更: `server/evals/post-write/replay.ts`, `server/test/post-write-replay.test.ts`, `knip.json`, `server/src/deliver.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/post-write-replay.test.ts` → 合成の会話記録（Edit・Write・MultiEdit・NotebookEdit、読めない行、compact）で、書き込みの前に emitted になった記録だけが除かれ、組が host・文書／コード・symbol／path／option 別に数えられ、読めなかった件数が出る
  - コミット: `feat(eval): replay past writes against current records for the post_write entry check`
  - 結果: `node --import ./test/isolate-home.ts --test --test-timeout=120000 test/post-write-replay.test.ts` → 3 pass（失敗した編集と削除のセルは書き込みに数えない、old_string は見ない、再生自身が配った記録と compact の前に hook が配った記録を除き compact の後は数え直す、subagent は別の会話、プロジェクトの外は outside に数える、標本は seed で固定され文書とコードに分かれる）。`bun run verify` → exit 0
- [x] T16: 消えた worktree での書き込みを、本体のチェックアウトのプロジェクトに数える
  - 種別: 修正
  - 計画: S1
  - 依存: T02（直す対象の再生スクリプト）
  - 変更: `server/evals/post-write/replay.ts`, `server/test/post-write-replay.test.ts`
  - red: `node server/evals/post-write/replay.ts --db ~/.sphica/sphica.db --out <file> ~/.claude/projects/-Users-shunichi-Projects-sphica` → 486 件が outside。そのうち 153 件は cwd が消えた `.claude/worktrees/<name>` の書き込み
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/post-write-replay.test.ts` → 消えた worktree の cwd が本体のプロジェクトと worktree の根に解決され、ほかの消えたディレクトリは外のまま
  - コミット: `fix(eval): count writes from removed worktrees in their checkout's project`
  - 結果: red を直す前のコードで実測（outside 486、うち 153 件が消えた worktree）。直した後の同じコマンド → outside 333（scratchpad 278、~/.claude/projects 22、別のクローン 17 ほか、どれもこのプロジェクトのチェックアウトの外）、配信が起きる書き込み 247。`node --import ./test/isolate-home.ts --test --test-timeout=120000 test/post-write-replay.test.ts` → 4 pass。`bun run verify` → exit 0
- [x] T17: 再生の時刻・上限・壊れた行を直す（T02 のレビューの F1・F2・F4・F5）
  - 種別: 修正
  - 計画: S1
  - 依存: T02（直す対象の再生スクリプト）
  - 変更: `server/evals/post-write/replay.ts`, `server/test/post-write-replay.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern="counts from its result" test/post-write-replay.test.ts` → null の行で TypeError、書き込みの時刻が tool_use の `2026-10-01T00:00:00Z` のまま、900 字に入らない 3 件目も shown
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/post-write-replay.test.ts` → 書き込みの時刻が結果の時刻（DB と同じ形）で、同じ呼び出しの pre_edit が配った記録が除かれ、900 字に入らない行は shown にならず、壊れた行は数えて残りを再生する
  - コミット: `fix(eval): time replayed writes by their result and fit deliveries in 900 characters`
  - 結果: red は直す前のコードで 3 段に分けて実測（TypeError → 時刻の不一致 → third が shown）。直した後 `node --import ./test/isolate-home.ts --test --test-timeout=120000 test/post-write-replay.test.ts` → 5 pass。`bun run verify` → exit 0
- [x] T03: M0 を持ち主のデータで流し、持ち主のラベルで作るかどうかを決める
  - 種別: 追加
  - 計画: S1, S2, S4
  - 依存: T02（再生スクリプトが要る）
  - 変更: `server/evals/post-write/m0.json`
  - 完了条件: `cat server/evals/post-write/m0.json` → seed、標本（session・tool_use_id・記録の key・ラベルだけで本文を含まない）、集計、基準の判定（作る / 作らない）が入っている。作るなら会話ごとの予算の値を plan の変更履歴に書いた
  - コミット: `test(eval): record the post_write entry check and its labels`
  - 結果: `node server/evals/post-write/replay.ts --db ~/.sphica/sphica.db --out <file> ~/.claude/projects/-Users-shunichi-Projects-sphica` → プロジェクト内の書き込み 735 件のうち 248 件で配信が起き、出る組は 612（文書の path が 353）。会話あたりの発火は中央値 4・上位 1 割 8・最大 29。標本 40 組（seed 20261009）を Claude と Codex が独立にラベル付け（持ち主の指示。食い違い 2 組は R・N の数を変えず Codex に合わせた）→ R 0・H 10・N 30。基準に届かず、作らない（`server/evals/post-write/m0.json`）。予算の値は作らないので決めない
- [x] T04: M0' の抽出スクリプト（原因の内訳の 30 ターンと、組の母集団の無作為な並び）
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `server/evals/post-write/shell-miss.ts`, `server/test/post-write-shell-miss.test.ts`, `knip.json`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/post-write-shell-miss.test.ts` → 一時 DB で、via=status だけの anchor 付きの組が列挙され、同じ seed で同じ並び・同じ 30 ターンになり、次の持ち主のプロンプトまでの emitted の判定と Wilson 区間の判定（進む / 不採用 / 決まらない）が期待どおり
  - コミット: `feat(eval): sample shell-changed files to measure undelivered records`
  - 結果: `node --import ./test/isolate-home.ts --test --test-timeout=120000 test/post-write-shell-miss.test.ts` → 2 pass（同じターンに tool の行がある path・finding・anchor の無い path は数えない、compact の前と次のプロンプトの後の配信は数えない、次のプロンプトが無ければ窓は開いたまま、subagent への配信は別に出す、seed で 30 ターンと 150 組が固定、Wilson の判定が進む / 不採用 / 決まらない を返し、30 組目の確認で止まり 150 組を超えて数えない）。`bun run verify` → exit 0
- [x] T05: M0' を流して Claude と Codex でラベルを付け、#219 を判定する
  - 種別: 追加
  - 計画: S1, S6
  - 依存: T04（抽出スクリプトが要る）
  - 変更: `server/evals/post-write/m0-shell.json`
  - 完了条件: `cat server/evals/post-write/m0-shell.json` → seed、原因の内訳、引いた組と確かめられた組の数、取りこぼしの区間、Claude と Codex の食い違いの決着、判定が入っている。#219 へのコメントの文面を持ち主に見せた
  - コミット: `test(eval): record the shell-change miss rate for #219`
  - 結果: 母集団 2,842 組、seed 20261009。33 組を引いて shell の編集と確かめた 30 組のうち 20 組が次のプロンプトまでに配られず（67%、95% Wilson 49〜81%）→ 判定「進む」（`node server/evals/post-write/shell-miss.ts --decide server/evals/post-write/m0-shell.json` → proceed）。Claude と Codex のラベルの食い違い 3 組（1・24・31）は Claude の見落としで、会話記録で Codex が正しいと確かめた。#219 に持ち主が承認した文面でコメントした（issuecomment-6083349101）。#219 の配信は別の計画と Go が要るので、ここで止める

- [x] T18: 配信の条件を過去の時点で判定できるようにする（`deliverable`・`namedRecords`・`ownerAdopted` の asOf）
  - 種別: 追加
  - 計画: S1
  - 依存: T01（照合の関数が要る）
  - 変更: `server/src/deliver.ts`, `server/src/authority.ts`, `server/test/deliver.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/deliver.test.ts test/deliver-codex.test.ts` → asOf を渡すと、その時点の状態・anchor の追加と取り外し・衝突の追加と解決・採用の時刻で名指しの記録が決まり、渡さなければ今と同じ
  - コミット: `feat(deliver): decide deliverable records as of a past time for replays`
  - 結果: `node --import ./test/isolate-home.ts --test --test-timeout=120000 test/deliver.test.ts test/deliver-codex.test.ts` → 53 pass（新しいテスト: 保存より前は 0 件、後で active を外れた記録・後で外した anchor・後で足した anchor・後で採用が付いて効く衝突・後で解決した衝突を時点ごとに確かめ、時点なしは今の状態）。hook は asOf を渡さない。`bun run verify` → exit 0

- [x] T19: 会話記録を一次資料として読む部分（会話ごとの行の順、成功した呼び出しと結果、人間のプロンプト、compact、Sphica の差し込みの key の解析と不完全の判定）と、入力の固定（未コミットの拒否、DB のスナップショット、会話記録の hash の一覧、forget の検査）
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `server/evals/post-write/transcript.ts`, `server/test/post-write-transcript.test.ts`, `knip.json`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/post-write-transcript.test.ts` → 合成の会話記録で、両形式の記録の行の key の完全一致、本文での言及を key にしない、未知の形式の行を含む差し込みを不完全にする、origin が human の行だけを人間のプロンプトにする、compact の後だけを窓にする、subagent を別の会話にする。dirty tree と forget_batch の行で止まる
  - コミット: `feat(eval): read what reached each conversation from Claude Code transcripts`
  - 結果: `node --import ./test/isolate-home.ts --test --test-timeout=120000 test/post-write-transcript.test.ts` → 3 pass（両形式の記録の行の key、記録の本文にある別の key は key にしない、未知の形式の行で不完全、タスク通知は人間のプロンプトにしない、origin の無い行は unknown、compact の前後、subagent は別の会話でターンの始まりは最初の呼び出し、一時的な git リポジトリで dirty な server/ と forget_batch の行で止まる）。`bun run verify` → exit 0
- [x] T20: M0 を作り直す（時点の資格、会話記録での届いたか、対象の規則、unknown、ラベルの材料、C22 の判定）
  - 種別: 修正
  - 計画: S1
  - 依存: T18（時点付きの照合が要る）, T19（会話記録の読み取りが要る）
  - 変更: `server/evals/post-write/replay.ts`, `server/test/post-write-replay.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/post-write-replay.test.ts` → 書き込みの後に active になった記録が当たりに入る（新しいテストが落ちる）
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/post-write-replay.test.ts` → 書き込みの時点で配れなかった記録は当たらず、会話記録の差し込みで届いた記録は除かれ、差し込みが観測されていない会話は別に数え、判定が R・H・N・unknown の境界式どおり
  - コミット: `fix(eval): replay writes against records deliverable then and what reached the conversation`
  - 結果: red は直す前のコードで実測（2020 年の書き込みに、今保存した記録 trace:ext-s1/utc が当たる）。直した後 `node --import ./test/isolate-home.ts --test --test-timeout=120000 test/post-write-replay.test.ts` → 6 pass（結果の時点で配れない記録は当たらない、その呼び出し自身の pre_edit の差し込みで届いた記録を除く、compact の後は数え直す、失敗・プロジェクトの外・差し込みの未観測・不完全な差し込みの後の書き込みを別に数える、900 字に入る分だけ出る、標本は seed で固定、判定は R・H・N・unknown の境界式どおりで 20 組未満は決まらない）。ラベルの材料を出す `--sheet` は、その時点の権限、書いた本文と old_string、ターンを始めた持ち主のプロンプトを出す。`bun run verify` → exit 0
- [x] T21: M0' を作り直す（重複の無い母集団、呼び出しの列挙からの資格と窓、判定器の検査、ターンを一様に引く原因の内訳）
  - 種別: 修正
  - 計画: S1
  - 依存: T18（時点付きの資格が要る）, T19（会話記録の読み取りが要る）
  - 変更: `server/evals/post-write/shell-miss.ts`, `server/test/post-write-shell-miss.test.ts`, `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/post-write-shell-miss.test.ts` → 編集の後に作られた記録が取りこぼしに入る、missed の無いラベルを配った扱いにする（新しいテストが落ちる）
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/post-write-shell-miss.test.ts` → 資格の無い組・subagent の組・次のプロンプトの無い組が別に数えられ、窓が会話記録で閉じ、判定器が不正なラベルを拒み、原因の内訳がターンを一様に引く
  - コミット: `fix(eval): measure shell-change misses on records deliverable at the edit, from transcripts`
  - 結果: red は直す前のコードで実測（旧 decide に missed の無い 30 件を渡すと verdict が not adopted。旧 M0' の取りこぼし 20 組のうち 14 組が編集の後に active になった記録）。直した後 `node --import ./test/isolate-home.ts --test --test-timeout=120000 test/post-write-shell-miss.test.ts` → 3 pass（候補はターンと path ごと、tool の行がある path・finding・記録より前のターンは候補にしない、呼び出しの結果の時点で資格を決め最初に資格のある呼び出しを測る、別の記録の配信は数えない、subagent・差し込みの未観測・次のプロンプト無し・決着しないラベル・shell の編集でないは別に数える、失敗した呼び出しは拒む、判定器は疑いを両方向に数え 150 組で止まり番号の欠けを拒む、原因の内訳はターンを一様に引く）。資格の判定に使う `deliverableIds` を deliver.ts から出し、時点のテストで確かめた。`bun run verify` → exit 0
- [x] T25: 測る呼び出しを、ラベルの書き順ではなく結果の時刻の順で選ぶ（材料の出力はファイル名を含む呼び出しだけにする）
  - 種別: 修正
  - 計画: S1
  - 依存: T21（直す対象の M0' のスクリプト）
  - 変更: `server/evals/post-write/shell-miss.ts`, `server/test/post-write-shell-miss.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/post-write-shell-miss.test.ts` → ラベルが後の呼び出しを先に書くと、後の呼び出しの結果（no next prompt）が返る
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/post-write-shell-miss.test.ts` → 書き順によらず、最初に返った資格のある呼び出しが測られる
  - コミット: `fix(eval): measure the earliest eligible call whatever order a label lists`
  - 結果: red を直す前のコードで実測（`["b4", "b1"]` で no next prompt）。直した後 `node --import ./test/isolate-home.ts --test --test-timeout=120000 test/post-write-shell-miss.test.ts` → 3 pass。`bun run verify` → exit 0

- [x] T26: M0' の偏りを直す（T21 のレビューの F1・F3・F4・F5・F6）
  - 種別: 修正
  - 計画: S1
  - 依存: T21（直す対象の M0' のスクリプト）, T19（読めない行の位置を持たせる）
  - 変更: `server/evals/post-write/shell-miss.ts`, `server/evals/post-write/transcript.ts`, `server/test/post-write-shell-miss.test.ts`, `server/test/post-write-transcript.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/post-write-shell-miss.test.ts` → ターンの途中だけ配れた記録が母集団に無い、決まらない組で 30 組目を埋めて不採用にする、Read の呼び出しを受け取る、原因の内訳で記録の多いパスに偏る
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/post-write-shell-miss.test.ts test/post-write-transcript.test.ts` → ターン中の変化の時刻でも資格を見る、決まらない組は取りこぼし・届いた・数えないの全組み合わせで判定が一致するときだけ確定、shell でない呼び出しとターンの外の呼び出しを拒む、窓とターンの前の読めない行は unknown、原因の内訳はターン、次にパスを一様に引く
  - コミット: `fix(eval): keep mid-turn records, resolve doubt every way, and check labelled calls`
  - 結果: red は直す前のコードで実測（mid が母集団に無い、29 shown＋unresolved＋120 ineligible で not adopted、Read の呼び出しを拒まない、パスの選択が記録数に偏る）。F5 は F4 と同時に直したので、窓の中の読めない行の検査を一時的に外してテストが落ちることを確かめ、戻した。直した後 `node --import ./test/isolate-home.ts --test --test-timeout=120000 test/post-write-shell-miss.test.ts test/post-write-transcript.test.ts` → 6 pass。`bun run verify` → exit 0

- [x] T27: origin の無い user の行を、モデルが答えたときだけ「プロンプトかもしれない」とする
  - 種別: 修正
  - 計画: S1
  - 依存: T19（直す対象の会話記録の読み取り）
  - 変更: `server/evals/post-write/transcript.ts`, `server/test/post-write-transcript.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/post-write-transcript.test.ts` → ローカルのコマンド（/reload-plugins）、持ち主の `!` の shell、中断の印で、次の人間のプロンプトが unknown になる
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/post-write-transcript.test.ts` → 答えの無い origin の無い行はプロンプトにせず、モデルが答えた行（古い会話記録のプロンプト）は unknown のまま
  - コミット: `fix(eval): treat a line of no origin as a possible prompt only when the model answers it`
  - 結果: red を直す前のコードで実測（nextHuman が 8 ではなく unknown）。M0' の試算で決まらなかった 5 組は、すべてこの行が原因だった（/reload-plugins など）。直した後 `node --import ./test/isolate-home.ts --test --test-timeout=120000 test/post-write-transcript.test.ts test/post-write-shell-miss.test.ts` → 7 pass。`bun run verify` → exit 0

- [x] T28: 判定器と母集団の残りの偏りを直す（T25・T26 のレビューの F1〜F4）
  - 種別: 修正
  - 計画: S1
  - 依存: T26（直す対象の M0' のスクリプト）
  - 変更: `server/evals/post-write/shell-miss.ts`, `server/test/post-write-shell-miss.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/post-write-shell-miss.test.ts` → 配れた時刻と anchor のあった時刻が重ならない組が母集団に入る、疑い 9 組と取りこぼし 30 組で決まらないになる
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/post-write-shell-miss.test.ts` → 同じ時点で配れて anchor があった組だけが候補、疑いの解決を (測れた数, 取りこぼし数) の到達できる状態で全部たどり上限を置かない、報告の件数は疑いを数えない 1 つの読み方でそろう、結果の後の読めない行は unknown
  - コミット: `fix(eval): require deliverable and anchored at once, and resolve doubt exactly`
  - 結果: red を直す前のコードで実測（late が母集団に入る、9 unknown＋30 missed で undecided）。F1 は他と同時に直したので、結果の後の読めない行の検査を一時的に外してテストが落ちることを確かめ、戻した。F4 はレビューで Codex が再現した（drawn 150・apart {}）。直した後 `node --import ./test/isolate-home.ts --test --test-timeout=120000 test/post-write-shell-miss.test.ts` → 3 pass。`bun run verify` → exit 0

- [x] T29: 始まりがはっきりしないターンと、呼び出しの後の読めない行を unknown にする（T27・T28 のレビューの F1・F2）
  - 種別: 修正
  - 計画: S1
  - 依存: T28（直す対象の M0' のスクリプト）
  - 変更: `server/evals/post-write/shell-miss.ts`, `server/test/post-write-shell-miss.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/post-write-shell-miss.test.ts` → origin の無い行で始まるターンを not observed と確定する
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/post-write-shell-miss.test.ts` → 差し込みの後に origin の無い行で始まったかもしれないターンは unknown、呼び出しと結果の間の読めない行も次のプロンプトの候補として unknown
  - コミット: `fix(eval): keep turns of unclear start and lines after the call as unknown`
  - 結果: red を直す前のコードで実測（not observed）。F2 は F1 と同時に直したので、`call.n` を `result.n` に一時的に戻してテストが落ちることを確かめ、戻した。直した後 `node --import ./test/isolate-home.ts --test --test-timeout=120000 test/post-write-shell-miss.test.ts` → 3 pass。`bun run verify` → exit 0

- [ ] T22: M0' を測り直して #219 を判定し直す（Claude と Codex のラベル）
  - 種別: 追加
  - 計画: S1, S6
  - 依存: T21（作り直した M0' が要る）
  - 変更: `server/evals/post-write/m0-shell.json`
  - 完了条件: `node server/evals/post-write/shell-miss.ts --decide server/evals/post-write/m0-shell.json` → 保存した判定と同じ。ファイルにコミット・スナップショットの sha256・会話記録の hash・別に数えた件数・両者のラベルと決着が入っている。#219 へのコメントを出した
  - コミット: `test(eval): remeasure the shell-change misses for #219`
- [ ] T23: M0 を測り直して #213 を判定し直す（Claude と Codex のラベル）
  - 種別: 追加
  - 計画: S1, S2, S4
  - 依存: T20（作り直した M0 が要る）
  - 変更: `server/evals/post-write/m0.json`
  - 完了条件: `cat server/evals/post-write/m0.json` → コミット・スナップショットの sha256・会話記録の hash・集計・40 組の両者のラベルと決着・境界式での判定が入っている。#213 へのコメントを出した
  - コミット: `test(eval): remeasure the post_write entry check for #213`

- [x] T24: 時点の条件を 1 つずつ確かめるテストを足す（T18 のレビューの F1）
  - 種別: 修正
  - 計画: S1
  - 依存: T18（直す対象のテスト）
  - 変更: `server/test/deliver.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/deliver.test.ts` → anchor の added_at・衝突の link の added_at・採用の retracted_at の条件を 1 つずつ外したコードでも、T18 のテストは通ってしまう（Codex が再現）
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/deliver.test.ts` → 後で足した anchor・後で足した衝突・後で撤回した採用のそれぞれで、時点ごとの名指しが変わる
  - コミット: `test(deliver): check each as-of condition on its own`
  - 結果: 足したテストは今のコードで pass。3 つの条件をそれぞれ一時的に外すと、どれでも新しいテストが落ちた（外した後は `git checkout` で戻し、差分なしを確かめた）。`bun run verify` → exit 0

## P2: 今のバンドルでの基準

今の配信では記録が届かない評価タスクと、post_write の hook を流せる runner を用意し、作る前に基準値と揺れを測る。

- [-] T06: M1 の評価タスクと fixture（今の配信経路で届かない記録、docs/ に書く違反のタスク 3 つ、should_not_block と should_stay_quiet、隠しテスト）
  - 種別: 追加
  - 計画: S2
  - 依存: T03（M0 で作らないと決まれば M1 も要らない）
  - 変更: `server/evals/cloud/tasks.json`, `server/evals/acceptance/world.json`, `server/test/eval-fixture.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/eval-fixture.test.ts` → 新しいタスクの記録が、プロンプトの照合・pre_edit・pre_read・session_start のどれでも配られない（deliver() を直接呼んで確かめる）
  - コミット: `test(eval): add tasks whose records no current delivery path reaches`
- [-] T07: runner の PostToolUse 配信の対応、配信の結果の reason・時刻・tool_use_id、書き込みの本文の記録
  - 種別: 追加
  - 計画: S2
  - 依存: なし
  - 変更: `server/evals/cloud/build-lib.ts`, `server/evals/cloud/build.ts`, `server/evals/cloud/claude-run.ts`, `server/evals/cloud/codex-run.ts`, `server/evals/cloud/collect.ts`, `server/test/eval-build.test.ts`, `server/test/eval-claude.test.ts`, `server/test/eval-codex.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/eval-build.test.ts test/eval-claude.test.ts test/eval-codex.test.ts` → hooks.json / codex.json に PostToolUse の配信の entry があるときだけ inject に PostToolUse の hook が入り、matcher が manifest に残る。無いとき（main のバンドル）の設定は今と同じ
  - コミット: `feat(eval): wire the shipped post-tool delivery hook into inject runs`
- [-] T08: 流す前の確認（docs/ の既知の違反が両ホストで違反と採点される、compare が既知の結果で期待どおり）
  - 種別: 追加
  - 計画: S2
  - 依存: T06（タスクが要る）, T07（runner が要る）
  - 変更: `server/test/eval-grade.test.ts`, `server/evals/cloud/report.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/eval-grade.test.ts` → 良くなる・悪くなる・同じの既知の grades で compare がそのとおりに出る。両ホストの docs/ の違反の文書が patch に入り implements_rejected=yes と採点される（1 run ずつの実走の結果を結果行に残す）
  - コミット: `test(eval): check grading of plan documents and the compare on known results`
- [-] T09: main のバンドルで baseline と A/A（モデル別 k=5 × 2）を流し、測れるモデルと M1 の k・改善幅を決める
  - 種別: 追加
  - 計画: S2
  - 依存: T08（流す前の確認が要る）
  - 変更: `server/evals/post-write/m1.json`
  - 完了条件: `cat server/evals/post-write/m1.json` → バンドルの hash、モデル別の違反の run 数（2 組）、測れるかの判定、決めた k と改善幅が入っている。両モデルとも測れなければ打ち切りを plan の変更履歴に書いた
  - コミット: `test(eval): record the post_write baseline and fix the main run`

## P3: post_write の実装

M0 と M1a を通ったときだけ、書いた直後の配信を両ホストに入れる。

- [-] T10: deliver.ts の post_write（本文の取り出し、照合、emitted の除外、予算と上限、lockedPlan、文面、`pre_edit`＋`reason='post_write'` での記録）
  - 種別: 追加
  - 計画: S3
  - 依存: T01（照合の関数が要る）, T09（M1a で打ち切りなら作らない）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`, `server/test/deliver-codex.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/deliver.test.ts test/deliver-codex.test.ts` → 候補 6 件以上、先頭だけ配信済み、ログの失敗、compact の後、別の agent、NotebookEdit の delete、複数ファイルの patch、old_string だけに出る名前で、配る記録と記録した行が期待どおり
  - コミット: `feat(deliver): deliver records that a write names, right after the write`
- [-] T11: 両ホストの hook の登録と、scale の計測への post_write の追加
  - 種別: 追加
  - 計画: S3
  - 依存: T10（配信の処理が要る）
  - 変更: `plugin/hooks/hooks.json`, `plugin/hooks/codex.json`, `server/test/plugin.test.ts`, `server/evals/scale/run.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/plugin.test.ts` → Claude Code の同期の PostToolUse（`Edit|Write|MultiEdit|NotebookEdit`）と Codex の `^apply_patch$` の配信の entry があり、Windows の形も既存と同じ。`node evals/scale/run.ts` → post_write の行が出る
  - コミット: `feat(plugin): register the post-write delivery hook on both hosts`

## P4: 本測定と採否

- [-] T12: M1 の本測定（main と作業ブランチのバンドルの比較）と #213 の採否
  - 種別: 追加
  - 計画: S4
  - 依存: T11（作業ブランチのバンドルが要る）
  - 変更: `server/evals/post-write/m1.json`
  - 完了条件: `cat server/evals/post-write/m1.json` → モデル別の最終の違反・完了・不要な停止・誤配の old と new、途中の違反（報告だけ）、採否が入っている。#213 へのコメントの文面を持ち主に見せた
  - コミット: `test(eval): record the post_write measurement and the decision on #213`

## P5: 出荷か撤去

- [-] T13: 採用したとき: revision 13（delivery.event に post_write、移行、旧 revision の fixture、型の生成）と、記録する event の切り替え
  - 種別: 変更
  - 計画: S5
  - 依存: T12（採用のときだけ）
  - 変更: `db/schema.sql`, `db/migrations`, `server/src/sqlite.ts`, `server/src/db-types.ts`, `server/src/deliver.ts`, `server/test/migrate.test.ts`, `server/test/schema.test.ts`, `server/test/deliver.test.ts`
  - 完了条件: `bun run verify` → 0 で終わる。`cd server && node --import ./test/isolate-home.ts --test test/migrate.test.ts` → revision 12 の DB の `reason='post_write'` の行が `event='post_write'` に移り、delivery と delivery_unit と採番が保たれる
  - コミット: `feat(schema): log post-write deliveries as their own event (revision 13)`
- [-] T14: 採用したとき: バージョンの同期と出荷の準備
  - 種別: 変更
  - 計画: S5
  - 依存: T13（出荷する schema が要る）
  - 変更: `plugin/package.json`, `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`
  - 完了条件: `bun run release:plan -- --base <前の release のコミット>` → `plugin`、npm と 3 つの plugin manifest が同じバージョン
  - コミット: `chore(release): bump to <version>`
- [ ] T15: 採用しないとき: post_write の実装と hook を外す（照合の切り出しと評価の仕組み・結果は残す）
  - 種別: 削除
  - 計画: S5
  - 依存: T12（不採用のときだけ）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`, `server/test/deliver-codex.test.ts`, `plugin/hooks/hooks.json`, `plugin/hooks/codex.json`, `server/test/plugin.test.ts`, `server/evals/scale/run.ts`
  - 完了条件: `git diff main -- plugin/hooks db/schema.sql` → 空。`bun run verify` → 0 で終わる
  - コミット: `revert(deliver): drop post_write after the measurement`

## 記録
- 2026-10-09 / T01 / pre-commit のバージョンの検査が、package の入力（deliver.ts）を変えるコミットにバージョンの同期を求めた / T01 のコミットで npm と 3 つの plugin manifest を 0.6.44 に上げた。不採用で出荷しないときの扱いは T15 で決める
- 2026-10-09 / T02 / Codex のセッションの記録は sphica で 489 件あるが、対話のものは 1 件で、apply_patch の書き込みは 0 件（残りは codex exec のレビューと計画の議論）。再生できる過去の書き込みは Claude Code だけ / replay.ts は Claude Code の会話記録だけを読む形にし、変更欄の「apply_patch」を外した。M0 の結果は Claude Code だけの数字として書く
- 2026-10-09 / T02 / 何で当たったか（symbol・path・option）を文字列から推すのはもろい / namedRecords が hit を返すようにした（変更欄に `server/src/deliver.ts` を足した）
- 2026-10-09 / T16 / 実データで再生すると、消えた worktree の書き込み 153 件が outside に数えられていた / 修正タスク T16 を足した
- 2026-10-09 / T02 のレビュー / F1（P1、書き込みの時刻が tool_use の時刻で、同じ呼び出しの pre_edit を除けない）・F2（900 字の上限が無い）・F4（時刻の文字列比較）・F5（JSON として読めるが中身の無い行で止まる）は採用して T17 で直した。F3（消えた worktree）は T16 で直し済み
- 2026-10-10 / T06, T07, T08, T09, T10, T11, T12, T13, T14 / M0 が基準に届かず post_write を作らない / M1a・M1・実装・出荷のタスクを取りやめた。T15（不採用時の扱い）は T01 の切り出しとバージョンをどうするかを持ち主に聞いてから
- 2026-10-10 / T03 / 持ち主の指示でラベルを Claude と Codex が付けた / 完了条件の「持ち主のラベル」を「標本とラベル」に読み替え、件名の owner's を外した
- 2026-10-10 / T03 / S2（M1a）と S4（採否の記録）を担うタスクが取りやめで無くなった / plan の S2・S4 を M0 での打ち切りの形に直し、T03 の計画欄を S1 から S1, S2, S4 にした（T03 で採否を決めたため）
- 2026-10-10 / T18 / M0' の取りこぼし 20 組のうち 14 組が編集の後に作られた記録で、M0 も今の記録を過去の書き込みに当てていた / 時点付きの配信条件を T18 で足した。M0 と M0' の測り直しは Codex との合意（plan の変更履歴）に沿ってタスクを足す
- 2026-10-10 / T19〜T23 / M0 と M0' の作り直しと測り直しを plan の変更履歴（Codex と合意）に沿って足した。T03 と T05 の判定は T23 と T22 で置き換える

- 2026-10-10 / T18 のレビュー / F1（各時点の条件を個別に確かめるテストが無い）は採用して T24 で直した
- 2026-10-10 / T21 / 資格の判定に時点付きの deliverable の結果が要った / `deliverableIds` を deliver.ts から出し、変更欄に deliver.ts と deliver.test.ts を足した
- 2026-10-10 / T25 / ラベル付けの途中で、測る呼び出しをラベルの書き順で選んでいたと気付いた。材料の出力も大きすぎた / 修正タスク T25 を足した
- 2026-10-10 / T21 のレビュー / F1・F3・F4・F5・F6 は採用して T26 で直した。F2（呼び出しの選ぶ順）は T25 で直し済み
- 2026-10-10 / T27 / Claude のラベルで試算すると決まらない組が 5 組あり、どれも次のプロンプトの前の origin の無い行（ローカルのコマンドなど）が原因だった / 修正タスク T27 を足した
- 2026-10-10 / T25・T26 のレビュー / F1〜F4 は採用して T28 で直した。8 組の上限は列挙をやめて状態をたどる形にしたので無くした
- 2026-10-10 / T27・T28 のレビュー / F1・F2 は採用して T29 で直した
