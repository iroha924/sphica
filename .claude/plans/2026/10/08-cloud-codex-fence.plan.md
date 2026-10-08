---
kind: plan
status: approved
codex_session: 01a11b40-4bca-7722-a5b6-f74040c4c041
codex_rounds: 4
approved_at: 2026-10-08
---

# cloud の評価の Codex（run と採点者）に permission profile の囲いを当て、持ち主のログイン・正解・他の run を読めなくする（#305）

## 要点

- `server/evals/cloud/codex.ts`（評価される Codex）と `grade.ts`（Codex の採点者）から `-s` を外し、PR #304 と同じ permission profile の deny で囲う。隠すのは、持ち主の資格情報（Codex のログインを含む）、`server/evals`、評価の出力先 `~/.cache/sphica-eval` の全体、run 自身の `auth.json`、run の DB
- 評価の出力先を `~/.cache/sphica-eval` の下に限る。codex.ts は `--build` と `--out` がその外なら止まり、grade.ts はビルドか、collect が記録した run の置き場がその外なら止まる
- Codex の run の checkout・HOME・TMPDIR は、隠す場所の外の一時ディレクトリで動かす。終わったら今と同じ `<run>/work` などへ移す。Codex を使う評価のプロセスは、共有のロックで 1 つずつしか動かさない
- 囲いの指紋（`fence`）を run と採点の checkpoint、loop.json、grades.json に残す。囲いの前の run は collect で除外し、report は fence の違う結果どうしを比べない
- 実際の Codex で読めないことを確かめる probe（`codex.ts --probe`、`grade.ts --probe`）を足す。Codex のバージョンか runner を変えたら、測る前に流す
- 変えないもの: パッケージ（release なし）、Claude の run、条件ごとに checkout が渡す中身（`.tools` の fixture.db や gold.json）

## 持ち主の決定

- 次の作業を #305 にし、その後に E4（#213・#219）へ進む（2026-10-08、「OK、それで進めよう」）
- 直し方は PR #304 の review の評価と同じ permission profile の deny にする（#305 の本文。持ち主の依頼の範囲）
- 評価はローカルの claude と codex で回し、費用の上限は当面設けない（記録 trace:913af8a9-e6e3-4165-a76b-38f6a3422f57/eval-local-no-cap）

## 目的

- 評価される Codex と Codex の採点者が走らせたコマンドから、次の場所が読めない。probe で `DENIED` と出る
  - `~/.codex/auth.json` と run の `$CODEX_HOME/auth.json`、`DENY_DIRS`・`DENY_FILES` の資格情報
  - `server/evals`（tasks.json の gold、隠しテスト）、`~/.cache/sphica-eval`（ビルド、他の run、ログ）、run の DB
- それでも Codex 自身はログインでき、search と inject の条件で MCP サーバーと配信のフックが動く
- 囲いの前の Codex の run が、測定の結果に数えられない

## 対象外

- checkout が条件ごとに持つ足場（search・inject の `.tools/fixture.db`、gold の `.tools/gold.json`）。その条件がもともと渡す情報で、Claude の cloud の run も同じ checkout を使う。隠すと条件の中身が変わり、#305 とは別の変更になる。既知の限界として eval-loop Skill に書く
- Claude の run（`claude-run.ts` は `blockReadsOutsideWorkingDirectories` と sandbox の `denyRead` で囲ってある）と `claude.ts` の出力先
- review の評価の挙動（共通の関数を移すことと、runnerDigest に移した先を足すことだけ）
- CI で実際の Codex を起動すること

## 前提

- codex-cli 0.160.1（手元の `codex --version`、2026-10-08）
- `-s read-only` と `-s workspace-write` では、モデルのコマンドが `$CODEX_HOME/auth.json` と正解のファイルを読めた。profile の deny では読めず、Codex のログインと MCP サーバーは動いた（#305 の本文の実測、2026-10-08）
- `default_permissions` は最上位のキーで、`[mcp_servers.x]` などの表より前に書く必要がある。`--sandbox` を渡すと古い設定が選ばれ、profile が外れる（#305）
- 親を deny して子を許す形は Codex が自分の実行ファイルを起動できず失敗する（openai/codex#21081、記録 codex-parent-deny-dead-end）。許す場所を deny の下に置かない
- 読み込まれた設定のどれかに `sandbox_mode` があると古い sandbox が選ばれる。システムの `/etc/codex/config.toml` も読み込まれる（https://learn.chatgpt.com/docs/permissions 、https://learn.chatgpt.com/docs/config-file/config-basic 、Codex が 2026-10-08 に確認。0.160.1 での再現は未検証）
- `managedCodexSettings()` が見ているのは、`requirements.toml` と managed preferences だけ（`server/evals/review/runner.ts:35`）
- `SPHICA_SH` は `EVAL_SPHICA_DB` があればその DB を使う（`server/evals/cloud/slot-scripts.ts:32`）
- Codex の PreToolUse の配信フックの matcher は `^apply_patch$|^Bash$`（`plugin/hooks/codex.json:90`）。読む前の配信は、コマンドに出てくる anchor のパスで記録を選ぶ（`server/src/deliver.ts:963`）。前の event で出した記録は選ばない（`deliver.ts:390`）。抑えた配信は行に残らない（`server/src/delivery-view.ts:38`）
- collect は `<run>/work` で隠しテストを流す（`server/evals/cloud/collect.ts:521`）。`--codex`・`--claude`・`--logs` は任意のディレクトリを取り、テストは一時ディレクトリで使っている（`server/test/eval-claude.test.ts`）
- `checkpointKey` は `GRADER_ARGS` と Codex の設定の文面を含む（`server/evals/cloud/grading.ts:231`、`:243`）。review の `runnerDigest` が hash するのは review の 5 ファイルだけ（`runner.ts:55`）
- `bun run release:plan -- --base v0.6.42` は none。予定のファイルの集合も `releaseKind()` で none（Codex が 2026-10-08 に実行）

## 方針

1. 共通の囲い（`server/evals/cloud/codex-home.ts`）
   - `codexProfile` と `managedCodexSettings` を `review/runner.ts` から移す（review は cloud から import する向きのまま）。`managedCodexSettings` は `/etc/codex/config.toml` があっても止まる
   - `fencedCodexHome(codexHome, { base, deny, extraConfig, settings })`: 管理者の設定があれば throw する。`isolatedCodexHome` に、`codexProfile(base, [...deny, <codexHome>/auth.json])` を `extraConfig` より前に置いた設定を書く。settings は呼び出し側が渡した写しをそのまま使う
   - `EVAL_CACHE = realpath(~/.cache/sphica-eval)` と `insideCache(p)`: realpath した後に、パスの要素の単位で中にあるかを見る
   - `fenceDigest(profile, roles)`: profile の文面のパスを役割の名前（`<evals>`、`<cache>`、`<home>/.ssh` など、`<codex-home>/auth.json`）に置き換え、sha256 を取る。マシンをまたいで比べられる
   - `codexLock()`: `EVAL_CACHE/codex.lock` を O_EXCL で作り、pid と開始の時刻を書く。あれば中身を出して止まり、古いロックを自動では奪わない。返す関数で消す
   - review の `run.ts` と `m2.ts` は `fencedCodexHome` に切り替える。`runnerDigest` に `../cloud/codex-home.ts` を足す
2. 評価される Codex（新しい `server/evals/cloud/codex-run.ts` に組み立てを出し、`codex.ts` は CLI の包みにする）
   - `--build` と `--out` を realpath し、`EVAL_CACHE` の外なら止まる。ロックを取ってから一時の状態を作る
   - checkout・HOME・TMPDIR は `mkdtemp(os.tmpdir())` の下に置く。`.tools` の写し、固定した git ディレクトリ、CODEX_HOME、DB（`EVAL_SPHICA_DB=<run>/db/sphica.db` を Codex のプロセスと MCP サーバーの env に渡す）は run のディレクトリ（隠す側）に置く。配信の行もその DB から読む
   - profile は `:workspace`、deny は `server/evals`・`EVAL_CACHE`・`DENY_DIRS`・`DENY_FILES`。`-s` を渡さない。一時の場所が deny の下に入る配置なら止まる
   - `finally` で、一時ディレクトリの `work`・`home`・`tmp` を `<run>/work`・`<run>/home`・`<run>/tmp` へ移して一時の親を消し、最後にロックを外す。成功でも失敗でも同じ
   - result.json に `fence`（`fenceDigest`）と `fence_roots`（実際に deny したパス）を書く
3. collect（`collect.ts`）
   - loop.json に `run_roots`（解決した `--codex`・`--claude`・`--logs`）を書く。Codex の行に `fence` を写す
   - `fence` が無いか、今の `fence` と違う Codex の run は excluded にし、理由を「run without the current read fence」とする。分母には残す
4. 採点者（`grade.ts`、`grading.ts`）
   - `GRADER_ARGS.codex` から `-s read-only` を外す。`gradeOne` は `fencedCodexHome(.., ":read-only", deny = server/evals・EVAL_CACHE・DENY_DIRS・DENY_FILES, settings = 写し)` で囲う
   - ビルドか loop.json の `run_roots` が `EVAL_CACHE` の外なら止まる。`run_roots` の無い loop.json も止まる（collect し直す）
   - `checkpointKey` に Codex の採点者のときだけ `fence` を足す（Claude の checkpoint は今のまま使える）。採点の行に `fence` を写す。採点のあいだはロックを持つ
5. report（`report.ts`）: 比べる両側のどちらかで、測った（excluded でない）Codex の行に `fence` が無いか、片側の中で fence が混ざるか、両側で違うなら、比べずに止まる
6. probe
   - `codex.ts --probe --build <b> --repo <slot> --task <t>`: 出力は `<out>/probe` に分け、collect が数えないようにする
     - 走らせる前に、持ち主の権限で対象が全部あることを確かめる。無ければ止まる
     - inject と search の slot では、fixture の DB の写しに出荷した session start の配信を流す。そこで出なかった live な decision か constraint のうち、`applies_to` の anchor のパスが checkout にあるものを選ぶ。無ければ「no eligible probe target」で止まる
     - checkout に `probe.sh` を置く。`LC_ALL=C` で各対象の先頭 1 バイトを読み、`DENIED`（Operation not permitted / Permission denied）、`MISSING`（No such file or directory）、`READ`（成功）、`ERROR`（それ以外）のどれかを出す。最後の行には、選んだ anchor のパスを読む `head -c 1 <path>` を、実行せずに出す
     - 対象は `$CODEX_HOME/auth.json`、`<実際の home>/.codex/auth.json`、存在する `DENY_DIRS` の 1 つと `DENY_FILES`、`server/evals/cloud/tasks.json`、ビルドの `tasks.json`、`EVAL_CACHE` に置いた token のファイル、`<run>/db/sphica.db`、checkout の中の対照のファイル（これだけ `READ`）
     - prompt には、`./probe.sh` を流して出力を引用し、最後の行のコマンドを流すことだけを書く。パスは prompt に書かない
     - 判定は、events.jsonl の完了した `command_execution` の出力で行う。モデルの答えは見ない。search の slot では、エラーの無い完了した `mcp_tool_call` の結果に fixture の記録のキーがあること。inject の slot では、選んだキーを含む emitted の `pre_read` の行があること
   - `grade.ts --probe --loop <build>/loop.json`: 採点と同じ囲いで、採点者の空のディレクトリに probe.sh を置いて 1 回流す。`--json` は probe のときだけ付け、同じ形で判定する。checkpoint と grades.json を読み書きする前に終わる
7. eval-loop Skill: Codex のバージョンか runner を変えたら、測る前に両方の probe を流す。Codex を使う評価は 1 つずつ動かす（ロックが止める）。出力先は `~/.cache/sphica-eval` の下に限る。checkout の足場は既知の限界として書く

## 採った案と棄却した案

- 採用: profile の deny で隠す場所だけを並べる。棄却: `-s read-only`／`workspace-write` のまま（全体を読める）、`:root` を deny して必要な所だけ許す（Codex が起動できない）、外側の `sandbox-exec` で包む（Codex が自分の sandbox を当てられない）
- 採用: 出力先を `~/.cache/sphica-eval` の下に限り、全体を deny する。棄却: 他のモデルの run の置き場を codex.ts の入力で受ける（受け渡しの抜けが残り、Claude の置き場を codex.ts が先に知れない）
- 採用: ロックは `--out` によらず 1 つにし、採点者も含める。棄却: `--out` ごとのロック（別の `--out` 同士で互いの一時 checkout を読める）
- 採用: 生きた DB を run のディレクトリに置く（`EVAL_SPHICA_DB`）。棄却: checkout の足場も隠す（条件の中身が変わる。別の変更）
- 採用: フックや MCP が囲いの下で動かなければ止めて計画をやり直す。棄却: tools を一時ディレクトリへ移す（`:workspace` で書けるため、モデルが書き換えたものを Codex が sandbox の外で走らせる）
- 採用: probe は、prompt に出さないパスを実際に読ませ、emitted の `pre_read` を求める。棄却: 抑えた配信の行で代える（行が残らない）、matcher が Bash に当たることだけで良しとする（anchor が無ければ行が出ない）
- 採用: 囲いの指紋は役割の名前で正規化する。実際のパスは別に `fence_roots` として残す。棄却: 実際のパスを hash する（マシンや run ごとに変わり、比べられない）

## 手順

- S1: codex-home.ts の共通の囲い（profile、管理者の設定の検査、`fencedCodexHome`、`EVAL_CACHE`、`fenceDigest`、ロック）と、review の切り替えと runnerDigest
- S2: codex-run.ts と codex.ts の囲い（出力先の制限、一時の場所、DB の置き場、profile、片付け、`fence` と `fence_roots`）
- S3: collect の `run_roots` と `fence`、囲いの無い run の除外
- S4: grade と grading の囲い（`-s` を外す、出力先の制限、settings の写し、checkpoint の `fence`、ロック）
- S5: report の fence の比較
- S6: `codex.ts --probe` と `grade.ts --probe`
- S7: eval-loop Skill

## 完了条件

- A1: `bun run verify` → 0 で終わる。新しいテストは、変えた起動の挙動（codex.ts と grade.ts の引数・設定・deny、出力先の制限、ロック、片付けの配置、checkpoint・collect・report の fence）について、直す前のコードで失敗したことを tasks の結果行に残している
- A2: `node server/evals/cloud/codex.ts --probe --build <build> --repo <inject の slot> --task <task>` → 秘密の対象がすべて `DENIED`、対照が `READ`、選んだキーを含む emitted の `pre_read` の行がある
- A3: `node server/evals/cloud/codex.ts --probe --build <build> --repo <search の slot> --task <task>` → 秘密の対象がすべて `DENIED`、エラーの無い完了した `mcp_tool_call` の結果に fixture のキーがある
- A4: `node server/evals/cloud/grade.ts --probe --loop <build>/loop.json` → 秘密の対象がすべて `DENIED`、checkpoint と grades.json が変わらない
- A5: 1 つのタスクについて none・search・inject・gold の各条件で `codex.ts` を 1 回ずつ流し、`collect.ts --build <build> --no-cloud --local-plan <plan>` → 4 行とも excluded でない。`answer_format` が valid で、隠しテストの結果は実際に流れたもの（not run でない）。gold の行には gold の receipt がある
- A6: `gh pr checks <PR>` → 全項目 pass。merge の前の Codex の全差分のレビューで、未対応の指摘が 0

## リスク

- 囲いの下でフックか MCP サーバーが動かない（A2・A3 で分かる） → 止めて、計画をやり直す（tools を書ける場所へ移す案は採らない）
- `:workspace` でも一時の場所への書き込みが deny に当たる → 一時の場所が deny の下に無いかを起動の前に確かめ、A5 で実際の run が終わることを見る
- Codex の更新で profile の書式か優先順位が変わる → eval-loop Skill の手順どおり、バージョンを変えたら probe を流す
- 古いロックが残って評価が止まる → 止まったときにロックの中身（pid と時刻）を出す。持ち主か Claude が、そのプロセスが無いことを確かめてから消す

## 未解決

なし

## 変更履歴
