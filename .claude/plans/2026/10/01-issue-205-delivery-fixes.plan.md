---
kind: plan
status: approved
codex_session: 01a0f6db-4661-7730-924b-72ae168e1c81
codex_rounds: 3
approved_at: 2026-10-01
---

# #205 前半: 配信フックの再現済みの不具合 3 件を直し、退役した記録を自動配信しないことを固定する

## 要点

- 文脈の無い Read・Edit の配信で `nothing` 行（と session 行）を書かない。session_start・prompt・review の空ログは残す
- プロンプトに出た path を部分一致ではなく境界で照合する（`web/src/db.tsx` が `src/db.ts` の記録を出さない。`src/db.tsを直して` は出す）。区切りは `/` と `\` の混在も、root を含む絶対表記も当たる
- #178: 配信のログだけ短い busy_timeout（暫定 250ms）で書き、書けなければログなしで本文を返す。2 つの insert は 1 トランザクションにまとめる。保証は「WAL で通常の書き込みトランザクションが握られている間」に限る
- superseded と withdrawn の記録が、pre_edit・pre_read・prompt・session_start・review で出ないことを、イベントごとの受け入れケースと単体テストで固定する
- 展開した tarball の `dist/deliver.js` が、書き込みロック中でも 1 秒未満で目的の記録を返すことを check-tarball で見る
- 変えないもの: DB schema（revision 5）、配信の上限（LIMITS・READ_SESSION）、表示済みの数え方、接続の役割、reader の busy_timeout。0.6.16 として出す

## 持ち主の決定

- #205 を 2 つの PR に分け、今回は前半（再現済みの不具合と退役した記録の受け入れテスト）
- compaction、サブエージェント（agent_id）、PostToolBatch の実験、#190 は後の PR
- #236 の同梱可否は Codex との議論で決める（議論の結果、別の計画・PR にした）

## 目的

- 紐付けの無いファイルを何度読んでも・編集しても delivery 行が増えない
- プロンプトが別のファイル（`web/src/db.ts`、`src/db.ts.bak`）を名指ししたとき、似た path の記録が出ない
- 別の接続が `begin immediate` を握っている間も、配信フックが 1 秒未満で本文を返す
- 自動配信が superseded・withdrawn の記録を出さないことが、テストで固定されている

## 対象外

- #205 のうち compaction・サブエージェント・PostToolBatch の実験・#190（後の PR）
- #205 の「セッション開始ログの key 部分一致」: 220309b3（0.6.2）で直っている。issue に書いて閉じる側に回す
- #236（MCP 引数の strict）: 配信と依存が無く、両 MCP サーバーの公開入力を変えるのでレビューの面を分ける
- reader 接続の busy_timeout と、WAL の例外（exclusive locking・最後の接続の終了処理・復旧中）で reader が BUSY になる場合。今の unavailable の扱いのまま

## 前提

- `nothing` 行を読む所は無い: beforeRead（server/src/deliver.ts:242-259）と resume の判定（684-693）は `emitted` だけ。eval の server/evals/cloud/collect.ts:239・371 も `emitted` だけ。collect.ts:357 は inject の run で delivery 行が 1 行も無いと除外するが、session_start の行は残るので足りる
- プロンプトの path は deliver.ts:386 の `text.includes(x.path)`（部分一致）。onPrompt の `word()`（deliver.ts:353）は前に `/` が来ても通り、後ろに日本語が続くと当たらない（Codex が Node 24.15.0 で実測）
- 保存される path はバックスラッシュを含まない（db/schema.sql:506）が全角文字は含み得るので、path に NFKC をかけると別の path と取り違える
- #178: deliver.ts:721 の `await log(...)` が return の前。server/src/sqlite.ts:57 の `busy_timeout = 5000` と plugin/hooks/hooks.json の PreToolUse `timeout: 5` が同じ 5 秒。log の 2 つの insert（deliver.ts:595・599）は別々のコミットで、後段だけ失敗すると session 行だけ残る（Codex が実スキーマで実測）
- DB は WAL（server/src/admin.ts:50）。通常の書き込みトランザクションと reader は並行できるが、WAL の例外では reader も BUSY になる（https://sqlite.org/wal.html#sometimes_queries_return_sqlite_busy_in_wal_mode 、2026-10-01）
- busy_timeout の PRAGMA は authorizer の前に流す必要がある（sqlite.ts:47-50）
- ロックを握る書き手: record の保存は saveText（server/src/extract.ts:447）、capture のバッチは server/src/capture.ts:547（BATCH 500）。握る時間は入力の量による。未計測
- 受け入れテスト: cases.json の injection-12 は「唯一の採用を取り下げた決定は pre_edit で出ない」だけ。driver は pre_read を Read 入力で流す（server/evals/acceptance/driver.ts:160-170）。否定の検査は最初の配信だけを見る（driver.ts:1142）ので、イベントごとに独立したケースが要る。review は driver に無い
- check-tarball（scripts/check-tarball.mjs）は展開した tarball の配信フックを子プロセスで既に流しており、一時 DB への直接投入もある（88・95・101 行）。owner 接続でのテスト fixture は server/test/temp-db.ts:21 と同じ扱い

## 方針

- `nothing` 行: `deliver()` で、event が pre_read か pre_edit で `plan.text` が空なら `log()` を呼ばない。省略の案内だけの配信は text があるので今までどおり書く
- プロンプトの path の照合（onPrompt の anchor の path だけ。symbol と option は今のまま）
  - NFKC をかけない元のプロンプトと照合する
  - path を `/` で segment に分け、各 segment を正規表現用に escape し、`[\\/]` で結ぶ（区切りごとに `/` と `\` のどちらも当たる）
  - 相対表記には任意の `./` か `.\` の前置きを許す。root を含む絶対表記も同じ作りで照合する（root の区切りも `[\\/]`）。任意の末尾一致はしない
  - 前の境界: 先頭か、ASCII の `[A-Za-z0-9_$.\-/\\]` 以外の文字
  - 後ろの境界: 末尾か、ASCII の `[A-Za-z0-9_$\-/\\]` 以外の文字。ただし `.` の直後に `[A-Za-z0-9_$]` が続く場合は拒む
  - ASCII 以外の文字（日本語の地の文）が隣にあっても当たる。`~` `@` などの ASCII 記号は区切りとして扱う
  - コードのコメントでは「ASCII の英数字・`_$-./\` で続かない path の出現」と書き、「完全一致」とは書かない
- ログ（#178）
  - `connectWriter` に busy の待ち時間を渡せるようにし、`prepare()` の中（authorizer の前）で設定する。他の役と他の呼び出しは 5000ms のまま
  - `log()` は待ち時間 250ms（暫定）の capture 接続を開き、capture_session と capture_delivery の 2 つの insert を `inTransaction`（server/src/db.ts:53）でまとめる。失敗したら両方残らない
  - どんな失敗でも本文を返す（deliver.ts:730 の catch を維持）。BUSY かどうかで分岐しない
  - ロック中に書けなかった配信は、次の同じ path の Read でもう一度出る。これは仕様としてテストで固定する（deliver.ts:233 の best effort の説明に沿う）
  - 250ms は、saveText と capture のバッチがロックを握る時間を一時 DB で 1 回測り（入力の件数とサイズを tasks に残す）、それを参考に調整する。必須条件は A3
- 退役した記録のテスト
  - cases.json に、superseded と withdrawn それぞれについて pre_edit・pre_read・prompt（path の名指し）・prompt（option の名指し）・session_start（紐付けの無い constraint）の独立したケースを足す。各ケースで、同じ条件の active の記録が出る肯定確認を入れる。対象が本当に superseded／withdrawn で、他の除外条件（証拠・衝突）で落ちているのではないことを given で作り分ける
  - server/test/acceptance-cases.test.ts の injection の件数を直す
  - review は server/test/deliver.test.ts で同じことを見る
  - 今のコードで通る見込みの固定用のテストなので、red ではなく初回 green と tasks に記録する
- check-tarball
  - 展開した CLI の init で作った一時 DB に、run・証拠・採用を持ち unit_state を通して active にした記録と紐付けを入れる（lifecycle の直接書き換えや trigger 外しはしない。tokenizer を登録する）
  - ロック前に別の session_id で肯定確認し、別接続で `begin immediate` を握ったまま `dist/deliver.js` を Read 入力で起動する。起動から終了までが 1 秒未満で、additionalContext に目的の key が入ることを見る。ロックの解放は finally
- リリース: `bun run release:plan` が plugin と言えば、plugin/package.json と 3 つの manifest（plugin/.claude-plugin/plugin.json、plugin/.codex-plugin/plugin.json、.claude-plugin/marketplace.json）を 0.6.16 に揃える

## 採った案と棄却した案

- 採用: ログだけ短い busy_timeout で書き、失敗したら諦める。棄却: capture の spool へ書く（Stop で流すまで beforeRead から見えず、同じセッションで同じ記録が何度も出る）
- 棄却: 応答を先に stdout へ書いてからログを書く（ホストはプロセスの終了を待つので、5 秒で殺されれば同じ）
- 棄却: detached の子プロセスでログを書く（Windows の扱いと部品が増える）
- 採用: 2 つの insert を 1 トランザクションにまとめる。棄却: 今のまま別々のコミット（session 行だけ残る）
- 採用: ログの失敗は BUSY かどうかによらず同じ扱い。棄却: BUSY だけを諦める（本文への扱いが同じで分ける理由が無い）
- 採用: reader の busy_timeout は変えず、保証を通常の書き込みトランザクションに限る。棄却: 配信用 reader にも短い待ち時間（WAL の例外は今の unavailable の扱いで足りる）
- 採用: `nothing` 行は書かない。棄却: 集計して 1 行にまとめる（読む所が無い）
- 採用: path の境界を ASCII の文字集合で決める。棄却: `word()` の流用（前の `/` を通し、後ろの日本語で外れる）。棄却: 後ろの境界に `\p{L}` を入れる（`src/db.tsを` が外れる）
- 採用: #236 は別の計画・PR。棄却: 同梱（リリースは 1 回で済むが、配信と無関係な公開入力の変更がレビューの面に加わる）
- 採用: 250ms は暫定値として実測を参考に調整し、A3 を必須にする。棄却: 単発の実測の数倍で決める（入力の量で変わり、小さすぎるか 1 秒を超える）

## 手順

- S1: pre_read・pre_edit の空の配信でログを書かない（テストの期待の更新を含む）
- S2: プロンプトの path を境界と区切りの規則で照合する
- S3: ログを短い待ち時間の 1 トランザクションで書き、ロック中は本文だけ返す（connectWriter の待ち時間の引数、ロック時間の測定を含む）
- S4: superseded・withdrawn の記録を自動配信しない受け入れケースと review の単体テスト
- S5: check-tarball に、展開した deliver.js がロック中に 1 秒未満で目的の記録を返す検査を足す
- S6: release:plan を流し、0.6.16 に揃える
- S7: リリースの関門から GitHub の Codex の要約コメントと Security Review の判定を外し、未解決のレビュースレッド 0 だけを見る。CLAUDE.md の Review 節、plugin-release スキル、release:plan の案内を「CI は Claude、GitHub の Codex レビューは持ち主が見て指摘を共有する」に直す

## 完了条件

- A1: `bun run verify` → exit 0
- A2: `rg -n "red 実測|初回 green" .claude/plans/2026/10/01-issue-205-delivery-fixes.tasks.md` → S1〜S3 の各修正タスクに red 実測（直す前のコードで意図どおり落ちた）の行、S4 のタスクに初回 green の行がある
- A3: `bun run bundle && npm pack` の tarball に対して `node scripts/check-tarball.mjs <tgz>` → exit 0。ロック中の dist/deliver.js が 1 秒未満で、目的の key を含む additionalContext を返す検査を含む
- A4: `rg -n "text.includes\(x.path\)" server/src` → 0 件
- A5: `bun run release:status` → plugin/package.json と 3 つの manifest が 0.6.16 で揃う（リリース前は release:plan の出力と版の一致）
- A6: `gh pr checks <PR 番号>` → PR head の全ジョブが pass

## リスク

- 250ms でもログを書き損ねて、同じ記録が同じセッションで繰り返し出る → 測定を参考に値を上げる。上限は A3 の 1 秒未満
- WAL の例外（exclusive locking、最後の接続の終了処理、復旧中）では reader も待つので、1 秒の保証は効かない → 今回の保証の範囲外と明記し、配信は今の unavailable の扱い
- ASCII の境界なので、日本語の文字や `~` `@` などの記号が隣に付いた別名のファイル（`src/db.tsを` という実ファイル、`x@src/db.ts`）にも当たる → 誤表示として許す。目立てば後の PR で見直す
- `nothing` 行を消すと、eval で Codex の inject run の delivery 行が 0 行になり除外される → session_start の行が残るので起きない見込み。起きたら collect.ts の判定を直す

## 未解決

なし

## 変更履歴
- 2026-10-01 / S7 を足した / 持ち主が ChatGPT のプランを下げて Security Review と要約コメントが無くなり、関門が通らなくなった。持ち主の提案で、GitHub の Codex レビューは持ち主が見て指摘を共有し、Claude は CI を見る運用に変えた。過去の決定 release-gate-codex-review（ボットの要約を API で確かめる）を置き換える。関門には未解決スレッド 0 だけを残す（ボットの表示に依らず、resolve し忘れを止める） / Go 済み（持ち主が A を選び、運用の変更を提案した）
