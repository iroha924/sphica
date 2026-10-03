---
kind: plan
status: approved
codex_session: 01a10154-f5f4-70c0-95a4-2d1999178e0f
codex_rounds: 4
approved_at: 2026-10-03
---

# Capture keeps a working-tree starting point per turn so a status edit never lands on another turn, and the record server prefers Codex's workspace

## 要点

- 作業ツリーの起点を、セッションに 1 つのファイルから「ターンごとに 1 つのファイル + 通し番号 seq」に変える。Stop は自分のターンが今のターン（seq が最大で同点なし）だと snapshot の後に確かめたときだけ status の編集を書く。判定できなければ捨てる（取りこぼしはあっても付け違えはしない）
- Claude Code の capture の UserPromptSubmit と Stop を同期の hook にする（1 回 30〜40ms の実測）。正しさは順序に依らない規則で持たせ、同期化は窓を狭めるため
- SessionStart は起点を書かない（compaction で走っている起点が残る。startup の裏の SessionStart が最初のプロンプトの起点を潰さない）。Codex の Interrupt は自分のターンの起点を running:false にする
- record サーバーの workspace を Codex の `_meta` → `CLAUDE_PROJECT_DIR` の順にする（読み取りサーバーと同じ順）
- 0.6.28 で出す。schema、`edit_observation` の形、記録が active になる規則は変えない

## 持ち主の決定

- #210 の残り 2 項目（中断の後の手での編集、ターン途中の compaction）をこの計画でやる（「了解、#210の続きやろう」）
- record サーバーの解決順（u199 で「#211 の次の計画で決める」とした）も同じ計画に入れる（Claude が勧めた B 案。持ち主の「了解」で入れた。Go のときに外せる）

## 目的

- Claude Code でオーナーが中断し、手で直したファイルが、次のターンの `via: "status"` の編集として記録されない（#210 の t1/t2）
- Codex の Interrupt の後も同じ
- ターンの途中で compaction があっても、その前のシェルの変更がそのターンの status の編集として残る
- hook の順序がどう入れ替わっても（遅れた Stop、遅れた保存、消せない・読めない起点、同時に走った hook）、あるターンの status の編集に別のターンの区間の変更が入らない。判定できないときは書かない
- `CLAUDE_PROJECT_DIR` を引き継いだ Codex のセッションで、record サーバーが Codex の `_meta` の示すプロジェクトに書く

## 対象外

- status の観測を implementation の根拠から外すこと（schema の規則の変更。持ち主の DB では観測の anchor を持つ active な implementation 22 件が全部 status の観測で、コミット前の実装の根拠がほぼ無くなる）
- 中断の検知: この capture が受け取るイベントでは確実に判別できない（Claude Code は中断で Stop を送らず、中断を示すイベントも欄も無い）。transcript は書き込みが遅れ得るので使わない
- PostToolUse の capture の同期化（起点に触らない）
- #211 のほかの項目（SDK v2、userConfig、portable plugin、alwaysLoad）

## 前提

- 今の起点（`server/src/capture.ts` 312-345、392-413）: (host, session) ごとに 1 ファイルの `Snapshot & { running }`。UserPromptSubmit は running でないときだけ取り直し、Stop は `changed(before, now)` を via:"status" で書いて running:false、SessionStart は source によらず running:false で取り直す（353-365）、Codex の Interrupt は flush だけ（368）
- 前回（PR #250 の T02・T03・T07、T08 で戻した。`git show 5aeab76e:.claude/plans/2026/10/03-issue-210-owner-turns.tasks.md`）: 1 ファイルの書き換えでは、遅れた書き込みの上書き・消せない起点・遅れた Stop の上書きで付け違えが出た（Sphica の記録 u185、u186）
- `plugin/hooks/hooks.json`: capture は SessionStart が同期（timeout 10）、UserPromptSubmit・PostToolUse・Stop が `async: true`。`scripts/check-ai-config.mjs` 309-327 がこの形を固定している。`plugin/hooks/codex.json` は全部同期（u190 で同期のままと決めた）
- Claude Code の hooks（https://code.claude.com/docs/en/hooks 、2026-10-03 閲覧）: 同期の UserPromptSubmit は "blocks model processing until it completes"。Stop は "Does not run if the stoppage occurred due to a user interrupt"。SessionStart は startup・resume・clear で裏で走る（"You can type right away"）。UserPromptSubmit の既定の timeout は 30 秒、timeout した同期の hook は打ち切られ、プロンプトは処理される。同期の Stop の完了と次の UserPromptSubmit の開始の順序の保証は見つからない（未検証）
- Codex は Interrupt の後に同じターンの Stop を送らず、1 つのターンの途中のプロンプトは同じ turn id を持つ（前回の計画で Codex が openai/codex のソースで確認）。Interrupt の入力に中断した turn_id が入る（https://learn.chatgpt.com/docs/hooks#interrupt）
- 実測（この Mac、262 ファイル）: `git status --porcelain=v2 -z --untracked-files=all` 0.01s、`node plugin/dist/capture.js` の Stop 1 回 0.03〜0.04s。大きなリポジトリでは未測定
- 記録が active になる規則（`db/schema.sql` 565-580）と `server/src/record.ts` 578-588: implementation の観測の anchor は、同じセッションの最新の観測を via やターンによらず選ぶ。害は「オーナーの手での編集がセッションの観測に入ること」
- record サーバー `projectOf`（`server/src/mcp-record.ts` 47-48）: `process.env.CLAUDE_PROJECT_DIR || hostWorkspace(meta)`。読み取りサーバー（`server/src/mcp.ts`、#253）は cwd → `_meta` → `CLAUDE_PROJECT_DIR` → `process.cwd()`。`writePlace`（`server/src/project.ts` 151）は cwd の project key が workspace と違えば拒否する

## 方針

1. 起点のファイル: `<sphicaHome>/worktree/<digest(host, session)>/<digest(turn)>.json`。中身は `{ head, entries: Record<string,string> | null, running: boolean, turn: string, seq: number | null }`。書き込みは今どおり tmp（`.` で始まる名前）+ rename。旧形式（`worktree/<digest>.json` の 1 ファイル）は読まず、prune で消す
2. 今のターン: セッションのディレクトリの `.` で始まらない全ファイルを読み、seq が最大のファイルのターン。次のときは「判定できない」: 列挙・読み取り・解析の失敗が 1 つでもある、seq が null のファイルがある、最大の seq が同点
3. UserPromptSubmit(turn)（注入かどうかによらない）: 自分のファイルがあって running ならそのまま（同じ id の途中のメッセージ）。それ以外（無い、running でない＝id の使い回し）は、ディレクトリを読んで `seq = 最大 + 1`（無ければ 1、読めないファイルがあれば null）を決め、snapshot を取り、自分のファイルを `{ snapshot, running: true, turn, seq }` で書く。snapshot に失敗しても `entries: null` で書く（今のターンの目印は必ず残す）。ほかのターンのファイルには触らない
4. Stop(turn): 自分のファイルを読み、running で entries があれば snapshot を取る。snapshot の後にディレクトリを読み直し、今のターンが自分と判定できたときだけ `changed` を via:"status" で書き、自分のファイルを `{ now, running: false, turn, seq }`（seq は保つ）で書き直す。それ以外は起点に何も書かない。発言の保存と flush は今どおり
5. Codex の Interrupt(turn): 自分のファイルがあれば、git を走らせず `running: false`（turn と seq と entries は保つ）で書き直す。無ければ何もしない
6. SessionStart: 起点を書かない（どの source でも）。`CLAUDE_ENV_FILE` と prune は今どおり
7. prune（SessionStart から）: セッションのディレクトリの中の全ファイル（tmp を含む）が HOLD_DAYS より古いときだけ、ディレクトリごと消す。一部だけは消さない（空のディレクトリも消さない）。旧形式の 1 ファイルは HOLD_DAYS より古いときだけ消す（更新の途中で旧い hook のセッションが使っている）。起点の読み書きと prune に失敗しても、発言の保存・flush・セッション開始の通知は止めない。UserPromptSubmit は発言を spool してから起点を取る（同期の hook が timeout で打ち切られても発言は残る）。Stop と Interrupt で終えたターンの起点は番号だけを残し、head と entries を null にする
8. 同期化: `plugin/hooks/hooks.json` の capture の UserPromptSubmit と Stop を `{ timeout: 10 }`（async を外す）。`scripts/check-ai-config.mjs` の期待を同じにする
9. 受け入れる穴（capture.ts の先頭のコメントに書く）:
   - (a) 中断の後、前のターンの id を使い回す通知のターン（起点が running のまま残り、オーナーの手での編集がそのターンに入る）
   - (b) Stop の snapshot までの間のオーナーの編集
   - (c) 走っている間に別の id のプロンプトが来ると、それまでのシェルの変更が status に残らない（取りこぼし。tool の編集は残る）
   - (d) 起点を書けない（ディスクの障害、目印を書く前の timeout、Stop・Interrupt の書き直しの失敗）
   - (f) timeout を過ぎても走り続ける hook、または古いターンの hook が新しいターンの目印の保存を見てから番号を振る順序（ホストの hook の起動順は保証が確かめられない）
   - (g) HOLD_DAYS 止まっていたセッションが再開した瞬間に、そのセッションの古い起点の prune が重なる
10. record サーバー: `projectOf` を `hostWorkspace(meta) || process.env.CLAUDE_PROJECT_DIR`。workspace が無ければ今どおり拒否し、cwd で代えない。選んだ workspace が未登録なら次の候補に進まない。コメントに理由（Claude Code のシェルから起動した Codex が環境変数を引き継ぐ）
11. テスト: 起点の処理を「読む・番号を振る・snapshot・読み直す・書く」の段に分けた関数にし、`server/test/capture.test.ts` で一時ディレクトリの実ファイルに、別のターンの段を間に挟む順を並べる（子プロセスは使わない）。入れる順序: #210 の t1/t2（Claude Code と Codex の Interrupt）、compaction、同じ id の途中のメッセージ、走っている間の注入、遅れた Stop(t1)、保存の手前で止まった UserPromptSubmit(t1) の遅れた保存、消せない起点、同点、seq:null、読めないファイル、tmp を比べない、entries:null・running:false を比べる対象に入れる、Stop と Interrupt が turn と seq を保つ、prune が番号を振った後・保存の前に走る順（C16）、旧形式の 1 ファイル
12. 受け入れケース: `server/evals/acceptance/` に中断の後のロールオーバーと compaction の 2 件を足す（`driver.ts`・`load.ts` の Turn に中断・シェルの編集・compaction の欄、`acceptance-cases.test.ts` の capture の件数）
13. record MCP: `server/test/plugin.test.ts` に、`_meta` と `CLAUDE_PROJECT_DIR` が両方あるとき `_meta` が勝つ、`_meta` が未登録なら環境変数に落ちない、別 project の cwd を拒否する、を実際の record MCP 呼び出しで足す
14. リリース: `bun run release:plan -- --base 85d09b55` を流してから 0.6.28 にそろえ（npm と 3 つの manifest）、PR 本文にリリースノート

## 採った案と棄却した案

- 採用: ターンごとのファイル + 通し番号 + snapshot の後の読み直し。棄却: 1 ファイルに turn を持たせて書き換える（途中の割り込みで遅れた保存が新しい起点を上書きし、消せない起点に遅れた Stop が来ると付け違える。Codex が C2・C3 で反例）
- 採用: 通し番号 seq。棄却: プロセスの開始時刻 startedAt（同値で付け違え（C13）、hook の起動の遅れで大小が逆になる（C14）、時計の戻り）
- 採用: 判定できない（同点・読めない・seq:null）なら捨てる。棄却: 列挙順やファイル名で決める（時間順の根拠にならない）
- 採用: prune はセッションの全ファイルが古いときだけディレクトリごと消す。棄却: 最大 seq を印にして残し、ほかの古いファイルを消す（T02 のタスクレビューで、prune が判定した後に同じ id の起点が作り直されると上書き・削除し、seq:null を消すと遅れた Stop が古いターンを今のターンと見ることが再現された）。棄却: 期限切れなら個別に全部消す（C16）
- 採用: SessionStart は起点を書かない。棄却: compact だけ残し、ほかは取り直す（startup の裏の SessionStart が最初のプロンプトの起点を潰す）
- 採用: UserPromptSubmit と Stop の同期化。棄却: 非同期のまま（遅れた Stop の窓が広く、u185 で見送った理由の待ち時間は実測 30〜40ms）
- 採用: status の観測は今どおり implementation の根拠にする。棄却: 根拠から外す（対象外を参照）

## 手順

- S1: 起点のターンごとのファイル、通し番号、今のターンの判定、UserPromptSubmit・Stop・Interrupt・SessionStart の規則、prune、先頭のコメント、単体テスト（方針 1〜7、9、11）
- S2: hooks.json の同期化と check-ai-config の期待（方針 8）
- S3: 受け入れケース 2 件と driver・load・件数（方針 12）
- S4: record サーバーの解決順と record MCP のテスト（方針 10、13）
- S5: release:plan、0.6.28 へのバージョンの更新、リリースノート（方針 14）

## 完了条件

- A1: `bun run verify` → 終了コード 0（sql:live と受け入れケースを含む）
- A2: `cd server && node --test test/capture.test.ts` → pass。方針 11 の順序のテストが、main の `capture.ts` に戻すと #210 の t1/t2・compaction・遅れた Stop で落ちる
- A3: `node scripts/check-ai-config.mjs` → 終了コード 0、`rg -n '"async": true' plugin/hooks/hooks.json` → PostToolUse の 1 件だけ
- A4: `cd server && node --test --test-name-pattern="_meta" test/plugin.test.ts` → pass。main の `mcp-record.ts` では `_meta` が勝つテストが落ちる
- A5: `bun run release:plan -- --base 85d09b55` → `plugin`。`plugin/package.json` と 3 つの manifest が 0.6.28
- A6: `gh pr checks <PR 番号> --watch` → 全ジョブ pass

## リスク

- 大きなリポジトリで同期の git status がプロンプトとターンの終わりを待たせる → timeout 10 で打ち切られ、そのターンは目印を書けず (d) になる（付け違えはしない）。報告があれば測って非同期に戻すか、snapshot を軽くする
- 起点のファイルが続いているセッションのディレクトリにターンの数だけ積もる → 終えたターンは番号だけの小さいファイルになり、セッションが HOLD_DAYS 止まれば消える。中断されたターン（Claude Code は Stop を送らない）の起点は entries を持ったまま残る
- 走っている間の別の id のプロンプト（c）で status の編集が思ったより落ちる → 取り違えはしないので出す。trace の後に `edit_observation` の via 別の件数を見る
- 方針 7 の prune は T07 のタスクレビューで Codex に確かめさせる

## 未解決

なし

## 変更履歴
- 2026-10-03 / 方針 7 の prune をセッション単位の削除にし、方針 9 の穴 (d) を起点の書き込みの失敗全般に、(f) を timeout を過ぎて走り続ける hook を含む形に広げ、(g) を足した。起点の失敗で発言の保存と flush を止めない / T01・T02 のタスクレビュー（Codex）: T02 の prune と hook の競合 2 件、T01 の Interrupt の書き込み失敗で flush が止まる 1 件を受理。T01 の残り 3 件は同期の UserPromptSubmit の前提か書き込みの失敗に当たる / Go 不要（範囲・公開インターフェース・データは変わらず、付け違えの起き得る場面は (g) の一瞬が増え、prune の部分削除が無くなった分だけ減る）
- 2026-10-03 / 方針 7 に、旧形式のファイルは古いときだけ消す、prune の失敗で通知を止めない、発言を起点より先に spool する、終えたターンは番号だけ残す、を足した / review-shipping の 4 件（同期の UserPromptSubmit が 10 秒で打ち切られると発言が消える、ターンごとのファイルが entries ごと積もる、0.6.27 の hook のセッションの起点を消す、prune の例外で通知が出ない）を受理 / Go 不要（範囲・公開インターフェース・データは変わらない）
