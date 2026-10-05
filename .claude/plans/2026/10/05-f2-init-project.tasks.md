---
kind: tasks
plan: 05-f2-init-project.plan.md
branch: fix/f2-init-project
base: main
---

# init のローカル名の表と DB の設置を同時実行に耐えるようにし、doctor が見つからない project の探した場所と複数のコピーを出す（#266・#277） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 準備とロックの部品

バージョンをそろえ、持ち主だけが消すロックと、壊れない置き換えの部品ができて、Windows の CI でも動く

- [x] T01: release:plan で種別を確かめ、npm と 3 つの manifest を 0.6.32 にそろえる
  - 種別: 変更
  - 計画: S6
  - 依存: なし
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run release:plan -- --base d9136f72` → 4 か所が 0.6.32、`bun run verify` → 終了コード 0
  - コミット: `chore(release): bump to 0.6.32`
  - 結果: `bun run release:plan -- --base d9136f72` → `version: npm 0.6.32 / plugin 0.6.32 / marketplace 0.6.32 / Codex 0.6.32`、kind は none（まだ package の入力を変えていない）。`bun run verify` → exit 0
- [ ] T02: file-lock.ts に withFileLock と replaceFile を足し、テストを書く
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `server/src/file-lock.ts`, `server/test/file-lock.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/file-lock.test.ts` → 待つ・時間切れ・pid が書かれる前のロックを奪わない・持ち主以外は消さない・置き換え・失敗時に元が残るの各テストが pass
  - コミット: `feat(lock): add an owner-only file lock and an atomic file replace`
- [ ] T03: Windows の CI で file-lock のテストを流す
  - 種別: 追加
  - 計画: S5
  - 依存: T02（流すテストのファイルが要る）
  - 変更: `.github/workflows/check.yml`
  - 完了条件: `bun run verify` → 終了コード 0（actionlint を含む）。push 後の Windows のジョブで file-lock のテストの step が pass
  - コミット: `ci(windows): run the file lock tests on Windows`

## P2: init の同時実行を直す

2 つの init が同時に走っても、projects.json の名前が消えず、先に置いた DB が置き換えられない

- [ ] T04: nameLocal をロックの中で読み直し、置き換えで書く
  - 種別: 修正
  - 計画: S2
  - 依存: T02（withFileLock と replaceFile が要る）
  - 変更: `server/src/project.ts`, `server/test/project.test.ts`, `server/test/fixtures/name-local-child.ts`
  - red: `cd server && node --test --test-timeout=60000 --test-name-pattern=race test/project.test.ts` → projects.json に子の名前が無くて落ちる。テストだけを先に足し、project.ts は main のまま
  - 完了条件: 同じコマンド → pass（元の 1 件・親・子の 3 件が残る）。途中で止まる場合のテスト → projects.json が元の内容で読め、次の nameLocal がロックのファイルの名前を出して止まる。`bun run verify` → 終了コード 0
  - コミット: `fix(init): name local projects under a lock and replace the table atomically`
- [ ] T05: dbInit で DB を置く手順全体をロックで囲む
  - 種別: 修正
  - 計画: S3
  - 依存: T02（withFileLock が要る）
  - 変更: `server/src/admin.ts`, `server/test/admin.test.ts`, `server/test/fixtures/db-init-child.ts`
  - red: `cd server && node --test --test-timeout=60000 --test-name-pattern=race test/admin.test.ts` → 両方が Created と出て、子の目印の行が無くて落ちる。テストだけを先に足し、admin.ts は main のまま
  - 完了条件: 同じコマンド → pass（Created は 1 つだけで、もう 1 つは already exists。勝った方の目印の行が残る）。`bun run verify` → 終了コード 0
  - コミット: `fix(init): place a new database under a lock so a concurrent init cannot replace it`

## P3: doctor の文面

doctor が、見つからない project には探した場所を、コピーが複数ある project にはその一覧を出す

- [ ] T06: doctor の Projects の欄で、探した場所と複数のコピーを出す
  - 種別: 修正
  - 計画: S4
  - 依存: なし
  - 変更: `server/src/cli.ts`, `server/test/cli.test.ts`
  - red: `cd server && node --test --test-timeout=60000 --test-name-pattern="doctor.*copies" test/cli.test.ts` → 2 つのコピーがある project が「not on this machine」と出て落ちる。テストだけを先に足す
  - 完了条件: 同じコマンド → pass（見つかった・見つからない・2 つのコピーの 3 行がそれぞれ期待の文面）。`bun run verify` → 終了コード 0
  - コミット: `fix(doctor): say where it looked for a project and list several copies`

## 記録
