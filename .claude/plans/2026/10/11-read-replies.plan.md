---
kind: plan
status: approved
codex_session: 01a12969-bb7b-7b43-9239-0f70cf2c4703
codex_rounds: 3
approved_at: 2026-10-11
---

# git の worker が断った理由を伝え、読み取りサーバーの返答を 32 KiB に収める（#323、#303）

## 要点

- git の worker が置き場を断ったとき、レビューの返答・`read` の rename の注記・`sphica doctor` が本当の理由を言う。「時間切れか大きすぎる」は、その 2 つのときにだけ言う（#323）
- 読み取りの MCP サーバーのツール呼び出しの返答を、エラーの返答も含めて 32 KiB に収める。対象は `search`（`sources` を含む）・`review_check`・`export`・`fields`・`asked` と、SDK が作るエラーの返答。止めた返答は、止めたことと続きの読み方を言う（#303）
- `export` は「全文か、拒否か」のまま上限を 60 KiB から 32 KiB に下げる。今 32〜60 KiB の文書を書けている利用者は、これからは「減らして」と言われる
- `fields` に任意の入力 `after` を足す（ページ送り）
- 1 つの PR、リリース 0.6.49（npm と 3 つの manifest）
- record サーバーの返答（`record_context`・`record_check`・`record_save`・`forget_preview`・`forget_apply`・`glean_fetch`）にも同じ種類の超過があるが、この PR には入れない。書き込みと確認の経路に触れる新しい契約（cursor、確認の必須領域）が要るので、issue #324 に要件を写し、0.6.49 の直後に別の計画にする（持ち主の Go、2026-10-11）
- 変えないもの: DB の schema、記録の書き込み、配信の選び方、`review_check` の入力の契約、CLI のコマンドの数、`read`・`overview`・`review_select` の今の切り方

## 持ち主の決定

- 「引き続きやり残しをしっかり片付けていきたい。1つのPRにまとめられるものはどんどんまとめて一気に進めて欲しい。今はちまちま1個ずつ片付けているので時間かかりすぎてる」（2026-10-11）
- #323 は issue にして直す（2026-10-11）
- 「妥協は無し。何かあれば根本的にやること」（2026-10-09）
- 利用者にも持ち主にも、API キーや追加の課金を求めない。CLI は init / doctor / uninstall だけ
- epic #200 の方針: 欠陥は、今のコードで落ちるテストを付けて直す。パッケージに入る変更は npm と 3 つの manifest を同じバージョンへ上げる
- #303 の「直すときに守ること」: 記録は DB に丸ごと残り `read` で読める / 途中で止める返答は、止めたことと続きの読み方を言い、記録を黙って落とさない / `review_check` の契約は変えない（`findings.unit` は完全なキー、バッチの全記録に finding が 1 つ）
- 明示的に切った長い発言は「見た」扱いにする（Sphica の記録 u90）。record 側の次の計画の前提

## 目的

- HOME が一時ディレクトリの下にある環境、または作業ツリーが HOME の `.sphica/git` と重なる環境で、レビューの返答と `sphica doctor` が、何が重なっているかを言う
- 読み取りサーバーのどのツールを、どんな入力で呼んでも、返答の text が UTF-8 で 32 KiB 以内に収まり、Codex が返答の真ん中を黙って落とす大きさにならない
- 止めた返答から、そこに書かれた呼び方だけで、省略された記録・発言・定義に到達できる

## 対象外

- record サーバーの返答。次の計画の要件として issue に写す: 末尾の情報が複数ページになるときの cursor、原文の offset と「見せた」の記録の整合、run に結び付く検査・保存の結果の続き、forget の確認の必須領域、`glean_fetch` の一覧の続き、record サーバーの SDK のエラー返答、状態と確認の統合テストと Skill の更新
- `export` を分割して返すこと（「返答の残りをそのまま 1 つのファイルに書く」契約が壊れ、つなぎ損ねた文書が正しい文書に見える）
- `asked` のページ送り（質問への答えで、一覧を全部めくる用途ではない。省略分は `read` で読める）
- CLI の出力の上限（MCP の返答ではない）
- shell の後の配信（`snapshot`）の挙動

## 前提

- worker は `isolatedHome()` が断ると `{ok:false,error:"<HOME>/.sphica/git overlaps <temp>, which an agent can write"}` を返す（HOME を一時ディレクトリの下に置いて実測、2026-10-11）。断る条件は 5 つ: hooks のフォルダが空でない、iso が通常のディレクトリでない、HOME の外へ出る、作業ツリーと重なる、一時ディレクトリと重なる（`server/src/git-worker.ts:56-71`。作業ツリーと重なる場合は未再現）
- `inIsolation`（`server/src/git.ts:344`）は失敗を全部 `null` にする。呼ぶ側は `worktreeDiff` → `localChange`（`server/src/review-bridge.ts:84`）、`worktreeStatus` → `snapshot`（`server/src/worktree.ts:33`）、`renamesSince`（`server/src/read.ts:464`）
- `READ_BUDGET` は 32 KiB（`server/src/read.ts:478`）。Codex 0.160.0 はツールの出力が約 40,000 バイトを超えると真ん中を黙って落とす（#289）
- Codex が表示関数とインメモリの MCP 接続で測った超過（2026-10-11、DB は通していない）: `review_check` は約 1 KB のキー 50 件の未判定行で 53,902 B、`asked` は 37,160 B、`search` の `sources: true` は 47,760 B、SDK のエラー返答は未知のプロパティ名 40 KB で 40,097 B・未知のツール名 40 KB で 40,033 B（ツール本体は呼ばれない）
- 叩き台の量（キー 200・本文 600・理由 400・revisit 200・option 8 個）だと `search` の 1 件は 4,157 B で、20 件中 7 件しか収まらない（Codex の試算）。`read` は 1 回 10 参照まで（`server/src/mcp.ts:237`）
- `head(s, n)` の n は UTF-8 のバイト数（`server/src/text.ts:162`）
- SDK 1.31.0 は、検証エラーと handler のエラーを `isError` の結果に変えて `transport.send` に渡す。`send` を包むと、成功の結果・通知・`tools/list` を通したままエラーの返答だけを収められる（Codex がインメモリで実測）
- `fields` Skill は今 1 回だけ呼んで表を見せる（`plugin/skills/fields/SKILL.md:22`）。`export` Skill は全文を 1 ファイルに書き、追記を禁じる（`plugin/skills/export/SKILL.md:40,46`）
- pre-commit の hook は、パッケージに入るファイルを変える最初のコミットでバージョンが上がっていないと拒否する。`release:plan` はコミット済みの履歴だけを見る
- 未検証: MCP サーバーと DB を通した超過の再現（タスクの red で確かめる）

## 方針

### A. worker の断りの理由（#323）

1. worker の返答を `{ok:true,out}` / `{ok:false,refused:<コード>}` / `{ok:false,error}` にする。コードは `hooks_not_empty`・`not_plain_dir`・`outside_home`・`overlaps_worktree`・`overlaps_tmp`。通常の I/O エラーは `error` で、断りと混ぜない
2. `inIsolation` は成功のほかに `refused`（コード付き）・`timeout`・`too_large`・`failed` を区別して返す。`worktreeDiff`・`worktreeStatus`・`renamesSince` は同じ区別を上へ運ぶ
3. コードから説明文を作る関数を 1 つ置き、`localChange` と doctor が使う。絶対パスは出さず、「your home directory」「the temp directory」「this work tree」と書く
4. `localChange`: `refused` は「Sphica's git worker would not start: <説明>. Run sphica doctor in this work tree.」、`timeout` と `too_large` は今の文、`failed` は「the change could not be read (git failed)」。`listFiles` の例外も同じ区別
5. `read` の rename の注記: 断られたとき「; rename not checked (<短い固定の理由>; run sphica doctor in this work tree)」。`snapshot` は成功以外を今までどおり `null`
6. worker に「置き場だけを確かめる」操作を足す（`isolatedHome` を呼び、作った iso を片付けて結果を返す。`prepare` と git は動かさない）。doctor は cwd を含む作業ツリーの root でそれを締め切り付きで呼び、「git worker: ready」/「git worker: refused, <説明>」/「git worker: failed」を出す。git の外では行を出さない

### B. 読み取りサーバーの返答（#303）

1. 共有するのは、バイトの計算と「部品を順に足し、枠と末尾の案内を含めて `READ_BUDGET` を超える手前で止める」処理だけ。先に確保する情報と続きの読み方は、ツールごとに持つ。`read.ts`・`review.ts`・`overview.ts` の今の切り方は触らない。数字はプレビューの量で、単位は UTF-8 のバイト
2. `search`（通常と `sources: true`）: 1 件ごとに、キーは 200、option は先頭 8 個（本文 160・理由 160）、anchor は先頭 8 個。切ったキーは表示専用で、`read` には `u<id>` / `s<id>` を示す。全体を予算で止めたら、省略した全件の参照を 10 件ずつの組にして「read these: … / then these: …」と言う（最大 20 件なので cursor は足さない）。組の案内の領域は先に確保する
3. `review_check`: 返答の先頭に、バッチの全記録の状況を `u<id>` で必ず出す（「u12 1 finding / u15 no finding / u18 2 findings」。バッチ全体の成否とは別の行）。問題文は `findings.<i>` と evidence の番号を残し、キーの表示は `inline(head(…, 200))`。問題の列は予算で止めて「and N more problems; fix these and check again」。照合は完全なキーで行い、各記録に finding がちょうど 1 件の検査は変えない。入力の検証エラーの文面も収める
4. `export`: 成功は `exportReply` 全体のバイト数で判定し、`READ_BUDGET` を超えたら「Nothing was exported」。拒否の返答（参照のエラーの列、長いキー）も収める。1 件と置換の履歴だけで超える場合は「choosing fewer does not help; read it with read」
5. `fields`: 入力に任意の `after`（定義の id）を足し、id 順のページにする。止めたら「call fields with after: <id>」
6. `asked`: キーは 200。repeats のセッション一覧・注意書き・省略の案内も含めて全体を収める。省略したメッセージは `s<id>`、記録は `u<id>` を 10 件ずつの組で示し、「the messages and records can be read with read」とだけ書く（紐付きの一覧を再現できるとは書かない）
7. SDK のエラー返答: `server/src/mcp.ts` の `connect` の直前で transport の `send` を包む。JSON-RPC の result が `isError: true` で `content` を持つときだけ、text の合計を案内込みで収める。id・`isError`・ほかのフィールド・`send` の options は保ち、成功の結果・通知・`tools/list` は通す。SDK のファイルは編集しない。成功の返答はここでは切らず、各ツールが完成させる

### C. 文書とリリース

1. `mcp.ts` の description、`plugin/skills/fields/SKILL.md`（全ページを読む手順）、`plugin/skills/export/SKILL.md`（拒否と上限）、README と README.ja.md を合わせる。保証は「読み取りサーバーのツール呼び出しの text 返答」と書く
2. 変更を stage した状態で `release:plan` を見てから、最初のパッケージ変更のコミットで 0.6.49 に上げる。リリースノートに、`export` の上限の変更と `fields` の `after` を書く

### テスト

- どれも、直す前のコードで落ちることを先に確かめる
- A: HOME を一時ディレクトリの下に置いた子プロセスで、レビューの 2 つの hook の返答と doctor の行。cwd がサブディレクトリ、HOME が作業ツリーの root、hooks が空でない、通常の成功、`snapshot` の従来の挙動、rename の注記、`timeout` と `too_large` の文が変わらないこと
- B: MCP サーバーを通して `content.text` のバイト数を測る。総量・残りの数に加えて、共通の接頭辞のキー、UTF-8 の境界、最初の部品が収まらない場合、予算ちょうど手前、成功・拒否・不正な入力、`fields` の次ページへの進み方、`search` で 11 件以上を省略したときに全参照が案内に載ること、`review_check` で長いキー 50 個でも全記録の状況が返答から分かること、未知のツール名と未知のプロパティ名 40 KB のエラー返答

## 採った案と棄却した案

- 採用: #323 と #303 を 1 つの PR。棄却: 別々の PR（持ち主の決定）
- 採用: record サーバーは次の計画。棄却: 同じ PR に入れる（cursor と確認の必須領域という新しい契約が 5 点決まっておらず、書き込みの経路に触れる。合意を待つと 2 件の修正も止まる）
- 採用: worker は固定のコードを返し、説明文は呼ぶ側で作る。棄却: 例外の文をそのまま運ぶ（絶対パスが先頭に来て、切ると肝心の理由が消える）
- 採用: 失敗を `refused`・`timeout`・`too_large`・`failed` に分ける。棄却: 断り以外を `null` にまとめる（worker の起動失敗や git のエラーが「時間切れか大きすぎる」のままになる）
- 採用: doctor に「置き場だけを確かめる」専用の操作。棄却: doctor が `isolatedHome` を直接呼ぶ（同期の I/O を締め切りで止められない）。棄却: status を流す（置き場以外の git の処理まで試してしまう）
- 採用: `export` は全文か拒否のまま、上限を下げる。棄却: 分割して返す。棄却: ホストごとに上限を変える（ホストを見分ける確かな方法が無い）
- 採用: `fields` に `after`。棄却: 入力を増やさず名前だけを末尾に並べる（残りの定義を取得できない）
- 採用: `review_check` は全記録の状況を `u<id>` で先に確保。棄却: 完全なキーの未判定行を先に全部出す（50 件で 53,902 B になり、収まらない）
- 採用: `search` の省略は全参照を 10 件ずつの組で示す。棄却: 10 件を超えた分は数だけ言う（一部の記録の読み方が消える）。棄却: 「search again with fewer words」（語を減らしても絞り込みにならない）
- 採用: エラー返答は transport の `send` を包んで収める。棄却: request handler を置き換える（SDK の検証と振り分けを引き受けることになる）
- 採用: 予算の計算だけを共有する。棄却: 5 つの返答を 1 つの切り方にまとめる（続きの読み方と、落としてはいけない情報がツールごとに違う）

## 手順

- S1: worker の返答とコード、`inIsolation` の 4 つの区別、説明文の関数
- S2: `localChange`・rename の注記・`listFiles` が区別を使う
- S3: worker の「置き場だけを確かめる」操作と、doctor の行
- S4: 予算の計算を共有する関数
- S5: `search`（通常と sources）
- S6: `review_check`
- S7: `export`
- S8: `fields` の `after`
- S9: `asked`
- S10: SDK のエラー返答（`send` を包む）
- S11: description・Skill・README
- S12: バージョン 0.6.49（最初のパッケージ変更のコミットで）

## 完了条件

A5 以降は、持ち主の `npm-release` の承認が要る。A4 の展開先はリポジトリの外。

- A1: `bun run verify` → 終了コード 0
- A2: `bun run release:plan -- --base v0.6.48` → `plugin`、npm と 3 つの manifest が 0.6.49
- A3: `node --import ./test/isolate-home.ts --test test/plugin.test.ts test/git-worker.test.ts test/cli.test.ts` → 足したテストが全部 pass（各テストは、直す前のコードで落ちたことをタスクの結果に残す）
- A4: `npm pack` → リポジトリの外で展開して起動し、`sphica doctor` に「git worker: ready」が出て、読み取りの MCP の `search` と、レビューの hook がそれぞれ答える
- A5: `gh pr checks <PR>` → 最終の head で全項目 pass、未解決のスレッド 0、Codex の全差分レビューの指摘に対応済み
- A6: `gh run watch <release run>` → release の workflow が完了し、`npm view sphica version` が 0.6.49
- A7: `bun run release:status` → 手元の CLI と両ホストのプラグインが 0.6.49 でそろう

## リスク

- `export` の上限を下げると、今は書けている文書が拒否される → リリースノートに書き、拒否の文に「choose fewer decisions」と、単独で超える場合の読み方を出す
- `send` を包む処理が SDK の更新で効かなくなる → エラー返答のバイト数を MCP 経由のテストで測っているので、効かなくなれば落ちる
- 切る数字（8 個、200、160）で、検索結果が見づらくなる → 省略は必ず数と読み方を言う。実際に使って不便なら数字だけを変える
- どちらかの修正が遅れる → 黙って切り離さず、範囲の変更として持ち主に戻す
- record サーバーの超過が残る → issue に要件を写し、0.6.49 の直後に計画する。README には読み取りサーバーの保証だけを書く

## 未解決

なし

## 変更履歴
