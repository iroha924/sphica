---
kind: plan
status: approved
codex_session: 01a0ea6b-11fc-7600-a2d6-ad46247a364c
codex_rounds: 3
approved_at: 2026-09-29
---

# 本人の過去の発言から今の問いに似たものを探し、それが何につながったかと、決定の記録が無いまま繰り返されている問いを示す（C1a #192、C4 #197）

## 要点

- `search` に `asked: true` を足す。本人の過去の発言のうち、今の問いの語の半分を超えるものを返し、それぞれにその発言を直接引用している記録（状態と、置き換えられていれば今の後継）を添える。頼まれたときだけ動き、プロンプトに合わせて自動では出さない
- 決定（decision か constraint で、candidate でないもの）が直接つながっていない発言には「no recorded decision」と書き、trace していなければ「not traced yet」と `/sphica:trace` を添える。答えは推測しない
- 同じことが 2 つ以上のセッションで聞かれていて、どこにも決定が無ければ、それらのセッションを 1 行で示す（trace 済みか未 trace かで分ける）
- 置き換えの後継を 1 段しかたどらない既存の不具合を直し、`search` の記録の検索でも最新まで届くようにする
- 関係ない発言を返す率を、リポジトリに置いた日本語と英語の固定のコーパスで測り、PR に書く
- 変えないもの: 一致の規則（語の半分を超える）、プロンプト時の配信（完全一致のまま）、スキーマ

## 持ち主の決定

- 選別の順序: … W3 → C1a → C2・C16 → C8-lite → C3 → C5-B → C4 → C12（2026-09-28、u22）
- 小さな issue は束ねる。C1a と C4 を 1 つの PR にする（2026-09-29、C4 は C1a の一致をそのまま使うので順序を前に寄せた）
- #192: 頼まれたときだけ動く形で作る。プロンプト時に自動で出すかは、誤表示の率を測ってから決める（u25、issue 本文）。記録の無い問いは「no recorded decision」と言い、推測しない
- #197: 「undecided」ではなく「no recorded decision」と言い、そのセッションの trace を勧める（issue 本文）

## 目的

- エージェントが頼まれたときに、本人が以前に同じようなことを言っていたか、それが何の記録につながったかを、置き換えを含めて正しく示せる
- 決定の記録が無いまま繰り返されている問いと、そのセッションが分かる
- 関係ない発言を返す率が数字で分かり、プロンプト時の自動表示を判断する材料になる

## 対象外

- プロンプト時の自動表示（u25）
- 「質問らしさ」の判定（「?」の有無など）。この版では一致した本人の発言をすべて返し、「questions」とは呼ばない
- 同じターンや後のターンの発言からの答えの推測。直接の引用だけを「つながった記録」とする
- ひらがなだけの語の索引（u29）。評価で実際に見落としが出たら見直す

## 前提

- 本人の発言は `source` の kind `session_message`、author_kind `owner`、indexed 1 で `source_fts` に入る。`session_id` と `turn_id` を持つ（`db/schema.sql` の `create table source`）。AI の返事は保存されるが索引されない
- 記録は `unit_evidence`（source_id、範囲、role、option_id）と `unit_adoption`（source_id、範囲）で発言を引用する。置き換えは `unit_link` の kind `supersedes`（新 → 旧）
- `source_processing`（source_id、run_id、outcome）が trace の見た発言を示す（`server/src/status.ts` の `pendingCount`）
- `searchSources`（`server/src/search.ts`）は「語の半分を超える」一致を上限と `stopped` 付きで行う。順番を 1 つの SQL で取ってから中身を引く
- `searchUnits` の後継は 1 段だけたどる（`server/src/search.ts` の後継のループ）。A → B → C と置き換えると、A の一致から C に届かない（Codex がコードで確認）
- MCP の読み取りサーバーのツールは status・search・read（`server/src/mcp.ts`）。ツールの一覧は `server/test/plugin.test.ts` で固定
- ホストのセッション id は `CLAUDE_CODE_SESSION_ID` / `CODEX_THREAD_ID`（`server/src/extract.ts` の `sessionOf`）。Claude Code の読み取りの MCP のプロセスは `CLAUDE_CODE_SESSION_ID` を持つ（2026-09-29、review-shipping が `ps` で確認）。Codex（codex-cli 0.157.1）が起動する MCP のプロセスには `CODEX_THREAD_ID` も他のセッション id も無く、1 つのプロセスが複数のスレッドに使われうる。エージェントのシェルには `CODEX_THREAD_ID` がある（同じく確認）。`/clear` や `/resume` の後も正しいかは未検証
- `server/src/text.ts` はひらがなだけの語を索引しない（u29）

## 方針

### 一致（`server/src/search.ts`）

- `searchSources` に本人の発言だけの形を足す（kind `session_message`、author_kind `owner`、今のセッションを除く）。この条件は順番を取る SQL に入れ、上限の前にかける。`stopped` と `read` はそのまま
- この形では `limit` 件で止めず、上限まで読んで一致した発言を全部集める（繰り返しの判定のため）。表示は `limit` 件に切る
- 後継: `supersedes` を今の記録に届くまでたどる関数を 1 つ作る（たどった記録の集合で輪を防ぐ）。`searchUnits` の後継もこれを使う

### つながった記録

- 一致した発言を直接引用している記録（evidence か adoption の source_id がその発言）を「led to」とする。記録ごとに key、kind、状態、置き換えられていれば今の後継
- 同じターン（同じ session_id と turn_id）の別の発言を引用している記録は、「same turn (context, not necessarily the answer)」として分け、引用された発言の話者と role を添える
- 同じターンの AI の返事は本文を載せず、「reply: s<id>（read で読める）」と id で示す
- 決定の記録 = 直接つながった記録のうち kind が decision か constraint で、状態が active・superseded・withdrawn のもの（candidate は数えない）。この判定は `kinds`・`lifecycles` の絞り込みの前に行う。絞り込みは見せる記録だけに効き、隠れた記録があれば「N tied records hidden by the filters」と書く
- 決定の記録が無い発言: 「no recorded decision」。その発言が trace されていなければ（`source_processing` が無い）「not traced yet: /sphica:trace <session>」を添える

### 繰り返し（#197）

- 一致した発言が 2 つ以上のセッションにまたがり、どの発言にも決定の記録が無いとき、1 行: 「Asked in N sessions with no recorded decision:」の下に「not traced yet: <sessions>（/sphica:trace で）」と「traced: <sessions>」。N は両方を合わせたセッション数
- 数えるのは上限まで読んで一致した発言全部。上限で止まったら「within the first N candidates」と書く

### MCP（`server/src/mcp.ts`）

- `search` に `asked: boolean` を足す。`sources: true` か `path` と一緒なら断る文を返す
- `search` に任意の `session`（今のセッションの id）を足す。`asked` で使い、渡された id と環境変数の id（両方のホストの形）を除く。Codex では MCP に id が渡らないので、ツールと引数の説明、MCP サーバーの instructions に「asked: true では、シェルの `CODEX_THREAD_ID` を session に渡す」と書く
- 今のセッションが分からない（`session` も環境変数も無い）ときは推測で除かない。見出しを「Owner messages matching:」、繰り返しの行を「Matching messages in N sessions with no recorded decision (current session may be included):」、何も無いときを「No owner message …」にし、最後に「Current session unknown; results and session counts may include its messages. Pass session to exclude it.」を付ける
- 文の見出しは「Earlier owner messages matching: …」（「questions」とは呼ばない）。何も一致しなければ今と同じ形（止まったら止まったと言う）
- ツールの説明に 1 文足す。Skill（`plugin/skills`）で search の使い方を書いている箇所があれば合わせる

### 評価（`server/evals/asked/`）

- 日本語と英語の本人の発言約 40 件（10 セッション、ひらがなの多い言い回しを含む）と、問い 12 件。問いごとに「人が関係あると言う発言の id」を固定で持つ
- スクリプトが一時 DB に入れて本物の検索を流し、返った組を順位と記録の状態を伏せて並べ替えて書き出す。関係の有無は固定の id で判定する（モデルに判定させない）
- 報告: 関係ない / 返した数、見落とし（関係あるのに返らなかった）、空だった問い、上限で止まった問い。ひらがなの多い問いで見落としがあれば u29 を見直す材料として書く
- 数字は PR 本文に書く。`bun run verify` には入れない（数字を報告するもので、合否ではない）

### テスト（実 SQLite）

- 置き換えられた答え（2 段の置き換えで今の記録まで届く。`searchUnits` でも）
- trace 済みで記録が無い発言は「no recorded decision」、未 trace は「no recorded decision」と「not traced yet」
- 今のセッションを除く、関係ない本人の発言（語が重なるだけの指示）が返ることを文言が「questions」と言わないことで扱う
- 同じターンの別の話題を引用した記録は「same turn」に分かれ、決定に数えない
- question や finding だけがつながっている発言は「no recorded decision」
- 絞り込みで決定を隠しても「no recorded decision」と言わず、隠れた件数を言う
- 絞り込みの条件が上限の前にかかる（AI の返事や今のセッションが上限を食わない）
- 2 セッションで記録が無い → 繰り返しの行（trace 済み・未 trace を分ける）。同じ内容で決定がつながっている → 行が出ない。上位 `limit` 件が同じセッションで、その後ろに別のセッションがある → 繰り返しを見落とさない
- MCP の文は `server/test/plugin.test.ts`。acceptance case を 1 つ

### 出荷

パッケージに入る変更なので、バージョンを編集する前に `bun run release:plan -- --base 0543025` を流し、`plugin` なら npm と 3 つの plugin manifest を同じ新しいバージョン（0.6.3 の見込み）にそろえる。最初の実装のコミットに入れる（pre-commit のフックが同じコミットでの上げを求める）。

## 採った案と棄却した案

- 採用: `search` に `asked` を足す。棄却: 新しいツール（ツールと Skill の案内が増える）
- 採用: 直接の引用だけを「つながった記録」、同じターンは文脈として分ける。棄却: 同じターンの引用をすべて答えとする（1 ターンに複数の話題があり、選ばなかった案の引用も含む）
- 採用: 一致した本人の発言を「messages」と呼び、質問らしさは判定しない。棄却: すべてを「questions」と呼ぶ（指示や記述も一致する）
- 採用: 決定 = decision か constraint で candidate 以外。棄却: どんな記録でもあれば決定あり（question や finding は決定ではない）
- 採用: 決定の有無は絞り込みの前に判定。棄却: 絞り込んだ後で判定（隠しただけで「記録なし」と言う）
- 採用: 繰り返しは上限まで読んで数え、表示だけ `limit` で切る。棄却: 表示の `limit` 件で数える（同じセッションが上位を占めると見落とす）
- 採用: 固定の関係ありの id で測るローカルの評価。棄却: クラウドの評価ループ（費用が大きく、この段階で要るのは検索の誤表示の率だけ）
- 採用: 今のセッションの id を `session` で受け取り、分からないときは含まれうると言う。棄却: 直近に発言のあったセッションを今のものとみなして除く（本当の過去のセッションを隠しうる）/ 注意書きだけ（Codex では常に混じる）
- 採用: 後継を今の記録までたどり、`searchUnits` も同じ PR で直す。棄却: 新しい機能だけ直す（同じ不具合が出荷済みの検索に残る）

## 手順

- S1: 後継を今の記録までたどる関数を作り、`searchUnits` で使う
- S2: `searchSources` に本人の発言だけの形を足す（条件は上限の前、`limit` で止めない）
- S3: 一致した発言ごとに、つながった記録・同じターンの文脈・決定の有無・trace の有無を組み立てる
- S4: 繰り返しの行を組み立てる
- S5: MCP の `search` に `asked` を足し、文と説明を書く
- S6: ローカルの評価（コーパス、問い、スクリプト）を足して流す
- S7: acceptance case を足す
- S8: `release:plan` に従ってバージョンを上げる

## 完了条件

- A1: `cd server && node --test --test-timeout=60000 test/search.test.ts test/plugin.test.ts` → 全部 pass（上のテストを含む）
- A2: `git checkout main -- server/src && (cd server && node --test --test-timeout=60000 test/search.test.ts); git checkout HEAD -- server/src` → 2 段の置き換えのテストと `asked` のテストが、直す前のコードで落ちる
- A3: `node server/evals/asked/run.ts` → 関係ない / 返した数、見落とし、空、上限で止まった問いを出力する
- A4: `bun run verify` → 0 で終わる
- A5: `bun run release:plan -- --base 0543025` → `plugin`。4 か所が同じバージョン
- A6: `gh pr checks <PR 番号> --watch` → 全項目 pass

## リスク

- 関係ない発言が多く返る → 数字を PR に書き、プロンプト時の自動表示は見送ったまま。一致の規則の見直しは別の作業
- 読み取りの MCP でホストのセッション id が取れず、今のセッションの発言が返る → 返っても害は小さい。取れないことを評価の報告に書く
- 固定のコーパスが実際の使い方を表さない → コーパスの作り方を PR に書き、本番の DB での測定は別に残す

## 未解決

なし

## 変更履歴
2026-09-29 / `search` に任意の `session` を足し、今のセッションが分からないときの言い方を決めた / review-shipping が、Codex の起動する読み取りの MCP には `CODEX_THREAD_ID` が無く、今のスレッドの発言が「過去の発言」として返ることを再現した。別の会話（01a0ea89-9b62-7ab2-993c-034b552ec1c0）で Codex もこの案を支持 / Go 要。持ち主が「session 引数を足す」を選んだ（2026-09-29）
