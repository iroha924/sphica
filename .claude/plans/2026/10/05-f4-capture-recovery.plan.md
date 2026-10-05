---
kind: plan
status: approved
codex_session: 01a10b76-98c9-7573-ab8c-cde754dd279c
codex_rounds: 4
approved_at: 2026-10-05
---

# hook が書けなかった record ツールの観測を後で送り直し、doctor が capture の待ち行列をそのまま報告する（#274 + #278）

## 要点

- Claude Code の record ツール用 PreToolUse hook は、DB へ直接書く前に同じ観測を `spool/calls/` に 1 ファイル置き、直接の書き込みが通れば消す。通らなかった（ロック待ちの時間切れなど）ファイルは次の flush が `capture_tool_call` へ送る。同じ tool use id で結ばれると、そのプロジェクトの後の返事の AI の採用の止めが外れ、呼び出したターンは外れたまま
- hook が動かない・tool use id が無い呼び出しは今までどおり結べない（送り直す元が無い）。推し量りで止めを外すことはしない
- doctor の Recording 欄: 読めないキューを 0 と言わず unknown、残った一時ファイル、拒否の理由ごとの件数、保留の録音のプロジェクト別と最後の prune の件数、送り直し待ちと送れなかった観測のファイル
- doctor の新しい欄: 結べない record ツールの呼び出しをプロジェクト・ホストごとに、AI の採用が止まった時刻と一緒に出す
- SessionStart の通知は、キューが読めないときの 1 つだけ増やす
- 変えないもの: schema、接続の役割、結べるまで止める方針、自動の復旧・削除・保持期間、trace_pending の自動 trace の fail-safe

## 持ち主の決定

- F4 は #274 と #278 を 1 PR にする（GitHub Project Sphica の Phase 01 / bundle F4）
- 結べるまで AI の採用を止める（fail closed）。セッション id・時刻・後の成功した hook から推し量って止めを外さない（`.claude/plans/2026/10/04-agent-adoption.plan.md` 方針 2、PR #273）
- #278 は診断だけ。自動の復旧・削除・保持期間の変更をしない（#278 本文）

## 目的

- hook が一時的に DB に書けなかった record ツールの呼び出しが、次の flush の後に同じ tool use id で結ばれる。ターンが分かる呼び出しなら、そのプロジェクトの別のターンの返事に AI の採用が付けられ、呼び出したターンの返事には付けられないまま
- doctor を見れば、待ち行列が読めるか、送られずに残るもの・拒まれたもの・保留のもの・消えたものがどれだけあるか、どのプロジェクトのどのホストでいつから AI の採用が止まっているかが分かる

## 対象外

- hook が動かない（`disableAllHooks`）・tool use id が無い・導入前の呼び出しを結ぶ方法。送り直す元が無く、推し量りは持ち主の決定で棄却済み
- 止まった呼び出しを持ち主が手で解除する口（#281 の段階 2）
- Codex の観測（MCP のメタデータにターンがあり hook を使わない）
- `calls/` の自動 prune。期限で消すと、結べていない呼び出しの唯一の送り直し元を失い止めが永久に残る
- 保存済みの候補を後から AI の採用に上げること（採用はトリガーが insert の時点で見るだけ）

## 前提

- hook: `plugin/hooks/hooks.json:100-112` の PreToolUse（matcher `mcp__plugin_sphica_record__.*`、timeout 10 秒）。`server/src/capture.ts:948-981` の `observeRecordCall` が `openWriter("capture", file, 5000)` で `capture_tool_call` へ直接 insert し、失敗は `main().catch(() => {})`（`capture.ts:1010-1014`）で黙って終わる
- `capture_tool_call` の instead-of insert は `on conflict do nothing`（`db/schema.sql:1169-1174`）、`tool_call_observation` は `unique (host, tool_use_id)`（`schema.sql:240-251`）。同じ観測の再送は行を変えない。capture の役で書ける（`server/src/db-write.ts:60,71`）
- `agent_ineligible_source`（`schema.sql:699-713`）: 観測は同じ session の同じ turn を外し、turn が null なら `observed_at` 以降を外す。claude-code の呼び出しで観測の無いもの・host が null のもの・codex で caller_session が null のものは、そのプロジェクトの `called_at` 以降の返事を外す。host が null の呼び出しは両ホストを外す（`schema.sql:711`）
- 採用はトリガー `unit_adoption_route`（`schema.sql:442-466`）と `server/src/record.ts:894` が保存の時点で見る
- `callSession`（`server/src/trace.ts:172-189`）は Claude Code の呼び出しのセッションと owner を観測から取る。trace_pending の auto は flush より前に callSession を見て、null なら自動 trace は何もしない（`server/src/mcp-record.ts:123`、`server/src/extract.ts:77-79`）。check と save も callSession を使う（`extract.ts:221,268`）
- 0.6.33 の flush が読むのは spool 直下と `unregistered/` の `.json` だけ（`capture.ts:783-795,911,917`）で、下位のディレクトリは読まない。`current` は project の無い記録を投げて rejected へ移す（`capture.ts:102`）
- `spool` は `.<name>` に書いて rename（`capture.ts:173-180`）。`readState` は読めないディレクトリを 0 にする（`capture.ts:571-605`）。`sendBatch` は理由を残さず `rejected/` へ移す（`capture.ts:801-867`）。prune は 1 回の flush で 2 回走り件数を残さない（`capture.ts:157-171,910,922`）。state は全体を上書きし、バッチを送ったときと失敗したときだけ書く（`capture.ts:561,925-928`）
- doctor の Recording 欄は `server/src/cli.ts:156-165`。reader の接続は全テーブルを読める（`server/src/sqlite.ts:146-153`）
- SQLite の日付関数の年は 0000〜9999。`new Date(at).toISOString() === at` は `+010000-…` や `-000001-…` を通すが、`schema.sql:248` の CHECK は拒む（Codex が Node 24.15 とメモリ上の SQLite で実測、2026-10-05）
- `scripts/check-hooks-live.mjs` は Windows の CI（`.github/workflows/check.yml:139-180`）で梱包した hook を起動する。今の起動の時間上限は 60 秒（`check-hooks-live.mjs:21`）
- README の制限の行: `README.md:147`、`README.ja.md:146`
- 未検証: Windows で、追加のファイル操作を含む hook が 10 秒以内に終わるか、ENOTDIR のエラーコード。CI で確かめる

## 方針

1. 観測の形（`server/src/capture.ts`）
   - `Observation = { v: 1, host: "claude-code", session, turn, toolUse, tool, owner, at }`。検査関数 `observation(raw)` は、キーがちょうどこの 8 つ、`v === 1`、`host === "claude-code"`、session・toolUse が `hostId` と同じ ASCII 1〜200 文字、tool が同じ条件で `mcp__plugin_sphica_record__` で始まる、turn が null か同じ条件、owner が数の 0 か 1、at が `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/` に合いかつ `new Date(at).toISOString() === at`。外れたら修復せず null
   - hook も flush も、同じ検査を通したオブジェクトだけを書く
2. hook（`observeRecordCall`）
   - 入力の検査の後、1 つの Observation を作る（`at` も 1 回だけ決める）
   - `spool/calls/` に `.<name>` で書いて rename（try/catch。失敗しても続ける）
   - 今の直接 insert を同じ Observation から行う（ロック待ち 5 秒は変えない）
   - insert が通ればファイルを rm（try/catch。消せなくても残りは次の flush で on conflict になるだけ）
   - hook から flush は起動しない（次の UserPromptSubmit / Stop の flush が送る）
3. flush
   - 最初のロック保持で、`unregistered/` の後・通常のキューの前に `calls/` を BATCH 件ずつ処理する。1 バッチ 1 トランザクションで `capture_tool_call` へ insert し、commit が返ってからそのバッチのファイルを消す。`late()` で打ち切り、残りは次の flush。通常キューの最低 1 バッチの規則（`queueBatches === 0`）は変えない
   - 読むときの ENOENT は hook が先に結んで消したものとして飛ばす。読めない・形が違うものは `calls/rejected/` へ移し、隣に理由（`unreadable` / `shape`）を書く
   - バッチが CONSTRAINT / MISMATCH / TOOBIG / RANGE で拒まれたら 1 件ずつ入れ直し、拒まれたものだけを `calls/rejected/` へ `sqlite:<CODE 名>` で移す
   - 通常のキューの拒否（`sendBatch`）も `rejected/<name>.reason` に理由を書く: `unreadable`（JSON が読めない）、`version`（未知の版）、`no-project`、`sqlite:<CODE 名>`。本文と例外メッセージは書かない
   - prune は消した件数を返し、途中の例外でも消した分を数える。flush は 1 回の中の件数を total に足し、成功の state にも失敗の state にも `pruned: { at, count }` を書く。count が 0 なら前の `pruned` を引き継ぐ。件数が 1 以上なら、バッチを送らなくても state を書く
4. 状態の読み取り
   - `readState` は今の軽い数え方のまま。各ディレクトリは ENOENT なら 0、それ以外の失敗は `null` とエラーコード。null を数値比較や表示に流さない。SessionStart の `captureNotice` は spool が読めないときだけ「キューが読めない」の通知を足し、それ以外は変えない
   - doctor 専用の `queueReport()` を足す: spool 直下・`calls/`・`rejected/`・`unregistered/`・`calls/rejected/` のそれぞれで、読めるか、`.` で始まる `.json`（`.lock` を除く）のうち 60 秒より古いものの件数・最古の経過時間・合計バイト（警告だけ。削除しない）、`rejected/` の理由ごとの件数（理由ファイルの無いものは `unknown`）、`unregistered/` のプロジェクトキーごとの件数と最古の経過時間、`calls/` の件数、`calls/rejected/` の理由ごとの件数、state の `pruned`
5. doctor（`server/src/cli.ts`）
   - Recording 欄に queueReport を出す。読めないディレクトリがあれば fail、一時ファイル・拒否・送れなかった観測があれば warn。外から来た文字列（プロジェクトキー、エラーコード）は `plain()` を通す
   - DB が使えるとき、新しい欄で結べない record ツールの呼び出しを、view の 711-713 行と同じ条件で数える: claude-code（tool_use_id があり観測が無い）、codex（caller_session が null）、すべてのホスト（host が null）を別の行にし、プロジェクトごとに件数と最初の `called_at` を「この時刻以降の <ホスト> の返事は AI の判断として採用されない」と出す。claude-code の行は、`calls/` に同じ tool_use_id のファイルがあるものを「送り直し待ち」、無いものと tool_use_id が null のものを「送り直せない」に分ける
   - 「送れなかった観測のファイル N 件（理由ごと、`calls/rejected/`）」は別の行にし、そこから呼び出しが結べないとは書かない
6. 文書: README.md・README.ja.md の制限の行を、送り直しで戻る場合（turn が分かるときだけ別ターンが戻る）と戻らない場合（hook が動かない・tool use id が無い・導入前・送れなかったファイル）に直す。保存済みの候補は上がらないことも書く。knowledge-schema の Skill（実体は `.agents/skills/knowledge-schema/`）の該当箇所も同じ変更で直す
7. 版: 版を触る前に `bun run release:plan -- --base v0.6.33` を流し、`plugin` なら `plugin/package.json` と 3 つの manifest（`scripts/release-plan.mjs:29` の 4 ファイル）を同じ版に上げる

## 採った案と棄却した案

- 採用: hook が観測を `calls/` に先に置き、直接の書き込みが通れば消す。棄却: 直接の書き込みが失敗したときだけファイルに書く（host が 10 秒で殺すと何も残らない）
- 採用: 先置きの失敗は握りつぶして直接の書き込みへ進む。棄却: 先置きの失敗で止める（今なら観測できる呼び出しまで観測できなくなる）
- 採用: 観測は専用の `spool/calls/` に別の形で置く。棄却: Spooled に kind を足して spool 直下に置く（0.6.33 の flush が project 無しとして rejected に移す）
- 採用: commit の後にファイルを消し、BATCH ずつ `late()` で打ち切る。棄却: insert ごとに消す（後の失敗の rollback で送り直し元を失う）
- 採用: 拒否の理由は隣の `.reason` ファイル。棄却: ファイル名に理由を埋める（「戻せば再送」の手順が崩れる）
- 採用: 観測の拒否は `calls/rejected/` に分ける。棄却: 共有の `rejected/` に入れる（SessionStart が spool 直下へ戻せと案内し、そこでは project 無しで再び拒まれる）
- 採用: readState は軽いまま、詳しい集計は doctor 専用の queueReport。棄却: readState に全部入れる（SessionStart が毎回最大 1000 件の本文を読む）
- 採用: `calls/` は自動で prune しない。棄却: 期限で消す（送り直し元を失い止めが永久に残る）
- 採用: 推し量りで止めを外さない（持ち主の決定）

## 手順

- S1: Observation の形と検査、hook の先置き・直接の書き込み・後消し
- S2: flush の `calls/` の送信（BATCH・commit 後の削除・1 件ずつの入れ直し・`calls/rejected/`）
- S3: 通常のキューの拒否の理由ファイル、prune の件数と state の引き継ぎ
- S4: readState の読めない状態と SessionStart の通知、doctor 専用の queueReport
- S5: doctor の Recording 欄と、結べない呼び出しの欄
- S6: 梱包した hook の検査（check-hooks-live.mjs）と Windows の tarball step の doctor の検査
- S7: README 両言語・knowledge-schema の Skill・版

## 完了条件

- A1: `bun run verify` → 終了コード 0
- A2: `cd server && node --test --test-name-pattern 'observation' test/capture.test.ts` → pass。ロックを持った DB で hook を流すと `calls/` にファイルが残り、flush の後に観測の行が入りファイルが消える。unit_adoption の insert が、再送前は別ターンの返事も拒否、再送後は別ターンの返事が通り、呼び出しのターンの返事は拒否のまま。同じ観測の重複の再送で行が変わらない。未結合がもう 1 件残ると別ターンも拒否のまま。拡張年の at（`+010000-01-01T00:00:00.000Z`、`-000001-01-01T00:00:00.000Z`）は `calls/rejected/` に `shape` で移り、同じバッチの正常な観測は入る
- A3: `cd server && node --test --test-name-pattern 'observation' test/capture.test.ts` → pass。callSession が再送前は null・再送後は観測のセッションを返し、trace_pending の auto は再送前に何もしない
- A4: `cd server && node --test test/cli.test.ts` → pass。一時 HOME で doctor を子プロセスで流し、読めないキュー（SPHICA_HOME をファイルにする）で Recording が unknown・fail、古い一時ファイル・理由ごとの拒否・保留のプロジェクト別・prune の件数・送り直し待ち・送れなかった観測のファイル・結べない呼び出しの各行が出る
- A5: `node scripts/check-hooks-live.mjs` → pass。record 用 PreToolUse の hook がロックを持った DB で hooks.json の timeout 以内に終わり、`calls/` にファイルを残し、`capture.js --flush` の後に観測の行が入る
- A6: `gh pr checks <PR>` → 全 job pass。Windows の job のログに、上の hook の検査の pass と、SPHICA_HOME をファイルにした doctor の Recording の unknown が出る
- A7: `cd plugin && npm pack` を外で展開し `node <展開先>/package/dist/cli.js --help` → 終了コード 0。中身の数が 0.6.33 の tarball と同じ
- A8: `bun run release:plan -- --base v0.6.33` → kind が `plugin`。4 つの版のファイルが同じ版を持つ

## リスク

- Windows で hook の追加のファイル操作が遅く 10 秒を超える → A5・A6 で測る。超えたら先置きを直接の書き込みの失敗の後だけに戻す案を Codex と再検討し、plan を直す
- 書き込み途中の正常な一時ファイルを古いと数える → 60 秒より古いものだけ数え、警告にとどめて消さない
- `calls/` のファイルが書き換えられると止めが外れ得る → spool は DB と同じ持ち主だけが書ける場所で、DB を直接書けるのと同じ信頼。新しい境界は作らない
- 0.6.33 と新しい版の hook が並んで動く → 旧 flush は `calls/` を読まないので、新しい flush が来るまで残るだけ

## 未解決

なし

## 変更履歴
