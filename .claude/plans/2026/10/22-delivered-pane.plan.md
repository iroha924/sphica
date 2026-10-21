---
kind: plan
status: approved
codex_session: 01a15f52-ca31-7cd2-af46-70555cfe316e
codex_rounds: 3
approved_at: 2026-10-22
---

# Sphica が渡した記録を並べる読み取り専用の Claude Code mod を、任意のプラグイン `sphica-pane` として出す（#370）

## 要点

- リポジトリ直下に `pane/` を足し、Claude Code の mod（hooks module）だけを持つプラグイン `sphica-pane` を作る。同じマーケットプレイスから `git-subdir`（ref はリリースのタグ）で配り、入れた人にだけ効く
- mod は 5 つの classic hook の結果から Sphica の文面と #218 の停止の理由を拾い、`/sphica-pane` で開くペインに並べる。hook の結果は変えずにそのまま返す。何も書かず、ファイル・ネットワーク・プロセス・MCP を呼ばない
- CI で、固定した Claude Code CLI の `plugin validate --strict` と `plugin test` を、配る実物（`git archive` で取り出した `pane/`）に対して Linux と Windows で流す。validate の `--json` を許可リストと突き合わせる
- リリースの判定・バージョンをそろえる検査・タグのゲート・到着の確認に `pane/` と marketplace の ref を足す。リリースの種別は plugin
- 変えないもの: DB、MCP ツール、本体の `plugin/hooks/hooks.json` とコマンド hook、`deliver.ts` の挙動と文面、#218 の停止、Codex の経路
- 完了は、出荷後 7 日の持ち主の実利用で、役に立った具体例と使った版を #370 に残すこと

## 持ち主の決定

- 「モダンな技術をどんどん試したい。面白そうや実験的に試すのも全然あり」（2026-10-20）。これを受けて #370 が作られた。2026-10-13 の調査の「今は mod を入れない」（記録 mods-investigation-result）は、実験として試す前提で上書きされた
- #370 の Keep: Codex と mod の無い Claude Code のために hook の経路を残し、README に違いを書く。mod は今の hook が読むものだけを読み、CLAUDE.md の接続ロールの外に何も書かない。listen するサーバーを作らない。Windows でも動く
- #370 の完了: mod を 1 つ出荷し、計測か持ち主の確認で役に立つと示す。それができなければ、hook のままにする理由を #370 に残す
- 持ち主はスパイクのペインに PreToolUse の配信文が出ることを確かめた（2026-10-22）

## 目的

- `sphica-pane` を入れた Claude Code で `/sphica-pane` を実行すると、このセッションで Sphica の hook が渡した文面（SessionStart・SubagentStart・UserPromptSubmit・UserPromptExpansion・PreToolUse）と、#218 の停止の理由が、時刻とイベント名付きで新しい順に並ぶ
- 入れていない人、Codex の人、mod の無い Claude Code の人には、何も変わらない
- `pane/` だけを変えた PR も、リリースの種別が plugin になり、バージョンをそろえる検査とタグのゲートに掛かる

## 対象外

- #218 の停止を mod に移すこと。2026-10-29 ごろまで 14 日の計測中で、挙動を変えると計測が崩れる
- 作業項目と未 trace の一覧のペイン。中身が SessionStart の文面とほぼ同じで、足せるものが少ない
- 利用の計測。mod は DB に書かない約束なので数えられない。持ち主の確認で判断する
- 文字列が本当に Sphica から来たかの証明。下流の hook の context は結合されて届き、出元の印が無い。拾う条件は表示のための推定にとどめる
- 本体の `plugin/hooks/hooks.json` に `modules` を足すこと（採った案と棄却した案）
- marketplace のエントリを Codex から隠すこと。エントリにホストを指定する欄は無い（https://code.claude.com/docs/en/plugins/host-marketplace 、Codex が 2026-10-22 に確認）

## 前提

- スパイク（Claude Code 2.1.306）で確かめたこと: mod の `on('classic.PreToolUse', …)` で `await next(e)` すると、返り値の `additionalContext` に Sphica のコマンド hook（`plugin/dist/deliver.js`）が出した文面が入る。持ち主がペインで確認した。ほかの 4 イベントと deny は未検証（S3 と A5 で確かめる）
- classic hook の並びは「[managed settings hooks, ...hooks modules, the other settings hooks as core]」。`PreToolUseResult` は allow / ask / deny と `additionalContext` を持つ（2.1.306 がこのセッション用に書き出した型定義 `claude-code.d.ts` の 1280 行、8186 行付近。このファイルは Claude Code が実行ごとに書き出すもので、リポジトリには無い）
- `update($, atom, fn)` は、値を読んで `fn` を当て、`ifVersion` で書き、外れたらやり直す。なので、同時に来た配信を落とさない（同じ型定義の UpdateFunction）。`$.state` はセッションの値で、mod の再読み込みでは残る
- mod の event 名は文字列リテラルでなければならず、`$` を渡す関数はファイルの先頭で宣言したものに限られる。どちらも validate が落とす（スパイクで実測）
- hooks.json には `modules` と従来の `hooks` を並べて書ける。mods が入ったのは Claude Code 2.1.287 から（https://code.claude.com/docs/en/plugins/mods/overview.md 、CHANGELOG の 2.1.287、2026-10-22 取得）。最低バージョンを宣言する欄は無く、公式は README に書けと言う
- 古い Claude Code が `modules` を拒むか無視するかの一次情報は無い。2.1.250 の `claude plugin validate` は今の mod の書き方を落とした（記録 mods-old-claude-code-validate）
- 2.1.288 で「`git-subdir` plugin installs failing, or caching an incomplete plugin, on older git (before 2.39)」が直っている（CHANGELOG）
- マーケットプレイスの npm ソースが指せるのは `package` / `version` / `registry` だけで、パッケージ内のサブディレクトリは指せない。`git-subdir` は `url` / `path` / `ref` / `sha` を取る（https://code.claude.com/docs/en/plugins/marketplace-reference.md 、2026-10-22 取得）。`git-subdir` は 2.1.69 で入った（CHANGELOG）。README の下限 2.1.139 より前なので、古い Claude Code が知らないソースにはならない
- Codex 0.163.0: `sphica`（npm）と `sphica-pane`（git-subdir）の 2 つを持つ marketplace.json を、使い捨ての `CODEX_HOME` で `codex plugin marketplace add` すると成功した。`codex plugin list` は両方を not installed として出した（実測 2026-10-22）。Codex に `sphica-pane` を入れたときの挙動は未検証
- Codex には mod に当たるものが無い。hook のハンドラーは `command` と `mcp_tool` だけ（https://learn.chatgpt.com/docs/hooks.md 、0.163.0 のリリースノート、2026-10-22 取得）
- 削除したエントリのプラグインは、`forceRemoveDeletedPlugins` が無ければ利用者の手元に残る（https://code.claude.com/docs/en/plugins/host-marketplace 、Codex が 2026-10-22 に確認）
- Sphica の配信文には決まった言い回しが入る: `server/src/deliver.ts:68` の `NOTE`、`:81` の `SEARCH_FIRST`、`Sphica:` と `Sphica unavailable:` で始まる文。#218 の停止は `permissionDecision: "deny"` と `permissionDecisionReason`（`deliver.ts:1511`）。編集の前の配信は 1 件で 1500 文字を超えうる（`deliver.ts:50`）
- `scripts/lib/release-scope.mjs:18` の `PACKAGE_PREFIXES` に `pane/` は無く、`releaseKind(["pane/hooks/register.tsx"])` は none になる（Codex が 2026-10-22 に実行）
- タグは plugin-release の手順 4 で打って push し、`release.yml` はタグの push で始まる（`.github/workflows/release.yml:12`）。`scripts/release-gate.mjs` はリモートのタグの commit を読む
- CI（`.github/workflows/check.yml`）には claude CLI が入っていない。`server/bunfig.toml` は `minimumReleaseAge = 604800`。npm の公開時刻: 2.1.301 が 2026-10-15T14:34:23Z、2.1.302 が 2026-10-16T16:48:28Z、2.1.306 が 2026-10-21T02:28:47Z（`npm view @anthropic-ai/claude-code time`、2026-10-22）
- `claude plugin validate` には `--strict` と `--json` がある。`claude plugin test [dir]` は `*.test.ts(x)` を `claude-code/testing` で流し、失敗すると 1 で終わる（2.1.306 の `--help`）。テストはモデル・認証・ネットワーク無しで動く（https://code.claude.com/docs/en/plugins/mods/test 、Codex が 2026-10-22 に確認）
- 未検証: 固定する版の CLI が `--ignore-scripts` のインストールで動くか、Windows の CI で validate と test が動くか（S1 で実測する）

## 方針

1. CLI の固定と入れ方（S1）
   - インストールする時点で、npm の公開時刻から 604800 秒以上たった最新の `@anthropic-ai/claude-code` を選び、正確な版に固定する。版は 1 か所（`scripts/lib/claude-cli.mjs` の定数）に書き、CI とローカルの検査が同じ値を読む
   - 入れ方は、次の 3 つを Linux と Windows で実測して、動くものを 1 つ選ぶ: server の devDependency（`bun install --ignore-scripts` で動くか）、mise の npm バックエンド、CI のジョブだけで `npm i -g @anthropic-ai/claude-code@<版>`。選んだものと棄却した理由を PR 本文に書く
   - Windows で validate と test が通らなければ、そこで止めて持ち主に戻す（出荷しない）
2. `pane/` の中身（S2・S3）
   - `pane/.claude-plugin/plugin.json`: name `sphica-pane`、version は npm と同じ、description、author、license `MIT`、`types: "./types/index.d.ts"`
   - `pane/hooks/hooks.json`: `{ "modules": ["./register.tsx"] }`
   - `pane/types/index.d.ts`: `PluginState` の `'sphica-pane': { delivered: Delivered[] }`。`Delivered = { at: string; event: string; kind: "context" | "stop"; text: string }`
   - `pane/hooks/sift.ts`: claude-code に依存しない純粋な関数。`sift(result)` は classic の結果から、`additionalContext` のうち `Sphica` で始まるか `NOTE` の言い回しを含むものを `context` として返し、deny の理由が同じ条件に当たるものを `stop` として返す。`layout(list, budget)` は新しい順に、全体を 8,000 文字（見出しと省略の表示を含む）、1 件を 1,500 文字に収め、切ったかどうかと出していない件数を返す
   - `pane/hooks/register.tsx`: 5 つの classic イベントそれぞれに、文字列リテラルの `on(...)` を書く。各 hook は `const r = await next(e)` の後、先頭で宣言した `keep($, event, r)` を try で呼んで失敗を握りつぶし、`r` をそのまま返す。`keep` は `sift` の結果を `update` で state の末尾に積む（最新 100 件）。`session.start` で `/sphica-pane` を登録し、`command.run` で `$.ui.open({ id: "sphica-delivered", title: "Sphica" })` を呼ぶ。頼まれずには開かない。`ui.render` の `Pane` は `layout` の結果を描く。使う `$` は `$.command.register`、`$.ui.open`、`$.ui.resolve`、`$.state.get`、`$.state.set` だけ
   - `pane/README.md`（40 ワード以上）と `pane/LICENSE`（ルートと同じ MIT）。英語で書く
3. テスト（S2・S3）
   - `server/test/pane-sift.test.ts`（node --test）: 既存の deliver のテストと同じ方法で、実際の `deliver.ts` の出力を作る（SessionStart、読む前、編集の前、プロンプト、SubagentStart、unavailable、#218 の deny）。それを `sift` に通して、全部拾えることを確かめる。負例として、他のプラグインの文面、空、`additionalContext` の無い結果を拾わないことを確かめる。`Sphica` で始まる無関係な文を拾わないことは確かめない（推定だから）。`layout` の境界も確かめる（長文 100 件、日本語、ちょうど上限）
   - `pane/hooks/register.test.tsx`（claude plugin test）: 5 つのイベントを `claude-code/testing` の経路で起こし、下流の結果を stub する（allow / ask / deny、updatedInput、複数の context、空、`keep` の失敗）。確かめるのは次の 4 点と、2 つの配信を同時に起こしても両方残ること
     - 返り値が下流の結果と同じ
     - 下流が 1 回だけ呼ばれる
     - 入力が変わらない
     - state の中身
4. 検査（S4）
   - `scripts/check-pane.mjs`: 次の 4 つを確かめる
     - `git archive HEAD pane` をリポジトリの外の一時ディレクトリに展開し、そこで `claude plugin validate --strict --json` と `claude plugin test` を流す
     - JSON の hook の一覧が、5 つの classic イベント、`session.start`、`command.run{command=sphica-pane}`、`ui.render{component=Pane, requestId=sphica-delivered}` と一致すること
     - calls が上の 5 つと一致すること
     - state の読み書き先が `sphica-pane.delivered` だけであること
   - 同じスクリプトが marketplace の `sphica-pane` のエントリも確かめる: `source.source == "git-subdir"`、`url` がこのリポジトリ、`path == "pane"`、`ref == "v<plugin/package.json の version>"`、`sha` は持たない
   - `bun run pane:check` として package.json に足し、`check` と `ci:static` に入れる。check.yml の Windows のジョブでも流す
   - `pane/hooks/sift.ts` と `pane/types/index.d.ts` は、oxlint、oxfmt、tsc（server の tsconfig の include に足す）、english、headers、comments の対象に入れる。`register.tsx` と `register.test.tsx` は lint・format・english・headers・comments の対象。tsc の対象にはしない（エンジンが書く型が要るため。validate と test が代わりになる）
5. リリースの仕組み（S5）
   - `scripts/lib/release-scope.mjs` の `PACKAGE_PREFIXES` に `pane/` を足す
   - `scripts/check-mcp-version.mjs`、`release-plan.mjs`、`release-gate.mjs`、`release-status.mjs` が、`pane/.claude-plugin/plugin.json` の version と marketplace の `sphica-pane` の `ref` を、npm の version と同じものとして扱う。release-gate は、この 2 つ、リモートのタグの commit、検査した head が一致することを見る。release-status は、Claude のキャッシュに `sphica-pane` のその版があるかを見る（入れていなければ「未導入」と出し、失敗にはしない）
   - CLAUDE.md・AGENTS.md の version-sync と `.claude/rules/verification.md` の「3 plugin manifests」を、pane のマニフェストと marketplace の ref を含む書き方に直す。`scripts/check-pairs.mjs` か既存の version の検査で、列挙を対として確かめる
   - `.claude/skills/plugin-release/SKILL.md`（`.agents/skills/plugin-release/SKILL.md` も同じ）に、出荷後の確認を足す。使い捨ての HOME で `claude plugin marketplace add iroha924/sphica` と `claude plugin install sphica-pane@sphica` を流し、`--plugin-dir` を使わずに読み込みと `/sphica-pane` の表示を確かめる。2 回目以降のリリースでは、前の版からの更新も確かめる
6. 配布と README（S6）
   - `.claude-plugin/marketplace.json` に `sphica-pane` のエントリを足す（`source: { source: "git-subdir", url: "https://github.com/iroha924/sphica.git", path: "pane", ref: "v<version>" }`）。npm と 3 つのマニフェストと pane の version を、次のパッチ版にそろえて上げる
   - README に書くこと:
     - Install に「任意: Sphica が渡したものを見るペイン（Claude Code のみ。CI で確かめた <固定した版> 以降）」と入れ方
     - mod は Claude Code の権限で動くこと。このペインは何も書かず、外へ送らないこと
     - 拾う条件は表示のための推定であること
     - Codex には mod が無いので入れないこと（Codex の一覧には出る）
     - 直すときは次の版で直すこと。更新と再読み込みの手順
     - 外すときは `claude plugin uninstall sphica-pane@sphica` であること
   - 本体の Requirements（2.1.139）は変えない
7. state の扱い
   - 定義: 表示の範囲は「この mod がこのセッションで見た最新 100 件」。`/clear` では消さない
   - 実測（A6）: reload、resume、`/clear` の後に何が残るかを測り、PR 本文に定義と分けて書く
8. 壊れたとき: エントリは残したまま、次のリリースで直した版か、何もしない版（hook を登録しない mod）を届ける。掲載をやめるのは別の扱いにし、入れている人には uninstall を案内する。`forceRemoveDeletedPlugins` は使わない

## 採った案と棄却した案

- 採用: 渡した記録のペイン。棄却: #218 の停止を mod に移す（計測中）、作業項目と未 trace の一覧（SessionStart の文面とほぼ同じ）
- 採用: classic hook の結果から読む。棄却: DB の `delivery` を読み取りサーバー経由で読む（MCP ツールの引数を足す公開契約の変更になる。hook が出した文面そのものではない）
- 採用: 別プラグインを `git-subdir` で配る。棄却: 本体の `plugin/hooks/hooks.json` に `modules` を足す（2.1.139〜2.1.286 でコマンド hook まで落ちるかが未検証で、落ちれば capture と配信が止まる。全員に全権限の mod が入る）。棄却: 別の npm パッケージ（公開の手順と承認の環境が 2 つになる）
- 採用: ref にリリースのタグ。棄却: `sha`（marketplace.json は自分を含むコミットの sha を書けない）
- 採用: 決まった言い回しで拾い、実際の出力で対を検査する。棄却: `deliver.ts` の出力に印を足す（両ホストのエージェントが読む文面が変わる）
- 採用: CI で固定した CLI の validate と test を、配る実物に対して流す。棄却: 手元だけで検査する（全権限で動くコードを、続けて守れない）
- 採用: 復旧は次の版で届ける。棄却: エントリを外す（入れた人の手元に残り、更新先も失う）
- 採用: 持ち主の確認で完了とし、具体例と版を残す。棄却: 利用回数の計測（mod は書かない約束）

## 手順

- S1: claude CLI の版の選び方と入れ方を実測で決め、Linux と Windows の CI で `claude --version` と、スパイク相当の小さな mod の validate と test が動くところまで通す
- S2: `pane/` の骨組み（マニフェスト、hooks.json、types、README、LICENSE）と `sift.ts`、`server/test/pane-sift.test.ts`。sift.ts と types を既存の検査に入れる
- S3: `register.tsx` と `register.test.tsx`
- S4: `scripts/check-pane.mjs` と `bun run pane:check`。check と ci:static と Windows のジョブに入れる
- S5: release-scope、check-mcp-version、release-plan、release-gate、release-status、CLAUDE.md・AGENTS.md・verification.md の version-sync、plugin-release の Skill
- S6: marketplace のエントリ、バージョンを上げる、README

## 完了条件

- A1: `bun run verify` → 0 で終わる
- A2: `gh pr checks <PR>` → Linux と Windows の pane:check を含む全ジョブが pass
- A3: `bun run pane:check` → `git archive` で展開した `pane/` で validate --strict と plugin test が通り、許可リストとの照合と marketplace のエントリの照合が通る
- A4: `node -e 'import("./scripts/lib/release-scope.mjs").then(m => console.log(m.releaseKind(["pane/hooks/register.tsx"])))'` → `plugin`
- A5: ファイルを読ませるセッションと、`SPHICA_DB` を一時の DB にして dead end のコマンドを走らせるセッションを `claude --plugin-dir pane` → `/sphica-pane` に SessionStart と PreToolUse の配信と、停止の理由（`stop`）が出る。どちらもセッションの進み方は mod の無いときと同じ
- A6: A5 のセッションで mod の再読み込み、`/clear`、`claude --resume` → それぞれの後にペインに残るものを測り、PR 本文に定義と分けて書いてある
- A7: リリース後、使い捨ての HOME で `claude plugin marketplace add iroha924/sphica` と `claude plugin install sphica-pane@sphica` → 読み込まれ、`/sphica-pane` が開いて配信が出る
- A8: A7 の HOME で `claude plugin uninstall sphica-pane@sphica` → 本体の SessionStart と読む前の配信が、変わらず届く
- A9: リリースから 7 日後に `gh issue view 370 --comments` → 持ち主の実利用で、どの配信を見つけ、何の判断に役立ったかの具体例と、使った Claude Code の版が書いてある。役に立たなかったなら、外すか残すかと理由が書いてある

## リスク

- 固定した版と利用者の版で mod の API が違う（early access で、断りなく変わりうる）→ README に確かめた版を書き、壊れた報告が来たら固定を上げて次の版で直す
- Windows の CI で claude CLI が動かない → 出荷せずに持ち主に戻す
- Codex の利用者が一覧の `sphica-pane` を入れる → README に書く。入れたときの挙動が問題なら、Codex 用の空のマニフェストを足すかを持ち主に聞く
- 他のプラグインが `Sphica` で始まる文を出し、ペインに混ざる → 表示だけの推定として README に書いてある。直さない
- `deliver.ts` の言い回しが変わって拾えなくなる → `pane-sift.test.ts` が落ちる
- 配信がとても多いセッションで描画が重い → 100 件と 8,000 文字の上限。足りなければ次の版で絞る

## 未解決

なし

## 変更履歴
