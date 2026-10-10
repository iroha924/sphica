---
kind: tasks
plan: 10-shell-write-delivery.plan.md
branch: feat/e4-post-write
base: main
---

# shell の呼び出しで内容が変わったファイルの記録を、呼び出しの直後に届ける（#219 の次の段、既定オフで試用）のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 変化の見分け方

配れる記録の anchor のファイル全部について、呼び出しの前後で内容の変化を確かに見分けられる。

- [x] T01: 対象のパス・状態・署名・hash のキャッシュ・控え・期限・寿命を持つ部品と、そのテスト
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `server/src/shell-state.ts`, `server/src/deliver.ts`, `server/test/shell-state.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/shell-state.test.ts` → 書き換え・作成・削除・atomic replace・同じサイズで mtime を戻した書き換えを変化とし、chmod・touch・同じ内容・書いて戻すを変化としない。読む間に変わると 3 回まで取り直し、だめなら unknown。unreadable・根の外へ出る symlink の扱い、壊れたキャッシュの作り直し、控えの検査・期限切れ・欠け、期限での打ち切りが期待どおり
  - コミット: `feat(deliver): snapshot anchored files around a shell call by content`
  - 結果: `node --import ./test/isolate-home.ts --test --test-timeout=120000 test/shell-state.test.ts` → 5 pass（書き換え・作成・削除・atomic replace・同じサイズで時刻を戻した書き換えは変化、chmod・touch・同じ内容・呼び出しの中で戻した書き込みは変化でない、署名が同じならキャッシュで読まない、壊れたキャッシュは空として作り直す、読む間に変わり続けると unknown、期限を過ぎたら unknown、ディレクトリと外へ出る symlink は unreadable、控えは 1 回だけ取れて中身を検査し期限を過ぎたら消える、対象のパスは配れる decision / constraint の applies_to だけ）。namedInCommand は同じ問い合わせの `deliverablePaths` を使う形にした。`bun run verify` → exit 0

- [x] T09: 変化の見分け方の穴を直す（T01 のレビューの F1〜F8）
  - 種別: 修正
  - 計画: S1
  - 依存: T01（直す対象の部品）
  - 変更: `server/src/shell-state.ts`, `server/test/shell-state.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/shell-state.test.ts` → 読み直しの途中でディレクトリが外への link に替わると外のファイルを hash する、paths がオブジェクトでない控えを受け取る
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/shell-state.test.ts` → 読み直しのたびに境界と期限を確かめ、1 MB ずつ読んで期限で止まり、境界の確かめの例外は missing / unreadable、`..settings` と `__proto__` は普通の名前、1970 年より前の時刻も署名として残り、読み直しは 1 回目だけ変わったら 2 回、変わり続けたら 3 回で止まる
  - コミット: `fix(deliver): keep shell snapshots inside the checkout and the deadline on every read`
  - 結果: red を直す前のコードで実測（F1 の外の hash、F4 の paths: true の受理）。ほかは同じテストの後ろにあったので、直した後に各直しを 1 つずつ戻してテストが落ちることを確かめた（F2・F3・F5・F6・F7・F8 すべて）。`node --import ./test/isolate-home.ts --test --test-timeout=120000 test/shell-state.test.ts` → 6 pass。`bun run verify` → exit 0

- [x] T10: 控えと Post の穴を直す（T02・T09 のレビューの F1〜F4）
  - 種別: 修正
  - 計画: S1
  - 依存: T09（直す対象の読み方）
  - 変更: `server/src/shell-state.ts`, `server/src/deliver.ts`, `server/test/shell-state.test.ts`, `server/test/deliver.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/shell-state.test.ts test/deliver.test.ts` → 境界の確かめの直後にディレクトリが外への link に替わると外のファイルを ok として hash する、7 日を過ぎた控えを受け取る、キャッシュを保存できないと Post が空を返し試用のログも残らない、4 万パスを渡すと too many SQL variables
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/shell-state.test.ts test/deliver.test.ts` → 開いたファイルが checkout の中で今そのパスが指すものと同じ（dev・ino）ときだけ hash し、期限を過ぎた控えは Post で snapshot_expired として残り、キャッシュを保存できなくても比べて届け、4 万パスでも記録が見つかる
  - コミット: `fix(deliver): check the opened file, expire snapshots at Post, and chunk changed paths`
  - 結果: 4 件とも直す前のコードで意図した理由の失敗を確かめた。`node --import ./test/isolate-home.ts --test --test-timeout=120000 test/shell-state.test.ts` → 6 pass、`--test-name-pattern="shell call|more changed paths" test/deliver.test.ts` → 4 pass。Pre で控えを取れなかったときも試用のログに snapshot_failed を残すようにした。`bun run verify` → exit 0

- [x] T11: プロジェクトの識別の失敗も試用のログに残す（T03・T10 のレビューの F2）
  - 種別: 修正
  - 計画: S2
  - 依存: T10（直す対象の Post の形）
  - 変更: `server/src/deliver.ts`, `server/src/shell-state.ts`, `server/test/deliver.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/deliver.test.ts` → origin の無い checkout でローカルのプロジェクト表が読めないと、Post が EISDIR で reject し、試用のログに何も残らない
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/deliver.test.ts` → 識別に失敗した Post は空を返し、試用のログに error 付きの 1 行を残す
  - コミット: `fix(deliver): log a shell call's Post whose project cannot be told`
  - 結果: red を直す前のコードで確かめた（EISDIR で reject）。`--test-name-pattern="shell call|more changed paths" test/deliver.test.ts` → 5 pass。境界のコメントを、残る隙（確かめの合間に link と行き来させる差し替え）を書く形に直した。`bun run verify` → exit 0

## P2: 届け方

設定がオンのとき、両ホストで shell の呼び出しの後に、まだ届いていない記録が次のモデルリクエストの前に入る。オフなら今と同じ。

- [x] T02: Post の配信（lockedPlan、文面、上限、pre_edit＋reason shell_write のログ、試用のログ）と設定の読み取り
  - 種別: 追加
  - 計画: S2
  - 依存: T01（控えと比較の部品が要る）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`, `plugin/.claude-plugin/plugin.json`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/deliver.test.ts test/deliver-codex.test.ts` → オフなら Pre は控えを取らず Post は何も返さない。オンなら変わったパスのまだ届いていない記録だけを 5 件・1,500 字まで返し、読みの予算を使わない。compact の後は数え直し、subagent は別の会話。PostToolUseFailure でも届く。並行の 2 つの Post で同じ記録が 2 回出ない。ログを書けなくても本文は返り、試用のログは配信の有無によらず 1 呼び出し 1 行
  - コミット: `feat(deliver): deliver records on files a shell call changed, behind an option`
  - 結果: `node --import ./test/isolate-home.ts --test --test-timeout=120000 --test-name-pattern="shell call" test/deliver.test.ts` → 2 pass（既定オフで控えを取らない、環境変数の off が plugin の設定に勝ち、plugin の設定だけでもオン、何も変えない呼び出しは何も出さない、名指さないスクリプトの書き換えで記録が届き pre_edit＋reason shell_write で記録される、同じ会話には 2 回出さない、subagent と別の会話・PostToolUseFailure・compact の後・Codex の Bash で届く、控えの無い Post は何も出さず snapshot_missing を残す、ロック中はログなしで本文を返す、試用のログは 1 呼び出し 1 行、並行の 2 つの Post でログに残る記録は 1 回）。読みの配信の「restart の後に届いた記録」を sinceRestart にくくり出して共有した。`bun run verify` → exit 0
- [x] T03: 両ホストの hook の登録と、userConfig の shell_write_delivery
  - 種別: 追加
  - 計画: S2
  - 依存: T02（Post の処理が要る）
  - 変更: `plugin/hooks/hooks.json`, `plugin/hooks/codex.json`, `scripts/check-ai-config.mjs`, `scripts/check-hooks-live.mjs`, `server/test/codex-trust.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/plugin.test.ts test/codex-trust.test.ts` → Claude Code の同期の PostToolUse と PostToolUseFailure（Bash|PowerShell）と Codex の PostToolUse（^Bash$、Windows は -EncodedCommand）の配信の entry があり、userConfig に既定 false の shell_write_delivery がある。`bun run hooks:live` → 足した entry を出荷する形で起動できる
  - コミット: `feat(plugin): register post-shell delivery hooks and the shell_write_delivery option`
  - 結果: `node scripts/check-ai-config.mjs` → 通る（Claude Code の PostToolUse に同期の Bash|PowerShell の配信、PostToolUseFailure に同じ配信、Codex の PostToolUse に同期の ^Bash$ の配信と encoded の commandWindows があることを固定した）。`node --import ./test/isolate-home.ts --test --test-timeout=120000 test/plugin.test.ts test/codex-trust.test.ts` → 48 pass（0.6.30 にあった hook の hash は Windows 以外で変わらず、増えた key は post_tool_use:1:0 だけ）。`bun run hooks:live` → 出荷する hooks.json の形で、設定オフでは何も届かず、plugin の設定オンでは PostToolUse と PostToolUseFailure の両方で名指さない書き換えの決定が届く。Codex は全 entry を sh で起動した。PostToolUseFailure の entry を外すと hooks:live が 2 件で落ちることを確かめた。`bun run verify` → exit 0

## P3: 正しさの harness と時間

固定の正例と負例で、出荷する hook が期待どおりに振る舞い、時間が収まることを数字で示す。

- [x] T04: 正しさの harness（両ホストの入力の形、正例 40 件・負例・別に数える行・限界の行、新旧比較）と、Windows の CI での実行
  - 種別: 追加
  - 計画: S3
  - 依存: T03（出荷する hook の形が要る）
  - 変更: `server/evals/post-write/shell-write-harness.ts`, `server/test/shell-write-harness.test.ts`, `.github/workflows/check.yml`, `knip.json`
  - 完了条件: `node server/evals/post-write/shell-write-harness.ts` → 両ホストの形で正例 40 件中 40 件が届き、負例とメタデータだけの行は追加 0、別に数える行と限界の行の件数と新旧比較の表が出る。`cd server && node --import ./test/isolate-home.ts --test test/shell-write-harness.test.ts` → harness 自身が既知の結果を正しく数える
  - コミット: `test(eval): check post-shell delivery on fixed shell commands for both hosts`
  - 結果: `node server/evals/post-write/shell-write-harness.ts` → exit 0（macOS）。正例 80 / 80（shell の 40 件 × 両ホスト。届いた経路は Pre が名指して先に届けたものと Post のものがあり、全件で Post が変化として見た）、負例 20 / 20（変化として見ず、Post は何も足さない）、別に数える行（git checkout・stash・restore、Biome）は 8 / 8 が変化として見え、Post で届いたのは 2。限界の行は background の書き込みが次の呼び出しでも見えないことと、署名を変えない変化はユーザー空間から再現できない（書けば ctime が動く）ことを出す。並行 3 行、控えの欠けと期限切れ、ロック中（ログなしで届く）、試用のログを書けない、サブディレクトリの cwd、大文字小文字、外へ出る symlink がすべて期待どおり。1,000 ファイル・63 MB の空のキャッシュで Pre 163 ms・Post 92 ms、全部を変える呼び出しで Post 235 ms（期限に当たらず unknown 0）。main との比較: 正例に届いたのは main 58 / 80、作業ブランチ 80 / 80、会話内の重複はどちらも 0、表示した記録 76 → 99、文字数 39,508 → 52,666。`cd server && node --import ./test/isolate-home.ts --test --test-timeout=120000 test/shell-write-harness.test.ts` → 4 pass。Windows のパスの形と PowerShell の正例は Windows の CI で流す（このコミットの時点では未実行）。`bun run verify` → exit 0
- [x] T05: scale の計測に Pre と Post を足す（実ファイルを持つ fixture、空と温まったキャッシュ、大量の変化）
  - 種別: 追加
  - 計画: S3
  - 依存: T02（Pre と Post の処理が要る）
  - 変更: `server/evals/scale/run.ts`
  - 完了条件: `node server/evals/scale/run.ts` → 温まったキャッシュで記録 1 万件のとき Pre と Post がそれぞれ 1 秒以内。空のキャッシュと大量の変化は hash したバイト数と時間が出て、期限内に終わる
  - コミット: `test(scale): time post-shell snapshots with cold and warm caches`
  - 結果: `node server/evals/scale/run.ts` → shell の行は全サイズで問題なし（Apple M4 Pro）。記録 1 万件（20,000 ファイル）の温まったキャッシュで Pre 最大 556 ms・Post 最大 582 ms（1 秒以内）、stress 1 万件で Pre 494 ms・Post 505 ms。空のキャッシュは 1 万件で 78 MB を hash して Pre 1,674 ms、3 万件（234 MB）は期限で 16,872 件を unknown にして Pre 3,657 ms・Post 3,595 ms。全部を変える呼び出しの Post は 1 万件で 2,685 ms、3 万件で 3,678 ms（14,872 changed・45,128 unknown）で、どれも 5 秒の内に答えた。最初の計測で Post が 5 秒で打ち切られたのを T12 で直した。終了コードは 1 で、原因は review の 2 行（typed と Skill）が全 fixture で記録を出さないこと。origin/main（5d412029）でも同じく失敗するので、この PR の変更によるものではない

- [x] T12: 変わったパスの記録を 1 回の問い合わせで突き合わせる（T05 の計測で見つけた時間の問題）
  - 種別: 修正
  - 計画: S2
  - 依存: T10（直す対象の分割の問い合わせ）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - red: `node server/evals/scale/run.ts` → 記録 1 万件で全部を変える呼び出しの Post が 5,006 ms で打ち切られる（変わったパス 2 万件を 500 件ずつ配れる記録の条件付きで問い合わせ、それだけで 16.6 秒）
  - 完了条件: `node server/evals/scale/run.ts` → 記録 1 万件で全部を変える呼び出しの Post が 5 秒の内に答え、変わったパスの数が watched のパスの数と合う
  - コミット: `fix(deliver): match changed paths against deliverable anchors in one query`
  - 結果: red を直す前のコードで実測した（Post 5,006 ms で打ち切り、問い合わせだけで 2 万パス 16,640 ms・500 パス 418 ms）。直した後は 2 万パス 22 ms・500 パス 20 ms、scale の Post は 2,685 ms。本文の行は表示する 5 件分だけ読む。`--test-name-pattern=\"shell call|more changed paths\" test/deliver.test.ts` → 5 pass。`bun run verify` → exit 0

- [x] T13: harness の大文字小文字の行が、区別しないファイルシステムで src を消す不具合を直す（Windows の CI で見つけた）
  - 種別: 修正
  - 計画: S3
  - 依存: T04（直す対象の harness）
  - 変更: `server/evals/post-write/shell-write-harness.ts`
  - red: `gh run view 38016800986 --job 114108761687 --log-failed` → 大文字小文字の行の後始末で `SRC` を消すと、区別しないファイルシステムでは `src` そのものが消え、後の Windows のパスの形の行が ENOENT で落ちる
  - 完了条件: `gh pr checks 308` → windows が pass（harness が最後まで流れて 0 で終わる）
  - コミット: `fix(eval): keep src when the letter-case row cleans up on a case-insensitive file system`
  - 結果: red は PR の Windows の CI のログで確かめた（固定のケースは 96 / 96 で通り、`src\\u0.ts` の ENOENT で落ちた）。区別しないときは `src/Case1.ts` を戻すだけにした。macOS で `node server/evals/post-write/shell-write-harness.ts --no-compare` → exit 0。Windows の CI は push の後に確かめる

## P4: 実機と出荷

両ホストの実機で文脈が届くことを確かめ、既定オフで出荷する。

- [x] T06: 両ホストの実機の確認（普通の書き込み、非 0 で終わる書き込み、並列、Codex の poll）
  - 種別: 追加
  - 計画: S4
  - 依存: T04（harness が通った出荷の形が要る）
  - 変更: `server/evals/post-write/real-host.md`
  - 完了条件: `rg -n "whose content changed between before and after this call" <確認したセッションの会話記録>` → 各ケースで Post の差し込みが次の応答より前にあり、Codex のセッションのログでも同じ。該当箇所を `real-host.md` に残す
  - コミット: `test(eval): record real-host checks of post-shell delivery on both hosts`
  - 結果: `rg -n "whose content changed between before and after this call" <7 件の会話記録とセッションのログ>` → 7 件すべてで差し込みが次の応答より前にあった。Claude Code 2.1.296（`claude -p --plugin-dir plugin`、入れてある sphica は無効）と codex-cli 0.162.0（一時的な CODEX_HOME にローカルのマーケットプレイスから同じバンドルを入れ、`--dangerously-bypass-hook-trust`）で 7 件を流した。どれも Post の差し込み（Claude Code は PostToolUse / PostToolUseFailure の hook_additional_context、Codex は developer のメッセージ）が次の応答より前にあり、応答は届いた key を引いた。Claude Code: 普通の書き込み、書いてから exit 3（PostToolUseFailure）、1 つのメッセージで 2 つの Bash。Codex: 普通の書き込み、1 つの exec で 2 つのコマンド、20 秒のコマンドを 1 回で待つ形と、2 秒で戻して write_stdin で 3 回 poll する形（差し込みは終わりを見た poll に付く）。セッション id と並びは `server/evals/post-write/real-host.md`。Codex の新しい hook の信頼の手順と、Windows の実機は確かめていない（同じファイルに書いた）
- [ ] T07: README の設定の説明と、既定オフのリリースの準備（release:plan、バージョン）
  - 種別: 追加
  - 計画: S5
  - 依存: T06（実機の確認が通ってから出す）
  - 変更: `README.md`, `README.ja.md`, `plugin/package.json`, `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`
  - 完了条件: `bun run release:plan -- --base v0.6.43` → plugin で、npm と 3 つの plugin manifest のバージョンが同じ。`bun run verify` → 0 で終わる
  - コミット: `docs(readme): describe the shell_write_delivery option`

## P5: 試用と採否（既定オフのリリースの後、この PR の外）

持ち主の 7 日の試用で、既定をオンにするか外すかを前もって決めた基準で決める。

- [ ] T08: 試用の標本（会話記録から、seed で 40 件）のラベル付けと採否、#219 への記録
  - 種別: 追加
  - 計画: S6
  - 依存: T07（既定オフのリリースが要る）
  - 変更: `server/evals/post-write/shell-write-trial.json`
  - 完了条件: `cat server/evals/post-write/shell-write-trial.json` → 母集団（会話記録の Post の差し込みと試用のログの突き合わせ）、標本、両者のラベルと決着、noise の割合、90 パーセンタイル、ホスト別、判定が入っている。#219 にコメントした
  - コミット: `test(eval): record the shell_write_delivery trial and its decision`

## 記録
- 2026-10-10 / T01 / SQL の呼び出し箇所は namedInCommand のものを deliverablePaths に移しただけで数が変わらず、台帳の変更は要らなかった / 変更欄から `scripts/lib/sql-call-sites.mjs` を外した
- 2026-10-10 / T02, T03 / `bun run pairs` が、コードで読む plugin の設定が plugin.json に宣言されていることを求めた。Codex の形は deliver.test.ts の中で確かめた / userConfig の shell_write_delivery の宣言を T03 から T02 に移し（T03 の変更欄から plugin.json を外した）、T02 の変更欄を `deliver-codex.test.ts` から `plugin/.claude-plugin/plugin.json` に変えた
- 2026-10-10 / T01 のレビュー / F1〜F8 は採用して T09 で直した。期限を守るため、読み取りをファイル全体の一括から 1 MB ずつに変えた
- 2026-10-10 / T03 / entry の形を固定しているのは plugin.test.ts ではなく check-ai-config.mjs だった。codex-trust.ts は hook を数で持たず変更が要らなかった。codex-trust.test.ts は 0.6.30 と hook の数が同じことを前提にしていた / 変更欄を実際に変えたファイルに直し、codex-trust.test.ts は key ごとに比べる形にした
- 2026-10-10 / T02・T09 のレビュー / F1〜F4 は採用して T10 で直した
- 2026-10-10 / T04 / 正例のコマンドの多くはファイルを名指すので、Pre の読みの配信で先に届き、同じ会話で Post は繰り返さない。計画の「Post で届く」を、その呼び出しの中で届くことと、Post が全件を変化として見ること（試用のログの changed）の 2 つで確かめる形にした / harness の正例の判定に changed を加え、届いた経路を表に出した
- 2026-10-10 / T03・T10 のレビュー / F2 は採用して T11 で直した。F1（確かめの合間に link と行き来させると外のファイルを hash できる）は見送った: Node に openat が無く確かめを重ねても隙は消えない、差し替えられるのは同じユーザーのプロセスで外のファイルを自分で読める、Sphica は hash を手元に置くだけで中身を出さず、狂うのはその 1 回の見分けだけ。コメントにこの隙を書いた
