---
kind: tasks
plan: 05-f1-windows-hooks.plan.md
branch: feat/f1-windows-hooks
base: main
---

# Codex のフックを特殊な文字を含むプラグインパスでも Windows で動かし、doctor が Codex のフックの信頼の状態を出す（#262・#276） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 先に red を見る

Windows の CI で、今の codex.json が空白入りのプラグインのパスで落ちることを、CI のバージョンの検査に邪魔されずに見られる

- [x] T01: release:plan で種別を確かめ、npm と 3 つの manifest を 0.6.31 に揃える
  - 種別: 変更
  - 計画: S6
  - 依存: なし
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run release:plan -- --base f5103885` → 4 か所が 0.6.31、`bun run verify` → 終了コード 0
  - コミット: `chore(release): bump to 0.6.31`
  - 結果: `bun run release:plan -- --base f5103885` → `version: npm 0.6.31 / plugin 0.6.31 / marketplace 0.6.31 / Codex 0.6.31`、kind は none（まだ package の入力を変えていない）。`bun run verify` → exit 0
- [x] T02: check-hooks-live に、Codex のフックを外側のシェルとプラグインのパスごとに起動する部を足す
  - 種別: 追加
  - 計画: S1
  - 依存: T01（バージョンを上げておかないと PR の CI がバージョンの検査で落ち、red の理由が混ざる）
  - 変更: `scripts/check-hooks-live.mjs`
  - 完了条件: `bun run hooks:live` → macOS で終了コード 0（sh の外側で全コピー・全エントリが通り、各ケースの目印が spool に届く）。push して PR を作り、Windows のジョブが Codex の部で落ちる（T03 の red）
  - コミット: `test(hooks): launch every Codex hook through each outer shell and plugin path`
  - 結果: `bun run hooks:live` → macOS で exit 0（sh × control・spaced で 18 件）。感度: 引用符を外した codex.json のコピーで `node scripts/check-hooks-live.mjs <copy>` → spaced/sh の 6 件だけが落ち、control は通った。Windows の red は push 後に T03 の red で確かめる

## P2: Codex のフックを直す

空白や `$`・`%` を含むプラグインのパスでも、Windows のどの外側のシェルからも Codex のフックが動く

- [ ] T03: codex.json の commandWindows を EncodedCommand にし、包みのケースと check-ai-config を直す
  - 種別: 修正
  - 計画: S2
  - 依存: T02（直す前に落ちることを示す検査が要る）
  - 変更: `plugin/hooks/codex.json`, `scripts/check-hooks-live.mjs`, `scripts/check-ai-config.mjs`
  - red: `gh run view <T02 の head の check の run> --log-failed` → Windows のジョブで、対照が powershell.exe・pwsh で通り、空白入りのコピーが `Cannot find module` で落ちている
  - 完了条件: `bun run verify` → 終了コード 0。push 後の Windows のジョブ → 全コピー・全外側のシェルで全エントリが終了コード 0、各ケースの目印が spool に届き、包みのケースが期待どおり
  - コミット: `fix(hooks): pass the plugin root to Codex's Windows hooks through the environment`

## P3: doctor が Codex のフックの信頼を出す

`sphica doctor` に「Codex hooks」の行が出て、trusted / modified / untrusted / disabled / unknown が分かる

- [ ] T04: smol-toml を足し、Codex と同じハッシュを出す純粋関数とテストを書く
  - 種別: 追加
  - 計画: S3
  - 依存: T03（Windows の手書きの期待値は出荷する EncodedCommand の文字列から作る）
  - 変更: `server/package.json`, `bun.lock`, `server/src/codex-trust.ts`, `server/test/codex-trust.test.ts`, `server/test/fixtures/codex-trust/`
  - 完了条件: `cd server && node --test test/codex-trust.test.ts` → 固定の 9 件が trusted、手書きの期待値と境界のケースが全件 pass。`bun run notices` → 終了コード 0
  - コミット: `feat(doctor): compute Codex's hook trust hashes`
- [ ] T05: doctor の observe と report に「Codex hooks」の行を足し、既存のテストを隔離し、CLI の子プロセスのテストと README を足す
  - 種別: 追加
  - 計画: S4
  - 依存: T04（ハッシュと状態を出す関数が要る）
  - 変更: `server/src/plugin.ts`, `server/test/plugin.test.ts`, `server/test/cli.test.ts`, `README.md`, `README.ja.md`
  - 完了条件: `bun run verify` → 終了コード 0（偽の codex が一時の CODEX_HOME を受け取り、config.toml の中身と mtime が変わらず、trusted・modified・disabled の行が出て、その行で終了コードが 1 にならない）
  - コミット: `feat(doctor): report whether Codex trusts Sphica's current hooks`
- [ ] T06: Windows の CI に、パックした doctor の「Codex hooks」の行を確かめる手順を足す
  - 種別: 追加
  - 計画: S5
  - 依存: T05（doctor の行が要る）
  - 変更: `.github/workflows/check.yml`, `scripts/check-codex-trust-windows.mjs`
  - 完了条件: `actionlint` → 終了コード 0。push 後の Windows のジョブ → 行が ✓「9 of 9 trusted」で unknown でなく、変更後に 1 modified・1 disabled と `/hooks` の案内
  - コミット: `ci(windows): check doctor's Codex hooks row from the packed CLI`

## 記録

- 2026-10-05 / T01 / release:plan は package の入力（`plugin/`・`server/src/` など）が変わるまで kind none を返すので、完了条件の「kind が plugin」はこの時点で観測できない / 完了条件を「kind が plugin」から「4 か所が 0.6.31」に変えた。kind plugin は T03 の後に確かめる
- 2026-10-05 / T02 / 依存の理由に書いた「バージョンを上げないと CI がバージョンの検査で落ちる」は誤り。`scripts/check-hooks-live.mjs` は package の入力ではなく（`scripts/lib/release-scope.mjs`）、バージョンの検査は上げずに通る / 並び順は変えず、そのまま進める
