---
kind: tasks
plan: 31-actions-lockfile.plan.md
branch: ci/actions-lockfile
base: main
---

# GitHub Actions の workflow lockfile を全ワークフローに入れ、Action の取得元を実行時に照合させる のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: lockfile を入れる

全ワークフローが lockfile に載り、CI で lockfile の整合を検査し、保証の説明が実態と合う。

- [ ] T01: actions-lock ジョブと release.yml の起動条件を足し、lockfile を作って入れる
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `.github/workflows/zizmor.yml`, `.github/workflows/release.yml`, `.github/workflows/actions.lock`
  - 完了条件: `gh actions-lock --verify --json` → exit 0、`valid: true`、error 0。`git diff main -- '.github/workflows/*.yml' | rg '^[-+]\s+(- )?uses:'` → 足した actions-lock ジョブの harden-runner と checkout の 2 行だけ
  - コミット: `ci: lock workflow actions with actions.lock and verify it in CI (T01)`

- [ ] T02: ASSURANCE.md に lockfile とその対象外を書く
  - 種別: 変更
  - 計画: S2
  - 依存: なし
  - 変更: `ASSURANCE.md`
  - 完了条件: `mise exec -- bun run verify:ai` → exit 0。`rg -n "lockfile" ASSURANCE.md` → :53 付近と :77 の表に lockfile の記述があり、reusable workflow とコンテナイメージが対象外と書いてある
  - コミット: `docs: describe the actions lockfile and its limits in ASSURANCE (T02)`

## 記録
