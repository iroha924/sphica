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

- [ ] T04: hook の入力の `transcript_path` の 1 行目から、Codex の対話のセッションかを読む関数を足す
  - 種別: 追加
  - 計画: S4
  - 依存: T01（バージョンを上げた後でないと、package に入るファイルを変えるコミットを pre-commit が断る）
  - 変更: `server/src/capture.ts`, `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/deliver.test.ts` → pass。`codex-tui` で `payload.id` が一致するログだけ対話、`codex_exec`・ファイル無し・通常ファイルでない・途中で切れた JSON・空やオブジェクトでない payload・別のセッションの id・subagent・1 行目が 256 KiB を超えるものは対話でない、短い 1 行目 + 大きな残りは対話。続けて `bun run verify` → 終了コード 0
  - コミット: `feat(deliver): read whether a Codex session is interactive from its log's first line`

- [ ] T05: 新しい対話の Codex のセッションに、SKILL.md のパスを名指しした自動の trace の案内を出す
  - 種別: 変更
  - 計画: S4
  - 依存: T04（ログの 1 行目で対話を見る関数が要る）, T03（案内を受けたエージェントが呼ぶ `auto: true` を、対話でない呼び出しに返さない止めが先に要る）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/deliver.test.ts` → pass。Codex の `codex-tui` の新しいセッションで `AUTO_TRACE`（パス入り）が同じセッションで 1 回だけ出る、`source: "resume"`・off（`off`, `0`, `false`, `no`）・待ち 0 件・長すぎるパス・制御文字を含むパスでは今の案内、Claude Code の文面は変わらない。続けて `bun run verify` → 終了コード 0
  - コミット: `feat(deliver): ask a new interactive Codex session to trace on its own`

## P3: Skill・文書・配布前の確認

trace の Skill と README が両ホストの今の動きと残る差を言い、実際のプラグインで動きを確かめる。

- [ ] T06: trace の Skill の「On your own」と採用の条件を、Codex でも成り立つ文面に直す
  - 種別: 変更
  - 計画: S5
  - 依存: T03（`trace_pending` が「自動で trace しない」と返す文面が要る）, T05（Codex の案内が SKILL.md を名指しする動きが要る）
  - 変更: `plugin/skills/trace/SKILL.md`
  - 完了条件: `bun run verify` → 終了コード 0。`rg -n "Codex does not start this Skill on its own yet" plugin/skills` → 0 件
  - コミット: `docs(trace): say when the trace Skill runs on its own in Codex`

- [ ] T07: README（英日）・検査のコメント・配布の Skill を直し、配布前の確認を流して結果を PR 本文に書く
  - 種別: 変更
  - 計画: S6, S8
  - 依存: T01（採用の条件の言い方が要る）, T05（自動の trace の条件の言い方が要る）, T06（Skill の文面と README の言い方を揃える）
  - 変更: `README.md`, `README.ja.md`, `scripts/check-ai-config.mjs`, `.claude/skills/plugin-release/SKILL.md`, `.agents/skills/plugin-release/SKILL.md`
  - 完了条件: `bun run verify` → 終了コード 0。plan の A5 の `rg` が 0 件。配布前の確認（plan の「リリース」の手順）の 5 項目それぞれについて、何回中何回かを PR 本文の「配布前の確認」の節に書いてある
  - コミット: `docs: say what Codex adopts and traces on its own, and what the background server's environment decides`

## 記録

- 2026-10-12 / T01〜T03 / 1 つのコミットにした（検査とレビューを 1 回にまとめるため）
- 2026-10-12 / T02 / 変更欄を直した。前: `server/test/codex-caller.test.ts`。後: `server/test/codex-caller.test.ts`, `server/test/record-world.ts`（`reply` がホストの `_meta` を受け取る引数を足した）
- 2026-10-12 / T01〜T03 / コミットの前の Codex のレビュー（`staged diff on 90bd2ed9`、新しい会話、high）: 指摘 0 件。ステージした 11 ファイル・plan・tasks を読み、`callerOf` の 15 通りを書き込みなしで実行したとのこと。`bun run verify` と子プロセスのテストは読み取り専用のため未実行と明記
- 2026-10-12 / T01〜T03 / コミットの前の review-shipping: 出荷可の判定。pack した 0.6.52 をリポジトリの外で展開して確認（53 ファイル、`dist` 6 件、`check-tarball.mjs` 終了コード 0、`dist/mcp-record.js` に新しい文面と `thread_source` があり、hook の bundle には無い）。直す前の `src` で新しいテスト 15 件中 7 件が fail、止めを `if (false)` にすると一覧のテストが fail、`thread_id === session_id` を外すと子のスレッドのテストが fail。指摘 1 件: README.md:150 と trace の SKILL.md:61 が、tag の前に直っている必要がある（T06・T07 で直す予定どおり）。Windows は未実行
