---
kind: tasks
plan: 06-h1-sdk-v2.plan.md
branch: feat/h1-sdk-v2
base: main
---

# 読み取りと記録の MCP サーバーを MCP SDK v1 から v2（@modelcontextprotocol/server 2.2.0）へ移す（#279） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 両サーバーが SDK v2 で動く

依存を v2 に替え、サーバーとテストを移し、v1 と同じ大きさの要求を受け、ツール一覧と `_meta` の扱いが変わらないことをテストで押さえる。

- [x] T01: 依存を @modelcontextprotocol/server 2.2.0 に替え、両サーバーとテストのクライアントを v2 へ移し、バージョンを 0.6.39 にそろえる
  - 種別: 変更
  - 計画: S1, S5
  - 依存: なし
  - 変更: `server/package.json`, `server/bun.lock`, `server/src/mcp.ts`, `server/src/mcp-record.ts`, `server/test/read.test.ts`, `server/test/overview.test.ts`, `server/test/plugin.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `rg -n "@modelcontextprotocol/sdk" server/src server/test server/package.json` → 0 件。`bun run release:plan -- --base v0.6.38` → `release kind: plugin` で 4 か所が 0.6.39。`bun run verify` → exit 0（bundle の予算を超えたら止めて結果欄に実測を書く）
  - コミット: `feat(mcp): move the read and record servers to MCP SDK v2 (T01)`
  - 結果: `rg -n "@modelcontextprotocol/sdk" server/src server/test server/package.json` → 0 件
  - 結果: `cd server && node --test test/plugin.test.ts test/read.test.ts test/overview.test.ts` → 65 pass, 0 fail（forget_apply の確認・拒否・取消・遅れた答えのキャンセルを含む）
  - 結果: `bun run verify` → exit 0。bundle は `mcp.js` 1,650,435 → 1,675,735、`mcp-record.js` 1,737,044 → 1,762,361 バイトで予算の内側

- [x] T02: 受信バッファの上限を外し、10 MiB を超える要求を受けるテストを足す
  - 種別: 修正
  - 計画: S1, S2
  - 依存: T01（v2 の transport が要る）
  - 変更: `server/src/mcp.ts`, `server/src/mcp-record.ts`, `server/test/plugin.test.ts`
  - red: `cd server && node --test --test-name-pattern="10 MiB" test/plugin.test.ts` → 既定の 10 MiB の上限で transport が閉じ、返答が来ずに落ちる
  - 完了条件: `cd server && node --test test/plugin.test.ts` → 全件 pass。足したテストが要求の大きさが 10 MiB を超えることと、その後の呼び出しにも返答が来ることを確かめている
  - コミット: `fix(mcp): accept stdio requests over 10 MiB as SDK v1 did (T02)`
  - 結果: red: 直す前に `cd server && node --test --test-name-pattern="10 MiB" test/plugin.test.ts` → `Error [SdkError]: Connection closed` で 1 fail（記録サーバーだけ・読み取りサーバーだけを元に戻した 2 通りで確かめた）
  - 結果: 直した後 `cd server && node --test --test-name-pattern="10 MiB" test/plugin.test.ts` → 1 pass。要求が 10 MiB を超えることをテストの中で assert している
  - 結果: `bun run verify` → exit 0

- [x] T03: 両サーバーのツール一覧と、ホストの _meta がハンドラーに届くことのテストを足す
  - 種別: 追加
  - 計画: S2
  - 依存: T01（v2 のクライアントで呼ぶ）
  - 変更: `server/test/plugin.test.ts`
  - 完了条件: `cd server && node --test test/plugin.test.ts` → 全件 pass。ツール一覧（名前、description、annotations、required、`additionalProperties: false`）と知らない引数の拒否、`claudecode/toolUseId`・`x-codex-turn-metadata`・Codex の sandbox の cwd のケースを含む
  - コミット: `test(mcp): pin both servers' tool lists and host metadata under SDK v2 (T03)`
  - 結果: `cd server && node --test --test-name-pattern="refuse an argument|logs the caller" test/plugin.test.ts` → 2 pass。18 ツールの required・properties・readOnlyHint・destructiveHint と `additionalProperties: false`、知らない引数の拒否、Claude Code と Codex の caller の列を確かめる
  - 結果: 0.6.38（v1）と T01 の bundle（v2）に SDK のクライアントで `client.listTools()` → 違いは `inputSchema.$schema` が draft-07 から 2020-12 になったことと、各ツールの `execution: {taskSupport: "forbidden"}` が無くなったことだけ
  - 結果: `bun run verify` → exit 0

## P2: SDK が同梱するパッケージを表記とスキャンに載せる

ajv など SDK v2 の中に入って bundle に入る 6 パッケージを THIRD_PARTY_NOTICES・release の SBOM・OSV に載せ、SDK を上げて同梱が変わったら verify が落ちる。

- [x] T04: 同梱パッケージのライセンス文と照合の検査を足し、THIRD_PARTY_NOTICES に載せる
  - 種別: 追加
  - 計画: S3
  - 依存: T01（v2 の配布物が node_modules に要る）
  - 変更: `scripts/licenses/embedded/ajv@8.18.0.txt`, `scripts/licenses/embedded/ajv-formats@3.0.1.txt`, `scripts/licenses/embedded/fast-uri@3.1.0.txt`, `scripts/licenses/embedded/fast-deep-equal@3.1.3.txt`, `scripts/licenses/embedded/json-schema-traverse@1.0.0.txt`, `scripts/licenses/embedded/content-type@1.0.5.txt`, `scripts/licenses/embedded/index.json`, `scripts/lib/embedded.mjs`, `scripts/lib/embedded.d.mts`, `scripts/bundle.mjs`, `scripts/third-party-notices.mjs`, `server/test/embedded.test.ts`
  - 完了条件: `bun run bundle` → exit 0。`index.json` から 1 つを一時的に外すと落ちる（結果欄に実測を残す）。生成した `plugin/THIRD_PARTY_NOTICES.md` に 6 パッケージが載る。`cd server && node --test test/embedded.test.ts` → 全件 pass。`bun run verify` → exit 0
  - コミット: `feat(notices): list the packages MCP SDK v2 embeds in its dist (T04)`
  - 結果: `node scripts/bundle.mjs` → exit 0、`third-party notices: 18 packages`。表に ajv 8.18.0・ajv-formats 3.0.1・content-type 1.0.5・fast-deep-equal 3.1.3・fast-uri 3.1.0・json-schema-traverse 1.0.0 が載り、SDK の LICENSE の licensing transition の前置きが 2 か所（server と core）入る
  - 結果: `index.json` から content-type を一時的に外して `node scripts/bundle.mjs` → `bundle check failed: - the bundles carry content-type 1.0.5 inside the MCP SDK, but scripts/licenses/embedded lacks it`。戻した
  - 結果: `cd server && node --test test/embedded.test.ts` → 4 pass。`bun run verify` → exit 0

- [x] T05: release の SBOM と OSV のスキャンに同梱パッケージを足す
  - 種別: 追加
  - 計画: S3
  - 依存: T04（同梱パッケージの一覧が要る）
  - 変更: `scripts/sbom-embedded.mjs`, `scripts/lib/sbom.mjs`, `scripts/lib/sbom.d.mts`, `server/test/sbom.test.ts`, `.github/workflows/release.yml`
  - 完了条件: `cd server && node --test test/sbom.test.ts` → 全件 pass。足した component と dependencies を `sbomProblems` が通すケースを含む。`actionlint .github/workflows/release.yml` → 指摘なし
  - コミット: `ci(release): add the SDK's embedded packages to the SBOM and the OSV scan (T05)`
  - 結果: `cd server && node --test test/sbom.test.ts` → 8 pass（足した 3 件: SDK の依存として加えた後に notices と一致する、SDK の無い SBOM と既に載っている SBOM を拒む、purl の形）
  - 結果: `node scripts/sbom-embedded.mjs --only-embedded <tmp>/embedded.cdx.json` を手元の osv-scanner 2.3.6 で `-L` → `found 6 packages`、結果の JSON に 6 つが npm の ecosystem で出る
  - 結果: `actionlint .github/workflows/release.yml` → 指摘なし。`bun run verify` → exit 0。release の dry run での確かめは PR の CI（plan の A5）

## P3: 梱包した両サーバーを Windows で確かめる

Windows の CI で、梱包した `mcp.js` と `mcp-record.js` の両方が tools/list と tools/call に答えることを見る。

- [x] T06: Windows の job に梱包した mcp-record.js の起動と、両サーバーの tools/call を足す
  - 種別: 追加
  - 計画: S4
  - 依存: T01（v2 で梱包したサーバーが要る）
  - 変更: `.github/workflows/check.yml`
  - 完了条件: `actionlint .github/workflows/check.yml` → 指摘なし。同じ送り方を手元で梱包した `plugin/dist/mcp.js` と `plugin/dist/mcp-record.js` に流す → 両方で tools/list に目当てのツールがあり、id 3 の tools/call に result が返る（Windows の実際の結果は plan の A6 で見る）
  - コミット: `ci(check): start the packed record server on Windows and call a tool on both (T06)`
  - 結果: `actionlint .github/workflows/check.yml` → 指摘なし
  - 結果: 同じループを手元で `node plugin/dist/<entry>.js` → 読み取りは `This directory is not in a registered project`、記録は `The host did not say which workspace` の result が id 3 で返った。stdin をすぐ閉じても今回は 3 つとも返ったが、SDK の注記どおり処理中の要求は閉じると落ちるので 5 秒開けておく

- [x] T08: 読めない region の印と、SDK のファイルが 1 つも無い bundle を照合で落とす
  - 種別: 修正
  - 計画: S3
  - 依存: T04（照合の仕組みが要る）
  - 変更: `scripts/lib/embedded.mjs`, `server/test/embedded.test.ts`
  - red: `cd server && node --test test/embedded.test.ts` → 足した 2 件（`./node_modules/.pnpm/` で始まる印、SDK の入力が無い metafile）で問題が返らず落ちる
  - 完了条件: `cd server && node --test test/embedded.test.ts` → 全件 pass。`bun run bundle` → exit 0
  - コミット: `fix(notices): fail the embedded check on unreadable markers and on bundles without the SDK (T08)`
  - 結果: red: 直す前に `cd server && node --test test/embedded.test.ts` → 足した 2 件が落ちた（4 pass, 2 fail）
  - 結果: 直した後 `cd server && node --test test/embedded.test.ts` → 6 pass。metafile の無い場合の期待に「SDK のファイルが無い」も加わった
  - 結果: `bun run verify` → exit 0（bundle の照合は今の 6 パッケージで通る）

## P4: structuredContent の注記を実測に合わせる

両ホストで structuredContent を持つ返答の扱いを測り、`server/src/mcp.ts` の注記を確かめた範囲に書き直す。

- [ ] T07: structuredContent の扱いを両ホストで実測し、mcp.ts の注記を書き直す
  - 種別: 変更
  - 計画: S6
  - 依存: T01（v2 のサーバーの注記を直す）
  - 変更: `server/src/mcp.ts`
  - 完了条件: 使い捨ての fixture を 3 回ずつ `claude -p` と `codex exec` → 3 つの形でモデルが受け取った内容を結果欄に書き、`server/src/mcp.ts` の注記がそれに合う。`bun run verify` → exit 0
  - コミット: `docs(mcp): state what the hosts showed for structuredContent under SDK v2 (T07)`

## 記録
- 2026-10-06 / T01 / Codex のタスクごとのレビューは指摘なし / そのまま
- 2026-10-06 / T02 / Codex のタスクごとのレビューは指摘なし / そのまま
- 2026-10-06 / T04 / @cfworker/json-schema は bundle に入らない（metafile で確認）。変更欄から `scripts/licenses/embedded/@cfworker+json-schema@4.1.1.txt` を外し、完了条件の 7 パッケージを 6 に / plan の方針と変更履歴も直した
- 2026-10-06 / T04 / 変更欄: 前は `scripts/check-embedded.mjs`, `package.json` を含む。新しくは `scripts/licenses/embedded/index.json`, `scripts/lib/embedded.mjs`, `scripts/lib/embedded.d.mts`, `scripts/bundle.mjs`, `server/test/embedded.test.ts` を足し、その 2 つを外した。完了条件も `node scripts/check-embedded.mjs` から `bun run bundle` に / 照合を bundle の中で流すため（plan の変更履歴）
- 2026-10-06 / T05 / 変更欄: 前は `scripts/sbom-embedded.mjs`, `server/test/sbom.test.ts`, `.github/workflows/release.yml`。新しくは `scripts/lib/sbom.mjs` と `scripts/lib/sbom.d.mts` を足した / 足す処理を CLI ではなく既存の SBOM の lib に置いてテストするため
- 2026-10-06 / T06 / 完了条件: 前は「PR の CI の Windows job のログで…通る」。新しくは actionlint と手元での同じ送り方 / check の workflow は PR でしか走らず、Windows の結果は plan の A6 と重なるため
- 2026-10-06 / T04 / Codex のタスクごとのレビューで P2 が 2 件（読めない region の印を黙って飛ばす、SDK の入力が 0 件でも通る）。どちらも空振りで通る穴なので T08 を足して直す。node_modules 以外から SDK のファイルが入る場合の指摘は、bundle が SDK を node_modules から解決するので見送る / T08 を追加
