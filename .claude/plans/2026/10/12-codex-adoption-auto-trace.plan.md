---
kind: plan
status: approved
codex_session: 01a12fcf-6a79-7580-b794-70e49eb10466
codex_rounds: 3
approved_at: 2026-10-12
---

# Codex でも、AI 自身の決定を採用し、新しい対話のセッションで自動の trace を走らせる（#333 の Items 2・3）

## 要点

- record サーバーが Codex の呼び出しを「対話」と見るのは、MCP のメタデータが `turn_trigger: "user"`、`thread_source: "user"`、`thread_id == session_id` の 3 つを満たすときだけ。`codex exec` と子のスレッドは今までどおり採用しない。**測定済みは TUI だけで、デスクトップアプリや IDE 拡張が同じ 3 つを送るなら、そこでも採用が通る**（record サーバーは TUI かどうかを確かめられない）
- 子のスレッドが record ツールを呼ぶと、その親セッションの AI の返事は、呼び出しの前のものも含めて全部、採用の対象から外れる（子のターンを親のターンに結べないため、安全な側に倒す）
- 自動の trace の案内は、SessionStart の hook がセッションのログの 1 行目を読み、`originator: "codex-tui"` の新しいセッションにだけ出す。record サーバー側でも、対話でない Codex の呼び出しには自動の trace の一覧を返さない
- trace の Skill は Codex で「明示的に呼んだときだけ」の設定のまま変えない。開始時の案内が SKILL.md のパスを名指しして読ませる
- `SPHICA_AUTO_TRACE=off` は Codex でも効くが、**常駐プロセスが起動したときの環境の値が使われる**。後から設定した値は、常駐プロセスが起動し直すまで効かない。README にそう書く（`SPHICA_SHELL_WRITE_DELIVERY` と `SPHICA_REVIEW_COMMANDS` も同じ）
- `plugin/hooks/codex.json` は変えない。hook の信頼し直しは要らない。**SDK が引数の形で断った record ツールの呼び出しを記録する hook（Claude Code と同じ観測）は足さず**、`codex.json` を変える次のリリース（レビュー前の配信）で足すかを、そのときに決める
- 1 つの PR、リリースは 0.6.52 の見込み。配布前に、一時の HOME と専用の常駐プロセスで、実際のプラグインの動きを確かめる

## 持ち主の決定

- AI 自身の決定の採用と自動の trace は 1 つの計画にする（Sphica の記録 `trace:cbc0dbe8-014d-4719-9165-5a39fdb1e53f/issue-333-codex-parity`）
- `plugin/hooks/codex.json` を変える項目は 1 回のリリースにまとめる（`trace:8bdc90ff-42f1-4bac-bfe4-025b363fc083/codex-json-one-release`）
- Claude Code と Codex は、各ホストが許す限り同じ機能を持つ。片方でしか動かない変更は、もう片方に何が無いかを名指しし、README に差を書く（CLAUDE.md `host-parity`）
- `agent` の採用は、record サーバーが対話のセッションから来たと見た trace の begin と save からだけ生まれる（CLAUDE.md `agent-adoption`）
- Codex の設定は環境変数のまま（issue #333 の末尾。Codex のプラグインの manifest に利用者設定の欄が無い）
- 持ち主の実環境の常駐プロセスを止める・起動し直す操作はしない
- 観測された事例の無い防止策は計画に入れない（memory `observed-need-before-building`）
- 3 つの値を送るデスクトップアプリや IDE 拡張でも採用が通ることを受け入れる（Codex との議論の後に持ち主が追加、2026-10-12）
- SDK が引数の形で断った record ツールの呼び出しを記録する hook は、今回は足さない（Codex との議論の後に持ち主が追加、2026-10-12）

## 目的

- 3 条件を満たす Codex のセッション（測定済みは TUI）で trace を流すと、AI 自身の決定が、Claude Code と同じ条件で AI の決定として active になる
- 新しい対話の Codex のセッション（ログの 1 行目が `codex-tui`）の最初のプロンプトで、trace 待ちのセッションがあれば、エージェントが依頼の後に自分で trace を流す
- `codex exec`、子のスレッド、3 条件を送らないクライアントでは、採用しない。自動の trace の案内は出ず、今の 1 日 1 回の案内だけが出る
- README と trace の Skill が、残るホストの差を言う

## 対象外

- レビュー前の配信（#333 の Items 4）と `/sphica:forget`（Items 5）。別の計画にする
- record ツールへの PreToolUse hook を `codex.json` に足すこと。次に `codex.json` を変えるリリースで決める
- Codex のデスクトップアプリと IDE 拡張の値を測ること
- 環境変数に代わる設定の置き場を足すこと
- 常駐プロセスがエージェントのシェルから起動されたとき、capture がすべての Codex のセッションを本人でないと判定する性質を直すこと（README に書くだけ。直す話は別の issue として持ち主に提案する）
- DB の schema の変更

## 前提

実測は 2026-10-12、Codex 0.162.1、macOS。B は一時の `CODEX_HOME` に専用の常駐プロセスを立て、入力と環境変数の名前を書き出す hook、`_meta` を書き出す MCP サーバー、probe の Skill を置いて測った（対話 5 回、`codex exec` 1 回）。

- A. 持ち主の実環境（常駐プロセス経由）で `$sphica:trace pending` を 1 回: `record_call` の id 371 が `host=codex, mode_raw=user, mode=unknown`。呼び出しを受けた record サーバーの親は常駐プロセス。ログの 1 行目は `originator: "codex-tui"`, `source: "vscode"`, `thread_source: "user"`, `payload.id == payload.session_id == hook の session_id`
- B1. 常駐プロセス経由の対話: `turn_trigger: "user"`, `thread_source: "user"`, `session_id == thread_id`。hook の `turn_id` と MCP の `turn_id` は同じターンで一致
- B2. 対話の中の子のスレッド: `turn_trigger: "user"`（親と同じ）、`session_id` は親、`thread_id` は子、`thread_source: "subagent"`。`turn_id` は子のターンで、親のどのターンとも違う。親のターンの id はメタデータに無い。hook 側も `turn_id` は子のターンで、`agent_id` が付く
- B3. `codex exec`: `turn_trigger: "exec"`, `thread_source: "user"`。常駐プロセスを使わない
- B4. SessionStart の hook は最初のプロンプトのとき（UserPromptSubmit の直前）に走る。入力は `source: "startup"`, `permission_mode`, `transcript_path`, `session_id`。その時点で `transcript_path` の 1 行目が読めた（対話は `codex-tui`、exec は `codex_exec`）。1 行目の長さは持ち主の実セッションで 22,879 バイト
- B5. 常駐プロセス経由の hook の環境変数は、常駐プロセスが起動したときのもの。後から別の端末で設定した `SPHICA_AUTO_TRACE=off` は届かなかった。exec では exec を起動した環境が届く。hook の環境に `CODEX_THREAD_ID` は無い
- B6. MCP サーバーの環境変数は `HOME, LANG, LOGNAME, PATH, SHELL, TERM, TMPDIR, USER, __CF_USER_TEXT_ENCODING` の 9 個だけ
- B7. SessionStart の hook が `additionalContext` で Skill を自分で走らせるよう言うと、対話 5 回・exec 1 回とも同じターンの中で走った。`allow_implicit_invocation: false` を付けた 1 回でも走ったが、Skill の場所を探すシェルコマンドが 2 回増えた（`CODEX_HOME/skills` の Skill。プラグインの Skill では未検証）
- B8. hook の信頼は、起動時の「Hooks need review」→「Trust all and continue」で `config.toml` の `[hooks.state]` に書かれる。常駐プロセス経由でも同じ
- C. Codex のソース（`rust-v0.162.1`、読んだだけ）: `turn_trigger` は app-server のクライアントが送る値で、TUI は `"user"`（`tui/src/app_server_session.rs:1441`）、exec は `"exec"`（`exec/src/lib.rs:1235`）、常駐プロセスの再起動後の続きは `"daemon_recovery"`（`app-server/src/request_processors/daemon_continuation.rs:94`）。`-c` の上書き・`--dangerously-bypass-hook-trust`・`--profile`・`--strict-config`・`--no-daemon` のどれかで、TUI は常駐プロセスを使わない（`tui/src/daemon_startup.rs:65-129`）。常駐プロセスのソケットは `CODEX_HOME` のパスごとに分かれる（`app-server-transport/src/transport/unix_socket.rs:302`、持ち主の実環境の値で照合済み）
- `server/src/caller.ts:31-43`: Codex は `exec` を headless、それ以外を unknown にする。`thread_source` と `thread_id` は読まない
- `server/src/trace.ts:176-192` `callSession`: Codex は `caller_session` をそのままセッションとし `owner: true`。コメントは実測 B2 と合わない
- `server/src/extract.ts:296-303` `agentRun`: begin と今の呼び出しの両方が `mode = interactive` で、同じ host・session のとき採用を通す。trace の対象のセッションの host は比べない（Claude Code の対話から Codex のセッションを trace すれば、今も Codex の返事を採用できる）
- `db/schema.sql:749-760` `agent_ineligible_source`: Codex は `caller_session = session.external_id` かつ `caller_turn is null or caller_turn = source.turn_id` の返事を外す。Codex の確認（現行 schema のメモリ内 SQLite）: `caller_turn` が子のターンだと親の返事は 0 件しか外れず、`caller_turn` が null だとその親セッションの返事が呼び出しの前後とも外れる
- `server/src/deliver.ts:1329-1339`: `auto` は Claude Code だけ。`:828-851` `waiting`: auto でなければ 1 日 1 回の案内
- `server/src/mcp-record.ts:126-132`: `trace_pending` の `auto: true` は呼び出し元の mode を見ない
- MCP SDK 1.31.0 は引数の検証をハンドラーの前に行う（`server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:125`）。断られた呼び出しは `called()` に届かず、`record_call` に残らない
- 2026-10-04 の採用の計画（`git show 235769db -- .claude/plans`、approved）: 「Codex で、MCP の入力の形で拒まれた record ツールの呼び出しは…拒まれた呼び出しは何も実行しないので、入力の形を緩めてまで記録しない。Codex の PreToolUse が MCP ツールに届くと分かれば、Claude Code と同じ観測を足す」
- `plugin/skills/trace/agents/openai.yaml`: `allow_implicit_invocation: false`（コミット 13c40273 から）
- `server/test/record-world.ts`: 実際の record サーバーを子プロセスで起こし、MCP のクライアントでつなぐ既存の土台
- 未検証: デスクトップアプリと IDE 拡張の値。プラグインの Skill が明示起動だけの設定のまま、開始時の案内から走るか。off を渡して常駐プロセスを起動したときの動き。Windows

## 方針

### 呼び出し元の判定（`server/src/caller.ts`）

- `session = text(session_id)`, `thread = text(thread_id)`, `source = text(thread_source)`, `trigger = text(turn_trigger)`
- 本人のスレッド: `session !== null && thread !== null && session === thread && source === "user"`
- mode: 本人のスレッドかつ `trigger === "user"` → `interactive`。`trigger === "exec"` → `headless`（本人のスレッドかは問わない）。それ以外 → `unknown`
- `turn`: 本人のスレッドなら `text(turn_id)`、そうでなければ null
- `raw`: 本人のスレッドなら `trigger`、そうでなければ `text(`${trigger ?? "none"}:${source ?? "none"}`)`
- `server/src/trace.ts` の `callSession` は動きを変えず、コメントを「Codex の `owner` は本人確認ではなく、mode が別に要る。子の呼び出しの `session_id` は親のもの」に直す
- schema・`agentRun`・trigger は変えない

### 自動の trace の案内（`server/src/deliver.ts`、`server/src/capture.ts`）

- `HookInput` に `transcript_path?: string` を足す
- Codex の対話の判定（新しい関数）: 絶対パス、`lstat` で通常ファイル、先頭から最大 256 KiB だけ読む（ファイル全体の大きさは問わない）。その範囲に改行が無ければ不一致。1 行目が JSON のオブジェクトで、`type === "session_meta"`、`payload` がオブジェクト、`payload.id === input.session_id`、`payload.originator === "codex-tui"`、`payload.thread_source === "user"` のときだけ対話。読めない・形が違う・別のセッション・未知の originator は、どれも対話でない
- `auto` の Codex の枝: `host === "codex"`、`SessionStart`、`source === "startup"`、上の判定、`SPHICA_AUTO_TRACE` が off でない。満たさなければ今の 1 日 1 回の案内
- Codex 用の案内の文面: SKILL.md の絶対パス（deliver のスクリプトの場所から `../skills/trace/SKILL.md`）を名指しし、「このファイルを読み、On your own の節のとおりに」と言う。パスは切らず変形しない。印字可能文字だけ（制御文字・改行・バッククォート無し）で UTF-8 の 1,000 バイト以下のときだけ使い、満たさなければその回は 1 日 1 回の案内に落とす。Claude Code の文面は変えない
- `plugin/skills/trace/agents/openai.yaml` は変えない

### record サーバー側の止め（`server/src/mcp-record.ts`）

- `trace_pending` の `auto: true` が Codex から来て、その呼び出しの mode が `interactive` でないときは、一覧を返さず「このセッションからは自動で trace しない。今回は何もしない」と返す。Claude Code の `auto: true` は今のまま

### 文書

- README.md と README.ja.md: Features、使い方（:99 / :98）、開始時の説明、制限（:150 / 対応する行）。採用の条件は「3 つの値を送る Codex、測定済みは TUI」、自動の trace は「ログの 1 行目が `codex-tui` の新しいセッション」。環境変数の段落に、常駐プロセスの起動時の値が使われること、エージェントのシェルから起動された常駐プロセスでは記録が止まり、起動し直すまで戻らないことを書く
- `plugin/skills/trace/SKILL.md`: 「On your own」から Claude Code だけの記述を外し、`trace_pending` が「自動で trace しない」と返したら止まると書く。`allow_implicit_invocation: false` は、プロンプトの内容から Codex が自分で選ぶことを抑える設定で、開始時の案内がファイルを名指ししたときは走る、という説明にする
- `scripts/check-ai-config.mjs:465`、`.claude/skills/plugin-release/SKILL.md:186`、`.agents/skills/plugin-release/SKILL.md:186` の「trace は Codex の方が厳しい」の説明を、上の説明に合わせる
- `caller.ts`・`deliver.ts`・`trace.ts` のコメント
- 実装後に `rg` で関連の言葉（`Codex`、`interactive`、`auto`、`turn_trigger`、`自動`）を列挙し、英日の README・Skill・コメントを突き合わせる

### テスト

- `server/test/caller.test.ts`: 対話、子のスレッド（`turn` が null、raw `user:subagent`）、`thread_source` 無し、`thread_id` 無し・不一致、exec、exec の中の子、`daemon_recovery`、合成した raw が `text()` を通らない長さ
- `server/test/record-world.ts` の土台で、実測の形の `_meta` を付けた `tools/call` を実際の record サーバーへ送る: `record_call` の行（mode・turn・raw）、対話の begin と save で別のターンの返事が AI の決定として active、begin か save が子のスレッド・exec・`daemon_recovery` なら candidate、子のスレッドの呼び出しの後は親セッションの返事が全部 candidate、record ツールを呼んだターンの返事は採用できない、begin と save でセッションが違う、check は対話で save は unknown、不正な引数の呼び出しは記録されず何も保存されない、`auto: true` の一覧が自分を除く、Codex の unknown / headless の `auto: true` は一覧を返さない、Claude Code の既存の条件が変わらない
- `server/test/deliver.test.ts`: 1 行目が `codex-tui` なら `AUTO_TRACE`（パス入り）、`codex_exec`・ファイル無し・通常ファイルでない・途中で切れた JSON・空やオブジェクトでない payload・別のセッションの id・subagent・1 行目が 256 KiB を超える・`source: "resume"`・off（`off`, `0`, `false`, `no`）なら今の案内。短い 1 行目 + 大きな残りは通る。同じセッションで 1 回、待ち 0 件・14 日超は出ない。空白や引用符を含むパスはそのまま出る、長すぎる・制御文字を含むパスは今の案内
- `server/evals/acceptance/driver.ts:292` の Codex の呼び出しを実測の形に直す
- 挙動を変えるテストは、直す前のコードで意図した理由で落ちることを先に確かめる

### リリース

- バージョンを変える前に `bun run release:plan -- --base 47b5d0e2`（v0.6.51 の tag のコミット）を流し、出た種別で扱う（`plugin` の見込み）。バージョンは未使用を確かめた次の値（0.6.52 の見込み）にし、最初の package のコミットで `plugin/package.json`・2 つの `plugin.json`・`.claude-plugin/marketplace.json` を揃える
- 配布前の確認（PR の中、tag の前）: 一時の HOME（MCP サーバーには `HOME` しか届かないので DB は `<tmp>/.sphica/sphica.db`）、その下の `CODEX_HOME`（持ち主の `auth.json` へのリンクと model の 2 行）、持ち主の常駐プロセスのパッケージから今のリリース 1 つをコピーした専用の常駐プロセス（自動更新は切る）、`bun run bundle` した実際のプラグイン。`-c` と `--dangerously-bypass-hook-trust` は使わず、画面で hook を信頼する（付けると常駐プロセスを使わない）。片付けは一時の home の pid ファイルの PID だけを kill し、一時の home とリンクを消す
- 到着後、持ち主に実環境の対話の Codex で新しいセッションを 1 回始めてもらい、自動の trace と AI の決定の採用を確かめる
- それ以外は `plugin-release` Skill の手順のとおり（`bun run verify`、`review-shipping`、CI、Codex の全差分レビュー、tarball の確認、持ち主の `npm-release` の承認、両ホストへの到着の確認）

## 採った案と棄却した案

- 採用: 対話の判定に `thread_source` と `thread_id` も使う。棄却: `turn_trigger === "user"` だけ（子のスレッドも `user` で `session_id` が親のものなので、子の呼び出しが本人の対話扱いになる）
- 採用: 本人のスレッドでない呼び出しは `turn` を null で記録し、既存の view でその親セッションの返事を全部外す。棄却: 子は unknown にするだけ（子の呼び出しで親の返事を外せない、Codex の指摘 C2）、変更前に残った行への防止策（観測された事例が無い）
- 採用: 採用の対象を「3 つの値を送る Codex」と説明する。棄却: record サーバーで TUI に限る（`transcript_path` が record サーバーに届かず、セッションの出どころを保存するには schema の変更が要る）
- 採用: hook はログの 1 行目の `originator` で対話を見て、record サーバーも mode で止める。棄却: `permission_mode`（起動の引数で変わる）、`source`（常駐プロセス経由だと `vscode`）、record サーバーだけで止める（`codex exec` のたびに案内が出て、エージェントが無駄に trace を試みる）、`codex_exec` 以外を全部対話とみなす
- 採用: `openai.yaml` は変えず、案内が SKILL.md のパスを名指しする。棄却: `openai.yaml` を消す（プロンプトの内容から Codex が trace を選ぶ範囲が広がる、Codex の指摘 C8）
- 採用: SDK が断った呼び出しは記録しない（2026-10-04 の計画の判断のまま）。棄却: record サーバーが引数の検証より前に記録する（順序・記録先・キャンセルの後始末の 3 つの欠陥が出た。断られた呼び出しは check も save もせず、そのターンを外しても守られるものが無い）、今回 `codex.json` に hook を足す（利用者全員の信頼し直しが要り、得られるのは断られた呼び出しのターンが外れることだけ）
- 採用: 環境変数のまま README に条件を書く。棄却: 設定ファイルを足す（3 つの設定の公開の契約が増える）
- 採用: `isOwnerTurn` は変えない。棄却: Codex で `SPHICA_PARENT_SESSION` を無視する（実際にエージェントが起動した子と見分けられず、今の防止を緩める）

## 手順

- S1: `callerOf` の Codex の枝を直し、`callSession` のコメントを直す。`caller.test.ts` と受け入れの driver を実測の形にする
- S2: 実際の record サーバーへ `_meta` 付きの呼び出しを送るテストを足す（採用が通る・通らない、子のスレッドの後の親セッション、不正な引数）
- S3: `trace_pending` の `auto: true` を、Codex の interactive でない呼び出しに返さない
- S4: `HookInput` に `transcript_path` を足し、ログの 1 行目で Codex の対話を見る関数と、`auto` の Codex の枝、Codex 用の案内の文面を足す
- S5: trace の Skill の文面を直す
- S6: README（英日）、検査のコメント、配布の Skill、コードのコメントを直し、`rg` で突き合わせる
- S7: `release:plan` を流してバージョンを上げる
- S8: 配布前の確認を流し、結果を PR 本文の「配布前の確認」の節に書く

## 完了条件

- A1: `cd server && node --import ./test/isolate-home.ts --test test/caller.test.ts` → pass。対話は `interactive`、子のスレッドは `unknown` で `turn` が null
- A2: `cd server && node --import ./test/isolate-home.ts --test test/record.test.ts test/authority.test.ts test/schema.test.ts test/codex-caller.test.ts` → pass（`codex-caller.test.ts` は S2 で足すファイル）
- A3: `cd server && node --import ./test/isolate-home.ts --test test/deliver.test.ts` → pass。Codex の `codex-tui` のログで `AUTO_TRACE`、それ以外は今の案内
- A4: `git diff --exit-code 47b5d0e2 -- plugin/hooks/codex.json plugin/skills/trace/agents/openai.yaml db/schema.sql` → 差分なし
- A5: `rg -n "only when the trace runs in an interactive Claude Code session|Codex does not start this Skill on its own yet|whose interactive turns are not measured yet|trace starts on its own only in Claude Code" README.md README.ja.md plugin/skills server/src scripts` → 0 件
- A6: `bun run verify` → pass
- A7: `gh pr view --json body --jq .body` → 「配布前の確認」の節に、S8 の 5 項目それぞれの「何回中何回」がある。(a) 対話の新しいセッションで自動の trace が走り、待っていたセッションが保存される、(b) 対話で AI の決定が active になる、(c) `codex exec` では `AUTO_TRACE` が出ず、採用もされない、(d) `SPHICA_AUTO_TRACE=off` を渡して常駐プロセスを起動すると `AUTO_TRACE` が出ない、(e) 今回始めたセッションが新しく記録される
- A8: `gh pr checks` → 全項目 pass
- A9: `gh pr view --json reviewDecision,comments --jq .` → Codex の全差分レビューの指摘が 0 件か、直すか棄却して PR 本文の「Declined findings」に書いてあり、未解決の thread が無い
- A10: `bun run release:status` → npm の `latest`・remote の tag・両ホストのキャッシュが新しいバージョンで、`unknown` が無い
- A11: `sqlite3 -readonly ~/.sphica/sphica.db "select mode, mode_raw from record_call where host = 'codex' order by id desc limit 5"` → 到着後に持ち主が実環境の対話の Codex で新しいセッションを 1 回始めた後、`interactive|user` の行がある（自動の trace が走った）。その trace か、続けて流した trace で AI の決定が 1 件 active になる

## リスク

- `turn_trigger` と `thread_source` はクライアントが送る値で、app-server に直接つなぐプログラムは `user` を名乗れる → Claude Code の `CLAUDE_CODE_ENTRYPOINT`（起動する側が決める環境変数）と同じ強さの根拠として扱い、本人を認証する仕組みとは説明しない
- 子のスレッドが record ツールを 1 回でも呼ぶと、その親セッションからは AI の決定を採用できなくなる → 安全な側。record ツールを子に呼ばせる Skill は Sphica に無い。困る事例が出たら、親のターンを知る手段を調べ直す
- 変更前に残った、子のスレッドからの record ツールの呼び出し（`caller_turn` が子のターン）は、親の返事を外さない。Claude Code の対話から Codex のセッションを trace する経路では、この残りは今もある → 観測された事例が無いので作らない。持ち主の DB の Codex の呼び出しは測定の 1 行だけ
- Codex で、SDK が引数の形で断った record ツールの呼び出しは記録されず、そのターンの返事は採用の対象に残る → 断られた呼び出しは check も save もしない。Claude Code と同じ観測（record ツールへの PreToolUse hook）は、`codex.json` を変える次のリリースの候補
- Codex のバージョンが上がって `thread_source` や `originator` の値が変わる → 対話が unknown に落ち、採用も自動の trace も止まる側に倒れる。到着後の確認と同じ手順で測り直す
- プラグインの Skill では、明示起動だけの設定のまま開始時の案内から走らないかもしれない → A7 の (a) で分かる。走らなければ実装を止め、`openai.yaml` を変える案（起動の範囲が広がる）を持ち主に出して Go を取り直す
- 実装中に `plugin/hooks/codex.json` を変える必要が出る → そこで止め、レビュー前の配信と同じリリースにまとめる計画に直して Go を取り直す

## 未解決

なし

## 変更履歴
