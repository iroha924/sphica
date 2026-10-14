---
kind: tasks
plan: 14-command-dead-ends.plan.md
branch: feat/command-dead-ends-218
base: main
---

# 行き止まりの記録をコマンドに紐付け、その会話で初めてそのコマンドを流そうとした呼び出しを 1 回だけ止める（#218）のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: コマンドの anchor を保存できる

dead_end にコマンドの anchor を付けて保存・検索・表示できるようになる。配信はまだ変わらない。

- [x] T01: schema revision 14 で unit_command を足し、バージョンを上げる
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `db/schema.sql`, `db/migrations/0014.sql`, `server/test/fixtures/schema-rev13.sql`, `server/src/sqlite.ts`, `server/src/db-write.ts`, `server/src/db-types.ts`, `server/test/schema.test.ts`, `server/test/db.test.ts`, `server/test/migrate.test.ts`, `plugin/package.json`, `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/schema.test.ts test/db.test.ts test/migrate.test.ts` → dead_end 以外への insert・CHECK に合わない command・update・unit がある間の delete・別プロジェクトの run が拒まれ、ingest の接続で insert と FTS の検索が通り、revision 13 から移行した DB と新しい DB の定義が一致する
  - コミット: `feat(db): add command anchors for dead ends in schema revision 14 (T01)`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/schema.test.ts test/db.test.ts test/migrate.test.ts` → pass 148 / fail 0。`bun run verify` → exit 0（受け入れ 142 件 pass）

- [x] T02: record server の commands 欄
  - 種別: 追加
  - 計画: S2
  - 依存: T01（unit_command の表が要る）
  - 変更: `server/src/record.ts`, `server/test/record.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/record.test.ts` → dead_end の commands が正規化して保存され、dead_end 以外・1 語だけ・`-` で始まる・引用符入り・mask で変わる値・6 件以上が problem として拒まれ、拒否の文面に値が出ない
  - コミット: `feat(record): save command anchors on dead ends (T02)`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/record.test.ts test/record-state.test.ts test/record-replies.test.ts` → pass 100 / fail 0。`bun run verify` → exit 0（受け入れ 142 件 pass）

- [x] T03: read と検索でコマンドの anchor を見せる
  - 種別: 追加
  - 計画: S5
  - 依存: T01（読む unit_command の表が要る）
  - 変更: `server/src/read.ts`, `server/src/search.ts`, `server/test/read.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/read.test.ts` → read が commands をファイルの Code 欄と分けて出し、search がコマンドの語で記録を見つける
  - コミット: `feat(read): show and search dead ends' command anchors (T03)`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern="dead end's commands" test/read.test.ts` → pass 1。search.ts の変更を外すと fail 1（コマンドの語だけの一致が弱い一致として落ちる）。`bun run verify` → exit 0

- [x] T04: trace と harvest の Skill に commands と教訓の書き方を足す
  - 種別: 変更
  - 計画: S6
  - 依存: T02（Skill が案内する commands 欄を record server が受けないと保存が拒まれる）
  - 変更: `plugin/skills/trace/SKILL.md`, `plugin/skills/harvest/SKILL.md`
  - 完了条件: `bun run verify:ai` → 0 で終わる
  - コミット: `docs(trace): write dead ends as lessons and anchor them to commands (T04)`
  - 結果: `bun run verify:ai` → exit 0。`bun run verify` → exit 0（T02 と同じコミット）

- [x] T10: コマンドの anchor の CHECK で NUL を拒む
  - 種別: 修正
  - 計画: S1
  - 依存: T01（直す CHECK が要る）
  - 変更: `db/schema.sql`, `db/migrations/0014.sql`, `server/test/schema.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern="a command anchor is a dead end" test/schema.test.ts` → NUL の後ろに改行・引用符・250 文字を続けた command が通り、Missing expected exception で落ちる
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/schema.test.ts test/db.test.ts test/migrate.test.ts` → NUL を含む command が拒まれ、移行した DB と新しい DB の定義が一致する
  - コミット: `fix(db): refuse NUL in command anchors, which length and glob stop at (T10)`
  - 結果: red を実測（fail 1、Missing expected exception）。直した後 `cd server && node --import ./test/isolate-home.ts --test test/schema.test.ts test/db.test.ts test/migrate.test.ts` → pass 148 / fail 0

## P2: 一致したコマンドを 1 回だけ止める

コマンドの anchor に一致した呼び出しを、その会話で 1 回だけ deny する。

- [x] T05: 行ごと・語ごとの照合の関数
  - 種別: 追加
  - 計画: S3
  - 依存: なし
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/deliver.test.ts` → `pnpm test --watch` が一致し、`pnpm test`・`--watch=false`・`bun testing`・行をまたぐ並び・引用符の付いた語は一致せず、`echo pnpm test --watch` と `echo 'note pnpm test --watch now'` は一致として固定される
  - コミット: `feat(deliver): match command anchors by whole tokens per line (T05)`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern="command anchor matches only" test/deliver.test.ts` → pass 1（一致 7 件・不一致 9 件）。`bun run verify` → exit 0

- [x] T06: 止める・知らせる配信と予算、COMMIT の後だけの deny
  - 種別: 追加
  - 計画: S4, S7
  - 依存: T02（commands 付きの記録を作る経路が要る）, T05（照合の関数が要る）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`, `server/evals/acceptance/cases.json`, `server/evals/acceptance/driver.ts`, `server/test/acceptance-cases.test.ts`, `scripts/lib/bundle-budget.mjs`
  - 完了条件: `bun run acceptance` → plan の A3 の観点が全部通る（受け入れケースを先に足し、実装の前に意図した理由で落ちることを確かめてから実装する）
  - コミット: `feat(deliver): stop the first call that repeats a recorded dead end's command (T06)`
  - 結果: red を実測（commandsRun を空にすると injection-29〜34 の 6 件が「call N stopped」で落ちる）。直した後 `bun run acceptance` の injection 34 件 pass。単体テスト 6 件 pass（並行のテストは 5 回続けて pass）。`bun run verify` → exit 0（受け入れ 148 件 pass）。deliver.js 457,240 バイト

- [x] T11: 照合で ; | & も語の区切りにする
  - 種別: 修正
  - 計画: S3
  - 依存: T05（直す照合の関数が要る）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern="command anchor matches only" test/deliver.test.ts` → `pnpm test --watch; Get-ChildItem` が一致せず落ちる
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/deliver.test.ts` → `;` `|` `&` でつないだコマンドが一致し、`--watch=false;` は一致しない
  - コミット: `fix(deliver): end a command's words at ; | & too, as PowerShell chains with ; (T11)`
  - 結果: red を実測（fail 1、`pnpm test --watch; Get-ChildItem`）。直した後 `cd server && node --import ./test/isolate-home.ts --test test/deliver.test.ts` → pass 66 / fail 0。injection の受け入れ 34 件 pass

- [x] T12: 知らせるだけの配信の文字数を、その文面の長さで予算に数える
  - 種別: 修正
  - 計画: S4
  - 依存: T06（直す予算の集計が要る）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern="spend the read budget's characters" test/deliver.test.ts` → 記録を含む command_context の行が合計 3,150 字になり、3,000 字を超えて落ちる
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/deliver.test.ts` → 同じ会話の command_context の記録が 3,000 字を超えない
  - コミット: `fix(deliver): count dead ends shown without a stop by their own words in the read budget (T12)`
  - 結果: red を実測（3,150 字で fail）。直した後 `cd server && node --import ./test/isolate-home.ts --test test/deliver.test.ts` → pass 67 / fail 0（同じ会話で 2,984 字）

- [x] T13: 演算子は空白に接するときだけコマンドの区切りにする
  - 種別: 修正
  - 計画: S3
  - 依存: T11（直す区切り方が要る）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - red: `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern="command anchor matches only" test/deliver.test.ts` → `pnpm;test --watch` が一致して落ちる
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/deliver.test.ts` → `pnpm;test --watch`・`pnpm|test --watch`・`pnpm test|--watch`・`pnpm; test --watch`・URL の `&` の中は一致せず、`pnpm test --watch; Get-ChildItem` と `npm ci && pnpm test --watch&` は一致する
  - コミット: `fix(deliver): split commands only at operators beside a space, never inside a word (T13)`
  - 結果: red を実測（fail 1、`pnpm;test --watch`）。直した後 `cd server && node --import ./test/isolate-home.ts --test test/deliver.test.ts` → pass 67 / fail 0。injection の受け入れ 34 件 pass

## P3: 速さと効果を測る

全件の照合の速さと、anchor の有無での効果を測る。

- [x] T07: scale の fixture にコマンドの anchor を入れる
  - 種別: 変更
  - 計画: S8
  - 依存: T06（測る配信の経路が要る）
  - 変更: `server/evals/scale/run.ts`
  - 完了条件: `node server/evals/scale/run.ts` → 記録 1 万件でコマンドの照合を含む 1 回が 1 秒以内
  - コミット: `test(scale): measure command anchor matching at 10,000 records (T07)`
  - 結果: `node server/evals/scale/run.ts` → main（a9dae113）と de5fb4c9 で流した。stress 10,000 件で止める呼び出しが中央値 91 ms・最大 95 ms、何にも当たらないシェル呼び出しが 87 ms。既存のケースの差は最大 31 ms（review, Skill tool）。1 秒を超えるのは既定オフの shell の書き込みの試用の cold cache のケースだけで、変更の前も超えていた

- [x] T08: eval の課題と fixture（anchor あり / なし）
  - 種別: 追加
  - 計画: S9
  - 依存: T04（trace の書き方で作った dead_end を使う）, T06（deny の経路が要る）
  - 変更: `server/evals/cloud/tasks.json`, `server/evals/cloud/build.ts`, `server/evals/cloud/build-lib.ts`, `server/evals/acceptance/world.json`, `server/evals/acceptance/cases.json`, `server/test/eval-fixture.test.ts`
  - 完了条件: `bun run verify` → 0 で終わり、eval-loop の build で anchor あり・なしの 2 本の slot ができる
  - コミット: `test(eval): add a task whose first command is a recorded dead end (T08)`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/eval-fixture.test.ts` → pass 4 / fail 0（新しい setup の dead_end が fixture に入り、`withoutCommands` が commands だけを外す）。`bun run verify` → exit 0。build と実行は A9 で流す（費用の承認が要る）

- [x] T14: 演算子を語の頭か終わりに含むコマンドの anchor を保存で拒む
  - 種別: 修正
  - 計画: S2, S3
  - 依存: T13（照合がコマンドを演算子で区切る）
  - 変更: `server/src/record.ts`, `server/test/record.test.ts`, `server/test/deliver.test.ts`, `plugin/skills/trace/SKILL.md`
  - red: `cd server && node --import ./test/isolate-home.ts --test --test-name-pattern="commands it is about" test/record.test.ts` → `node build.mjs &` と `npm test | tail -20` が保存され、拒否の行が無くて落ちる
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/record.test.ts test/deliver.test.ts` → 2 つが「must be one command」で外れ、語の内側に演算子を含む anchor（URL の `&`）は自分のコマンドに一致する
  - コミット: `fix(record): refuse a command anchor that holds two commands, which could never match (T14)`
  - 結果: red を実測（fail 1、拒否の行が無い）。直した後 `cd server && node --import ./test/isolate-home.ts --test test/record.test.ts` → pass 83 / fail 0。deliver のテストも pass

- [x] T15: scale の「止める」ケースで deny されたかも見る
  - 種別: 変更
  - 計画: S8
  - 依存: T07（直す測定のケースが要る）
  - 変更: `server/evals/scale/run.ts`
  - 完了条件: `bun run verify` → 0 で終わり、止めるケースの最初の呼び出しが deny でなければ「not stopped」が problems に出る
  - コミット: `test(scale): count a stop only when the hook denied the call (T15)`
  - 結果: `bun run verify` → exit 0。scale の全体は T09 の後の測り直しで流す

- [x] T16: eval の anchor なしの側を、ありの側の fixture のコピーから commands だけを外して作る
  - 種別: 変更
  - 計画: S9
  - 依存: T08（--no-commands が要る）
  - 変更: `server/evals/cloud/build.ts`, `server/evals/cloud/build-lib.ts`, `server/test/eval-fixture.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/eval-fixture.test.ts` → コピーから外した fixture は unit_command が空で FTS の ident に npx が無く、ほかの表の行と schema は元と同じ
  - コミット: `test(eval): build the arm without command anchors from a copy of the other arm's fixture (T16)`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/eval-fixture.test.ts` → pass 4 / fail 0

## P4: 両ホストで確かめて出す準備

実機で deny の理由が届くかを確かめ、届かないホストは知らせるだけに戻して README に書く。

- [ ] T09: 両ホストの実機の確認と README
  - 種別: 変更
  - 計画: S10, S11
  - 依存: T06（確かめる配信が要る）
  - 変更: `README.md`, `server/src/deliver.ts`
  - 完了条件: `bun run verify` → 0 で終わり、README に deny の振る舞いと（あれば）ホストの差が書いてある
  - コミット: `docs(readme): describe stopping a call that repeats a recorded dead end (T09)`

## 記録
2026-10-14 / T01 / plan の unit_command に retired_at と「live な一意」を書いたが、退役の経路を作らず update も禁じるので列は常に NULL になる / retired_at を置かず、一意は (unit_id, command) にした。退役を足すときに migration で列を足す
2026-10-14 / T02 / extract.ts は check と save の共通の経路のままで変える必要が無かった / 変更欄から `server/src/extract.ts` を外した
2026-10-14 / T02, T04 / `bun run pairs` が、save が受ける欄（commands）を trace の Skill の表が書いていないと落とした / T04 を T02 と同じコミットで終えた

2026-10-14 / T01 / Codex のタスクごとのレビュー F1（P2、再現済み）: CHECK の制御文字の範囲が char(1) からで、NUL の後ろを length と glob が見ない / 採用。T10 を足して直した。record server の検査は NUL を先に拒むので保存の経路からは入らない
2026-10-14 / T03 / search は FTS の候補を JS で語を数え直して強い一致を決めるので、ident に入れただけではコマンドの語で見つからない / 変更欄に `server/src/search.ts` を足した
2026-10-14 / T02, T04 / Codex のタスクごとのレビュー F1（P2）: glean の保存の返答に check の problems（外したコマンド）が出ない / 見送り。extract.ts の glean の保存はもとから problems を返さず（anchor も同じ）、この変更で入ったものではない
2026-10-14 / T02, T04 / Codex のタスクごとのレビュー F2（P2）: Skill がまだ実装していない「止める」を書いている / 見送り。T06 で実装し同じ PR で出す。T09 で文面と挙動を突き合わせる
2026-10-15 / T06 / 変更欄: deliver-codex.test.ts は変えずに済み、deliver.js が上限 455,000 を 2,240 バイト超えた / 前: deliver-codex.test.ts を含む。後: 外して scripts/lib/bundle-budget.mjs を足し、上限を 460,000 にした（前例どおり 5 KB 刻み）
2026-10-15 / T06 / review-shipping の指摘 3 件: 並行のテストが 0 件の止めでも通る、止める動作と合わないコメント 2 か所、PowerShell の `cmd --worker; next` が `--worker;` の 1 語になり一致しない / 前の 2 件は T06 の中で直した。3 件目は照合の見逃しなので T11 を足す
2026-10-15 / T06 / Codex のタスクごとのレビュー F1（P2）: command_context の行を、予算の集計が CONFIRM の長さを引いて数え、1 行あたり 81 字少なく数える / 採用。T12 を足して直した
2026-10-15 / T06 / Codex のタスクごとのレビュー F2（P2）: Codex の Bash でパッチの heredoc とコマンドを 1 回にまとめると照合を通らない / 見送り。パッチの本文はファイルの中身で、照合するとコマンドをファイルに書くだけの編集まで止める
2026-10-15 / T11, T12 / Codex の再レビュー F1（P2、再現済み）: T11 で演算子を空白と同じに扱ったため、別々のコマンドや URL の `&` の中にも一致する / 採用。T13 を足して直した。T12 は指摘なし
2026-10-15 / T08 / 変更欄: tsundoku の world にコマンドを打つ課題が無く、2 本の arm を作る口も無かった / 前: tasks.json, fixture.ts。後: world.json にセッション s-en-typecheck、cases.json に setup trace_en_typecheck（dead_end に commands ["npx tsc"]）、tasks.json に課題 dead-end-typecheck、build.ts に --no-commands（build-lib.ts の withoutCommands）
2026-10-15 / T07 / tasks の検査の違反（結果行の書式）を残したまま T07 をコミットした。検査をパイプに通して終了コードを失った / T08 のコミットで書式を直した
2026-10-15 / T13, T07, T08 / Codex のレビュー F1〜F4（P2）: 2 本の arm を --compare で比べられない、組み立て直すと差が commands だけにならない、演算子を含む anchor が自分に一致しない、scale の止めるケースが deny を見ない / F2〜F4 は採用（T16、T14、T15）。F1 は一部採用: 2 本は build ごとに集計して並べると計画に書いた
2026-10-15 / T09 / 対話の Codex を expect で 3 回操作したが、ターンが始まらず hook まで届かなかった（history.jsonl にはプロンプトがあり、ログはスレッドの開始まで）。codex exec では止めて理由が届くことを確かめた / 持ち主に聞く
