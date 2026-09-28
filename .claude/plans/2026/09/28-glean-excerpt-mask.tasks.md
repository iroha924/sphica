---
kind: tasks
plan: 28-glean-excerpt-mask.plan.md
branch: fix/glean-excerpt-mask
base: main
---

# glean が引いたファイルの抜粋と、記録のコード位置の抜粋を、保存の前に伏せ字にする（W1）のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 判定の部品

秘密鍵の範囲と、引用が伏せ字に触れていないかの判定を、単体で使える形で足す。

- [ ] T01: 秘密鍵ブロックの範囲と、引用の対応の判定を text.ts に足す
  - 種別: 追加
  - 計画: S2
  - 依存: なし
  - 変更: `server/src/text.ts`, `server/test/text.test.ts`
  - 完了条件: `bun run --cwd server test` → 追加したテスト（`TOKEN=redacted123` と `redacted` は断る、`API_KEY=abc123def456` と単独の `abc123def456` は断る、`AIza` + `a`×75 と `a`×40 は断る、秘密を避けた引用は正しいバイト位置、ブロックの範囲がバイト位置で返る）を含めて全件 pass
  - コミット: `feat(text): find private key ranges and check quotes against masked text (T01)`

## P2: glean の抜粋を伏せ字にする

glean が引いたファイルの抜粋が、伏せ字にされて保存・索引化され、秘密に触れる引用が断られるようになる。

- [ ] T02: glean の抜粋を伏せ字にして保存し、引用と秘密鍵の行の指定を検査する
  - 種別: 修正
  - 計画: S1, S3
  - 依存: T01（引用の判定と秘密鍵の範囲の関数が要る）
  - 変更: `server/src/glean.ts`, `server/test/extract.test.ts`, `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`
  - red: 足したテストと受け入れケースを直す前のコードで `bun run --cwd server test` と `bun run acceptance` → 抜粋の本文に秘密の文字列が残る、`redacted` が 0、`source_fts` で秘密の文字列が当たる、秘密に触れる引用が保存される、の各 assert で fail
  - 完了条件: `bun run --cwd server test` と `bun run acceptance` → 全件 pass。古い伏せ字なしの行があるときは新しい revision が作られ、根拠の位置がその本文の上で正しい
  - コミット: `fix(glean): mask file excerpts before storing them (T02)`

## P3: コード位置の抜粋を伏せ字にする

trace、harvest、glean が記録に付けるコード位置の抜粋に、秘密が残らなくなる。

- [ ] T03: コード位置の抜粋を、行全体を伏せ字にしてから 200 文字に切る
  - 種別: 修正
  - 計画: S1, S4
  - 依存: T01（秘密鍵の範囲の関数が要る）
  - 変更: `server/src/anchors.ts`, `server/test/record.test.ts`
  - red: 足したテストを直す前のコードで `bun run --cwd server test` → 長い `apiKey = "…"` の行と秘密鍵ブロックの中の行で、`unit_anchor.excerpt` に秘密の文字列が残り fail
  - 完了条件: `bun run --cwd server test` → 全件 pass
  - コミット: `fix(anchors): mask anchor excerpts before cutting them (T03)`

## P4: 出荷の準備

glean スキルの案内と、バージョンをそろえる。

- [ ] T04: glean スキルに引用の注意を 1 行足し、バージョンを上げる
  - 種別: 変更
  - 計画: S5
  - 依存: T02（断るときの文面が決まっている必要がある）, T03（出荷の範囲がそろっている必要がある）
  - 変更: `plugin/skills/glean/SKILL.md`, `plugin/package.json`, `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`
  - 完了条件: `bun run release:plan -- --base v0.5.6` → kind が `plugin`、`bun run verify` → 0 で終わる
  - コミット: `chore(release): bump to the next patch version for masked excerpts (T04)`

## 記録
