---
kind: plan
status: approved
codex_session: 01a0fb88-0e3f-7842-ae48-04440d361974
codex_rounds: 2
approved_at: 2026-10-02
---

# Fix the reproduced search defects of #204 and reject unknown MCP tool arguments (#236), released as 0.6.19

## 要点

- 検索の候補を FTS から引く順にする（両サブクエリを `cross join`）。kind・lifecycle・path・asked の絞り込みでも同じ
- 質問の "does" が "doe" として残る件と、`getUsers` のような複数形の識別子が完全一致に数えられない件を、質問側の処理だけで直す。`terms()` の出力は変えない
- `search` の `path` を anchor と同じ規則で正規化し、絶対パス・空文字・リポジトリの外は「該当なし」でなくエラーで返す
- `sphica doctor` が、今の Node の単語分割が配った規則（terms の golden 54 件）と一致するかを見て、違えば知らせる。DB には何も足さない
- 両 MCP サーバーの全 18 ツールで、知らない引数をキー名入りのエラーにする
- 変えないもの: schema（revision 7 のまま）、`terms()` の出力、索引、ツールの引数の名前と意味。#204 の実験項目は後の PR
- npm と 3 つの manifest を 0.6.19 にそろえて出す

## 持ち主の決定

- #204 の fixes の部分と #236 を、1 つの計画・1 つの PR・1 回のリリースにまとめる
- #204 の実験項目は別の PR にする

## 目的

- 項目の多いプロジェクトでも、検索が FTS の一致から候補を引き、プロジェクトの行を総なめにしない
- "what does sanitize do" と "getUsers retry backoff jitter" が、該当する記録を見つける
- `search` の `path` に `./src/x.ts` を渡すと `src/x.ts` に anchor のある記録が返り、使えない path では理由の分かるエラーが返る
- 単語分割が配った規則と違う Node で動いていることに、doctor で気づける
- エージェントが引数の名前を間違えると、黙って無視されずにエラーで直せる

## 対象外

- #204 の実験: 識別子（camelCase・snake_case・path の区切り）の分割、bm25 の後の recency と kind の重み、alias の衛生の警告、日本語の分割による取りこぼしの計測、source の本文検査を安くすること。#204 はこれらを残して開いたままにする
- #189: 0.6.2（#223）で直っている（候補をページで読み、上限で止まったと言う）
- 索引を作った ICU を DB に記録すること（採らない理由は「採った案と棄却した案」）
- MCP SDK v2（#211）

## 前提

- main 2d00901b、0.6.18 公開済み。Node は mise で 24.15.0（SQLite 3.51.3）
- join の順番: `server/src/search.ts:60`・`:345` の内側のサブクエリは `fts join unit/source ... and project_id = ?`。Node 24.15.0 で実際の外側のクエリ込みの `explain query plan` は `SEARCH unit USING COVERING INDEX unit_content (project_id=?)` から始まり、MATCH が rowid ごとに走る。内側に `+project_id` を付けても外側の `u` が `SEARCH u USING INDEX unit_content` で先に来る。内側を `cross join` にすると `SCAN unit_fts VIRTUAL TABLE` が先頭になる（実測。Codex も unit 検索・source 検索・owner と除外 session 付きの askedBefore の 7 条件で同じ結果）。Node 26.5 では今の SQL でも FTS が先に来る（Codex 実測）。https://www.sqlite.org/optoverview.html#manual_control_of_query_plans_using_cross_join
- "does": `server/src/text.ts` の `queryTerms()` は `terms()` の後で QUESTION を外すが、`terms()` は `singular()` で "does" を "doe" にするので外れない。今の `queryTerms("what does sanitize do")` は `["doe","sanitize"]`（Codex 実測）
- 複数形の識別子: `search.ts:288-291` は単数にそろえた質問の語と、anchor の path・symbol を NFKC と小文字化しただけの文字列を比べる。`getUsers` の symbol は語 `getuser` と一致しない
- path: `search.ts:69-78` は `unit_anchor.path = q.path` の完全一致。空文字はフィルタ無しになる。`server/src/record.ts:195` の `repoPath()` が anchor の path の規則（`./` を 1 つ外す、空・絶対・`\`・ドライブ文字・`..`・`.`・空の区切り・制御文字を拒む）。`search.ts:52-54` は検索語が無いと path を見る前に返る
- 規則のバージョン: `terms()` の規則を変えるときは schema の revision を上げ、移行で索引を作り直す決まりで、`server/test/terms-golden.test.ts` がそれを守る（`text.ts:37-39`）。golden は `server/test/fixtures/terms-golden.json` の 54 件（約 14 KB、全件の照合は約 1.5 ms、Codex 実測）。ICU のバージョンはどこにも記録していない
- 索引への追記は各プロセスの `terms()` で行う（`server/src/db-write.ts:327-334`、capture は別の Node のプロセスから書く）
- #236: 両サーバーの `inputSchema` は生の shape で、SDK 1.30.0 が知らないキーを捨てる。`z.object({...}).strict()` にすると `isError: true` で `MCP error -32602 ... Unrecognized key` を返す（`callTool()` は reject しない）。`params._meta` は arguments と別に `extra._meta` へ届くので影響しない。`arguments._meta` は知らない引数として拒まれる。キーの description は listTools に残る（Codex が SDK 1.30.0 の InMemoryTransport で再現）
- package の入力は `scripts/lib/release-scope.mjs:16` の `plugin/`・`server/src/`・`db/`・`scripts/licenses/`。`server/test/fixtures/` は入らない
- 実ホスト（Claude Code・Codex）が今のツールに余分なキーを送っているかは未検証。Skills の記載の引数に衝突は見つかっていない（Codex が読んで確認）

## 方針

- **join の順番**: `searchUnits` と `searchSources` の内側のサブクエリの `join` を `cross join` にする。`askedBefore`（`server/src/asked.ts`）は `searchSources` を通るか確かめ、別の SQL なら同じ形にする。テストは、本物の関数が prepare する SQL を `statements()` で集め、候補の順位を取る SQL（`order by f.rank` を持つもの）に `explain query plan` をかけ、最初の段が `SCAN unit_fts` / `SCAN source_fts` であることを見る。条件は kind・lifecycle・path・それらの併用・sources・asked（owner と除外 session 付き）。本文や関連行を取る SQL は対象にしない。時間のテストは置かない
- **"does"**: QUESTION の比較を `terms()` と同じ畳み方にそろえる（一覧の各語を `terms()` に通した集合と比べる）。直接のテスト `queryTerms("what does sanitize do")` → `["sanitize"]` と、"what does sanitize do" が sanitize の記録を見つける検索のテスト
- **複数形の識別子**: 完全一致の判定に使う `ident` を、anchor の path と symbol それぞれのまるごとに NFKC・小文字化・`singular()` をかけたものにする。分割はしない。テストは、symbol `getUsers` の anchor を持ち他の語を持たない記録が "getUsers retry backoff jitter" で見つかること、path `src/x.ts` の anchor しか一致しない "src retry backoff jitter" は weaker のままであること
- **path**: MCP の `path` を `z.string().min(1).max(500)` にする。`searchUnits` は検索語の有無より先に `repoPath()` で正規化し、null なら `"path must be relative to the repository root: <理由>"` の形のエラーを返す（空白だけ・絶対・`..`・`\` などを含む）。正規化した path で anchor を探す。MCP の返答はツールのエラー（`isError: true`）。絶対パスはリポジトリの中でも変換せず拒む（説明が repository-relative のため）
- **分割の確かめ（doctor）**: golden を `server/src/terms-golden.json` に移し、`terms-golden.test.ts` と doctor の両方がそこを読む。期待値は実行時やバンドル時の `terms()` から作らない。doctor は今の Node で 54 件を `terms()` に通し、全件一致なら「word splitting matches the fixed samples (ICU <version>)」、違えば件数と `process.versions.icu` を出して「この Node は配った規則と違う分け方をするので、別の分け方で索引された記録を検索が見落とし得る」と知らせる。一致は `ok`、不一致は `warn` の行にする（doctor の既存の区分で、`warn` は「N to fix」に数えられる。直し方は配った規則と同じ分け方をする Node で Sphica を動かすこと）。案内に「reindex で直る」とは書かない（reindex は今の Node で作り直すだけで、この照合の結果は変わらない）。全件一致も「固定サンプルに一致」とだけ言い、既存の DB や別ホストの状態の証明とは言わない
- **#236**: 両サーバーの全ツールの `inputSchema` を `z.object({...}).strict()` で包み、各キーの description を残す。テストは `server/test/plugin.test.ts:430-511` と同じく実際のサーバーの入口を隔離した HOME と DB で起動し、listTools の全ツールが固定の引数表に載っていること（表の漏れで落ちる）と、全ツールに必須の引数と `zz_unknown` を渡すと `isError: true` で本文に `zz_unknown` が出ることを見る
- **バージョン**: 実装の差分ができた後、バージョンを編集する前に `bun run release:plan -- --base v0.6.18` を流し、`plugin` なら npm と 3 つの manifest を 0.6.19 にする（pre-commit が最初の package 入力のコミットでバージョンを求めるなら、そのコミットで上げる）
- 終わった計画の plan と tasks（`.claude/plans/2026/10/` の 4 組）は削除して、この PR に入れる（持ち主の決まり）

## 採った案と棄却した案

- 採用: 内側のサブクエリを `cross join`。棄却: 内側の `project_id` に単項の `+`（外側の `u` が project の index で先に選ばれ、FTS が先頭にならない。Node 24.15.0 で実測）
- 採用: path と symbol のまるごとを単数にそろえて比べる。棄却: `terms(path)` の全要素を完全一致に使う（`src` のような path の一部だけで強い一致になり、範囲が広がる）
- 採用: doctor が今の Node の分割を golden 54 件と照合する。棄却: 索引を作った ICU と規則のバージョンを DB に 1 行で記録する（capture が別の Node のプロセスから追記し続けるので 1 行では索引を表せない。追記ごとに記録するには capture に新しい書き込み権限と revision 8 が要る。規則のバージョンは revision と golden がすでに担う）
- 採用: golden の全 54 件で照合する。棄却: 数件の probe（全件でも 1.5 ms で、減らす利点が無い）
- 採用: 絶対パスはリポジトリの中でも拒む。棄却: cwd の root から相対に直す（公開の説明が repository-relative で、仕様を増やす理由が無い）
- 採用: 全 18 ツールを実際に呼ぶテスト。棄却: listTools の `additionalProperties: false` だけを見る（schema の形は見えても、実際の拒否と文面は確かめられない）

## 手順

- S1: 検索の候補を FTS から引く（`cross join`）と、実際の SQL のクエリプランのテスト
- S2: QUESTION の比較を `terms()` の畳み方にそろえる
- S3: 完全一致の判定を、path と symbol のまるごとを単数にそろえた形で行う
- S4: `search` の `path` を `repoPath()` で正規化し、使えない path をエラーにする
- S5: golden を `server/src/terms-golden.json` に移し、doctor が今の Node の分割を照合する
- S6: 両 MCP サーバーの全ツールで知らない引数を拒む
- S7: バージョンを 0.6.19 にそろえ、終わった計画のファイルを削除する

## 完了条件

- A1: `bun run verify` → exit 0
- A2: `cd server && node --test --test-name-pattern="query plan" test/search.test.ts` → pass。Node 24.15.0 で、変更前の SQL では順位を取る SQL の最初の段が `SEARCH` になって落ちることを red として tasks に記録してある
- A3: `cd server && node --test --test-name-pattern="does|plural identifier|path" test/search.test.ts test/text.test.ts` → pass（`queryTerms("what does sanitize do")` が `["sanitize"]`、`getUsers` が見つかる、`src` だけでは weaker、`./src/x.ts` が見つかり絶対パスと空文字がエラー）
- A4: `cd server && node --test test/terms-golden.test.ts` → pass で、読んでいるのが `server/src/terms-golden.json`（`server/test/fixtures/terms-golden.json` は無い）
- A5: `cd server && node --test --test-name-pattern="unknown argument" test/plugin.test.ts` → pass。両サーバーの全ツールが `zz_unknown` を名指しして拒む
- A6: `cd server && node --test --test-name-pattern="word splitting" test/cli.test.ts` → pass（今の Node で一致の行が出る。期待値を 1 件変えたデータでは不一致の件数と ICU のバージョンが出て、reindex を案内しない）
- A7: `npm pack` した tarball を repo の外で展開し `HOME=<temp> node <unpacked>/plugin/dist/cli.js doctor` → 「word splitting matches the fixed samples」の行が出る
- A8: `bun run release:plan -- --base v0.6.18` → `plugin`、npm と 3 つの manifest が 0.6.19
- A9: リリースの後、`bun run release:status` → `release ledger is consistent`。新しいセッションの `search` に `paths` を渡すとキー名入りのエラーになる

## リスク

- 実ホストが今のツールに余分なキーを送っていて、strict にすると呼び出しが失敗する → リリース後に Claude Code と Codex の両方で search・read・trace の保存を 1 回ずつ流して確かめる（A9）。失敗したらそのキーだけ受ける形に直して次のパッチで出す
- `cross join` が、データの多い DB で別の遅さを生む（FTS の一致が非常に多く、プロジェクトの行が少ないとき） → 合成 DB で今の SQL と比べて桁が悪くならないことを実装中に 1 回測り、tasks に記録する。悪くなるなら Codex と方針を見直す
- golden を `server/src` に移すと、テスト用のデータの変更がリリース対象になる → 意図どおり（期待値が配布物の一部になる）。release:plan が `plugin` を返すことで確かめる
- doctor の照合が CI と違う ICU の環境で落ちる → doctor は警告を出すだけで、テストは期待値を差し替えたデータで分岐を見る。golden のテスト自体は今までどおり CI の Node 24 と 26 で流れる

## 未解決

なし

## 変更履歴
