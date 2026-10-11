---
kind: tasks
plan: 11-read-replies.plan.md
branch: fix/read-replies
base: main
---

# git の worker が断った理由を伝え、読み取りサーバーの返答を 32 KiB に収める（#323、#303） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: worker が断った理由を伝える（#323）

レビューの返答・rename の注記・`sphica doctor` が、git の worker が置き場を断った理由を言うようになる。

- [x] T01: worker の断りをコードで返し、レビューの返答と rename の注記がその理由を言う。バージョンを 0.6.49 に上げる
  - 種別: 修正
  - 計画: S1, S2, S12
  - 依存: なし
  - 変更: `server/src/git-worker.ts`, `server/src/git.ts`, `server/src/review-bridge.ts`, `server/src/read.ts`, `server/test/git-worker.test.ts`, `server/test/git-safety.test.ts`, `server/test/review-bridge.test.ts`, `server/test/record.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - red: `node --import ./test/isolate-home.ts --test test/review-bridge.test.ts` → HOME を一時ディレクトリの下に置いた場合の新しいテストが、直す前は「in time, or is too large」を受け取って落ちる
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(review): say why the git worker would not start, and bump to 0.6.49`
  - 結果: `node --import ./test/isolate-home.ts --test test/review-bridge.test.ts` → 直す前のコード（`server/src` を stash）では足した 2 件が失敗（どちらも「in time, or is too large」を受け取る）、直した後は pass
  - 結果: `bun run verify` → 終了コード 0
  - 結果: `node --import ./test/isolate-home.ts --test test/git-worker.test.ts test/review-bridge.test.ts` → 28 件 pass

- [x] T02: worker に置き場だけを確かめる操作を足し、`sphica doctor` がその結果を 1 行で出す
  - 種別: 追加
  - 計画: S3
  - 依存: T01（断りのコードと説明文の関数が要る）
  - 変更: `server/src/git-worker.ts`, `server/src/git.ts`, `server/src/cli.ts`, `server/test/git-worker.test.ts`, `server/test/cli.test.ts`
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `feat(doctor): report whether the git worker can use its directory`
  - 結果: `bun run verify` → 終了コード 0
  - 結果: `node --import ./test/isolate-home.ts --test test/cli.test.ts test/git-worker.test.ts` → 28 件 pass
  - 結果: `node plugin/dist/cli.js doctor` → HOME が一時ディレクトリの外なら「✓ Git worker ready」、中なら「△ Git worker would not start: … overlaps the temp directory …」、git の外では行が出ない。どの場合も `.sphica/git` には `hooks` だけが残る

- [x] T10: リンク先の無いリンクを、git の失敗ではなく「リンクである」という断りとして返す
  - 種別: 修正
  - 計画: S1
  - 依存: T01（断りのコードが要る）
  - 変更: `server/src/git-worker.ts`, `server/test/git-worker.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/git-worker.test.ts` → `.sphica` をリンク先の無いリンクにすると、直す前の `ownDir` は `EEXIST` を投げ、断りにならない
  - 完了条件: `node --import ./test/isolate-home.ts --test test/git-worker.test.ts` → 全件 pass
  - コミット: `feat(doctor): report whether the git worker can use its directory`
  - 結果: `node --import ./test/isolate-home.ts --test test/git-worker.test.ts` → 直す前の `ownDir` に戻すと `Error: EEXIST: file already exists, mkdir …/.sphica` で 1 件 fail、直した後は pass

## P2: 読み取りサーバーの返答を 32 KiB に収める（#303）

`search`・`review_check`・`export`・`fields`・`asked` と、SDK が作るエラーの返答が、どんな入力でも 32 KiB に収まり、止めたときは続きの読み方を言う。

- [x] T03: 予算の計算を共有する関数を置き、`search`（通常と sources）の返答を収める
  - 種別: 修正
  - 計画: S4, S5
  - 依存: T01（バージョンが上がっていないと、パッケージに入るファイルのコミットが拒否される）
  - 変更: `server/src/read.ts`, `server/src/search.ts`, `server/src/mcp.ts`, `server/test/plugin.test.ts`, `server/test/search.test.ts`, `server/test/deliver.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/plugin.test.ts` → 長い option を持つ記録と、長い artifact の発言 20 件で、`search` の返答が 32 KiB を超えて落ちる
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(search): keep search replies within the reply budget`
  - 結果: `node --import ./test/isolate-home.ts --test test/plugin.test.ts` → 直す前のコード（`server/src` を stash）では、足した search のテストが「search: 429308 bytes」で失敗。直した後は pass
  - 結果: `bun run verify` → 終了コード 0

- [x] T11: doctor が、リンク先の無い `.sphica` も Sphica のものとして git worker を確かめる
  - 種別: 修正
  - 計画: S3
  - 依存: T02（直す対象の doctor の行が要る）
  - 変更: `server/src/cli.ts`, `server/test/cli.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/cli.test.ts` → `.sphica` をリンク先の無いリンクにすると、直す前は Git worker の行が出ずにテストが落ちる
  - 完了条件: `node --import ./test/isolate-home.ts --test test/cli.test.ts` → 全件 pass
  - コミット: `fix(search): keep search replies within the reply budget`
  - 結果: `node --import ./test/isolate-home.ts --test test/cli.test.ts` → `existsSync` に戻すと足したケースが失敗、`lstat` で見る形では pass

- [x] T04: `review_check` の返答を収め、バッチの全記録の状況を先頭に必ず出す
  - 種別: 修正
  - 計画: S6
  - 依存: T03（予算の計算の関数が要る）
  - 変更: `server/src/review-findings.ts`, `server/src/mcp.ts`, `server/test/plugin.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/plugin.test.ts` → 約 1 KB のキー 50 件の未判定で、`review_check` の返答が 32 KiB を超えて落ちる
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(review): keep review_check replies within the reply budget`
  - 結果: `node --import ./test/isolate-home.ts --test test/plugin.test.ts` → 直す前の `review-findings.ts` では「review_check: 54462 bytes」で失敗、直した後は pass
  - 結果: `bun run verify` → 終了コード 0

- [x] T05: `export` を、返答全体が 32 KiB に収まるときだけ成功にし、拒否の返答も収める
  - 種別: 修正
  - 計画: S7
  - 依存: T03（予算の計算の関数が要る）
  - 変更: `server/src/export.ts`, `server/src/mcp.ts`, `server/test/plugin.test.ts`, `server/test/export.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/plugin.test.ts` → 40 KiB の文書になる選び方で、`export` の返答が 32 KiB を超えて落ちる
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(export): refuse a document the reply budget cannot carry whole`
  - 結果: `node --import ./test/isolate-home.ts --test test/plugin.test.ts` → 直す前の `export.ts` では「export: 44274 bytes」で失敗、直した後は pass
  - 結果: `bun run verify` → 終了コード 0

- [x] T06: `fields` に `after` を足し、ページで返す
  - 種別: 修正
  - 計画: S8
  - 依存: T03（予算の計算の関数が要る）
  - 変更: `server/src/fields.ts`, `server/src/mcp.ts`, `server/test/plugin.test.ts`, `server/test/fields.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/plugin.test.ts` → 定義を多数持つプロジェクトで、`fields` の返答が 32 KiB を超えて落ちる
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(fields): page the fields table within the reply budget`
  - 結果: `node --import ./test/isolate-home.ts --test test/plugin.test.ts` → 直す前の `fields.ts` と `mcp.ts` では「fields: 60006 bytes」で失敗、直した後は pass（60 件が複数ページに分かれ、全ページで 60 件そろう）
  - 結果: `bun run verify` → 終了コード 0

- [x] T07: `asked` の返答を、セッションの一覧と案内も含めて収める
  - 種別: 修正
  - 計画: S9
  - 依存: T03（予算の計算の関数が要る）
  - 変更: `server/src/asked.ts`, `server/src/mcp.ts`, `server/test/plugin.test.ts`, `server/test/asked.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/plugin.test.ts` → 繰り返しのセッションが多い質問で、`asked` の返答が 32 KiB を超えて落ちる
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(asked): keep asked replies within the reply budget`
  - 結果: `node --import ./test/isolate-home.ts --test test/plugin.test.ts` → 直す前の `asked.ts` と `mcp.ts` では「search: 43521 bytes」で失敗、直した後は pass
  - 結果: `bun run verify` → 終了コード 0

- [x] T08: SDK が作るエラーの返答を、transport の `send` を包んで収める
  - 種別: 修正
  - 計画: S10
  - 依存: T03（予算の計算の関数が要る）
  - 変更: `server/src/mcp.ts`, `server/test/plugin.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/plugin.test.ts` → 未知のツール名 40 KB と、未知のプロパティ名 40 KB の呼び出しで、エラーの返答が 32 KiB を超えて落ちる
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(mcp): keep the read server's error replies within the reply budget`
  - 結果: `node --import ./test/isolate-home.ts --test test/plugin.test.ts` → 直す前の `mcp.ts` では、40 KB のツール名のエラー返答が 32 KiB を超えて失敗、直した後は pass
  - 結果: `bun run verify` → 終了コード 0

## P3: 文書を合わせる

ツールの説明、Skill、README が、新しい返答の形と読み方を言う。

- [x] T09: description・`fields` と `export` の Skill・README を新しい返答に合わせる
  - 種別: 変更
  - 計画: S11
  - 依存: T05（`export` の上限が決まっている）, T06（`fields` の `after` がある）
  - 変更: `server/src/mcp.ts`, `plugin/skills/fields/SKILL.md`, `plugin/skills/export/SKILL.md`, `README.md`, `README.ja.md`
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `docs(read): describe the reply budget, fields paging, and the export limit`
  - 結果: `bun run check` → 終了コード 0
  - 結果: `bun run verify` → 終了コード 0

- [x] T12: 検索結果の表示を、切る前に無害化し、切ったら印を付け、Sphica 自身の案内を枠の外に出す
  - 種別: 修正
  - 計画: S5, S6, S7, S8, S9
  - 依存: T03（直す対象の表示が要る）
  - 変更: `server/src/read.ts`, `server/src/search.ts`, `server/src/asked.ts`, `server/src/fields.ts`, `server/src/review-findings.ts`, `server/src/export.ts`, `server/src/mcp.ts`, `server/test/search.test.ts`, `server/test/plugin.test.ts`
  - red: `node probe/codex-f123.ts` → `73dcb115` の `hitsReply` は、タイトルの制御文字列を途中で切った option の後ろの hit（u2）を返答から落とし、切った option に印を付けない
  - 完了条件: `node --import ./test/isolate-home.ts --test test/search.test.ts` → 全件 pass
  - コミット: `fix(read): keep every read server reply within the reply budget`
  - 結果: `node probe/codex-f123.ts` → 直す前は「F1 names u2: false」「F3 cut option is marked: false」、直した後はどちらも true
  - 結果: `node --import ./test/isolate-home.ts --test test/search.test.ts` → 24 件 pass

- [x] T13: 切ったキーの横に、`read` に渡せる `u<id>` を出す（asked・review_check・export）
  - 種別: 修正
  - 計画: S6, S7, S9
  - 依存: T12（キーを切って表示する形が要る）
  - 変更: `server/src/read.ts`, `server/src/asked.ts`, `server/src/review-findings.ts`, `server/src/export.ts`, `server/test/asked.test.ts`, `server/test/plugin.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/asked.test.ts` → 切ったキーの横に `[key cut: read u<id>]` を期待するテストが、直す前（`3516aa72`）は失敗する
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(read): name the id read takes beside every key a reply cuts`
  - 結果: `node --import ./test/isolate-home.ts --test test/asked.test.ts` → 直す前は 1 件 fail（`plugin.test.ts` の asked と review_check のテストも fail）、直した後は pass
  - 結果: `bun run verify` → 終了コード 0

- [x] T14: キーを切る残りの場所にも `u<id>` を出し、export の拒否の行は渡された参照をそのまま出す
  - 種別: 修正
  - 計画: S5, S6, S7
  - 依存: T13（`keyShown` が要る）
  - 変更: `server/src/review-findings.ts`, `server/src/export.ts`, `server/src/search.ts`, `server/test/plugin.test.ts`, `server/test/asked.test.ts`, `server/test/search.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/plugin.test.ts` → 直す前（`1f7c6d43`）は、finding 自身の問題行に id が無く、export の拒否の行が参照を 200 バイトで切るので、厳しくしたテストが 2 件落ちる
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(read): carry the record id on the remaining lines that cut a key`
  - 結果: `node --import ./test/isolate-home.ts --test test/plugin.test.ts` → 直す前は review_check と export のテストが fail、直した後は pass
  - 結果: `bun run verify` → 終了コード 0

## 記録

- 2026-10-11 / T01 / 未完了の T01 の変更欄を変えた。前: `server/src/worktree.ts` あり、`server/test/git-safety.test.ts`・`server/test/record.test.ts` なし。後: 逆 / `snapshot` は `worktreeStatus` が今までどおり文字列か `null` を返すので変更が要らなかった。既存のテスト 2 ファイルが新しい戻り値に追従し、rename の注記のテストは `record.test.ts` にあった
- 2026-10-11 / T01 / 予定外の発見: `isolatedHome` は、iso のディレクトリを作った後で重なりを調べ、断るときにそれを残していた（断られる環境では、呼ぶたびに `~/.sphica/git` に空のディレクトリが 1 つ増える） / 断るときに消すようにし、テストに入れた
- 2026-10-11 / T01 / コミットの前の review-shipping が 6 件指摘（出荷は可の判定。40 通りの弱め方のうち 25 をテストが落とす）: (1) worker から `renamesSince` を通る経路のテストが無い (2) `listFiles` の失敗の分け方（`unreadOf`）のテストが無い (3) `localChange` の timeout の文面を固定するテストが無い (4) 3 つの断りの文面と、まれな失敗の経路の分け方が固定されていない (5) 存在しない TMPDIR では git を動かす前に失敗するのに「git failed」と言う (6) `unreadText` が `localChange` の doc コメントと宣言の間に入っていた / (1)(2)(5)(6) と (4) の文面を直した。(5) は文面を「git failed or could not be started」にした。採らない: (3) は timeout と too_large が同じ 1 行を返すので、弱めるには枝を足す必要がある。(4) の残り（spawn の失敗や壊れた返答を `failed` にする経路）は、起こすのにプロセスの失敗を作る必要があり、分け方は `inIsolation` の 3 種類のテストで固定している
- 2026-10-11 / T01 / review-shipping が確かめたこと: 古い worker（0.6.48）と新しい呼び出し側が混ざっても落ちず、0.6.48 と同じ文面になる。`ETIMEDOUT` と `ENOBUFS` は Node 24.15・24.18・26.10 の macOS で実測（Windows は未実測）。断るときの `rmSync` は、リンクならリンクだけを消す
- 2026-10-11 / T01 / tasks を直すスクリプトが文字コードのエラーで動かず、チェックの無いままコミットされた（push の前） / 同じコミットを amend してチェックと結果を入れた。以後、tasks の更新は成功を確かめてからコミットする
- 2026-10-11 / T01 / Codex のレビュー（`e0107a6e`、指摘 1 件、P2）: `.sphica`・`.sphica/git`・`hooks` がリンク先の無いリンクだと、`existsSync` が false を返して `mkdirSync` が `EEXIST` で落ち、断りではなく失敗として報告される（自分でも再現） / 採用。T10 を足し、`ownDir` が先に `lstat` で見るようにした
- 2026-10-11 / T02 / コミットの前の review-shipping が 3 件指摘（出荷は可の判定）: (1) doctor が作業ツリーの root ではなく cwd を試すように弱めても、テストが通る (2) `sphica init` をしたことのない HOME で doctor を流すと、`.sphica`・`.sphica/git`・`.sphica/git/hooks` を作る（0.6.48 の doctor は何も作らなかった） (3) bundle の余裕が少ない（`git-worker.js` は 13,000 のうち 12,845、`cli.js` は 632,000 のうち 629,328） / (1) は、HOME 自体が作業ツリーのときに、その下のフォルダから流すケースを足した。(2) は、HOME に `.sphica` が無いとき（まだ使っていない環境）は試さず、行も出さないようにした。(3) は直さず記録だけ（今は `git-worker.js` 12,888、`cli.js` 629,419 で予算内。次に worker を触るときに予算を見直す）
- 2026-10-11 / T02 / Codex のレビュー（`5d87d383`、指摘 1 件、P2）: doctor が `.sphica` の有無を `existsSync` で見るので、リンク先の無いリンクだと未使用の HOME として扱い、worker が断る理由を出さない / 採用。T11 を足し、`lstat` で見るようにした
- 2026-10-11 / T03 / 未完了の T03 の変更欄を変えた。前: `server/src/text.ts`。後: `server/src/read.ts` と `server/test/deliver.test.ts` / 予算の計算の関数は `READ_BUDGET` の隣（`read.ts`）に置いた。`deliver.test.ts` は、無くなった `hitsText` を使っていたので新しい関数に合わせた
- 2026-10-11 / T03 / 予定外の発見: 部品の大きさを足すだけでは、枠（`framed` が通す `plain`）と省略の案内の分がずれる / 返答全体を作る関数を渡し、できあがった返答のバイト数で決める形にした（`fitCount`）
- 2026-10-11 / T03 / 予定外の発見: `sources: true` は、artifact と作者を切ると 20 件でも収まる（1 件あたり約 1.5 KB） / 省略の案内は残すが、テストは「20 件が全部出て、省略なし」を見る
- 2026-10-11 / T03 / コミットの前の review-shipping が 4 件指摘（出荷は可の判定。32,768 バイトを超える search の返答は作れなかった。最大は実 DB 経由で 32,442 バイト）: (1) option の本文などの切り詰めを外しても、テストが通る（収まるが、出る件数が減るだけ） (2) `fitCount` の最初の見積もりは枠が落とす文字（ゼロ幅や制御文字）を数えるので、そういう本文だと早く止まる (3) 0 件の返答自体が上限を超えるときは 0 を返し、呼ぶ側が上限を超えた返答を送る（search では起きないが、次のタスクで同じ関数を使う） (4) sources の省略の案内は、20 件が必ず収まるので通らない / (1) は「6 件以上が表示される」をテストに足した。(2) は見積もりから増やす方向にも試すようにした。(3) は関数の説明に「0 件の返答は呼ぶ側の上限で収める」と書き、次のタスクで各ツールの 0 件の返答を固定の長さにする。(4) は直さない
- 2026-10-11 / T03 / review-shipping が測った bundle の余裕: `deliver.js` 1,694、`cli.js` 2,555、`git-worker.js` 112 バイト。`mcp.js` は 104,652 / 残りのタスクで `deliver.js` と `git-worker.js` は触らない
- 2026-10-11 / T03 / Codex のレビュー（`73dcb115`、指摘 3 件、どれも P2、どれも自分で再現）: (1) option を 160 バイトで切ると、タイトルの制御文字列の終端が落ち、枠の `plain` がそこから返答の終わりまで消す。後ろの hit が参照も残さず消える (2) 記録の本文が、省略の案内と同じ行を書ける（案内が枠の中にあるので区別できない） (3) 切った option に印が無く、全文に見える / 全部採用。T12 を足した。表示する文字列は先に無害化（`plain` / `inline`）してから切り、切ったら「…」を付ける関数（`preview`）にまとめた。省略の案内・検索が止まった場所・「Read a record by its key」は、枠の閉じる行の後（Sphica だけが書く場所）に出す。同じ形を asked・fields・review_check・export の表示にも入れた
- 2026-10-11 / T04 / 未完了の T04 の変更欄を変えた。前: `server/test/review.test.ts` あり。後: なし / 短いキーでは問題文が変わらない形にしたので、既存のテストに変更が要らなかった
- 2026-10-11 / T04〜T09・T12 / 1 つのコミットにまとめた / 持ち主の「まとめて一気に進めて」に合わせ、検査と独立レビューを 1 回で通すため。各タスクの red は個別に確かめて結果欄に残した
- 2026-10-11 / T07 / 予定外の発見: セッションの id を 100 バイトで切ると、`/sphica:trace` に渡せない id を使えるように見せてしまう / 100 バイト以内はそのまま、超えるものは「[id cut]」と印を付ける
- 2026-10-11 / T08 / SDK 1.31.0 の `StdioServerTransport.send` は引数が 1 つ（options を取らない） / 包む関数も 1 引数にした
- 2026-10-11 / T04〜T09・T12 / コミットの前の review-shipping（出荷は可の判定。読み取りサーバーで 32,768 バイトを超える返答は作れず、最大は `review_check` の 32,682 バイト。bundle した `mcp.js` でも、40 KB の未知のツール名のエラーがちょうど 32,768 バイトに収まる。名指しした 7 通りの弱め方は全部テストが落とす）が 7 件指摘: (1) asked で、1 件の発言の部品だけで上限を超えると、その発言は表示されない（ひも付く記録それぞれに後継が 30 件、キー 300 文字のとき。関数を直接呼んで再現） (2) `[id cut]` の印を外してもテストが通る (3) 記録の検索が途中で止まったときの案内を、サーバー経由で通すテストが無い (4) 発言を省略するときに、セッションの一覧や注意書きを落としてもテストが通る (5) エラーでない返答まで切るようにしてもテストが通る (6) export の拒否の一覧の 2 つの守りは、片方ずつ外してもテストが通る (7) sources の省略の案内は通らない（T03 と同じ） / (1) は、ひも付く記録が名指しする後継を 3 件までにして残りを数える形にした（1 件の発言の部品が上限を超えなくなる）。(2)(4) は、手で組んだ結果を `askedText` に渡すテストを足した。採らない: (3) は 2,000 件を超える候補が要り、案内そのものは `hitsReply` のテストで固定している。(5) は、上限を超える成功の返答が存在しないので、切っても切らなくても同じ結果になる。(6) の 2 つ目は、参照を 200 バイトに切った後は 50 件で約 12 KB にしかならず、スキーマの範囲では届かない念のための守り。(7) は T03 と同じ
- 2026-10-11 / 全体 / review-shipping が見つけた、この変更によらない事実: 10 MiB を超える 1 行の JSON-RPC の要求で、サーバーが返答なしに終了コード 0 で終わる（SDK の stdio の上限。main の `mcp.ts`・bundle した `mcp.js`・`mcp-record.js` で再現） / この PR では直さない。record サーバーの計画（issue #324）に足す
- 2026-10-11 / T05 / review-shipping が持ち主の DB の写しで測った大きさ: 有効な決定 190 件、1 件の文書は 897〜4,519 バイト（中央値 1,568）。新しい上限では 1 ファイルに 14〜23 件入る。1 件だけで拒否されるものは無い
- 2026-10-11 / 全体 / Codex の全差分レビュー（`main..3516aa72`、指摘 1 件、P2、Codex が実 DB で再現）: asked がキーを 200 バイトで切るのに `u<id>` を出さないので、表示された記録を `read` で開けない。後継と Same turn のキーも同じ / 採用。T13 を足した。キーを切ったときだけ「[key cut: read u<id>]」を付ける関数（`keyShown`）を `read.ts` に置き、asked の 3 か所、`review_check` の「no verdict」と重複の行、export の置換の連なりの行に使った。短いキーの表示は変わらない
- 2026-10-11 / 全体 / 完了条件の実測（`3516aa72` を pack してリポジトリの外で展開）: `sphica doctor` は「✓ Git worker ready」、HOME を一時ディレクトリの下にすると「△ Git worker would not start: … overlaps the temp directory …」。pack した `deliver.js` のレビューの hook は、通常は「Sphica checked 1 changed path against origin/main: no active recorded decision applies.」、HOME が一時ディレクトリの下だと断りの理由を返す。pack した `mcp.js` は 0.6.49 を名乗り、`search`・`fields`（`after` 付きも）が答え、40 KB の未知のツール名のエラーは 32,768 バイト
- 2026-10-11 / T13 / Codex の再レビュー（`3516aa72..1f7c6d43`、指摘 2 件、どちらも P2、実 DB で再現）: (1) `review_check` の「次のバッチ」の案内と、finding 自身の問題行は、キーを切って id を出さない (2) export の種類・状態による拒否の行も、キーを切って id を出さない / 両方採用。T14 を足した。(1) は `keyShown` を使う（finding の問題行は、そのキーがこの差分に当たる記録のときだけ id を付ける）。(2) は、参照が呼び出し側の入力でスキーマが 300 文字に限るので、切らずにそのまま出す（これで拒否の一覧を予算で止める守りにも実際に届き、テストで通る）。あわせて、検索結果の「Replaces <キー>」が切れたときは、その hit の `u<id>` を読めば分かると書く
- 2026-10-11 / T13 / review-shipping（`1f7c6d43`、出荷は可の判定）が 2 件指摘: 切ったキーの横の id を 0 にしても、4 か所のうち 3 か所でテストが通る（テストが数字なら何でも受け入れていた） / asked は id を 100 番台と 77 にして値まで比べ、`review_check` は全 50 件の id を記録の id と比べる形にした。export の置換の連なりの行は、起こすのに 20 段を超える連なりが要るのでテストを足していない
- 2026-10-11 / 全体 / 同じ種類の指摘（切ったキーに id が無い）が 2 回続いたので、変えた 6 つの module を `rg 'preview\([^)]*[kK]ey|shown\([^)]*[kK]ey|head\([^)]*\.key'` で洗い、残りが無いことを確かめた（残るのは `keyShown` 自身と、id を必ず横に出す検索結果の見出しだけ）
