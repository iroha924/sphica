---
kind: plan
status: approved
codex_session: 01a0e27c-9032-75c1-a57e-1e509ef0f869
codex_rounds: 3
approved_at: 2026-09-27
---

# Claude Code gets decisions when a Bash command names an anchored file, as Codex does, shipped as 0.5.1

## 要点

- Claude Code の PreToolUse Bash で、コマンドが記録の紐付くファイルを名指ししたら配信する（Codex の 0.5.0 と同じ「名指し」の配信。読んだ証拠とは言わない）
- 読み取りと同じ 1 セッション 1 回の抑止と予算を共有する。patch 形式の判定は Codex だけに残し、Claude の Bash は常に読み取り扱い
- hooks.json の matcher に Bash を足し、Claude 側の matcher を verify:ai で検査する。評価の matcher は hooks.json から追従する
- README（英・日）を両ホスト共通の書き方に直し、限界の見出しを 0.5.1 にする
- 公開前に手元の候補で、公開後に導入した 0.5.1 で、一時 HOME の `claude -p` を 3 回ずつ実測する
- Codex の挙動、配信の文面、予算の値は変えない

## 持ち主の決定

- 0.5.0 の実機確認で Claude Code が Read ではなく Bash の `cat` で読み、配信が 3 回とも出なかった。0.5.1 で Codex と同じ「コマンドがファイルを名指ししたときに配信する」を Claude Code にも入れる（2026-09-27、「うん、進めてOK」）
- `.claude/plans/` を .gitignore から外し、git で追跡する。過去の計画ファイルは削除する（plan の確認の後に持ち主が追加、2026-09-27）

## 目的

Claude Code のセッションで、Bash のコマンドが decision / constraint の applies_to アンカーのパスを名指しすると、その記録が PreToolUse の additionalContext で届き、delivery に claude-code の pre_read が記録される。

## 対象外

- シェルでの編集（`sed -i` など）を編集として解析すること。名指しとしての配信だけになる（Codex と同じ）
- Codex の挙動
- サブエージェントの予算の扱いの変更（今の実装のまま。実機での共有は未確認）

## 前提

- 0.5.0 の実機: `claude -p`（Claude Code 2.1.283）が 3 回とも `cat src/db.ts` などの Bash で読み、delivery は session_start だけだった。同じ入力を配布版 deliver.js に渡すと pre_read が emitted（2026-09-27 実測）
- Bash を読み取りとして扱うのは `host === "codex"` のときだけ（server/src/deliver.ts:543-561 の event と `shell` の計算）
- `shellPatch` は event の判定では host によらず呼ばれ、patch の生成だけが Codex 限定（server/src/deliver.ts:543-561。Codex 指摘 C1）
- Sphica の spool、状態、ベースライン、ローカルのプロジェクト表は、呼ぶたびに os.homedir() から `$HOME/.sphica` を解決する（server/src/capture.ts:34-49、server/src/project.ts:18-19）。`SPHICA_DB` は DB の場所だけを変える（server/src/sqlite.ts:22-25）
- `sphica@sphica` とローカルの `--plugin-dir` の plugin は別 ID で、前者を `--settings` の enabledPlugins で切っても候補は読み込める（https://code.claude.com/docs/en/cli-reference 、Codex が確認、2026-09-27）
- `release:plan` は作業ツリーではなくコミットを比べる。e1338f5 のままでは `none`（Codex 実測）。npm の版は plugin/package.json
- Codex の Bash フックの遅延は約 75 ms（0.5.0 の review-shipping、macOS）。Claude では未測定

## 方針

- server/src/deliver.ts
  - event: `tool_name === "Read"`、または `tool_name === "Bash"` で `!(host === "codex" && shellPatch(input))` なら pre_read
  - `patch` は今のまま Codex だけ（apply_patch と shellPatch）
  - `shell`: `tool_name === "Bash"` で patch が無く `tool_input.command` が文字列なら、ホストによらずそのコマンド
  - コメントの「Codex's reads only as shell commands」を両ホストに合う言い方に直す
- plugin/hooks/hooks.json: PreToolUse の deliver の matcher を `Edit|Write|MultiEdit|NotebookEdit|Read|Skill|Bash` にする
- scripts/check-ai-config.mjs: Claude の PreToolUse の deliver の matcher が Read と Bash を覆うことを検査する（Codex の既存の検査と同じ形）
- README.md / README.ja.md: 配信の節で、両ホストとも「記録の紐付くファイルを名指しするシェルのコマンドの前に（読んだ証拠ではない）」と書き、シェルでの編集は編集として解析しないと書く。「Limits in 0.5.0」を「Limits in 0.5.1」にし、名指しの限界の行をホスト共通にする
- server/test/deliver.test.ts に足すテスト
  - Claude の Bash が紐付くパスを名指し → 「this command names」の文面で配信し、delivery に claude-code の pre_read emitted
  - 何も名指ししない Bash → "" で delivery を残さない
  - Read の後に同じパスの Bash → 同じ記録を繰り返さない
  - `*** Begin Patch` / `*** Update File: src/f.ts` を含む Claude の Bash → pre_edit ではなく名指しの読み取り
- `.gitignore` から `.claude/plans/` を外し、過去の計画ファイル（追跡されていない `.claude/plans/` の既存ファイル）を消し、この plan と tasks を作業ブランチの最初のコミットに入れる
- 版: plugin/package.json、plugin/.claude-plugin/plugin.json、plugin/.codex-plugin/plugin.json、.claude-plugin/marketplace.json の npm source を 0.5.1 に揃える
- 実測（公開前と公開後、それぞれ 3 回）。コードを変えないので手順にせず、0.5.1 の公開とあわせて完了条件 A3〜A6 で流す
  - 一時ディレクトリを HOME にし、`~/.claude` と `~/.claude.json` へのリンクだけを置く。その HOME で scratch リポジトリに `sphica init` し、記録を 1 件入れる（DB は `$HOME/.sphica/sphica.db`、SPHICA_DB は使わない）
  - 3 回の前に、同じ HOME で簡単な `claude -p` を 1 回流してサインインが効くかを見る。効かなければ実測を止めて持ち主に戻す（本物の HOME に逃げない）
  - 公開前: `bun run bundle` の後、`--plugin-dir <plugin の絶対パス>` と `--settings`（enabledPlugins の sphica@sphica を false）で走らせ、stream-json の init で sphica の plugin が候補のパスの 1 件だけかを確かめる
  - 公開後: 導入した 0.5.1 で、init の plugin のパスと版を確かめてから走らせる
  - 1 回ごとに、delivery の行、最初に呼んだ Sphica のツール、最終回答が記録を使ったかを報告する
- 遅延: 紐付く記録 200 件の DB で、何も名指ししない Bash の入力を deliver.js に 50 回渡し、中央値と p95 を報告する

## 採った案と棄却した案

- 採用: Claude の Bash は patch 形式の文字列を含んでも読み取り扱い。棄却: host の条件を外すだけ（Claude の Bash が patch 形式で pre_edit になる。C1）
- 採用: 実測は一時 HOME。棄却: SPHICA_DB だけの切り替え（spool と状態は HOME の下にあり、持ち主の溜まった記録が一時 DB へ流れうる。C2）
- 採用: 公開前に手元の候補で実測し、公開後にも実測。棄却: 公開後の配信の件数だけで判定（同じ版は出し直せず、回答への反映も分からない。C2）

## 手順

- S1: deliver.ts で Claude の Bash を名指しの読み取りにし、テストを足す
- S2: hooks.json の matcher に Bash を足し、check-ai-config で Claude 側を検査する
- S3: README（英・日）を直す
- S4: 版を 0.5.1 に揃える
- S5: `.claude/plans/` を git の追跡に変え、過去の計画ファイルを消し、この plan と tasks を入れる

## 完了条件

- A1: `bun run verify` → exit 0
- A2: 版の変更をコミットした後に `bun run release:plan -- --base v0.5.0` → release kind が plugin
- A3: 公開前の 3 回の後に `sqlite3 <一時 HOME>/.sphica/sphica.db "select s.external_id, d.event, d.outcome from delivery d join session s on s.id = d.session_id where s.host = 'claude-code' order by d.id"` → Bash が紐付くパスを名指しした回ごとに pre_read emitted が 1 行以上。各回の stream-json の init で sphica が候補のパス 1 件。回ごとの最初の Sphica のツールと、回答が記録を使ったかも報告する
- A4: `node <候補の plugin>/dist/deliver.js` → 紐付く記録 200 件の一時 DB で、何も名指ししない Bash の入力を 50 回渡し、中央値と p95 を報告する（判定の閾値は置かない）
- A5: `sqlite3 <一時 HOME>/.sphica/sphica.db "select s.external_id, d.event, d.outcome from delivery d join session s on s.id = d.session_id where s.host = 'claude-code' order by d.id"` → 公開後の 3 回で A3 と同じ期待。init の sphica が導入した 0.5.1 のキャッシュのパスと版
- A6: `npm view sphica dist-tags --json` → latest と next が 0.5.1

## リスク

- Claude の Bash のたびに deliver.js が起動する → A4 の値が Codex（約 75 ms）より大きく離れていたら持ち主に報告し、先に DB を開かない判定（名指しの候補が無ければ終える）を検討する
- 紐付くパスを何件も並べた Bash のコマンドが読み取りの予算を使う → 予算は今の値のまま。評価で誤配として測る
- 一時 HOME でサインインが効かない → 実測を止めて持ち主に戻す
- サブエージェント（Explore）が親と予算を共有するかは実機で未確認 → 実測で見えたら報告する

## 未解決

なし

## 変更履歴
