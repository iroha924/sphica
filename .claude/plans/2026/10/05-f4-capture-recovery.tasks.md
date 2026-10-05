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
  - 結果: red（送信を足す前）: `node --test --test-name-pattern 'observation resend' test/capture.test.ts` → 2 件とも fail。1 件目は送信前の拒否・callSession の null・trace_pending の「cannot tell」までは通り、flush の後に `calls/` に観測が残る「sent and removed」で落ちた。2 件目は `toolu_ok` が入らず落ちた
  - 結果: 実装後 `node --test --test-name-pattern 'observation|record call' test/capture.test.ts` → 7 pass。`bun run verify` → 0（sql:live に calls/ の送り直しを足した）

## P2: 待ち行列の診断（#278）

doctor が待ち行列を読めない・残った・拒まれた・保留・消えた状態と、結べない呼び出しをそのまま出す。

- [x] T03: 拒否の理由ファイルと prune の件数
  - 種別: 修正
  - 計画: S3
  - 依存: なし
  - 変更: `server/src/capture.ts`, `server/test/capture.test.ts`
  - red: `cd server && node --test --test-name-pattern 'rejection reason|prune count' test/capture.test.ts` → `rejected/<name>.reason` が無く、capture.json に `pruned` が無くて fail
  - 完了条件: `cd server && node --test --test-name-pattern 'rejection reason|prune count' test/capture.test.ts` → pass。`unreadable` / `version` / `no-project` / `sqlite:<CODE>` が書かれ、prune の件数が成功・失敗・送らなかった flush のどれでも残り、0 件の flush は前の値を引き継ぐ
  - コミット: `fix(capture): keep why each record was rejected and how many held records were pruned`
  - 結果: red（capture.ts を直す前に戻して）: `node --test --test-name-pattern 'rejection reason|prune count' test/capture.test.ts` → 理由ファイルが 1 つも無く deepEqual で fail、capture.json に `pruned` が無く `undefined !== 2` で fail
  - 結果: 実装後 `node --test --test-name-pattern 'rejection reason|prune count' test/capture.test.ts` → 2 pass（unreadable / version / no-project / sqlite:CONSTRAINT、送らない flush でも件数が残り、0 件の flush と 2 件目の削除で落ちた flush でも直前の値か 1 件が残る）。`bun run verify` → 0

- [x] T08: 読めない観測のファイルを calls/rejected/ へ移し、送信を止めない
  - 種別: 修正
  - 計画: S2
  - 依存: T02（観測の送信が要る）
  - 変更: `server/src/capture.ts`, `server/test/capture.test.ts`
  - red: `cd server && node --test --test-name-pattern 'unreadable observation' test/capture.test.ts` → 読み取り権限の無い観測のファイルで flush が EACCES を投げ、正常な観測も通常のキューも送られず fail
  - 完了条件: `cd server && node --test --test-name-pattern 'unreadable observation' test/capture.test.ts` → pass。読めないファイルは `calls/rejected/` に `unreadable` で移り、同じ flush で正常な観測と通常のキューが送られる
  - コミット: `fix(capture): set aside an observation file that cannot be read instead of stopping the send`
  - 結果: red: `node --test --test-name-pattern 'unreadable observation' test/capture.test.ts` → `EACCES: permission denied, open '.../spool/calls/1-a.json'` で fail
  - 結果: 実装後 同じコマンド → pass（読めないファイルが `calls/rejected/` に unreadable で移り、正常な観測と通常のキュー 1 件が送られた）。`bun run verify` → 0

- [x] T04: readState の読めない状態、SessionStart の通知、queueReport
  - 種別: 修正
  - 計画: S4
  - 依存: T02（queueReport が `calls/` と `calls/rejected/` を数える）, T03（queueReport が理由ファイルと `pruned` を読む）
  - 変更: `server/src/capture.ts`, `server/test/capture.test.ts`
  - red: `SPHICA_HOME=$T/h node -e 'import("./src/capture.ts").then(m => console.log(m.readState().pending, m.captureNotice(process.env.SPHICA_HOME + "/sphica.db")))'` → `0 null`（`$T/h/spool` をファイルにし、`$T/h/sphica.db` を置く）
  - 完了条件: `cd server && node --test --test-name-pattern 'unreadable queue|queue report' test/capture.test.ts` → pass。読めないディレクトリは null とコード、ENOENT は 0、通知が出る。queueReport が 5 つのディレクトリの読める状態・60 秒より古い一時ファイル・理由ごとの件数・保留のプロジェクト別・`calls/` の件数・`pruned` を返す
  - コミット: `fix(capture): tell an unreadable queue from an empty one and report the queue in detail`
  - 結果: red: `SPHICA_HOME=$T/h node -e '...readState()...captureNotice(...)'` → `{"pending":0,"rejected":0} null`（spool をファイルにした）
  - 結果: 実装後 `node --test --test-name-pattern 'unreadable queue|queue report|stuck is reported' test/capture.test.ts` → 3 pass。`bun run verify` → 0

- [x] T05: doctor の Recording 欄と、結べない呼び出しの欄
  - 種別: 修正
  - 計画: S5
  - 依存: T04（queueReport が要る）
  - 変更: `server/src/cli.ts`, `server/test/cli.test.ts`
  - red: `cd server && node --test --test-name-pattern 'doctor queue' test/cli.test.ts` → 新しい行（Left-behind files など）が無く fail。spool をファイルにした doctor は Recording を ok と出す
  - 完了条件: `cd server && node --test --test-name-pattern 'doctor queue' test/cli.test.ts` → pass。一時 HOME の子プロセスで、unknown の fail、一時ファイル・理由ごとの拒否・保留のプロジェクト別・prune・送り直し待ち・送れなかった観測のファイル・claude-code / codex / すべてのホストの結べない呼び出しと止まった時刻の各行が出る。`bun run verify` → 0
  - コミット: `fix(doctor): report the capture queue and unjoined record tool calls as they are`
  - 結果: red: `node --test --test-name-pattern 'doctor queue' test/cli.test.ts` → `no Left-behind files row` で fail。`HOME=$H node src/cli.ts doctor`（spool をファイルに）→ `✓ Recording null pending`
  - 結果: 実装後 `node --test --test-name-pattern 'doctor' test/cli.test.ts` → 5 pass（一時ファイル・理由ごとの拒否・保留のプロジェクト別・prune・送り直し待ち・送れなかった観測・Claude Code / Codex / すべてのホストの 3 行、読めないキューは ✗ で 0 pending と出さない）。`bun run verify` → 0

## P3: タスクごとのレビューの指摘の修正

T03・T08 のレビューで見つかった、prune の件数の上書きと、移せない観測で送信が止まる穴を直す。

- [x] T09: 1 回の flush の中で、ロックを取り直しても prune の件数を足し続ける
  - 種別: 修正
  - 計画: S3
  - 依存: T03（prune の件数が要る）
  - 変更: `server/src/capture.ts`, `server/test/capture.test.ts`
  - red: `cd server && node --test --test-name-pattern 'prune count across' test/capture.test.ts` → 2 回目のロック保持の prune が 1 回目の件数を上書きし、合計より小さい count が残って fail
  - 完了条件: `cd server && node --test --test-name-pattern 'prune count' test/capture.test.ts` → pass。2 回のロック保持で消えた件数の合計が state に残る
  - コミット: `fix(capture): count every prune of one send, across retaking the lock`
  - 結果: red: `node --test --test-name-pattern 'prune count across' test/capture.test.ts` → `actual: 1, expected: 3` で fail
  - 結果: 実装後 `node --test --test-name-pattern 'prune count' test/capture.test.ts` → 2 pass。`bun run verify` → 0

- [x] T10: 観測のファイルを calls/rejected/ へ移せなくても送信を続ける
  - 種別: 修正
  - 計画: S2
  - 依存: T08（読めないファイルの隔離が要る）
  - 変更: `server/src/capture.ts`, `server/test/capture.test.ts`
  - red: `cd server && node --test --test-name-pattern 'observation that cannot be moved' test/capture.test.ts` → rename が EBUSY で失敗すると flush が投げ、正常な観測も通常のキューも送られず fail
  - 完了条件: `cd server && node --test --test-name-pattern 'observation that cannot be moved' test/capture.test.ts` → pass。移せないファイルは calls/ に残り、同じ flush で正常な観測と通常のキューが送られる
  - コミット: `fix(capture): keep sending when an observation file cannot be set aside`
  - 結果: red: `node --test --test-name-pattern 'observation that cannot be moved' test/capture.test.ts` → `EBUSY: resource busy or locked` が flush から投げられて fail
  - 結果: 実装後 `node --test --test-name-pattern 'observation' test/capture.test.ts` → 7 pass（移せないファイルは calls/ に残り、正常な観測と通常のキュー 1 件が送られた）。送った後の削除の失敗も同じく握るようにした。`bun run verify` → 0

- [x] T11: 拒否の理由 no-project を doctor が unknown と数えない
  - 種別: 修正
  - 計画: S4
  - 依存: T04（queueReport が要る）
  - 変更: `server/src/capture.ts`, `server/test/capture.test.ts`
  - red: `cd server && node --test --test-name-pattern 'queue report' test/capture.test.ts` → 理由ファイルが `no-project` の記録が `unknown` に数えられて fail
  - 完了条件: `cd server && node --test --test-name-pattern 'queue report' test/capture.test.ts` → pass。no-project・unreadable・version・sqlite:<CODE>・shape がそのまま数えられ、それ以外の中身は unknown
  - コミット: `fix(capture): count the no-project rejection reason as itself`
  - 結果: red: `node --test --test-name-pattern 'queue report' test/capture.test.ts` → `actual: { unreadable: 1, 'sqlite:CONSTRAINT': 1, unknown: 3, version: 1 }`（no-project が unknown に入る）で fail
  - 結果: 実装後 同じコマンド → pass。`bun run verify` → 0

- [x] T12: doctor の AI の採用の止まりを、名前ではなくプロジェクトごとに数える
  - 種別: 修正
  - 計画: S5
  - 依存: T05（doctor の欄が要る）
  - 変更: `server/src/cli.ts`, `server/test/cli.test.ts`
  - red: `cd server && node --test --test-name-pattern 'doctor queue' test/cli.test.ts` → 同じ名前の 2 つのプロジェクトの呼び出しが 1 行にまとまり、件数と時刻が混ざって fail
  - 完了条件: `cd server && node --test --test-name-pattern 'doctor queue' test/cli.test.ts` → pass。同じ名前のプロジェクトは別の行になり、それぞれキーで見分けられる
  - コミット: `fix(doctor): count stopped AI adoption per project, not per project name`
  - 結果: red: `node --test --test-name-pattern 'doctor queue' test/cli.test.ts` → AI adoption の行が `actual: 3, expected: 4`（同じ名前の 2 つのプロジェクトが 1 行に混ざる）で fail
  - 結果: 実装後 同じコマンド → pass（同じ名前のプロジェクトはキーを添えて別の行）。`bun run verify` → 0（3 回目。下の記録を参照）

## P4: 梱包と Windows、文書と版

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
- 2026-10-05 / T01 / Codex のタスクごとのレビュー（65383caf） / 指摘なし。ロック時の実走と Windows は Codex 側で未実行（read-only）
- 2026-10-05 / T03 / 実装を先に書いてから red を確かめた / capture.ts の変更を一時的に退けて新しいテストが意図した理由で落ちることを確かめ、戻した
- 2026-10-05 / T02 / Codex のタスクごとのレビュー（d49c2525）F1: 読めない（EACCES）観測のファイルが flush を投げさせ、通常のキューまで毎回止める / 受理。読み取りの ENOENT 以外の失敗も unreadable で隔離する修正タスク T08 を T04 の前に足した
- 2026-10-05 / T04 / red の欄を変えた。前: SPHICA_HOME をファイルにして readState と captureNotice を見る。新: SPHICA_HOME の下の spool をファイルにする / SPHICA_HOME 自体をファイルにすると DB も無くなり、captureNotice は「DB が無い」を先に返すので、キューが読めないことを確かめられない
- 2026-10-05 / T05 / 変更欄から `scripts/lib/sql-call-sites.mjs` を外した（前: cli.ts・cli.test.ts・sql-call-sites.mjs）。red の欄を、spool をファイルにする形と新しい行が無いことに変えた / 台帳は変えずに verify が通った。SPHICA_HOME 自体をファイルにすると DB も無くなる（T04 と同じ理由）
- 2026-10-05 / T03 / Codex のレビュー（3be8e3b8）F1: removed がロック保持ごとに 0 に戻り、後の prune が件数を上書きする / 受理。修正タスク T09 を足した
- 2026-10-05 / T08 / Codex のレビュー（538ecc3d）F1: 読めない観測を rename できない（Windows の EBUSY など）と setAside が投げ、送信全体が止まる / 受理。修正タスク T10 を足した。通常のキューの rename の失敗が投げるのは前からの挙動で、この PR では変えない
- 2026-10-05 / T04 / Codex のレビュー（1bb9b112）F1: doctor が読めないキューを ok / null pending と出す / T05 で直っている（✗ と「the queue cannot be read」）。F2: 理由の正規表現がハイフンを許さず no-project が unknown になる / 受理。修正タスク T11 を足した
- 2026-10-05 / T05 / Codex のレビュー（11063e12）F1: 集計のキーが project.name と host で、同じ名前の別のプロジェクトが混ざる / 受理。修正タスク T12 を足した
- 2026-10-05 / T12 / verify が 2 回続けて record.test.ts の rename limit（一時ディレクトリの rmSync が ENOTEMPTY）で落ちた。このブランチは触っていない / 単独で 3 回 pass、`bun run test` は T12 の変更あり・なしとも 0、3 回目の verify は 0。負荷で起きる既存の不安定さとみて手を入れない
