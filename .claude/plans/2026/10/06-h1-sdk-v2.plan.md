---
kind: plan
status: approved
codex_session: 01a11125-a985-7042-a911-c7e8dab5ed11
codex_rounds: 3
approved_at: 2026-10-06
---

# 読み取りと記録の MCP サーバーを MCP SDK v1 から v2（@modelcontextprotocol/server 2.2.0）へ移す（#279）

## 要点

- 依存を `@modelcontextprotocol/sdk` 1.x から `@modelcontextprotocol/server` 2.2.0（固定）へ替え、テストのクライアントは devDependency の `@modelcontextprotocol/client` 2.2.0 にする。express・hono・jose などの v1 の依存がなくなる
- 両サーバーは 2025 年版の手書きの stdio 接続のまま移す。Claude Code は 2026-07-28 版の `server/discover` を先に試し、Method not found で 2025 年版へ戻るので、今と同じ版で動き、`forget_apply` の確認ダイアログ（elicitInput）も書き換えずに済む
- 変えないもの: ツールの名前・引数・返答の意味、ホストの `_meta` の扱い、受け取れるリクエストの大きさ（v2 の 10 MiB の上限は外して v1 と同じにする）
- v2 は ajv など 6 個のパッケージを自分の配布物の中に同梱して bundle に入るので、そのライセンス文をリポジトリに置き、THIRD_PARTY_NOTICES・release の SBOM・OSV のスキャンに載せ、SDK を上げて同梱が変わったら verify が落ちるようにする
- 実装の塊: 依存とサーバーとテストの移行 → 同梱パッケージの notices / SBOM / OSV → 梱包したサーバーの検査（Windows を含む）と bundle の予算 → 0.6.39 で release
- 確かめ: 両ホストの headless で読み取りと記録を一時の SPHICA_HOME で通し、structuredContent の扱いを実測して mcp.ts の注記を直す。Claude Code の対話での forget の確認は持ち主に 1 回流してもらう

## 持ち主の決定

- 次の作業は epic #200 の Phase 02 の H1 #279 にする（2026-10-06、「OK、それで進めよう」）
- #279 の要求: 両サーバーを SDK v2 へ移し、`sql:live`・acceptance・本物の Claude Code と Codex のセッション（CLI と MCP は別々に）で確かめる。bundle の前後を測って PR に書く。mcp.ts の structuredContent の注記を確かめ直す

## 目的

- 梱包した 0.6.39 の `mcp.js` と `mcp-record.js` が `@modelcontextprotocol/server` 2.2.0 で動き、Claude Code 2.1.291 と codex-cli 0.160.x の両方で、今と同じツール一覧と返答、同じ caller の記録になる
- THIRD_PARTY_NOTICES と release の SBOM に、SDK が同梱するパッケージが名前とバージョンつきで載り、OSV のスキャン結果にも載る
- bundle の前後のバイト数とその内訳が PR にある

## 対象外

- 2026-07-28 版の配信（`serveStdio` と、`forget_apply` の `inputRequired` と署名した `requestState` への書き換え）。ホストが 2026-07-28 版しか受け付けなくなったとき、または対応を足すと決めたときの別 issue にする
- リクエストの大きさの上限を新しく決めること（公開の引数の上限が変わる）
- 2.3.x への更新（10/12 に公開から 7 日を過ぎる。別の依存更新で扱う）
- #289（overview live と review_select の返答の大きさ）

## 前提

- npm（2026-10-06）: `@modelcontextprotocol/server` 2.2.0 は 2026-09-28T19:09Z 公開、2.3.0 は 10-02、2.3.1 は 10-05。`server/bunfig.toml:3` の `minimumReleaseAge = 604800` で、今入れられるのは 2.2.0 まで。server・core・client 2.2.0 の maintainers は sdk 1.32.1 と同じ 5 人（client は 1 人多い）で、どれも SLSA v1 の provenance がある。server 2.2.0 の依存は core 2.2.0 と zod ^4.2.0 だけ、engines は node >=20
- v2 の文書（v2.2.0 タグの `docs/migration/upgrade-to-v2.md` と `support-2026-07-28.md`）: `extra._meta` → `ctx.mcpReq._meta`、`extra.signal` → `ctx.mcpReq.signal`。手書きの `server.connect(new StdioServerTransport())` は 2025 年版だけを配信する。2026 年版の要求では `elicitInput` が例外になる
- 実測（2026-10-06、v1 の今の bundle を透過のプロキシで挟み、一時の SPHICA_HOME で headless）:
  - Claude Code 2.1.291: 最初に `server/discover`（2026-07-28）を送り、-32601 が返ると `initialize`（2025-11-25）を送る。capabilities に `elicitation: {form, url}` がある
  - codex-cli 0.160.1: 最初から `initialize`（2025-06-18）。capabilities に `elicitation: {form, url}` がある。`tools/call` の `_meta` に `x-codex-turn-metadata` が入る
- 実測（2026-10-06、v2 2.2.0 の最小のサーバー）: 手書きの接続は `server/discover` に -32601 を返し、`initialize` 2025-11-25 に応じ、`claudecode/toolUseId` と `x-codex-turn-metadata` を `ctx.mcpReq._meta` に渡し、`.strict()` の知らない引数を isError の返答で拒否した。`serveStdio` は `server/discover` に応じる（Claude Code が 2026 年版で接続するようになる）
- v2 の stdio は受信バッファが既定で 10 MiB を超えると transport を閉じる（`src-BHSMhZ_W.mjs` の `ReadBuffer.append`、比較は `buffer + chunk > max`）。v1 は上限なし。record_check は 11 MiB を超える要求を schema の上で受け付ける（Codex の実測）
- v2 の配布物は ajv 8.18.0、ajv-formats 3.0.1、fast-uri 3.1.0、fast-deep-equal 3.1.3、json-schema-traverse 1.0.0、content-type 1.0.5、@cfworker/json-schema 4.1.1（workerd 用の shim だけ）を `//#region ../../node_modules/.pnpm/<name>@<version>/` の印つきで同梱している。core には無い。`scripts/third-party-notices.mjs` は宣言された依存だけをたどるので、今のままでは載らない
- release の SBOM は `.github/workflows/release.yml` の `sbom` job が syft で `server/` の lockfile から作り、`prepare` が `check-sbom` で notices と比べ、publish がその artifact を attest する。`osv` job は `sbom` に依存せず、osv-scanner 2.6.0 は CycloneDX（`-L <file>.cdx.json`）を読める（v2.6.0 の docs/scan-source.md）
- Codex は MCP の子プロセスの env を許可リストで絞り、`SPHICA_HOME` は通らない（codex rust-v0.160.0 の `rmcp-client/src/utils.rs`）。`server/src/sqlite.ts:26-29` は `SPHICA_DB` を `SPHICA_HOME` より優先する
- 変更前の bundle（main 62794f28、`bun run bundle`）: `mcp.js` 1,650,435 バイト、`mcp-record.js` 1,737,044 バイト。内訳は zod 785,695、kysely 約 293,000、ajv 193,631、`@modelcontextprotocol/sdk` 119,150、fast-uri 39,415、zod-to-json-schema 38,654、ajv-formats 14,572
- 未検証: 移行後の bundle の大きさ。ホストが structuredContent を持つ返答でテキストをモデルへ渡すか（S6 で実測）

## 方針

- 依存: `server/package.json` の dependencies の `@modelcontextprotocol/sdk` を外し、`"@modelcontextprotocol/server": "2.2.0"` を足す。devDependencies に `"@modelcontextprotocol/client": "2.2.0"`。`server/bun.lock` を作り直す
- サーバー（`server/src/mcp.ts`、`server/src/mcp-record.ts`）:
  - import は `McpServer` を `@modelcontextprotocol/server`、`StdioServerTransport` を `@modelcontextprotocol/server/stdio` から
  - ハンドラーの第 2 引数を `ctx` にし、`ctx.mcpReq._meta` と `ctx.mcpReq.signal` を読む。`capabilities.experimental["codex/sandbox-state-meta"]`、instructions、annotations、テキストだけの返答、workspace と caller の優先順は変えない
  - `forget_apply` は `server.server.getClientCapabilities()` と `server.server.elicitInput` のまま（2025 年版の接続では動く。v2 では deprecated の注記がつく）。型が変わった所だけ直す
  - 接続は `await server.connect(new StdioServerTransport(undefined, undefined, { maxBufferSize: Number.POSITIVE_INFINITY }))`。上限を外す理由を 1 行のコメントで書く（超えるとセッションごと切れ、v1 には上限が無かった）
- テスト: `server/test/read.test.ts`、`overview.test.ts`、`plugin.test.ts` のクライアントを `@modelcontextprotocol/client`（`Client`）と `@modelcontextprotocol/client/stdio`（`StdioClientTransport`）へ。`callTool` の signal は第 2 引数へ。elicitation は `setRequestHandler("elicitation/create", ...)` で v2 の結果型を返し、`as never` をやめる。遅れて届いた答えのキャンセルのテストと DB の確かめは残す
- 足すテスト（`server/test/plugin.test.ts`）:
  - 両サーバーのツール一覧（名前、description、annotations、required、`additionalProperties: false`）をテストに書いた期待と比べ、知らない引数が今までどおり拒否される
  - `_meta` の `claudecode/toolUseId`、`x-codex-turn-metadata`、Codex の sandbox の cwd がハンドラーに届く（今の caller と workspace のテストが v2 の経路で通ること）
  - 直列化して 10 MiB を超える `record_check` の要求に、通常の返答（拒否か判定）が返り、その後の呼び出しにもサーバーが答える。要求が 10 MiB を超えていることもテストで確かめる
- 同梱パッケージ:
  - 一覧はリポジトリに置くライセンス文のファイル `scripts/licenses/embedded/<name>@<version>.txt`（scoped は `@scope+name@version.txt`）。それぞれそのバージョンの npm tarball から 1 回写す
  - 照合は `scripts/lib/embedded.mjs` に置き、`scripts/bundle.mjs` が予算の検査と並べて流す（metafile のある所で、release の build でも必ず通る）。`.build/meta-<entry>.json` から bundle に入った `@modelcontextprotocol/*/dist/` のファイルを取り、その region の印を読み、`_ajv@…` のような pnpm の peer の接尾辞を外して名前とバージョンにし、一覧と完全に一致しなければ落ちる。metafile が無ければ落ちる（飛ばさない）。workerd 用の @cfworker/json-schema は bundle に入らないので載せない
  - `scripts/third-party-notices.mjs` は npm で解決したパッケージの後に一覧の各パッケージを表とライセンス文に足す
  - 新しい `scripts/sbom-embedded.mjs <in.cdx.json> <out.cdx.json>` は一覧の各パッケージを top-level の `library` の component（`purl` は `pkg:npm/<name>@<version>`）として足し、`dependencies` に同梱元の SDK パッケージからの関係を足す。`--only-embedded <out>` は一覧だけの CycloneDX を書く
  - release.yml: `sbom` job に setup-node を足し、syft の直後に `sbom-embedded.mjs` を流して、足した後の file だけを upload する（`prepare` の check-sbom と publish の attest が同じ artifact を見る）。`osv` job は `sbom` に依存させず、setup-node をスキャンの前に移し、`--only-embedded` で書いた file を `-L <file>.cdx.json` で `-r` と並べて渡す。`sbomProblems` は変えない
- 梱包と Windows: `.github/workflows/check.yml` の Windows job で、梱包した `mcp.js` の起動の確認の隣に `mcp-record.js` を足し、両方で tools/list と 1 回の tools/call を `process.execPath` で流す
- bundle: `scripts/lib/bundle-budget.mjs` の `BUDGETS` は実測で変わったときだけ、理由を件名に書いたコミットで直す
- structuredContent: 出荷しない使い捨ての fixture サーバー（scratchpad）に、テキストだけ・structuredContent だけ（content は空）・両方（別々の目印）の 3 つのツールを outputSchema なしで置き、両ホストの headless で 3 回ずつ受け取った内容を答えさせる。結果に合わせて `server/src/mcp.ts:4` の注記を、確かめたバージョンと形の範囲に書き直す（裏付けられれば残す）
- 実機の確かめは、ホストの子プロセスへ `SPHICA_HOME=<一時>` を渡し `SPHICA_DB` を消す透過のプロキシ（scratchpad。両方向をバイトのまま転送し、最初の数行を一時のログへ写す。protocol の stdout にはログを出さない）で行う。終わったあと持ち主の `~/.sphica` の DB と spool が変わっていないことを確かめる
- release: `bun run release:plan -- --base v0.6.38` で種別を見てから、npm と 3 つの plugin manifest と marketplace を 0.6.39 にそろえる（最初にパッケージの入力を変えるコミットに入れる）。`plugin-release` の手順どおり

## 採った案と棄却した案

- 採用: 2025 年版の手書きの stdio 接続。棄却: `serveStdio`（Claude Code が 2026 年版で接続するようになり、`forget_apply` を `inputRequired` と署名した `requestState` へ書き換える必要が出る）
- 採用: 2.2.0 に固定。棄却: 10/12 まで待って 2.3.1（今入れられない。上げるのは別の依存更新で足りる）
- 採用: テストは SDK v2 の client を devDependency で使う。棄却: 手書きの JSON-RPC クライアント（保守が増える）
- 採用: 受信バッファの上限を Infinity にして v1 と同じにする。棄却: 既定の 10 MiB（超えるとセッションごと切れる）、有限の大きな値（公開の上限が新しくできる）
- 採用: 同梱パッケージはライセンス文のファイルを一覧にし、verify で bundle の metafile が示すチャンクの印と照らす（sbom と osv の job は一覧だけを読む）。棄却: sbom と osv の job が metafile を読む（bundle に依存し、job の順序が崩れる）、インストール済みの dist 全部の印と照らす（bundle に入らない workerd 用のパッケージまで載る）、同梱パッケージを通常の依存として入れる（出荷の形と違う）
- 採用: osv は `sbom` に依存させず、一覧だけの CycloneDX を自分で書いて読ませる。棄却: `osv` を `sbom` の後にする（sbom が落ちると「スキャン結果なし」の行が出なくなる）

## 手順

- S1: 依存を v2 へ替え、両サーバーのハンドラーと接続を移し、受信バッファの上限を外す
- S2: テストのクライアントを v2 へ移し、ツール一覧・`_meta`・大きな要求のテストを足す
- S3: 同梱パッケージの一覧・照合の検査・notices・SBOM への追加・OSV への入力
- S4: 梱包した両サーバーの検査を Windows の CI に足し、bundle を測って予算を直す
- S5: バージョンを 0.6.39 にそろえる
- S6: structuredContent の実測と mcp.ts の注記の書き直し

## 完了条件

- A1: `bun run verify` → exit 0（最後の HEAD で）
- A2: `cd server && node --test test/plugin.test.ts` → 足したツール一覧・`_meta`・10 MiB を超える要求のテストを含めて全件 pass
- A3: `bun run bundle` → exit 0。`scripts/licenses/embedded/index.json` から 1 つ消すと `bundle check failed` で落ちることを確かめる
- A4: `rg -n "ajv|ajv-formats|fast-uri|fast-deep-equal|json-schema-traverse|content-type|licensing transition" plugin/THIRD_PARTY_NOTICES.md` → 同梱の 6 パッケージが表とライセンス文に載り、`@modelcontextprotocol/server` と core の LICENSE が移行の前置きを含めてそのまま載る
- A5: `gh workflow run release.yml --ref <PR の head>` → `sbom` の artifact に同梱の 6 パッケージがあり、`prepare` の check-sbom が通り、`osv` の結果 JSON（`--all-packages`）に同梱のパッケージがスキャンした対象として出る
- A6: `gh pr checks <PR>` → Linux（Node 24.15 と 26）と Windows が全部 pass し、Windows のログで梱包した `mcp.js` と `mcp-record.js` の tools/list と tools/call が通っている
- A7: リポジトリの外で展開した `npm pack` の tarball の `node plugin/dist/mcp.js` と `node plugin/dist/mcp-record.js` → node_modules の無い場所で一時の DB に向けて SDK のクライアントで呼び、両方で initialize・tools/list・tools/call が返る
- A8: 梱包した v2 のサーバーを挟んだプロキシで `claude -p --mcp-config <プロキシの設定>` と `codex exec -c mcp_servers.<プロキシ>` → ログで Claude Code 2.1.291 は `server/discover` に -32601 が返って `initialize` 2025-11-25 に戻り、Codex は `initialize` 2025-06-18 で接続している
- A9: プロキシで一時の SPHICA_HOME を渡し `SPHICA_DB` を消して、status・search・read と trace_begin・record_context・record_check・record_save を `claude -p` と `codex exec` → すべて返り、一時の DB の caller の列（host・session・turn・tool use id・mode）が今と同じ形で入り、Claude では hook の観測との結び付き（`server/src/trace.ts:179`）もできている。持ち主の `~/.sphica` の DB と spool の更新時刻は変わらない
- A10: CLI は MCP と別に `HOME=<一時> sphica init` と `HOME=<一時> sphica doctor` → どちらも通る
- A11: 持ち主が対話で、使い捨てのリポジトリで /sphica:forget を `SPHICA_HOME=<一時> claude` → 確認に違う数を打つと何も消えず、正しい数を打つと消える。流さない限り完了としない
- A12: structuredContent の fixture を 3 回ずつ `claude -p` と `codex exec` → 結果（ホストのバージョンと 3 回ずつの内容）が PR にあり、`server/src/mcp.ts` の注記がそれに合う
- A13: main（62794f28）と PR の head で `bun run bundle` → 前後のバイト数と package ごとの内訳が、比べたコミットとツールのバージョンとともに PR にある
- A14: release の後に `bun run release:status` → consistent。release の run が全 job success、merge 後の main の OSV と Scorecard の run が success

## リスク

- 次の Claude Code が 2026 年版だけで接続するようになる → `forget_apply` の `inputRequired` 化を含む 2026 年版の配信を別 issue で先に進める（A8 のログが変わったら気づける）
- v2 の JSON Schema の出し方（2020-12）でホストのツールの読み込みが変わる → A2 と A8・A9 で一覧と呼び出しを見る。読み込めないホストがあれば止めて計画に戻る
- 存在しないツールの呼び出しが isError の返答から -32602 のエラーに変わる → Sphica の呼び出し側に依存が無いことを `rg` で確かめ、PR に書く
- bundle が小さくならない（ajv が SDK の中に残る）→ 実測をそのまま PR に書く。予算は実測に合わせる
- 同梱パッケージのライセンス文が npm tarball に無い → README の該当節から取る（`third-party-notices.mjs` の方針どおり）。それでも無ければ止めて持ち主に聞く

## 未解決

なし

## 変更履歴

- 2026-10-06 / 照合の対象を、インストール済みの dist 全部から bundle の metafile が示すチャンクへ狭め、@cfworker/json-schema を一覧から外した / bundle に入っていないこと、tarball にライセンス文が無く中に punycode 由来のコードがあることを metafile と tarball で確かめた / Go は要らない（範囲・公開インターフェース・依存は変わらない）
- 2026-10-06 / 照合を新しい `scripts/check-embedded.mjs` ではなく `scripts/bundle.mjs` の中（予算の検査の隣）で流し、一覧に名前・ライセンス・出どころを持つ `scripts/licenses/embedded/index.json` を足した。A3 を `bun run bundle` に / metafile が必ずある所で動き、release の build でも飛ばせない。notices の表に SPDX と出どころが要る / Go は要らない
- 2026-10-06 / 保留: merge と release をしない / SDK v2（2.2.0〜2.3.1）は fast-uri 3.1.0（既知の脆弱性 9 件、修正は 3.1.8）と ajv 8.18.0 を dist に埋め込んでいて overrides で上げられず、0.6.38 の 3.1.8 から後退するため。再開の条件は、SDK が同梱の fast-uri を 3.1.8 以上にした版を公開し、その版が minimumReleaseAge を過ぎたとき / 持ち主の判断（保留して上流を待つ）
- 2026-10-06 / 上流に issue を立てた（https://github.com/modelcontextprotocol/typescript-sdk/issues/2966）。#279 にも保留と再開の条件をコメントした / 再開の目安を追えるようにするため / Go は要らない
