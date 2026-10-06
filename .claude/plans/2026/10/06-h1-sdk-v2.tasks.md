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
  - 結果: 0.6.38（v1）と T01 の bundle（v2）の tools/list を比べると、違いは `inputSchema.$schema` が draft-07 から 2020-12 になったことと、各ツールの `execution: {taskSupport: "forbidden"}` が無くなったことだけ
  - 結果: `bun run verify` → exit 0

## P2: SDK が同梱するパッケージを表記とスキャンに載せる

ajv など SDK v2 の中に入っている 7 パッケージを THIRD_PARTY_NOTICES・release の SBOM・OSV に載せ、SDK を上げて同梱が変わったら verify が落ちる。

- [ ] T04: 同梱パッケージのライセンス文と照合の検査を足し、THIRD_PARTY_NOTICES に載せる
  - 種別: 追加
  - 計画: S3
  - 依存: T01（v2 の配布物が node_modules に要る）
  - 変更: `scripts/licenses/embedded/ajv@8.18.0.txt`, `scripts/licenses/embedded/ajv-formats@3.0.1.txt`, `scripts/licenses/embedded/fast-uri@3.1.0.txt`, `scripts/licenses/embedded/fast-deep-equal@3.1.3.txt`, `scripts/licenses/embedded/json-schema-traverse@1.0.0.txt`, `scripts/licenses/embedded/content-type@1.0.5.txt`, `scripts/licenses/embedded/@cfworker+json-schema@4.1.1.txt`, `scripts/check-embedded.mjs`, `scripts/third-party-notices.mjs`, `package.json`
  - 完了条件: `node scripts/check-embedded.mjs` → exit 0。一覧から 1 ファイルを一時的に外すと落ちる（結果欄に実測を残す）。`bun run notices` → exit 0 で、生成した notices に 7 パッケージが載る。`bun run verify` → exit 0
  - コミット: `feat(notices): list the packages MCP SDK v2 embeds in its dist (T04)`

- [ ] T05: release の SBOM と OSV のスキャンに同梱パッケージを足す
  - 種別: 追加
  - 計画: S3
  - 依存: T04（同梱パッケージの一覧が要る）
  - 変更: `scripts/sbom-embedded.mjs`, `server/test/sbom.test.ts`, `.github/workflows/release.yml`
  - 完了条件: `cd server && node --test test/sbom.test.ts` → 全件 pass。足した component と dependencies を `sbomProblems` が通すケースを含む。`actionlint .github/workflows/release.yml` → 指摘なし
  - コミット: `ci(release): add the SDK's embedded packages to the SBOM and the OSV scan (T05)`

## P3: 梱包した両サーバーを Windows で確かめる

Windows の CI で、梱包した `mcp.js` と `mcp-record.js` の両方が tools/list と tools/call に答えることを見る。

- [ ] T06: Windows の job に梱包した mcp-record.js の起動と、両サーバーの tools/call を足す
  - 種別: 追加
  - 計画: S4
  - 依存: T01（v2 で梱包したサーバーが要る）
  - 変更: `.github/workflows/check.yml`
  - 完了条件: `actionlint .github/workflows/check.yml` → 指摘なし。PR の CI の Windows job のログで、両サーバーの tools/list と tools/call の返答の確かめが通る
  - コミット: `ci(check): start the packed record server on Windows and call a tool on both (T06)`

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
