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

- [x] T01: 秘密鍵ブロックの範囲と、引用の対応の判定を text.ts に足す
  - 種別: 追加
  - 計画: S2
  - 依存: なし
  - 変更: `server/src/text.ts`, `server/test/text.test.ts`, `plugin/package.json`, `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`
  - 完了条件: `bun run --cwd server test` → 追加したテスト（`TOKEN=redacted123` と `redacted` は断る、`API_KEY=abc123def456` と単独の `abc123def456` は断る、`AIza` + `a`×75 と `a`×40 は断る、秘密を避けた引用は正しいバイト位置、ブロックの範囲がバイト位置で返る）を含めて全件 pass
  - コミット: `feat(text): find private key ranges and check quotes against masked text (T01)`
  - 結果: `node --test test/text.test.ts` → 13 件 pass（追加の 2 件を含む）。`tsc --noEmit` → エラーなし。biome check → 指摘なし。`bun run --cwd server test` → 311 件 pass。バージョンを 0.5.6 → 0.5.7 に上げた（pre-commit の bundle が同じコミットでの引き上げを求めるため）

- [x] T05: quoteSpan と privateKeyRanges のバイト位置の計算を線形にする
  - 種別: 修正
  - 計画: S2
  - 依存: T01（直す対象の関数）
  - 変更: `server/src/text.ts`, `server/test/text.test.ts`
  - red: 足した「stay fast」のテストを直す前のコードで `node --test test/text.test.ts` → 5 秒の上限を超えて fail
  - 完了条件: `bun run --cwd server test` → 全件 pass
  - コミット: `fix(text): count placeholder byte offsets in one pass (T05)`
  - 結果: red は `took 42657 ms` で fail。直した後 `node --test test/text.test.ts` → 14 件 pass（同じテストが 85 ms）、`tsc --noEmit` と biome は指摘なし。`bun run --cwd server test` → 312 件 pass

- [x] T06: 伏せ字の目印の正規表現に長さの上限を付ける
  - 種別: 修正
  - 計画: S2
  - 依存: T05（直す対象の quoteSpan の線形化）
  - 変更: `server/src/text.ts`, `server/test/text.test.ts`
  - red: 「stay fast」のテストに閉じ括弧の無い `[redacted: ` を 10 万行足し、直す前のコードで `node --test test/text.test.ts` → 5 秒の上限を超えて fail
  - 完了条件: `bun run --cwd server test` → 全件 pass
  - コミット: `fix(text): bound placeholder labels so unclosed openings stay linear (T06)`
  - 結果: red は `took 45183 ms` で fail（最初の実行は期待値の書き誤りで別の assert が fail したので直して流し直した）。直した後 `node --test test/text.test.ts` → 14 件 pass（94 ms）、tsc と biome は指摘なし、`bun run --cwd server test` → 313 件 pass

## P2: glean の抜粋を伏せ字にする

glean が引いたファイルの抜粋が、伏せ字にされて保存・索引化され、秘密に触れる引用が断られるようになる。

- [x] T02: glean の抜粋を伏せ字にして保存し、引用と秘密鍵の行の指定を検査する
  - 種別: 修正
  - 計画: S1, S3
  - 依存: T01（引用の判定と秘密鍵の範囲の関数が要る）
  - 変更: `server/src/glean.ts`, `server/test/extract.test.ts`, `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`, `server/test/acceptance-cases.test.ts`
  - red: 足したテストと受け入れケースを直す前のコードで `bun run --cwd server test` と `bun run acceptance` → 抜粋の本文に秘密の文字列が残る、`redacted` が 0、`source_fts` で秘密の文字列が当たる、秘密に触れる引用が保存される、の各 assert で fail
  - 完了条件: `bun run --cwd server test` と `bun run acceptance` → 全件 pass。古い伏せ字なしの行があるときは新しい revision が作られ、根拠の位置がその本文の上で正しい
  - コミット: `fix(glean): mask file excerpts before storing them (T02)`
  - 結果: red は、直す前の glean.ts で extract.test.ts の新しいテストが fail（古い伏せ字なしの行を使い回し、行数 1 ≠ 2）、受け入れケース glean-13 が fail（保存本文に `API_KEY=abc123def456` が残る）。直した後 `bun run --cwd server test` → 313 件 pass、`bun run acceptance` → 58 件 pass

- [x] T07: 抜粋の外にあるキー名で伏せ字になる値を、抜粋だけで保存しない
  - 種別: 修正
  - 計画: S3, S4
  - 依存: T02（直す対象の glean の抜粋）, T03（直す対象のコード位置の抜粋）
  - 変更: `server/src/glean.ts`, `server/src/anchors.ts`, `server/test/extract.test.ts`, `server/test/record.test.ts`, `plugin/skills/glean/SKILL.md`
  - red: `API_KEY=` の次の行の値だけを引くケースを足し、直す前のコードで `node --test test/extract.test.ts test/record.test.ts` → extract は `Missing expected rejection`、record は抜粋に `tokenValue123abc;` が残って fail
  - 完了条件: `bun run --cwd server test` と `bun run acceptance` → 全件 pass
  - コミット: `fix(glean): refuse excerpts whose masking depends on text outside them (T07)`
  - 結果: red は上のとおり fail。直した後 `bun run --cwd server test` → 314 件 pass、`bun run acceptance` → 58 件 pass、tsc と biome は指摘なし

## P3: コード位置の抜粋を伏せ字にする

trace、harvest、glean が記録に付けるコード位置の抜粋に、秘密が残らなくなる。

- [x] T03: コード位置の抜粋を、行全体を伏せ字にしてから 200 文字に切る
  - 種別: 修正
  - 計画: S1, S4
  - 依存: T01（秘密鍵の範囲の関数が要る）
  - 変更: `server/src/anchors.ts`, `server/test/record.test.ts`
  - red: 足したテストを直す前のコードで `bun run --cwd server test` → 長い `apiKey = "…"` の行と秘密鍵ブロックの中の行で、`unit_anchor.excerpt` に秘密の文字列が残り fail
  - 完了条件: `bun run --cwd server test` → 全件 pass
  - コミット: `fix(anchors): mask anchor excerpts before cutting them (T03)`
  - 結果: red は、直す前のコードで record.test.ts の新しいテストが fail（抜粋に `apiKey` の値が残る）。値は `sk-` の形だと切った後でも鍵の形で伏せ字になり、順序の誤りを見分けられないので、代入の形でしか見つからない値に変えて red を取り直した。直した後 `bun run --cwd server test` → 314 件 pass、`bun run acceptance` → 58 件 pass、`bun run architecture` → 通過。配信のたびに走る anchorState には秘密鍵の走査を入れず、保存時の locate だけで抜粋を作る形に分けた

## P4: 出荷の準備

glean スキルの案内を足し、出荷前の検査を通す。

- [x] T04: glean スキルに引用の注意を 1 行足す
  - 種別: 変更
  - 計画: S5
  - 依存: T02（断るときの文面が決まっている必要がある）, T03（出荷の範囲がそろっている必要がある）
  - 変更: `plugin/skills/glean/SKILL.md`
  - 完了条件: `bun run release:plan -- --base v0.5.6` → kind が `plugin`、`bun run verify` → 0 で終わる
  - コミット: `docs(glean): tell the agent not to quote secrets (T04)`
  - 結果: `bun run release:plan -- --base v0.5.6` → release kind: plugin、4 つのバージョンがすべて 0.5.7。`bun run verify` → 最後の acceptance まで通過（58 件 pass）

## 記録

- 2026-09-28 / T01, T04 / pre-commit の bundle フックが、パッケージに入るファイルの変更と同じコミットでのバージョンの引き上げを求めた / バージョンの引き上げ（0.5.7）を T04 から T01 に移した。T01 の変更欄: 前 `server/src/text.ts`, `server/test/text.test.ts` → 後 それに 4 つのバージョンのファイルを足す。T04 の変更欄: 前 SKILL.md と 4 つのバージョンのファイル → 後 SKILL.md のみ。T04 の名前とコミットの件名も合わせて直した
- 2026-09-28 / T05 / T01 の Codex レビュー（F1）: 伏せ字が約 5 万箇所ある約 1 MiB の入力で quoteSpan が 7.3 秒、処理時間が二乗で増える / 採用。修正タスク T05 を T01 の後に足した。Codex 側の全件テストの失敗は読み取り専用の環境で一時ディレクトリが作れなかったためで、手元では 311 件 pass
- 2026-09-28 / T02 / 受け入れケースの層ごとの件数の検査（server/test/acceptance-cases.test.ts の PER_LAYER）が glean 12 件を固定していた / glean-13 を足したので 13 にした。T02 の変更欄に同ファイルを足した（前: 4 ファイル → 後: 5 ファイル）
- 2026-09-28 / T05 / T05（b5d996b）の Codex レビュー（F1、再現済み）: 閉じ括弧の無い `[redacted: ` が多数ある入力で、PLACEHOLDER の `[^\]]*` が開始位置ごとに末尾まで読み直し、quoteSpan がまだ二乗時間 / 採用予定。再開時に修正タスク T06（PLACEHOLDER の説明部分に長さの上限を付け、同じ入力の速度テストを足す）を T05 の後に足す。byteRanges と重なり判定の正しさには指摘なし
- 2026-09-28 / T02 / 持ち主が Claude を再起動するため中断。T02（ff28b14）の Codex レビューはまだ投げていない / 再開時に新しい会話で投げる
- 2026-09-28 / T06 / T06（ec11ca7）の Codex レビュー: 範囲を絞った目印の正規表現は全種類の目印に一致し、閉じ括弧の無い入力でも線形と確認。新しい指摘 F1（再現済み）: 同じ文字の連続に同じ文字だけの長い引用を重なりも含めて探すと二乗時間で、1 MiB で約 2.2 秒 / 見送り。ファイルは 1 MiB（MAX_FILE）、引用は 4000 文字（zod）が上限で最悪でも約 2.2 秒、本人が実行する glean でしか起きない。線形にするには自前の KMP が要り、手間に見合わない。PR 本文の見送った指摘に書く
- 2026-09-28 / T03 / T03（bf13675）の Codex レビュー: 指摘なし（target 一致）。Codex 側の全件テストの失敗は読み取り専用の環境の EPERM で、手元では 314 件 pass / 受け取り
- 2026-09-28 / T07 / T02（ff28b14）の Codex レビュー F1（再現済み）: `API_KEY=` の次の行の値だけを引くと、抜粋だけを伏せ字にしても値が残り、source.text と source_fts に入る。コード位置の抜粋（T03）にも同じ穴 / 採用。修正タスク T07: 前後の文脈とつないで伏せ字にした結果が別々に伏せ字にした結果と一致しなければ、glean は断り、コード位置の抜粋は `[redacted]` にする
