---
kind: plan
status: approved
codex_session: 01a121e2-6e6f-79f1-af49-f278a4b25cab
codex_rounds: 4
approved_at: 2026-10-10
---

# shell の呼び出しで内容が変わったファイルの記録を、呼び出しの直後に届ける（#219 の次の段、既定オフで試用）

## 要点

- Bash / PowerShell の呼び出しの前に、配れる decision / constraint の applies_to のファイル全部の状態（lstat の署名と内容の hash）を控え、呼び出しの後に比べる。内容が変わった・作られた・消されたファイルについて、その会話で最後の compact / clear の後にまだ届いていない記録を、編集と同じ上限（1 回 5 件・1,500 字）で届ける。読みの予算は使わない
- 両ホストで作る。Claude Code は PreToolUse に加えて同期の PostToolUse と PostToolUseFailure、Codex は PreToolUse と PostToolUse
- 正しさは決定的な harness で確かめる（固定 40 件の正例が全部届く、負例・メタデータだけの変化は 0 件）。両ホストの実機の確認も、既定オフのリリースの前に通す
- 実際の使い方でのノイズは使ってみないと決められないので、epic の例外に従い既定オフの設定で出す。持ち主が 7 日試し、届いた配信の標本を Claude と Codex がラベル付けして、前もって固定した基準で既定をオンにするか外すかを決める
- この PR は既定オフのリリースで終わる。既定オンと revision の追加（post_shell）は、試用の結果を受けた後のリリース
- 変えないもの: 今の Bash の名指しの読みの配信（pre_read）、Edit 系の pre_edit、プロンプト・セッション開始の配信、capture、schema（この PR では revision を上げない）

## 持ち主の決定

- E4 の続きとして、このブランチ（feat/e4-post-write）と同じ PR で #219 の次の段を進める（2026-10-10、選択肢 A）
- 「任せる。妥協は無し。何かあれば根本的にやること」（2026-10-10）
- epic #200 の方針: 実験は仮説・測り方・基準・届かなかったときの扱いを持ち、PR ブランチで測る。測るために npm へ出さない。持ち主の使用でしか判断できない変更は、既定オフの設定で出してよい
- 利用者に API キーや追加の課金を求めない

## 目的

- 設定がオンのとき、エージェントが shell で記録の付いたファイルの内容を変えると、まだ届いていないその記録が、同じターンの次のモデルリクエストの前に会話へ入る（両ホスト）
- 設定がオフのときの挙動は今と変わらない
- 試用の結果で、既定をオンにするか外すかが、前もって決めた基準で決まる

## 対象外

- 名指しによる絞り込み（今の namedInCommand だけに頼る形）。生成スクリプトや組み立てたパスでの書き込みを拾えない
- 書き込みの形の正規表現による見分け（任意の shell・Python・PowerShell を網羅できない）
- git status の差分による検出（変更済みのファイルの再編集を見落とし、呼び出しごとに git を走らせる）
- 次のプロンプトでの配信（同じターンのうちに直す機会を逃す）
- bashEditDiff（プラグインから有効にできず、Codex に無い）
- 署名を変えずに内容が変わる場合の検出（下の「限界」）
- Claude Code の run_in_background の呼び出しが Post の後に書く変更
- 既定オン・revision の追加・post_shell の値（試用の後の別のリリース）

## 前提

- M0'（`server/evals/post-write/m0-shell.json`、2026-10-10）: shell で記録付きのファイルを書いたとき、その時点で配れた記録が次のプロンプトまでに届かなかったのは、測れた 30 組中 17 組。Claude Code だけの値（Codex には shell の編集の履歴がこのマシンに無い）
- 今の Bash の配信は、コマンドが名指すパスを読みとして扱う（`server/src/deliver.ts` deliver() → namedInCommand → beforeRead）。読みの予算は会話あたり 8 件・3,000 字
- Claude Code: 同期の PostToolUse と PostToolUseFailure の additionalContext は次のモデルリクエストに入る。async の hook は次のターン（https://code.claude.com/docs/en/hooks 、2026-10-09）。capture の PostToolUse は async なので別の entry が要る。並列の呼び出しでは PostToolUse も並行に走る
- Codex 0.162.0: PostToolUse は Bash で使え、tool_use_id と tool_input.command が入り、非 0 で終わっても走る。長いコマンドは write_stdin の後の poll で元の呼び出しの PostToolUse が届く（https://learn.chatgpt.com/docs/hooks 、仕様で確認。実機は完了条件で確かめる）
- hook の timeout: Claude Code の deliver.js は 5 秒（`plugin/hooks/hooks.json`）、Codex の PreToolUse は 5 秒（`plugin/hooks/codex.json`）
- lstat の時刻は OS とファイルシステムで精度が違い、Windows の ChangeTime はアプリが更新を抑えられる。chmod や touch でも時刻が変わる（Codex が一次情報で確認）
- 読む前の配信は、ロックを取ってから計画しログを書く（lockedPlan、記録 u135）。ロックを取れないと、ログなしで返す
- 配信ログは届いたことの証明ではない。届いたかは会話記録で確かめる（M0・M0' の測り直しで確立した）

## 方針

### 変化の見分け方

- 対象のパス: その時点で配れる decision / constraint の、退役していない applies_to の anchor のパスを重複なく（今は無いパスも含める。作成を見るため）。checkout の根の中に限り、realpath が根の外へ出るもの（symlink や junction）は除く
- 状態: パスごとに ok（通常のファイル）/ missing（ENOENT・ENOTDIR）/ unreadable（それ以外のエラーと、通常のファイルでないもの）。missing → ok は作成、ok → missing は削除で、どちらも変化。前後のどちらかが unreadable なら、そのパスはその呼び出しでは unknown
- 署名: lstat の (exists, dev, ino, size, mtimeNs, ctimeNs)
- 内容の hash のキャッシュ: checkout の正規の根ごとに Sphica の home に置き、パスごとに (署名, sha256) を持つ。署名が同じならキャッシュの hash を使い、違えば読み直す。読み取りは lstat → read → lstat で、前後の署名が違えば 3 回までやり直し、だめならその呼び出しではそのパスを unknown にする。署名と hash が揃ったものだけを atomic に書き込む。壊れた・無いキャッシュは作り直す
- Pre（PreToolUse）: 対象のパス全部の (署名, hash) を、呼び出しの控えとして書く。控えの名前は (host, 根, session, agent, tool_use_id) の sha256、中身は読むときに検査する
- Post（Claude Code の PostToolUse と PostToolUseFailure、Codex の PostToolUse）: 控えを読み、署名が変わったパスだけ hash を取り直す。hash が違う・作られた・消されたパスを「変わった」とする。chmod、touch、同じ内容での書き戻し、呼び出しの中で書いて戻したものは変わっていない。終了コードでは判断しない
- 期限: Pre と Post はそれぞれ 3.5 秒で打ち切り、残ったパスは unknown として控えを確定する（hook の 5 秒の内）
- 控えの寿命: Post まで、または 7 日。期限切れで消した控えと、控えの無い Post は計測のログに残し、「変わっていない」とは扱わない
- 限界（計画として認め、harness で再現できる OS では再現して報告する）: 署名が丸ごと変わらない内容の変化は見えない。その後にメタデータだけの呼び出しがあると、古い hash との比較で配信しうる。Claude Code の background の呼び出しが Post の後に書くものは見えない

### 届け方

- 変わったパスについて、その会話（session と agent）で最後の compact / clear の後に emitted になっていない decision / constraint を、編集と同じ上限（1 回 5 件・1,500 字）でまとめて届ける。読みの予算は使わない。並行の呼び出しの重複は lockedPlan で防ぐ
- 文面（英語の固定の lead）: `Active decisions applying to <paths>, files whose content changed between before and after this call (current code relevance unverified).`＋固定の CONFIRM＋NOTE。各行は recordLines の形（理由と却下した案）。試用の標本はこの lead で見分ける
- ログ: delivery は event pre_edit、reason shell_write（この PR では schema を変えない）。呼び出しごとの計測（host、session、agent、tool_use_id、時刻、対象のパス数、変わった・unknown・期限切れの数、届けた key、ログを書けたか）を Sphica の home の試用のログ（JSON Lines、1 呼び出し 1 行）に、配信の有無によらず書く
- 設定: Claude Code は plugin の userConfig に shell_write_delivery（真偽、既定 false）、両ホストで環境変数 SPHICA_SHELL_WRITE_DELIVERY（on / off）。どちらかがオンで有効（userConfig が off でも env が on ならオン、env が off なら止める）。オフのとき Pre は控えを取らず、Post は何もしない
- hook の登録: Claude Code は PostToolUse と PostToolUseFailure に Bash|PowerShell の同期の entry、Codex は PostToolUse に ^Bash$ の entry（Windows は既存と同じ -EncodedCommand の形）。PreToolUse は今の entry のまま、deliver の中で控えを取る

### 正しさの harness（既定オフのリリースの前に通す）

- 一時的な checkout と一時 DB で、bundle した deliver.js を新しいプロセスで Pre と Post に流し、その間に本物の shell のコマンドを走らせる。Claude Code の入力の形（Pre / Post / PostFailure）と Codex の入力の形（Pre / Post）の両方
- 正例（固定の 40 件、それぞれ違う形）: Python の書き戻し、sed -i、perl -i、リダイレクト、tee、cat の heredoc、自分の一時ファイルからの cp / mv、名指さない生成スクリプト、cd の後の相対パス、書いてから非 0 で終わるコマンド、作成、削除、内容の変わる atomic replace、Windows の CI で PowerShell の Set-Content と Out-File ほか
- 正例には、同じサイズの別の内容に書き換えて mtime を元に戻すコマンドも入れる（ctime が変わるので届くことを期待する）
- 負例: 読み（cat、grep、sed -n）、記録の無いファイルだけを変えるコマンド、何もしないコマンド、拒否された呼び出し、chmod、touch / utimes、同じ内容での書き戻し、呼び出しの中で書いて戻す
- 別に数える行（基準の正負に入れず、件数を報告する）: git の checkout・stash・restore と formatter による内容の変化、限界の行（署名を変えない変化とその後のメタデータだけの呼び出し、background）
- 基準: 正例 40 件中 40 件が Post で届く（率は主張しない）、負例とメタデータだけの行は追加の配信 0。並行（読み＋書き、同じファイルへの書き＋書き、別のファイル）、期限での打ち切り（空のキャッシュで大量のファイル、大量の変化）、控えの期限切れと欠け、ロックの競合とログの失敗、Windows のパス（空白、日本語、大文字小文字、ドライブ、UNC、逆の区切り、cwd、外へ出る junction / symlink）も行として持つ
- 新旧比較: 同じ入力で main のバンドルと作業ブランチのバンドルを流し、追加の記録数・文字数・会話あたりの重複を表にする
- 時間: scale の計測に Pre と Post を足し、実ファイルを持つ fixture で、キャッシュが温まっていて記録 1 万件のとき 1 回 1 秒以内。空のキャッシュと大量の変化の時間も、hash したバイト数と一緒に報告し、hook の期限内に終わる（打ち切りで unknown になる）ことを確かめる

### 実機（既定オフのリリースの前と、試用の初日）

- 次の確認が両ホストで通るまで、既定オフのリリース（S5）に進まない
- 両ホストで、Pre では記録が届かない形（パスを名指さないスクリプトで記録付きのファイルを書く）で: 普通の書き込み、書いてから非 0 で終わる（Claude Code の PostToolUseFailure）、並列の 2 つの shell の呼び出し、Codex の poll で届く長いコマンド。文脈が次のモデルリクエストに入ったことを会話記録（Claude Code）とセッションのログ（Codex）で確かめる。harness が確かめるのは hook の出力までだと明記する

### 試用と採否（既定オフのリリースの後）

- 持ち主が設定をオンにして 7 日使う（延長しない）
- 標本の母集団は、会話記録の Post の差し込み（固定の lead で見分ける）から作り、試用のログと突き合わせる。ログに無い差し込みも母集団に入れ、ログの欠けで外さない
- 1 件 = 1 回の Post の差し込み。seed で固定した 40 件（両ホストにデータがあればホスト別に層別）を、Claude と Codex が会話記録を見て独立にラベル付けする: useful（その呼び出しがエージェントの組み立てた内容を書き、含まれる記録が全部そのファイルの変更に関わる）/ noise（それ以外: git、formatter、メタデータ、別のプロセスの変更、関わりの無い記録を含む）。混在と両者の不一致は unknown とし、基準では noise に数える
- 基準（今固定）: noise（unknown を含む）が標本の 1/3 以下、かつ設定がオンだった会話（配信 0 の会話も含む）で、会話あたりの Post の差し込みの 90 パーセンタイルが 10 以下。ホスト別の件数と結果を出し、データの無いホストは確かめていないと書く
- 届けば、既定オンと revision（post_shell）を別のリリースで出す。届かなければ、または 7 日で標本が 40 件に届かなければ（データ不足として採用の条件に届かない）、設定とコードを外し、結果を #219 に残す

## 採った案と棄却した案

- 採用: 配れる記録の anchor のファイル全部の前後の内容を比べる。棄却: 名指したファイルだけを比べる（名指さない書き込みを拾えない）
- 採用: 署名のキャッシュ付きの内容の hash。棄却: stat だけ（chmod・touch でも変化になり、書き込みの検出を保証しない）。棄却: Pre のたびに全部の内容を読む（anchor のファイルの総量に比例し、shell の呼び出しごとに重い）
- 採用: 書き込みの形の正規表現も git status の差分も使わない。棄却: (a) 正規表現（網羅できない）、(b) git status の差分（再編集を見落とし、git を毎回走らせる）、(d) 次のプロンプトでの配信（遅い）
- 採用: 実験として扱い、既定オフで試用して採否を決める。棄却: 修正として扱う（今の契約に無い挙動の追加で、M0' は次の段へ進む理由であって採用の証明ではない）
- 採用: harness の固定 40 件は「40 件中 40 件」と報告する。棄却: 固定の一覧から実利用の漏れの率を出す（確率標本ではない）
- 採用: ノイズは持ち主の試用で決める。棄却: 過去の git status から追加の配信の上限を出す（途中で戻した変更・ignored のファイル・編集ツールとの混在が見えず、上限にならない）
- 採用: この PR では pre_edit＋reason shell_write で記録し、試用のログを別のファイルに書く。棄却: この PR で revision を上げる（既定オフの間は要らず、新旧の比較が難しくなる）

## 手順

- S1: 変化の見分け方（対象のパス、署名、hash のキャッシュ、控え、期限、寿命）と、その決定的なテスト
- S2: 届け方（Post の配信、lockedPlan、文面、ログ、試用のログ、設定）と、両ホストの hook の登録、テスト
- S3: 正しさの harness と新旧比較、scale の計測
- S4: 実機での確認（両ホスト）
- S5: 既定オフのリリース（release:plan、バージョン、plugin-release の手順、Windows CI）
- S6: 試用（7 日）と、標本のラベル付け・採否、#219 への記録（既定オンは別のリリース）

## 完了条件

- A1: `bun run verify` → 0 で終わる
- A2: `node server/evals/post-write/shell-write-harness.ts` → 両ホストの入力の形で、正例 40 件中 40 件が届き、負例とメタデータだけの行は追加の配信 0、別に数える行と限界の行の件数が出る
- A3: `node server/evals/scale/run.ts` → キャッシュが温まっていて記録 1 万件のとき、Pre と Post がそれぞれ 1 秒以内。空のキャッシュと大量の変化が期限内に終わる
- A4: `gh pr checks <PR>` → Windows を含む全ジョブが pass
- A5: `rg -n "whose content changed between before and after this call" ~/.claude/projects/-Users-shunichi-Projects-sphica/<実機確認のセッション>.jsonl` → Post の差し込みが次のアシスタントの行より前にある。Codex のセッションのログでも同じ文が次の応答より前にある（該当箇所を tasks の結果欄に残す）
- A6: `bun run release:plan -- --base <前の release のコミット>` → plugin で、npm と 3 つの plugin manifest のバージョンが同じ
- A7: `bun run release:status` → release ledger is consistent
- A8: `gh issue view 219 --comments` → この PR の外、試用の後に、試用の結果（標本のラベル、noise の割合、90 パーセンタイル、ホスト別）と採否のコメントがある

## リスク

- 対象のファイルが多く、空のキャッシュで hook が遅い → 期限で打ち切って unknown にし、時間を報告する。温まった状態で 1 秒を超えたら止めて計画を見直す
- 並行の呼び出しで、別の呼び出しの変化をこの呼び出しの変化として届ける → 文面で原因を断定しない。試用の noise に数える
- 試用で持ち主の会話の量が少なく、標本が 40 件に届かない → データ不足として採用の条件に届かないと扱い、設定とコードを外して結果を残す（延長しない）
- Codex の実機で poll 経由の Post が確かめられない → 既定オフのリリースに進まず、止めて持ち主に戻す

## 未解決

なし

## 変更履歴
- 2026-10-10 / 書き上げた plan を Codex が確かめ、存在しないパスの状態（C7）、Codex の実機確認をリリース前に置く（C22）、試用を延長しない（C21）、mtime を戻す書き換えの行（C20）、この PR と試用の完了条件の区別（C29）を直した / 合意と文面の食い違い / Go の前の直し
