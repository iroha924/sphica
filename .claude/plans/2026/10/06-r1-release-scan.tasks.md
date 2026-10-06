---
kind: tasks
plan: 06-r1-release-scan.plan.md
branch: ci/r1-release-scan
base: main
---

# release の run で、承認の前に出すリビジョンを OSV でスキャンし、merge の後に main の OSV と Scorecard を走らせ直す（#268）のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 承認の前のスキャン

タグのコミットのスキャン結果が run の summary と承認を頼む PR のコメントに出て、publish がスキャンを待つ。

- [ ] T01: OSV の結果を found / none / unavailable と表に要約するライブラリと CLI を足す
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `scripts/lib/osv-summary.mjs`, `scripts/osv-summary.mjs`, `server/test/osv-summary.test.ts`
  - 完了条件: `cd server && node --test test/osv-summary.test.ts` → pass。ファイルなし・空・壊れた JSON・形の違いは unavailable、0 件は none、1 つの ID が 2 パッケージにあるときの件数は 1、CLI は結果が読めなくても exit 0 で `status` と `count` を `$GITHUB_OUTPUT` に書く
  - コミット: `feat(release): summarize OSV results as found, none, or unavailable (T01)`

- [ ] T02: release.yml に osv ジョブを足し、notify-approval と publish に待たせ、paths に足す
  - 種別: 追加
  - 計画: S1
  - 依存: T01（ジョブが呼ぶ CLI が要る）
  - 変更: `.github/workflows/release.yml`
  - 完了条件: `actionlint .github/workflows/release.yml` → 出力なし。`bun run verify` → 成功
  - コミット: `ci(release): scan the tagged revision with OSV before approval (T02)`

## P2: merge の後のスキャン

release の merge の後に、main の OSV と Scorecard の run を workflow_dispatch で起こし、その URL を summary に出す。

- [ ] T03: osv-scanner.yml と scorecard.yml に workflow_dispatch を足し、release.yml に refresh-scans を足す
  - 種別: 追加
  - 計画: S2
  - 依存: なし
  - 変更: `.github/workflows/osv-scanner.yml`, `.github/workflows/scorecard.yml`, `.github/workflows/release.yml`
  - 完了条件: `actionlint .github/workflows/release.yml .github/workflows/osv-scanner.yml .github/workflows/scorecard.yml` → 出力なし。`bun run verify` → 成功
  - コミット: `ci(release): dispatch OSV and Scorecard on main after the release merge (T03)`

## P3: 手順書

plugin-release Skill が、スキャンの結果の読み方と、dispatch した run の見届け方、失敗したときの戻し方を書く。

- [ ] T04: plugin-release Skill の 5・7〜9 段と失敗からの戻し方を直す
  - 種別: 変更
  - 計画: S3
  - 依存: T02（5 段目が osv ジョブを書く）, T03（7〜9 段目が refresh-scans を書く）
  - 変更: `.agents/skills/plugin-release/SKILL.md`
  - 完了条件: `bun run verify:ai` → 成功
  - コミット: `docs(release): describe the pre-approval scan and the scans after the merge (T04)`

## 記録
