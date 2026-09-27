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

- [x] T08: npm と 3 つの manifest のバージョンを 0.5.5 に上げる
  - 種別: 変更
  - 計画: S7
  - 依存: なし
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run release:plan -- --base v0.5.4` → 4 か所が 0.5.5
  - コミット: `chore(release): bump to 0.5.5`
  - 結果: `bun run release:plan -- --base v0.5.4` → version: npm 0.5.5 / plugin 0.5.5 / marketplace 0.5.5 / Codex 0.5.5（07e5207 の時点。kind は差分がまだ無いので none）

- [x] T01: ingest 接続から owner_identity への書き込みを拒む
  - 種別: 変更
  - 計画: S1
  - 依存: T08（配布物の変更はバージョンを上げた後でないとコミットできない）
  - 変更: `server/src/db-write.ts`, `server/test/db.test.ts`
  - 完了条件: `bun run test` → ingest からの owner_identity への insert / update / delete が拒まれる検査を含めて通る
  - コミット: `feat(db): refuse owner_identity writes from the ingest role`
  - 結果: 変更前のコードで `node --test --test-name-pattern="owner identity" test/db.test.ts` → insert の段で失敗（ingest が書けた）。変更後 `bun run test` → 293 pass / 0 fail

- [x] T02: gh api のホストを github.com に固定し、ghUser() で応答を検証して読む
  - 種別: 追加
  - 計画: S2
  - 依存: T08（配布物の変更はバージョンを上げた後でないとコミットできない）
  - 変更: `server/src/github.ts`, `server/test/github.test.ts`
  - 完了条件: `bun run test` → gh(repo) と ghUser() が `--hostname github.com` を渡し、ghUser() が missing / failed / unexpected（id 無し・0・文字列、login が空）を分けて返す検査が通る
  - コミット: `feat(github): pin gh api to github.com and read the signed-in user`
  - 結果: `bun run test` → 295 pass / 0 fail（偽の gh で `--hostname github.com` の引数、failed / missing / unexpected 9 通りを確認）。`bun run acceptance` → 55 pass。`bun run typecheck` と `bun run knip` → 指摘なし

- [x] T03: bindOwner() で最初の 1 件だけ登録し、登録した ID の CONTRIBUTOR の発言が採用される
  - 種別: 追加
  - 計画: S3
  - 依存: T01（owner 接続だけが書ける前提で登録の経路を 1 つにする）
  - 変更: `server/src/admin.ts`, `server/test/admin.test.ts`, `server/test/extract.test.ts`
  - 完了条件: `bun run test` → bound / already / other（行は 1 件のまま）/ skipped（revision 違い）と、bindOwner 後に CONTRIBUTOR の PR 本文が `owner` で保存されそれを引いた記録が active になる検査が通る。`bun run sql:reach` → 0 で終わる
  - コミット: `feat(admin): bind the owner's GitHub account once`
  - 結果: `bun run test` → 298 pass / 0 fail（bound / already / other で行は 1 件 / skipped、登録前の CONTRIBUTOR の PR 本文は person で candidate、登録後の PR は owner で active）。`bun run sql:reach` → 128 / 128 sites

- [x] T09: ghUser() が Enterprise Managed User のログイン名を受け付け、起動できない gh を未ログインと分ける
  - 種別: 修正
  - 計画: S2
  - 依存: T02（直す対象の ghUser() が要る）
  - 変更: `server/src/github.ts`, `server/test/github.test.ts`
  - red: `cd server && node --test test/github.test.ts` → `mona-cat_octo` が unexpected、実行権限の無い gh が failed で 2 件失敗
  - 完了条件: `bun run test` → 両方のケースを含めて通る
  - コミット: `fix(github): accept managed-user logins and tell an unstartable gh from a signed-out one`
  - 結果: red を実測（pass 4 / fail 2、上の 2 件）。直した後 `bun run test` → 298 pass / 0 fail。`bun run typecheck` → 指摘なし

- [x] T10: bindOwner() が revision を書き込みロックの中で確かめ、どの行に登録済みの ID でも already と返す
  - 種別: 修正
  - 計画: S3
  - 依存: T03（直す対象の bindOwner() が要る）
  - 変更: `server/src/admin.ts`, `server/test/admin.test.ts`
  - red: `cd server && node --test --test-name-pattern="any row" test/admin.test.ts` → ID 42 と 7 が登録された DB で 7 を渡すと other が返り失敗
  - 完了条件: `bun run test` → 複数行のケースを含めて通る
  - コミット: `fix(admin): check the revision under the lock and match any bound row`
  - 結果: red を実測（actual other / expected already）。直した後 `bun run test` → 299 pass / 0 fail。`bun run typecheck` → 指摘なし。`bun run sql:reach` → 128 / 128 sites。revision の競合は再現テストを作らず、読む位置をロックの中へ移しただけ

- [x] T11: ghUser() が 40 文字以上のログイン名を拒み、シグナルでの終了と出力の上限超えの分類をテストする
  - 種別: 修正
  - 計画: S2
  - 依存: T09（直す対象の分類が要る）
  - 変更: `server/src/github.ts`, `server/test/github.test.ts`
  - red: `cd server && node --test test/github.test.ts` → 40 文字のログイン名が ok で返り失敗
  - 完了条件: `bun run test` → 40 文字の拒否、SIGKILL で failed、2 MB の出力で unexpected を含めて通る
  - コミット: `fix(github): cap logins at 39 characters and test the signal and size cases`
  - 結果: red を実測（pass 5 / fail 1、40 文字が ok）。直した後 `bun run test` → 299 pass / 0 fail。`bun run typecheck` → 指摘なし

- [x] T12: 39 文字のログイン名が通る境界をテストする
  - 種別: 変更
  - 計画: S2
  - 依存: T11（39 文字の上限が要る）
  - 変更: `server/test/github.test.ts`
  - 完了条件: `bun run test` → 39 文字の login が ok で返る検査を含めて通る
  - コミット: `feat(cli): bind the signed-in GitHub account in init and show it in doctor`
  - 結果: `bun run verify` → rc 0（`bun run test` を含む）

- [x] T15: ghUser() に時間の上限を付け、固まった gh で init が止まらないようにする
  - 種別: 修正
  - 計画: S2
  - 依存: T11（直す対象の ghUser() の分類が要る）
  - 変更: `server/src/github.ts`, `server/test/github.test.ts`
  - red: `cd server && node --test test/github.test.ts` → 60 秒眠る偽の gh で ghUser() が返らず、テストが時間切れで失敗
  - 完了条件: `bun run test` → 固まった gh が 500 ms で failed になる検査を含めて通る
  - コミット: `fix(github): give up on a gh api user call that never answers`
  - 結果: red を実測（42 秒で時間切れの失敗）。直した後 `node --test test/github.test.ts` → 7 pass / 0 fail（5.8 秒）

## P2: init と doctor

sphica init がアカウントを登録して結果を 1 行で出し、doctor が登録を表示する。受け入れケースで harvest から採用まで通る。

- [x] T04: init で登録して表示し、doctor に登録済みのアカウントを出す
  - 種別: 追加
  - 計画: S4
  - 依存: T02（ghUser() が要る）, T03（bindOwner() が要る）
  - 変更: `server/src/cli.ts`, `server/src/admin.ts`, `server/test/cli.test.ts`, `server/test/admin.test.ts`, `server/test/fake-gh.ts`, `scripts/lib/live-harness.mjs`, `scripts/check-sql-live.mjs`, `scripts/check-tarball.mjs`
  - 完了条件: `bun run sql:live` → 一時 HOME と偽の gh で init が登録し、gh の失敗でも 0 で終わり、doctor が `GitHub owner` を表示する検査が通る
  - コミット: `feat(cli): bind the signed-in GitHub account in init and show it in doctor`
  - 結果: `bun run sql:live` → 8 / 8 SQL sites、未ログインの init が理由を出し、ログイン済みの init が hana (id 42) を登録し、doctor が `✓ GitHub owner hana (id 42)` を出す検査を含めて通る。`node scripts/check-tarball.mjs <npm pack の tgz>` → CLI 0.5.5 が起動し、DB を作り、アカウントを登録。`bun run verify` → rc 0

- [x] T05: 受け入れのドライバーで偽の gh を init の前に置き、CONTRIBUTOR の自分の PR が採用されるケースを足す
  - 種別: 追加
  - 計画: S5
  - 依存: T04（init が登録しないとケースが通らない）
  - 変更: `server/evals/acceptance/driver.ts`, `server/evals/acceptance/world.json`, `server/evals/acceptance/cases.json`, `server/test/acceptance-cases.test.ts`
  - 完了条件: `bun run acceptance` → 新しいケースを含めて通り、既存ケースの結果が変わらない
  - コミット: `test(acceptance): harvest the bound owner's pull request as a contributor`
  - 結果: `bun run acceptance` → 57 pass / 0 fail（capture-09: 登録後の CONTRIBUTOR の PR が active で author_is_owner、capture-10: 登録なしは candidate で author_is_owner でない。既存 55 件は変わらず）

- [x] T13: Windows CI の init で本物の gh を未ログインにし、tarball と sql:live で doctor の表示を確かめる
  - 種別: 修正
  - 計画: S4
  - 依存: T04（init と doctor の表示が要る）
  - 変更: `.github/workflows/check.yml`, `scripts/check-sql-live.mjs`, `scripts/check-tarball.mjs`
  - red: `rg -n "GH_CONFIG_DIR|GitHub owner" .github/workflows/check.yml scripts/check-tarball.mjs` → 何も出ない（Windows CI の init は認証済みになり得る本物の gh を使い、tarball の doctor も見ていない）
  - 完了条件: `bun run sql:live` → 未登録の doctor が `○ GitHub owner none` で、to fix に入らない検査を含めて通る。`node scripts/check-tarball.mjs <tgz>` → doctor の `✓ GitHub owner hana (id 42)` を含めて通る。`actionlint .github/workflows/check.yml` → 指摘なし
  - コミット: `fix(ci): keep gh signed out in the Windows init and check doctor's GitHub owner line`
  - 結果: red を実測（rg が 0 件）。`bun run sql:live` → 8 / 8 SQL sites で通る。`node scripts/check-tarball.mjs` → 通る。`actionlint` → 指摘なし。CI の手順を手元で再現（空の GH_CONFIG_DIR と空のトークンで本物の gh）→ gh は exit 4 で、init は `GitHub account not bound: gh api user failed` を出した。Windows での実走は PR の CI で見る

## P3: 文書と出荷

README と harvest Skill が登録を説明し、バージョンがそろう。

- [x] T06: README と harvest Skill に GitHub アカウントの登録を書く
  - 種別: 変更
  - 計画: S6
  - 依存: T04（書く表示の文言が決まる）
  - 変更: `README.md`, `README.ja.md`, `plugin/skills/harvest/SKILL.md`, `server/src/extract.ts`, `server/src/github.ts`, `server/test/extract.test.ts`
  - 完了条件: `bun run verify:ai` → 0 で終わる。`rg -n "sphica init" README.md README.ja.md` → init の説明に GitHub アカウントの登録が入っている
  - コミット: `docs: explain how init binds the owner's GitHub account`
  - 結果: `bun run verify` → rc 0（verify:ai を含む）。`rg -n "sphica init" README.md README.ja.md` → 72 行目の後に登録の段落、189 行目の表に登録。harvest の context が登録済みの本人に `(CONTRIBUTOR, the owner)` と出る検査が通る

- [x] T14: README と CI のコメントを、登録前の発言と gh の資格情報について事実どおりに直す
  - 種別: 修正
  - 計画: S6
  - 依存: T06（直す対象の README が要る）, T13（直す対象の CI の手順が要る）
  - 変更: `README.md`, `README.ja.md`, `.github/workflows/check.yml`
  - red: `rg -n "leaves both untouched|no request leaves" README.md .github/workflows/check.yml` → 2 件（再実行で何も変えないという説明と、リクエストが出ないという言い切り）
  - 完了条件: `rg -n "leaves both untouched|no request leaves" README.md .github/workflows/check.yml` → 0 件。`actionlint .github/workflows/check.yml` と `bun run verify:ai` → 指摘なし
  - コミット: `docs: say what init changes on a rerun and that earlier harvests keep contributor words`
  - 結果: red を実測（2 件）。直した後 rg → 0 件、`actionlint` → 指摘なし、`bun run verify:ai` → 通る

- [-] T07: release:plan に従い npm と 3 つの plugin manifest のバージョンをそろえる
  - 種別: 変更
  - 計画: S7
  - 依存: T06（出荷に入る変更が全部そろってから種別を判定する）
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run verify` → 0 で終わる。`bun run release:plan -- --base <前回のリリースのコミット>` → `plugin` と出て、バージョンがそろっている
  - コミット: `chore(release): bump to the next version`

## 記録

- 2026-09-28 / T01, T07, T08 / T01 のコミットが pre-commit の bundle 検査で止まった（配布物の変更はバージョンを同じ変更で上げる必要がある） / T07 を取りやめ、同じ S7 を担う T08 を先頭に足した。T01 と T02 の依存を なし → T08 に変えた
- 2026-09-28 / T08 / 結果欄を書式に合わない形のままコミットした（検査の終了コードをパイプで落とした） / T01 のコミットで結果欄を直した
- 2026-09-28 / T03 / 採用まで通すテストは harvest の run と保存の道具がそろう extract.test.ts に置き、新しい SQL の呼び出しも既存のテストで届いて台帳の変更が要らなかった / 変更欄を `admin.ts, admin.test.ts, github.test.ts, sql-call-sites.mjs` → `admin.ts, admin.test.ts, extract.test.ts` に変えた
- 2026-09-28 / T02 のレビュー / F1（EMU のログイン名を拒む、再現済み）と F2（EACCES を failed にする）を採用 / 修正タスク T09 を足した
- 2026-09-28 / T01 のレビュー / 指摘なし（Codex 側はテストを流せず、手元の `bun run test` で確認済み） / そのまま
- 2026-09-28 / T03 のレビュー / F1（revision をロックの前に読む）と F2（複数行で最初の行だけ比べる）を採用 / 修正タスク T10 を足した
- 2026-09-28 / T09 のレビュー / F1 のうち長さ（39 文字）は採用、EMU の接尾辞の形の検査は見送り（login は表示と保存だけで、owner の判定は数値 ID）。F2（シグナルと上限超えのテスト）は採用 / 修正タスク T11 を足した
- 2026-09-28 / T04 / init を流すテスト（admin.test、cli.test、sql:live、check-tarball）が手元の本物の gh で api.github.com に繋がることに気づいた / 偽の gh を PATH の先頭に置く server/test/fake-gh.ts と live-harness の fakeGh を足し、変更欄を広げた
- 2026-09-28 / T04, T05 / 受け入れのドライバーは init の後に偽の gh を置いていたため、T04 だけのコミットでは受け入れテストが本物の gh を呼ぶ / T04 と T05 を 1 コミットにした。既存ケースを変えないよう、最初の init は未ログインで流し、`gh_login` のステップで登録する形にした（plan の「world の任意の欄」から変更。world の owner 欄は前からあるので使わなかった）
- 2026-09-28 / T05 / 受け入れの件数を固定する検査がある / capture の件数を 8 → 10 にした
- 2026-09-28 / T10, T11 のレビュー / F2（39 文字の境界テスト）を採用し T12 を足した。F1（revision の競合の回帰テスト）は見送り（順序を決めて再現する手段が無く、起きるのは別の接続が user_version を書き換える場合だけ）
- 2026-09-28 / T06 / harvest の record_context は `by <login> (CONTRIBUTOR)` としか出さず、Skill は CONTRIBUTOR を提案と教えるため、登録しても本人の発言を採用に引かせられない / context で owner の発言に `, the owner` を添え（pullSources に author_kind を足す）、Skill にその読み方を書いた。変更欄に extract.ts、github.ts、extract.test.ts を足した
- 2026-09-28 / T04 のレビュー / F1（Windows CI の init が本物の gh を使う）、F2（tarball の doctor を見ていない）、F3（未登録の doctor が中立であることの検査が無い）を採用 / 修正タスク T13 を足した
- 2026-09-28 / T06, T13 のレビュー / F1（空のトークンと設定では鍵保管庫の資格情報を除けず、リクエストが出ないとは言えない）、F3（登録前の発言も採用できると読める）、F4（再実行で何も変えないという説明と矛盾）を採用し T14 を足した。F2（PR 本文に見出しの形を書けば context の owner の見出しを偽装できる）は見送り: 本文による見出しの偽装はこの変更の前からあり、record_check と record_save が DB の author_kind を確かめ直すので、偽装だけでは採用にならない
- 2026-09-28 / 差分全体の Codex レビュー / 指摘 1 件（gh api user に時間の上限が無く、固まった gh で init が止まる）を採用し T15 を足した
