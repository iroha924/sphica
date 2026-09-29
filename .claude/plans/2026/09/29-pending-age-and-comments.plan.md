---
kind: plan
status: approved
codex_session: 01a0ec45-7020-70b2-9d9a-a29fadb8899f
codex_rounds: 3
approved_at: 2026-09-29
---

# 30 日より古い未 trace のセッションを待ちに数えず、Skill の allowed-tools に読み取りツールをそろえ、コメント規則から参照と経緯を外す（0.6.5）

## 要点

- #226: セッション開始の「N 件の待ち」は、最後のオーナー発言が 30 日以内のセッションだけを数える。`/sphica:trace pending` と `status` は古いものを別に示す。発言は DB と検索に残し、何も消さない
- allowed-tools: 同梱の全 Skill に `status`・`search`・`read` を許可し、trace に AskUserQuestion を足し、review にも読み取りツールを許可する。本文で名前を出したツールが許可に無ければ `verify:ai` で落とす
- コメント規則: `.claude/rules/comments.md` と `AGENTS.md` の規則を書き換え、「パスを指す」をやめ、issue・PR・plan・コミットの参照と経緯を書かないことにする。新しい `bun run comments` で番号とパスの参照を機械で落とし、既存の違反コメントを直す
- `.claude/plans/` の既存の plan と tasks 14 ファイルを消す（この計画の 2 ファイルは残す）
- npm と 3 つのプラグインマニフェストを 0.6.5 にそろえて出す
- 変えないもの: DB schema、発言の保存と検索、trace_begin が受け付けるセッション、CLI のコマンド、reviewer に渡すツールの表

## 持ち主の決定

- #226 の本文どおり: 30 日より古い未 trace のセッションは待ちに数えず、pending では古いものとして別に並べる。削除はしない（自動削除は棄却済み、記録 u50）
- allowed-tools: 読み取りツールを全 Skill にそろえ、本文と許可のずれを検査で止める（記録 u53 を受けて、2026-09-29）
- #226 と allowed-tools を 1 つの計画・PR・リリースにまとめる（2026-09-29）
- 既存の plan と tasks を全部消し、同じ PR に入れる（議論の 1 往復目の後に持ち主が追加）
- コメントに plan のパス、issue・PR の番号、経緯を書かない。既存の規則は足すのではなく書き換える。今の規則がコードを冗長にしている（議論の 1 往復目の後に持ち主が追加）

## 目的

- 31 日前が最後のオーナー発言の未 trace セッションが、セッション開始の件数に入らず、pending に「古い」として出て、その発言が `search`（`sources: true`、`asked: true` のそれぞれ）で見つかる
- headless の `claude -p` で `/sphica:rules` を流し、エージェントが `status` を呼んでも拒否されない
- Skill の本文にあって `allowed-tools` に無いツール、コメント中の issue・PR 番号や plan のパスが `bun run verify` で落ちる
- `.claude/plans/` にこの計画の 2 ファイルだけが残る

## 対象外

- 未 trace の発言の削除や期限切れ（持ち主が棄却）
- 30 日の値を設定で変えられるようにすること
- セッション開始の行に古い件数を出すこと（古いものへの入口は pending に残る）
- reviewers/*.md を allowed-tools の検査の対象にすること。reviewer のツールは review の SKILL.md の「Tools given」の表で渡し、その名前は SKILL.md 自体にあるので検査に入る
- 経緯を語るコメントの機械検査（言い回しで見分けられない。規則の文章だけで止める）
- `server/test/fixtures/*.sql` の機械検査（migration のテストが使う、古い schema の固定の写し。規則の文章は及ぶ）

## 前提

- `pendingCount`（`server/src/status.ts:22`）は、どの `source_processing` にも無いオーナー発言を持つセッションを数え、セッション開始の行（`server/src/deliver.ts:423` の `waiting`）と `status` の行（`status.ts:113`）が使う
- `pendingSessions`（`server/src/trace.ts:7`）は同じ条件のセッションを `started_at` の新しい順に 20 件返し、`pendingText`（`server/src/extract.ts:38`）が `trace_pending` の文面にする。0 件なら「Every captured session has been traced.」
- `source.created_at` は `%Y-%m-%dT%H:%M:%fZ` の文字列（`db/schema.sql:73`）で、`Date.prototype.toISOString()` と文字列のまま比べられる
- capture の spool は `HOLD_DAYS = 30`（`server/src/capture.ts:46`）で 30 日を使っている
- `search` は `sources: true` と `asked: true` を同時に受け付けない（`server/src/mcp.ts:161`、Codex が確認）
- `allowed-tools` を持つのは trace・harvest・glean・rules・forget。review には無い。trace の本文は AskUserQuestion を使うよう書くが許可に無い（`plugin/skills/trace/SKILL.md:6,32`）
- `allowed-tools` はその Skill を呼んだターンの事前許可で、使えるツールを制限しない（https://code.claude.com/docs/en/skills 、Codex が確認）。Codex は `allowed-tools` を読まない
- review の親の許可が reviewer（子のエージェント）の MCP 呼び出しに引き継がれるかは未検証（公式は一般の Agent が親の権限を継ぐと書くが、Skill の一時的な許可については記述が無い）
- ツールの登録は `server.registerTool(` の次の行に名前がある形（`server/src/mcp.ts:95`、`server/src/mcp-record.ts:92`）
- 今のコメント規則は `.claude/rules/comments.md` と `AGENTS.md:66` の「### Comments」に同じ「1 to 3 lines. Put longer explanations in a Skill or design doc and point to its path」がある。invariant の名前の集合は `scripts/check-ai-config.mjs:113` で比べるが、文面の一致は見ていない
- js-tokens でコメントを取り出す処理が `scripts/lib/english.mjs` にある
- `release:plan` はステージした差分だけで種別を決める（`scripts/release-plan.mjs:42`）。直前のリリースは `v0.6.4`（`850da68`）
- 規則に反する既存のコメント（rg で確認）
  - plan のパス: `server/src/forget.ts:3`、`server/test/forget.test.ts:2`、`server/evals/acceptance/load.ts:1`
  - issue・PR 番号: `server/src/forget.ts:1`、`db/migrations/0002.sql:1`、`db/migrations/0003.sql:1`、`scripts/check-sql-live.mjs:69`、`scripts/lib/release-gate.mjs:70`、`server/test/github.test.ts:141`
  - 経緯: `scripts/bundle.mjs:6`、`server/src/capture.ts:51,421,680`、`scripts/check-ai-config.mjs:369`、`scripts/check-tarball.mjs:88`、`db/schema.sql:2`、`server/test/migrate.test.ts:2`、`scripts/release-finish.mjs:153`

## 方針

### #226

- `status.ts` に `PENDING_DAYS = 30` を置き、`cutoff(now: Date): string`（`now - 30 日` の ISO 文字列）を出す
- 最近か古いかは SQL で決める。条件は 2 つを別に書く: 未 trace のオーナー発言がある（今の EXISTS）、かつ、そのセッションの**全**オーナー発言（trace 済みも含む）の `max(created_at)` が cutoff 以上なら最近、未満なら古い。ちょうど 30 日は最近
- `now` は入口ごとに 1 回だけ取り（`waiting`、`status`、`trace_pending`）、同じ cutoff を件数と一覧に渡す。関数は `now` を引数で受け、既定を `new Date()` にする
- `pendingCount(db, projectId, cutoff)` は `{ recent, older }` を返す。`waiting` は `recent` だけを使う（行の文面は変えない）
- `status` の行
  - `recent > 0`: 今の「N sessions not traced yet ...」
  - `older > 0`: 「M older sessions (last owner message over 30 days ago) not traced; /sphica:trace pending lists them.」を足す
  - 両方 0 のときだけ「Every captured session has been traced.」
- `pendingSessions` は群ごとに、最後のオーナー発言の新しい順に 20 件まで返し、群の総数も返す
- `pendingText` は最近の群を先に、次に「Older than 30 days (not counted at session start):」の見出しで古い群を、今と同じ行の形で出す。見出しには群の総数を出し、20 件で切ったら「and K more」を足す。全件 0 のときだけ今の 0 件の文面にする
- `trace_begin` は古いセッションの id も今までどおり受け付ける
- trace の Skill の本文に、pending が古い群を別に出すことを 1 行足す
- テストは実際の SQLite（`server/test/temp-db.ts`）で、31 日（古い）・29 日（最近）・ちょうど 30 日（最近）・古い未 trace 発言の後に新しい trace 済み発言（最近）を確かめる。31 日のセッションの発言が `search` の `sources: true` と `asked: true` を別々に呼んで見つかることも確かめる
- acceptance case を 1 件足し、直す前のコードで落ちることを先に確かめる
- SQL の呼び出し箇所が変わるので `scripts/lib/sql-call-sites.mjs` を直す

### allowed-tools

- trace・harvest・glean・rules・forget の `allowed-tools` に `mcp__plugin_sphica_sphica__status`・`__search`・`__read` を（無いものだけ）足す。trace に `AskUserQuestion` を足す
- review に `allowed-tools: mcp__plugin_sphica_sphica__status, mcp__plugin_sphica_sphica__search, mcp__plugin_sphica_sphica__read, mcp__plugin_sphica_sphica__review_select, mcp__plugin_sphica_sphica__review_check` を足す。reviewer の「Tools given」の表は変えない
- `scripts/check-ai-config.mjs` に検査を足す
  - 登録名は `server/src/mcp.ts`（`sphica`）と `server/src/mcp-record.ts`（`record`）から `registerTool\(\s*"([a-z_]+)"` で取る（改行を許す）。どちらかが 0 件なら落とす
  - 各プラグイン Skill の SKILL.md と `references/*.md` で、登録名と完全に一致するインラインコード、または `AskUserQuestion` を集める
  - 集めた名前が `mcp__plugin_sphica_<server>__<name>`（または `AskUserQuestion`）として `allowed-tools` に無ければ落とす。`status`・`search`・`read` は本文に無くても全 Skill で必須。`allowed-tools` にある `mcp__plugin_sphica_*` が登録名に無ければ落とす
  - reviewers/ を外す理由を検査のコメントに 1 行書く

### コメント規則

- `.claude/rules/comments.md` の箇条書きの 1 行目を、次の 3 行に置き換える。`AGENTS.md` の「### Comments」の 1 行目も同じ 3 行に置き換える。残りの行はどちらも変えない

```markdown
- 1 to 3 lines, only what the code cannot say: why it is this way, a constraint, a trap. Put anything longer in a Skill, not in the comment <!-- invariant: comment-length -->
- Write the reason itself. Do not point to issues, pull requests, plans, or commits by number, URL, or path
- Describe the code as it is. Do not tell its history (what it used to be, what changed, when): git and Sphica's records keep that
```

- `scripts/check-ai-config.mjs` で、この共通の 3 行が 2 つのファイルにそれぞれ 1 字も違わずにあることを確かめる（改行コードだけ正規化）。それぞれにしかない行は比べない
- 新しい `scripts/check-comments.mjs` を `bun run comments` として `bun run check` に入れる
  - コメントの取り出しは `scripts/lib/english.mjs` の js-tokens の処理を共用する（コメントのトークンを行番号付きで返す関数を出す）
  - 対象: `server/src`・`server/test`・`server/evals`・`scripts` の `*.ts`・`*.mjs` のコメント、`db/**/*.sql` の行頭が `--` の行（空白を除いて）
  - 落とすもの: `.claude/plans/`、`\bissue #?\d+`、`\b(PR|pull request) #?\d+`、`\(#\d+\)`、`\b(close[sd]?|fix(e[sd])?|resolve[sd]?) #\d+`（大文字小文字を区別しない）、`[\w.-]+/[\w.-]+#\d+`、`github\.com/[^/\s]+/[^/\s]+/(issues|pull)/\d+`
  - 検査のテストは `server/test/comments-check.test.ts`。落ちる例: 上の各形。通る例: `#27`、文字列の中の `Fixes #14`、SQL の文字列の中の `--`。このテストファイルを `scripts/check-english.mjs` の一覧に足す
- 前提に挙げた既存のコメントを直す。番号とパスは消し、理由がコメントに無ければ理由を書く。経緯は今の制約か挙動の説明に書き換えるか、消す。migration は先頭コメントの issue 番号だけを消し、SQL は変えない

### plan の削除とリリース

- `.claude/plans/2026/09/` の既存 14 ファイルを `git rm` する
- バージョン以外の変更をステージしてから `bun run release:plan -- --base v0.6.4` を流し、`plugin` と出たら `plugin/package.json`・`plugin/.claude-plugin/plugin.json`・`plugin/.codex-plugin/plugin.json`・`.claude-plugin/marketplace.json` を 0.6.5 にそろえる。その後は `plugin-release` Skill のとおりに進める

## 採った案と棄却した案

- 採用: 最後のオーナー発言（trace 済みを含む）の日時で 30 日を判定する。棄却: `session.started_at` で判定する（昔始まって今日も続くセッションが落ちる）。棄却: 未 trace の発言だけの最新日時で判定する（新しい trace 済みの発言があるセッションを古いと誤る）
- 採用: 最近が 0 件で古いものがあるとき、「全部 trace 済み」と出さずに古い件数を出す。棄却: 古い件数を足すだけにする（「全部 trace 済み」が嘘になる）
- 採用: 読み取りツールを全 Skill に許可する。棄却: rules にだけ `status` を足す（MCP サーバーの説明が検索が空のあとに status を促すので、どの Skill でも起きる）
- 採用: 本文のインラインコードで登録名と完全に一致するものを集める。棄却: ツールを指す明示の書き方を決めて検査する（普通の単語と紛れる `status`・`search`・`read` は全 Skill で必須なので、誤判定が起きない）
- 採用: 共通の 3 行だけを両ファイルで比べる。棄却: 箇条書き全体を比べる（Claude 側と Codex 側で他の行が違う）
- 採用: コメント検査を独立したスクリプトにする。棄却: 英語の検査に混ぜる（目的が違う）
- 採用: migration の先頭コメントから番号だけを消す。棄却: migration を検査の対象から外す（同じ規則が効かなくなる）

## 手順

- S1: #226 の acceptance case を足し、今のコードで落ちることを確かめる
- S2: 最近と古いの判定、`pendingCount`・`pendingSessions`・`pendingText`・`status`・`waiting` の変更、単体テスト、SQL 呼び出し箇所の台帳
- S3: trace の Skill の本文に古い群の説明を足す
- S4: 全 Skill の `allowed-tools` をそろえ、本文と許可のずれの検査を `check-ai-config.mjs` に足す
- S5: コメント規則を書き換え、共通の 3 行の一致の検査を足す
- S6: `check-comments.mjs` とそのテストを足し、`bun run check` に入れる
- S7: 既存の違反コメントを直す
- S8: 既存の plan と tasks 14 ファイルを消す
- S9: `release:plan` を流し、4 つのファイルを 0.6.5 にそろえる

## 完了条件

- A1: `bun run verify` → 0 で終わる
- A2: `bun run --cwd server test` → #226 のテストが通り、31 日のセッションが件数に入らず pending の古い群に出る、29 日とちょうど 30 日は最近、古い未 trace と新しい trace 済みのセッションは最近、31 日の発言が `sources: true` と `asked: true` のそれぞれで見つかる
- A3: `bun run acceptance` → #226 の case が通る。同じ case を `v0.6.4` の worktree で流すと落ちる
- A4: `bun run verify:ai` → どれか 1 つの Skill の `allowed-tools` から `mcp__plugin_sphica_sphica__status` を消すと落ち、Skill の本文に許可の無いツール名を書くと落ち、`comments.md` の共通の 3 行を 1 字変えると落ちる（それぞれ戻して 0 で終わる）
- A5: コメントに `issue #1`・`.claude/plans/x`・`Closes #2` を書いて `bun run comments` → それぞれ落ちる
- A6: `npm pack` した tarball を展開してプラグインとして読み込み、HOME と `SPHICA_DB` を一時ディレクトリにして `claude -p "/sphica:rules call status first, then list live records" --output-format stream-json` → `status` の tool_use があり、その結果が権限の拒否ではない。Codex では `$sphica:rules` が動くことだけを別に記録する
- A7: `find .claude/plans -type f` → この計画の plan と tasks の 2 ファイルだけ
- A8: `bun run release:plan -- --base v0.6.4` → `plugin`、4 つのファイルのバージョンが 0.6.5 で一致
- A9: `gh pr checks --watch` → すべて pass

## リスク

- 検査の正規表現が既存コードで思わぬものに当たる → 規則に反しているならコメントを直す。反していないなら正規表現を狭め、通る例をテストに足す
- 古い群への切り替えで、長く放置した未 trace のセッションが待ちの表示から消え、持ち主が気づかない → `status` と pending に古い件数を出すので、入口は残る
- headless の A6 でエージェントが `status` を呼ばない → 引数で呼ぶよう指示しているので、呼ばなければ実行をやり直す。3 回呼ばなければ未確認として報告する

## 未解決

なし

## 変更履歴
