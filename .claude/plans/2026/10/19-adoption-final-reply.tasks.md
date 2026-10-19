---
kind: tasks
plan: 19-adoption-final-reply.plan.md
branch: fix/adoption-final-reply-355
base: main
---

# #355: trace が、提案が変わった後の最終版への持ち主の返事を採用に引くようにする のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: check の警告

trace の新しい記録で、採用の発言が引いた提案より前なら check と save が警告する。0.6.62 に上げる。

- [x] T01: 採用が引いた提案より前のときの警告を足し、0.6.62 に上げる
  - 種別: 修正
  - 計画: S1, S2, S4
  - 依存: なし
  - 変更: `server/evals/acceptance/cases.json`, `server/test/acceptance-cases.test.ts`, `server/src/record.ts`, `server/test/record.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - red: acceptance case 2 件と件数（capture 18 → 20）だけを足した状態で `bun run bundle && SPHICA_ACCEPTANCE_LAYER=capture bun run acceptance` → 前の返事を引く case が「check did not report "is older than the proposal it cites"」で落ち、最終版の返事を引く case は通る
  - 完了条件: `bun run verify` → 0 で終わる。コミットの後に `bun run release:plan -- --base bf7e146b` → `plugin`
  - コミット: `fix(record): warn when a trace's adoption is older than the proposal it cites (T01)`
  - 結果: red: case と件数だけを足して `bun run bundle && SPHICA_ACCEPTANCE_LAYER=capture bun run acceptance` → capture-19 が「check did not report "is older than the proposal it cites"」で落ち、capture-20 は pass。実装後 `bun run verify` → exit 0（acceptance 150 件 pass）。record.test.ts の新しいテストを単独で流して pass

## P2: Skill の文面

trace・harvest・glean の Skill が、提案が変わったら最終版への返事を引くと言い、警告への対処を説明する。

- [x] T02: 3 つの Skill に、最終版への返事を引く規則と警告への対処を足す
  - 種別: 修正
  - 計画: S3
  - 依存: T01（文面が名指す警告の文言が要る）
  - 変更: `plugin/skills/trace/SKILL.md`, `plugin/skills/harvest/SKILL.md`, `plugin/skills/glean/SKILL.md`
  - red: `rg -c "final version" plugin/skills/trace/SKILL.md plugin/skills/harvest/SKILL.md plugin/skills/glean/SKILL.md` → どれにも当たらない（今の文面は、提案が変わったときにどの返事を引くかを言わない）
  - 完了条件: 同じ `rg` → 3 ファイルすべてに当たる。`bun run verify` → 0 で終わる
  - コミット: `docs(skills): quote the reply to the final proposal as the adoption (T02)`
  - 結果: red: 変更前に `rg -c "final version" plugin/skills/{trace,harvest,glean}/SKILL.md` → 当たりなし（exit 1）。変更後 → trace 2、harvest 2、glean 1。`bun run verify` → exit 0

- [x] T03: agent の採用を除くことを、実際に agent の採用を通して確かめる
  - 種別: 修正
  - 計画: S2
  - 依存: T01（直すテストが T01 にある）
  - 変更: `server/test/record.test.ts`
  - red: 直す前のテストのまま `server/src/record.ts` の `adoption.filter((x) => x.route !== "agent")` を外し、`cd server && node --import ./test/isolate-home.ts --test --test-name-pattern="adoption older than the unit's newest proposal" test/record.test.ts` → 通ってしまう（adoption が空で、除外を確かめていない）
  - 完了条件: 同じ書き換えで同じコマンド → 落ちる。書き換えを戻して → 通る。`bun run verify` → 0 で終わる
  - コミット: `test(record): pass a real agent adoption to the order warning test (T03)`
  - 結果: red: 直す前のテストで agent の除外を外して流す → pass（空振り）。直した後、同じ書き換え → fail、戻して → pass。adoption の route が ["agent"] であることも assert した。`bun run verify` → exit 0

- [x] T04: 警告の判定のコメントを、断定ではなく警告にとどめる理由の説明にする
  - 種別: 修正
  - 計画: S2
  - 依存: T01（直すコメントが T01 にある）
  - 変更: `server/src/record.ts`
  - red: `rg -n "answered an earlier version" server/src/record.ts` → 1 行当たる（時刻の前後だけで、前の版への返事だったと言い切っている）
  - 完了条件: 同じ `rg` → 当たらない。`bun run verify` → 0 で終わる
  - コミット: `docs(record): say the adoption order check only warns (T04)`
  - 結果: red: `rg -n "answered an earlier version" server/src/record.ts` → 720 行目に当たり。直した後 → 当たりなし（exit 1）。`bun run verify` → exit 0

## 記録

- 2026-10-19 / T01 / 完了条件の release:plan を「版を編集する前に流す」→「コミットの後に流す」に変えた / release:plan はコミット済みの履歴だけを読み、作業ツリーの変更では none と出たため（plan の変更履歴にも記載）
- 2026-10-19 / T01 / Codex のタスクごとのレビュー（c504abcf）で P2 が 1 件: agent の採用の除外を確かめるテストが adoption を空のまま渡していて空振りする（Codex が再現） / 採用。T03 を足して直す
- 2026-10-19 / T01 / GitHub の Codex レビュー（cc17382d）の P1「コメントが言い切りすぎ」 / 採用。後の発言が言い換えなだけのこと（u655）もあるので、T04 を足して直す
- 2026-10-19 / T01 / GitHub の Codex レビュー（cc17382d）の P1「release:plan を版の編集の前に戻せ」 / 不採用。release:plan はコミット済みの履歴だけを読み（作業ツリーでは none と出た）、pre-commit の bundle は版を上げない package のコミットを止めるので、その順序は今の仕組みでは取れない。PR 本文の Declined findings に書く
