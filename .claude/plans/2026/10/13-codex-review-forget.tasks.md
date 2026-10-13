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

- [x] T07: review の時間の上限を review の配信全体に効かせ、SKILL.md を読む shell の見分けを「単純な 1 コマンド」だけにする
  - 種別: 修正
  - 計画: S4
  - 依存: T05（直す対象の review の配信と見分けの関数が要る）
  - 変更: `server/src/deliver.ts`, `server/src/review-bridge.ts`, `server/test/review-bridge.test.ts`, `scripts/lib/bundle-budget.mjs`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/review-bridge.test.ts` → 直す前（fa0e0d00）は、hook の開始から 10 秒たった呼び出しでも review が変更を読んで `checked 1 changed path` を返して落ちる。`cat skills/my-review/SKILL.md | head -50` や `git status; cat …/SKILL.md` のような複合の行を review と見て、「単純な 1 コマンド以外は見ない」のテストが落ちる
  - 完了条件: `bun run verify` → 終了コード 0。テストで、表示するコマンドで始まる単純な 1 コマンド（`cat <パス>`、`nl -ba <パス>`、複数のファイル、引用符付きのパス、Windows のパス）は review と見る / `;` `|` `&` `<` `>`、バッククォート、`$(`、改行を含む行と、`sed`（その場で書き換えもする）は見ない / 時間が残っていない review は「読めなかった」と言い、その呼び出し本来の配信は返る / 時間があれば同じ変更を読む
  - コミット: `fix(deliver): keep a Codex review inside its time limit, and read a skill file only from one plain command`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/review-bridge.test.ts` → `server/src/deliver.ts` と `server/src/review-bridge.ts` を `git stash` で fa0e0d00 に戻して流すと tests 19、fail 2（`cd /repo && cat .codex/skills/review/SKILL.md` が review と見られる / 開始から 10 秒たった呼び出しの review が `checked 1 changed path` を返す）。戻した後、配信の 3 つのテストファイルで tests 87、pass 87
  - 結果: `bun run verify` → 終了コード 0（受け入れ 138 件 pass。T06 の文面と同じ作業ツリーで流した）。`plugin/dist/deliver.js` は 450,027 バイトで、上限を 455,000 に上げた（Codex の review の配信の分）

- [x] T08: review の時間の上限を、未追跡ファイルの読み取りにも効かせる
  - 種別: 修正
  - 計画: S4
  - 依存: T07（review に渡す時間の上限と、時間切れの言い方が要る）
  - 変更: `server/src/review-bridge.ts`, `server/test/review-bridge.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/review-bridge.test.ts` → 直す前（fd1fc524）は `untrackedFiles` が無く、テストファイルが import で落ちる（元の `localChange` は未追跡ファイルを時間を見ずに全部読む）
  - 完了条件: `bun run verify` → 終了コード 0。テストで、時間が過ぎていれば未追跡ファイルを読まずに null を返す / 読むものが無ければ時間によらず空を返す / 時間があれば、読めたファイルは行ごとに、大きすぎる・無いファイルはパスだけを返す / `localChange` が追跡済みと未追跡の両方を変更に入れる
  - コミット: `fix(review): stop reading untracked files when the review's time is up`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/review-bridge.test.ts` → テストだけ足した状態（fd1fc524 のコード）では `The requested module '../src/review-bridge.ts' does not provide an export named 'untrackedFiles'` で落ちた。直した後、配信の 3 つのテストファイルで tests 87、pass 87
  - 結果: `bun run verify` → 終了コード 0（受け入れ 138 件 pass）。`plugin/dist/deliver.js` は 450,319 バイト（上限 455,000）

- [x] T09: ページャを表示するコマンドから外し、forget の Skill の「確認を出せない」の言い方を直す
  - 種別: 修正
  - 計画: S4, S6
  - 依存: T07（表示するコマンドの一覧が要る）
  - 変更: `server/src/review-bridge.ts`, `server/test/review-bridge.test.ts`, `plugin/skills/forget/SKILL.md`
  - red: `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern="Codex review is its built-in" test/review-bridge.test.ts` → 直す前（3cbdfbe0 のコード）は `less -O skills/my-review/SKILL.md -` が review と見られて落ちる
  - 完了条件: `bun run verify` → 終了コード 0。テストで、`less`・`more`・`bat` で始まる行は review と見ない / `cat`・`head`・`nl`・`type`・`Get-Content` は今までどおり見る。forget の Skill は、承認する人がいない headless の実行と、持ち主が承認や確認を断った場合を分けて言う
  - コミット: `fix(review): leave pagers out of the commands that read a skill, and say when forget cannot ask`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern="Codex review is its built-in" test/review-bridge.test.ts` → `server/src/review-bridge.ts` を `git stash` で 3cbdfbe0 に戻して流すと fail 1（`less -O skills/my-review/SKILL.md -` が review と見られる）。戻した後、配信の 3 つのテストファイルで tests 87、pass 87
  - 結果: `bun run verify` → 1 回目は終了コード 1。受け入れの retrieval-07 が 786 秒かかって落ち、retrieval-08 も落ちた。`pmset -g log` に 13:43:04〜13:56:12（788 秒）のスリープがあり、その間に止まっていた。`caffeinate -i bun run verify` で流し直して終了コード 0（受け入れ 138 件 pass）。`plugin/dist/deliver.js` は 450,296 バイト

## P4: 文書と、配布前の確認

README と forget の Skill が両ホストの今の動きを言い、pack したプラグインを実機の Codex で確かめる。ここまで終えてから、全差分のレビュー、push、PR、CI、リリースに進む。

- [x] T06: 配布前の確認を流し、その結果に合わせて README（英日）と forget の Skill を直す
  - 種別: 変更
  - 計画: S6, S8
  - 依存: T02（capture の動きが決まっていないと、記録されないものを README に書けず、配布前の確認もできない）, T05（review の 3 つの入口が動いていないと確かめられない）, T07（配布前の確認は、直した後の配布物で流す）
  - 変更: `README.md`, `README.ja.md`, `plugin/skills/forget/SKILL.md`, `server/src/mcp-record.ts`
  - 完了条件: `bun run verify` → 終了コード 0。その前に plan の A7（`npm pack` と `check-tarball.mjs`）、A8（`$sphica:forget` の通し）、A9（review の 3 つの入口と TUI の `/review`、capture）を流し、それぞれ何回中何回かを結果行に書いてある。`rg -n "Claude Code only|no review hook in Codex|may not appear in Codex" README.md plugin/skills` → 0 件。`rg -n "Codex にはレビューのフックがありません|Codex では出ないことがあります" README.ja.md` → 0 件
  - コミット: `docs: say what Codex's reviews get, what its capture leaves out, and that forget works there`
  - 結果: `node scripts/check-tarball.mjs <tgz>` → A7。最後の作業ツリーを `npm pack` した tarball で終了コード 0（53 ファイル）
  - 結果: `codex exec review --uncommitted` → A9。Codex 0.162.1、macOS、一時の HOME・DB と、pack した 0.6.53 をローカルの marketplace から実際のプラグインとして入れた一時の `CODEX_HOME`、hook は `--dangerously-bypass-hook-trust`。組み込みの review（exec）2 回中 2 回、`$review-probe …` 1 回中 1 回、暗黙の skill 1 回中 1 回、TUI の `/review` 1 回中 1 回で、delivery に event `review` の行（記録 1 件）が残り、組み込みは `agent_id` が子の id、子のログに Sphica の文面が developer メッセージとして入った。review の回答は記録された決定に触れた。合成のプロンプトは source に無く、`codex exec`・`codex exec resume` の本人の発言と応答は source にある。`--ephemeral` は発言が記録されず（1 回中 1 回）、その組み込みの review には review の配信も出ない（1 回中 1 回。README に書いた）
  - 結果: `codex --no-daemon -C <一時の repo> '$sphica:forget …'` → A8。同じ環境の TUI で、preview → ツールの承認 → 件数 `1` の入力 → `s6 was forgotten, and its deleted text was cleared from the database file. No record was affected.` と返り、source が DB から消えた（最後の配布物で 1 回中 1 回）
  - 結果: `rg -n "Claude Code only|no review hook in Codex|may not appear in Codex" README.md plugin/skills` → 0 件。`rg -n "Codex にはレビューのフックがありません|Codex では出ないことがあります" README.ja.md` → 0 件
  - 結果: `bun run verify` → 終了コード 0（受け入れ 138 件 pass）。その後に README の 1 文（`--ephemeral` の組み込みの review）を足し、`bun run check` → 終了コード 0
  - 結果: `bun run verify` → 出荷前レビューの指摘の直し（`sed` を外す、行の前後の空白、`forget_apply` の文面）の後の、コミットする作業ツリーでもう 1 回流して終了コード 0（受け入れ 138 件 pass）。`plugin/dist/deliver.js` は 450,015 バイト。配布前の確認（A8・A9）はこの直しの前の配布物で流した: 暗黙の skill の確認で Codex が使ったのは `cat <パス>` で、直しの影響を受けない

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
- 2026-10-13 / T04, T05 / Codex のタスクごとのレビュー（新しい会話、コミット fa0e0d00、既定の effort）: 指摘 3 件。F1（P1）review の 3.5 秒が効くのは変更の読み取りだけで、その前に review の配信がもう一度リポジトリを探す git を流す。F2（P2）`cat 2>/dev/null <SKILL.md>` のように、パスより前に `>` があるだけで読み取りを外してしまう。F3（P2）引用符の中の `;` で分けるので `sed -n '1,200p;201q' <SKILL.md>` を見落とし、here-document の中の行をコマンドと見る / F1・F2 と F3 の引用符は直す（修正タスク T07 を T05 の後に足した）。F3 の here-document は直さない: 当たっても変更の照合が 1 回走って文面が 1 回出るだけで、shell の解釈を広げるほうが数え落としが増える
- 2026-10-13 / T06 / 依存を変えた。前: T02, T05。後: T02, T05, T07 / 配布前の確認を、T07 で直した後の配布物で流すため。T07 の前に fa0e0d00 の配布物で流した分（組み込みの review、`$名前`、暗黙の skill、resume、ephemeral）は T06 の結果に参考として書く
- 2026-10-13 / T07 / `review-shipping` の指摘 4 件（直した後の作業ツリー）。(1) 引用符を追う分割が、閉じない `'` の後ろの読み取りを見落とす（コメント行の `skill's`、here-document の本文）。(2) 空白入りのパスへのリダイレクトを書き込みと見ず、読みと見る。(3) リポジトリを 1 回だけ探す直しを外しても通るテストしか無い。(4) `|` で分ける条件にテストが無い / (1)(2) は、T05 の出荷前レビューの後の絞り込み、Codex のレビューの後の直しに続いて、同じ箇所の直しが新しい欠陥を生んだ 2 回目。止めて持ち主に聞き、「単純な 1 コマンドだけを見る」に決まった（分割も引用符の解釈もやめる。外れたときは届かない側にだけ倒れる）。持ち主の 10 月の Codex のログでは、SKILL.md の読み方の上位は `cat <パス>`（約 1,300 回）と `nl -ba <パス>`（約 80 回）で、どれもこの形。(4) は分割ごと消えた
- 2026-10-13 / T07 / 欄を変えた。題名: 前「…shell の見分けを引用符とリダイレクトの向きで直す」→ 後「…『単純な 1 コマンド』だけにする」。red・完了条件・コミットの件名もそれに合わせた / 上の決定のため
- 2026-10-13 / T07 / 指摘 (3) にテストは足していない。リポジトリを探す git を 1 回にした効果は時間にしか出ない。`review-shipping` が pack した配布物で git を遅くして測った値: git の起動 1 回あたり 1.2〜2.2 秒の遅れで、直す前（fa0e0d00）は 5 秒で止められて何も出ず、直した後は 3.6〜4.6 秒でその呼び出し本来の配信が返り、review は「時間内に読めなかった」と言った。2.5 秒の遅れでは review の無い呼び出しも止められる（リポジトリを探す git だけで 5 秒を超える。この変更の前から同じ）
- 2026-10-13 / T06, T07 / `review-shipping` の指摘 5 件（T06 と T07 をまとめた作業ツリー）の採否。(1) `sed -i …/SKILL.md` が単純な 1 コマンドで、書き込みなのに review と見られる → 直した。表示するコマンドの一覧から `sed` を外した（その場で書き換えもするため。`sed -n` で読んだときは届かない）。(2) `;|&<>` を含まない書き込みのテストが無い → 足した（`sed -i`、`tee`、`cp`）。(3) `forget_apply` の返事が「Claude Code で流して」のままで、直した README と Skill に合わない → 直した（「対話の Claude Code か Codex のセッションで」）。plan の方針 7 は「コードは変えない」としていたが、返事の文面 1 か所だけ変えた。(4) Sphica 自身の review の skill は、`~` や相対のパスで読まれると見分けられない → 直さない。Sphica 自身の review の前に文面が 1 回出るだけで、見分けるにはパスの解釈を足すことになる。(5) 行末に改行が付いた 1 コマンドを見落とす → 直した（前後の空白を落としてから見る）。ほかの見落とし（`2>&1`、`LC_ALL=C cat …`、引用符の中の `>`）は届かない側なのでそのまま
- 2026-10-13 / T06 / 変更欄を変えた。前: `README.md`, `README.ja.md`, `plugin/skills/forget/SKILL.md`。後: それに `server/src/mcp-record.ts` を足した / 上の指摘 (3) のため
- 2026-10-13 / T06, T07 / 上の直し（一覧から 1 つ外す、空白を落とす、文面 1 か所、テスト）の後は、`review-shipping` をもう一度は流していない。全差分の Codex のレビュー（12 段目）で見る
- 2026-10-13 / T06, T07 / 1 つのコミットで終える。配布前の確認は T07 の直しを入れた配布物で流す必要があり、出荷前レビューも 1 回にするため
- 2026-10-13 / T06 / 配布前の確認の途中で分かったこと。(1) 一時の HOME を一時ディレクトリの下に置くと、Sphica の git の作業用ディレクトリが一時ディレクトリと重なり、review は「git worker would not start」と言う。TMPDIR を HOME の下に置いて流した（テストと同じ置き方）。(2) T07 の前（fa0e0d00）の配布物でも、組み込みの review（exec 1 回、TUI 1 回）、`$名前`、暗黙の skill、resume、`--ephemeral` は同じ結果だった。`$sphica:forget` は 2 回中 1 回: 1 回目は、エージェントが会話での確認を挟まずに進んだのに操作のスクリプトが確認を待っていて、終了時の Ctrl-C でツールの承認が取り消しになった（スクリプトの都合）
- 2026-10-13 / T06 / 未検証のまま残るもの: 記録しないセッションの通知（`systemMessage`）が Codex の画面に出るか（`codex exec` の標準出力には出なかった。TUI は見ていない）/ 常駐プロセス経由の対話 / デスクトップアプリと IDE 拡張 / `codex review`（hook の信頼を外すフラグが無い）/ Windows
- 2026-10-13 / 全差分 / Codex の全差分のレビュー（新しい会話、`main..fd1fc524`、high）: 指摘 1 件（P2）。review の 3.5 秒が効くのは git までで、その後の未追跡ファイルの読み取り（最大 500 件）は時間を見ない。Codex は module の mock で、500 件・1 件 10 ms の遅れのとき 5,000 ms かかって全部返ることを再現した（実際のホストでの打ち切りは未再現）/ 直す。修正タスク T08 を足した。直した後は、全差分をもう一度頼むのではなく、T08 のコミットだけを新しい会話でレビューさせる（全差分のレビューの指摘はこの 1 件で、直しは 1 つの関数に収まるため）
- 2026-10-13 / T06, T07, T08 / Codex のレビュー（新しい会話、コミット fd1fc524 と 3cbdfbe0、既定の effort）: 指摘 3 件、どれも P2。F1: 未追跡ファイル 1 件の読み取りそのものが固まると、時間の上限を越える（ファイルシステムが数秒止まる場合。読み取りを mock して再現）。F2: `less -O <SKILL.md> -` は標準入力をそのファイルへ書くのに、単純な 1 コマンドの読み取りと見られる。F3: forget の Skill が、持ち主がツールの承認を断った場合まで「このセッションは確認を出せない」と言う / F2・F3 は直す（修正タスク T09）。F2 はページャ（`less`・`more`・`bat`）を一覧から外す。F1 は直さない: 同期の読み取りを途中で止めるには読み取りを非同期に作り替える必要があり、ファイルシステムが秒単位で止まる状況では、その呼び出し本来の配信（DB の読み取り）も同じく止まる
- 2026-10-13 / 全体 / Codex のレビューは、T04・T05 で 3 件、全差分で 1 件、直近 2 コミットで 3 件と、回を重ねても 0 件にならない（重さは P2 まで、信頼の境界に関わる指摘は無い）。T09 の後は手元の Codex のレビューをこれ以上は重ねず、持ち主に状況を伝えて PR に進む（memory `review-rounds-cap`）。PR では GitHub の Codex のレビューが走る
- 2026-10-13 / 全体 / 配信の計測の 1 回目で 1 件だけ 610 秒止まった原因も Mac のスリープだった（`pmset -g log` に 13:02:57〜13:13:09 の 612 秒。その後の 2 回の流し直しと全体の 2 回目は問題なし）/ 長い検査は `caffeinate -i` を付けて流す
