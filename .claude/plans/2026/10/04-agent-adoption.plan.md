---
kind: plan
status: draft
codex_session: 01a105a3-d907-7280-9456-28cb1386932c
codex_rounds: 4
approved_at:
---

# AI が自分で決めた判断を「AI の判断」として採用・配信し、trace を持ち主の依頼なしに AI が回す（段階 1）

## 要点

- 採用の経路に `agent` を足す。AI の返事の中で AI が一人称で選んだ引用（新しい evidence の役 `decides`）だけが採用の根拠になる。採用の強さは「持ち主 > AI > なし」で、採用の履歴から都度出す
- 配信・read・search・record_context は記録ごとに「持ち主の判断」か「AI の判断」かを出す。AI の判断には「理由があれば離れてよい。返事でどの記録からなぜ離れたかを書く」という専用の文を付ける。持ち主の判断は今の CONFIRM のまま
- 持ち主の判断への link の効き目を権限で止める。持ち主の判断が配信から外れるのは持ち主が採用した相手と衝突したときだけで、後継の枠を使うのは採用された後継だけ（今の候補の記録が持ち主の判断を配信から消す穴もふさぐ）。段階 1 の AI は supersedes・撤回・衝突の解決をしない。AI の判断どうしの矛盾は conflicts で両方を止める
- trace は AI が自分で起動できる。新しい持ち主のセッションの開始時の通知で、今のセッション以外の未処理を古い順に最大 2 セッション、上限つきで処理する。Stop からは起動しない
- 呼び出し元（対話 / headless / SDK とターン）を record サーバーが判別できるかを最初に両ホストで測り、判別できないところでは AI の採用を止める。段階 2 の評価に使う「AI の判断として active になったことのある記録」の一覧を読み取り専用で出す
- README（両言語）・CLAUDE.md・AGENTS.md・knowledge-schema の Skill と、配布する review・export・rules の Skill を今の挙動に合わせる
- 変えないもの: 持ち主と maintainer の採用、承認の関門（npm-release、forget の件数確認）、接続の役割（capture に書き込みの口を 1 つ足すだけ）、Stop の capture。observation / assessment・新しい link・場面による想起・AI による撤回と衝突の自動解決はこの計画に入れない

## 持ち主の決定

- Sphica は基本的に人が介入しない。AI が人のように過去の記録と判断を参照できるのを目指す
- 後継の枠は、持ち主の判断かどうかで分けず、どの記録でも active になった後継だけが使う（T19 のレビューの後に持ち主が追加）
- 持ち主の判断を守る形は C′（候補の link は保存できるまま、効き目を権限で止める）にする。記録 u121 の「後継は 1 つまで」の数え方も変える（T04 の途中で持ち主が追加）
- 判断の種類を増やす方向は、Codex との議論で合意した分類（権限・根拠・当てはまる条件・見直す時・約束・次にすること・補う AI の弱点の 7 軸、kind observation と assessment、link depends_on / qualifies / evaluates / derived_from / paired_with、場面による想起）を全体像にする
- AI が自分で出した判断に限って、AI が採用・更新・撤回まで進めてよい。持ち主が決めた判断、公開の約束（CLI の出力・MCP の形・DB の形）、セキュリティと権限、リリースと forget は人に残す（「なるほどね、良いと思う」）
- 2 段階で進める。段階 1 は抽出の自動起動と、AI の判断を「AI が決めた」として記録・配信すること。段階 2 は段階 1 の判断の当たり具合を評価ループで見てから、AI による撤回と衝突の自動解決を足す

## 目的

- 持ち主が `/sphica:trace` を打たなくても、持ち主の新しいセッションで AI が未処理のセッションを trace し、記録が増える
- AI がセッションの中で自分で決めた判断（例: 「この関数は分けずにこのままにする」）が、AI の判断として active になり、次のセッションに「AI の判断」と分かる形で届く
- 持ち主の判断は、AI の経路でも候補の記録でも、置き換えられず配信からも消えない
- 段階 2 が、AI の判断として active になった記録を、その時点の本文と採用元つきで取り出せる

## 対象外

- AI による supersedes・撤回・衝突の解決: 段階 2（評価の後に入れると持ち主が決めた）
- 7 軸のうち権限以外、observation / assessment、新しい link、場面による想起: 全体像として合意済みで、別の計画
- harvest・glean の自動起動: 今回は trace だけ。glean の経路は権限の検査（S4）だけ合わせる
- AI の判断の評価の保存と採点: 段階 2
- headless・SDK のセッションによる trace と、AI の採用: 人のセッションの代わりに自動で動くものが採用を成立させないため（記録 u184）

## 前提

- 採用の経路は `owner_statement` と `explicit` だけで、`unit_adoption_route` のトリガーが source の書き手を確かめる（`db/schema.sql:372`、`:397`）。`server/src/record.ts:536` が経路を決める
- decision / constraint が active になるには、撤回されていない evidence と adoption があればよい（`db/schema.sql:564` の `unit_support`）。evidence の役と adoption の対応は見ていない
- 今のコードでは、候補の記録からの conflicts でも持ち主の active な記録が配信から外れ（`server/src/deliver.ts:89`）、候補からの supersedes が後継の枠をふさぐ（`db/schema.sql:815`）。Codex が現行の schema.sql をメモリ上の SQLite に載せて再現した（2026-10-04）
- AI の返事は capture で `author_kind = 'assistant'` の `session_message` になる。AskUserQuestion の質問も assistant として `:ask:<…>:q:<digest>` の id で入る（`server/src/capture.ts:506`、`:536`、`server/src/extract.ts:243`）
- `edit_observation` には session_id・turn_id・path がある（`db/schema.sql:199`）。`server/src/record.ts:578` の照合は session と path だけ
- trace の Skill は `disable-model-invocation: true`（`plugin/skills/trace/SKILL.md:5`）で、Codex 側は `plugin/skills/trace/agents/openai.yaml:2` の `allow_implicit_invocation: false`。`scripts/check-ai-config.mjs:443` が両ホストのずれを拒む
- 未処理の判定は持ち主の発言だけを見る（`server/src/trace.ts:16`）。開始時の通知は DB とプロジェクトごとに 1 日 1 回（`server/src/deliver.ts:488`）、resume では早く戻る（`:799`）
- Stop のあとの flush は、ロック中・予算切れ・エラーで終わらないことがある（`server/src/capture.ts:895`、`:927`、`:934`）
- Codex の Stop で処理を続けさせると、reason が新しい user prompt になる（https://learn.chatgpt.com/docs/hooks 、Codex が 2026-10-04 に確認）。capture は既知の形以外を持ち主の発言として保存する（`server/src/capture.ts:244`）
- record サーバーが今知っているのは作業場所だけで、呼び出し元のセッション・ターン・起動の形は持っていない（`server/src/project.ts:136`、`server/src/mcp-record.ts:47`、`db/schema.sql:221`）
- 関係する過去の判断: u26（持ち主の発言から覆しの承認を自動で判定しない）、u184（自動で動く SDK のエージェントに決定を成立させない）。どちらもこの計画と矛盾しない（持ち主の判断は AI の経路で覆らず、SDK は AI の採用からも外す）
- 実測（2026-10-04、probe の MCP サーバーで環境変数と各呼び出しの `_meta` を記録）:
  - Claude Code 2.1.289 の対話（動いている Sphica の record サーバー）: 環境変数に `CLAUDE_CODE_ENTRYPOINT=cli`・`CLAUDE_CODE_SESSION_ID`（今のセッション）
  - Claude Code の `claude -p`: 環境変数に `CLAUDE_CODE_ENTRYPOINT=sdk-cli`・`CLAUDE_CODE_SESSION_ID`。各呼び出しの `_meta` は `progressToken` と `claudecode/toolUseId` だけで、ターンは無い。親のプロセスから無関係な変数（親の `CLAUDE_PID`、ほかのプラグインのセッション id）も引き継ぐので、ホスト自身が置く変数以外は根拠にしない
  - 同じ `claude -p` に PreToolUse の hook（matcher `mcp__probe__.*`）を付けると、hook の入力に `session_id`・`prompt_id`・`tool_use_id`・`mcp_server` が入り、`tool_use_id` が MCP 側の `claudecode/toolUseId` と 3 回とも一致した（うち 2 回は並列）
  - Codex 0.160.0 の `codex exec`: サーバーの環境変数に CLAUDE / CODEX の変数は無い。各呼び出しの `_meta` の `x-codex-turn-metadata` に `session_id`・`turn_id`・`turn_trigger: "exec"`・`thread_source: "user"`・`turn_started_at_unix_ms` がある
- 未検証: 対話の Codex（TUI・デスクトップアプリ）の `turn_trigger` などの値、Agent SDK（`sdk-ts`・`sdk-py`）を実際に走らせた値、Claude Code の `/clear`・`/resume` の後にサーバーの環境変数のセッション id が古いまま残るか（A の方式では hook の入力を正とするので結果を左右しない）、Windows

## 方針

1. 呼び出し元の実測（最初に行う）。Claude Code と Codex の対話・headless（`claude -p` / `codex exec`）・SDK で、record サーバーのプロセスから呼び出し元のセッション id・ターン・起動の形（`CLAUDE_CODE_ENTRYPOINT` など）が見えるかを測り、結果を plan の「前提」に足す。見える値は run に保存し、begin でも save でも確かめる。判別できないホストや形では、AI の採用を候補のまま残す（閉じる側に倒す）
2. record-tool の呼び出しの記録
   - 起動の形: Claude Code はサーバーの `CLAUDE_CODE_ENTRYPOINT` が `cli` なら対話、`sdk-cli` なら headless、`sdk-` で始まるものは SDK、無い・見たことのない値は不明。Codex は `x-codex-turn-metadata` の `turn_trigger` が `exec` なら headless、それ以外は対話と実測できるまで不明。Codex の値がある呼び出しを、引き継いだ Claude の環境変数で分け直さない。生の値も残す
   - Claude Code: record ツールだけに当たる同期の PreToolUse hook（両ホストの hooks のうち Claude 側だけ）が、ツールが動く前に、hook の入力の `session_id`・`prompt_id`・`tool_use_id`・ツール名・時刻を、capture の接続の新しい insert 用の view から同期で書く（spool と flush は通さない）。新しい接続の役割は作らない
   - record サーバー: 呼び出し元を確かめた直後で、対象の検証と外部取得より前に、全 record ツール（begin・context・check・save・pending）の呼び出しを ingest の接続で独立して commit する（save の rollback で消えない。書けなければ処理を進めない）。Claude Code は `claudecode/toolUseId`、Codex は `x-codex-turn-metadata` のセッションとターンを書く。サーバーの環境変数のセッション id は補助として残すだけで、hook の値と食い違っても環境変数を優先しない
   - 除外: hook の観測と一意に結べた呼び出しは、そのセッション・ターンの assistant source を AI の採用の対象から外す。セッションだけ分かる呼び出しはそのセッション全体を外す。hook の行が無い呼び出し（hook の失敗・時間切れ・未登録の古いホスト）は不明として残し、結べるまで同じホスト・作業場所の assistant source の AI の採用を止める
   - 対話の Codex は実測できるまで AI の採用と自動の trace の通知を止める（呼び出しの記録と持ち主の採用は続ける）
3. schema（次の revision、移行あり）
   - `unit_adoption.route` に `agent` を足す。トリガーは、source が assistant の `session_message` で、AskUserQuestion の質問ではなく、2 の除外に当たらないことを確かめる
   - evidence の役に `decides` を足す。`agent` の adoption は、同じ記録の、同じ source と範囲にある撤回されていない `decides` evidence と組でなければならず、`reported_speaker` のある evidence は対象にならない。`unit_support` がこの組を見る
   - `do` の decision / constraint に `applies_to` の anchor があるときだけ、`agent` の採用には同じセッション・同じターンでその path を編集した観測が要る（record.ts の照合にターンを足す）。`dont`・`defer`・anchor の無い判断は `decides` の引用だけでよい
   - run に呼び出し元（セッション・形）を持たせる。既存の行は不明として移す
4. 権限の判定を 1 つの関数にする: 記録 →「持ち主（撤回されていない owner_statement / explicit がある）/ AI（agent だけ）/ なし」。read の履歴では、その時点の adoption と撤回から出す。保存のトランザクションの中で、記録を active にする・link を足す・adoption を足す・撤回する・衝突を解決する・anchor を変える、のすべての操作で変更の前後を確かめる。glean の経路（`server/src/glean.ts:63`、`:505`、`:972`）も同じ関数を通す。check は報告し、save で確かめ直す
5. link の規則（C′）: 候補の supersedes / conflicts は今どおり保存できる。効き目は権限で決める
   - 配信: 未解決の conflicts で配信から外れるのは、持ち主の判断でない記録と、持ち主が採用した相手と衝突している持ち主の判断。持ち主の判断は、採用されていない記録や AI の判断との衝突では外れない。AI の判断どうしの衝突は両方を止める
   - 置き換えは「つもり」と「効いている期間」に分ける。`unit_link` の `supersedes` は置き換えるつもり（記録の入力はそのまま。1 つの記録が持てるのは 1 つまでで、DB でも縛る）。効いている期間は新しい表 `unit_replacement`（開始・終了・その原因の run か forget、終了は 1 回だけ、書き換えない）。開いている行は 1 つの記録につき 1 つまで（partial unique index）で、それが後継の枠
   - 状態は事実から計算する。書き込み（record・glean の保存、forget、移行）は事実（つもり、根拠、採用、明示の取り下げ）だけを変え、最後に 1 回、純粋な関数 `judge(snapshot)` が、影響を受けた記録と `supersedes` でつながる範囲の最終の状態を決め、差分だけを書く（閉じる行 → 開く行 → 状態の行の順）。一時的な下げはしない。trigger は書かれた結果が規則を満たすかを確かめるだけで、連鎖を戻す処理はしない
   - 条件（どの種類でも同じ）: eligible = 取り下げられていない・`extraction = 'supported'`・`unsourced = 0`・`unit_support` に不足なし。判断と制約がつもりを持つなら、持ち主か maintainer の採用も要る（相手が誰でも。AI の採用だけでは置き換えを効かせない）。置き換えが効くのは、eligible な後継で、相手が sound で取り下げられておらず、後継が枠の持ち主のとき。枠の持ち主は、今開いている行の後継がまだ条件を満たすならそのまま、空いていれば、つもりを先に保存したもの（`unit_link.added_at`、次に id）
   - active は、eligible で、つもりがあればそれが効いているとき。superseded は、効いている置き換えが入ってきているとき。それ以外は candidate で、待っている理由（どの記録が枠を持っているか）を状態とは別に持ち、check・save・read が出す。superseded から active へ直接戻る遷移を正しい遷移として足す
   - 採用付きで保存した後継と glean の `adopt` は、相手の枠が埋まっていれば今どおり名前を挙げて拒む。待つのは採用されていない候補だけ（後採用の流れ）。同じ保存で同じ相手に 2 つの後継を active にしようとしたら、名前を挙げて拒む。同じ保存で、新しい後継が置き換える前の記録を取り下げる操作は冗長として書かない（今どおり）
   - 移行（revision 10）: 証明できる過去の期間だけを行として戻し、今効いているが始まりが分からないものは移行の時点を始まりとする行（`origin = 'migration'`）にする。今は効いていなくて過去も証明できないつもりには「以前の履歴は記録されていない」の印を残し、read で未実行の提案と取り違えない。複数のつもりを持つ記録があれば、勝手に選ばずに移行を止めて一覧にする。そのあと同じ `judge`（revision 10 に固定した版）を同期で通して状態を直し、すべて `sphica_migration_note` に出す
   - 読み手（search の後継、overview、read、export、review、rules）は、保存された状態と `unit_replacement` の行だけを読み、推し量らない。read は、つもり・今の効き目・閉じた期間・履歴が記録されていない印を分けて出す
   - ingest と forget は `unit_replacement` に行を足し、終了の列だけを書ける。根拠の最後の 1 つを撤回するのを拒む今の trigger はゆるめる（同じ transaction の judge が整合をとる）。`unit_state` と `unit_replacement` を書くのは reconcile のモジュールだけで、architecture の検査で固定する
   - `agent` だけの記録は置き換えを効かせられない。配信を止めていることと撤回とは表示で分ける
6. 表示: 配信・read・search・record_context・review の表示で、記録ごとに権限を出す。AI の判断には CONFIRM とは別の固定文を付ける（「前のセッションで AI が決めた。具体的な理由があれば離れてよい。返事でどの記録からなぜ離れたかを書く。持ち主の規則・公開の約束・承認の関門を越える許可ではない」の趣旨、英語）。どちらの文も記録からは取らない
7. trace の Skill（両ホスト）: 自動での起動を許す（`disable-model-invocation` と `allow_implicit_invocation` を一緒に変え、description から「明示の依頼のときだけ」を外す）。自動のときは対象を自分で選び、持ち主に聞かない。`agent` の採用を使ってよいのは AI が一人称で選んだ判断だけで、伝聞・引用・提案・質問・文書やツール出力の要約には使わない。公開の約束・セキュリティと権限・リリース・forget、CLAUDE.md / AGENTS.md / `.claude/rules` を緩める判断には使わない。迷ったら採用しない。コードブロック・引用・かぎかっこの中の引用は警告にとどめる。パスの一覧（`db/schema.sql`、`server/src/db-write.ts`、`server/src/sqlite.ts`、`server/src/mcp*.ts`、`server/src/cli/`、`server/src/forget.ts`、`.github/workflows/release.yml`、`plugin/hooks/*.json`、プラグインの manifest）に `applies_to` が当たる `agent` の採用は警告を出して候補に残す（補助の検査で、境界ではない）
8. 自動の trace の起動: 新しい持ち主のセッション（対話で SDK ではない）の開始時の通知で、AI に、持ち主の依頼を片づけた後で、今のセッション以外の未処理を古い順に最大 2 セッション trace するよう伝える。通知は今のセッションごとに 1 回で、resume では出さない。遅れは「次の新しい持ち主のセッション」で、ちょうど 1 セッション後とは限らない
9. 未処理と再開: 自動のときの未処理には、処理していない assistant source も数える（source_processing を使う）。後から届いた source は次の回で未処理になる。セッションは古い順に SQL で limit の前に選ぶ。record_context は自動のとき、未処理の source から始め、前の文脈を決まった数だけ添える（文脈と今回の対象を分けて見せる）。ページの上限に達したら、読んだ範囲だけを保存して進みを残す。全ページを読み切る今の約束は、自動のときに限って変える
10. 段階 2 のための一覧: 「一度でも AI の判断として active になった記録」を、最初に active になった時刻、その時の採用元と content hash、今の状態つきで返す読み取りの関数を足す（新しい MCP ツールにはしない。評価側から呼ぶ）。今の履歴から作れるかを acceptance で確かめ、足りない項目だけを保存する。持ち主による置き換えと撤回は評価の候補を拾う手がかりで、変化の無いことを成功とは数えない
11. 配布する Skill の追従: review の過去の判断の観点（`plugin/skills/review/reviewers/precedent.md`）は、持ち主の判断から外れる差分を今どおり指摘し、AI の判断から外れる差分は「理由が書かれていなければ指摘」に弱める。export と rules は選ぶ一覧と下書きに権限を出す（rules は持ち主が選んだ記録だけを下書きする今の規則のまま。AI の判断を規約の行にすると規範に格上げされるので、その旨を選ぶときに 1 行で知らせる）
12. 文書の更新（README は配布物で、npm のページにも出る。`scripts/bundle.mjs:60`）。README.md と README.ja.md は同じ内容で、今の挙動だけを書く（記録 u84: バージョン番号・経緯・移行の説明は書かない、日本語は普段の開発者の言葉）
   - 「できること」の trace の項: 新しいセッションの開始時に、エージェントが以前のセッションを自分で trace する（1 回に最大 2 セッション）。手で `/sphica:trace` を流すこともできる。決定が採用になるのは、あなたがそう言ったとき（あなたの判断）と、エージェントがそのセッションで自分で決めたとき（AI の判断）の 2 通り。AI の判断はそう分かる形で届き、あなたの判断を置き換えられず、公開の約束・セキュリティと権限・リリース・forget には使われない
   - 「必要なときに見せる」の項: 届く記録に、あなたの判断か AI の判断かが付く。AI の判断には、理由があれば離れてよいと添える
   - 「使い始める」: セッションの終わりに trace を流す案内を、自動で回ることと、すぐ残したいときに手で流せることに書き換える
   - 安全の節「ほかの人が書いた文章」: 採用にできるのは、あなた・オーナー・メンテナーの言葉と、エージェント自身が決めたこと。ほかの人の文章をエージェントが引用・要約したものは採用にならない
   - 「まだできないこと」: エージェントが自分で決めたかどうかの見分けは文の意味に頼るので完全ではない / headless・SDK のセッションと、呼び出し元を見分けられない環境では、AI の判断は採用にならず候補に残る / 自動の trace はサブスクリプションの使用量を使う / エージェントは AI の判断を撤回しない（置き換えたいときは矛盾として両方を止める）
   - CLAUDE.md と AGENTS.md（同じ内容）: Runtime boundaries の record-writes の項に「`agent` の採用は record サーバーが呼び出し元を確かめた run からだけ」「持ち主の判断を置き換える・ぶつかる link は持ち主が採用した記録からだけ」を足し、invariant の印を付ける。CLI の説明「trace は slash command」は、エージェントも自分で起動すると直す
   - knowledge-schema の Skill（`.agents/skills/knowledge-schema/SKILL.md`。`.claude/skills/knowledge-schema` はその symlink）: 採用の経路（`agent`）、evidence の役（`decides`）、`unit_support` の条件、run の呼び出し元と record-tool の呼び出しの表を足す
   - plugin-release・eval-loop・`.claude/rules` は、この変更で書いてあることが変わらないことを rg で確かめ、変わるところがあれば同じタスクで直す
13. 出荷: package に入る変更なので、`bun run release:plan` で種類を確かめ、npm と 3 つの manifest を同じバージョンに上げる。npm-release の承認は持ち主のまま

## 採った案と棄却した案

- 採用: 採用の経路 `agent` と、採用の履歴から都度出す権限。棄却: unit に書き換えられる authority 列を持つ（採用・撤回の履歴とずれる）
- 採用: 置き換えの「つもり」（`supersedes`）と「効いている期間」（`unit_replacement`）を分け、状態は書き込みの最後に事実から計算して差分を書く。棄却: 後継の枠を状態や採用から推し量る（T04・T18・T19・T20 の Codex のレビューで 13 件の穴が出た）。棄却: link の種類（proposes）を足し、active になったときに置き換えへ変える（採用の撤回と一時的な下げを見分けられず、権限の喪失や中間の記録の根拠喪失で出来事を取りこぼす）。棄却: 出来事ごとに期間を開け閉めする（状態の行が書かれない権限の変化、複数の操作の保存、連鎖の末尾の再採用で取りこぼす）。棄却: 後継の枠を u121 の元の規則に戻す（AI の提案が待っていると持ち主の後継が保存できない制約が残る）
- 採用: 候補の link は保存できるまま、配信では権限を見て持ち主の判断への効き目を止める（C′ の配信の部分）。棄却: 新しい記録を候補に残すだけで守る（候補の conflicts でも持ち主の判断が配信から消え、候補の supersedes が後継の枠をふさぐ。再現済み）。棄却: 持ち主の判断への link を同じ保存で持ち主が採用した記録からだけ通す（glean の「候補の後継をあとで採用する」流れを壊し、後から採用された判断に付いていた候補の conflicts も防げない）。棄却: link を採用のときに初めて付ける（glean の入力の決まりごとが増える）
- 採用: 対象外の領域は Skill の規則と「迷ったら候補」で守り、パスの一覧は補助の警告にする。棄却: `applies_to` のパスの一覧を境界にする（anchor を省けば素通りし、判断の中身を分類できない）
- 採用: `decides` の引用と capture 由来の除外を組み合わせ、`do` で anchor のある判断だけに同じターンの編集を求める。棄却: 構文の除外と `states` と同じセッションの編集だけで見分ける（伝聞を平文で書き、無関係な編集を根拠にすれば通る）。棄却: すべての判断に編集を求める（`dont`・`defer`・調べものの判断が採用されなくなる）
- 採用: 段階 1 の AI は supersedes しない。棄却: AI の判断どうしの置き換えを許す（評価の前に古い AI の判断を退かせてしまう）
- 採用: 開始時の通知で前のセッションを trace する。棄却: Stop で処理を続けさせて今のセッションを trace する（Codex では続けさせた文が持ち主の発言として入るおそれがあり、遅れて届く source と、trace の報告を次の trace が拾う循環がある）
- 採用: Claude Code のターンは、record ツールにだけ当たる同期の PreToolUse hook が capture の新しい view から書き、record サーバーが `claudecode/toolUseId` で結ぶ。棄却: 記録済みのターンの区切りと時刻から推し量る（別のターンの返事が挟まると呼び出しを見落とし、`/clear` 後の古いセッション id で別のセッションを外す）。棄却: hook が取れなかったときだけ時刻から推し量る（安全が一番要る場面で弱い方法に落ちる）。棄却: record ツールを呼んだセッションを丸ごと外すだけ（自動の trace は毎回新しいセッションで走るので、ほとんどの AI の判断が採用されなくなる）
- 採用: record-tool の呼び出しを、record サーバーが呼び出し元のセッション・ターンつきで同期して書く。棄却: hook の PostToolUse で観測する（非同期で遅れて届き、失敗や中断を拾えない）。棄却: run の開始時刻と、その後の最初の返事で推し量る（同じ run を別のターンで使う場合や、begin の前の失敗を外せない）
- 採用: 呼び出し元を測ってから、判別できないところでは AI の採用を止める。棄却: Skill の禁止だけで headless・SDK を外す（サーバーが拒む保証にならない）
- 採用: 評価用の一覧は「一度でも AI の判断として active になった記録」。棄却: 今 AI の判断である記録だけ（持ち主が採用したり撤回したりすると、評価したい元の記録が一覧から消える）

## 手順

- S1: 呼び出し元の実測（両ホスト × 対話・headless・SDK、Windows を含む）と、結果の「前提」への追記
- S2: schema の revision を上げる（`agent` の経路、`decides` の役、run の呼び出し元、record-tool の呼び出しの記録、トリガーと `unit_support`）と移行。生成する型
- S3: record ツール用の同期の PreToolUse hook（Claude Code）と、record サーバーが呼び出し元を確かめ、record-tool の呼び出しを同期で書き、hook の観測と結び、begin と save で照合する
- S4: 権限の判定関数と、保存・glean のすべての操作での前後の検査。link の規則（持ち主の判断の保護、AI の supersedes の禁止、AI どうしの conflicts）
- S5: record.ts の `agent` の採用（`decides` との組、除外、同じターンの編集、パスの一覧の警告）
- S6: 配信・read・search・record_context・review の権限の表示と、AI の判断用の固定文
- S7: trace の Skill（両ホストの起動の設定・description・自動のときの手順と規則）と check-ai-config
- S8: 自動の trace の起動（セッションごとの開始時の通知）と、未処理・再開（assistant source、古い順、前の文脈、上限での部分保存）
- S9: 段階 2 のための一覧の関数
- S10: acceptance のケース（S1〜S9 の入力すべて。今のコードにある挙動は red を先に確かめる）
- S11: 配布する Skill（review の過去の判断の観点、export、rules）が権限を扱う
- S12: README.md・README.ja.md・CLAUDE.md・AGENTS.md・knowledge-schema の Skill の更新と、ほかの開発の文書の確かめ
- S13: バージョンを上げて出荷し、両ホストで実際に届くことを確かめる
- S14: 純粋な `judge(snapshot)` と、つながる範囲の取得（同期。保存用と移行用の adapter に分ける）
- S15: schema（`unit_replacement`、1 記録 1 つのつもり、履歴が記録されていない印、superseded から active への遷移、trigger を確かめだけにする、ゆるめる撤回の trigger、view と再帰の復帰を外す）と、record・glean・forget の保存を「事実 → 正規化 → judge → 差分を書く → 最後の整合の確認」に集める
- S16: revision 9 からの移行（証明できる期間、移行の時点の行、印、複数のつもりで止める、judge を通す、メモ）
- S17: 読み手（search・overview・read・export・review・rules・record_context）を `unit_replacement` に合わせる
- S18: 役割ごとの実接続、全 rollback、操作の順番に依存しないこと、再採用・同じ保存の取り下げ・隔離・出典なしの受け入れケース

## 完了条件

- A1: `bun run verify` → 終了コード 0
- A2: `cd server && node --test --test-name-pattern="authority" test/record.test.ts test/deliver.test.ts` → pass。次がすべて通る: 候補・`agent` の記録から持ち主の判断を指す supersedes / conflicts が拒まれ、持ち主の判断が配信に残る / `agent` の記録が supersedes を持てない / AskUserQuestion の質問・`reported_speaker` のある引用・`decides` でない引用・record ツールを呼んだターンの返事・呼び出し元が不明の run からの `agent` の採用が候補に残る / `do` で anchor のある判断は、同じターンにその path の編集が無ければ候補に残る / 持ち主の採用は今までどおり active になる。持ち主の判断を守るテストは main のコードでは落ちる
- A3: `bun run acceptance` → pass。S10 で足した伝聞の平文・取得したページの注入文・無関係な編集・質問・trace の報告の各ケースで、`agent` の採用が active にならない
- A4: `cd server && node --test --test-name-pattern="migrat" test/schema.test.ts` → pass。移行の前後で既存の持ち主の採用が変わらず、run の呼び出し元が不明として移り、新しく作った DB と移行した DB の schema が一致する
- A5: `cd server && node --test --test-name-pattern="agent history" test/record.test.ts` → pass。持ち主が後から採用した記録と AI の採用が撤回された記録が一覧に残り、最初に active になった時刻と当時の content hash が返る
- A6: `node scripts/check-ai-config.mjs` → 終了コード 0。trace の Skill の両ホストの起動の設定がそろっている
- A7: `bun run hooks:live` → pass。対話の持ち主のセッションの開始で自動の trace の通知が 1 回だけ出て、resume と headless・SDK の形では出ない
- A8: `bun run release:plan -- --base <前のリリースのコミット>` → `plugin`。`plugin/package.json` と 3 つの manifest が同じ新しいバージョン
- A9: `bun run release:status` → 出荷の後、npm・global CLI・Claude と Codex のプラグインのバージョンがそろう。そのうえで両ホストの対話セッションで、未処理のセッションがある状態で新しいセッションを始めると、AI が持ち主に聞かずに最大 2 セッションを trace し、`agent` の採用を含む記録が保存される（Windows を含む、手で確かめる）
- A10: `node scripts/check-pairs.mjs && bun run english && bun run verify:ai` → 終了コード 0。`rg -n "end of a session|セッションの終わりに" README.md README.ja.md` → trace を手で流すことだけを前提にした案内が残っていない
- A11: `gh pr checks <PR 番号> --watch` → 全ジョブ pass
- A12: `cd server && node --test --test-name-pattern="successor place|owner decision protected|judge" test/*.test.ts` → pass。T04・T18・T19・T20 のレビューの 13 件と、設計の議論の C18・C20・C22・C23・C25〜C29・C33 の入力が、それぞれ回帰のテストとして通る
- A13: `cd server && node --test --test-name-pattern="judge budget" test/reconcile.test.ts` → pass。記録数千件・長い連鎖・1 つの相手に多数の待っている提案を持つ一時 DB で、1 回の保存のロックが 200 ms 以内

## リスク

- S1 で、どのホストでも呼び出し元のターンが取れない → 方針 2 の保守的な形（record ツールを呼んだセッション全体を対象外）にする。自動の trace は、開始時に依頼を片づけた後に動くので、そのセッションで AI が決めた判断がすべて候補に残る。そうなったら持ち主に報告し、段階 1 の範囲を見直す
- S1 で、headless・SDK と対話を見分けられない → そのホストでは `agent` の採用を止める。自動の trace の通知も、見分けられない形では出さない
- `decides` の判定は意味に頼るので、誤った AI の判断が active になる → セキュリティの境界ではないと認めたうえで、AI の判断と表示し、持ち主の判断を覆せず、規則を緩められない形で被害を抑える。段階 2 の評価で率を測る
- 自動の trace がサブスクリプションの使用量を食う → 1 セッションの開始ごとに最大 2 セッション、ページの上限つき。多すぎると分かったら上限を下げる
- 開始時の通知を AI が無視する、または依頼の前に trace を始める → A6 で両ホストの挙動を見る。守られないときは文を直し、評価ループのケースにする
- 作業ツリーに別の計画（#206）の変更があり、schema の revision やバージョンがぶつかる → 実装を始める時点の main の revision とバージョンの次を使う

- Codex で、MCP の入力の形で拒まれた record ツールの呼び出しはサーバーに届かず、`record_call` に残らない（Claude Code は hook の行で外せる）→ 拒まれた呼び出しは何も実行しないので、入力の形（公開の約束）を緩めてまで記録しない。Codex の PreToolUse が MCP ツールに届くと分かれば、Claude Code と同じ観測を足す

## 未解決

なし

## 変更履歴

- 2026-10-04 / 方針 5 の後継の枠を、「つもり」と「効いている期間」を分けて状態を事実から計算する作りに直し、S14〜S18 と A12・A13 を足した / 推し量る形は 4 回のレビューで 13 件の穴が出続けた。持ち主が「妥協せずに最高のもの」を求め、Codex（session 01a106b6-fb1d-7b92-bd56-1ce63211bc02）と 4 往復して合意した（最後の 2 点 C24・C33 は Codex の代案を入れて閉じた） / Go が要る（データの形と保存の挙動が変わる。承認待ち）

- 2026-10-04 / 方針 5 の後継の枠を、持ち主の判断かどうかで分けない規則にし、連鎖をまとめて戻すようにした / 持ち主の判断のときだけ規則を変える形は、前の判断の採用の付け外しで規則が切り替わり、穴が開き続けた（T19 の Codex のレビューで P1 2 件・P2 1 件） / 持ち主が選択肢 1 を選んだ（Go 済み）

- 2026-10-04 / 方針 5 の後継の枠を「active になった後継だけ」に単純にした / 「採用された候補も枠を使う」形は、採用の撤回や並べる順番で穴が開き続けた（T04・T18 の Codex のレビューで計 8 件） / C′ の「候補は枠を使わない」を厳しくする向きで範囲は変わらないので Go は不要

- 2026-10-04 / 方針 5 を C′ に直した（候補の link は保存できるまま、配信と後継の枠で効き目を止める。u121 の数え方を変える） / T04 の保存時に拒む形が glean の後採用の流れを壊し（既存テスト 3 件の退行）、後から採用された判断への候補の conflicts も防げないと分かり、Codex（session 01a10674-cba9-7973-87e6-d00262d5f9c9）と比べた / 持ち主が C′ を選んだ（Go 済み）

- 2026-10-04 / 方針 2 の除外を「hook の行だけでそのターンを外す」に強め、Codex の入力の形で拒まれた呼び出しをリスクに足した / T03 の Codex のレビュー（MCP の SDK が入力の形をハンドラーより先に確かめるので、拒まれた呼び出しは記録されない） / 守りを強める向きで範囲は変わらないので Go は不要

- 2026-10-04 / 方針 2 を、Claude Code のターンを record ツール用の同期の PreToolUse hook と capture の新しい view で取る形に直し、実測を前提に足した / 実測で Claude Code の MCP 呼び出しにターンが無いと分かり、Codex（session 01a1065d-a782-77f2-bcea-beccec0ace30）と比べた / 持ち主が A を選んだ（Go 済み）

- 2026-10-04 / 方針 11・12 と S11・S12・A10 を足した（配布する Skill の追従と、README などの文書の更新） / 持ち主が文書の徹底した更新を求めた / Go が要る（tasks の確認で取る）
