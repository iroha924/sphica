---
kind: plan
status: approved
codex_session: 01a120e8-15f6-77a0-bf88-39a207aeda7b
codex_rounds: 4
approved_at: 2026-10-09
---

# 書いた本文が名指しした記録を書いた直後に配る実験（#213）と、shell で変わったファイルの取りこぼしの測定（#219）（E4）

## 要点

- #213 を「書いた直後の配信（post_write）」に絞る。同期の PostToolUse で、書いた本文に記録の anchor の symbol・path・option が onPrompt と同じ規則で出ていたら、その会話でまだ配っていない記録を理由付きで配る。ExitPlanMode・Codex の Plan モード・チャットだけの計画は扱わない
- 作る前に、モデルを回さない入口の検査（M0: 過去の書き込みの再生と持ち主のラベル）と、今のバンドルの baseline と A/A（M1a）を測る。どちらかで止まれば作らずに不採用を記録する
- 採否は M1 で、main のバンドルと作業ブランチのバンドルを同じ fixture・同じ `inject` 条件で比べ、モデル別に「最終の patch に却下した内容が残った run」で決める
- 実験中は schema を変えない（post_write は `event='pre_edit'`・`reason='post_write'` で記録）。採用したときだけ revision 13 で `post_write` の値を足す
- #219 は作らずに取りこぼしを測る（M0'）。基準を下回れば不採用、上回るか決まらなければ止めて持ち主に戻す（次の段は別の計画と Go）
- 変えないもの: 既存の配信イベント（session_start・prompt・pre_edit・pre_read・review）の選び方と上限、capture、record サーバー、bashEditDiff は使わない

## 持ち主の決定

- epic #200 の次の作業を E4（#213 と #219）にする（2026-10-09、「OK、それで進めよう」）
- epic #200 の方針: 実験は仮説・測り方・基準・届かなかったときの扱いを持ち、merge の前に PR ブランチで測る。基準に届かない実験は最終の差分から外して結果を issue に残す。測るために npm へ出さない
- 評価はローカルの claude と codex で回し、費用の上限は当面設けない（記録 trace:913af8a9-e6e3-4165-a76b-38f6a3422f57/eval-local-no-cap）
- 利用者に API キーや追加の課金を求める機能は作らない

## 目的

- 書いた本文が過去の記録（却下した案・dont の決定・anchor の symbol や path）を名指ししたとき、その記録と理由（却下した案を含む）が、同じターンの次のモデルリクエストでエージェントに届く
- #213 と #219 の採否が、測った数字とともに各 issue に残る。打ち切った場合は「この入力と基準では改善を確かめられない」と、機能の価値の否定を分けて書く

## 対象外

- ExitPlanMode の hook。additionalContext は承認の後に届き、承認の前に届くのは deny の理由だけ。持ち主は plan mode を使っていない。Codex に計画の hook は無い
- Codex の Plan モード（`<proposed_plan>`）とチャットだけで示す計画。「計画一般の検出」は達成としない
- 照合を広げること（別名・言い換え・option の文からの字面の抜き出し）。#260 の範囲
- Bash・PowerShell の本文（Bash 内の patch を含む）。shellPatch() は表示だけの heredoc も拾い、Codex の Bash の PostToolUse は失敗したコマンドでも発火する
- bashEditDiff。プラグインからは有効にできず、Codex に同じ入力が無い
- permissionDecision の ask / deny でエージェントを止めること
- #219 の配信の実装（M0' を通ったときは別の計画）

## 前提

- 却下した案の文: 持ち主の DB の active な rejected option 184 件のうち、バッククォートでコードを囲むものは 0 件で、ほぼ全部が日本語の文（2026-10-09、`sqlite3 -readonly` で集計）。onPrompt の option 照合は option の全文を Unicode の語境界で照合する（`server/src/deliver.ts:526`）ので、コードに option が当たることはまず無い。当たるのは symbol・path と、計画の文書（推測）
- ExitPlanMode: 持ち主の Claude Code の会話記録（`~/.claude/projects` 配下 1097 プロジェクト）に呼び出しは 0 件。このプロジェクトの `.plan.md` への Write は 55 件（2026-10-09 集計、Codex も再集計）
- Claude Code 2.1.295: PreToolUse(ExitPlanMode) の additionalContext はツールの結果の隣に置かれ、承認の後に読まれる（https://code.claude.com/docs/en/hooks 、2026-10-09。承認前に読まれない点は実行の順序からの推測で確度は高い）。同期の PostToolUse の additionalContext は次のモデルリクエストに載り、async の hook は次のターン。上限は文字列ごとに 10,000 字。書いた本文は Edit の `new_string`、Write の `content`、NotebookEdit の `new_source`。2.1.295 に MultiEdit のツール定義は無い（researcher と Codex が独立に確認）
- Sphica の capture の PostToolUse は `async: true`（`plugin/hooks/hooks.json`）なので、配信には同期の hook を別に立てる
- Codex 0.162.0: PostToolUse の additionalContext は apply_patch・Bash・MCP で使え、同期の hook なら同じターンの次のサンプリングの前に developer メッセージとして入る（`codex-rs/core/src/tools/registry.rs`、`hooks/src/events/post_tool_use.rs`、tag rust-v0.162.0）。上限は約 2,500 トークン（`hooks/src/output_spill.rs`）。apply_patch の PostToolUse は成功したときだけ走る。計画の提示・承認の hook は無く、PreToolUse の ask は使えない（`hooks/src/events/pre_tool_use.rs`）。shell が変えたファイルを知らせる入力は無い
- bashEditDiff: `bashEditDiffEnabled` は user・`--settings`・managed だけが true にでき、未設定なら auto / bypassPermissions かつ段階配信の条件のときだけ値が入る（https://code.claude.com/docs/en/settings-reference 、インストール済みの 2.1.295 の実装、2026-10-09）
- Bash / PowerShell の PreToolUse は、anchor の path を名指すコマンドに記録を pre_read（named）として配る（`server/src/deliver.ts:459` namedInCommand）
- beforeEdit は 1 回 5 件まで、文字数でも省く（`server/src/deliver.ts:278`）。ログの失敗でも配信は返す（`:1049`）
- delivery.event は CHECK で 5 つの値（`db/schema.sql:1148`）、`reason` は自由な文字列（`:1150`）。今の revision は 12（`db/schema.sql:1270`、`server/src/sqlite.ts:17`）。reader は revision の不一致を拒む（`server/src/sqlite.ts:63`）
- `event='pre_edit'`・`reason='post_write'` の行は、beforeRead では配信済みとして扱われ、読みの予算（pre_read だけを数える）を使わず、compact / clear の位置（session_start の reason だけを見る）も変えない（`server/src/deliver.ts:339-391`、Codex が確認）。delivery-view は event と outcome で合算し reason を出さない（`server/src/delivery-view.ts:340`、`:378`）ので、実験の採点に overview は使わない
- 評価の runner は `inject` で SessionStart・UserPromptSubmit・PreToolUse の配信だけを設定する（`server/evals/cloud/claude-run.ts:62`、`server/evals/cloud/codex-run.ts:386`）。Claude の runner は ignored のファイルも `add -f` で集めるが（`claude-run.ts:195`）、Codex の runner は `git add -A` だけ（`codex-run.ts:443`）
- `report.ts --compare` は同じ fixture・同じタスクの新旧のバンドルを比べ、バンドルは成果物の hash と配信の matcher で区別する。`same` で A/A を比べる（`server/evals/cloud/report.ts:292-312`）。比較のキーは task・model・condition（`:349`）
- 既存の評価（2026-09-30、tsundoku）: implements_rejected=yes は対象のある run のうち inject で Claude 1/8・Codex 2/8、none でも同じ（`~/.cache/sphica-eval/builds/*/grades.json`）。今の配信で差が出ていない
- 持ち主の DB の edit_observation: 同じターン・同じ path に tool の行が無い via=status の行が 3,364 行・473 ターン、active な decision / constraint の applies_to が付いた path は 1,007 行・316 ターン（claude-code だけ）。edit_observation は変更の原因を持たず、HEAD が進んだターンは commit 間の変更も合算する（`server/src/worktree.ts:63`）

## 方針

### post_write（#213）

- hook: Claude Code は PostToolUse、matcher `Edit|Write|MultiEdit|NotebookEdit`、同期、timeout 5、`deliver.js`。capture の async の hook とは別の entry。Codex は PostToolUse、matcher `^apply_patch$`、`deliver.js codex`（Windows は既存と同じ `-EncodedCommand` の形）
- 照合する本文: Edit の `new_string`、MultiEdit の `edits[].new_string`（古いホスト向け）、Write の `content`、NotebookEdit の `new_source`（`edit_mode` が delete のときは見ない）、apply_patch はパッチ内の全ファイルの `+` 行。`old_string` と削除行は見ない
- 照合の規則: onPrompt と同じ（symbol は 3 字以上、小文字だけの語は `(` か backtick 付きのときだけ。path は pathNamed。option は 3 字以上の語境界一致）。onPrompt の照合部分を関数に切り出して両方から使う。ヒットは候補であって違反ではない
- 順序: 照合 → その会話（同じ session と agent、最後の compact / clear の後）で emitted になった delivery_unit の記録を除く → 会話あたりの予算 → 1 回の件数・文字数の上限。書いたファイル自体に anchor があるかでは除かない
- 上限: 1 回 3 件・900 字 + 依頼文。会話あたりの予算は M0 の会話ごとの発火数（中央値・最大）から実装の前に決めて、この計画の変更履歴に書く
- 文面: lead は「今書いた内容が次の記録を名指ししています（今のコードとの関係は未確認）。」に、固定の CONFIRM と NOTE を続ける。各行は beforeEdit と同じ recordLines の形（理由と却下した案を含む）に、names の理由（何を名指したか）を付ける
- 並行: lockedPlan を通す（pre_read と同じ）。ロックやログの失敗時は今と同じ best effort
- 記録: 内部のイベントは post_write として扱い、ログに書くときだけ `event='pre_edit'`・`reason='post_write'` に写す。採用したら revision 13 で CHECK に `post_write` を足し、移行で `reason='post_write'` の行を `event='post_write'` に直す（移行 SQL、旧 revision の fixture、型の生成、delivery と delivery_unit と採番の保持。knowledge-schema の手順）

### M0（#213 の入口の検査、モデルを回さない）

- 入力: 持ち主の Claude Code の会話記録の Edit / Write / NotebookEdit の入力と、Codex のセッションの apply_patch。今の DB の記録に対して post_write と同じ照合と除外（書き込みの前に emitted になった配信だけを見る）をかける。結果は「今の記録を過去の入力に当てた再生」と明記する
- 集計: （書き込み, 記録）の組を、host・計画の文書かコードか・symbol / path / option のどれで当たったか別に出す。会話ごとの発火数（中央値・最大）は予算の決定用に、ラベル用とは別の標本で出す
- ラベル: 持ち主が「関連（却下案の再提案・dont に反する内容）」「関連（無害な言及・引用・否定）」「無関係」で付ける。標本は文書とコードで層別に最大 40 組を、ラベルを付ける前に固定の seed で決める。当たる組が 20 未満なら、その旨を書いて M1a に進む
- 基準（作るかどうか）: 標本の中で無関係が 1/3 以下、かつ「却下案の再提案・dont に反する内容」が 1 組以上。割合は標本の中の値で、実利用の誤配率とは呼ばない

### M1a（今のバンドルの baseline と A/A、作る前）

- タスク: 記録が今の配信経路（プロンプトの照合・pre_edit・pre_read・session_start）で届かない形に作る。記録の anchor はタスクが開かず名指しもしないファイルにあり、プロンプトは記録の symbol・path・option を名指さない。却下した内容は別のファイル（追跡対象の `docs/` の計画の文書、または却下した方法を作り直す新しいモジュール）に書かれやすい。違反のタスク 3 つ、should_not_block と should_stay_quiet を 1 つ以上ずつ。違反のタスクは正当な完了を隠しテストで確かめ、should_not_block と should_stay_quiet は不要な停止を失敗にする
- 流す前の確認: 既知の違反を含む docs/ の文書が、両ホストで違反として採点される
- 測定: main のバンドルの `inject` で、モデル別に k=5 を 2 回（A/A）。search で対象の記録を引いた run は区別して数える
- 基準: モデル別に、違反の run が 2 回の合計 10 run 中 2 以下なら、そのモデルは「測れない」で採否を担えない。両モデルとも測れなければ打ち切って不採用を記録する。測れるモデルについては、M1 の k と必要な改善幅をこの結果から post_write の結果を見る前に決め、変更履歴に書く

### M1（本測定、作った後）

- runner: `inject` のまま、ビルドの hooks.json / codex.json に PostToolUse の配信の entry があるときだけ PostToolUse の配信 hook を設定する。matcher は deliverMatcher と同じ読み方で取り、成果物の hash と一緒に manifest に残す。runner の配信の結果に `reason`・時刻・tool_use_id を足す。各 run の書き込みの本文（Claude は stream-json のツール入力、Codex はセッションのログの apply_patch）を run のログに残す。流す前に、hook が発火し文脈が次のリクエストに届いたことを 1 run ずつ両ホストで確かめ、report の compare を既知の結果（良くなる・悪くなる・同じ）で確かめる
- 比較: 同じ fixture から作った main のバンドル（old）と作業ブランチのバンドル（new）を `report.ts --compare` で比べる
- 基準（モデル別、合算しない）: 採用は、測れるモデルの少なくとも 1 つで「最終の patch に却下した内容が残った run」（grader の implements_rejected / proposes_rejected）が M1a で決めた改善幅以上に減り、かつどのモデルでも隠しテストの完了・不要な停止・should_not_block と should_stay_quiet での誤配が悪くならないこと。「途中で違反を書いた run」は書き込みの本文から盲検の grader が判定し、報告だけにする。「通知を見て直した」とは主張しない

### M0'（#219、モデルを回さない）

- (i) 原因の内訳: via=status だけで anchor 付きの 316 ターンから固定の seed で 30 ターンを選び、会話記録から原因を「エージェントの shell の編集 / git の操作 / formatter・生成器 / サブエージェント・並行のセッション / 不明」で分ける。報告だけ
- (ii) 取りこぼし: 母集団は（session, turn, path, 記録）の組（via=status だけの行で、path に active な decision / constraint の applies_to がある行と、その記録の組）。母集団の全組を固定の seed で無作為な順に並べ、先頭から最大 150 組を見る（ターンごとの上限は置かない）。引いた組ごとに会話記録から「その path をエージェントが shell で編集したと確かめられるか」を判定し、確かめられた組について、最後の再開から次の持ち主のプロンプトまでに、その session と agent に記録が emitted になったかを見る。次の持ち主のプロンプトが無いターンは別に数える。確かめられた組が 30 になったら止める
- 基準: 確かめられた組での取りこぼしの割合の 95% Wilson 区間（有限の母集団からの非復元抽出に対する近似と明記）。下限 20% 以上なら止めて、次の段の計画を持ち主に出す（新しい Go が要る）。上限 20% 未満なら不採用。それ以外か、150 組で確かめられた組が 30 に届かなければ「決まらない」として止めて持ち主に戻す

## 採った案と棄却した案

- 採用: post_write で両ホストを扱う。棄却: ExitPlanMode の PreToolUse（承認の後に届く、持ち主が使っていない、Codex に無い）
- 採用: onPrompt の字句照合のまま。棄却: option の文からコードの字面を抜き出して照合する（誤配の量が測れておらず、#260 の範囲）
- 採用: 除外は emitted の delivery_unit だけ。棄却: 書いたファイルに anchor がある記録を一律に除く（pre_edit は上限で省き、ログの失敗でも配信する）
- 採用: 実験中は `pre_edit`＋`reason='post_write'` で記録し、採用時に revision 13。棄却: 最初から revision 13（新旧のバンドルが同じ fixture を使えず比べられない）
- 採用: 条件は `inject` のまま、バンドルの違いで比べる。棄却: 新しい条件 `inject_pw`（report の比較キーが condition を含み、judge・collect・canary も直すことになる）
- 採用: 採用の基準は最終の patch の違反だけ。棄却: post_write のヒットを「最初に違反を書いた」の代わりにする（無害な言及でも当たり、baseline では測れない）
- 採用: Bash は post_write の対象外。棄却: shellPatch() で拾った Bash の patch も見る（表示だけの heredoc や失敗したコマンドも拾う）
- 採用: #219 は組の母集団から抽出して Wilson 区間。棄却: ターンを抽出して中の組を独立に数える（1 ターンに固まると区間が狭くなりすぎる）。棄却: 1 ターンから 2 組までの上限（組の多いターンが少なく代表され、推定が偏る）。棄却: via=status をそのまま shell の編集と数える（原因を持たない）。棄却: bashEditDiff（上記）
- 採用: M1 の計画の文書は追跡対象の `docs/`。棄却: ignored の計画の文書（Codex の runner が集めず、違反が消えて見える）

## 手順

- S1: M0 と M0' の再生・抽出のスクリプト（`server/evals/` の下）。M0 のラベルは持ち主が付ける。M0' のラベル（shell の編集か、emitted か）は事実の判定なので Claude が会話記録と DB から付け、Codex が同じ組を独立に付けて食い違いを決着させる。M0' の判定と記録
- S2: M1a のタスクと fixture、runner の PostToolUse 配信対応・書き込みの本文の記録・配信の結果の reason、流す前の確認、main のバンドルでの baseline と A/A、k と改善幅の決定（M0 で打ち切ったので行わない。変更履歴を参照）
- S3: M0 と M1a を通ったときだけ post_write の実装（照合の切り出し、deliver.ts、両ホストの hook、テスト、scale の計測に post_write を足す）
- S4: #213 の採否の記録（M0 の結果で不採用。M1 の本測定は行わない。変更履歴を参照）
- S5: 採用したとき: revision 13 と移行、実験版と最終版で配信の本文・除外・予算が同じことの確認、両ホストの実機確認、`release:plan`、バージョンの同期、release。採用しないとき: 実装と hook を最終の差分から外す（評価の仕組みと結果は残す）
- S6: #219 の記録（不採用）、または止めて持ち主に戻す

## 完了条件

- A1: `gh issue view 213 --comments` → M0（と行ったなら M1a・M1）の数字（モデル別の件数、k、バンドルの hash）と採否のコメントがある
- A2: `gh issue view 219 --comments` → M0' の数字（原因の内訳、取りこぼしの区間、引いた組の数）と、不採用か「止めて持ち主に戻した」かのコメントがある
- A3: `bun run verify` → 0 で終わる
- A4: `gh pr checks <PR>` → Windows を含む全ジョブが pass
- A5: 採用したとき: 更新後の Claude Code と Codex で、記録の symbol を名指す文書を書くと、会話記録の次のリクエストに post_write の文脈が入り、delivery に `event='post_write'` の行が残る。採用しないとき: `git diff main -- server/src/deliver.ts plugin/hooks db/schema.sql` → 空
- A6: `node server/evals/scale/run.ts` → 採用したとき、post_write を足した表で、記録 1 万件での post_write の 1 回が 1 秒以内
- A7: `bun run release:plan -- --base <前の release のコミット>` → 採用があれば `plugin` で npm と 3 つの plugin manifest のバージョンが同じ、無ければ `none`
- A8: release したとき: `bun run release:status` → release ledger is consistent

## リスク

- 計画の文書は記録の path と symbol を多く名指すので、配信がうるさくなる → M0 の基準と会話あたりの予算で止める。M1 の誤配の基準で不採用にする
- M1a で違反がほぼ出ず測れない（E3 と同じ）→ 基準どおり打ち切って記録する。回数を後から足さない
- 書き込みのたびに同期の hook が 1 プロセスを起こして遅くなる → A6 で測る。1 秒を超えたら不採用の理由に含める
- 持ち主のラベル付けの時間（M0 の最大 40 組）→ 一度にまとめて出す
- 会話記録の形式がホストの更新で変わり、再生が読み落とす → 読めなかった件数を数えて報告し、0 件扱いにしない

## 未解決

なし

## 変更履歴
- 2026-10-10 / M0 のラベルは持ち主ではなく Claude と Codex が独立に付け、食い違いを決着させる形にした / 持ち主が「あなたでできないことなの？」と、自分で付けない形を求めた / 持ち主の指示による（Go は不要）
- 2026-10-10 / M0 で打ち切り、post_write を作らずに #213 を不採用とする。M1a・M1・post_write の実装（T06〜T14）は行わない / 標本 40 組（文書 20・コード 20）で R 0・H 10・N 30。基準「N が 1/3 以下、かつ R が 1 組以上」の両方に届かない。当たりの多くは tasks の変更欄のパスの一覧、別のファイルの同名の関数、却下案の短い語（delete）とコードの字面の一致だった / 計画どおりの打ち切りで Go は不要。T01 の切り出しとバージョンの扱いは持ち主に聞く
