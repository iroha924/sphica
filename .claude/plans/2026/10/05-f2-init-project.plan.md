---
kind: plan
status: approved
codex_session: 01a10a55-f44c-7bf0-97ce-075624f81a52
codex_rounds: 3
approved_at: 2026-10-05
---

# init のローカル名の表と DB の設置を同時実行に耐えるようにし、doctor が見つからない project の探した場所と複数のコピーを出す（#266・#277）

## 要点

- `sphica init --name` が同時に走っても、projects.json の名前が消えず、途中で止まっても壊れた projects.json が残らない（ロックの中で読み直し、一時ファイルから rename で置き換える）
- ハードリンクが使えない FS で 2 つの init が同時に DB を作っても、先に置いた DB を後の init が置き換えない（DB を置く手順全体を 1 つのロックの中で行う）
- ロックは新しい `server/src/file-lock.ts` に置く。持ち主しか消さず、待つのは最大 5 秒。時間切れなら何も書かずに止まり、ロックのファイルと pid を伝える
- doctor は「(not on this machine)」をやめる。見つからない project には探した場所を、コピーが複数ある project にはその一覧を出す
- 競合のテストは、書き込みで確定させる直前に子プロセスを同期させて決定的に再現する。main で落ちることを先に確かめる
- 変えないもの: capture のロック、DB のスキーマ、doctor が探す場所、init の出力の他の行

## 持ち主の決定

- GitHub Project「Sphica」の Phase 01、PR bundle「F2 Init and project」として、#266 と #277 を 1 つの計画・1 つの PR・1 回のリリースにまとめる（「OK、それやろう」）
- 作業は main から切った別の worktree で行う（F1 と同じ進め方）

## 目的

- DB がすでにある状態で、2 つの `sphica init --name` が別々のディレクトリを同時に名付けても、両方の名前と元からあった名前が projects.json に残る
- projects.json を置き換える途中でプロセスが止まっても、projects.json は前の内容のまま正しい JSON として読める
- ハードリンクが使えない FS で、DB が無いと見た 2 つの init が同時に走ると、DB を置くのは 1 つだけになる。もう 1 つは「already exists」で止まり、先に置かれた DB の行はそのまま残る
- doctor の Projects の欄で、見つかった project には何も付かない。見つからない project には探した場所が付き、コピーが複数ある project にはその場所の一覧が付く

## 対象外

- #265 の残り（capture の送信待ち、一時ファイル、拒否の理由、保留中の記録）。#265 のコメントのとおり F4（#274・#278）で扱う
- doctor が探す場所を広げること。#277 が求めているのは、探した場所を言うことだけ
- `connectWriter` の `requireFile` と `new DatabaseSync(file)` の間の TOCTOU（`server/src/db-write.ts:341-343`）。DB のパスを作るのは init だけ、という前提は意図した制約で、コードが原子的に保証しているわけではない
- 古いロックの自動での取り除き。持ち主が死んでいても自動では消さない（棄却の理由は「採った案と棄却した案」）
- capture の `lock()` をこの helper に移すこと

## 前提

- `nameLocal`（`server/src/project.ts:173-185`）は `localMap()` を読み、1 件を足して `writeFileSync(localFile())` で直接書く。読む側の `identify`（`project.ts:114-130`）と `localRoots`（`project.ts:197-226`）はロックを取らない
- `nameLocal` の中では、`identify`（`project.ts:174` から `123`）で 1 回目、更新に使う `localMap()`（`project.ts:178`）で 2 回目の読み込みがある
- `dbInit`（`server/src/admin.ts:297-356`）は、一時ファイル `${file}.${pid}.tmp` にスキーマを作ってから `linkSync(tmp, file)` する。EEXIST 以外のエラーで、かつ `existsSync(file)` が false のときは `renameSync(tmp, file)` に落ちる。最初の存在確認は `admin.ts:298`、落ちたときの確認は `admin.ts:346`
- rename は POSIX でも Windows でも置き換える。Windows は libuv の fs__rename が MOVEFILE_REPLACE_EXISTING を使う（Codex が Node v24.15.0 の `deps/uv/src/win/fs.c` で確認）
- Node の `wx` は Windows で CREATE_NEW になる（Node 24.15 の fs の文書 File system flags）。ネットワーク FS では排他が保証されない場合があるので、保証するのはローカルの FS に限る
- DB のパスを新しく作るのは `dbInit` だけ。`connectWriter` は `create` が無ければ、無いファイルを拒む（`db-write.ts:335-343`）。`connectReader` は readOnly（`server/src/sqlite.ts:136-139`）
- capture の `lock()`（`server/src/capture.ts:608-645`）は `wx` と pid を使い、5 分経つか持ち主が死んでいればロックを奪う。この手順は stat、pid の読み取り、削除が別々に走るので、奪う側どうしが競合する。新しいロックの手本にはしない
- doctor（`server/src/cli.ts:190`、`215`）は `localRoots()` の `found` だけを見る。`ambiguous` は捨てるので、コピーが 2 つある project にも「not on this machine」と出る。`localRoots` が見るのは `~/Projects` の直下と、projects.json のうちルートが今もあるものだけ
- `sphica init` は `dbInit` → `bindGitHub` → `nameLocal` の順に進む（`cli.ts:305-308`）。DB の作成の競合で負けた init は、名前を付ける前に止まる
- 同期で待つ処理の前例: `Atomics.wait`（`scripts/release-finish.mjs:194`）
- CLI を子プロセスで流すテストの前例: `server/test/cli.test.ts` の `runIn`（HOME と USERPROFILE を一時ディレクトリにする）
- Windows の CI（`.github/workflows/check.yml:94-`）は bundle と tarball の起動を見るだけで、ユニットテストは流さない
- バージョンを上げる場所: `plugin/package.json`、`plugin/.claude-plugin/plugin.json`、`plugin/.codex-plugin/plugin.json`、`.claude-plugin/marketplace.json`。前回のリリースのコミットは v0.6.31 のタグ（`d9136f72`）

## 方針

### file-lock.ts（新規）

- `withFileLock<T>(lockPath: string, fn: () => T): T`
  - `writeFileSync(lockPath, String(process.pid), { flag: "wx" })` でロックを取る。EEXIST なら 25〜50 ms おきに `Atomics.wait` で待って取り直す。期限は `performance.now()` で測り、最大 5 秒待つ
  - ロックは、生きていても、生死が分からなくても、pid がまだ書かれていなくても奪わない。消すのは持ち主だけで、`finally` の中で、中身が自分の pid のときだけ消す
  - 時間切れのときは何も書かずに Error を投げる。文面にはロックのファイルのパスと、そこに書かれた pid を入れる。`process.kill(pid, 0)` が ESRCH を投げたときだけ「その pid は動いていない。sphica init が他に動いていなければロックのファイルを消して、もう一度実行する」と添える。ESRCH 以外の例外は生死不明として扱い、この一文は添えない
- `replaceFile(file: string, text: string): void`
  - 同じディレクトリの `${file}.${process.pid}.tmp` に書いてから `renameSync(tmp, file)` で置き換える
  - rename が EPERM・EACCES・EBUSY を返したら、間を空けて最大 5 回まで取り直す（Windows でスキャナや読み手が開いているとき）。それでも失敗したら tmp を消して投げる。元のファイルはそのまま残る

### nameLocal

- `checkLocalName` と remote の確認は今のまま、ロックの外で行う
- `mkdirSync(path.dirname(localFile()))` をロックを取る前に行う
- `withFileLock(localFile() + ".lock")` の中で `localMap()` を読み直し、1 件を足して `replaceFile(localFile(), …)` で置き換える
- 読む側（`identify`、`localRoots`）はロックを取らない。rename なので、読む側には前か後の完全なファイルが見える

### dbInit

- スキーマを作るのは今と同じく、ロックの外の `${file}.${pid}.tmp` で行う
- 置くときは、`withFileLock(file + ".init.lock")` の中で `existsSync(file)` を確かめ直す。あれば今の「already exists」の文面で止まる。無ければ `linkSync(tmp, file)` し、EEXIST 以外のエラーなら `renameSync(tmp, file)` に落ちる。EEXIST は「already exists」で止まる
- 新しく DB を作る経路は、ハードリンクでも rename でも、すべてこのロックを通る

### doctor の Projects の欄

- 各 project について、`ambiguous` を先に見る。コピーが複数あれば ` (N copies: <path>, <path>)` を付ける
- `found` にも `ambiguous` にも無ければ、` (not found in ~/Projects or the named projects)` を付ける。ホームディレクトリは `~` で表す
- パスはどれも `inline()` に通す（view.ts の部品だけで出す規約）。正確な文面は実装のときに決め、テストで固定する

### テスト

- `server/test/file-lock.test.ts`（新規）: ロックを取る、他が持っている間は待つ、時間切れで止まって文面にパスと pid が入る、pid が書かれる前のロックを奪わない、持ち主以外は消さない、`replaceFile` が既存のファイルを置き換える、rename が失敗したら元のファイルが残って tmp も残らない。Windows の CI でもこのファイルを流す
- DB の競合（`server/test/admin.test.ts`）: 親も子も `fs.linkSync` を EPERM で失敗させる。親は、行き先が `file` の `fs.renameSync` を包み、本物の rename の直前に子を非同期で起動する。そして `done` か `blocked` の合図のファイルを `Atomics.wait` で最大 20 秒まで待つ。子の fixture は、`.init.lock` で終わるパスへの `writeFileSync` が EEXIST になったら `blocked` を書く。`dbInit` が返ったら、owner 接続で目印の行（project の key `git:example/child`）を入れ、接続を閉じてから `done` を書く。親も `dbInit` が返ったら目印 `git:example/parent` を入れて閉じる
  - 両方が終わった後に確かめること: Created と出たのは 1 つだけで、もう 1 つは「already exists」で止まっている。`file` の DB には、勝った方の目印の行が残っている
  - main では、子が置いた DB を親の rename が置き換えるので、両方が Created と出て子の目印が消える（red）
- 名前の競合（`server/test/project.test.ts`）: projects.json を前もって 1 件入りで作る。親は、projects.json を行き先とする書き込みを包む。main では `fs.writeFileSync`、直した後は `fs.renameSync` で、自分の書き込みの直前に子を起動し、合図を待つ。子は 2 つ目のディレクトリを名付ける。合図は `projects.json.lock` が EEXIST になったときの `blocked` と、終わったときの `done`
  - 終わった後に確かめること: projects.json に、元の 1 件と親と子の名前の 3 件が入っている
  - main では、子の名前が親の書き込みで消える（red）
- 途中で止まる場合: 子の fixture で、projects.json を置き換える `renameSync` を `process.exit(1)` に差し替える。その後も projects.json が元の内容の正しい JSON で、`identify` が元の名前を見つけることを確かめる。ロックのファイルは残り、次の `nameLocal` は 5 秒以内に、ロックのファイルの名前を出して止まる。これが文書にする復旧の手順。これとは別に、普通の rename の失敗では tmp もロックも残らないことを確かめる
- doctor（`server/test/cli.test.ts`）: 一時的な HOME に DB を作る。登録するのは、`~/Projects` の下にある project 1 つ、どこにも無い project 1 つ、同じ remote のコピーが `~/Projects` の下に 2 つある project 1 つ。CLI を子プロセスで流し、それぞれの行に期待した文面が出ることを確かめる
- 子プロセスにはそれぞれ timeout を付ける。HOME・USERPROFILE・SPHICA_HOME は一時ディレクトリにし、親の SPHICA_DB と CODEX_HOME は渡さない

### Windows の CI

- `.github/workflows/check.yml` の windows のジョブに、`server/test/file-lock.test.ts` を `node --test` で流す step を足す

### リリース

- バージョンを変える前に `bun run release:plan -- --base d9136f72` を流し、種別が plugin であることを確かめる
- 4 か所を 0.6.32 にそろえ、plugin-release の手順で出す

## 採った案と棄却した案

- 採用: 持ち主だけが消すロックで、最大 5 秒待ち、時間切れでは止まる。棄却: 経過時間や pid の生死を見てロックを奪う（止まっていた持ち主が再開したときや、奪う側どうしで、排他が破れる）
- 採用: DB を置く手順全体（確かめ直し、link、rename）をロックの中で行う。棄却: rename に落ちるときだけロックを取る（ハードリンクで置く側と排他にならない）
- 採用: 完成した一時ファイルをロックの中で置く。棄却: DB のパスに空の placeholder を `wx` で先に作る（作りかけのファイルが読み手・capture・別の init から見える）
- 採用: 書き込みで確定させる直前に子プロセスを同期させる、決定的な競合のテスト。棄却: 何度も繰り返して競合を引き当てる（再現が確率に頼る）、`existsSync` に嘘を返させる（直した後のコードも同じ嘘で破れる）、最初の読み込みで同期させる（main でも落ちない）
- 採用: capture の `lock()` は今のまま残す。棄却: この helper に移す（capture は待たない作りで、今回の目的に要らない）

## 手順

- S1: `server/src/file-lock.ts`（`withFileLock`、`replaceFile`）と、そのテスト
- S2: `nameLocal` をロックと `replaceFile` で書き直し、名前の競合と途中で止まる場合のテストを足す
- S3: `dbInit` で DB を置く手順をロックで囲み、DB の競合のテストを足す
- S4: doctor の Projects の欄の文面と、子プロセスでのテスト
- S5: Windows の CI に file-lock のテストを足す
- S6: release:plan、4 か所を 0.6.32 に、plugin-release の手順で出す

## 完了条件

- A1: `git checkout a13710ac -- server/src` の後に `cd server && node --test --test-timeout=60000 --test-name-pattern=race test/project.test.ts test/admin.test.ts` → 意図した理由（子の名前が消える／両方が Created と出て子の目印が消える）で落ちる。直した後のコードでは同じコマンドが通る
- A2: `cd server && node --test --test-timeout=60000 test/file-lock.test.ts test/project.test.ts test/admin.test.ts test/cli.test.ts` → すべて pass
- A3: `bun run verify` → 終了コード 0
- A4: `gh pr checks <PR>` → Windows のジョブの file-lock のテストの step を含めて、全部の項目が pass
- A5: `bun run release:plan -- --base d9136f72` → kind が plugin で、4 か所が 0.6.32
- A6: 0.6.32 のリリースの後、`npm view sphica version` → 0.6.32。この PC の CLI と両方のホストの plugin が 0.6.32 で、`release:status` が consistent

## リスク

- 子プロセスの同期のテストが CI で遅い・不安定になる → 合図を待つ上限と子の timeout で上限を決める。不安定なら同期の位置と合図を見直し、テストを繰り返し流す形にはしない
- Windows で、ウイルス対策が開いているために projects.json の rename が 5 回とも失敗する → 元のファイルは残るので、失敗の文面を出して止まる。再実行で直る
- 強制終了したときにロックのファイルが残る → 次の init が 5 秒で止まり、ロックのファイルと「動いていない pid」を伝える。消し方は文面にある

## 未解決

なし

## 変更履歴
