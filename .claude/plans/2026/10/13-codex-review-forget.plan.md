---
kind: plan
status: approved
codex_session: 01a13140-61d5-70d0-b0a8-27cfa39f92d9
codex_rounds: 4
approved_at: 2026-10-13
---

# Codex でも review の前に過去の決定を届け、子のスレッドのプロンプトを持ち主の発言として保存しない（#333 の Items 4・5）

## 要点

- **修正（信頼の境界）**: Codex の組み込みの review は子のスレッドに合成のプロンプトを送り、今の capture はそれを持ち主の発言として保存する。TUI の「Review a commit」ではそこに commit の subject（他人が書ける）が入る。直した後の capture は、セッションのログの 1 行目で「このセッション自身のスレッド」だと確かめられた hook 呼び出しだけを記録する
- **その代償**: ログが読めない・形が違うときは、その Codex のセッションを記録せず、理由を 1 セッションに 1 回通知する。Codex がログの形を変えると、直すまで Codex のセッションは記録されない（持ち主の発言として保存する側には倒さない）
- **review の前の配信（Items 4）**: Codex の 3 つの入口（組み込みの review、プロンプトの `$名前`、モデルが shell で読む review の skill の `SKILL.md`）で、ローカルの変更が触れる過去の決定を届ける。今ある hook に乗るので `plugin/hooks/codex.json` は変えず、hook の信頼し直しは要らない
- **会話の数え方**: `agent_id` の付かない子のスレッド（組み込みの review）は、親とは別の会話として配信を数える。子に見せた記録を、親に見せたことにしない
- **forget（Items 5）**: 対話の Codex 0.162.1 で確認のフォームが通ることを実測した。コードは変えず、README と forget の Skill の文面を直す。配布前に `$sphica:forget` を最初から最後まで通して確かめる
- **進め方**: 修正が攻撃の経路を書くので、全タスクと全差分のレビューが終わるまでブランチを push しない。終わったら push・CI・リリースを続けて行う。1 つの PR、0.6.53 の見込み
- **変えないもの**: Claude Code の経路、DB の schema、`codex.json`、設定の置き場（Codex は環境変数のまま）。record ツールへの PreToolUse hook は今回も足さない

## 持ち主の決定

- #333 の Items 4 と 5 を 1 つの計画・PR・リリースにする。Items 5 は先に実機で流し、結果を計画に入れる（2026-10-13）
- `plugin/hooks/codex.json` を変える項目は 1 回のリリースにまとめる（Sphica の記録 `trace:8bdc90ff-42f1-4bac-bfe4-025b363fc083/codex-json-one-release`）
- Claude Code と Codex は、各ホストが許す限り同じ機能を持つ。片方でしか動かない変更は、もう片方に何が無いかを名指しし、README に差を書く（CLAUDE.md `host-parity`）
- Codex の設定は環境変数のまま（`SPHICA_REVIEW_COMMANDS`。issue #333 の末尾）
- Sphica 自身の review には届けない（自分で照合するため。今の Claude Code と同じ）
- 脆弱性の修正は、全タスクと全差分のレビューが終わるまで push せず、終わったら push・CI・リリースを続けて行う（memory `security-fix-push-late`、2026-10-09）
- README には今の挙動だけを書き、バージョン番号と経緯を書かない（`trace:58139139-1d29-40b1-be4a-f7e6e4d8a4cc/readme-current-only`）
- 観測された事例の無い防止策は計画に入れない（memory `observed-need-before-building`）
- 持ち主の実環境の常駐プロセスを止める・起動し直す操作はしない
- `codex exec --ephemeral` のセッションは記録しない。Codex がログのパスを渡さず、本人のプロンプトと組み込みの review の子のプロンプトを見分けられないため。最初のプロンプトで、記録しないことと `--ephemeral` を外せば記録されることを 1 回通知し、README に書く（実装中に持ち主が追加、2026-10-13）
- record ツールへの PreToolUse hook は今回も足さない。Sphica の質問の記録 `trace:ddaa270f-07bd-4d5a-85d0-43e9e78db0f9/codex-record-hook-open` は open のまま残す（Codex との議論の後に持ち主が追加、2026-10-13）

## 目的

- Codex の組み込みの review のプロンプト（定型文、commit の subject、custom instructions）が、source に保存されない
- ログを残すセッションの本人のスレッド（`codex exec`、TUI、resume、fork）の発言は、今までどおり保存される。`--ephemeral` のセッションは保存されず、最初のプロンプトでその理由が 1 回通知される
- 対話でも headless でも、Codex の組み込みの review を始めると、review する側のモデルの最初の入力に「この変更に当たる過去の決定」か「当たるものは無い」か「照合できなかった理由」が入る。同じ親セッションから review を 2 回始めても、2 回とも入る
- プロンプトに `$<review を含む名前>`（または `SPHICA_REVIEW_COMMANDS` に挙げた名前）を書くと、そのターンに同じものが入り、プロンプトが名指しした symbol・path の記録も今までどおり入る
- モデルが review の skill の `SKILL.md` を shell で名指しすると、その shell の前に同じものが入る。Sphica 自身の `skills/review/SKILL.md` では入らない
- 組み込みの review の子が読んだファイルの記録は、後で親が同じファイルを読んだときにも親に届く
- README（英語・日本語）と forget の Skill が、Codex で何が届くか、forget が対話の Codex で動くこと、組み込みの review に渡した指示は記録されないことを言う

## 対象外

- `plugin/hooks/codex.json` の変更と、record ツールへの PreToolUse hook
- すでに利用者の DB に入った行を自動で探す・消す仕組みと migration（リリースノートに、既存の `search`・`read`・`/sphica:forget` で確かめて消す手順を書く）
- Codex のデスクトップアプリと IDE 拡張、常駐プロセス経由の対話での実測
- `/skills` の選択画面から skill を選んだときに送られる文字列の実測（`$名前` が入るなら明示の skill に当たる）
- 組み込みの review の「commit」「base ブランチ」の範囲に、照合の範囲を合わせること（今の Claude Code の bridge と同じく、常に「作業ツリーと既定ブランチの merge base の差分 + 未追跡ファイル」を見て、その範囲を文面に書く）
- `notOwnWords` の引用の規則を変えること（入口の capture で止める）
- 環境変数に代わる設定の置き場、DB の schema の変更

## 前提

実測は 2026-10-13、Codex 0.162.1、macOS。一時の `CODEX_HOME`（持ち主の `auth.json` へのリンク、model と effort の 2 行、作業ディレクトリを信頼済みにした `[projects]`）と一時の `HOME`、対話は `--no-daemon`。回数を書いていないものは 1 回中 1 回。

forget（一時の DB に使い捨ての発言 3 件。record サーバーは Codex のプラグインのキャッシュにある 0.6.52 の `dist/mcp-record.js` を、一時の `config.toml` の `[mcp_servers.record]` に直接書いた）:

- F1. 対話で `forget_apply` を呼ばせると、先に Codex のツール承認（Allow / Allow for this session / Always allow / Cancel）が出て、Allow の後に確認のフォームが出た。`Forget 1 source for good?`、source の行、`Number of sources`、`Type 1 to forget 1 source` が見えた
- F2. `1` と Enter（2.5 秒あけて）: `Forgot 1 source. The deleted text was cleared from the database file.` が返り、DB から行が消えた
- F3. `2` と Enter: `The number typed does not match 1, so nothing was forgotten`。Esc: `You cancelled, so nothing was forgotten`。どちらも行は残った
- F4. `1` と Enter を 0.7 秒あけて送った最初の 1 回は `You cancelled` で終わった。Enter が確定にならず終了時の Ctrl-C で閉じたのか、別の理由かは切り分けていない
- F5. `codex exec`（持ち主の実際のプラグイン経由、HOME だけ一時）: `forget_preview` は通り、`forget_apply` は `MCP tool call requires approval, but approval policy is never` でサーバーに届く前に断られた
- 未検証: プラグインが読み込んだ record サーバー経由の対話。`$sphica:forget` の Skill を最初から最後まで流すこと（A8 で確かめる）

review（一時の `CODEX_HOME` に、入力を書き出す hook を全イベントに、`skills/review-probe/SKILL.md` を置いた。hook は `--dangerously-bypass-hook-trust`）:

- R1. `codex exec 'Review the local change with the review probe.'`（暗黙の skill）: PreToolUse（`Bash`）の `tool_input.command` が `cat <CODEX_HOME>/skills/review-probe/SKILL.md` だった
- R2. `codex exec '$review-probe check my change'`（明示の skill）: UserPromptSubmit の `prompt` は `$review-probe check my change` のまま。SKILL.md を読む shell は走らなかった
- R3. `codex exec review --uncommitted`: SessionStart と Stop は出ず、UserPromptSubmit が 1 回出た。`agent_id` は無く（子の PreToolUse・PostToolUse にも無い）、`session_id` は親のもの。`transcript_path` は子のスレッドのログで、1 行目は `type: "session_meta"`、`payload.id` が子の id（`session_id` と違う）、`payload.parent_thread_id == session_id`、`payload.source == {"subagent":"review"}`、`payload.thread_source == "subagent"`
- R4. TUI の `/review` →「Review uncommitted changes」: R3 と同じ形。`originator` だけ `codex-tui`
- R5. R2・R3・R4 で UserPromptSubmit の hook が `additionalContext` を返すと、ログに developer ロールのメッセージとして入り、モデルの最終回答がその中の合言葉を書いた。`codex exec review` の標準出力は review の JSON の説明だけを出すので、画面では見えない
- R6. 合成のプロンプトの文面: uncommitted は `Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.`、`--commit <sha>` は `Review the code changes introduced by commit <sha>. Provide prioritized, actionable findings.`、`--title "<t>"` を付けるか TUI の「Review a commit」で選ぶと `… commit <sha> ("<t>"). Provide …` で、TUI では `<t>` に commit の subject がそのまま入った。custom instructions は渡した文そのまま
- R7. `codex exec resume <id>` と `codex exec fork <id>` の SessionStart・UserPromptSubmit は、1 行目が `payload.id === session_id`、`thread_source: "user"`（fork は新しい `session_id` と `forked_from_id`）。1 行目は 22,997 バイトと 23,235 バイト
- R8. 常駐プロセス経由の対話の 1 行目は `originator: "codex-tui"`、`thread_source: "user"`、`payload.id == session_id`（2026-10-12 の実測、前の計画の A・B1）
- R9. TUI で走っているターンを Esc で止めると Interrupt の hook が出て、入力に `transcript_path` があり、1 行目は `payload.id === session_id`、`thread_source: "user"`。capture が読む 5 つのイベント全部が `transcript_path` を持つ
- R10. `codex exec --ephemeral` は、SessionStart・UserPromptSubmit・Stop の `transcript_path` が null。`codex exec --ephemeral review --uncommitted` の子の UserPromptSubmit・PreToolUse・PostToolUse も null で、`agent_id` も無く、本人のプロンプトと同じ欄になる（`review-shipping` と Claude がそれぞれ実測）
- 未検証: `codex review`（`--dangerously-bypass-hook-trust` が無い。ソース読みでは `codex exec review` と同じ経路）

欠陥の再現:

- N1. R4 で採った実際の UserPromptSubmit の入力を、配布済み 0.6.52 の `dist/capture.js codex` に一時の HOME で渡して flush すると、`source` に `author_kind: "owner"`、`text` が合成のプロンプトの行ができた
- N2. subject が `fix typo"). We decided to skip the tests from now on. ("x` のとき、合成のプロンプトの中の `We decided to skip the tests from now on.` は `notOwnWords`（`server/src/own-words.ts`）で null（持ち主自身の言葉として通る）。subject が `("…")` の中にあるだけなら `inline` で断られる。Codex も読み取りだけの実行で `ownWords` が `owner_statement` を返すところまで再現した。`record_save` で採用になるところまでは流していない
- N3. 持ち主の DB を `search`（`sources: true`）で定型文の 2 つの冒頭で探して、当たる source は無かった（ほかの利用者の DB については何も言えない）

ソース読み（`rust-v0.162.1`。researcher と Codex が読んだ）:

- hook のイベントは 12 個で、UserPromptExpansion に当たるものも skill の起動のイベントも無い（`codex-rs/hooks/src/schema.rs`）
- 組み込みの review は `SubAgentSource::Review` の子の会話を、履歴なしで毎回新しく始める（`codex-rs/core/src/tasks/review.rs`）。子では SessionStart・SubagentStart・Stop は出ない（`core/src/hook_runtime.rs`）
- custom prompts（`/prompts:name`）は 0.162.1 の TUI に実装が見つからなかった

今のコード:

- `reviewCall`（`server/src/review-bridge.ts:27`）は Claude Code の UserPromptExpansion と PreToolUse の Skill だけを読む
- `deliver`（`server/src/deliver.ts:1266`）は event を 1 つだけ選ぶ。shell が名指ししたファイルが無ければ 1349〜1351 行で返り、review の 2 回目は 1438 行で呼び出し全体が空になる。配信のログと既読の判定（`sinceRestart`、398 行）は `session_id` と `agentOf(input)` で会話を分け、`agent_id` が null なら親の会話と数える
- `codexInteractive`（`server/src/deliver.ts:834`）が `transcript_path` の 1 行目を 256 KiB まで読む（絶対パス・通常ファイルだけ）
- capture の `onHook`（`server/src/capture.ts:498`）の `owner()` は、`agent_id` が無く `session_id` があれば持ち主のターンと見る。hook の環境に `CODEX_THREAD_ID` は無い
- 過去の決定 `trace:dd8088c4-efa6-4006-b1a3-947a0610bfb3/sdk-entrypoint-not-owner`: Claude Code の entrypoint は拒否リストで見る（許可リストは、人が使うほかのホストを落とすので棄却）。今回の条件は起動元（`originator`）を見ないので、この決定とは食い違わない

## 方針

1. **ログの 1 行目を読む関数を 1 つにする。** `server/src/codex-log.ts` を作り、`codexThread(input)` が `{ id, originator, threadSource, parent, subagent }`（読めなければ null）を返す。読み方の制限は今の `codexInteractive` と同じ（絶対パス、`lstat` で通常ファイル、先頭 256 KiB の 1 行目、`session_meta`、payload が object）。`codexInteractive` はこれに乗せ、挙動は変えない
   - 本人のスレッド: `id === input.session_id` かつ `threadSource === "user"`
   - 子のスレッド: `threadSource === "subagent"` かつ `parent === input.session_id` かつ `id` が `agentOf` と同じ文字の制限（`^[\x21-\x7e]{1,200}$`）を通る
2. **capture（修正）**: host が codex のとき、`onHook` の `owner()` は今の `isOwnerTurn` に加えて「本人のスレッド」を求める。SessionStart・UserPromptSubmit・PostToolUse・Stop・Interrupt の全部に当たる
   - 子のスレッドだと確かめられた: 黙って何もしない（保存しない、ターンを開かない、送らない）
   - 判定できない（`transcript_path` が無い・読めない・形が違う・`id` が合わない）: 何もせず、UserPromptSubmit のときに理由を `systemMessage` で 1 セッションに 1 回出す（文面は `panel`。ログのパスが無いときは `--ephemeral` を外せば記録されること、ログがあるのに確かめられないときは Sphica と Codex の更新を案内する。印は配信と同じ一時ディレクトリの `markOnce`。capture のセッションごとのディレクトリは、ターンの起点のファイルだけを置く決まりなので使わない）
   - Codex の capture を流すテスト・受け入れの driver・`scripts/check-hooks-live.mjs` は、入力にログを付ける形に直す（今は `transcript_path` の無い入力を渡している箇所がある。`rg` で全部拾う）
3. **配信の会話の識別**: `deliver` の最初で 1 回だけ決め、全経路で使う。`agent_id` があればそれ、無くて host が codex で子のスレッドだと確かめられたらその子の id、それ以外は null（親）。使う場所は、配信のログの `agent_id`、`beforeRead` の既読と予算（`sinceRestart`）、shell の snapshot のキーと shell の後の配信（`afterShell`）、review の重複抑制のキー。ログが読めないときは今までどおり親として扱う（配信は権限を与えないので止めない）。`source.subagent` が `review` 以外の子にも同じ識別を使う。決めた識別は hook の入力の `agent_id` とは別に持ち、「`agent_id` の付いた呼び出しには review を届けない」の判定（方針 4）には元の `agent_id` を使う
4. **review の入口（Codex）**: `reviewCall` に host とログの結果を渡す。Claude Code の分岐は変えない
   - 組み込み: UserPromptSubmit、`agent_id` が無い、子のスレッドで `subagent === "review"` → `{ name: "review", args: "" }`
   - 明示: UserPromptSubmit、上に当たらない、`prompt` の中の `$名前`（`\$([\w.:/-]{1,100})`、直前が行頭か空白）のうち、名前の規則（`sphica:review` を除き、`review` を含むか `SPHICA_REVIEW_COMMANDS` にある）に最初に当たったもの。args はプロンプト（1000 字まで）。`CLAUDE_PLUGIN_OPTION_REVIEW_COMMANDS` は Codex では読まない
   - 暗黙: PreToolUse の `Bash`、`tool_input.command` が `skills/<名前>/SKILL.md` で終わるパスを名指しし、`<名前>` が同じ規則に当たる。そのパスを解決した先が、この bundle 自身の `skills/review/SKILL.md`（`traceSkill` と同じ探し方）なら届けない。args は空
   - `agent_id` の付いた呼び出し（spawn した subagent の中）では届けない（今の Claude Code と同じ）
5. **Codex では review を通常の配信に足す**: review の文面は、その hook 呼び出しの通常の配信（prompt / pre_read / pre_edit）と別に作り、review を先にしてつなぐ。shell が名指ししたファイルが無くても、`rels` が空でも、review の照合は走る。重複抑制が止めるのは review の部分だけ。pre_read は今の `lockedPlan` のまま。配信のログは部分ごとに 1 行。組み込みの review の子のプロンプトも通常の prompt の配信を通す（custom instructions が symbol や path を名指しすることがある）
6. **重複抑制のキー**: 3 の識別を使う。組み込みの review は子の id ごと（親が同じでも review のたびに届く）、明示・暗黙は今までどおり親の会話ごと
7. **forget**: コードは変えない。README の `(Claude Code; the confirmation dialog it needs may not appear in Codex)` を、対話の Codex でも動くこと、headless（`codex exec`、`claude -p`）では確認を出せないので何も消えないことに直す。forget の Skill の「some Codex versions」の段も同じ内容にする。A8 が通らなければ、実測した範囲（確認のフォームまで）だけを書く
8. **README（英語・日本語）**: 「Before a review (Claude Code only)」と「There is no review hook in Codex」を直し、Codex の 3 つの入口、照合の範囲、拾えない読み方（パスを書かずに `SKILL.md` を読む）、名前の追加は `SPHICA_REVIEW_COMMANDS` だけであること（Codex の環境変数の一覧にも足す）、組み込みの review に渡した指示は記録されないこと、`--ephemeral` のセッションは記録されないこと、ログが読めないと Codex のセッションは記録されず通知が出ることを書く
9. **リリースノート**: 更新前に Codex の組み込みの review を使った人向けに、定型文の冒頭（`Review the current code changes`、`Review the code changes`）で `search`（`sources: true`）→ `read` で確かめる → `/sphica:forget` の手順を書く。検索では custom instructions を網羅できないこと、消した source を引用していた記録の本文は残ることを添える
10. **順序とバージョン**: 変更を作る → `bun run release:plan -- --base v0.6.52` → npm と 3 つの manifest を 0.6.53 に上げる（パッケージに入る最初のコミットに入れる。pre-commit がそれより前のコミットを断る）
11. **push しない**: 作業ブランチは手元だけに置く。タスクごとのレビューも全差分のレビューも手元の Codex で済ませ、終わってから push、PR、CI、リリースを続けて行う。issue #333 へのコメントと PR 本文はそのときに出す

## 採った案と棄却した案

- 採用: 今ある UserPromptSubmit と Bash の PreToolUse で拾う。棄却: `codex.json` に review 用の hook を足す（Codex に review や skill のイベントが無く、足しても拾えるものが増えない。信頼し直しだけが増える）
- 採用: 組み込みの review はログの 1 行目で見分ける。棄却: 合成のプロンプトの文面で見分ける（文面が変わると黙って外れる）
- 採用: capture は、本人のスレッドだと確かめられたときだけ記録する。棄却: 子だと確かめられたときだけ落とし、読めなければ今までどおり持ち主の発言として保存する（確かめられない文に採用の権限を与える経路が残る。Codex の指摘 C13）
- 採用: `--ephemeral` のセッションは記録しない。棄却: ログのパスが null のときだけ今までどおり保存する（`codex exec --ephemeral review --commit … --title …` の合成のプロンプトが持ち主の発言として残る経路が残る）
- 採用: 子のスレッドの id を配信の全経路の会話の識別に使う。棄却: review と prompt の配信だけに使う（子が読んだ別のファイルの記録が、親に見せたことになる。C14）
- 採用: 組み込みの review の重複抑制は子の id ごと。棄却: 親の session ごと（2 回目の review の新しいモデルに届かない。C1）
- 採用: Sphica 自身の review の skill は、解決したパスで除く。棄却: ディレクトリ名で除く（配布物のパスは `skills/review/SKILL.md` で、名前は `review`。C2）
- 採用: すでに入った行は、リリースノートの手順と既存の forget に任せる。棄却: 自動の検出・削除・migration
- 採用: record ツールへの PreToolUse hook は今回も足さない。棄却: 今回足す（それだけのために `codex.json` が変わり、信頼し直しが要る。困った事例は無い）

## 手順

- S1: `server/src/codex-log.ts` に `codexThread` を作り、`codexInteractive` をそれに乗せる（挙動は変えない）
- S2: capture の `owner()` に「本人のスレッド」の条件を足し、判定できないときの通知を出す（修正。受け入れケースとテストを先に足して落ちることを確かめる）。Codex の capture を流すテスト・driver・`check-hooks-live.mjs` の入力にログを付ける
- S3: `deliver` の会話の識別を 1 回決めて全経路で使う
- S4: `reviewCall` に Codex の 3 つの入口を足し、Codex では review を通常の配信に足す。重複抑制のキーを識別に合わせる
- S5: `node server/evals/scale/run.ts` を変更の前（main）と後で流し、表を残す
- S6: README・README.ja・forget の Skill の文面
- S7: `release:plan` を流してから、バージョンを 0.6.53 に上げる（パッケージに入る最初のコミット）
- S8: 配布前の確認（一時の HOME・DB・`CODEX_HOME` に pack したプラグインを入れる）: review の 3 つの入口と TUI の `/review`、capture、`$sphica:forget` の通し。結果は tasks の結果行に書き、push のときに PR 本文へ移す

## 完了条件

- A1: `bun run verify` → 0 で終わる
- A2: `cd server && node --import ./test/isolate-home.ts --test test/capture.test.ts` → 本人のスレッドのログでは 5 つのイベントが今までどおり動く / 子のスレッドのログでは何も置かず通知も出ない / ログが無い・256 KiB を超える・JSON でない・`id` が違うときは何も置かず、UserPromptSubmit で通知が 1 回だけ出る、の各テストが通る。直す前のコードで、子のスレッドのプロンプトが spool に置かれて落ちることを先に確かめる
- A3: `cd server && node --test --test-timeout=60000 evals/acceptance/run.ts` → 足した capture のケース（組み込みの review のプロンプトが source にならない）が通る。直す前に意図した理由で落ちることを先に確かめる
- A4: `cd server && node --import ./test/isolate-home.ts --test test/review-bridge.test.ts test/deliver-codex.test.ts test/deliver.test.ts` → 組み込みの review で review の文面が返る / 親が同じで子が違う 2 回はどちらにも返る / 同じ子への 2 回目は返らない / `$my-review` で review と prompt の両方が返り、2 回目は prompt だけ返る / `cat …/skills/my-review/SKILL.md` で review が返り、同じ shell が名指しした別のファイルの記録も返る / `$sphica:review` と、この bundle の `skills/review/SKILL.md` では返らない / Codex では `CLAUDE_PLUGIN_OPTION_REVIEW_COMMANDS` を読まない / 子が読んだファイル B の記録が、後で親が B を読んだときにも返る / 親の既読が子への配信を止めない / 子の shell の後の配信が親の snapshot と混ざらない / `codexInteractive` の既存のテストがそのまま通る
- A5: `node server/evals/scale/run.ts` → main と作業ブランチで 1 回ずつ流した両方の表が PR 本文にあり、記録 1 万件で 1 回 1 秒以内のまま
- A6: `bun run release:plan -- --base v0.6.52` → `plugin`（バージョンを上げる前に流す）
- A7: `cd plugin && npm pack` の tarball に `node scripts/check-tarball.mjs <tgz>` → 0 で終わる
- A8: `codex --no-daemon -C <一時の repo> '$sphica:forget <使い捨ての発言>'` → 配布前、一時の HOME・DB と、pack したプラグインを入れた一時の `CODEX_HOME` で、対話のまま出典の選択・preview・確認・apply・報告まで進み、選んだ source が DB から消える。通らなければ方針 7 のとおり README を実測した範囲にする
- A9: `codex exec review --uncommitted` → 配布前、A8 と同じ環境で、これと TUI の `/review`、`codex exec '$<review の skill> …'`、暗黙の skill を流すと、delivery に event `review` の行があり（組み込みは `agent_id` が子の id）、子のログに Sphica の文面が developer メッセージとして入っている。合成のプロンプトは source に無く、`codex exec`・TUI・`codex exec resume` の本人の発言は source にある。回数を報告する
- A10: `bun run release:status` → push の後、`gh pr checks <PR>` の全項目が pass、`gh run watch <release の run> --exit-status` が 0 で、`release ledger is consistent` と出る
- A11: `gh issue view 333` → 到着の確認を `plugin-release` の Skill の手順で済ませた後、Items 4・5 にチェックが入り、実測値のコメントがある

## リスク

- Codex がログの 1 行目の形を変える → Codex のセッションが記録されなくなり、通知が出る。review の配信は出なくなる。A9 の確認を Codex の更新のたびに流す手順にするかは、起きてから決める
- デスクトップアプリ・IDE 拡張のログが条件を満たさない（未検証）→ そこでは記録されず通知が出る。報告が来たら実測して条件を見直す
- `$REVIEW_DIR` のような環境変数の書き方を skill と取り違える → 「この変更に当たる過去の決定」を 1 回届けるだけで、同じ変更では 2 回目は出ない
- モデルが `SKILL.md` をパスを書かずに読む（`cd` してから `cat SKILL.md`）→ 拾えない。README に書く
- 配信でログが読めないとき、子のスレッドを親の会話として数える → 子に見せた記録が親に見せたことになる（今と同じ状態）。配信は止めない
- 配信の hook が毎回ログの 1 行目を読む（Bash の PreToolUse は回数が多い）→ A5 の計測で見る。1 秒を超えたら、読むのを review と子の判定が要る経路だけに絞る
- push までの間、手元にしか作業が無い → タスクごとにコミットし、検査は手元の `bun run verify` と Codex のレビューで見る。CI で初めて落ちたものは、push の後に同じブランチで直す
- A8 が自動の操作で安定しない（対話の画面で 2 回のやり取りが要る）→ 3 回試して通らなければ、持ち主に一時の環境で 1 回流してもらう

## 未解決

なし

## 変更履歴

- 2026-10-13 / 目的・持ち主の決定・前提（R9、R10）・方針 2 と 8・採った案に、`codex exec --ephemeral` のセッションを記録しないことを足した。方針 2 の通知の印の置き場を、配信と同じ一時ディレクトリにした / T02 の出荷前レビューで、ephemeral のセッションは hook の `transcript_path` が null で、本人のプロンプトと review の子のプロンプトを見分けられないと分かった。計画の目的は `codex exec` が今までどおり保存されるとしていた / Go 要。持ち主が AskUserQuestion で「記録しない」を選んだ（2026-10-13）
