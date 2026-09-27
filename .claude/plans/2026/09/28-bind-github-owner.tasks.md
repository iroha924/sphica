---
kind: tasks
plan: 28-bind-github-owner.plan.md
branch: feat/bind-github-owner
base: main
---

# sphica init でログイン中の GitHub アカウントを owner として登録し、他人のリポジトリに出した自分の PR の発言も採用できるようにする（#173） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 登録の土台

owner_identity を書けるのが owner 接続だけになり、gh からアカウントを検証して読み、DB に 1 件だけ登録できる。

- [ ] T01: ingest 接続から owner_identity への書き込みを拒む
  - 種別: 変更
  - 計画: S1
  - 依存: なし
  - 変更: `server/src/db-write.ts`, `server/test/db.test.ts`
  - 完了条件: `bun run test` → ingest からの owner_identity への insert / update / delete が拒まれる検査を含めて通る
  - コミット: `feat(db): refuse owner_identity writes from the ingest role`

- [ ] T02: gh api のホストを github.com に固定し、ghUser() で応答を検証して読む
  - 種別: 追加
  - 計画: S2
  - 依存: なし
  - 変更: `server/src/github.ts`, `server/test/github.test.ts`
  - 完了条件: `bun run test` → gh(repo) と ghUser() が `--hostname github.com` を渡し、ghUser() が missing / failed / unexpected（id 無し・0・文字列、login が空）を分けて返す検査が通る
  - コミット: `feat(github): pin gh api to github.com and read the signed-in user`

- [ ] T03: bindOwner() で最初の 1 件だけ登録し、登録した ID の CONTRIBUTOR の発言が採用される
  - 種別: 追加
  - 計画: S3
  - 依存: T01（owner 接続だけが書ける前提で登録の経路を 1 つにする）
  - 変更: `server/src/admin.ts`, `server/test/admin.test.ts`, `server/test/github.test.ts`, `scripts/lib/sql-call-sites.mjs`
  - 完了条件: `bun run test` → bound / already / other（行は 1 件のまま）/ skipped（revision 違い）と、bindOwner 後に CONTRIBUTOR の PR 本文が `owner` で保存されそれを引いた記録が active になる検査が通る。`bun run sql:reach` → 0 で終わる
  - コミット: `feat(admin): bind the owner's GitHub account once`

## P2: init と doctor

sphica init がアカウントを登録して結果を 1 行で出し、doctor が登録を表示する。受け入れケースで harvest から採用まで通る。

- [ ] T04: init で登録して表示し、doctor に登録済みのアカウントを出す
  - 種別: 追加
  - 計画: S4
  - 依存: T02（ghUser() が要る）, T03（bindOwner() が要る）
  - 変更: `server/src/cli.ts`, `server/test/cli.test.ts`, `scripts/check-sql-live.mjs`
  - 完了条件: `bun run sql:live` → 一時 HOME と偽の gh で init が登録し、gh の失敗でも 0 で終わり、doctor が `GitHub owner` を表示する検査が通る
  - コミット: `feat(cli): bind the signed-in GitHub account in init and show it in doctor`

- [ ] T05: 受け入れのドライバーで偽の gh を init の前に置き、CONTRIBUTOR の自分の PR が採用されるケースを足す
  - 種別: 追加
  - 計画: S5
  - 依存: T04（init が登録しないとケースが通らない）
  - 変更: `server/evals/acceptance/driver.ts`, `server/evals/acceptance/world.json`, `server/evals/acceptance/cases.json`
  - 完了条件: `bun run acceptance` → 新しいケースを含めて通り、既存ケースの結果が変わらない
  - コミット: `test(acceptance): harvest the bound owner's pull request as a contributor`

## P3: 文書と出荷

README と harvest Skill が登録を説明し、バージョンがそろう。

- [ ] T06: README と harvest Skill に GitHub アカウントの登録を書く
  - 種別: 変更
  - 計画: S6
  - 依存: T04（書く表示の文言が決まる）
  - 変更: `README.md`, `README.ja.md`, `plugin/skills/harvest/SKILL.md`
  - 完了条件: `bun run verify:ai` → 0 で終わる。`rg -n "sphica init" README.md README.ja.md` → init の説明に GitHub アカウントの登録が入っている
  - コミット: `docs: explain how init binds the owner's GitHub account`

- [ ] T07: release:plan に従い npm と 3 つの plugin manifest のバージョンをそろえる
  - 種別: 変更
  - 計画: S7
  - 依存: T06（出荷に入る変更が全部そろってから種別を判定する）
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run verify` → 0 で終わる。`bun run release:plan -- --base <前回のリリースのコミット>` → `plugin` と出て、バージョンがそろっている
  - コミット: `chore(release): bump to the next version`

## 記録
