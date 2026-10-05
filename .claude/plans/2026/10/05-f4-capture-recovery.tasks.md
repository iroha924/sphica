---
kind: tasks
plan: 05-f4-capture-recovery.plan.md
branch: fix/f4-capture-recovery
base: main
---

# hook が書けなかった record ツールの観測を後で送り直し、doctor が capture の待ち行列をそのまま報告する（#274 + #278） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 観測の送り直し（#274）

hook が DB に書けなかった record ツールの呼び出しが、次の flush で結ばれ、AI の採用の止めが外れる。

- [x] T01: 観測の形と検査、hook の先置き・直接の書き込み・後消し
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `server/src/capture.ts`, `server/test/capture.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `cd server && node --test --test-name-pattern 'observation' test/capture.test.ts` → pass。検査関数が 8 キー・各値の条件・拡張年の at を拒み、ロックを持った DB で hook を流すと `calls/` にファイルが残り、ロックが無ければ行が入ってファイルが消える
  - コミット: `feat(capture): keep each record tool observation in spool/calls until the database has it`
  - 結果: `bun run release:plan -- --base v0.6.33` → plugin、4 つの版を 0.6.34 に上げた。`node --test --test-name-pattern 'observation|record call' test/capture.test.ts` → 5 pass。書き込みロックを持った DB で hook が 50 ms 待って失敗すると `calls/` に同じ観測が 1 件残り、ロックが無ければ残らない。`calls/` が書けなくても DB に行が入る。`bun run verify` → 0

- [x] T02: flush が `calls/` を送り、結べなかった呼び出しの止めを外す
  - 種別: 修正
  - 計画: S2
  - 依存: T01（`calls/` のファイルと検査関数が要る）
  - 変更: `server/src/capture.ts`, `server/test/capture.test.ts`, `scripts/check-sql-live.mjs`
  - red: `cd server && node --test --test-name-pattern 'observation resend' test/capture.test.ts` → hook が書けなかった呼び出しの後、flush しても `tool_call_observation` に行が無く、別ターンの返事への agent の採用の insert が拒否されて fail
  - 完了条件: `cd server && node --test --test-name-pattern 'observation resend' test/capture.test.ts` → pass。再送後に別ターンが通り呼び出しのターンは拒否のまま、重複の再送で行が変わらない、未結合がもう 1 件あれば拒否のまま、拡張年の 2 例が `calls/rejected/` に `shape` で移り同じバッチの正常な観測は入る、callSession が再送前 null・再送後に観測のセッション、trace_pending の auto は再送前に何もしない
  - コミット: `fix(capture): resend record tool observations a hook could not write`
  - 結果: red（送信を足す前）: 2 件とも fail。1 件目は送信前の拒否・callSession の null・trace_pending の「cannot tell」までは通り、flush の後に `calls/` に観測が残る「sent and removed」で落ちた。2 件目は `toolu_ok` が入らず落ちた
  - 結果: 実装後 `node --test --test-name-pattern 'observation|record call' test/capture.test.ts` → 7 pass。`bun run verify` → 0（sql:live に calls/ の送り直しを足した）

## P2: 待ち行列の診断（#278）

doctor が待ち行列を読めない・残った・拒まれた・保留・消えた状態と、結べない呼び出しをそのまま出す。

- [ ] T03: 拒否の理由ファイルと prune の件数
  - 種別: 修正
  - 計画: S3
  - 依存: なし
  - 変更: `server/src/capture.ts`, `server/test/capture.test.ts`
  - red: `cd server && node --test --test-name-pattern 'rejection reason|prune count' test/capture.test.ts` → `rejected/<name>.reason` が無く、capture.json に `pruned` が無くて fail
  - 完了条件: `cd server && node --test --test-name-pattern 'rejection reason|prune count' test/capture.test.ts` → pass。`unreadable` / `version` / `no-project` / `sqlite:<CODE>` が書かれ、prune の件数が成功・失敗・送らなかった flush のどれでも残り、0 件の flush は前の値を引き継ぐ
  - コミット: `fix(capture): keep why each record was rejected and how many held records were pruned`

- [ ] T04: readState の読めない状態、SessionStart の通知、queueReport
  - 種別: 修正
  - 計画: S4
  - 依存: T02（queueReport が `calls/` と `calls/rejected/` を数える）, T03（queueReport が理由ファイルと `pruned` を読む）
  - 変更: `server/src/capture.ts`, `server/test/capture.test.ts`
  - red: `cd server && node --test --test-name-pattern 'unreadable queue' test/capture.test.ts` → SPHICA_HOME をファイルにすると readState が pending 0 を返し、captureNotice が null で fail
  - 完了条件: `cd server && node --test --test-name-pattern 'unreadable queue|queue report' test/capture.test.ts` → pass。読めないディレクトリは null とコード、ENOENT は 0、通知が出る。queueReport が 5 つのディレクトリの読める状態・60 秒より古い一時ファイル・理由ごとの件数・保留のプロジェクト別・`calls/` の件数・`pruned` を返す
  - コミット: `fix(capture): tell an unreadable queue from an empty one and report the queue in detail`

- [ ] T05: doctor の Recording 欄と、結べない呼び出しの欄
  - 種別: 修正
  - 計画: S5
  - 依存: T04（queueReport が要る）
  - 変更: `server/src/cli.ts`, `server/test/cli.test.ts`, `scripts/lib/sql-call-sites.mjs`
  - red: `cd server && node --test --test-name-pattern 'doctor queue' test/cli.test.ts` → SPHICA_HOME をファイルにした doctor が Recording を `0 pending` の ok と出して fail
  - 完了条件: `cd server && node --test --test-name-pattern 'doctor queue' test/cli.test.ts` → pass。一時 HOME の子プロセスで、unknown の fail、一時ファイル・理由ごとの拒否・保留のプロジェクト別・prune・送り直し待ち・送れなかった観測のファイル・claude-code / codex / すべてのホストの結べない呼び出しと止まった時刻の各行が出る。`bun run verify` → 0
  - コミット: `fix(doctor): report the capture queue and unjoined record tool calls as they are`

## P3: 梱包と Windows、文書と版

梱包した hook と Windows で送り直しと doctor が動くことを CI で見て、文書と版を揃える。

- [ ] T06: 梱包した hook の送り直しの検査と、Windows の doctor の検査
  - 種別: 追加
  - 計画: S6
  - 依存: T02（送り直しが要る）, T05（doctor の unknown が要る）
  - 変更: `scripts/check-hooks-live.mjs`, `.github/workflows/check.yml`
  - 完了条件: `bun run bundle && node scripts/check-hooks-live.mjs` → pass。record 用 PreToolUse の hook がロックを持った DB で hooks.json の timeout 以内に終わり、`calls/` にファイルを残し、`capture.js --flush` の後に観測の行が入る
  - コミット: `ci(hooks): check the packed hook resends a missed record tool observation, and doctor's unreadable queue on Windows`

- [ ] T07: README 両言語・knowledge-schema の Skill
  - 種別: 変更
  - 計画: S7
  - 依存: T02（送り直しの挙動を書く）, T05（doctor の出力を書く）
  - 変更: `README.md`, `README.ja.md`, `.agents/skills/knowledge-schema/SKILL.md`
  - 完了条件: `bun run release:plan -- --base v0.6.33` → `plugin`、4 つの版が 0.6.34 で同じ。`bun run verify` → 0
  - コミット: `docs: say when a missed record tool observation is resent, and bump to 0.6.34`

## 記録

- 2026-10-05 / T01, T07 / pre-commit の bundle 検査が、package の入力を変える最初のコミットで版の上げを求めた / 版の上げを T07 から T01 へ移した。T01 の変更欄に 4 ファイルを足し（前: capture.ts と capture.test.ts だけ）、T07 の変更欄から 4 ファイルを外し、T07 の名前から「・版」を外し完了条件を「4 つの版が 0.6.34 で同じ」にした
- 2026-10-05 / T02 / sql:live が capture.ts の新しい insert を子プロセスで通っていないと落とした / T02 の変更欄に `scripts/check-sql-live.mjs` を足した（前: capture.ts と capture.test.ts だけ）。calls/ に置いた観測を `--flush` が送ることを子プロセスで確かめる
