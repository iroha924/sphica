---
kind: plan
status: approved
codex_session: 01a10fa9-1b95-7103-9cb4-8d7a76c5e6e4
codex_rounds: 3
approved_at: 2026-10-06
---

# 評価の採点を終わった分から保存し、止まった後の再実行では残りだけを採点する（#269）

## 要点

- `grade.ts` は、採点者（Codex・Claude）の 1 回の呼び出しが終わるたびに、その生の結果（終了コードと出力）を `<build dir>/grades.checkpoint.json` に一時ファイルと rename で書く
- 再実行では、行・採点者・入力のすべて（行の識別、タスク定義、採点者に渡す文面、回答、パッチ、ビルド、schema、Codex の設定、起動の引数）が一致する保存済みの結果だけを使い、残りを採点する
- 保存した生の結果は、使うときに今の `receiveGrade` を通し直す。終了コードが 0 でない結果は保存せず、次の実行で採点し直す
- 壊れた checkpoint は、どの採点者も呼ぶ前にファイル名を挙げて止まり、ファイルには触らない
- eval-loop Skill の 5 段目に、checkpoint と、最初から採点し直すときは消すことを 1 行で足す
- 変えないもの: `grades.json` の形、採点の文面・schema・受け入れの規則、report.ts、パッケージ（リリースなし）

## 持ち主の決定

- 次の作業は GitHub Project の Phase 01 の束 T1（#269）にする（おすすめの提示に「OK」）
- #269 の項目と完了条件: 終わった採点を 1 件ずつアトミックに保存する。再実行では task・answer・patch・build・採点者への入力が一致する保存結果だけを使い、残りを採点する。途中で止めたテストの再実行で残りだけが採点され、`bun run verify` が通る

## 目的

- 採点の途中で grade.ts が止まっても（kill・Ctrl-C・クラッシュ）、終わった採点者の呼び出しの結果が残る
- 同じ `loop.json` で再実行すると、保存済みで入力が一致する（行, 採点者）は呼ばれず、残りだけが呼ばれる。終わったビルドの再実行では 1 回も呼ばれない
- 入力のどれかが変わった行は採点し直される。最後の `grades.json` は今と同じ形

## 対象外

- 採点の並列化、1 回の実行の中での再試行、同じビルドで grade.ts を 2 つ同時に動かすことへの lock
- 第 2 採点者（Claude）のモデルを固定すること。今は `--model` を渡しておらず、固定すると採点の挙動が変わる。Claude の採点は一致度を見るためだけに残し、数えない
- 採点の文面・schema・受け入れの規則・report.ts の変更

## 前提

- `server/evals/cloud/grade.ts:127-169`: 採点はメモリの `graded` にため、ループの後に一度だけ `grades.json` を書く（2026-10-06 に読んだ）
- `server/evals/cloud/grading.ts:39-73`: `blindPrompt` はタスク id と run を含まず、空の回答・パッチを `(empty)`・`(no changes)` に置き換える。文面だけをキーにすると、別の行や別の値がぶつかる（Codex が読み取りだけで再現、1 往復目 C1・C2）
- `server/evals/cloud/grading.ts:28-36`: swapped の `gradedTask` は `against` を外し `expect` を置き換えるので、元の expect と against の違いが消える（Codex が再現、2 往復目 C2）
- `server/evals/cloud/codex-home.ts:10-20`: `isolatedCodexHome` は持ち主の config.toml から model と model_reasoning_effort の行だけを写す
- `server/evals/cloud/grade.ts:94-125`: Claude は `--model` なしで起動する。実際のモデルは呼ぶまで分からない（未検証）
- `node scripts/release-plan.mjs --base v0.6.37` → `none`（評価のスクリプト・テスト・Skill はパッケージの外）
- 一時ファイルと rename の書き方は `server/src/file-lock.ts:141` と `server/src/capture.ts:401` にある

## 方針

- checkpoint のコードは `server/evals/cloud/grading.ts` に置く（grade.ts は実行するとすぐ動くスクリプトで、テストから import できないため）。足すもの:
  - `checkpointKey(...)`: 次の値を並べた JSON の sha256（16 進）。`[grader, その採点者の起動引数の定数, 行の識別 [model, task, condition, run], 元のタスク {id, prompt, expect, against ?? null, conflict ?? null}, 採点者に渡す文面, 生の answer, 生の patch, patch_truncated, presented ?? null, build, bundle, variant, grade.schema.json の本文の sha256, Codex の隔離した config.toml の本文（Claude は null）]`
  - `loadCheckpoint(file)`: 無ければ空。あれば zod の strict な schema で全体を検査する（`{ version: 1, entries: record<64 桁の 16 進, { grader: "codex" | "claude", status: number | null, output: string, at: string }> }`）。読めない・形が違う・version が違うときは、ファイルのパスを挙げて throw する。ファイルは書き換えない
  - `saveCheckpoint(file, data)`: 同じディレクトリの `<file>.<pid>.tmp` に書き、fsync して rename する。失敗したら一時ファイルを消して throw する
- 起動引数は採点者ごとに 1 つの定数にし、spawn とキーの両方がそれを使う（1 回ごとの一時ディレクトリのパスは定数に入れない）
- grade.ts の流れ:
  - ループの前に checkpoint を読む。失敗したら非 0 で終わる（採点者は呼ばない）
  - 行ごと、採点者ごとに、キーが checkpoint にあれば呼ばずに使う。無ければ呼び、終了コードが 0 なら書き足して保存してから次へ進む（Codex を保存してから Claude を呼ぶ）。0 でない結果は保存しない
  - 使う結果は保存済みでも新しくても、今と同じ `receiveGrade` を通す
  - 保存に失敗したら、そこで非 0 で終わる（次の採点者を呼ばない）
  - 行ごとの出力に、呼ばずに使ったときは `reused` を出す。最後に、呼んだ回数と使い回した回数を出す
  - `grades.json` は今の形のまま、一時ファイルと rename で書く。checkpoint は消さない
- テスト（`server/test/eval-grade.test.ts`、名前に必ず `checkpoint` を入れる）。子プロセスには偽の `codex` と `claude` を PATH の先頭に置き、`PATH`・`HOME`・`CODEX_HOME` を明示して渡す（持ち主のものを引き継がない）:
  - 止まった実行の再開: 3 行、2 回目の呼び出しで偽の codex が親を `kill -9` する。最初の実行が kill で終わったこと、checkpoint に 1 件あることを確かめる。再実行では codex が 2 回だけ呼ばれ、`grades.json` に 3 行があり、1 行目の採点は最初の実行の値のまま
  - 終わったビルドの再実行で呼び出しが 0 回、採点も同じ
  - 1 行の answer を変えると、その行だけ呼ばれる
  - 終了コード 1 の行は再実行で呼ばれ直す。終了コード 0 で形の崩れた出力は使い回され、`ungraded` の理由も同じ
  - Claude を呼んでいる途中で止めると、再実行では codex は 0 回、claude だけが呼ばれる
  - 壊れた checkpoint（JSON でない、形が違う、version が違う）で非 0 終了・ファイル名を表示・バイト列はそのまま・採点者の呼び出しは 0 回
  - 文面が同じで run だけが違う 2 行は、2 回呼ばれて 2 件になる
  - 保存の失敗: 1 件保存した後にビルドのディレクトリを読み取り専用（0o555）にする。非 0 で終わり、エラーが checkpoint のパスを挙げ、前の checkpoint が 1 件のまま読め、失敗の後に採点者が呼ばれていない。権限は `finally` で戻す
  - `checkpointKey` の単体テスト: 何も変えなければ同じキー。上の各要素を 1 つずつ変えると違うキー（swapped で expect・against を変えたとき、文面だけを変えたときも含む）
- eval-loop Skill の 5 段目に 1 行: 採点の結果は `grades.checkpoint.json` に 1 件ずつ残り、再実行は残りだけを採点する。最初から採点し直すときはこのファイルを消す。Claude の既定のモデルが変わっても検出しない

## 採った案と棄却した案

- 採用: 生の結果（終了コードと出力）を保存し、使うときに `receiveGrade` を通し直す。棄却: 受け入れた後の採点を保存する（受け入れの規則が変わると古い判定が残る）
- 採用: 行の識別・元のタスク・生の値・文面のすべてをキーに入れる。棄却: 採点者への文面だけをキーにする（別の行が同じ文面になり、空の値が置き換えで同じ文面になる）
- 採用: Claude のモデルはキーに入れず、検出しないことを Skill に書く。棄却: Claude のモデルを固定する（第 2 採点者の挙動が変わり #269 の範囲を出る。Claude の採点は数えない）
- 採用: 終了コードが 0 でない結果は保存せず再実行で呼び直し、0 で形が崩れた出力は使い回す。棄却: 形が崩れた出力も呼び直す（通るまで呼び直すと採点が偏る）
- 採用: 1 件ごとに checkpoint 全体を一時ファイルと rename で書き直す。棄却: JSONL への追記（最後の行が途中で切れたときの扱いが要る）
- 採用: 終わった後も checkpoint を残し、最初からやり直すときは消す。棄却: 終わったら消す（終わったビルドの再実行でまた課金される）

## 手順

- S1: `grading.ts` に `checkpointKey`・`loadCheckpoint`・`saveCheckpoint` と起動引数の定数を足し、キー・読み込みの検査の単体テストを書く
- S2: grade.ts を checkpoint で動かし、`grades.json` をアトミックに書く。止まった実行の再開から保存の失敗までの子プロセスのテストを書く
- S3: eval-loop Skill の 5 段目に 1 行を足す

## 完了条件

- A1: `cd server && node --test --test-name-pattern="checkpoint" test/eval-grade.test.ts` → すべて pass、fail 0
- A2: `git stash push server/evals/cloud && cd server && node --test --test-name-pattern="checkpoint resumes" test/eval-grade.test.ts; cd .. && git stash pop` → 変更前の grade.ts では fail する（再実行で codex が 3 回呼ばれる）
- A3: `bun run verify` → 通る
- A4: `node scripts/release-plan.mjs --base v0.6.37` → `release kind: none`
- A5: `gh pr checks <PR 番号> --watch` → 全項目 pass

## リスク

- `kill -9 $PPID` の偽 codex は POSIX の sh に頼る → 既存の採点のテストと同じく Linux と macOS の CI で流す。Windows のジョブはこのファイルを流していない
- chmod 0o555 で書き込みが止まらない環境（root など） → テストは失敗が起きたことを確かめるので、止まらなければ落ちて分かる。そのときは失敗の起こし方を変える
- 偽の codex が呼ばれた回数を数えるファイルがビルドのディレクトリに入ると、保存の失敗のテストで書けなくなる → 数えるファイルはビルドのディレクトリの外に置く

## 未解決

なし

## 変更履歴
