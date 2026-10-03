---
kind: plan
status: approved
codex_session: 01a0fdd6-74fa-77b2-9e13-85cd5724fbc8
codex_rounds: 2
approved_at: 2026-10-03
---

# Capture stops counting SDK turns as the owner's, and pending traces count for 14 days

## 要点

- `CLAUDE_CODE_ENTRYPOINT` が `sdk-` で始まるターンは、親の目印と一致してもオーナーのターンにしない（`sdk-ts`・`sdk-py` が今は素通り）
- ターンの境目（中断と compaction をまたぐ status の編集）は、実装とレビューで非同期の hook の取り合いが続いたので、この PR から外して別の計画にする（T02・T03・T07 は T08 で戻す）
- `fit()` の `redacted` は、残した部分に伏せ字があるときだけ立てる
- trace 待ちに数える期間を 30 日から 14 日にする（過ぎても消さず別の見出しで出す）
- 0.6.24 で出す。`plugin/hooks/codex.json`、schema、`HOLD_DAYS` は変えない

## 持ち主の決定

- epic #200 の次は #210、その後 #209 の Fix 部分、#207 の順（「OK、その順番で進めるか。」）
- trace 待ちを 14 日にし、この PR に入れる（議論の途中で持ち主が追加:「今回のPRで待ちを14日に変更しよう。30日は長い。」「一緒にPR混ぜて」）
- `codex.json` の変更は #207 で 1 回のリリースにまとめる（#207 の項目）
- ターンの境目はこの PR から外し、別の計画で設計し直す（T07 のレビューの後に持ち主が選んだ:「分けて後で」）

## 目的

- SDK の自動のエージェントの発言が、オーナーの発言として決定を adopt しない
- 中断されたターンの後にオーナーが手で直したファイルが、次のターンの `via: "status"` の編集として記録されない
- ターンの途中で compaction があっても、その前のシェルの変更がそのターンの編集として残る
- 切り詰めた発言で、伏せ字が捨てた部分にしか無いとき `redacted = 0` になる
- 最後のオーナーの発言から 14 日を過ぎたセッションは trace 待ちの件数に数えず、`trace_pending` では別の見出しの下に出る

## 対象外

- ターンの境目（方針 2・3、S2・S3）: 持ち主の決定で別の計画へ。残る穴は変更履歴を参照
- #188: #222（0.6.1）で閉じている
- `CLAUDE_AGENT_SDK_VERSION` を判定に使うこと: Claude デスクトップアプリが同梱の SDK で Claude Code を起動し、この変数を付ける（前提を参照）。使うとデスクトップの Code タブのオーナーのターンが全部落ちる
- `CLAUDE_CODE_SESSION_ATTENDED`: 文書が見つからない
- 走っている間に別の id で来る途中のメッセージ（148 件中 5 件）を分類すること: どちらに倒しても記録が落ちるだけで、取り違えにはならない
- `plugin/hooks/codex.json` の変更（#207）

## 前提

- `server/src/capture.ts` `isOwnerTurn`: agent_id、Codex の親、`SPHICA_PARENT_SESSION` の順に見て、最後が `return entrypoint !== "sdk-cli";`。親の目印と一致すると entrypoint を見ずに true を返す
- TypeScript Agent SDK 0.2.70（`~/.bun/install/cache/@anthropic-ai/claude-agent-sdk@0.2.70@@@1/sdk.mjs`）: `if(!B.CLAUDE_CODE_ENTRYPOINT)B.CLAUDE_CODE_ENTRYPOINT="sdk-ts"` と `process.env.CLAUDE_AGENT_SDK_VERSION="0.2.70"`。Python SDK 0.2.162 は `sdk-py`（#210 のコメント、https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.162/src/claude_agent_sdk/_internal/transport/subprocess_cli.py#L814-L824 、Codex が確認）
- Claude デスクトップアプリ（`/Applications/Claude.app/Contents/Resources/app.asar`、2026-10-03 に確認）: SDK 0.3.284 を同梱し `at.CLAUDE_CODE_ENTRYPOINT||="sdk-ts",at.CLAUDE_AGENT_SDK_VERSION||="0.3.284"`。entrypoint は `claude-desktop` / `claude-desktop-3p`、ほかに `local-agent`。hook に実際に届く環境は未検証（実機で hook の環境を取っていない）
- 持ち主の Claude Code のログ（`~/.claude/projects` の全 jsonl、2026-10-03）: entrypoint は `cli` 154,938、`sdk-cli` 12,052 だけ
- 起点（`Baseline = Snapshot & { running }`）は (host, session) ごとに 1 ファイル。UserPromptSubmit は走っていないときだけ取り直し、INJECTED の判定より前にある。Stop は `changed(before, now)` を `via: "status"` で書き running:false にする。SessionStart はどの source でも running:false で取り直す。Codex の Interrupt は flush だけ
- Claude Code は中断で Stop を送らない（https://code.claude.com/docs/en/hooks Stop の節）。Codex は Interrupt の後に同じターンの Stop を送らず、1 つのターンの途中のプロンプトは同じ turn id を持つ（openai/codex `codex-rs/core/src/hook_runtime.rs`、`codex-rs/core/src/tasks/mod.rs`、Codex が確認）
- 両ホストとも compaction で `source: "compact"` の SessionStart を送る（https://code.claude.com/docs/en/hooks#sessionstart-input 、https://learn.chatgpt.com/docs/hooks#sessionstart 、Codex が確認）。`codex.json` は SessionStart を登録済み
- `fit()` の切り詰めは 2 倍の窓を伏せてから切るが、`redacted` は窓全体で比べている。`db/schema.sql` の CHECK は truncated = 1 なら redacted のどちらも通す。`redacted` で分岐するコードは無い（Codex が確認）
- `PENDING_DAYS = 30`（`server/src/trace.ts:8`）。cutoff ちょうどは新しい側。`HOLD_DAYS`（未登録リポジトリのキューの 30 日、README）は別の上限

## 方針

1. オーナーのターン（`isOwnerTurn`）: agent_id と Codex の親を見た後、親の目印より前に、entrypoint が `sdk-` で始まれば false。許可の一覧（`cli` だけ）にはしない（`claude-desktop`、`claude-vscode`、`remote_desktop` などの人が使うホストを落とさない）。ファイル先頭のコメントを直し、残る穴を書く: Bash の外（hook のプロセスなど）から起動された SDK のエージェントが `cli` を受け継ぎ、親の目印を持たない場合は判定できない
2. ターンの境目: 起点に `turn`（その起点を取ったターンの id）を足す。UserPromptSubmit で
   - 注入でない（INJECTED に当たらない）プロンプトが、走っている起点に対して別の turn か、`turn` の無い起点（古いインストール）で来たら、ロールオーバー: 起点のファイルを先に消し、取り直して `{ ...snapshot, running: true, turn }` を書く。取り直しに失敗すれば起点が無いままで、次の Stop は status の編集を書かない
   - 同じ turn、または注入のプロンプトが走っている間に来たら、起点を残す（今と同じ）
   - 走っていないときは、注入かどうかによらず取り直す（今と同じ。turn を持たせる）
   - Codex の Interrupt: git を走らせず、起点を running:false で書き直す。書けなければファイルを消す
   - Stop は、起点の `turn` が Stop のターン id と同じときだけ status の編集を書く。遅れて終わった前のターンの hook が書いた起点や、消せなかった起点は別のターンのものとして使わない。走っている間に別の id の注入のプロンプトが来たら、起点の中身は残し `turn` だけをその id に付け替える（`turn` の無い古い起点は付け替えない）
   - 受け入れる損失: 走っている間に別の id の注入でないプロンプトが来たとき（中断、または別の id を持つ途中のメッセージ）、そのターンのシェルの変更は status の編集として残らない。tool の編集（`via: "tool"`）は今どおり残る
3. compaction: `HookInput` に `source` を足す。SessionStart で `source === "compact"` かつ起点が走っていれば上書きしない。startup / resume / clear は今どおり取り直す。両ホスト
4. `fit()`: 切り詰めのとき `redacted: a !== head(start, KEEP) || z !== tail(end, KEEP)`
5. trace 待ち: `PENDING_DAYS = 14`。`server/src/mcp-record.ts` の `trace_pending` の説明、`plugin/skills/trace/SKILL.md`、`server/evals/acceptance/cases.json` と `driver.ts`、`server/test/status.test.ts` の 30 を 14 にし、日数の fixture を 13 日・ちょうど 14 日・14 日を少し過ぎた・20 日にする
6. 受け入れケース: sdk-* のターン、中断の後のロールオーバー、compaction で起点を残す、の 3 つを足し、件数の固定（`server/test/acceptance-cases.test.ts`）を直す
7. リリース: `bun run release:plan -- --base <0.6.23 のリリースコミット>` を流してからバージョンを 0.6.24 にそろえ（npm と 3 つの manifest）、PR 本文にリリースノートを書く

## 採った案と棄却した案

- 採用: `sdk-` で始まる値を除く。棄却: `cli` だけを許す（デスクトップや IDE のオーナーのターンが落ちる）
- 採用: sdk-* は親の目印より前に判定する。棄却: 親の目印が一致すれば今どおり true（SDK は entrypoint が空のときだけ sdk-ts を付けるので、一致は SDK のプロセスが親のシェルの目印を受け継いだことを示す）
- 採用: SDK の判定に `CLAUDE_AGENT_SDK_VERSION` を使わず、穴を明記する。棄却: 2 つ目の手がかりとして使う（デスクトップの Code タブに付く）
- 採用: 別の id の注入でないプロンプトでロールオーバー。棄却: 別の id なら何でもロールオーバー（走っている間の完了通知で、中断が無いのに編集が落ちる）
- 採用: `turn` の無い古い起点もロールオーバーする。棄却: 古い起点は今どおり残す（更新の直後の中断で取り違えが残る）
- 採用: compaction で起点を残すのは両ホスト。棄却: Claude Code だけ（Codex も compact の SessionStart を送る）

## 手順

- S1: `isOwnerTurn` の sdk-* と親の目印の順序、コメント、単体テスト
- S2: 起点の `turn`、ロールオーバー、Codex の Interrupt、単体テスト
- S3: SessionStart の compact で起点を残す、単体テスト
- S4: `fit()` の `redacted`、単体テスト
- S5: `PENDING_DAYS` を 14 にし、説明・Skill・テスト・受け入れケースを直す
- S6: 受け入れケース 3 件と件数
- S7: release:plan、0.6.24 へのバージョンの更新、リリースノート

## 完了条件

- A1: `bun run verify` → 終了コード 0（sql:live と受け入れケースを含む）
- A2: `cd server && node --test --test-name-pattern="sdk-|redacted only|14 days" test/capture.test.ts test/status.test.ts` → 全部通る
- A3: `rg -n "30 days|30 日" server/src/trace.ts server/src/mcp-record.ts plugin/skills/trace/SKILL.md server/evals/acceptance server/test/status.test.ts` → 一致なし
- A4: `bun run release:plan -- --base <0.6.23 のリリースコミット>` → `plugin`。`plugin/package.json` と 3 つの manifest が 0.6.24
- A5: `gh pr checks <PR 番号> --watch` → 全ジョブ pass

## リスク

- 別の id の途中のメッセージが思ったより多く、status の編集が落ちすぎる → 取り違えは起きないので出す。数を測りたければ trace の後に `edit_observation` の via 別の件数を見る
- デスクトップアプリの hook に届く entrypoint が `sdk-ts` になる（アプリが `claude-desktop` を付けずに起動する経路がある）→ デスクトップのオーナーのターンが落ちる。出した後に持ち主のデスクトップのセッションが記録されているかを見て、落ちていれば直す
- 起点のファイル形式が変わる → 古い起点はロールオーバーで取り直すので、読めないことでは止まらない

## 未解決

なし

## 変更履歴
- 2026-10-03 / 方針 2 に「Stop は同じターンの起点だけを使う」「注入のプロンプトは起点の turn を付け替える」を足した / T02 のタスクレビューで、非同期の hook の遅れた書き込みと、起点を消せないときに古い起点が残る経路が再現されたため / Go 不要（合意した「迷うときは記録しない」の内側で、範囲・公開インターフェース・データは変わらない）
- 2026-10-03 / ターンの境目（方針 2・3、S2・S3、受け入れケースのうち中断と compaction の 2 件）をこの PR から外し、T08 で戻す / 起点を 1 つのファイルで持つ形は非同期の hook どうしの取り合いで直しが 2 回続けて新しい欠陥を生み、ターンごとのファイルにしても、Claude Code が通知で始まるターンに id を使い回す場合（中断の後のオーナーの編集がそのターンに付く）と、非同期の Stop の直後の編集（main にもある）が残ると Codex と確かめた / 持ち主の Go あり（「分けて後で」）
