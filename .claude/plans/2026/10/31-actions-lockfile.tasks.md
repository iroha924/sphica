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

- [x] T01: actions-lock ジョブと release.yml の起動条件を足し、lockfile を作って入れる
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `.github/workflows/zizmor.yml`, `.github/workflows/release.yml`, `.github/workflows/actions.lock`
  - 完了条件: `gh actions-lock --verify --json` → exit 0、`valid: true`、error 0。`git diff main -- '.github/workflows/*.yml' | rg '^[-+]\s+(- )?uses:'` → 足した actions-lock ジョブの harden-runner と checkout の 2 行だけ
  - コミット: `ci: lock workflow actions with actions.lock and verify it in CI (T01)`
  - 結果: 使い捨ての worktree（HEAD 08cbe969 に編集後の zizmor.yml と release.yml を写したもの）で `gh actions-lock --no-interactive` → exit 0、actions.lock（90 行）だけを作業ツリーへ写した。worktree 側では 5 本の YAML の `uses:` がタグに書き換わったが、作業ツリーへは写していない
  - 結果: `gh actions-lock --verify` → exit 0。`--json` で `valid: true`、warning は `sha-as-ref` 21 と `container-image` 1、error 0
  - 結果: `git diff main -- '.github/workflows/*.yml' | rg '^[-+]\s+(- )?uses:'` → `+` の 2 行（actions-lock ジョブの harden-runner と checkout）だけ
  - 結果: ステージ後の `mise exec -- bun run release:plan -- --base v0.6.70` → `release kind: none (no release)`

- [x] T02: ASSURANCE.md に lockfile とその対象外を書く
  - 種別: 変更
  - 計画: S2
  - 依存: なし
  - 変更: `ASSURANCE.md`
  - 完了条件: `mise exec -- bun run verify:ai` → exit 0。`rg -n "lockfile" ASSURANCE.md` → :53 付近と :77 の表に lockfile の記述があり、reusable workflow とコンテナイメージが対象外と書いてある
  - コミット: `docs: describe the actions lockfile and its limits in ASSURANCE (T02)`
  - 結果: `mise exec -- bun run verify:ai` → exit 0（AI config と links が通った）。`mise exec -- bun run english` → 通った
  - 結果: `rg -n "lockfile" ASSURANCE.md` → :54 に lockfile の項（reusable workflow、コンテナイメージ、step が取るツールを対象外と明記）、:78 の表の Supply chain compromise の行に workflow lockfile

- [x] T03: zizmor.yml の冒頭コメントを、fork の PR を除くのが zizmor ジョブだけだと分かる形に直す
  - 種別: 修正
  - 計画: S1
  - 依存: T01（actions-lock ジョブが fork の PR でも走る形で入っている）
  - 変更: `.github/workflows/zizmor.yml`
  - red: `sed -n 2p .github/workflows/zizmor.yml` → 「It does not run for fork PRs」とワークフロー全体の話として書いてあり、actions-lock と actionlint のジョブ（fork の PR でも走る）と食い違う
  - 完了条件: `sed -n 2p .github/workflows/zizmor.yml` → fork の PR を除くのが zizmor のジョブだけだと読める。`mise exec -- bun run english` → 通る
  - コミット: `ci: say only the zizmor job skips fork PRs (T03)`
  - 結果: 直す前に `sed -n 2p .github/workflows/zizmor.yml` → 「Findings do not fail the job (they are read as SARIF). It does not run for fork PRs, …」で、ワークフロー全体を指していた（red を確認）
  - 結果: 直した後に `sed -n 2p .github/workflows/zizmor.yml` → 「zizmor's findings do not fail its job …, and that job does not run for fork PRs, …」。`mise exec -- bun run english` → 通った

## 記録

2026-10-31 / T02 / ASSURANCE.md の該当行が完了条件の「:53 付近と :77」から 1 行ずれて :54 と :78 になった（:53 の直後に項を足したため） / 欄は変えず、結果に実際の行番号を書いた
2026-10-31 / T01 / Codex のタスクごとのレビュー（8d613c65、high）は指摘 0 件。sandbox ではオンラインの `--verify` が認証エラー（exit 2）で流せず、同じ照合は手元で exit 0 を確かめた / 直すものなし
2026-10-31 / 全体 / 全差分の Codex レビュー（main..36512741、high）は P3 が 2 件。F1・F2 とも計画の記述の誤りで、受け入れて plan を直した（変更履歴）。実装の変更はなし
2026-10-31 / 全体 / review-shipping は 2 件。zizmor.yml の冒頭コメントが古くなっていた指摘は T03 で直した。scorecard.yml と osv-scanner.yml が PR では走らない指摘は、plan に完了条件 A8 を足して受け入れた
