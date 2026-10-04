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

- [x] T17: T03 のレビュー指摘を直す（Claude Code の record ツールの hook の行だけでそのターンを外す）
  - 種別: 修正
  - 計画: S3
  - 依存: T03（直す対象の呼び出しの記録）, T16（同じ view を直したもの）
  - 変更: `db/schema.sql`, `db/migrations/0010.sql`, `server/test/schema.test.ts`, `.claude/plans/2026/10/04-agent-adoption.plan.md`
  - red: `cd server && node --test --test-name-pattern="hook row alone" test/schema.test.ts` → 直す前の view は `record_call` と結べた hook の行しか見ないので、サーバーに届かなかった呼び出しのターンが外れずに落ちる
  - 完了条件: `cd server && node --test test/schema.test.ts test/migrate.test.ts test/db.test.ts` → pass。サーバーに届かなかった record ツールの呼び出しも、hook の行でそのターンが AI の採用の対象外になる
  - コミット: `fix(schema): let a record tool's hook row alone rule out its turn (T17)`
  - 結果: red を実測（直す前の view で 1 件 fail）。直した後 `node --test test/schema.test.ts test/migrate.test.ts test/db.test.ts` → 108 pass / 0 fail。`bun run codegen:check` 一致。Codex の拒まれた呼び出しは plan のリスクに足した

## P2: 権限と持ち主の判断の保護

持ち主の判断を AI の経路でも候補の記録でも覆せないようにし、AI の判断を条件つきで active にする。

- [x] T04: 持ち主の判断への link の効き目を権限で止める（C′: 配信を止めるのは持ち主が採用した相手との衝突だけ、後継の枠を使うのは採用された後継だけ、待っていた候補は他の後継が立った後に active になれない）
  - 種別: 修正
  - 計画: S4
  - 依存: なし
  - 変更: `db/schema.sql`, `db/migrations/0010.sql`, `server/src/record.ts`, `server/src/deliver.ts`, `server/test/schema.test.ts`, `server/test/migrate.test.ts`, `server/test/deliver.test.ts`, `server/test/extract.test.ts`, `server/test/review-bridge.test.ts`, `.claude/plans/2026/10/04-agent-adoption.plan.md`
  - red: `cd server && node --test --test-name-pattern="owner decision protected|never holds the owner" test/deliver.test.ts test/schema.test.ts` → 採用されていない候補の conflicts で持ち主の判断が配信から消え（`actual: ''`）、候補の後継が枠をふさいで持ち主自身の後継が「already has a successor that is not withdrawn」で拒まれて落ちる
  - 完了条件: `cd server && node --test --test-name-pattern="owner decision protected|never holds the owner" test/deliver.test.ts test/schema.test.ts` → pass。`bun run verify` → 終了コード 0。glean の後採用の流れ（候補の後継をあとで adopt する）は残り、他の後継が立った後の adopt は拒まれる
  - コミット: `fix(record): stop unadopted links from hiding or displacing the owner's decision (T04)`
  - 結果: red を実測（配信は `actual: ''`、schema は「the record already has a successor that is not withdrawn」）。直した後、上の 2 件 pass。`bun run verify` → 終了コード 0（テスト 734 件、SQL 到達 204/204、実 DB 10/10、受け入れ 105 pass）。Codex の C7〜C10 どおり、後採用の流れの 3 件は期待を保ち、候補が枠をふさぐ期待（extract）と、採用を持てない question で持ち主の判断を隠すデータ（deliver・review-bridge）と、rev4 の移行テストの最後の確認を C′ に合わせた

- [x] T18: T04 のレビュー指摘を直す（後継の枠を view 1 つで決め、取り下げからの復帰・同じ保存の予約・overview の案内をそろえる）
  - 種別: 修正
  - 計画: S4
  - 依存: T04（直す対象の後継の枠の規則）
  - 変更: `db/schema.sql`, `db/migrations/0010.sql`, `server/src/db-types.ts`, `server/src/record.ts`, `server/src/overview.ts`, `server/test/schema.test.ts`, `server/test/record.test.ts`, `server/test/overview.test.ts`
  - red: `cd server && node --test --test-name-pattern="whatever proposal waits|does not take the place the owner's successor takes|look names the successor that took" test/schema.test.ts test/record.test.ts test/overview.test.ts` → 持ち主の後継を取り下げても元の判断が superseded のまま、同じ保存で持ち主の後継が「another record in this save already supersedes」で拒まれ、overview が待っている候補を後継と案内して落ちる
  - 完了条件: 同じコマンド → pass。`bun run verify` → 終了コード 0。枠を使う後継の定義が `unit_successor_place` の 1 か所にあり、link の trigger・復帰の規則・復帰の trigger・record.ts・overview がそれを読む
  - コミット: `fix(record): judge the successor place in one view and follow it everywhere (T18)`
  - 結果: red を実測（3 件とも上の理由で fail）。直した後 3 件 pass。`bun run verify` → 終了コード 0（SQL 到達 204/204、実 DB 10/10、受け入れ 105 pass）。overview に一度足した予備の問い合わせは、superseded の記録には必ず枠を使う後継があり届かないので消した

- [x] T19: T18 のレビュー指摘を直す（持ち主の判断の後継の枠を active になった後継だけにし、採用の撤回でも元の判断を戻す。search と read を合わせる）
  - 種別: 修正
  - 計画: S4
  - 依存: T18（直す対象の view）
  - 変更: `db/schema.sql`, `db/migrations/0010.sql`, `server/src/record.ts`, `server/src/search.ts`, `server/src/read.ts`, `server/test/record.test.ts`, `.claude/plans/2026/10/04-agent-adoption.plan.md`
  - red: `cd server && node --test --test-name-pattern="adoption is taken back|search and read name only|order of a waiting proposal" test/record.test.ts` → 採用の撤回で元の判断が superseded のまま、取り下げた後継が `liveSuccessors` に残り、[持ち主の後継, 提案] の順で持ち主の後継が拒まれて落ちる
  - 完了条件: 同じコマンド → pass。`bun run verify` → 終了コード 0
  - コミット: `fix(record): let only an active successor hold the owner's decision's place (T19)`
  - 結果: red を実測（3 件とも上の理由で fail）。直した後 3 件 pass、T04・T18 の後継の枠のテストも pass。`bun run verify` → 終了コード 0（SQL 到達 204/204、実 DB 10/10、受け入れ 105 pass）。read は待っている提案を「Replacement proposed by ...」と分けて出す

- [x] T20: 後継の枠をどの記録でも同じ規則にし、連鎖をまとめて戻す（T19 のレビュー指摘）
  - 種別: 修正
  - 計画: S4
  - 依存: T19（直す対象の枠の規則）
  - 変更: `db/schema.sql`, `db/migrations/0010.sql`, `server/src/db-write.ts`, `server/src/record.ts`, `server/test/schema.test.ts`, `server/test/record.test.ts`, `.claude/plans/2026/10/04-agent-adoption.plan.md`
  - red: `cd server && node --test --test-name-pattern="end of a chain leaves active|same rule holds whether or not" test/record.test.ts` → 連鎖の末尾が active から外れても先頭が superseded のまま残り、持ち主の判断でない記録への 2 つ目の提案の link が「already has a successor that is not withdrawn」で拒まれて落ちる
  - 完了条件: 同じコマンド → pass。`bun run verify` → 終了コード 0
  - コミット: `fix(record): hold a successor place the same way for every record and free whole chains (T20)`
  - 結果: red を実測（2 件とも上の理由で fail）。直した後 pass、T04・T18・T19 の後継の枠のテストも pass。forget の接続が再帰の読み取りを拒んだので許した（他の役割と同じ）。旧い規則を前提にした schema のテスト 2 件を新しい規則に書き換えた。`bun run verify` → 終了コード 0（テスト 742 件、SQL 到達 204/204、実 DB 10/10、受け入れ 105 pass）

- [x] T21: 純粋な `judge(snapshot)` と、`supersedes` でつながる範囲の取得を作る（同期。保存用と移行用の adapter に分ける）
  - 種別: 追加
  - 計画: S14
  - 依存: なし
  - 変更: `server/src/judge.ts`, `server/src/record.ts`, `server/test/judge.test.ts`
  - 完了条件: `cd server && node --test test/judge.test.ts` → pass。plan の方針 5 の条件を snapshot ごとに確かめ、T04・T18・T19・T20 のレビューの 13 件と C18・C20・C22・C23・C25〜C29・C33 の入力が期待どおりの状態・開く行・閉じる行・待つ理由になる。同じ事実を操作の順番を変えて与えても結果が同じで、結果をもう一度 judge に通しても差分が出ない
  - コミット: `feat(record): judge lifecycles and replacements from facts in one pure function (T21)`
  - 結果: `cd server && node --test test/judge.test.ts` → 15 pass / 0 fail（T04 F1・F2、T18 F1〜F4、T19 F1〜F3、T20 F1・F2、C2・C18・C20・C22・C23・C25・C26・C28・C29 の入力。順番を入れ替えても同じ結果、判定済みの事実は差分なし）。依存が 1 つのつもりだけなので、枠の持ち主は相手ごとに独立して決まり、再帰も繰り返しも要らない。種類の互換 `replaceable` を record.ts から judge.ts に寄せた。`bun run verify` → 終了コード 0、knip で未使用の export なし

- [x] T22: schema を事実と結果に分け（`unit_replacement`、1 記録 1 つのつもり、印、superseded から active への遷移、trigger を確かめだけにする）、record・glean・forget の保存を「事実 → 正規化 → judge → 差分 → 最後の整合の確認」に集める。view と再帰の復帰と `takes` を外す
  - 種別: 変更
  - 計画: S15
  - 依存: T21（判定の本体が要る）
  - 変更: `db/schema.sql`, `db/migrations/0010.sql`, `server/src/db-types.ts`, `server/src/db-write.ts`, `server/src/judge.ts`, `server/src/reconcile.ts`, `server/src/record.ts`, `server/src/glean.ts`, `server/src/forget.ts`, `server/src/overview.ts`, `scripts/check-architecture.mjs`, `server/test/judge.test.ts`, `server/test/schema.test.ts`, `server/test/record.test.ts`, `server/test/extract.test.ts`, `server/test/forget.test.ts`
  - 完了条件: `cd server && node --test --test-name-pattern="successor place|owner decision protected" test/*.test.ts` → pass（13 件の回帰を含む）。`bun run architecture` → `unit_state` と `unit_replacement` を書くのが reconcile のモジュールだけ。`bun run verify` → 終了コード 0
  - コミット: `refactor(record): keep facts apart from judged lifecycles and replacements (T22)`
  - 結果: `unit_replacement`（開いた行が後継の枠、1 回だけ終わる、消せない）と、1 記録 1 つのつもりの index を足し、推し量る view・連鎖を戻す trigger・根拠の撤回を拒む 3 つの trigger を外した。状態の規則に superseded から active への遷移と「superseded には開いた行」「置き換えのある記録は active にならない」を入れた。record・glean・forget は事実だけを書き、最後に `reconcile`（つながる範囲 → judge → 閉じる行・開く行・状態の行 → もう一度判定して差分なし）を 1 回だけ通す。`bun run architecture` → `lifecycle writers: only server/src/reconcile.ts writes unit_state and unit_replacement`。`bun run verify` → 終了コード 0（SQL 到達 197/197、実 DB 10/10、受け入れ 105 pass）

- [x] T23: revision 9 からの移行で、証明できる期間を戻し、移行の時点の行と「履歴が記録されていない」印を作り、複数のつもりで止め、固定した judge を同期で通してメモに出す
  - 種別: 変更
  - 計画: S16
  - 依存: T22（新しい schema と judge の adapter が要る）
  - 変更: `db/schema.sql`, `db/migrations/0010.sql`, `db/migrations/0010.check.sql`, `server/src/db-types.ts`, `server/src/admin.ts`, `server/src/reconcile.ts`, `server/test/migrate.test.ts`
  - 完了条件: `cd server && node --test --test-name-pattern="revision 9" test/migrate.test.ts` → pass。後採用・全員が候補の後継・連鎖・中間の記録の権限喪失・再採用の fixture で、移行した DB の状態と行が新しい DB で同じ事実を保存した結果と一致し、複数のつもりを持つ DB は何も変えずに止まって一覧を出す
  - コミット: `feat(schema): rebuild replacements and repair lifecycles when moving to revision 10 (T23)`
  - 結果: 移行の SQL が、今効いている置き換え（最後に superseded になった時刻から）と、取り下げで終わった過去の期間（取り下げと復帰が同じ時刻のものだけ）を行として戻し、日付の分からないつもりに `unit_replacement_gap` の印を付ける。そのあと同期版の `settleForMigration`（reconcile.ts。計画づくりは保存と同じ）が、状態の行を持つ記録をプロジェクトごとに判定し、差分を書いてメモに出す。複数のつもりを持つ記録があれば 0010.check.sql で止める。`cd server && node --test test/migrate.test.ts` → 47 pass / 0 fail（revision 9 の連鎖・過去の期間・印・判断し直し、複数のつもりで何も変えずに止まる、を含む）。`bun run verify` → 終了コード 0（SQL 到達 199/199、実 DB 10/10、受け入れ 105 pass）

- [x] T27: T23 のレビュー指摘を直す（過去の期間は、取り下げの直前まで active だった後継からだけ戻す）
  - 種別: 修正
  - 計画: S16
  - 依存: T23（直す対象の移行）
  - 変更: `db/migrations/0010.sql`, `server/test/migrate.test.ts`
  - red: `cd server && node --test --test-name-pattern="not one withdrawn with it" test/migrate.test.ts` → 直す前の移行は、同じ保存で一緒に取り下げた一度も active でない出典なしの候補にも、同じ過去の期間を作って落ちる
  - 完了条件: `cd server && node --test test/migrate.test.ts` → pass
  - コミット: `fix(schema): date a past replacement only from the successor that was in effect (T27)`
  - 結果: red を実測（候補 q にも 9/21〜9/22 の期間ができて fail）。取り下げの行が active からのものだけを証拠にした。`node --test test/migrate.test.ts` → 48 pass / 0 fail

- [x] T24: 読み手（search・overview・read・export・review・rules・record_context）を `unit_replacement` に合わせ、つもり・今の効き目・閉じた期間・印・待つ理由を分けて出す
  - 種別: 変更
  - 計画: S17
  - 依存: T22（新しい表が要る）
  - 変更: `server/src/search.ts`, `server/src/read.ts`, `server/src/export.ts`, `server/test/search.test.ts`, `server/test/overview.test.ts`, `server/test/export.test.ts`, `server/test/review.test.ts`
  - 完了条件: `cd server && node --test test/search.test.ts test/overview.test.ts test/export.test.ts test/review.test.ts` → pass。過去の時点の read も、その時点で開いていた行だけを置き換えとして出す
  - コミット: `feat(read): show replacements, waiting proposals, and unrecorded history apart (T24)`
  - 結果: search の後継（`liveSuccessors`）と export の連なりは開いている `unit_replacement` の行だけをたどる。read は「Supersedes X (in effect since … / not in effect[: Y is in effect as its successor])」「Replaced X from … to …: 理由」「Superseded by X (since …)」「Was superseded by X from … to …: 理由」「Replacement proposed by X (状態)」を分けて出し、過去の時点では [started_at, ended_at) に入る行だけを効いている置き換えとする。overview・review・extract は保存された状態と開いた行だけを読んでいて変更なし（保存の出力は reconcile の待つ理由を `△ key candidate: 理由` で出す）。「履歴が記録されていない」印は保存先がまだ無いので出していない（T23 で印を作るときに read へ足す）。`cd server && node --test test/search.test.ts test/overview.test.ts test/export.test.ts test/review.test.ts` → 52 pass / 0 fail（足したケースのうち search の 3 件は変更前の読み手で落ちることを確かめた）。`bun run verify` → 終了コード 0（SQL 到達 198/198、実 DB 10/10、受け入れ 105 pass）

- [x] T25: 役割ごとの実接続、全 rollback、操作の順番、再採用・同じ保存の取り下げ・隔離・出典なしの受け入れケースと、保存 1 回のロック時間の測定を足す
  - 種別: 追加
  - 計画: S18
  - 依存: T22（保存の経路が要る）, T23（移行が要る）
  - 変更: `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`, `server/test/reconcile.test.ts`, `server/test/db.test.ts`, `server/test/acceptance-cases.test.ts`
  - 完了条件: `bun run acceptance` → pass。`cd server && node --test --test-name-pattern="judge budget" test/reconcile.test.ts` → pass（保存 1 回のロックが 200 ms 以内）
  - コミット: `test(record): cover reconciling saves end to end and keep their lock time in budget (T25)`
  - 結果: 受け入れに層 reconcile の 8 件（ja 4・en 4。AI の提案が待っていても持ち主の判断が配信に残る / 提案が待っていても持ち主の後継を保存できる / その後継を取り下げると持ち主の判断が戻る / 連鎖の末尾の採用を撤回すると枠が中間に戻る / 末尾を再び採用すると連鎖全体が置き換わる / 元の記録と提案を同じ保存で取り下げると両方取り下がる / 隔離された記録は置き換わらず保存が理由を出す / 出典なしの記録は後継で置き換わる）と、driver の期待 `unit_read`・`save_notes_contain` を足した。main（c09283df）のコードに同じ cases.json と driver を載せて流し、8 件とも落ちることを確かめた（02・03 は持ち主の後継の保存が「already has a successor, …duckdb (candidate)」で拒まれる、04 は末尾の撤回後も中間が superseded のまま、07 は保存が `CHECK constraint failed: extraction = 'supported' or lifecycle = 'candidate'` で失敗、01・05・06・08 は状態は main でも同じで、read が提案を「Superseded by」と出す・置き換えの期間を出さないことで落ちる）。`server/test/reconcile.test.ts` に、置き換えの行を失った superseded の記録を次の保存が直すこと、reconcile の途中で失敗した保存が run 以外の書き込みをすべて戻すこと、3 つの保存の 6 通りの順番と glean の 2 つの操作の順番で同じ状態と行になること、judge budget（3,200 件・長さ 20 の連鎖 150 本・待っている提案 200 件の相手への持ち主の後継の保存）を足した。`server/test/db.test.ts` に ingest と forget が `unit_replacement` を足し終わりの列だけを書けるテストを足した。`cd server && node --test test/reconcile.test.ts test/db.test.ts test/acceptance-cases.test.ts` → 33 pass / 0 fail。`cd server && node --test --test-name-pattern="judge budget" test/reconcile.test.ts` → pass（ロック 8.7〜37.5 ms、単独で流すと 33.3 ms、全テストと並べて 14.7 ms）。`cd server && bun run test` → 778 pass / 0 fail。`bun run acceptance` → 113 pass / 0 fail。`bun run verify` → 終了コード 0（SQL 到達 201/201、実 DB 10/10、受け入れ 113 pass）

- [x] T05: 権限の判定関数を作り、保存と glean のすべての操作で変更の前後を確かめる。AI の supersedes を禁じ、AI どうしの conflicts を通す
  - 種別: 追加
  - 計画: S4
  - 依存: T02（`agent` の経路が要る）, T04（link の規則をこの関数へ移す）, T22（権限の条件を judge の eligible とそろえる）
  - 変更: `server/src/authority.ts`, `server/src/deliver.ts`, `server/src/read.ts`, `server/test/authority.test.ts`
  - 完了条件: `cd server && node --test test/authority.test.ts` → pass。持ち主 > AI > なしの判定が、その時点の採用と撤回から出る（AI の採用の前・後、持ち主の採用の後、持ち主の撤回の後）。read の見出しにその時点の判定が出る
  - コミット: `feat(record): judge authority from adoption history and check it on every write (T05)`
  - 結果: `server/src/authority.ts` に `authorityOf`（その時点の採用と撤回から持ち主・AI・なし）と、配信と共有する `ownerAdopted` を置いた。`cd server && node --test test/authority.test.ts` → 1 pass（AI の採用は本物の trigger の条件をそろえて作った）。read の見出しに「the owner's decision」「decided by an AI」「adopted by no one」を出す。`bun run verify` → 終了コード 0（SQL 到達 202/202、受け入れ 105 pass）

- [x] T06: record.ts で `agent` の採用を受ける（`decides` との組、質問・record ツールのターン・不明な呼び出し元の除外、`do` で anchor のある判断の同じターンの編集、パスの一覧の警告）
  - 種別: 追加
  - 計画: S5
  - 依存: T03（record-tool の呼び出しの行で除外する）, T05（権限の判定が要る）, T16（除外の view と begin の呼び出しの規則が直っている）, T22（AI の採用を judge の条件に入れる）
  - 変更: `server/src/record.ts`, `server/src/extract.ts`, `server/src/mcp-record.ts`, `server/src/rule-files.ts`, `server/src/export.ts`, `server/test/record.test.ts`, `.claude/plans/2026/10/04-agent-adoption.plan.md`
  - 完了条件: `cd server && node --test --test-name-pattern="agent adoption" test/record.test.ts` → pass。条件をすべて満たす AI の判断が active になり、AskUserQuestion の質問・`reported_speaker`・`decides` でない引用・record ツールを呼んだターンの返事・呼び出し元が不明の run・同じターンに anchor の path の編集が無い `do` は候補に残る。パスの一覧に当たる `applies_to` は警告を出して候補に残る
  - コミット: `feat(record): adopt an AI's own decision when its reply decided it and passes the checks (T06)`
  - 結果: check と save は、run を始めた呼び出しと今の呼び出しの両方が対話のとき（`agentRun`）だけ、AI の返事の引用を `agent` の採用として受け、anchor を見たあとで `agentRefusal` が条件（同じ言葉の decides、質問でない、record ツールのターンでない、規約・CI のファイルでない、do でコードを決めるなら同じターンの編集）を確かめ、満たさないものは理由つきで外す。save の出力にも check の注意を出すようにした。`cd server && node --test --test-name-pattern="agent adoption" test/record.test.ts` → 4 pass（受ける例、質問・states・trace のターン・CLAUDE.md、編集の有無、headless）。`bun run verify` → 終了コード 0（SQL 到達 205/205、受け入れ 105 pass）

## P3: 表示と自動の trace

次のセッションが持ち主の判断と AI の判断を見分け、AI が持ち主に聞かずに trace を回す。

- [x] T07: 配信・read・search・record_context・review の表示に記録ごとの権限を出し、AI の判断に専用の固定文を付ける
  - 種別: 変更
  - 計画: S6
  - 依存: T05（権限の判定が要る）, T24（読み手が新しい表を読む）
  - 変更: `server/src/deliver.ts`, `server/src/read.ts`, `server/src/search.ts`, `server/src/mcp.ts`, `server/src/extract.ts`, `server/src/trace.ts`, `server/test/deliver.test.ts`, `server/test/search.test.ts`
  - 完了条件: `cd server && node --test test/deliver.test.ts test/deliver-codex.test.ts` → pass。持ち主の判断には今の CONFIRM、AI の判断には専用の文が付き、どちらの文も記録の本文から取らない。read の履歴の権限はその時点のもの。conflicts で止めていることが撤回と分けて出る
  - コミット: `feat(deliver): show whether the owner or an AI made each decision (T07)`
  - 結果: 配信の 5 か所（編集の前・読む前・発言・セッションの開始・レビュー）で AI の判断に「decided by an AI」を付け、AI の判断を含むときだけ固定文 `AI_DECIDED` とその長さぶんの枠を足す（持ち主の判断は今の CONFIRM のまま）。search の結果・record_context の生きている記録・read の見出しに誰の判断かを出す。read の未解決の衝突に、配信から外れているか（撤回ではない）を出す。`cd server && node --test test/deliver.test.ts test/deliver-codex.test.ts test/search.test.ts` → pass（AI の印と固定文、持ち主の判断には付かない、衝突の 2 通り）。`bun run verify` → 終了コード 0（SQL 到達 205/205、受け入れ 105 pass）。途中で record.test の rename limit のテストが 1 回だけ時間切れで落ち、単独とまとめての再実行で通った（別の作業ツリーのテストと重なった負荷）

- [x] T08: trace の Skill を両ホストで自動で起動できるようにし、自動のときの手順と `decides`・`agent` の採用の規則を書く
  - 種別: 変更
  - 計画: S7
  - 依存: T06（`decides` と `agent` の採用が record_check を通る）
  - 変更: `plugin/skills/trace/SKILL.md`, `plugin/skills/trace/agents/openai.yaml`, `scripts/check-ai-config.mjs`
  - 完了条件: `node scripts/check-ai-config.mjs` → 終了コード 0。`bun run verify:ai` → pass。両ホストの起動の設定がそろい、description に「明示の依頼のときだけ」が残っていない
  - コミット: `feat(trace): let the agent run trace on its own and adopt its own decisions under fixed rules (T08)`
  - 結果: trace の Skill から `disable-model-invocation` を外し、Codex の `allow_implicit_invocation` を true にした。description は「依頼されたとき、またはセッション開始の通知が未処理を知らせたとき（依頼を片づけた後）」に変えた。本文に自動のときの手順（`auto: true` の pending と context、自分のセッションは取らない、持ち主に聞かない）と、`decides` と AI の採用の規則（一人称の自分の選択だけ、伝聞・提案・質問・引用・公開の約束・セキュリティ・リリース・forget・規約を緩める判断には使わない、迷ったら採用しない）を書いた。check-ai-config に「description の『Use only when the user explicitly asks』は disable-model-invocation: true のときだけ」の検査を足し、description を元の文言に戻すと落ちることを確かめた。`node scripts/check-ai-config.mjs` → 終了コード 0。`bun run verify:ai` → pass。`bun run verify` → 終了コード 0（受け入れ 105 pass）

- [x] T09: 自動のときの未処理と再開（assistant source を数える、古い順に SQL で選ぶ、前の文脈を決まった数だけ添える、上限で読んだ範囲を保存する）
  - 種別: 変更
  - 計画: S8
  - 依存: なし
  - 変更: `server/src/trace.ts`, `server/src/extract.ts`, `server/src/status.ts`, `server/src/mcp-record.ts`, `server/test/auto-pending.test.ts`
  - 完了条件: `cd server && node --test --test-name-pattern="auto pending" test/auto-pending.test.ts` → pass。後から届いた assistant source が次の回で未処理になり、上限で止めた run の後の run が続きから始まり、文脈と対象が分けて出る。明示の trace の挙動は変わらない
  - コミット: `feat(trace): resume automatic traces from unprocessed messages, oldest sessions first (T09)`
  - 結果: `pendingSessions`・`pendingCount`・`pendingText` と `contextText` に既定 false の auto を足し、record サーバーの `trace_pending` と `record_context` に省略できる `auto` を足した（`trace_pending` は auto のとき呼び出し元のセッションを外す）。auto の record_context は最初の未処理の発言から始め、前の 6 件を 1 件 2,000 文字までの文脈として見出しで分け、2 ページで止めて残りの件数を出す。保存で見た扱いになるのは示した対象と引用した発言だけ。`cd server && node --test --test-name-pattern="auto pending" test/auto-pending.test.ts` → 4 pass / 0 fail。`cd server && node --test test/extract.test.ts test/status.test.ts test/record.test.ts test/deliver.test.ts test/auto-pending.test.ts` → 118 pass / 0 fail（明示の trace のページ送りのテストは変えずに通る）。`cd server && bun run test` → 746 pass / 0 fail。`bun run verify` → 終了コード 0（SQL 到達 204/204、実 DB 10/10、受け入れ 105 pass）

- [x] T26: T22・T09 のレビュー指摘を直す（同じ保存の取り下げの冗長の判定、見直し条件の引用は初めての active 化だけ、glean で新しい採用付きの記録の枠の取り合いを拒む、自動 pending は呼び出し元が分からなければ何もしない、置き換え済みの記録が立てない理由を残す）
  - 種別: 修正
  - 計画: S15, S8
  - 依存: T22（直す対象の reconcile）, T09（直す対象の自動 pending）
  - 変更: `db/schema.sql`, `db/migrations/0010.sql`, `server/src/judge.ts`, `server/src/reconcile.ts`, `server/src/record.ts`, `server/src/glean.ts`, `server/src/extract.ts`, `server/src/mcp-record.ts`, `server/test/judge.test.ts`, `server/test/record.test.ts`, `server/test/extract.test.ts`, `server/test/auto-pending.test.ts`
  - red: `cd server && node --test --test-name-pattern="withdrawing both a record|racing for one place" test/extract.test.ts && node --test --test-name-pattern="reconsider quote was forgotten" test/record.test.ts && node --test --test-name-pattern="caller cannot be told" test/auto-pending.test.ts` → 直す前のコードで、両方の取り下げのうち元の記録が active のまま、取り合いが拒まれず、最後の再判定が「records did not settle」で失敗し、呼び出し元が分からないのに自動 pending が一覧を返して落ちる
  - 完了条件: 同じコマンド → pass。`bun run verify` → 終了コード 0
  - コミット: `fix(record): settle same-save withdrawals and races; skip auto tracing for an unknown caller (T26)`
  - 結果: red を実測（4 件とも上の理由で fail。自動 pending はコミット済みの extract.ts に戻して確認）。直した後 4 件 pass、`node --test test/judge.test.ts` → 17 pass。`bun run verify` → 終了コード 0（SQL 到達 199/199、実 DB 10/10、受け入れ 105 pass）。見直し条件の引用の規則は schema の trigger も「一度も active になっていない記録の初めての active 化」にそろえた

- [x] T29: T07 のレビュー指摘を直す（AI の固定文は残った記録に AI の判断があるときだけ、読み取りの予算から引かない、search と read にも付ける、未採用を search に出す）
  - 種別: 修正
  - 計画: S6
  - 依存: T07（直す対象の表示）
  - 変更: `server/src/authority.ts`, `server/src/deliver.ts`, `server/src/search.ts`, `server/src/mcp.ts`, `server/src/read.ts`, `server/src/extract.ts`, `server/test/deliver.test.ts`
  - red: `cd server && node --test --test-name-pattern="AI words come only|AI words spend none" test/deliver.test.ts` → 直す前の配信は、枠から AI の判断が外れても固定文を残し、読み取りの予算から固定文の分まで引いて 7・8 件目を出さない
  - 完了条件: `cd server && node --test --test-name-pattern="decided by an AI" test/deliver.test.ts` → pass
  - コミット: `fix(deliver): show the AI words only beside a kept AI decision, off the read budget (T29)`
  - 結果: red を 2 件とも実測した。`fitMarked` で、AI の文の枠をとって並べたあと、残った行に AI の判断が無ければ文を外す（短くなるだけなので枠を超えない）。読む前の予算は、過去の配信の記録の、その配信の時刻の権限で AI の判断を含んでいたかを判定して固定文の分を引かない（ログの文字数の意味は eval が使うので変えない）。権限の言葉と固定文は authority.ts に 1 つにまとめ、固定文に「印の無い配信の判断は持ち主のもの」を足した。search の結果（`hitsText` を search.ts に移した）と read にも、AI の判断があるときだけ固定文を付け、search の未採用の判断に「adopted by no one」を出す。`node --test test/deliver.test.ts test/deliver-codex.test.ts test/search.test.ts test/extract.test.ts` → 99 pass。`bun run verify` → 終了コード 0（SQL 到達 208/208、受け入れ 113 pass）

- [x] T28: T05・T06 のレビュー指摘を直す（turn の無い返事は AI の採用に使えない。置き場所の違う `decides` は check でも拒む）
  - 種別: 修正
  - 計画: S3, S7
  - 依存: T06（直す対象の AI の採用）
  - 変更: `db/schema.sql`, `db/migrations/0010.sql`, `server/src/record.ts`, `server/src/glean.ts`, `server/test/record.test.ts`
  - red: `cd server && node --test --test-name-pattern="reply with no turn|decides evidence on a question|glean takes no decides" test/record.test.ts` → 直す前は、同じセッションに record ツールのターンがあっても turn の無い返事が AI の採用で active になり、質問への `decides` を check が ok と返し（save は落ちる）、glean が `decides` を受ける
  - 完了条件: `cd server && node --test --test-name-pattern="agent adoption" test/record.test.ts` → pass
  - コミット: `fix(record): keep turnless replies from adopting and refuse misplaced decides at check (T28)`
  - 結果: red を 3 件とも実測した（active になる、check が ok: true、glean の検査が role を拒まない）。`agent_ineligible_source` に turn の無い返事を入れ、`agentRefusal` でも理由を出す。check は `decides` を AI の返事（質問でない）の本体の evidence にだけ受け、ほかはエラーにする。glean の evidence の役から `decides` を外した。`node --test --test-name-pattern="agent adoption" test/record.test.ts` → 7 pass。`bun run verify` → 終了コード 0（SQL 到達 205/205、受け入れ 113 pass）

- [x] T10: 新しい持ち主のセッションの開始時に、自動の trace の通知をセッションごとに 1 回出す
  - 種別: 変更
  - 計画: S8
  - 依存: T01（対話と headless・SDK を見分ける）, T08（Skill が自動で起動できる）, T09（自動の未処理の数え方が要る）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`, `scripts/check-hooks-live.mjs`
  - 完了条件: `cd server && node --test --test-name-pattern="auto trace notice" test/deliver.test.ts test/deliver-codex.test.ts` → pass。対話の持ち主のセッションで 1 回だけ出て、resume・headless・SDK・判別できない形では出ない。`bun run hooks:live` → pass
  - コミット: `feat(deliver): ask the agent to trace waiting sessions at the start of each new owner session (T10)`
  - 結果: 対話の Claude Code（hook の `CLAUDE_CODE_ENTRYPOINT=cli`）の新しいセッション（resume でない SessionStart、サブエージェントでない、持ち主のセッション）でだけ、自動の数え方で自分以外の未処理を数え、`AUTO_TRACE` の固定文（依頼を片づけた後、古い順に最大 2 セッションを Skill の「On your own」どおりに trace する。持ち主に聞かない）をセッションごとに 1 回出す。それ以外（Codex、resume、判別できない形）は今の 1 日 1 回の手動の案内のまま。`cd server && node --test --test-name-pattern="auto trace notice" test/deliver.test.ts` → pass（1 回だけ、自分のセッションを数えない、resume・sdk-cli・sdk-ts・不明・サブエージェント・cli を引き継いだ Codex では出ない）。`bun run hooks:live` → pass。通知を外した bundle では「a new interactive session was not asked to trace」で落ちることを確かめた。`bun run verify` → 終了コード 0（受け入れ 113 pass）

## P4: 評価への備えと出荷

段階 2 が AI の判断を取り出せるようにし、受け入れケースをそろえて出す。

- [x] T11: 一度でも AI の判断として active になった記録を、その時点の採用元と content hash、今の状態つきで返す関数を足す
  - 種別: 追加
  - 計画: S9
  - 依存: T05（その時点の権限の判定が要る）
  - 変更: `server/src/authority.ts`, `server/test/authority.test.ts`
  - 完了条件: `cd server && node --test --test-name-pattern="agent history" test/authority.test.ts` → pass。持ち主が後から採用した記録と AI の採用が撤回された記録が一覧に残り、最初に active になった時刻と当時の content hash が返る
  - コミット: `feat(record): list records that were ever active as AI decisions for evaluation (T11)`
  - 結果: `agentHistory` は、active になった状態の行ごとにその時点の権限を `authorityOf` で出し、AI の判断として active になった最初の時刻・その時点で効いていた AI の採用（source と範囲）・content hash（記録の本文は書き換えないので今の値が当時の値）・今の状態と権限を返す。今の履歴だけで作れたので、新しく保存する項目は無い。`cd server && node --test --test-name-pattern="agent history" test/authority.test.ts` → pass（持ち主が後から採用した記録と、AI の採用が撤回された記録が残る。active になる前から持ち主の判断だった記録と、active にならなかった記録は入らない）。`bun run verify` → 終了コード 0（SQL 到達 207/207、受け入れ 113 pass）

- [x] T12: 受け入れケースを足す（伝聞の平文、取得したページの注入文、無関係な編集、質問、trace の報告、持ち主の判断の保護、自動の trace の通知）
  - 種別: 追加
  - 計画: S10
  - 依存: T06（AI の採用の挙動が要る）, T10（通知の挙動が要る）
  - 変更: `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`, `server/evals/acceptance/load.ts`, `server/test/acceptance-cases.test.ts`
  - 完了条件: `bun run acceptance` → pass。足したケースのうち持ち主の判断の保護は main のコードで落ちる
  - コミット: `test(acceptance): cover AI adoption exclusions, owner decision protection, auto trace notice (T12)`
  - 結果: 受け入れに層 agent の 14 件（ja 7・en 7）を足した。AI の判断が active になり「decided by an AI」として配信と read に出る / AI が返事で伝えた他人の判断を explains で引いた AI の採用は候補に残る / 取得したページ（第三者の PR コメント）を decides で引くと check と保存が拒む / 同じターンに別のファイルを編集した do は候補に残る / AskUserQuestion の質問への decides を check と保存が拒む / record ツールを呼んだターンの返事は Claude Code（hook の観測）でも Codex（record_call）でも候補に残り、次のターンの判断は active になる / headless（sdk-cli）・SDK（sdk-ts）・判別できない呼び出し元の run は候補に残る / 採用されていない記録の conflicts でも持ち主の判断が配信に残る / AI の判断の conflicts と supersedes でも持ち主の制約が active のまま配信に残り、置き換える側は「replacing another record needs the owner's or a maintainer's adoption」で候補に残る / 新しい対話の開始で自動の trace の通知が 1 回だけ出る / resume・headless・判別できない開始では出ない。driver に、trace の呼び出し元（Claude Code の hook の観測と record サーバーの呼び出しの記録を `callerOf` で作る）、ターンの record ツールと AskUserQuestion、`session:<id>#<n>.question`、inject の entrypoint と session、harvest の refused を足した。main（c09283df）に同じ cases.json・driver・load を載せて流し、持ち主の判断の保護（agent-11）が `delivery lacks "保存先は SQLite の 1 ファイルにする"` で落ちることを確かめた（agent-13 も通知が無く落ちる。AI の採用のケースは main に agent の経路と呼び出しの記録が無いので流せない）。入力を 1 つずつ変えて、record ツールの呼び出しを外す・同じファイルを編集する・呼び出し元を cli にすると該当のケースが落ちることも確かめた。伝聞を decides で引くと active になる（意味に頼る部分で Sphica は見分けない。plan のリスクのとおり）。`cd server && node --test test/acceptance-cases.test.ts` → 4 pass / 0 fail。`bun run acceptance` → 127 pass / 0 fail。`bun run verify` → 終了コード 0（SQL 到達 207/207、実 DB 10/10、受け入れ 127 pass）

- [x] T30: T28・T10・T11・T29 のレビュー指摘を直す（持ち主の採用の撤回で AI の判断になった記録を一覧に入れる、自動の trace の通知は startup だけ、glean の新しい記録も decides を受けない）
  - 種別: 修正
  - 計画: S8, S9, S7
  - 依存: T29（直す対象の最後の表示の修正）
  - 変更: `server/src/authority.ts`, `server/src/deliver.ts`, `server/src/record.ts`, `server/test/authority.test.ts`, `server/test/deliver.test.ts`, `server/test/record.test.ts`
  - red: `cd server && node --test --test-name-pattern="owner's adoption is taken back|auto trace notice|glean takes no decides" test/authority.test.ts test/deliver.test.ts test/record.test.ts` → 直す前は、active のまま持ち主の採用を撤回した記録が一覧に無く、resume したセッションの compact で通知が出て、glean の新しい記録が decides を受ける
  - 完了条件: `cd server && node --test --test-name-pattern="agent history|auto trace notice|agent adoption" test/authority.test.ts test/deliver.test.ts test/record.test.ts` → pass
  - コミット: `fix(record): fix agent history, the session notice, and glean decides from review (T30)`
  - 結果: red を 3 件とも実測した。`agentHistory` は、active になった時刻と、持ち主か maintainer の採用が撤回された時刻を見て、その時点で active かつ AI の判断なら入れる。通知は SessionStart の source が `startup` のときだけ（resume のあとの compact や source の無い開始では出ない）。check は `decides` を trace の run でだけ受ける。`node --test --test-name-pattern="agent history|auto trace notice|agent adoption" ...` → 10 pass。`bun run verify` → 終了コード 0（SQL 到達 209/209、受け入れ 127 pass）

- [x] T13: 配布する Skill を権限に合わせる（review の過去の判断の観点、export、rules）
  - 種別: 変更
  - 計画: S11
  - 依存: T07（権限が表示に出る）
  - 変更: `plugin/skills/review/reviewers/precedent.md`, `plugin/skills/export/SKILL.md`, `plugin/skills/rules/SKILL.md`, `server/src/review.ts`, `server/src/export.ts`, `server/src/mcp.ts`, `server/test/review.test.ts`, `server/test/export.test.ts`, `server/test/deliver.test.ts`, `server/test/temp-db.ts`
  - 完了条件: `bun run verify:ai` → pass。`cd server && node --test test/review.test.ts` → pass。review の観点が持ち主の判断から外れる差分を今どおり指摘し、AI の判断から外れる差分は理由が書かれていないときだけ指摘する。export と rules の一覧と下書きに権限が出て、rules は AI の判断を選ぶときに規範に格上げされることを 1 行で知らせる
  - コミット: `feat(skills): weigh owner and AI decisions differently in review, export, and rules (T13)`
  - 結果: review_select の出力の組み立てを review.ts の `selectedText` に移し、AI の判断に「decided by an AI」を付け、そのときだけ「AI の判断から外れる差分は理由が無いときだけ違反」の固定文（`AI_DEPARTURE`）を足す。precedent.md は、持ち主の判断から外れる差分は今どおり指摘し、AI の判断から外れる差分は理由（追加したコメント・コミットメッセージ・渡された PR 本文）が無いときだけ指摘し、あれば `undetermined` で理由と場所を書いて注記にする。export の文書の各判断に `authority:` の行を足し、Skill は選ぶときに誰の判断かを見せる。rules は選ぶときに誰の判断かを見せ、AI の判断を選んだら規約の行にすると規範になることを 1 行で知らせる（下書きするのは持ち主が選んだ記録だけのまま）。AI の判断の行を作るテストの helper を temp-db.ts の `aiDecided` に移した。`bun run verify:ai` → pass。`cd server && node --test test/review.test.ts` → 9 pass。`node --test test/export.test.ts` → 15 pass。`bun run verify` → 終了コード 0（SQL 到達 208/208、受け入れ 113 pass）

- [x] T14: README.md・README.ja.md・CLAUDE.md・AGENTS.md・knowledge-schema の Skill を今の挙動に合わせ、ほかの開発の文書を確かめる
  - 種別: 変更
  - 計画: S12
  - 依存: T10（自動の trace の挙動が決まる）, T13（配布する Skill の挙動が決まる）
  - 変更: `README.md`, `README.ja.md`, `CLAUDE.md`, `AGENTS.md`, `.agents/skills/knowledge-schema/SKILL.md`, `.agents/skills/plugin-release/SKILL.md`, `plugin/skills/glean/SKILL.md`, `plugin/skills/trace/SKILL.md`
  - 完了条件: `node scripts/check-pairs.mjs && bun run english && bun run verify:ai` → 終了コード 0。`rg -n "end of a session|セッションの終わりに" README.md README.ja.md` → 手で trace を流すことだけを前提にした案内が残っていない。plan の方針 12 の項目が両言語の README にそろって入っている。`rg -n -i "only the owner|owner's words|explicitly asks|持ち主の言葉" .claude .agents plugin/skills README.md README.ja.md CLAUDE.md AGENTS.md` → 残った行が、持ち主の判断についての記述として今の挙動と合っている
  - コミット: `docs: describe AI decisions and automatic tracing in the READMEs and agent instructions (T14)`
  - 結果: 両言語の README に方針 12 の項目を入れた（採用の 2 通りと AI の判断の扱い、Claude Code での頼まなくても走る trace、配信の印と離れてよい旨、使い始めの案内、ほかの人の文章は採用にならない、まだできないことの 4 件）。実装に合わせて、自動の trace と AI の採用は Claude Code の対話のセッションだけで Codex は知らせるだけと書き、衝突は持ち主の判断を止めないことに合わせた。CLAUDE.md と AGENTS.md の record-writes に「エージェントも session start の頼みで trace を流す」を足し、新しい invariant `agent-adoption`（AI の採用は対話の呼び出しと確かめた trace から decides と組で、持ち主の判断を置き換える・止める link は持ち主が採用した記録からだけ）を足した。knowledge-schema に、事実から状態を判定する judge と reconcile、`unit_replacement` と印の表、`agent` の採用と `authorityOf`、record ツールの呼び出しの記録、書き手と forget の権限を書いた。plugin-release に description の検査を足した。rg の確認で、glean と trace の Skill に残っていた「衝突は両方を止める」を今の挙動に直した。eval-loop と `.claude/rules` に変わる記述は無かった。`node scripts/check-pairs.mjs && bun run english && bun run verify:ai` → 終了コード 0。`rg -n "end of a session|セッションの終わりに" README.md README.ja.md` → 0 件。`bun run verify` → 終了コード 0（受け入れ 113 pass）

- [x] T31: T13・T14 のレビュー指摘を直す（README の除外の説明を実装どおりに、precedent が見られる理由だけを認める、rules の下書きに AI の判断の印、自動の trace は直近 14 日）
  - 種別: 修正
  - 計画: S11, S12
  - 依存: T14（直す対象の文書）
  - 変更: `README.md`, `README.ja.md`, `plugin/skills/review/reviewers/precedent.md`, `plugin/skills/rules/SKILL.md`
  - red: `rg -n "wherever Sphica cannot tell which session called|見分けられないときは、候補|the commit message, or the PR body you were given" README.md README.ja.md plugin/skills/review/reviewers/precedent.md` → 直す前は 3 行が見つかる（実装より強い除外の説明と、レビュアーに渡らないコミットメッセージを理由の場所に挙げる行）
  - 完了条件: `node scripts/check-pairs.mjs && bun run english && bun run verify:ai` → 終了コード 0
  - コミット: `docs: match the READMEs and review and rules Skills to what the code does (T31)`
  - 結果: README（英日）の「呼び出し元が分からないときは候補に残る」を、実装どおり「headless・SDK・Codex では候補」と「記録ツールのターンを見分けられなかったとき（hook の時間切れ・無効）は、そのプロジェクトでそれ以後に Claude Code のエージェントが書いた応答がずっと候補」に分けた。永久に止まる点は Codex と議論し、env・時間の窓・後の hook の成功ではどのターンの呼び出しかを証明できないので、plan の方針 2 どおり止めたままにした（同じ tool use id で観測を送り直す経路は plan の変更になるので入れていない）。precedent.md は、レビュアーに見える理由（差分で足したコメント、起動側が渡したときのコミットメッセージや PR 本文）だけを認める。rules の下書きの AI の判断の行に `(decided by an AI)` を付ける。README に自動の trace は直近 14 日のセッションだけと足した。`node scripts/check-pairs.mjs && bun run english && bun run verify:ai` → 終了コード 0。`bun run verify` → 終了コード 0（受け入れ 127 pass）

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
- 2026-10-04 / T17 / T03 の Codex のレビュー（F1: T02 の F1 と同じで T16 で直し済み。F2 P2: MCP の SDK が入力の形で拒んだ呼び出しは `record_call` に残らない）。F2 を受けて修正タスク T17 を足した。Codex の拒まれた呼び出しは記録できないので plan のリスクに足した
- 2026-10-04 / T04 / 保存時に拒む形が glean の後採用の流れを壊した（既存テスト 3 件の退行）。Codex と比べ、持ち主が C′ を選んだ。T04 の題名・変更欄・red・完了条件・コミットを C′ に書き直した（前: record.ts で同じ保存の持ち主の採用を求める → 後: 配信と後継の枠で効き目を止める）
- 2026-10-04 / T18 / T04 の Codex のレビュー（F1 P1: 取り下げからの復帰が待っている候補を後継と数えた。F2 P2: 同じ保存で待っている候補が枠を予約した。F3 P2: overview が待っている候補を後継と案内した）を 3 件とも受け、修正タスク T18 を足した
- 2026-10-04 / T19 / T18 の Codex のレビュー（F1 P1: 採用済みの候補を active 化の確認が見落とし後継が 2 つ並ぶ。F2 P1: 採用の撤回で元の判断が戻らない。F3 P2: 同じ保存で順番に依存。F4 P2: liveSuccessors が取り下げた後継を返す。F5 P2: read が待っている提案も Superseded by と出す）を 5 件とも受けた。場当たりに直さず、枠を「active になった後継だけ」に単純にした（plan の方針 5 を更新）
- 2026-10-04 / T20 / T19 の Codex のレビュー（F1 P1: 連鎖の末尾の採用撤回で先頭が戻らない。F2 P1: 前の判断に採用が付くと枠が空いても戻らない。F3 P2: 前の判断の採用撤回で待っている提案が 2 つとも枠を持つ）。3 回目のレビューでも P1 が出たので止めて持ち主に相談し、規則を全記録で同じにする選択肢 1 を受けて修正タスク T20 を足した
- 2026-10-04 / T21〜T25 / T20 のレビュー（P1 1 件・P2 1 件、4 回目）を受け、持ち主の「妥協せずに最高のもの」で、Codex と 4 往復して後継の枠の作りを「つもりと効いている期間を分け、状態を事実から計算する」に変えた（plan の方針 5）。T18〜T20 の推し量る仕組みは T22 で外す。T05・T06・T07 の依存に T22・T24 を足した。持ち主の Go を受けた
- 2026-10-04 / T21 / 変更欄に `server/src/record.ts` を足した（`replaceable` を judge.ts へ寄せたため）。snapshot を DB から取る adapter は `unit_replacement` の表が要るので T22 で作る（T21 は純粋な本体だけ）
- 2026-10-04 / T22 / 変更欄（`server/src/extract.ts`・`search.ts`・`read.ts`・`db.test.ts`・`migrate.test.ts` は変えずに済み外した。judge の条件を直したので `judge.ts`・`judge.test.ts` を足した）。出典が無くなった記録は後継で置き換えて直せる（schema の CHECK どおり、置き換えられないのは隔離だけ）と分かり、judge の条件を「相手が sound」から「相手が隔離でない」に直した。根拠のそろった candidate を forget が判断し直すと active になる（状態を事実から決めるため。forget のテストの期待を直した）。保存の最後の「採用付きの後継が枠を待ったら拒む」は check が同じ transaction で先に拒むので届かず、置かなかった（glean の adopt では残す）
- 2026-10-04 / T09 / 変更欄（前: `server/test/record.test.ts` → 後: 新しい `server/test/auto-pending.test.ts` と、省略できる `auto` を足す `server/src/mcp-record.ts`）と完了条件のテストファイルを直した。record.test.ts は begin が送る記録の待ち行列を一時の HOME に向けていないので、begin を呼ぶテストを別のファイルに分けた
- 2026-10-04 / T23 / 変更欄に `db/schema.sql`（印の表 `unit_replacement_gap`）、`server/src/db-types.ts`、`server/src/reconcile.ts`（同期版の adapter）を足した。reconcile を純粋な計画づくりと非同期・同期の読み書きに分け、移行の SQL は reconcile.ts に置いて admin.ts から実行の関数だけを渡す（生の SQL の置き場所と lifecycle の書き手の両方の検査を満たすため）。状態の行を 1 行も持たない記録（どのリリースも作らない）は移行で判定しない。移行は自分の run を足すので、件数・id を前提にした既存の移行テストを合わせた。revision 10 の移行は、このリリースの judge で判定する（規則を変えるときは新しい revision にする）
- 2026-10-04 / T26 / T21・T22 の Codex のレビュー（F1 P1: 同じ保存で元の記録と後継の両方の取り下げで、元の取り下げが消える。F2 P2: 見直し条件の引用を forget した後継の置き換えが最後の再判定で失敗。F3 P2: glean で新しい採用付きの記録と adopt が枠を取り合っても拒まない）と T09 のレビュー（F1 P2: 呼び出し元が分からないと自動 pending が今のセッションを含める）を受け、T24 のサブエージェントが気づいた点（置き換え済みの記録が採用を失ったときの終わりの理由が一般的な文になる）も合わせて、修正タスク T26 を足した
- 2026-10-04 / T24 / 変更欄（前: `server/src/overview.ts`・`review.ts`・`extract.ts` を含む → 後: 3 つを外した）。overview は開いた行だけをたどり済み、review は active だけを選び、extract は後継を語らず保存の出力が reconcile の待つ理由をそのまま出すので、変える所が無かった。「履歴が記録されていない」印は schema にまだ保存先が無く、read は推し量らずに出さない。印を作る T23 で read の表示も足す必要がある
- 2026-10-04 / T24 / サブエージェントが別の作業ツリーで実装した T24（f826fda1）を取り込み、T26 まで入った状態で `node --test test/search.test.ts test/overview.test.ts test/export.test.ts test/review.test.ts test/record.test.ts` → 97 pass を私が流して確かめた。T23 で作った `unit_replacement_gap` の印を read に出す 1 行を足した（T24 の時点では表が無かった）。`bun run verify` → 終了コード 0（SQL 到達 201/201）
- 2026-10-04 / T05 / 保存・glean の操作の前後の確認は、T22 の reconcile（最後にもう一度判定して差分なし）がすべての操作で担うので、T05 では判定関数と共有する SQL に絞った。変更欄と完了条件を直し（前: record.ts・extract.ts・glean.ts の前後の確認 → 後: authority.ts・deliver.ts・read.ts と authority.test.ts）、`authorityOf` が未使用にならないよう、T07 の表示のうち read の見出しの 1 行を前倒しした
- 2026-10-04 / T06 / 変更欄（前: record.ts と record.test.ts → 後: run の判定の extract.ts・record_check の呼び出しの mcp-record.ts・規約のファイルの判定を共有する rule-files.ts と export.ts・plan を足す）。止めるパスの一覧を、どのリポジトリにもある規約のファイルと CI の定義に直した（plan の方針 7 と変更履歴）。AI の採用が外れた理由が保存の出力に出ないと分かり、save でも check の注意を出すようにした
- 2026-10-04 / T27 / T23・T26・T24 の Codex のレビュー（F1 P2: 取り下げと復帰が同じ時刻というだけで、一緒に取り下げた候補まで過去に効いていた後継として戻す）を受け、修正タスク T27 を足した。指摘はこの 1 件だけだった
- 2026-10-04 / T07 / 変更欄（前: deliver.ts・read.ts・search.ts・extract.ts・review.ts と deliver の 2 つのテスト → 後: review.ts は配信のレビューの経路が deliver.ts にあるので変えず、search の表示の mcp.ts、生きている記録の trace.ts、search.test.ts を足し、deliver-codex.test.ts は変えずに済んだ）
- 2026-10-04 / T25 / 変更欄に `server/test/acceptance-cases.test.ts` を足した（層ごとの件数を固定しているので、新しい層 reconcile の 8 件を数えに足す）。reconcile の最後の再判定（`records did not settle`）は、judge が読む事実を保存の書き込みが変えないので正しい書き込みからは届かず、ingest の authorizer が事実を書き換えるトリガーを差し込ませないので、rollback は「保存の途中で schema が書き込みを拒むと、それまでの書き込みがすべて戻る」で確かめた。保存をまたぐ順番のテストは、置き換え済みの記録への提案を check が拒む（順番で受け付けが変わるのは check の規則で、reconcile ではない）ので、どの順番でも受け付けられる保存だけで組んだ
- 2026-10-04 / T28 / T05・T06 の Codex のセキュリティレビュー（F1 P2: turn の無い返事が record ツールのターンの除外をすり抜ける。F2 P2: 質問への decides を check が通し save が保存全体を戻す）を受け、修正タスク T28 を足した。同じずれが glean の evidence にもあったので同じタスクで直した
- 2026-10-04 / T10 / 変更欄（前: deliver-codex.test.ts を含む → 後: Codex で出ないことは deliver.test.ts の同じテストで、Claude Code の環境を引き継いだ Codex として確かめたので外した）
- 2026-10-04 / T11 / 変更欄とテストの置き場所（前: record.test.ts → 後: AI の採用の行を作る helper がある authority.test.ts）
- 2026-10-04 / T29 / T27・T07・T08・T25 の Codex のレビュー（F1〜F4 すべて P2）を受け、修正タスク T29 を足した。F1 は search と read に固定文を付け、record_context には付けない（trace が key を選ぶための一覧で、離れてよいという案内は当てはまらない）。F3 は search に「adopted by no one」を出し、配信は行ごとの印を足さずに固定文で印の無い判断が持ち主のものと伝える（配信に載る判断は必ず採用済み）
- 2026-10-04 / T13 / 変更欄（前: precedent.md・export と rules の Skill・review.ts・export.ts・review.test.ts → 後: review_select の文を review.ts へ移すための mcp.ts、export のテスト、AI の判断の行を作る helper を共有するための temp-db.ts と deliver.test.ts を足した）
- 2026-10-04 / T14 / 変更欄（前: README の 2 つ・CLAUDE.md・AGENTS.md・knowledge-schema → 後: rg の確認で見つかった古い衝突の説明を直すため glean と trace の Skill、description の検査を書くため plugin-release を足した）。README は方針 12 の文面のうち「新しいセッションの開始時にエージェントが trace する」を、実装どおり Claude Code だけと書いた（Codex の対話の値は未実測で、通知は手動の案内のまま）
- 2026-10-04 / T12 / 変更欄に `server/test/acceptance-cases.test.ts` を足した（層ごとの件数を固定しているので、新しい層 agent の 14 件を数えに足す）。伝聞の平文は意味に頼るので Sphica は見分けられず、受け入れでは機械で守る部分（decides でない引用は AI の採用にならない）だけを確かめた。コミットの件名（前: `…, and the auto trace notice (T12)` → 後: `…, auto trace notice (T12)`）。commit-msg の検査が 100 文字を超える件名（106 文字）を拒んだため
- 2026-10-04 / T30 / T28・T10・T11・T29 の Codex のレビュー（F1〜F3 すべて P2）を受け、修正タスク T30 を足した
- 2026-10-04 / T31 / T13・T14 の Codex のレビュー（F1〜F4 すべて P2）を受け、修正タスク T31 を足した。review-shipping の指摘 2（hook の取りこぼし 1 回で AI の採用がプロジェクトごとずっと止まる）は Codex と議論し、plan どおり止めたままにして README に書いた
