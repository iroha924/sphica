---
kind: tasks
plan: 04-agent-adoption.plan.md
branch: feat/agent-adoption
base: main
---

# AI が自分で決めた判断を「AI の判断」として採用・配信し、trace を持ち主の依頼なしに AI が回す（段階 1）のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 呼び出し元と schema

record サーバーが誰に呼ばれたかを知り、AI の採用・`decides`・呼び出しの記録を DB が持てるようにする。

- [x] T01: 呼び出し元を実測し、record サーバーが呼び出しの `_meta` と環境変数から、ホスト・セッション・ターン・tool_use_id・起動の形を読む関数を作る
  - 種別: 追加
  - 計画: S1, S13
  - 依存: なし
  - 変更: `server/src/caller.ts`, `server/test/caller.test.ts`, `.claude/plans/2026/10/04-agent-adoption.plan.md`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `cd server && node --test test/caller.test.ts` → pass。実測した値（Claude Code の `cli`・`sdk-cli` と `claudecode/toolUseId`、Codex の `x-codex-turn-metadata` の `exec`）ごとに判別が返り、`sdk-` で始まる値は SDK、値が無い・見たことのない値・Codex の `exec` 以外は不明になる。Codex の値がある呼び出しは Claude の環境変数で分け直さない
  - コミット: `feat(record): identify the calling session, turn, and mode from what the host passes (T01)`
  - 結果: probe の MCP サーバーで実測（Claude Code 2.1.289 の対話は動いている record サーバーの環境変数、`claude -p`、`codex exec`、`claude -p` に PreToolUse の hook）。値は plan の前提に追記。`claude -p` の hook の `tool_use_id` は MCP の `claudecode/toolUseId` と 3 回とも一致（並列 2 回を含む）。`cd server && node --test test/caller.test.ts` → 5 pass / 0 fail。`bun run typecheck` エラーなし、`bun run english` → 終了コード 0、biome は整形後に指摘なし。pre-commit の bundle の検査が package に入るファイルの変更でバージョンの更新を求めたので、`bun run release:plan -- --base 1043f18c` → `plugin` を確かめ、4 つのファイルを 0.6.29（v0.6.29 はタグ済み）から 0.6.30 に上げた

- [x] T02: schema の revision を上げ、`agent` の経路・`decides` の役・run の呼び出し元・record-tool の呼び出しの表・hook の観測の表と capture の insert 用の view・トリガーと `unit_support` を足し、移行を書く
  - 種別: 追加
  - 計画: S2
  - 依存: T01（保存する呼び出し元の項目が決まる）
  - 変更: `db/schema.sql`, `db/migrations/0010.sql`, `server/src/sqlite.ts`, `server/src/db-types.ts`, `server/src/db-write.ts`, `server/src/knowledge.ts`, `server/test/schema.test.ts`, `server/test/db.test.ts`, `server/test/migrate.test.ts`, `server/test/fixtures/schema-rev9.sql`
  - 完了条件: `cd server && node --test test/schema.test.ts` → pass。新しく作った DB と移行した DB の schema が一致し、既存の持ち主の採用は変わらず、run の呼び出し元は不明として移る。`agent` の adoption は assistant の source・組になる `decides` evidence が無いと拒まれ、`reported_speaker` のある evidence とは組めない
  - コミット: `feat(schema): add agent adoption, the decides role, run callers, and record tool calls (T02)`
  - 結果: revision 10。`record_call`・`tool_call_observation`・`capture_tool_call`・`agent_ineligible_source` を足し、`extraction_run.begin_call_id`、evidence の `decides`、adoption の `agent`、`unit_support` の組の条件を入れた。run の呼び出し元は列ではなく begin の呼び出し（`begin_call_id`）で持つ。`cd server && node --test test/schema.test.ts test/db.test.ts test/migrate.test.ts` → 106 pass / 0 fail（revision 1〜9 の移行が新しい DB と同じ定義、`decides`・`agent`・除外の view・役割の拒否を含む）。`bun run test` → 727 pass / 0 fail、`bun run typecheck` エラーなし、`bun run codegen:check` 一致、`node scripts/check-pairs.mjs` → 0

- [x] T03: record ツール用の同期の PreToolUse hook（Claude Code）を足し、record サーバーが呼び出し元を run に結び、全 record ツールの呼び出しを検証と外部取得の前に同期で書き、hook の観測と結び、begin と save で照合する
  - 種別: 追加
  - 計画: S3
  - 依存: T02（呼び出しの表と run の呼び出し元の列が要る）
  - 変更: `server/src/mcp-record.ts`, `server/src/extract.ts`, `server/src/trace.ts`, `server/src/capture.ts`, `server/src/caller.ts`, `plugin/hooks/hooks.json`, `scripts/check-ai-config.mjs`, `scripts/check-sql-live.mjs`, `server/test/record.test.ts`, `server/test/capture.test.ts`
  - 完了条件: `cd server && node --test --test-name-pattern="record call" test/record.test.ts test/capture.test.ts` → pass。hook が spool を通さず同期で観測を書き、サーバーの呼び出しと `tool_use_id` で結ばれる。hook の行が無い呼び出しは不明として残る。`bun run hooks:live` → pass。begin の前で失敗した呼び出し、同じ run を別のターンで使う呼び出しも行が残り、save の呼び出し元が begin と違うと拒まれる。`bun run architecture` → 書き込みの接続が `server/src/db-write.ts` の外に無い
  - コミット: `feat(record): bind the caller to each run and log every record tool call before it runs (T03)`
  - 結果: record サーバーの全ツール（forget を含む 10 個）が、プロジェクトを決めた直後に `record_call` を ingest で単独に commit してから動く。begin は run に `begin_call_id` を持たせ、save は begin と自分の呼び出しのセッションを比べる（Claude Code は hook の観測、Codex は `_meta`。サーバーの環境変数は使わない）。Claude Code の record ツール用の同期の PreToolUse hook が `capture_tool_call` に直接書く。`node --test --test-name-pattern="record call" test/record.test.ts test/capture.test.ts` → 3 pass / 0 fail。`bun run verify` → 終了コード 0（SQL 到達 204/204、実 DB 10/10、hooks:live、受け入れ 105 pass、architecture の reader 境界）

- [x] T16: T02 のレビュー指摘を直す（結べなかった呼び出しの後の返事をすべて外す、run の begin の呼び出しを同じプロジェクトに限る）
  - 種別: 修正
  - 計画: S2
  - 依存: T02（直す対象の schema）
  - 変更: `db/schema.sql`, `db/migrations/0010.sql`, `server/test/schema.test.ts`
  - red: `cd server && node --test --test-name-pattern="never carry agent adoption|own project" test/schema.test.ts` → 直す前の schema では、結べなかった呼び出しの後の 2 つ目の返事が外れずに落ち、別プロジェクトの呼び出しを begin に持つ run が拒まれずに落ちる
  - 完了条件: `cd server && node --test test/schema.test.ts test/migrate.test.ts test/db.test.ts` → pass。hook と結べなかった呼び出しの後は、同じプロジェクト・ホストの返事がすべて AI の採用の対象外になり、run の `begin_call_id` は同じプロジェクトの呼び出しだけを指せる
  - コミット: `fix(schema): rule out replies after an unplaced call and keep begin calls in the project (T16)`
  - 結果: red を実測（コミット済みの schema.sql に戻して 2 件 fail）。直した後 `node --test test/schema.test.ts test/migrate.test.ts test/db.test.ts` → 107 pass / 0 fail。`bun run codegen:check` 一致。0010.sql は schema.sql から作り直した

## P2: 権限と持ち主の判断の保護

持ち主の判断を AI の経路でも候補の記録でも覆せないようにし、AI の判断を条件つきで active にする。

- [ ] T04: 持ち主の判断を指す supersedes / conflicts を、同じ保存で持ち主が採用した記録からだけ通す
  - 種別: 修正
  - 計画: S4
  - 依存: なし
  - 変更: `server/src/record.ts`, `server/src/extract.ts`, `server/test/record.test.ts`, `server/test/deliver.test.ts`
  - red: `cd server && node --test --test-name-pattern="owner decision protected" test/record.test.ts test/deliver.test.ts` → 採用の無い候補の conflicts で持ち主の active な記録が配信から消え、候補の supersedes の後に持ち主が採用した後継が拒まれて落ちる
  - 完了条件: `cd server && node --test --test-name-pattern="owner decision protected" test/record.test.ts test/deliver.test.ts` → pass。関係の無い持ち主の発言を採用に引いた記録の link も拒まれる
  - コミット: `fix(record): only an owner-adopted record may supersede or conflict with an owner decision (T04)`

- [ ] T05: 権限の判定関数を作り、保存と glean のすべての操作で変更の前後を確かめる。AI の supersedes を禁じ、AI どうしの conflicts を通す
  - 種別: 追加
  - 計画: S4
  - 依存: T02（`agent` の経路が要る）, T04（link の規則をこの関数へ移す）
  - 変更: `server/src/authority.ts`, `server/src/record.ts`, `server/src/extract.ts`, `server/src/glean.ts`, `server/test/record.test.ts`
  - 完了条件: `cd server && node --test --test-name-pattern="authority" test/record.test.ts` → pass。持ち主 > AI > なしの判定が、その時点の採用と撤回から出る。`decides` evidence の撤回・後からの持ち主の採用・anchor の変更・衝突の解決の前後で判定が変わる場合を確かめる。glean の撤回と衝突の解決は今までどおり持ち主の根拠を求める
  - コミット: `feat(record): judge authority from adoption history and check it on every write (T05)`

- [ ] T06: record.ts で `agent` の採用を受ける（`decides` との組、質問・record ツールのターン・不明な呼び出し元の除外、`do` で anchor のある判断の同じターンの編集、パスの一覧の警告）
  - 種別: 追加
  - 計画: S5
  - 依存: T03（record-tool の呼び出しの行で除外する）, T05（権限の判定が要る）, T16（除外の view と begin の呼び出しの規則が直っている）
  - 変更: `server/src/record.ts`, `server/test/record.test.ts`
  - 完了条件: `cd server && node --test --test-name-pattern="agent adoption" test/record.test.ts` → pass。条件をすべて満たす AI の判断が active になり、AskUserQuestion の質問・`reported_speaker`・`decides` でない引用・record ツールを呼んだターンの返事・呼び出し元が不明の run・同じターンに anchor の path の編集が無い `do` は候補に残る。パスの一覧に当たる `applies_to` は警告を出して候補に残る
  - コミット: `feat(record): adopt an AI's own decision when it quotes the AI deciding and passes the exclusions (T06)`

## P3: 表示と自動の trace

次のセッションが持ち主の判断と AI の判断を見分け、AI が持ち主に聞かずに trace を回す。

- [ ] T07: 配信・read・search・record_context・review の表示に記録ごとの権限を出し、AI の判断に専用の固定文を付ける
  - 種別: 変更
  - 計画: S6
  - 依存: T05（権限の判定が要る）
  - 変更: `server/src/deliver.ts`, `server/src/read.ts`, `server/src/search.ts`, `server/src/extract.ts`, `server/src/review.ts`, `server/test/deliver.test.ts`, `server/test/deliver-codex.test.ts`
  - 完了条件: `cd server && node --test test/deliver.test.ts test/deliver-codex.test.ts` → pass。持ち主の判断には今の CONFIRM、AI の判断には専用の文が付き、どちらの文も記録の本文から取らない。read の履歴の権限はその時点のもの。conflicts で止めていることが撤回と分けて出る
  - コミット: `feat(deliver): show whether the owner or an AI made each decision (T07)`

- [ ] T08: trace の Skill を両ホストで自動で起動できるようにし、自動のときの手順と `decides`・`agent` の採用の規則を書く
  - 種別: 変更
  - 計画: S7
  - 依存: T06（`decides` と `agent` の採用が record_check を通る）
  - 変更: `plugin/skills/trace/SKILL.md`, `plugin/skills/trace/agents/openai.yaml`, `scripts/check-ai-config.mjs`
  - 完了条件: `node scripts/check-ai-config.mjs` → 終了コード 0。`bun run verify:ai` → pass。両ホストの起動の設定がそろい、description に「明示の依頼のときだけ」が残っていない
  - コミット: `feat(trace): let the agent run trace on its own and adopt its own decisions under fixed rules (T08)`

- [ ] T09: 自動のときの未処理と再開（assistant source を数える、古い順に SQL で選ぶ、前の文脈を決まった数だけ添える、上限で読んだ範囲を保存する）
  - 種別: 変更
  - 計画: S8
  - 依存: なし
  - 変更: `server/src/trace.ts`, `server/src/extract.ts`, `server/src/status.ts`, `server/test/record.test.ts`
  - 完了条件: `cd server && node --test --test-name-pattern="auto pending" test/record.test.ts` → pass。後から届いた assistant source が次の回で未処理になり、上限で止めた run の後の run が続きから始まり、文脈と対象が分けて出る。明示の trace の挙動は変わらない
  - コミット: `feat(trace): resume automatic traces from unprocessed messages, oldest sessions first (T09)`

- [ ] T10: 新しい持ち主のセッションの開始時に、自動の trace の通知をセッションごとに 1 回出す
  - 種別: 変更
  - 計画: S8
  - 依存: T01（対話と headless・SDK を見分ける）, T08（Skill が自動で起動できる）, T09（自動の未処理の数え方が要る）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`, `server/test/deliver-codex.test.ts`, `scripts/check-hooks-live.mjs`
  - 完了条件: `cd server && node --test --test-name-pattern="auto trace notice" test/deliver.test.ts test/deliver-codex.test.ts` → pass。対話の持ち主のセッションで 1 回だけ出て、resume・headless・SDK・判別できない形では出ない。`bun run hooks:live` → pass
  - コミット: `feat(deliver): ask the agent to trace waiting sessions at the start of each new owner session (T10)`

## P4: 評価への備えと出荷

段階 2 が AI の判断を取り出せるようにし、受け入れケースをそろえて出す。

- [ ] T11: 一度でも AI の判断として active になった記録を、その時点の採用元と content hash、今の状態つきで返す関数を足す
  - 種別: 追加
  - 計画: S9
  - 依存: T05（その時点の権限の判定が要る）
  - 変更: `server/src/authority.ts`, `server/test/record.test.ts`
  - 完了条件: `cd server && node --test --test-name-pattern="agent history" test/record.test.ts` → pass。持ち主が後から採用した記録と AI の採用が撤回された記録が一覧に残り、最初に active になった時刻と当時の content hash が返る
  - コミット: `feat(record): list records that were ever active as AI decisions for evaluation (T11)`

- [ ] T12: 受け入れケースを足す（伝聞の平文、取得したページの注入文、無関係な編集、質問、trace の報告、持ち主の判断の保護、自動の trace の通知）
  - 種別: 追加
  - 計画: S10
  - 依存: T06（AI の採用の挙動が要る）, T10（通知の挙動が要る）
  - 変更: `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`, `server/evals/acceptance/load.ts`
  - 完了条件: `bun run acceptance` → pass。足したケースのうち持ち主の判断の保護は main のコードで落ちる
  - コミット: `test(acceptance): cover AI adoption exclusions, owner decision protection, and the auto trace notice (T12)`

- [ ] T13: 配布する Skill を権限に合わせる（review の過去の判断の観点、export、rules）
  - 種別: 変更
  - 計画: S11
  - 依存: T07（権限が表示に出る）
  - 変更: `plugin/skills/review/reviewers/precedent.md`, `plugin/skills/export/SKILL.md`, `plugin/skills/rules/SKILL.md`, `server/src/review.ts`, `server/src/export.ts`, `server/test/review.test.ts`
  - 完了条件: `bun run verify:ai` → pass。`cd server && node --test test/review.test.ts` → pass。review の観点が持ち主の判断から外れる差分を今どおり指摘し、AI の判断から外れる差分は理由が書かれていないときだけ指摘する。export と rules の一覧と下書きに権限が出て、rules は AI の判断を選ぶときに規範に格上げされることを 1 行で知らせる
  - コミット: `feat(skills): weigh owner and AI decisions differently in review, export, and rules (T13)`

- [ ] T14: README.md・README.ja.md・CLAUDE.md・AGENTS.md・knowledge-schema の Skill を今の挙動に合わせ、ほかの開発の文書を確かめる
  - 種別: 変更
  - 計画: S12
  - 依存: T10（自動の trace の挙動が決まる）, T13（配布する Skill の挙動が決まる）
  - 変更: `README.md`, `README.ja.md`, `CLAUDE.md`, `AGENTS.md`, `.agents/skills/knowledge-schema/SKILL.md`
  - 完了条件: `node scripts/check-pairs.mjs && bun run english && bun run verify:ai` → 終了コード 0。`rg -n "end of a session|セッションの終わりに" README.md README.ja.md` → 手で trace を流すことだけを前提にした案内が残っていない。plan の方針 12 の項目が両言語の README にそろって入っている。`rg -n -i "only the owner|owner's words|explicitly asks|持ち主の言葉" .claude .agents plugin/skills README.md README.ja.md CLAUDE.md AGENTS.md` → 残った行が、持ち主の判断についての記述として今の挙動と合っている
  - コミット: `docs: describe AI decisions and automatic tracing in the READMEs and agent instructions (T14)`

- [-] T15: `release:plan` で種類を確かめ、npm と 3 つの manifest を同じ新しいバージョンに上げる
  - 種別: 変更
  - 計画: S13
  - 依存: T14（出す中身と文書がそろう）
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run release:plan -- --base <前のリリースのコミット>` → `plugin`。4 つのファイルのバージョンが同じ。`bun run verify` → 終了コード 0
  - コミット: `chore(release): bump the plugin version for AI adoption (T15)`

## 記録

- 2026-10-04 / T01・T02・T03 / 実測で Claude Code の MCP 呼び出しにターンが無いと分かり、持ち主が record ツール用の同期の PreToolUse hook（案 A）を選んだ / T01 の題名と完了条件（前: 両ホストの全形の実測と plan への追記 → 後: 実測した値の判別。実測は plan の前提に追記済み、対話の Codex・SDK・Windows は未検証として plan に残す）、T02 の題名と変更欄（`server/src/db-write.ts` を足す）、T03 の題名・変更欄・完了条件（hook と capture を足す）を直した
- 2026-10-04 / T01・T15 / pre-commit の bundle の検査が、package に入る最初の変更（`server/src/caller.ts`）のコミットでバージョンの更新を求めた / T15 を取りやめ、バージョンの更新（S13 の一部）を T01 に移した。T01 の計画欄（前: S1 → 後: S1, S13）と変更欄（4 つのファイルを足す）を直した。main が先に新しいバージョンを出したら、マージのときに次のバージョンへ上げ直す
- 2026-10-04 / T02 / 変更欄（前: `db/schema.sql`, `server/src/sqlite.ts`, `server/src/db-types.ts`, `server/src/db.ts`, `server/src/db-write.ts`, `server/test/schema.test.ts` → 後: `server/src/db.ts` を外し、移行・語彙・fixture・役割と移行のテストを足す）。run の呼び出し元を列でなく `begin_call_id` で持つことにした（save の照合は begin の呼び出しと比べるだけで足りるため）
- 2026-10-04 / T03 / 変更欄（前: `server/src/db-write.ts` を含む → 後: `db-write.ts` は T02 で済んだので外し、`server/src/trace.ts`・`server/src/caller.ts`・`scripts/check-sql-live.mjs` を足す）。save の照合は、どちらかのセッションが分からないときは拒まない。その save で AI の採用が通らないよう、T06 で save の呼び出しも対話であることを条件に足す
- 2026-10-04 / T16 / T02 の Codex のレビュー（F1 P1: 結べなかった呼び出しで最初の返事のターンしか外さず、plan の方針 2 の「結べるまで止める」より緩かった。F2 P2: `begin_call_id` が別プロジェクトの呼び出しを指せ、その対話の判定を借りられた）を両方受け、修正タスク T16 を足して直した。T06 の依存に T16 を足した（前: T03, T05 → 後: T03, T05, T16）
