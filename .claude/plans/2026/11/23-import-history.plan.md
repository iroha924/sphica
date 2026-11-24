---
kind: plan
status: approved
codex_session: none
codex_rounds: 0
approved_at: 2026-11-23
---

# 導入より前のホストの会話記録を、ライブの capture と同じ経路で取り込めるようにする（#215）

## 要点

- `sphica init --history` で、登録したプロジェクトの過去のセッションを、Claude Code の transcript と Codex の rollout から読み、capture の spool に積んで既存の送信で書く（一括の直接書き込みはしない）
- 取り込むのは、ライブの capture が記録するのと同じもの: 持ち主の発言、ターンごとの AI の最後の返答、AskUserQuestion の答え、編集ツールが報告したファイル。git status の編集は再現できないので取り込まない
- 持ち主の発言かどうかは、transcript の目印で決める（Claude Code は `origin.kind = "human"`、Codex は rollout の 1 行目が対話のスレッドを示すときだけ）。目印で決められないものは取り込まない
- すでに DB にあるセッション（同じホストと id）は丸ごと飛ばす。ライブの記録と二重にならない
- 正しさは、ライブの capture で入っているセッションを一時 DB に取り込み直し、持ち主の発言と返答の集合を突き合わせて測る（持ち主の DB は読むだけ）
- `--history` を付けない `sphica init` は今のまま。見つかった件数と付け方を 1 行で知らせるだけにする
- 変えないもの: DB の形（schema・revision）、capture のビュー、MCP ツール。CLI は `init` に 1 つ旗が増える（公開の契約の変更）

## 持ち主の決定

- #215 を進める（2026-11-23、「うん、進めて」）
- 持ち主の判断待ちだったものは Claude に任せる（2026-11-23）。ただしこの計画は戻しにくい領域（取り込みの経路・CLI の契約）なので、規定どおり実装の前に持ち主の Go を取る
- Codex のローカル実行は使えないので、grill-codex（Codex との詰め）は通さない。レビューは CLAUDE.md の規定どおり Claude だけの `/sphica:review full`

## 目的

- 新しく入れた人が `sphica init --history` を 1 回流すと、そのリポジトリの過去のセッションが `/sphica:trace pending` に並び、trace できる
- ライブの capture で記録済みのセッションを取り込み直すと、持ち主の発言の集合がライブの記録と一致する（一致しない分は理由ごとに数えて報告する）
- 取り込みを 2 回流しても、セッションも発言も増えない

## 対象外

- git status の編集（ライブではターンの始まりと終わりの作業ツリーを比べて得る。過去の作業ツリーは残っていない）
- サブエージェント・ヘッドレス（`claude -p`、`codex exec`）・SDK の実行。ライブの capture も記録しない。ログからは「持ち主が端末から起動した `codex exec`」と「エージェントが起動したもの」を区別できないので、`codex exec` は全部外す（ライブの capture より狭い。README に書く）
- 登録していないリポジトリのセッション、cwd が今は無いディレクトリのセッション（`identify()` で引けないもの）。件数だけ報告する
- 取り込んだセッションの自動の trace。session start の自動 trace は 14 日以内のものしか拾わないので、古いものは `/sphica:trace pending` で持ち主が選ぶ（今のまま）
- 他の AI ツール（Letta、Cursor など）の履歴

## 前提

- Claude Code の transcript は `~/.claude/projects/<cwd を - でつないだ名前>/<session id>.jsonl`。サブエージェントは `<session id>/subagents/` に別ファイル（このリポジトリで実測、2026-11-23）
- 持ち主のプロンプトの行は `type: "user"`、`origin: {"kind": "human"}`、`promptId` を持つ。通知は `origin.kind = "task-notification"`、別のエージェントからの報告は `isMeta` 付きで `origin.kind = "peer"`（a6a1a853 の transcript で実測。human 31 行、task-notification 1 行、peer は複数）
- Claude Code は `cleanupPeriodDays`（既定 30、持ち主の設定は 14）より古い transcript を消す（https://code.claude.com/docs/en/memory 、`~/.claude/settings.json:3`）。持ち主の手元に残っているのはこのリポジトリの 2 件だけで、どちらもライブで記録済み
- Codex の rollout は `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`、2026-08 以降はほぼ `.jsonl.zst`（1,383 件中 1,382 件）。1 行目の `session_meta` に `originator`・`source`・`thread_source`・`cwd`・`cli_version`。内訳は `codex_exec` 1,110、サブエージェントとレビュー 263、対話（`source: "vscode"`、`thread_source: "user"`）10（実測）
- Node 24.15 は `zlib.zstdDecompressSync` を持つ（実測）。新しい依存は要らない
- ライブの capture: `onHook`（`server/src/capture.ts:543`）が spool に `v: 2` の message / edit を積み、`write`（`:874`）が `capture_session`・`capture_message`・`capture_edit` に入れる。`created_at` は記録の `at`、`captured_at` は送った時刻。発言の id は `<turn>:<owner|assistant>:<本文の digest>`（`:600`）
- Codex で持ち主の発言かを決める今の規則は `codexThread` / `ownThread`（`server/src/codex-log.ts`）: 1 行目の `id` がセッション id と同じで `thread_source = "user"`
- 持ち主の DB は Claude Code 112 セッション、Codex 821 セッション（実測）
- Codex の rollout の中で、持ち主が打った発言とホストが差し込む発言（AGENTS.md、環境の説明）を分ける目印は未検証。T01 で実物から決める

## 方針

### 読み取り（`server/src/history.ts`、新規）

- 純粋な関数: transcript 1 本の行の配列を受け取り、`Spooled`（`capture.ts` の型）の配列と、外した理由ごとの件数を返す。ファイルを開くのは呼び出し側
- Claude Code: `origin.kind === "human"` の user 行を持ち主の発言、ターン（`promptId`）ごとの最後の assistant の text をその返答にする。AskUserQuestion の `toolUseResult` の answers は `answersOf`（`capture.ts:292`）と同じ形にして持ち主の発言、questions は返答として積む。Edit / Write / MultiEdit / NotebookEdit の `file_path` を `via: "tool"` の edit にする。`isSidechain`・`isMeta` の行と、origin の無い user 行は持ち主の発言にしない
- Codex: 1 行目が `ownThread` と同じ条件で、かつ `originator` が `codex_exec` でないときだけ読む。`item_completed` の UserMessage を持ち主の発言、ターンごとの最後の AgentMessage をその返答、FileChange のパスを `via: "tool"` の edit にする。T01 でこの目印をライブの記録と突き合わせ、ずれが理由なく残れば Codex は取り込まず、README に違いを書く（host-parity）
- 本文は `clean` と `fit`（`capture.ts`）を通し、id はライブと同じ式で作る。`at` は transcript の時刻
- 版: 読めた行の形だけを使い、知らない `type` は数えて飛ばす。transcript の書式の版は持たない（行ごとの形で判定する）

### 実行（`sphica init --history`）

- `init` がプロジェクトを登録した後、`--history` があれば、そのリポジトリの cwd を持つ transcript を探す。Claude Code は `~/.claude/projects/` の該当ディレクトリ、Codex は全 rollout の 1 行目の `cwd`
- 各セッションについて、DB に同じホストと id のセッションがあれば飛ばす。無ければ読み取った記録を spool に積み、最後に既存の送信（`flush`）で書く
- 出力は `view.ts` の部品で、見つかった数・取り込んだ数・飛ばした数（理由ごと）を出す。transcript の本文は出さない
- `--history` 無しの `init` は、見つかった件数が 1 以上なら「`sphica init --history` で取り込める」と 1 行出すだけ
- HOME の場所は `os.homedir()`（テストは一時 HOME）。`CODEX_HOME` があればそれを使う

### 測り方（`server/evals/history/`、新規）

- 持ち主の手元で、実物の transcript を一時ディレクトリの DB に取り込み、持ち主の DB（読み取り専用で開く）の同じセッションと、持ち主の発言の本文の集合を比べるスクリプト。結果は件数と、ずれの理由ごとの件数だけを出し、本文は出さない

## 採った案と棄却した案

- 採用: capture の spool に積んで既存の送信で書く。棄却: DB へ直接まとめて書く（CLAUDE.md の harvest の規定。capture のビューと検査を迂回する）
- 採用: `init --history`。棄却: 新しいサブコマンド `sphica import`（CLI は init・doctor・uninstall だけという規定を変える）、Skill から MCP で書く（セッションの発言は capture だけが書く規定。record server は session を書けない）
- 採用: 既に DB にあるセッションは丸ごと飛ばす。棄却: 発言ごとに id で重複を除く（ライブの入力と transcript の本文が少しでも違えば二重になる。境目で取りこぼすセッションはあるが、二重よりよい）
- 採用: `codex exec` を全部外す。棄却: ライブと同じく持ち主の exec を入れる（ログで見分けられない）
- 採用: 持ち主の発言は transcript の origin の目印で決める。棄却: ライブの `INJECTED` の形で決める（transcript にはより確かな目印がある）

## 手順

- S1: Codex の目印（UserMessage）が、ライブで記録した持ち主の発言と一致するかを実物で確かめる（理由のないずれが残れば Codex を外す）
- S2: 読み取りの純粋な関数とフィクスチャのテスト（Claude Code、Codex）
- S3: `init --history` の配線、重複の飛ばし、出力、`--history` 無しの 1 行
- S4: 持ち主の手元での突き合わせのスクリプトと、その結果
- S5: README（英日）と plugin-release / knowledge-schema の Skill の記述、受け入れケース
- S6: リリース（plugin、0.6.73）

## 完了条件

- A1: `cd server && node --test test/history.test.ts` → すべて pass（持ち主の発言、通知や peer の除外、AskUserQuestion、編集、サブエージェントと exec の除外、zstd）
- A2: `cd server && node --test test/history-live.test.ts` → 一時 HOME で `sphica init --history` を 2 回流し、1 回目でセッションと発言が入り、2 回目は 0 件増
- A3: `node server/evals/history/compare.ts --db <持ち主の DB の写し>` → ライブで記録済みのセッションについて、持ち主の発言の一致数と、ずれの理由ごとの件数が出る。理由のないずれが 0
- A4: `caffeinate -i mise exec -- bun run verify` → exit 0
- A5: リリース後、持ち主の手元のこのリポジトリで `sphica init --history` → 取り込んだ件数と飛ばした件数が理由ごとに出て、取り込んだセッションが `/sphica:trace pending` に並ぶ

## リスク

- Claude Code の transcript の形が版で変わる → 知らない形は数えて飛ばし、件数を出す。doctor には足さない
- 持ち主の発言の誤認（通知や他のエージェントの文を持ち主の言葉として記録する）→ 目印が無い行は入れない。A3 の突き合わせでずれを見る
- S1 で Codex の目印がずれる → Codex を外して Claude Code だけで出し、README に違いを書く（この計画の Go の範囲内）
- 持ち主の手元では取り込める古いセッションがほとんど無く（Claude Code は 14 日で消える）、効果を持ち主の実地で測れない → A3 は正しさだけを測り、効果（仮説）は新しく入れた人の結果待ちとして #215 に書く
- 大量の rollout（1,383 件、zstd）を読む時間 → 1 行目だけを先に読んで cwd で絞る

## 未解決

なし

## 変更履歴

- 2026-11-24 / レビュー（round 1）を受けて: 作業中に打った発言（`queued_command` の attachment、origin human）を持ち主の発言に足し、human の行の先頭の `<system-reminder>` のブロックを外し、AskUserQuestion の答えはその呼び出しの結果からだけ取り、持ち主の発言が 1 件も無いセッションは取り込まない / 突き合わせで、作業中の発言 5 件をライブは記録し取り込みは落としていた。ホストのブロックは持ち主の言葉ではない / Go 不要（目的の「持ち主の発言の集合がライブと一致」の範囲）
- 2026-11-24 / Claude Code は 1 つのセッションが別のディレクトリから移ってくるので、ターンごとの cwd でリポジトリのものかを決め、worktree のセッションの編集はその checkout の root からの相対にする。cwd がもう無いディレクトリでもリポジトリの root の下なら取り込む（「対象外」の「cwd が今は無いディレクトリのセッション」から変更） / a6a1a853 はデスクトップの作業用フォルダで始まり、この計画の読み方では丸ごと落ちていた。消えた worktree のセッションも root の下にある / Go 不要（目的の範囲。対象外を狭めた）
- 2026-11-24 / 送信待ちの記録があるセッション（実行中、まだ送っていない）は飛ばす。書けた件数は DB に入った数で数え、拒否された件数を出す。Codex は `source` が cli か vscode のものだけにし、rollout は 1 行目だけを先に展開して除外を決める。`CLAUDE_CONFIG_DIR` を読む / 実行中のセッションの取り込みが時刻の違いで拒否され警告が残ること、他のセッションの送信を数えて成功と出ることを再現した / Go 不要
