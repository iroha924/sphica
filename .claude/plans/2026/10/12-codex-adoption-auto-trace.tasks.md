---
kind: tasks
plan: 12-codex-adoption-auto-trace.plan.md
branch: feat/codex-adoption-auto-trace
base: main
---

# Codex でも、AI 自身の決定を採用し、新しい対話のセッションで自動の trace を走らせる（#333 の Items 2・3） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: record サーバーが Codex の対話を見分ける

3 つの値を送る Codex の呼び出しが対話になり、trace で AI の決定が採用される。子のスレッドと `codex exec` は採用されず、対話でない呼び出しには自動の trace の一覧が返らない。

- [x] T01: `callerOf` が Codex の本人のスレッドの対話を見分け、本人のスレッドでない呼び出しのターンを置かない。バージョンを上げる
  - 種別: 修正
  - 計画: S1, S7
  - 依存: なし
  - 変更: `server/src/caller.ts`, `server/src/trace.ts`, `server/test/caller.test.ts`, `server/evals/acceptance/driver.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - red: `cd server && node --import ./test/isolate-home.ts --test test/caller.test.ts` → 直す前は、子のスレッド（`thread_source: "subagent"`、`thread_id` が `session_id` と違う）の呼び出しの `turn` が子のターンのままで null にならず、対話の呼び出しの mode が `unknown` のままで落ちる
  - 完了条件: `bun run verify` → 終了コード 0。その前に `bun run release:plan -- --base 47b5d0e2` の種別が `plugin` で、上げたバージョンが npm に無いこと（`npm view sphica versions --json`）を確かめる
  - コミット: `fix(record): tell an interactive Codex thread from a child thread, and bump the version`
  - 結果: red を実測（直す前の `callerOf` で `node --import ./test/isolate-home.ts --test test/caller.test.ts` が 2 件 fail: 対話の mode が `unknown` のまま、子のスレッドの `turn` が `cx-child-t` のまま）。直した後は 7 pass / 0 fail。ステージした状態で `bun run release:plan -- --base 47b5d0e2` → `plugin`（inputs: `server/src/caller.ts`, `server/src/trace.ts`）。`npm view sphica versions` の最新は 0.6.51 で、0.6.52 に上げた。`bun run verify` → 終了コード 0（受け入れ 137 pass / 0 fail）

- [x] T02: 実測の形の `_meta` を付けた呼び出しを実際の record サーバーへ送り、採用が通る場合と通らない場合を確かめるテストを足す
  - 種別: 追加
  - 計画: S2
  - 依存: T01（Codex の呼び出しが `interactive` になり、子のターンが null になる判定が要る）
  - 変更: `server/test/codex-caller.test.ts`, `server/test/record-world.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/codex-caller.test.ts` → pass。対話の begin と save で別のターンの返事が AI の決定として active、子のスレッド・exec・`daemon_recovery` が混ざると candidate、子のスレッドの呼び出しの後は親セッションの返事が全部 candidate、不正な引数の呼び出しは `record_call` に残らず何も保存されない。続けて `bun run verify` → 終了コード 0
  - コミット: `test(record): send Codex's measured call metadata through the record server`
  - 結果: `node --import ./test/isolate-home.ts --test test/codex-caller.test.ts` → 8 pass / 0 fail（T03 の 2 件を含む）。本人のスレッドの begin と save で別のターンの返事が `agent` の採用で active、trace を流したターンの返事・exec・`daemon_recovery`・`thread_source` 無し・`thread_id` 無し・子のスレッドは candidate、子のスレッドが `trace_pending` を呼んだ後は親セッションの返事が candidate、`session: 17` の `trace_begin` は `record_call` が 0 行。begin と save でセッションが違う場合は save が「This run was begun in another session」で断られる（candidate ではなく拒否）。`bun run verify` → 終了コード 0

- [x] T03: `trace_pending` の `auto: true` を、Codex の対話でない呼び出しには返さない
  - 種別: 変更
  - 計画: S3
  - 依存: T01（Codex の呼び出しの mode が `interactive` になる判定が要る。無いと Codex の全部の呼び出しを断ってしまう）, T02（実際の record サーバーへ `_meta` を送るテストの土台が要る）
  - 変更: `server/src/mcp-record.ts`, `server/test/codex-caller.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/codex-caller.test.ts` → pass。Codex の `unknown` と `headless` の `auto: true` は一覧を返さず、対話の `auto: true` は自分以外の一覧を返し、Claude Code の `auto: true` は今のまま。続けて `bun run verify` → 終了コード 0
  - コミット: `feat(record): refuse the automatic trace list to a Codex call that is not interactive`
  - 結果: 止めを外した `mcp-record.ts` で `--test-name-pattern="automatic trace list goes only"` が fail（子のスレッドに一覧が返る）ことを確かめ、戻して pass。Codex の子のスレッド・exec・`daemon_recovery`・`thread_source` 無しの `auto: true` は「the automatic trace does nothing this time」、本人のスレッドは自分以外の一覧、Claude Code は今のまま。`bun run verify` → 終了コード 0

## P2: 新しい対話の Codex のセッションで自動の trace を案内する

SessionStart の hook がセッションのログの 1 行目で対話を見分け、`codex-tui` の新しいセッションにだけ、trace の SKILL.md を名指しした案内を出す。

- [x] T04: hook の入力の `transcript_path` の 1 行目から、Codex の対話のセッションかを読む関数を足す
  - 種別: 追加
  - 計画: S4
  - 依存: T01（バージョンを上げた後でないと、package に入るファイルを変えるコミットを pre-commit が断る）
  - 変更: `server/src/capture.ts`, `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/deliver.test.ts` → pass。`codex-tui` で `payload.id` が一致するログだけ対話、`codex_exec`・ファイル無し・通常ファイルでない・途中で切れた JSON・空やオブジェクトでない payload・別のセッションの id・subagent・1 行目が 256 KiB を超えるものは対話でない、短い 1 行目 + 大きな残りは対話。続けて `bun run verify` → 終了コード 0
  - コミット: `feat(deliver): read whether a Codex session is interactive from its log's first line`
  - 結果: `node --import ./test/isolate-home.ts --test --test-name-pattern="Codex session is interactive" test/deliver.test.ts` → pass。`codex-tui` で `payload.id` が一致するログだけ対話。1 行目 200 KiB は通り 300 KiB は通らない、短い 1 行目 + 1 MiB の残りは通る。`codex_exec`・未知の originator・subagent・別のセッションの id・`session_id` 無し・相対パス（良いログに届くもの）・リンク（Windows 以外）・ディレクトリ・ファイル無し・空・途中で切れた JSON・payload が null や配列・`session_meta` でない行は通らない。`bun run verify` → 終了コード 0

- [x] T05: 新しい対話の Codex のセッションに、SKILL.md のパスを名指しした自動の trace の案内を出す
  - 種別: 変更
  - 計画: S4
  - 依存: T04（ログの 1 行目で対話を見る関数が要る）, T03（案内を受けたエージェントが呼ぶ `auto: true` を、対話でない呼び出しに返さない止めが先に要る）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`, `scripts/check-hooks-live.mjs`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/deliver.test.ts` → pass。Codex の `codex-tui` の新しいセッションで `AUTO_TRACE`（パス入り）が同じセッションで 1 回だけ出る、`source: "resume"`・off（`off`, `0`, `false`, `no`）・待ち 0 件・長すぎるパス・制御文字を含むパスでは今の案内、Claude Code の文面は変わらない。続けて `bun run verify` → 終了コード 0
  - コミット: `feat(deliver): ask a new interactive Codex session to trace on its own`
  - 結果: `node --import ./test/isolate-home.ts --test --test-name-pattern="auto trace notice|a path is named|trace Skill's file" test/deliver.test.ts` → pass。Codex の新しい対話のセッションに、SKILL.md の絶対パスをバッククォートで囲んだ `AUTO_TRACE` が 1 回だけ出る。自分のセッションは数えない。resume・`source` 無し・`codex_exec`・未知の originator・subagent・ログ無し・別のセッションのログ・off の各表記（off, 0, false, no, 前後に空白のある OFF）・待ち 0 件・14 日超では出ない。Claude Code の文面は既存のテストのまま通る。bundle の `deliver.js` は 444,946 バイト（上限 445,000）。`bun run verify` → 終了コード 0（`hooks:live` が、空白と引用符を含むプラグインの場所から起こした Codex の SessionStart で、pack した中の SKILL.md が名指しされることを見る。SKILL.md を消した写しでは「did not name the packed trace Skill」で落ちることを確かめた）

## P3: Skill・文書・配布前の確認

trace の Skill と README が両ホストの今の動きと残る差を言い、実際のプラグインで動きを確かめる。

- [x] T06: trace の Skill の「On your own」と採用の条件を、Codex でも成り立つ文面に直す
  - 種別: 変更
  - 計画: S5
  - 依存: T03（`trace_pending` が「自動で trace しない」と返す文面が要る）, T05（Codex の案内が SKILL.md を名指しする動きが要る）
  - 変更: `plugin/skills/trace/SKILL.md`
  - 完了条件: `bun run verify` → 終了コード 0。`rg -n "Codex does not start this Skill on its own yet" plugin/skills` → 0 件
  - コミット: `docs(trace): say when the trace Skill runs on its own in Codex`
  - 結果: `rg -n "Codex does not start this Skill on its own yet" plugin/skills` → 0 件。「On your own」を両ホストの文面にし、`trace_pending` が「the automatic trace does nothing this time」と返したら止まる、Codex の子のスレッドと `codex exec` は採用できない、を書いた。`bun run verify` → 終了コード 0（`verify:ai` を含む）

- [x] T07: README（英日）・検査のコメント・配布の Skill を直し、配布前の確認を流して結果を PR 本文に書く
  - 種別: 変更
  - 計画: S6, S8
  - 依存: T01（採用の条件の言い方が要る）, T05（自動の trace の条件の言い方が要る）, T06（Skill の文面と README の言い方を揃える）
  - 変更: `README.md`, `README.ja.md`, `scripts/check-ai-config.mjs`, `.agents/skills/plugin-release/SKILL.md`
  - 完了条件: `bun run verify` → 終了コード 0。plan の A5 の `rg` が 0 件。配布前の確認（plan の「リリース」の手順）の 5 項目それぞれについて、何回中何回かを PR 本文の「配布前の確認」の節に書いてある
  - コミット: `docs: say what Codex adopts and traces on its own, and what the background server's environment decides`
  - 結果: `bun run verify` → 終了コード 0。plan の A5 の `rg` → 0 件。配布前の確認を流した（Codex 0.162.1、macOS、一時の HOME、`env -i` の環境、専用の常駐プロセス、pack した 0.6.52 を手元の marketplace から `codex plugin add` で入れ、起動時の画面で hook 10 個を信頼）: (a) 案内が届いた対話の新しいセッション 4 回のうち 3 回で、エージェントが依頼の後に自分で trace を流し、待っていたセッションが保存された（走らなかった 1 回は依頼が「Say hello in one line.」で、案内はログに届いていた）。record ツールの呼び出し 23 回はどれも `interactive` / `user`。 (b) 1 回目の自動の trace で、別のセッションの AI の返事（「I chose src/util.ts …」）が `agent` の採用で active になった（1 回中 1 回）。その記録は後のセッションに AI の判断の印付きで配信された。 (c) `codex exec` 2 回とも `AUTO_TRACE` は届かず（1 日 1 回の案内は 1 回目に 1 回）、record ツールは呼ばれなかった。`codex exec '$sphica:trace pending'` の `trace_pending` は `headless` / `exec` で記録された（1 回）。exec での保存までは流していない。 (d) `SPHICA_AUTO_TRACE=off` を付けて常駐プロセスを起動し直した新しいセッション 1 回では `AUTO_TRACE` が届かず record ツールも呼ばれなかった。off を外して起動し直すと、次の新しいセッションで `AUTO_TRACE` が届いて trace が走った。 (e) 最初の対話 4 回と exec 3 回のセッション（その時点の 7 つ）がどれも新しく記録されていた。その後の対話 2 回の記録は見ていない。trace の Skill は `allow_implicit_invocation: false` のまま。片付け: 専用の常駐プロセスは pid ファイルの PID を確かめて kill（3 回）、`auth.json` へのリンクと一時の home を消した。持ち主の常駐プロセス（PID 51619, 8776）は起動時刻が変わっていない。PR 本文の「配布前の確認」の節には、PR を作るときにこの数字を書く

## P4: レビューで見つかった直し

全差分のレビューで見つかった、完了条件（文書がコードと実測に合う、コメントの規則）に当たる 2 点を直す。

- [x] T08: README の環境変数の段落を常駐プロセスを通るセッションに絞り、`caller.ts` の冒頭のコメントを 3 行にする
  - 種別: 変更
  - 計画: S6
  - 依存: T07（直す対象の README の段落）, T01（直す対象のコメント）
  - 変更: `README.md`, `README.ja.md`, `server/src/caller.ts`
  - 完了条件: `bun run verify` → 終了コード 0。README（英日）が「常駐プロセスを通るセッションでは起動時の環境、`codex exec` は起動した環境」と書いている
  - コミット: `docs: scope the background server's environment to sessions that run through it`
  - 結果: `bun run verify` → 終了コード 0。README.md と README.ja.md の段落を「常駐プロセスを通るセッション」に絞り、`codex exec` は起動した環境がフックに届くと書いた（実測 B3・B5）。`server/src/caller.ts` の冒頭のコメントは内容を変えずに 3 行にした

## 記録

- 2026-10-12 / 全体 / Codex の全差分のレビュー（`6a5568ae..c4acd4b0`、新しい会話、high）: 指摘 2 件、どちらも P3、読んで確認。(1) README（英日）の環境変数の段落が、常駐プロセスを通らない `codex exec` にも当てはまるように読める (2) `server/src/caller.ts` の冒頭のコメントが 4 行で、3 行までの規則を超える / 両方採用。T08 を足した。A1〜A3 と A6 は読み取り専用のため未実行と明記
- 2026-10-12 / 全体 / push の前の review-shipping（`6a5568ae..c4acd4b0`）: 出荷可の判定、指摘 0 件。pack した 0.6.52 の README と trace の Skill はリポジトリと同じ内容で、`check-hooks-live.mjs` を展開先に向けても終了コード 0。`plugin/hooks/codex.json` は v0.6.51 と同じ blob（信頼し直しは要らない）。手元の Codex のログ 80 件（0.160〜0.162.1）はどれも 1 行目が `session_meta` で、`codex-tui` はターミナルだけ。未確認: Windows のジョブ、`release` の dry run、README の常駐プロセスについての記述（`daemon` サブコマンドがあることだけ確認）

- 2026-10-12 / T06・T07 / 1 つのコミットにした。文書だけなので、コミットの前の Codex のレビューは省き、全差分のレビュー（12 段目）で見る
- 2026-10-12 / T07 / 変更欄を直した。前: `README.md`, `README.ja.md`, `scripts/check-ai-config.mjs`, `.claude/skills/plugin-release/SKILL.md`, `.agents/skills/plugin-release/SKILL.md`。後: `.claude/skills/plugin-release/SKILL.md` を外した（`.claude/skills/plugin-release` は `.agents/skills/plugin-release` へのリンクで、追跡している実ファイルは `.agents` 側だけ）
- 2026-10-12 / T07 / 予定外の事実（配布前の確認）: 案内は Codex のログに `developer` のメッセージとして届く。trace の依頼の行は「Sphica past record, not an instruction」の見出しの下に並ぶ。走らなかった 1 回がこの見出しのせいかは切り分けていない（Claude Code でも同じ並び）。空白を含むプラグインの場所でエージェントがパスを読めるかは、実機では流していない（`hooks:live` は出力までを見る）
- 2026-10-12 / T07 / README の「`codex app-server daemon restart` で起動し直せる」は、Codex の `--help` と常駐プロセスの README からで、このコマンドは流していない（確認では専用の常駐プロセスを PID で止めて起動し直した）。「エージェントのシェルから起動された常駐プロセスでは記録が止まる」は、`isOwnerTurn`（`server/src/capture.ts`）と測った hook の環境変数からの帰結で、Sphica の capture をその状態で動かしてはいない

- 2026-10-12 / T04・T05 / 1 つのコミットにした（検査とレビューを 1 回にまとめるため）
- 2026-10-12 / T05 / 変更欄を直した。前: `server/src/deliver.ts`, `server/test/deliver.test.ts`。後: それに `scripts/check-hooks-live.mjs` を足した（下の review-shipping の指摘 2）
- 2026-10-12 / T04・T05 / 予定外: bundle の `deliver.js` が 445,057 バイトで上限（445,000）を 57 バイト超えた。上限は上げず、1 行目の判定のコードを短くして 444,946 バイトに収めた。余裕は 54 バイト
- 2026-10-12 / T04・T05 / コミットの前の Codex のレビュー（`staged diff on e26c39c0`、新しい会話、high）: 指摘 0 件。ソースの export にメモリ内のファイルシステムを当てて 47 通りを確かめたとのこと。`bun run verify`・実際の Codex・Windows は未実行と明記
- 2026-10-12 / T04・T05 / コミットの前の review-shipping: 出荷可の判定。pack した 0.6.52 の `deliver.js` を一時の HOME と DB で hook として起こし、案内が展開先の `skills/trace/SKILL.md` を名指しすることを確認。hook の時間は中央値 85〜87 ms（ログ無しは 82〜84 ms）。手元の Codex のログ 995 件で 1 行目の最長は 23,446 バイト。指摘 4 件: (1) SKILL.md:61 と README.md:150 が tag の前に直っている必要がある（T06・T07 の予定どおり） (2) bundle が自分の隣の SKILL.md を見つける経路を、どの検査も通らない (3) 絶対パスの確認・通常ファイルの確認・`traceSkill` の中の `namable` を外してもテストが通る (4) 空白を含むパスを引用符なしで名指ししている / (2)(3)(4) を採用。(2) は `hooks:live` に確認を足し、(3) は良いログに届く相対パス・リンク・`traceSkill` に場所を渡すテストを足し、(4) はパスをバッククォートで囲んだ。Windows で Codex が書いている最中のログを開けるかは未確認
- 2026-10-12 / T04・T05 / 予定外: 最初のコミット（9dea4fdf）にチェックと結果の行が入らなかった（tasks を書き換えるスクリプトが文字コードのエラーで止まり、コミットのコマンドがそれで止まる形になっていなかった）。push の前だったので、同じコミットを作り直してチェックを入れた

- 2026-10-12 / T01〜T03 / 1 つのコミットにした（検査とレビューを 1 回にまとめるため）
- 2026-10-12 / T02 / 変更欄を直した。前: `server/test/codex-caller.test.ts`。後: `server/test/codex-caller.test.ts`, `server/test/record-world.ts`（`reply` がホストの `_meta` を受け取る引数を足した）
- 2026-10-12 / T01〜T03 / コミットの前の Codex のレビュー（`staged diff on 90bd2ed9`、新しい会話、high）: 指摘 0 件。ステージした 11 ファイル・plan・tasks を読み、`callerOf` の 15 通りを書き込みなしで実行したとのこと。`bun run verify` と子プロセスのテストは読み取り専用のため未実行と明記
- 2026-10-12 / T01〜T03 / コミットの前の review-shipping: 出荷可の判定。pack した 0.6.52 をリポジトリの外で展開して確認（53 ファイル、`dist` 6 件、`check-tarball.mjs` 終了コード 0、`dist/mcp-record.js` に新しい文面と `thread_source` があり、hook の bundle には無い）。直す前の `src` で新しいテスト 15 件中 7 件が fail、止めを `if (false)` にすると一覧のテストが fail、`thread_id === session_id` を外すと子のスレッドのテストが fail。指摘 1 件: README.md:150 と trace の SKILL.md:61 が、tag の前に直っている必要がある（T06・T07 で直す予定どおり）。Windows は未実行
