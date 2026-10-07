---
kind: plan
status: approved
codex_session: 01a11714-7dbf-7740-b926-ef36b26d2c45
codex_rounds: 3
approved_at: 2026-10-08
---

# チェックの失敗の出力を捨てず、テストの一時ディレクトリの残骸を作らせない（#299、#300）

## 要点

- sql:reach・sql:live・hooks:live の失敗の経路を、出力してから `process.exitCode = 1` で return する形にし、出力が途中で捨てられないようにする（#299）
- sql:reach はテストを、実行ごとの空の専用の TMPDIR で流し、成否によらず中に残ったものを名前つきで出して落とし、最後に自分のディレクトリだけを消す（#300 の再発防止）
- 一時ディレクトリを残すテストを、作成箇所から洗い出して全部直す（#300）
- 変えないもの: パッケージ（リリース無し）、SQL coverage の判定、隠しテストの sandbox の環境

## 持ち主の決定

- 今回は Claude が PdM として判断を任されている（2026-10-08、持ち主:「判断任せるよ。どんどん進めて欲しい」「今はあなたが pdm」）
- 持ち主の機械にたまった既存の残骸（42,146 個）は PR の外で、持ち主の承認を得て消す

## 目的

テストやチェックが落ちたとき、失敗したテストの名前と詳細が最後まで出る。テストの実行が os.tmpdir() に何も残さず、新しく残すテストは verify で落ちる。

## 対象外

- record.test の rename limit が時々落ちる件の原因（git の「unable to create temporary file: Invalid argument」）。残骸との関係に根拠は無い。この PR で出力が切れなくなるので、次に落ちたときに失敗した git のコマンドと stderr を確保できる
- 出力の後に process.exit するほかのチェック（check-markdown など）: 親が子の出力を出し直す経路ではなく、出力が大きくない
- 既存の残骸の削除

## 前提

- scripts/check-sql-reach.mjs:23 は spawnSync でテストを流し、失敗のときに子の出力を console.error で出して process.exit(1) する（:29-33、ほかに :43、:77）。Node は process.exit で書き終えていない出力を捨てる。Codex の実測: process.exit(1) では 204,804 バイトのうち 65,536 バイトしか届かず、自然に終われば全部届いた。writeSync してから exit しても、受け手が遅いと 65,536 バイトで止まり、ループでは EAGAIN になった
- spawnSync の maxBuffer の既定は 1 MiB で、超えると子は SIGTERM で止められる（error ENOBUFS、status null）。:23 は上限も r.error も見ていない
- scripts/check-sql-live.mjs:263 と scripts/check-hooks-live.mjs:498 も出力の直後に process.exit する。check-sql-live は live-harness の withTempDir の finally の後片付けまで飛ばす。scripts/check-codex-trust-live.mjs:130 は既に exitCode = 1 と return の形
- 残骸の作成箇所（Codex と確認）: server/test/admin.test.ts:20 の tmp()、file-lock.test.ts:9、assets.test.ts:13、fake-gh.ts:9、fake-codex.ts:12、plugin.test.ts:702・747 の `sphica-${name}-`（a・b・u）、extract.test.ts。子の環境を PATH・HOME だけで組み直すテストがある（cli.test.ts:26、admin.test.ts:224）
- os.tmpdir() は Linux と macOS で TMPDIR → TMP → TEMP、Windows で TEMP → TMP を見る。macOS の /var と /private/var は realpath で同じになる

## 方針

### 失敗の出力（#299）

- sql:reach・sql:live・hooks:live の該当経路を main 関数にまとめ、失敗は出力してから `process.exitCode = 1` で return する。共通の強制終了の関数は作らない
- sql:reach の spawnSync に `maxBuffer: 64 * 1024 * 1024` を明示し、r.error・r.signal・r.status を出す。上限を超えたらそのことを診断として出して落とす

### テストの実行ごとの TMPDIR（#300 の再発防止）

- テストの起動・残骸の検査・後片付けを `scripts/lib/test-run.mjs` の関数に切り出す（仮に runTestsIsolated）。実行ごとに os.tmpdir() に空の専用ディレクトリを作って realpath で揃え、子に TMPDIR・TMP・TEMP として渡す。coverage 用のディレクトリとは分ける
- テストの成否によらず、終わった後に専用ディレクトリの中を調べ、残ったものの名前を出す。テストの失敗と残骸の両方を報告して落とし、最後に自分の作ったディレクトリだけを finally で消す
- 保証は「実行用のディレクトリの下に残ったもの」まで。固定の /tmp や、環境を無視する作成先は対象外
- 子の環境を組み直すテストには TMPDIR・TMP・TEMP を渡す。隠しテストの環境（hiddenEnv）は変えない（scratch は呼び出し元が専用の TMPDIR の下に作って finally で消すので、検査の対象になる）

### 残骸を作るテストの直し（#300）

- mkdtemp などの作成箇所を起点に全部洗い出し、作成の直後に削除を登録する（テスト単位は t.after、モジュール共有の fake はファイル単位の after）。返り値を受け取る前に失敗しても消えるようにする
- 子を起動するテスト（file-lock.test.ts など）は、失敗したときも子を止めて終了を待ってから消す

### テスト

- `scripts/lib/test-run.mjs` の関数を偽のコマンドで直接確かめる: 漏れなしで通る、漏れありで名前を出して落ちる、テストの失敗と漏れの両方を出す、出力の上限を超えたら診断を出す、専用ディレクトリが消える
- 本物の scripts/check-sql-reach.mjs を、PATH の先頭に置いた偽の bun で起動する: 200 KB の stdout と stderr の末尾まで届く（直す前の形では落ちる）、失敗の経路で exitCode が 1 で専用ディレクトリが消える。SQL coverage の判定は残し、スクリプト全体の成功は本物のテストを流す verify で確かめる
- 本物の GIT_DIR を渡さず、テストスイートを再帰で起動しない

## 採った案と棄却した案

- 採用: 出力してから exitCode = 1 で return する。棄却: writeSync で書いてから process.exit する共通の関数（受け手が遅いと 64 KB で止まり EAGAIN になる、finally を飛ばす）
- 採用: 実行ごとの専用の TMPDIR の中を検査する。棄却: os.tmpdir() の sphica-* の数を前後で比べる（ほかの作業の一時ファイルと混ざる）
- 採用: 成功の経路は切り出した関数で確かめ、本物のスクリプトは失敗の経路で確かめる。棄却: 本物のスクリプト全体を偽の bun で成功させる（偽の bun は SQL coverage を作らず、必ず落ちる）

## 手順

- S1: 失敗の出力を捨てない形（sql:reach・sql:live・hooks:live）と、sql:reach の maxBuffer と診断
- S2: テストの実行ごとの TMPDIR と残骸の検査（scripts/lib/test-run.mjs と sql:reach）、そのテスト
- S3: 残骸を作るテストを直し、子の環境を組み直すテストに TMPDIR・TMP・TEMP を渡す

## 完了条件

- A1: `bun run verify` → 0 で終わる
- A2: `cd server && node --test test/test-run.test.ts` → 全件 pass（漏れなし、漏れあり、失敗と漏れ、出力の上限、後片付け、偽の bun での 200 KB の出力の末尾）
- A3: `n0=$(ls "$(node -p 'os.tmpdir()')" | grep -c ^sphica); bun run verify; n1=$(ls "$(node -p 'os.tmpdir()')" | grep -c ^sphica); echo $((n1-n0))` → 0（ほかの作業が動いていないときに）
- A4: `gh pr checks <PR>` → 全項目 pass

## リスク

- 既存のテストに、ほかにも残骸を作るものが見つかり、検査で verify が落ちる → 作成箇所を直してから入れる。直せないものは理由を書いて検査で名指しで許す（無い想定）
- 専用の TMPDIR で、TMPDIR を前提にするテストの振る舞いが変わる → 落ちたものを見て、テスト側で直す

## 未解決

なし

## 変更履歴

- 2026-10-08: review-shipping の指摘で、#299 の回帰テストを CI の macos ジョブにも足した（Linux のパイプは同期で書かれ、直す前の形でも落ちないため）。対象のファイルに `.github/workflows/check.yml` が加わる
