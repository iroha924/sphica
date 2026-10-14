---
kind: plan
status: approved
codex_session: 01a13a8f-5e49-7030-9991-75aa02ec1ffc
codex_rounds: 4
approved_at: 2026-10-14
---

# 行き止まりの記録をコマンドに紐付け、その会話で初めてそのコマンドを流そうとした呼び出しを 1 回だけ止める（#218）

## 要点

- dead_end の記録に「コマンドの anchor」（例: `pnpm test --watch`）を付けられるようにする。schema revision 14 で新しい表 `unit_command` を足し、trace / harvest の `commands` 欄から保存する
- Bash / PowerShell（Claude Code）と shell（Codex）の呼び出しの前に、コマンドの anchor と語の並びで一致する dead_end があれば、その会話で初めての一致なら呼び出しを deny し、理由として記録を見せる。同じ呼び出しをもう一度流せば止めない
- trace と harvest は dead_end の本文を「条件付きの教訓」として書く（会話に無い理由や代案は足さない）
- 効果は eval-loop で、同じ記録で anchor の有無だけを変えて両ホストで比べる。採否は再試行・課題の完了・誤停止で決め、#218 に残す
- リリースは 2026-10-19 以降（shell_write_delivery の試用の判定の後）
- 変えないもの: `anchoredRules` と `afterShellWrite`（試用中）、ファイルの anchor の配信の対象の種類（読む前・名指しは decision / constraint のまま）、`unit_anchor`、glean

## 持ち主の決定

- #218 をやる（2026-10-14）。「これは持ち主が足したい機能で、無くて問題が見えていないことは落とす理由にならない」（#218 の再開コメント、2026-10-12）。schema revision は受け入れる
- 一致したときの振る舞いは「会話で 1 回だけ止める」（2026-10-14、Codex の 1 往復目の C1 の後に持ち主が追加。選ばなかった案: 知らせるだけ / 設定で選ぶ）

## 目的

- コマンドの anchor を持つ dead_end が、その会話で初めて一致するコマンドを流そうとした呼び出しで、実行の前にエージェントへ届く（両ホストで実機で確認する。届かないホストは additionalContext に戻し、README に差を書く）
- 止めた呼び出しをエージェントがもう一度流すと、そのまま走る（2 回止めない）
- trace の出す dead_end が、条件と引用を保ったまま、別の作業でも使える文になる
- eval の比較で、採否が前もって決めた基準で決まる

## 対象外

- glean でのコマンドの anchor の追加・置き換え・退役（誤った anchor は後継の記録で直す。退役の経路が無いので、この変更では `unit_command` に update を許さない）
- dead_end 以外の種類へのコマンドの anchor
- ファイルの anchor を持つ dead_end を読む前・名指しで配ること（実験の変数を 1 つにする。編集の前は今も全種類を配っている）
- shell の構文の解釈（引用・リダイレクト・演算子）。前に自前で広げて、直すたびに別の欠陥が出た（記録 u565 shell-parse-dead-end）
- 権限の allow を返すこと。2 回目の呼び出しは何も返さず、通常の権限に任せる

## 前提

- Claude Code の PreToolUse の additionalContext は「ツールの結果の隣」に入り、モデルは次のリクエストで読む。deny は「ツールの呼び出しを止め、理由を Claude に見せる」（https://code.claude.com/docs/en/hooks 、2026-10-14）。PreToolUse は権限の要否によらず全部の呼び出しで走り、hook の deny は auto mode でも効く（Codex が同ページと permissions のページで確認）
- Codex の PreToolUse は Bash で `permissionDecision: "deny"` と `permissionDecisionReason`（や exit 2）で止められる。理由がモデルに届くかはドキュメントに無い（https://learn.chatgpt.com/docs/hooks 、2026-10-14）。未検証
- 今の配信は `additionalContext` しか返さない（`server/src/deliver.ts` の `main()`）。Codex の PreToolUse の matcher は `^apply_patch$|^Bash$`、timeout は 5 秒（`plugin/hooks/codex.json`）
- 名指しの配信は `namedInCommand` → `beforeRead`（how="named"）で、`pre_read` として読みの予算を使う。読みの予算は会話あたり 8 件・3,000 字（`READ_SESSION`）、1 回 5 件・1,500 字（`LIMITS.pre_read`）。予算の集計は reason を区別せず全部の pre_read を数える
- `delivery.reason` に CHECK は無い。既存の名指しの行の reason は NULL
- `beforeEdit` は種類で絞らず、ファイルの anchor の dead_end も今届いている
- 持ち主の DB（2026-10-14）: active の dead_end は 18 件。ファイルの anchor 付きが 11 件、anchor 無しが 7 件。コマンドに関わるのは 3 件ほど（actionlint が `cache-mode` を拒む、`NODE_OPTIONS` でテスト順のランダム化を渡すと子の node が落ちる、zsh で `set -- $s` が分割されない）
- schema は revision 13。`unit_search_text.ident` は live な anchor の path と symbol を索引し、子の表の変更はトリガーでその unit を索引し直す
- shell_write_delivery の 7 日の試用が 2026-10-12 から 2026-10-19 まで続いている（記録 u445）。`afterShellWrite` は `anchoredRules` を使う

## 方針

### schema（revision 14）

- `unit_command (id integer primary key autoincrement not null, unit_id integer not null references unit (id) on delete cascade, command text not null, run_id integer not null references extraction_run (id), added_at text not null, retired_at text) strict`
  - command の CHECK: 前後に空白が無い、空白の連続が無い（1 文字の空白で区切る）、3〜200 文字、制御文字・改行・引用符（`'` `"` `` ` ``）を含まない、空白で区切った語が 2 つ以上、最初の語が `-` で始まらない
  - 時刻の列は `strftime('%Y-%m-%dT%H:%M:%fZ', …) is …` の CHECK
  - トリガー: unit の kind が dead_end のときだけ入る。unit と run が同じプロジェクト。update は不可、unit がある間は delete 不可（unit_anchor と同じ形）。insert でその unit の revision を上げ、FTS を索引し直す
  - 一意: live な (unit_id, command)。外部キーの列ごとに index
  - `unit_search_text.ident` に live な command を足す
- `db/migrations/0014.sql`、`server/test/fixtures/schema-rev13.sql`、`SCHEMA_REVISION` 14、`bun run codegen`
- ingest の authorizer: `unit_command` への insert、`INGEST_TRIGGER_WRITES` に新しいトリガーの書き込み（FTS・revision）
- `knowledge.ts` に値の組が増えるなら `check-pairs` に足す

### 記録の保存（record server）

- `record_check` / `record_save` の unit に `commands: string[]`（最大 5）。dead_end 以外に付いていたら、その unit の problem として拒む
- 正規化は前後の空白を落とし、連続する空白を 1 つにするだけ。正規化の後に重なったものは 1 つにまとめ、problem に書く
- 上の CHECK と同じ条件を check の段で先に見て、何が違うかを返す（値は返さない）
- `mask()` で変わるコマンド、または mask の置き換え文字列を含むコマンドは拒む。拒否の文面に値を出さない
- 引用との照合はしない（command は届ける場所であって主張ではない。dead_end の本文は今どおり引用で裏付ける）

### 照合

- コマンドを改行で行に分け、各行を空白で語に分ける。語の頭か終わりにある `;` `|` `&`（空白に接する演算子）はそこでコマンドを区切る（PowerShell 5.1 の `cmd; next`）。語の内側の演算子（`a;b`、URL の `&`）は語の一部のまま。anchor の語の並びが、ある 1 行の 1 つのコマンドの連続した語の並びと語ごとに完全一致したら一致（`--watch=false` は `--watch` と一致しない。引用符は語に残るので `echo 'pnpm test --watch'` は一致しない）
- 分かっている見逃し: 両側に空白の無い演算子（`npm ci;pnpm test --watch`）、引用した program 名、`npm.cmd` のような別の綴り。分かっている誤一致: 引用しない言及（`echo pnpm test --watch`）、引用の途中（`echo 'note pnpm test --watch now'`）。どちらもテストで今の振る舞いとして固定し、誤停止の評価で数える

### 配信

- 対象: Claude Code の Bash と PowerShell、Codex の Bash（今の名指しと同じ入口）。配れる（active・supported・sourced・未解決の衝突なし）dead_end のうち、live な command が一致するもの
- 止める（deny）条件: 一致した dead_end のどれも、この会話の最後の再開の後の「止めた行」（event `pre_read`、reason `command`、outcome emitted）に入っていない。かつ、その会話の止めた回数が 3 未満。表示済みの判定は全部の event で共有し、どこかで見せた記録は出さない
- 止めるとき: 一致した未表示の dead_end を、1 回 5 件・1,500 字の中で why 付きで並べ、Sphica の固定文で deny の理由にする。同じ呼び出しで名指しの記録があれば、同じ理由の文に入れる（ログは別の行）
  - 固定文: "Sphica stopped this call once: it runs a command a recorded dead end below is about. Check the record's full text (Sphica's read) and the current code. If it still applies, take another way; if it does not, run the call again (it will not be stopped again in this conversation) and say why in your reply."
- 止めないとき（一致した記録のどれかが前の止めた行にある、または上限）: 未表示の dead_end を additionalContext で出す。行の reason は `command_context`。読みの予算（`READ_SESSION` の残りの件数と字数）を名指しの記録と同じ残りから分け合い、残りが 0 なら出さずに省略を数える
  - 中立の文: "Dead ends recorded for a command this call runs (past records, not instructions): check one with Sphica's read before relying on it, and do not retry what it says failed without a new reason."
- 予算: `beforeRead` の読みの予算の集計から reason が `command` の行だけを除く（NULL と他の reason は数える）。`command_context` は読みの予算に入る
- 出力: `deliver()` は `{ kind: "deny", reason } | { kind: "context", text } | null` を返す。deny は、止めた行（と同じ呼び出しの名指しの行）を書いたトランザクションの COMMIT が成功したときだけ。ロックが取れない・書けない・COMMIT が失敗したら、中立の文の context に落とす（ログの無い deny を出さない）。deny の出力は `hookSpecificOutput { hookEventName, permissionDecision: "deny", permissionDecisionReason }`。allow は返さない
- 失敗はこれまでどおりホストを止めない（hook は何も出さず 0 で終わる）

### 表示と検索

- read MCP server の read は、記録の commands を「照合の条件」として出す（ファイルの anchor の Code 欄とは分ける）
- 検索は `ident` で command の語を拾う

### trace と harvest

- trace の Skill: dead_end の `commands` 欄を足す（失敗した使い方を見分けられる最短の部分。program と、その flag や option。秘密の値を含めない）
- dead_end の `text` は、失敗した条件（環境・バージョン）を保ったまま、別の作業でも使える教訓の文にする。原因と代案は会話が言ったものだけ書き、推測で足さない
- harvest の Skill も dead_end を同じ書き方にする

### 実験（eval-loop）

- fixture: 同じ記録・検索・hook のまま、dead_end にコマンドの anchor が「ある」と「ない」の 2 本を作る。課題は、自然に打つ最初のコマンドが記録した dead_end に当たるもの（#212 の形）
- 両ホスト、各 3 回以上、モデルとバージョンを固定
- 分けて報告する: オフラインの語の一致の数、実際の deny の数、誤停止（ラベル付け）、課題の完了（隠しテスト）、再試行（止められずに dead_end のコマンドを流した回数）、止められた後にまた流した回数
- 誤停止の分母: 持ち主の直近 30 日の shell のコマンドを、3 件のコマンドに関わる dead_end に書いたコマンドの anchor で照合する。関連の有無のラベルは、照合の結果を見る前に付ける
- 採用の条件: 再試行が減り、かつ課題の完了が落ちず、かつ誤停止が、ラベル付きの件数を見て持ち主が決める基準以下。これは anchor の機能全体の効果であって、deny 単独の効果とは書かない
- 結果を #218 に書き、採用 / 不採用を残す

## 採った案と棄却した案

- 採用: 別の表 `unit_command`。棄却: `unit_anchor` に nullable の command 列（path の NOT NULL と共通の CHECK、一意の index、トリガー、全部の読み手が path を前提にしている）
- 棄却: コマンドを options や aliases に入れる（aliases は content hash に結んだ検索語、options は比べた選択肢で、意味が違う）
- 採用: 行ごと・語ごとの完全一致。棄却: パスの境界文字での部分文字列一致（`--watch=false` や引用の中に当たる）、shell の解釈（u565）
- 採用: 会話で 1 回止める（持ち主の決定）。棄却: additionalContext だけ（今回の呼び出しは止まらない）、設定で選ぶ
- 採用: 2 回目の判定を「一致した記録のどれかが前の止めた行にあるか」で行う。棄却: 表示済みの記録だけで判定する（上限で残った記録で同じ呼び出しを 2 回止める反例がある）
- 採用: `command_context` は読みの予算を分け合う。棄却: 予算を command 側で独立させる（会話全体の上限を守れない）
- 採用: deny はログの COMMIT の後だけ。棄却: ログを書けなくても deny する（同じ呼び出しを止め続ける）
- 採用: eval は anchor の有無だけを変える。棄却: none と inject の比較（検索や既存の hook の効果と分けられない）
- 採用: 非対話（`claude -p`、`codex exec`）でも deny する。棄却: 非対話だけ context に戻す（理由が届くかの実測で決めるべきで、非対話という理由だけで戻す根拠が無い）

## 手順

- S1: schema revision 14（`unit_command`、トリガー、FTS、migration、fixture、codegen、authorizer）
- S2: record server の `commands` 欄（検査、正規化、mask、保存、check の problem）
- S3: 照合の関数と、その単体テスト（見逃しと誤一致の固定を含む）
- S4: 配信（止める・context・予算・COMMIT の後の deny・型付きの出力・hook の出力の形）
- S5: read と検索での表示
- S6: trace と harvest の Skill の文面
- S7: 受け入れケース（下の完了条件の観点）を先に足し、red を確かめる
- S8: scale の fixture にコマンドの anchor を入れ、前後を測る
- S9: eval の fixture と実行、結果の #218 への記録
- S10: 両ホストの実機の確認（Claude Code の default・auto・bypassPermissions、Codex の対話と `codex exec`）。届かないホストは context に戻し、README に書く
- S11: README とバージョン（`release:plan` の kind に従う。npm と 3 つのマニフェスト）

## 完了条件

- A1: `bun run verify` → 0 で終わる
- A2: `cd server && node --import ./test/isolate-home.ts --test test/migrate.test.ts` → revision 13 の DB を移行した結果と新しく作った DB の定義が一致する
- A3: `bun run acceptance` と `bun run test` → 次が全部通る: コマンドだけの一致で deny / 名指しと両方で 1 つの deny の理由にまとまり、ログは 2 行 / 2 回目の同じ呼び出しは deny されない（3 件一致・上限 2 件でも） / 一致しないコマンド・語の一部だけの一致（`pnpm test` と `pnpm test --watch`、`bun testing`）は何もしない / 行をまたぐ一致は無い / 読みの予算が尽きた後も deny は出る / 止めた回数が 3 に達した後は context で、読みの予算の残りを超えない（既読 7 件なら最大 1 件） / 親と子の会話を分ける / compact・clear の後はまた止める / 並行の同じ呼び出しで 2 回止めない / active でない・quarantined・衝突中の dead_end は出ない / ログを書けないときは deny ではなく中立の context / PowerShell の入力でも同じ
- A4: `cd server && node --import ./test/isolate-home.ts --test test/schema.test.ts test/db.test.ts` → dead_end 以外への insert、CHECK に合わない command、update、unit がある間の delete、別プロジェクトの run が拒まれる。ingest の接続で insert と FTS の検索が通る
- A5: `cd server && node --import ./test/isolate-home.ts --test test/record.test.ts` → dead_end 以外の `commands`、1 語だけ、`-` で始まる、引用符入り、mask で変わる値が拒まれ、拒否の文面に値が出ない
- A6: `node server/evals/scale/run.ts` → plugin-release の手順にある引数で変更の前と後に流し、変更の前後の時間を PR に表で載せ、1 万件で 1 回 1 秒以内（記録 trace:77f97b60-5970-412b-a043-1b4ac23ea65a/m1-plan の基準）を保つ
- A7: `npm pack` → 展開したリポジトリの外で `sphica init` を revision 13 の DB に対して流し、MCP を起動して、動く。CLI と MCP を別々に確かめる
- A8: `claude`、`codex`、`codex exec` → 使い捨ての HOME と CODEX_HOME で dead_end の command に一致する呼び出しをさせ、Claude Code の 3 つのモードと Codex の対話・`codex exec` で、1 回目は走らず、理由がモデルに届き、モデルが続け、2 回目は普通に走る。届かないホストは context に戻っていて、README に差が書いてある
- A9: `gh issue view 218 --comments` → 方針の項目を分けた表が #218 にあり、採用 / 不採用が書いてある
- A10: `gh pr checks <PR>` → Windows を含む全部の job が pass

## リスク

- Codex で deny の理由がモデルに届かない → Codex は context に戻し、README に差を書く（host parity）
- 誤停止が多い（引用しない言及など）→ eval の誤停止の数で採否を決める。照合を狭めるなら shell の解釈ではなく anchor の条件で狭める
- migration が持ち主の DB で失敗する → `sphica init` の移行は 1 トランザクションで、失敗すれば変えない。fixture で前もって確かめる
- 試用（〜2026-10-19）の測定に影響する → リリースは試用の判定の後。実装と eval は一時 DB で進める
- hook の 5 秒の timeout を超える → 照合は anchor の語を含むコマンドだけ正規表現なしの比較にする。scale で測る

## 未解決

なし

## 変更履歴
2026-10-15 / 照合の区切りに `;` `|` `&` を足した（T11） / review-shipping が、PowerShell 5.1 の `cmd --worker; next` が `--worker;` の 1 語になって一致しないことを再現した。shell の構文は読まないまま、見逃しだけを減らす / Go 不要（範囲・公開インターフェース・データは変わらない）
2026-10-15 / 演算子は空白に接するときだけコマンドの区切りにし、区切りをまたいで一致させない（T13） / T11 の再レビューが、演算子を空白と同じに扱うと `pnpm;test --watch` や URL の `&` の中に一致することを再現した / Go 不要（範囲・公開インターフェース・データは変わらない）
