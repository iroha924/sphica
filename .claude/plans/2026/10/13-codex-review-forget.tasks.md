---
kind: tasks
plan: 13-codex-review-forget.plan.md
branch: fix/codex-own-thread-capture
base: main
---

# Codex でも review の前に過去の決定を届け、子のスレッドのプロンプトを持ち主の発言として保存しない（#333 の Items 4・5） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: Codex の capture が、本人のスレッドだけを記録する

セッションのログの 1 行目を読む関数を 1 つにし、capture は「このセッション自身のスレッド」だと確かめられた hook 呼び出しだけを記録する。組み込みの review の子のプロンプトは保存されなくなる。このフェーズの間、ブランチは push しない（plan の方針 11）。

- [x] T01: ログの 1 行目を読む `codexThread` を `server/src/codex-log.ts` に作り、`codexInteractive` をそれに乗せる。バージョンを上げる
  - 種別: 変更
  - 計画: S1, S5, S7
  - 依存: なし
  - 変更: `server/src/codex-log.ts`, `server/src/deliver.ts`, `server/test/codex-log.test.ts`, `server/test/codex-log-file.ts`, `server/test/deliver.test.ts`, `scripts/lib/bundle-budget.mjs`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run verify` → 終了コード 0。その前に、(1) 変更の前の main で `node server/evals/scale/run.ts` を流して表を結果行に残す、(2) `bun run release:plan -- --base v0.6.52` の種別が `plugin` で、上げるバージョンが npm に無い（`npm view sphica versions --json`）ことを確かめてからバージョンを上げる、(3) `cd server && node --import ./test/isolate-home.ts --test test/codex-log.test.ts test/deliver.test.ts` が pass（本人のスレッド・子のスレッド・読めないログのそれぞれで `codexThread` が期待の値を返し、`codexInteractive` の既存のテストは変えずに通る）
  - コミット: `refactor(deliver): read a Codex session log's first line in one place, and bump the version`
  - 結果: `node server/evals/scale/run.ts` → 変更の前（コミット 569ba556、Apple M4 Pro）に流して終了コード 0、全行 problems none。記録 1 万件（uniform）の中央値: prompt 130〜172 ms、read 64 ms、edit 69 ms、名指しの shell 124 ms、review 263〜272 ms、session start 79 ms。表は PR 本文に載せる
  - 結果: `git add <変更> && bun run release:plan -- --base v0.6.52` → `release kind: plugin`、inputs は `server/src/codex-log.ts`, `server/src/deliver.ts`。`npm view sphica versions --json` の最後は 0.6.52 で、0.6.53 は無い
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/codex-log.test.ts test/deliver.test.ts` → tests 64、pass 64、fail 0
  - 結果: `bun run verify` → 1 回目は Biome の整形 2 件で落ち（`bun run fix` で直した）、2 回目は `deliver: ./deliver.js is 445640 bytes, over its budget of 445000` で落ち（上限を 450,000 に上げた）、3 回目は終了コード 0（受け入れ 137 件 pass）
  - 結果: `node scripts/check-tarball.mjs <tgz>` → `review-shipping` が `npm pack` の tarball に流して 0。止める指摘なし。`deliver.js` だけが 694 バイト増え、ほかの 5 つの bundle は同じ。旧 `codexInteractive` と 48,580 通りの入力で比べ、違いは「文字列でない `session_id` が文字列でない `payload.id` と一致する」12 通りだけで、新しいほうが対話でないと答える（ホストは文字列しか送らない）

- [x] T02: Codex の capture は、ログで本人のスレッドだと確かめられたときだけ記録し、判定できないときは通知する
  - 種別: 修正
  - 計画: S2
  - 依存: T01（ログの 1 行目を読む `codexThread` が要る）
  - 変更: `server/src/capture.ts`, `server/src/once.ts`, `server/src/deliver.ts`, `server/test/capture.test.ts`, `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`, `server/evals/acceptance/load.ts`, `server/test/acceptance-cases.test.ts`, `scripts/check-hooks-live.mjs`, `scripts/lib/bundle-budget.mjs`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/capture.test.ts` → 直す前は、子のスレッドのログを持つ UserPromptSubmit が spool に `speaker: "owner"` の発言を置き、「何も置かない」のテストが落ちる。`cd server && node --test --test-timeout=60000 evals/acceptance/run.ts` → 足した capture のケース（組み込みの review のプロンプトが source にならない）が、source ができて落ちる
  - 完了条件: `bun run verify` → 終了コード 0。capture のテストで、本人のスレッドのログでは SessionStart・UserPromptSubmit・PostToolUse・Stop・Interrupt が今までどおり動く / 子のスレッドのログでは何も置かず通知も出ない / ログが無い・256 KiB を超える・JSON でない・`id` が違うときは何も置かず、UserPromptSubmit で通知が 1 セッションに 1 回だけ出る。Codex の capture を流すほかのテスト・driver・`check-hooks-live.mjs` は、`rg` で拾った全部の入力にログを付けてある
  - コミット: `fix(capture): record a Codex hook call only when its log says it is the session's own thread`
  - 結果: `cd server && node --test --test-timeout=60000 evals/acceptance/run.ts` → 直す前（capture.ts は元のまま、ケースと driver だけ足した状態）は tests 138、fail 1。capture-18 が `session:s-en-review-thread#1.owner was recorded` で落ちた。直した後は pass 138
  - 結果: `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern="recorded only when its session log" test/capture.test.ts` → capture.ts だけ `git stash` で元に戻して流すと fail 1（`Stop sends nothing`: 子のスレッドの Stop が送信を始める。元のコードが子の呼び出しを本人のものとして扱っている）。戻した後、ファイル全体で tests 72、pass 72
  - 結果: `bun run verify` → 1 回目は新しいテストの型エラー（`source` は `HookInput` に無い）、2 回目は `cli: ./cli.js is 632532 bytes, over its budget of 632000` で落ち、上限を 636,000 に上げて 3 回目は終了コード 0。通知の文面を分けた後にもう 1 回流して終了コード 0（受け入れ 138 件 pass）。bundle は capture 390,172 / cli 632,796 / deliver 446,878 / mcp-record 1,772,997 バイト
  - 結果: `node dist/capture.js codex` → `review-shipping` が pack した配布物に実機の形の入力を渡した: 本人のスレッドのプロンプトと Stop は 2 件が待ち行列に入り、review の子のログでは何も入らず、無いファイルでは通知が 1 回。Claude Code は `transcript_path` の有無によらず今までどおり。`node scripts/check-tarball.mjs <tgz>` は 0
  - 結果: `rg -n 'onHook\(' server scripts` → Codex の capture を流すのは `server/test/capture.test.ts`、受け入れの `driver.ts`、`scripts/check-hooks-live.mjs` の 3 か所で、全部にログを付けた（ほかの `"codex"` は配信・record サーバー・評価）

## P2: 子のスレッドを、親とは別の会話として配信を数える

`agent_id` の付かない子のスレッド（組み込みの review）への配信を、子の id で数える。子に見せた記録を親に見せたことにしない。

- [x] T03: 配信の会話の識別を `deliver` の最初で 1 回決め、ログ・既読と予算・shell の snapshot と後の配信で使う
  - 種別: 修正
  - 計画: S3
  - 依存: T01（子のスレッドを確かめる `codexThread` が要る）
  - 変更: `server/src/deliver.ts`, `server/test/deliver-codex.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/deliver-codex.test.ts` → 直す前は、子のスレッドがファイル B を読んで B の記録を受け取った後、親が B を読んでも何も返らず、「親にも届く」のテストが落ちる
  - 完了条件: `bun run verify` → 終了コード 0。テストで、子が B を読んだ後に親が B を読むと親にも届く / 親の既読が子への配信を止めない / 子の shell の後の配信が親の snapshot と混ざらない / 配信のログの `agent_id` が子の id になる / ログが読めないときは今までどおり親として数える / Claude Code の配信は変わらない
  - コミット: `fix(deliver): count a Codex child thread without an agent id as its own conversation`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/deliver-codex.test.ts` → 直す前（deliver.ts は元のまま、テストだけ足した状態）は tests 7、fail 2。1 つは `the session was never shown it`（actual は空文字: 子に見せた記録が親に見せたことになっている）、もう 1 つは親の Post が子の snapshot を取って文面を返した。直した後は pass 7
  - 結果: `bun run verify` → 終了コード 0（受け入れ 138 件 pass）。`plugin/dist/deliver.js` は 446,987 バイト
  - 結果: `node dist/deliver.js codex` → `review-shipping` が pack した配布物で 40 回ずつ測り、ログの読み取りの有無で中央値は 54〜57 ms のまま（250 KB の 1 行目でも +2 ms ほど）。1 か所ずつ元に戻す変異 6 通りは、どれも新しいテストのどちらかが落ちた。`~/.codex/sessions` の実際のログ 1,004 件の 1 行目は最大 23,446 バイト

## P3: Codex の review の前に、過去の決定を届ける

組み込みの review、プロンプトの `$名前`、モデルが shell で読む review の skill の 3 つで、ローカルの変更が触れる過去の決定が届く。`plugin/hooks/codex.json` は変えない。

- [x] T04: Codex の 3 つの入口から review の呼び出しを見分ける関数を足す
  - 種別: 追加
  - 計画: S4
  - 依存: T01（組み込みの review を見分けるのに `codexThread` の結果が要る）
  - 変更: `server/src/review-bridge.ts`, `server/test/review-bridge.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/review-bridge.test.ts` → pass。組み込み（子のスレッドで `subagent` が `review`）は `review` を返す / `$my-review` と `SPHICA_REVIEW_COMMANDS` に挙げた名前は返す / `$sphica:review`・`review` を含まない名前・文中の `a$review`・`agent_id` の付いた呼び出しは返さない / `cat …/skills/my-review/SKILL.md` は返し、この bundle の `skills/review/SKILL.md` を解決したパスは返さない / Codex では `CLAUDE_PLUGIN_OPTION_REVIEW_COMMANDS` を読まない / Claude Code の `reviewCall` の既存のテストは変えずに通る。続けて `bun run verify` → 終了コード 0
  - コミット: `feat(review): tell a Codex review from its built-in review thread, a named skill, or a skill file the model reads`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/review-bridge.test.ts` → pass。`codexReviewCall` のテスト 1 件が、組み込み・`$名前`・SKILL.md を読む shell の 3 つの入口と、当たらない入力（`$sphica:review`、変数の形の `$REVIEW_DIR`、`find`・`git add`・`wc`・リダイレクトでの書き込み、`agent_id` 付き、ほかの子のスレッド、Sphica 自身の skill のパス）を見ている。Claude Code の `reviewCall` の既存のテストは変えていない
  - 結果: `bun run verify` → 終了コード 0（受け入れ 138 件 pass）（T05 と同じ作業ツリーで流した）

- [x] T05: Codex では review を通常の配信に足し、重複抑制を会話の識別ごとにする
  - 種別: 変更
  - 計画: S4, S5
  - 依存: T03（子の id での会話の識別が要る。無いと組み込みの review の 2 回目が親の重複抑制で止まる）, T04（review の呼び出しを見分ける関数が要る）
  - 変更: `server/src/deliver.ts`, `server/test/review-bridge.test.ts`
  - 完了条件: `bun run verify` → 終了コード 0。テストで、組み込みの review で review の文面が返る / 親が同じで子が違う 2 回はどちらにも返る / 同じ子への 2 回目は返らない / `$my-review` で review と prompt の両方が返り、同じ変更の 2 回目は prompt だけ返る / skill の `SKILL.md` を名指しした shell で review が返り、同じ shell が名指しした別のファイルの記録も返る / shell が名指ししたファイルが無くても review は返る / Claude Code の review の配信は変わらない。`node server/evals/scale/run.ts` を流し、T01 の表と並べて、記録 1 万件で 1 回 1 秒以内のまま
  - コミット: `feat(deliver): give Codex's reviews the past decisions the local change touches`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/review-bridge.test.ts test/deliver-codex.test.ts test/deliver.test.ts` → tests 87、pass 87。組み込みの review は子ごとに届き、同じ子の 2 回目は出ない / `$my-review` は review と prompt の両方、同じ変更の 2 回目は prompt だけ / SKILL.md を読む shell は名指しのファイルが無くても review が届く / 時間切れは「読めなかった」と出て、その呼び出し本来の配信は返る
  - 結果: `bun run verify` → 終了コード 0（受け入れ 138 件 pass）。`plugin/dist/deliver.js` は 449,871 バイト（上限 450,000）
  - 結果: `node server/evals/scale/run.ts` → 直した後の作業ツリーで終了コード 0、99 行とも problems none。記録 1 万件（uniform）の中央値は prompt 143〜191 ms（前 130〜172）、read 69 ms（前 64）、名指しの shell 133 ms（前 124）、review 304〜313 ms（前 263〜272）、session start 78 ms（前 79）で、どれも 1 秒以内
  - 結果: `node dist/deliver.js codex` → `review-shipping` が pack した配布物で、直す前の作業ツリーを測った: 3 つの入口とも文面が返り、review が足す時間は約 200 ms（62 ms → 267 ms）。Claude Code は 39 通りの hook 入力で、HEAD と出力・配信の行・1 回きりの印が同じ。git を遅くすると 5 秒で止められて何も出ない場合があった（下の記録の指摘 1・2。直した後の実機での確認は T06）

## P4: 文書と、配布前の確認

README と forget の Skill が両ホストの今の動きを言い、pack したプラグインを実機の Codex で確かめる。ここまで終えてから、全差分のレビュー、push、PR、CI、リリースに進む。

- [ ] T06: 配布前の確認を流し、その結果に合わせて README（英日）と forget の Skill を直す
  - 種別: 変更
  - 計画: S6, S8
  - 依存: T02（capture の動きが決まっていないと、記録されないものを README に書けず、配布前の確認もできない）, T05（review の 3 つの入口が動いていないと確かめられない）
  - 変更: `README.md`, `README.ja.md`, `plugin/skills/forget/SKILL.md`
  - 完了条件: `bun run verify` → 終了コード 0。その前に plan の A7（`npm pack` と `check-tarball.mjs`）、A8（`$sphica:forget` の通し）、A9（review の 3 つの入口と TUI の `/review`、capture）を流し、それぞれ何回中何回かを結果行に書いてある。`rg -n "Claude Code only|no review hook in Codex|may not appear in Codex" README.md plugin/skills` → 0 件。`rg -n "Codex にはレビューのフックがありません|Codex では出ないことがあります" README.ja.md` → 0 件
  - コミット: `docs: say what Codex's reviews get, what its capture leaves out, and that forget works there`

## 記録

- 2026-10-13 / T01 / 変更欄を変えた。前: `server/src/codex-log.ts`, `server/src/deliver.ts`, `server/test/codex-log.test.ts` と 4 つのバージョンのファイル。後: それに `server/test/codex-log-file.ts`（テスト用のログを書く helper。T02 以降の capture と配信のテストでも使う）、`server/test/deliver.test.ts`（手元の helper をやめて共有のものを import）、`scripts/lib/bundle-budget.mjs` を足した / 理由: helper を 2 か所に持たないため。`plugin/dist/deliver.js` が 445,640 バイトになり上限 445,000 を超えたので、上限を 450,000 に上げた（T03・T05 でも deliver は増える。足りなければそのコミットで理由を書いて上げる）
- 2026-10-13 / T01 / `bun run release:plan` は staged の差分（`git diff <base> --cached`）を見る。コミット前に変更を stage してから流さないと `none` と出る / stage してから流して `plugin` を確かめた
- 2026-10-13 / T02 / 変更欄を変えた。前: `server/src/capture.ts`, `server/test/capture.test.ts`, 受け入れの `cases.json`・`driver.ts`, `server/test/acceptance-cases.test.ts`, `scripts/check-hooks-live.mjs`。後: それに `server/src/once.ts` と `server/src/deliver.ts`（1 セッションに 1 回の印 `markOnce` を deliver から共有の module に出した。capture は deliver を import できない）、`server/evals/acceptance/load.ts`（セッションの `thread` 欄）、`scripts/lib/bundle-budget.mjs`（`cli.js` が 632,532 バイトになり上限 632,000 を超えたので 636,000 に上げた。CLI は capture.ts を bundle する）を足した / plan の方針 2 は印を「capture のセッションごとのディレクトリ」に置くとしていたが、そこはターンの起点のファイルだけを置く決まり（knowledge-schema の Skill）なので、配信と同じ一時ディレクトリの印にした
- 2026-10-13 / T02 / 実測を足した（Codex 0.162.1、TUI、1 回中 1 回）: 走っているターンを Esc で止めると Interrupt の hook が出て、入力は `cwd, hook_event_name, model, permission_mode, session_id, transcript_path, turn_id`。ログの 1 行目は `payload.id === session_id`、`thread_source` は `user`。capture が読む 5 つのイベント全部が `transcript_path` を持つ
- 2026-10-13 / T02 / `review-shipping` の指摘: `codex exec --ephemeral` は `transcript_path` が null で、修正後は記録されなくなる（今は記録される）。Claude も実測し、review の子も同じ欄になることを確かめた / 持ち主に聞き、記録しないと決まった。plan を直し（変更履歴）、通知の文面をログのパスが無いときと有るときで分け、テストに null の入力を足した。README への記載は T06
- 2026-10-13 / T02 / `review-shipping` の指摘のうち採らなかったもの: 通知の印が一時ディレクトリにあり、TMPDIR が呼び出しごとに違うと通知がもう 1 回出る / 配信の印と同じ性質で、記録は止まらないので変えない
- 2026-10-13 / T02 / Codex のタスクごとのレビュー（新しい会話、コミット 8f844ca2、high）: 指摘 0 件。読んだだけで、テストは流していないと申告 / 採否の判断は不要
- 2026-10-13 / T03 / `review-shipping` の指摘 3 件の採否。(1) review の重複抑制のキーが session のまま → T05 で直す（計画どおり）。(2) revision と unavailable の 1 回きりの印は session ごとで、子と親が共有する（この変更の前から同じ）→ 変えない。会話ごとにすると Claude Code の subagent ごとに通知が出るようになり、子が親より先に revision の食い違いに当たる場面は見ていない。(3) `Entry` のコメントが subagent だけを言っていた → 直した。`db/schema.sql` の `delivery.agent_id` のコメントは schema のファイルなので触っていない
- 2026-10-13 / T03 / 配信の一覧（`server/src/delivery-view.ts`）は `agent_id` のある行を subagent と数えるので、Codex の review の子は `subagent <スレッドの id>` と出る / 数え方としては合っているので変えない
- 2026-10-13 / T03 / Codex のタスクごとのレビュー（新しい会話、コミット 75cfd805、既定の effort）: 指摘 0 件。読んだだけで、テストは流していないと申告 / 採否の判断は不要
- 2026-10-13 / T05 / 変更欄を変えた。前: `server/src/deliver.ts`, `server/test/deliver-codex.test.ts`。後: `server/src/deliver.ts`, `server/test/review-bridge.test.ts` / review の照合は既定ブランチ（origin/HEAD）のある checkout が要り、その fixture は `review-bridge.test.ts` にある
- 2026-10-13 / T04, T05 / 1 つのコミットで終える。T04 の関数を使うのは T05 の配信だけで、出荷前レビューと Codex のレビューを 1 回ずつにするため
- 2026-10-13 / T05 / review の配信の受け入れケースは足していない。受け入れの review の層は MCP の `review_select` を見ていて、hook からの review の配信は Claude Code の分も `server/test/review-bridge.test.ts`（実際の SQLite と git の checkout）で見ている。Codex の分も同じ場所に足した
- 2026-10-13 / T04, T05 / `review-shipping` の指摘 6 件の採否。(1) review が先に走り、git が遅いと 5 秒の上限でその呼び出し本来の配信ごと止められる → 直した。本来の配信を先に作り、review は hook の開始から 3.5 秒までで打ち切る（文面の順は review が先のまま）。(2) 1 回きりの印を出力の前に付けるので、その後に止められると同じ変更が二度と届かない → (1) の順序で、印の後に残るのは配信のログの書き込みだけになった（Claude Code の今の経路と同じ）。印の順は変えていない。(3) 名前の規則が広すぎる → 絞った。プロンプトでは変数の形（大文字・数字・`_` だけ）を skill と見ない。shell では、ファイルを表示するコマンド（`cat`・`sed`・`head`・`tail`・`nl`・`less`・`more`・`bat`・`type`・`Get-Content`・`gc`）がそのパスを読み、そこへリダイレクトしていないときだけ当てる。残るもの: `$reviewers` のような小文字の名前と、`preview` を含む名前（Claude Code の今の規則と同じ「review を含む」）。(4) Sphica 自身の skill は、リンク越しのプラグインのパスでは見分けられない → hook が起動されたときのパス（`process.argv[1]`）の隣も見るようにした。`cd` してからの相対パスや大文字小文字の違いは見分けられず、Sphica 自身の review の前に文面が 1 回出る。(5) テストの無い行 → `realpathSync` は消した。review のときに snapshot を取らない条件（`!call`）は、取っても見える違いが時間だけなのでテストを足していない。(6) `toldBefore` のコメント → 直した
- 2026-10-13 / T05 / 時間切れのときに `localChange` が「既定ブランチが無い」「履歴を共有していない」と言う箇所を見つけ、時間切れと言うように直した（git が時間で止められたときだけ。Claude Code の経路にも効く）/ review の打ち切りを 3.5 秒にしたことで当たりやすくなるため
- 2026-10-13 / T05 / plan の方針 4・5 を直した（変更履歴）。範囲は狭まる向きなので Go は取り直していない
