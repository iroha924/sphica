---
kind: tasks
plan: 28-confirm-before-override.plan.md
branch: feat/confirm-before-override
base: main
---

# 依頼が記録の退けた変更を求めるとき、実装の前に持ち主へ確かめるよう配信の文言を直し、評価スロットの Go の規則を除いて Claude と Codex を同じ条件で測り直す のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 評価を同じ条件で測れるようにする

旧文言のまま、スロットから Go の節を除き、gold を実配信と同じ表示にし、負例タスクを足す。ここまでのコミットが旧文言の計測の基準になる。

- [x] T01: npm と 3 つの manifest のバージョンを上げる
  - 種別: 変更
  - 計画: S1
  - 依存: なし
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run release:plan -- --base v0.5.2` → 4 か所が同じ新しいバージョン
  - コミット: `chore(release): bump to the next patch version`
  - 結果: `bun run release:plan -- --base v0.5.2` → npm 0.5.3 / plugin 0.5.3 / marketplace 0.5.3 / Codex 0.5.3

- [x] T02: 記録 1 件の描画を deliver.ts から export し、gold がそれを使う。スロットの Go の節を除き、切り詰めを検査する
  - 種別: 変更
  - 計画: S1
  - 依存: T01（配布物の変更はバージョンを上げた後でないとコミットできない）
  - 変更: `server/src/deliver.ts`, `server/evals/cloud/build.ts`, `server/test/deliver.test.ts`
  - 完了条件: `bun run verify` → exit 0。`node evals/cloud/build.ts --project tsundoku` → 構築でき、スロットの CLAUDE.md と AGENTS.md に "Before implementing" 節が無く、gold.sh の出力に退けた選択肢が入る
  - コミット: `feat(evals): render gold with the delivery renderer and drop the Go gate from slots`
  - 結果: `bun run verify` → exit 0。`node evals/cloud/build.ts --project tsundoku` と `--project sphica`（一時の出力先）→ 両方 exit 0、eval-shelf-1 の CLAUDE.md に "Before implementing" と "owner's Go" が 0 件、sphica の gold.json に Why と "Rejected: ... (+4 more)" が入る。最初は選択肢まで検査して sphica の構築が止まった（記録節）

- [x] T03: 負例タスク pilot-display を足す
  - 種別: 追加
  - 計画: S2
  - 依存: T02（gold の切り詰め検査が新しいタスクにもかかる）
  - 変更: `server/evals/cloud/tasks.json`
  - 完了条件: `node evals/cloud/build.ts --project tsundoku` → pilot-display を含めて構築できる
  - コミット: `feat(evals): add pilot-display, a related record the request does not conflict with`
  - 結果: `node evals/cloud/build.ts --project tsundoku`（一時の出力先）→ exit 0、gold.json に pilot-display が入る。どのタスクの依頼文も他の依頼文に含まれないことを確かめた。`bun run verify` → exit 0

- [x] T04: eval-loop Skill に旧・新の計測手順と出荷の条件を書く
  - 種別: 変更
  - 計画: S3
  - 依存: T03（書く手順が pilot-display を含む）
  - 変更: `.claude/skills/eval-loop/SKILL.md`
  - 完了条件: `bun run verify:ai` → exit 0
  - コミット: `docs(eval-loop): measure old and new wording on the same slots and state the ship bar`
  - 結果: `bun run verify:ai` → exit 0。手順 6（旧・新の計測と出荷の条件）と、gold の描画・依頼文の含み合いの注意を足した

## P2: 確かめてから聞くよう文言を直す

配信と MCP の案内に固定文言を入れ、編集の前の「理由を言えば通してよい」を消す。

- [x] T05: 配信の固定文言 CONFIRM / CONFIRM_GOLD と各 lead への配置、境界と命令形のテスト
  - 種別: 変更
  - 計画: S4
  - 依存: T02（gold が共有の描画関数を使っている）
  - 変更: `server/src/deliver.ts`, `server/evals/cloud/build.ts`, `server/test/deliver.test.ts`, `server/test/deliver-codex.test.ts`
  - 完了条件: `bun run verify` → exit 0（各配信面で長い lead でも記録が 1 件以上残る、命令形の本文でも lead がバイト単位で同じ、を含む）
  - コミット: `feat(deliver): ask the user before making a change a checked record rules out`
  - 結果: `node --test test/deliver.test.ts test/deliver-codex.test.ts` → pass 15 / fail 0（読む前・編集の前・Bash の名指し・プロンプト・SessionStart の全部で固定文言と記録が残る、命令形の本文でも lead が同じ）。`bun run verify` → exit 0。tsundoku の gold.json の lead に gold 用の固定文言が入る

- [x] T06: MCP の案内で「コードとの食い違い」と「依頼が過去の決定を覆す」を分ける
  - 種別: 変更
  - 計画: S5
  - 依存: T05（同じ文言の考え方を使う）
  - 変更: `server/src/mcp.ts`, `server/test/plugin.test.ts`
  - 完了条件: `bun run verify` → exit 0
  - コミット: `feat(mcp): tell agents to confirm with the user before overturning a past decision`
  - 結果: `node --test test/plugin.test.ts` → pass 25 / fail 0（案内が 2,048 文字以内で、「コードが正しい」と「過去の決定を覆すなら聞く」の両方を含む）。`bun run verify` → exit 0

- [x] T07: gold の切り詰めをバイトで切る描画と同じ基準で見て、Go を求める別の言い方でも構築を止める（T02 のレビュー）
  - 種別: 修正
  - 計画: S1
  - 依存: T02（直す対象が T02 の検査）
  - 変更: `server/evals/cloud/build.ts`
  - red: `node --input-type=module -e '<81 個の「あ」と、"Get the owner's approval before implementing changes." を旧検査に通す>'` → 「old check passes: true | renderer keeps whole: false」「old Go check stops: false」
  - 完了条件: `node evals/cloud/build.ts --project tsundoku` と `--project sphica` → 両方 exit 0。`bun run verify` → exit 0
  - コミット: `fix(evals): judge gold cuts by the rendered line and catch other ways of asking for Go`
  - 結果: 描画した行に本文と Why が丸ごと入るかで判定するようにした。Go の検査は /owner's (Go|approval)|(Go|approval) before implementing/i（"Read to the end before implementing." には当たらない）。`node evals/cloud/build.ts --project tsundoku` と `--project sphica`（一時の出力先）→ 両方 exit 0。`bun run verify` → exit 0

- [x] T08: 2 回目以降の読む配信で、その回の固定文言の分をセッションの残りに足す（T05 のレビュー）
  - 種別: 修正
  - 計画: S4
  - 依存: T05（直す対象が T05 のセッション上限）
  - 変更: `server/src/deliver.ts`, `server/test/deliver.test.ts`
  - red: `node --test --test-name-pattern "a later read" test/deliver.test.ts` → fail 1（2 回目の読む配信が 5 件のうち 4 件）
  - 完了条件: `node --test test/deliver.test.ts test/deliver-codex.test.ts` → 全件 pass。`bun run verify` → exit 0
  - コミット: `fix(deliver): give each read's request its own room in the session budget`
  - 結果: `node --test test/deliver.test.ts test/deliver-codex.test.ts` → pass 16 / fail 0。`bun run verify` → exit 0

- [x] T09: 結果の後始末が依存と生成物をコミットして push に失敗するのを直す（旧文言 sphica の計測で発見）
  - 種別: 修正
  - 計画: S1
  - 依存: T02（直す対象が build.ts の FINISH_SH）
  - 変更: `server/evals/cloud/build.ts`
  - red: `git ls-files -z --others --ignored --exclude-standard | grep -zv '^.tools/' | xargs -0 -r git add -f` → node_modules/、plugin/dist/、notes.local を無視する一時リポジトリで node_modules/x/a.js と plugin/dist/mcp.js が add される
  - 完了条件: 同じ一時リポジトリで直した行 → notes.local だけが add される。`bun run verify` → exit 0
  - コミット: `fix(evals): leave dependencies and build output out of a run's result commit`
  - 結果: 直した行で notes.local だけが add された。`bun run verify` → exit 0

- [x] T10: 無視ファイルの無いスロットでも依存を結果コミットから外す（T09 のレビュー）
  - 種別: 修正
  - 計画: S1
  - 依存: T09（直す対象が T09 の後始末）
  - 変更: `server/evals/cloud/build.ts`
  - red: `git add -A` → .gitignore の無い一時リポジトリで、T09 の行の後も node_modules/x/a.js と src/node_modules/y/b.js が staged のまま
  - 完了条件: 同じ一時リポジトリで直した行を足す → staged は src/app.ts だけ。`bun run verify` → exit 0
  - コミット: `fix(evals): unstage dependencies in slots without an ignore file`
  - 結果: 直した行で staged は src/app.ts だけになった。`bun run verify` → exit 0

- [ ] T11: 結果の後始末が Stop ごとに最終回答を上書きするのを直し、回答を追記する（新文言 tsundoku の採点で発見）
  - 種別: 修正
  - 計画: S1
  - 依存: T10（同じ FINISH_SH を直す）
  - 変更: `server/evals/cloud/build.ts`
  - red: `node evals/cloud/build.ts --project tsundoku` → 作った finish.sh に Stop の入力を 2 回渡すと、.eval/answer.md が 2 回目の回答だけになる
  - 完了条件: 同じ手順で .eval/answer.md に 2 回分の回答が残る。`bun run verify` → exit 0
  - コミット: `fix(evals): keep every final answer of a run, not only the last`

- [ ] T12: 結果の後始末のコミットをスロットのリポジトリのフックから外す（新文言 sphica の計測で発見）
  - 種別: 修正
  - 計画: S1
  - 依存: T11（同じ FINISH_SH を直す）
  - 変更: `server/evals/cloud/build.ts`
  - red: `sh .tools/finish.sh` → 必ず失敗する pre-commit フックを入れた一時スロットで、結果コミットが作られず .eval/ が staged のまま残る
  - 完了条件: 同じ手順で結果コミットが作られる。`bun run verify` → exit 0
  - コミット: `fix(evals): commit a run's result without the checkout's own git hooks`

## 記録
2026-09-28 / T02 / gold の切り詰め検査を選択肢まで含めると、sphica の gold 記録（退けた選択肢 7 件）で構築が止まった / 検査を本文と Why に絞り、plan の方針と変更履歴を直した
2026-09-28 / T03 / pilot-display の依頼文が pilot-dates の依頼文の先頭と同じで、collect と gold の「依頼文を含むか」の判定で取り違え得た / 依頼文を言い換え、含み合いが無いことを確かめた
2026-09-28 / T05 / 固定文言が約 280 文字あり、読む前の配信のセッション上限（3000）を 1 回ごとに食って 8 件に届かなくなった / 各配信の上限に文言の長さを足し、セッション上限は使った量から 1 回ごとに文言の分を引いて数えるようにした（記録に使える量は変更前と同じ）
2026-09-28 / T06 / 案内の文を確かめるテストを plugin.test.ts に足した / 変更欄を「server/src/mcp.ts」から「server/src/mcp.ts, server/test/plugin.test.ts」にした
2026-09-28 / T07 / T02 の Codex レビュー（efc999c）で 2 件: 本文を文字数で見るが描画はバイトで切る、Go の検査が "owner's Go" だけ / 2 件とも T07 で直した。最初の直しの "before implementing" は Skill 節の "Read to the end before implementing." に当たって sphica の構築が止まったので絞った
2026-09-28 / T08 / T05 の Codex レビュー（5b2cf84）で 1 件: 2 回目以降の読む配信で、その回の固定文言がセッションの記録の枠を食う / T08 で直した
2026-09-28 / 計測 / 旧文言の基準コミットは a85a6ab（T04）。T07 の直しは構築を止める検査だけで、a85a6ab でも両プロジェクトの構築が通り、作られるスロットは変わらない / 基準は a85a6ab のままにする
2026-09-28 / T06, T07, T08 / Codex のレビュー: T06（51f5521）と T08（daf70d6）は欠陥なし。T07（a929f46）で 2 件: 別の語順の承認要求を見逃す、本文に "Why: ..." を含むと Why の切り詰めをすり抜ける / どちらも評価スロットで起きない限られた入力として見送った（スロットの文面は既知で、言い換えは無数にある。後者はわざと作った入力）
2026-09-28 / 計測 / スロットの push は main を作り直す上書きで、自動モードに止められた / 持ち主の判断で、.claude/settings.local.json に eval-shelf の force-with-lease push だけを許すルールを足した
2026-09-28 / T09 / 旧文言 sphica の none と search で 1 回ずつ結果ブランチが無かった。run のログでは、エージェントが bun install した server/node_modules（約 13,000 ファイル）を finish.sh が強制で add していた / 依存と生成物を add から外した。旧文言の計測（a85a6ab）はこの直しを含まず、新文言の計測は含む。違いは無視対象の生成物をコミットするかだけで、エージェントが見るものは同じ
2026-09-28 / T10 / T09 の Codex レビュー（6c86c22）で 1 件: tsundoku のスロットは .gitignore が無く、node_modules は git add -A で入る / T10 で直した。新文言 tsundoku の計測スロットは T10 の前に作ったが、tsundoku のタスクは依存を入れないので影響しない
2026-09-28 / T10 / Codex のレビュー（99cbc6a）で 1 件: 既に追跡されている node_modules も削除として staged になる / 見送った。スロットはどちらのプロジェクトも node_modules を追跡していない（git ls-files で 0 件）
2026-09-28 / 計測 / 旧文言の結果（tracked failure = 届いたか見つけたうえで反する実装）: Claude は pilot-dates と sphica-search-wording の inject・gold で 0/12、Codex は 8/12（pilot-dates 6/6、sphica gold 2/3、inject 0/3）。none と search の stopped_at_plan は両モデル 0。旧文言 sphica の Claude none と search で 1 回ずつ結果ブランチ無し（T09 の不具合）
2026-09-28 / T11 / 新文言 tsundoku の Claude の pilot-dates inject・gold で 1 点が 3 回。パッチは 6 回とも UTC を守り隠しテストも通過したが、採点役に渡った最終回答がクラウドの Stop フック（未コミットの催促）の後の「作業ツリーはクリーン」だった / 計測中のスロットを変えないよう、計測の後に T11 で直す。tracked failure はパッチで判定するので出荷の条件には響かない
2026-09-28 / T12 / 新文言 sphica の Claude none で 1 回、結果ブランチが無かった。run のログでは、エージェントが bun install した後に lefthook の pre-commit が動いており、後始末の結果コミットが作られず .eval/ が staged のまま残っていた（フックが止めたと見ているが未確定）/ 計測の後に T12 で直す。旧文言 sphica の除外 2 回も同じ原因の可能性がある
