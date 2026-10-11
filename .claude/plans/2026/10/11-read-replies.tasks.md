---
kind: tasks
plan: 11-read-replies.plan.md
branch: fix/read-replies
base: main
---

# git の worker が断った理由を伝え、読み取りサーバーの返答を 32 KiB に収める（#323、#303） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: worker が断った理由を伝える（#323）

レビューの返答・rename の注記・`sphica doctor` が、git の worker が置き場を断った理由を言うようになる。

- [ ] T01: worker の断りをコードで返し、レビューの返答と rename の注記がその理由を言う。バージョンを 0.6.49 に上げる
  - 種別: 修正
  - 計画: S1, S2, S12
  - 依存: なし
  - 変更: `server/src/git-worker.ts`, `server/src/git.ts`, `server/src/review-bridge.ts`, `server/src/read.ts`, `server/src/worktree.ts`, `server/test/git-worker.test.ts`, `server/test/review-bridge.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - red: `node --import ./test/isolate-home.ts --test test/review-bridge.test.ts` → HOME を一時ディレクトリの下に置いた場合の新しいテストが、直す前は「in time, or is too large」を受け取って落ちる
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(review): say why the git worker would not start, and bump to 0.6.49`

- [ ] T02: worker に置き場だけを確かめる操作を足し、`sphica doctor` がその結果を 1 行で出す
  - 種別: 追加
  - 計画: S3
  - 依存: T01（断りのコードと説明文の関数が要る）
  - 変更: `server/src/git-worker.ts`, `server/src/git.ts`, `server/src/cli.ts`, `server/test/git-worker.test.ts`, `server/test/cli.test.ts`
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `feat(doctor): report whether the git worker can use its directory`

## P2: 読み取りサーバーの返答を 32 KiB に収める（#303）

`search`・`review_check`・`export`・`fields`・`asked` と、SDK が作るエラーの返答が、どんな入力でも 32 KiB に収まり、止めたときは続きの読み方を言う。

- [ ] T03: 予算の計算を共有する関数を置き、`search`（通常と sources）の返答を収める
  - 種別: 修正
  - 計画: S4, S5
  - 依存: T01（バージョンが上がっていないと、パッケージに入るファイルのコミットが拒否される）
  - 変更: `server/src/text.ts`, `server/src/search.ts`, `server/src/mcp.ts`, `server/test/plugin.test.ts`, `server/test/search.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/plugin.test.ts` → 長い option を持つ記録と、長い artifact の発言 20 件で、`search` の返答が 32 KiB を超えて落ちる
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(search): keep search replies within the reply budget`

- [ ] T04: `review_check` の返答を収め、バッチの全記録の状況を先頭に必ず出す
  - 種別: 修正
  - 計画: S6
  - 依存: T03（予算の計算の関数が要る）
  - 変更: `server/src/review-findings.ts`, `server/src/mcp.ts`, `server/test/plugin.test.ts`, `server/test/review.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/plugin.test.ts` → 約 1 KB のキー 50 件の未判定で、`review_check` の返答が 32 KiB を超えて落ちる
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(review): keep review_check replies within the reply budget`

- [ ] T05: `export` を、返答全体が 32 KiB に収まるときだけ成功にし、拒否の返答も収める
  - 種別: 修正
  - 計画: S7
  - 依存: T03（予算の計算の関数が要る）
  - 変更: `server/src/export.ts`, `server/src/mcp.ts`, `server/test/plugin.test.ts`, `server/test/export.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/plugin.test.ts` → 40 KiB の文書になる選び方で、`export` の返答が 32 KiB を超えて落ちる
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(export): refuse a document the reply budget cannot carry whole`

- [ ] T06: `fields` に `after` を足し、ページで返す
  - 種別: 修正
  - 計画: S8
  - 依存: T03（予算の計算の関数が要る）
  - 変更: `server/src/fields.ts`, `server/src/mcp.ts`, `server/test/plugin.test.ts`, `server/test/fields.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/plugin.test.ts` → 定義を多数持つプロジェクトで、`fields` の返答が 32 KiB を超えて落ちる
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(fields): page the fields table within the reply budget`

- [ ] T07: `asked` の返答を、セッションの一覧と案内も含めて収める
  - 種別: 修正
  - 計画: S9
  - 依存: T03（予算の計算の関数が要る）
  - 変更: `server/src/asked.ts`, `server/src/mcp.ts`, `server/test/plugin.test.ts`, `server/test/asked.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/plugin.test.ts` → 繰り返しのセッションが多い質問で、`asked` の返答が 32 KiB を超えて落ちる
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(asked): keep asked replies within the reply budget`

- [ ] T08: SDK が作るエラーの返答を、transport の `send` を包んで収める
  - 種別: 修正
  - 計画: S10
  - 依存: T03（予算の計算の関数が要る）
  - 変更: `server/src/mcp.ts`, `server/test/plugin.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/plugin.test.ts` → 未知のツール名 40 KB と、未知のプロパティ名 40 KB の呼び出しで、エラーの返答が 32 KiB を超えて落ちる
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `fix(mcp): keep the read server's error replies within the reply budget`

## P3: 文書を合わせる

ツールの説明、Skill、README が、新しい返答の形と読み方を言う。

- [ ] T09: description・`fields` と `export` の Skill・README を新しい返答に合わせる
  - 種別: 変更
  - 計画: S11
  - 依存: T05（`export` の上限が決まっている）, T06（`fields` の `after` がある）
  - 変更: `server/src/mcp.ts`, `plugin/skills/fields/SKILL.md`, `plugin/skills/export/SKILL.md`, `README.md`, `README.ja.md`
  - 完了条件: `bun run verify` → 終了コード 0
  - コミット: `docs(read): describe the reply budget, fields paging, and the export limit`

## 記録
