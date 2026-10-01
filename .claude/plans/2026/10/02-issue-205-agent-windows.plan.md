---
kind: plan
status: approved
codex_session: 01a0f80d-adbd-7b90-9112-812fb50ce34c
codex_rounds: 3
approved_at: 2026-10-02
---

# #205 後半: 読む前の配信の「表示済み」と予算を、compaction の区切り・エージェントごと・並行の読み込みで正しく数える

## 要点

- 親の compaction と /clear の後は、読む前の配信の表示済みと予算を数え直す（SessionStart の source を delivery.reason に残し、`compact`・`clear` を区切りにする。schema の event は変えない）
- サブエージェントの配信は (session, agent_id) ごとに数える。親の予算を使い切らず、親の表示済みにもしない。schema revision 6 で `delivery.agent_id` を足し、既存の `capture_delivery` は変えずに新しいビュー `capture_delivery_scoped` を足す
- SubagentStart（Claude・Codex の両方）で、サブエージェントにセッション開始の一式と「方針を決める前に Sphica を検索する」1 行を渡す
- 並行して読んだときの重複と予算超過を直す: pre_read とセッション開始は、capture の書き込みロックを取ってから reader で計画し、ログを書いてから返す（実ログで Codex の重複 29 件を確認）
- PostToolBatch の実験は採らない（重複は Codex だけで起きていて、Codex には PostToolBatch が無い）。#205 に計測と一緒に書く
- 変えないもの: 配信の上限（LIMITS・READ_SESSION）、pre_edit・prompt・review の順序（計画してからログ）、接続の役割の種類、event の値の集合。0.6.17 として出す

## 持ち主の決定

- #205 の残り（compaction、サブエージェント、PostToolBatch の実験）をこの計画でやる（2026-10-02「#205やろう」）
- #205 を前半と後半の 2 つの PR に分けた（前半は PR #242 / 0.6.16）
- epic #200 の方針: 修正は直す前のコードで落ちるテストを付ける。修正でない挙動の変更は実験として扱う

## 目的

- 親で compaction か /clear が起きた後、それ以前に出した記録を、次にそのファイルを読んだときにもう一度出せる。読む前の予算もそこから数え直す
- サブエージェントが読んでも親の予算が減らず、親の表示済みにもならない。サブエージェントは自分が読むファイルに紐付く記録を、自分の予算の中で受け取る
- サブエージェントの開始時に、作業中の件と広い constraint、それに Sphica を検索する 1 行が届く
- 同じセッション・同じエージェントで並行して読んでも、同じ記録が 2 回出ず、予算（件数・文字数）を超えない。ただしログを書けずに返した配信は保証の外

## 対象外

- サブエージェントの compaction の後の区切り直し（両ホスト）: SubagentStart は compaction・再開・新しいメッセージを区別する欄を持たない。Codex の子の PostCompact も一緒に後に回す。既知の穴として残す
- compaction の後に、それまで出した記録の key を並べる一覧: 効果を測る手段が無く、compaction のたびに文字数を使う。後で実験にできる
- PostToolBatch への移行（不採用。理由は「前提」）
- #203 の残り（delivery の保持期間、project の key の正規化）、#236
- review の配信の順序（git を走らせるので、ロックを握ったまま計画しない）

## 前提

- `beforeRead`（server/src/deliver.ts:240-295）は、表示済みの unit と読む前の予算（READ_SESSION、49）を delivery.session_id だけでセッション全体から数える
- SessionStart は source によらず atStart を流し、`resume` だけ、すでに session_start を出していれば飛ばす（deliver.ts:706-715）。session_start の plan.reason は null
- ログは計画の後に別の capture 接続で書き（deliver.ts:601-640、745-754）、どんな失敗でも本文を返す
- Claude Code（https://code.claude.com/docs/en/hooks 、2026-10-02）
  - SessionStart の source は startup・resume・clear・compact・fork
  - サブエージェントの中では、どのフックの入力にも `agent_id` と `agent_type` が付く
  - SubagentStart は `hookSpecificOutput.additionalContext` をサブエージェントの文脈に足せる。compaction の後と、サブエージェントの実行中に中断した会話を再開したときにも、もう一度走る。どの理由で走ったかを示す欄は無い
  - PreCompact と PostCompact はメインの会話でだけ走り、agent_id を持たない
- 再開したサブエージェントは会話の履歴をそのまま持ち、同じ agent ID を使う（https://code.claude.com/docs/en/sub-agents 、2026-10-02）
- Codex（https://learn.chatgpt.com/docs/hooks 、2026-10-02）
  - SessionStart の source に compact がある
  - SubagentStart は親の session_id と agent_id・agent_type を受け取る。PostToolBatch は無い
  - サブエージェントの中の PreToolUse も agent_id と agent_type を送る（openai/codex 57ac6f5 の codex-rs/core/src/hook_runtime.rs:196-207 と codex-rs/hooks/src/events/pre_tool_use.rs:175-189。Codex が読んだ）。入っている Codex のバージョンに含まれるかは未検証で、実装の中で確かめる
  - 子の compact は SessionStart ではなく、子の情報を付けた PostCompact に回る（hook_runtime.rs:135-153、581-599）
- 持ち主の実ログ（~/.sphica/sphica.db を読み取り専用で集計、2026-09-27〜10-01）
  - 出した pre_read は 940 件（claude-code 275、codex 665）
  - 同じセッションで同じ unit を 2 回出した組は 29 件で、すべて codex、どれも 2 秒以内
  - 並行の呼び出しが原因というのは推測。tool_use_id も agent_id も残っていないので確定できない
- capture の書き込み
  - 書き込みは capture のビューへの insert だけ（server/src/db-write.ts:56 の CAPTURE_VIEWS、59 の TRIGGER_WRITES、68 の TRIGGER_FUNCTIONS）
  - knowledge-schema スキルは、revision をまたいで capture のビューの列を変えないことを求める。server/test/migrate.test.ts:232 が列を比べている
- SQLite は `begin immediate` で書き手を 1 つにし、その後に始めた読み取りは、それより前にコミットされた行を見る（https://sqlite.org/isolation.html）。node:sqlite の呼び出しは同期なので（server/src/kysely-node-sqlite.ts:25）、並行の検査は子プロセスでやる
- 配線の検査は scripts/check-ai-config.mjs:288 にある（Codex の配信のイベントを見る）。今は SubagentStart を見ていない

## 方針

- schema revision 6（knowledge-schema スキルの手順どおり）
  - `delivery` に `agent_id text`（null 可、null はメインの会話）。末尾に足すので、作り直しは要らない見込み。作り直しが要るなら、カウンタの扱いもスキルの手順どおり
  - `capture_delivery` と、その trigger の列と挙動は変えない（agent_id は null で入る）
  - 新しいビュー `capture_delivery_scoped` を足す。列は capture_delivery の列に agent_id を加えたもの。insert の trigger `capture_delivery_scoped_insert` は capture_delivery_insert と同じ検査をして、agent_id も書く
  - db-write.ts: CAPTURE_VIEWS、TRIGGER_WRITES、TRIGGER_FUNCTIONS に新しいビューの分を足す
  - `db/migrations/0006.sql`、`server/test/fixtures/schema-rev5.sql`、`bun run codegen`
  - migrate.test.ts で、rev 5 の delivery・delivery_unit の行が残ることと、古いビューの列が変わらないことを見る
- 区切り（窓）
  - 親の SessionStart は、ログに `reason = source`（startup、resume、clear、compact、fork のどれか。無ければ null）を書く
  - 親の窓は、同じ session・agent_id が null の行のうち、reason が `compact` か `clear` の session_start の最新の行より後（id で比べる）の配信だけを数える。outcome は問わない。atStart の本文が空でも、区切りの行は書く
  - サブエージェントの窓は、その agent_id の全期間。SubagentStart では区切らない
  - 表示済みの unit と、件数・文字数の予算の 3 つを、同じ窓で数える
  - 区切りの行を書けなかったら（ロック中など）、窓は区切られない。best effort としてコードのコメントに書く
- agent_id
  - 入力の `agent_id` を、どの event のログにも付ける（サブエージェントの Edit の配信が、親の後の Read を止めない）
  - 書くのは capture_delivery_scoped を通して。親の resume の判定（deliver.ts:706）は `agent_id is null` に絞る
- SubagentStart
  - 両ホストの hook ファイル（plugin/hooks/hooks.json、plugin/hooks/codex.json。Codex は commandWindows も）で、SubagentStart を deliver.js に繋ぐ
  - deliver() は SubagentStart を event `session_start`・reason `subagent`・agent_id 付きでログに書く。出力の hookEventName は `SubagentStart` のまま
  - 本文は atStart の一式に、固定の 1 行「Before choosing an approach, search Sphica's past records for it.」を足す。持ち主向けの「trace を待つセッション」の行は出さない
  - 走るたびに本文を返す（親の resume のような「もう出した」での省略はしない）。子の compaction の後に戻るのはこれだけで、再開で重なっても 1 回 1000 字ほど
- ロックしてから計画する（pre_read と、session_start・SubagentStart）
  - 入力の検査と identify() はトランザクションの外
  - capture 接続を開いて `begin immediate`（待ち時間 LOG_WAIT_MS = 250ms）を取り、取れてから reader 接続を開いて計画し、capture_session と capture_delivery_scoped の insert を同じトランザクションで書いてコミットし、本文を返す
  - 空の pre_read は何も書かずにロールバックする
  - 失敗の扱い（C15）
    - capture 側の失敗（開けない、ロックが取れない、ロックを取る前のどんな失敗も）: ロックなしで reader で計画し、ログなしで本文を返す（並行の保証の外）
    - 計画が済んだ後の insert・コミットの失敗: ロールバックし、その計画の本文を返す
    - reader・schema・計画の失敗: 今の unavailable の扱い
    - fallback に移る前に、トランザクションと接続の後片付けを終える
  - pre_edit・prompt・review は今のまま（計画してからログ）
- テスト
  - 単体（server/test/deliver.test.ts、一時 DB）
    - 親の compact・clear で窓が区切られ、startup・resume・fork では区切られない
    - 区切りの行は本文が空でも書かれる
    - 子 A・子 B・親の予算と表示済みが別々に数えられる
    - 子の Edit が親の Read を止めない
    - 子が同じ agent_id で再び SubagentStart を受けても、窓が区切られない
    - SubagentStart の本文と hookEventName
    - BUSY 以外のログの失敗（capture の authorizer の拒否など）で本文が返り、delivery にも session にも途中の行が残らない
  - 並行（子プロセス）: 1 つの一時 DB・同じセッション・同じエージェントで deliver.ts を N 個同時に起動し、返った key と記録された予算を見る
    - 3 つの場合を分ける: 同じ unit が重なる / 別々の unit で件数の上限 / 別々の unit で文字数の上限
    - 全員がロックを取れる条件で流し、時間切れの fallback は別のテストで見る
  - 権限（server/test/db.test.ts）: capture の役が capture_delivery_scoped に agent_id が null の行と null でない行を insert でき、delivery へ直接は書けない
  - 受け入れ（server/evals/acceptance/driver.ts と cases.json）
    - driver に、呼び出しごとの host・agent_id、event の対応（SubagentStart、source 付きの SessionStart）、呼び出しごとの否定の期待を足す
    - ケース: 親 → 子 A → 子 B → 親 / 予算を使い切る → compact → 読む / clear → 読む / 子の開始の後の親の resume / 子の再開で同じ記録が繰り返されない / Codex の Bash の入力 1 件
    - server/test/acceptance-cases.test.ts の件数を直す
  - 配線と同梱物
    - check-ai-config に SubagentStart の配線（両ホスト、Codex の commandWindows）の検査を足す
    - scripts/check-tarball.mjs に、展開した deliver.js が SubagentStart の入力に hookEventName `SubagentStart` で答える検査を足す。ロック中に 1 秒未満で返る既存の検査は残す
- 計測の書き方（#205 への記録）
  - 過去の 29 件は推測として書く
  - 直した後の重複は host・session・agent・窓・unit ごとに数え、予算の超過は別に数える。ログなしの配信は DB に残らないので、別に扱う
- PostToolBatch: 実験はしない。#205 に、上の実ログの数（Claude 275 件で重複 0、重複 29 件はすべて Codex で、Codex には PostToolBatch が無い）と「金の記録の基準は比べていない」を書いて、不採用とする
- リリース: `bun run release:plan` が plugin と言えば、plugin/package.json と 3 つの manifest を 0.6.17 に揃える。migration があるので plugin-release スキルの移行の手順に従う

## 採った案と棄却した案

- 採用: SessionStart の source を delivery.reason に残し、compact・clear を区切りにする。棄却: event に `compact` を足す（CHECK の変更が要り、reason で足りる）
- 採用: revision 6 で delivery.agent_id を足す。棄却: サブエージェントごとに session 行を作る（session は記録した会話を表し、trace 待ちの数が狂う）。棄却: agent_id を reason や path に詰める（列の意味が崩れる）
- 採用: 新しいビュー capture_delivery_scoped。棄却: capture_delivery に列を足す（revision をまたいで capture のビューの列を変えない約束と migrate.test.ts の比較に反する）
- 採用: ロックを取ってから計画し、ログを書いてから返す。棄却: trigger で重複を拒んで 1 回だけ計画し直す（その間に別の配信がコミットされると防げず、予算の超過も止まらない）。棄却: tmp に session ごとのロックファイル（古いロックの扱いが要る）。棄却: 直さない（実ログで重複を確認した）
- 採用: ロックは pre_read と開始の event だけ。棄却: すべての event（review は git を走らせるので、ロックを長く握る）
- 採用: サブエージェントの窓は agent_id の全期間。棄却: SubagentStart のたびに区切る（文脈が残った再開でも同じ記録が出て、予算が戻る）
- 採用: compaction の後に key の一覧を出さない（回復できる範囲を、紐付いた decision・constraint と開始の一式に絞って書く）。棄却: key だけの一覧（効果を測れず、compaction のたびに文字数を使う）
- 採用: PostToolBatch は実ログを根拠に不採用。棄却: 実験する（重複が起きているのは Codex で、Codex には PostToolBatch が無い）
- 採用: Codex の子の PostCompact は、Claude の子の compaction と一緒に後に回す。棄却: 今回 Codex だけ対応する（両ホストで扱いが揃わず、Claude 側には使える合図が無い）

## 手順

- S1: schema revision 6（delivery.agent_id、capture_delivery_scoped、migration、fixture、codegen、authorizer、権限と移行のテスト）
- S2: agent_id をすべての配信のログに付け、表示済みと予算を (session, agent_id) と窓で数える。親の SessionStart は reason に source を書き、compact・clear で区切る
- S3: pre_read と開始の event を、ロックを取ってから計画する形にし、失敗の扱いを C15 のとおりにする（子プロセスの並行テストを含む）
- S4: SubagentStart の配信（deliver.ts、両ホストの hook ファイル、check-ai-config、check-tarball）
- S5: 受け入れの driver の拡張とケースの追加
- S6: release:plan を流し、0.6.17 に揃える

## 完了条件

- A1: `bun run verify` → exit 0
- A2: `rg -n "red 実測" .claude/plans/2026/10/02-issue-205-agent-windows.tasks.md` → 修正のタスク（compaction の窓、サブエージェントの予算、並行の重複）それぞれに、直す前のコードで意図どおり落ちた記録がある
- A3: `bun run bundle && npm pack` の tarball に対して `node scripts/check-tarball.mjs <tgz>` → exit 0。SubagentStart の検査と、ロック中に 1 秒未満で返る既存の検査を含む
- A4: `rg -n "SubagentStart" plugin/hooks/hooks.json plugin/hooks/codex.json` → 両方に deliver.js への配線がある
- A5: `SPHICA_DB=<rev 5 の DB のコピー> node <展開した tarball>/dist/cli.js init && SPHICA_DB=<同じ> node <展開した tarball>/dist/cli.js doctor` → revision 6 に上がり、doctor が exit 0（plugin-release スキルの移行の確認の手順。HOME は一時ディレクトリ）
- A6: `bun run release:status` → plugin/package.json と 3 つの manifest が 0.6.17 で揃う（リリース前は release:plan の出力とバージョンの一致）
- A7: `gh pr checks <PR 番号>` → PR head の全ジョブが pass

## リスク

- revision を上げるので、更新した持ち主が `sphica init` を流すまで配信は unavailable になる（セッションごとに 1 回） → 0.6.15 と同じ移行の案内に従う。リリースノートに書く
- ロックを握ったまま計画するので、capture のバッチや record の保存と競ると、ログなしの配信が増える → 250ms は前半で決めた値のまま。増えれば、計画の時間を測ってから見直す
- 入っている Codex が、子の PreToolUse に agent_id を送らないバージョンかもしれない → その場合、子の読み込みは今までどおり親の分として数える。実装の中で入っている Codex で確かめ、記録節に残す
- SubagentStart の本文が、サブエージェントが多いと文脈を使う → 1 回 1000 字ほど。目立てば、本文を絞る実験を別に立てる

## 未解決

なし

## 変更履歴
