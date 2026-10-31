---
kind: plan
status: approved
codex_session: 01a19101-4f10-74e0-ae39-cfa3e7e45651
codex_rounds: 3
approved_at: 2026-10-31
---

# sphica-pane を出荷物・マーケットプレイス・リポジトリから外す

## 要点

- マーケットプレイスから sphica-pane のエントリを消し、トップレベルに `"renames": {"sphica-pane": null}` を残す。入れた人の手元の pane は、マーケットプレイスを更新すると無効になり、エラーは出ない
- pane/、pane のためだけの検査（check-pane・pane-report）、ピン留めした Claude Code CLI（tools/claude-cli、scripts/claude-cli.mjs）、そのテストと CI の手順を消す
- release-scope から pane と paneRef を外し、版をそろえる対象を 4 つ（npm、Claude と Codex の plugin.json、marketplace の npm 版）に戻す
- `renames` を消し忘れないよう、check-ai-config に検査を足す
- README・CLAUDE.md・AGENTS.md・verification.md・plugin-release の pane の記述を直す。plugin-release の手順 7 は丸ごと消す
- 0.6.71 としてリリースする。実行コード・hooks・MCP・DB は変えず、npm で変わるのは版と README だけ
- 公開の後、持ち主の実機で本体を更新し、pane が無効でエラーが無く配信が届くことを確かめてから pane をアンインストールする

## 持ち主の決定

- #370 は閉じた（2026-10-31）。持ち主は 0.6.66 で出した pane を 9 日間使わず、役に立った例が無いので hooks のままにする
- sphica-pane は出荷物とリポジトリから外す。後続の PR で行う（#370 のコメント）

## 目的

- `git ls-files pane tools/claude-cli` が空で、マーケットプレイスの plugins が sphica だけ、`renames` が `{"sphica-pane": null}`
- pane を入れていた人がマーケットプレイスを更新すると、pane は無効になり、`claude plugin list --json` にエラーが出ず、sphica は今どおり動く
- 0.6.71 が npm に出て、持ち主の実機の Claude Code と Codex に届く

## 対象外

- Sphica 本体の hooks・MCP・CLI・DB の挙動
- 過去のリリースのタグ（v0.6.66〜v0.6.70）。消すと、入れてあるコピーの元が無くなる
- server/evals/delivery/after-release-353.json の pane への言及（過去の計測の記録）
- `forceRemoveDeletedPlugins`（今後ほかのプラグインを消すときにも効いてしまう。今回の対象だけを示す renames を使う）
- 引退を告げるだけの最後の pane の版を出すこと（renames で無効にでき、告知の版を更新しなかった人への対処は別に要るため）
- project / local スコープでの実走（公式の説明では renames は user・project・local の設定から外す。持ち主も使っていない）

## 前提

- 実測（2026-10-31、Claude Code 2.1.316、HOME は替えず CLAUDE_CONFIG_DIR だけ使い捨て）: 0.6.70 のマーケットプレイスの写しから sphica と sphica-pane を入れ、写しから pane のエントリだけを消して `claude plugin marketplace update sphica` すると、`claude plugin list` で pane が「failed to load / Plugin sphica-pane not found in marketplace sphica」になる。update と install は not found、uninstall は成功
- 実測（同上）: エントリを消し、トップレベルに `"renames": {"sphica-pane": null}` を置くと、`claude plugin validate` は pass。marketplace update の後、settings.json の enabledPlugins から pane が外れ、`claude plugin list --json` で pane は enabled false、エラーなし。installed_plugins.json には残り、uninstall は成功
- 実測（Codex 0.163.0、CODEX_HOME だけ使い捨て）: renames 入りの写しを `codex plugin marketplace add` すると成功し、`codex plugin list` は sphica@sphica だけ
- 公式: https://code.claude.com/docs/en/plugins/host-marketplace#migrate-users-with-a-renames-map （renames の値を null にすると旧キーを設定から外す）と #uninstall-removed-plugins-from-users-machines（Codex が 2026-10-31 に確認）
- 使い捨ての HOME で claude を動かしたとき、macOS のキーチェーンのダイアログが出た（推測でその操作が原因）。実測は HOME を替えず CLAUDE_CONFIG_DIR / CODEX_HOME だけにする。ログインが無いので、使い捨ての環境ではセッションの起動を見られない
- `.claude-plugin/marketplace.json` は `EXACT_PACKAGE_INPUTS`（scripts/lib/release-scope.mjs:15）なので release kind は plugin。scripts/bundle.mjs:64 が README を出荷先へ写すので、npm では README も変わる
- check-mcp-version は VERSION_SOURCES から対象を作り（scripts/check-mcp-version.mjs:83）、`withoutReleaseVersion` で比べる（:137）。トップレベルの renames は壊さない（Codex がメモリ上で確認）
- scripts/check-ai-config.mjs:599〜625 は marketplace の先頭エントリだけを見ていて、renames の検査は無い
- ピン留めした CLI（tools/claude-cli、@anthropic-ai/claude-code 2.1.300）を使うのは scripts/check-pane.mjs:14 だけ。`bun run eval:plugin` は PATH の claude を使う（package.json:42）。Dependabot は GitHub Actions だけ（.github/dependabot.yml:4）
- 持ち主の手元には sphica-pane@sphica 0.6.70 が user スコープで有効に入っている
- 未検証: renames を解さない古い Claude Code（どの版からか分からない）では、M1 と同じ「failed to load」になる見込み。2.1.300 は試していない

## 方針

1. `.claude-plugin/marketplace.json`: plugins から sphica-pane を消し、トップレベルに `"renames": {"sphica-pane": null}` を置く。renames は今後も消さない
2. `scripts/check-ai-config.mjs` の marketplace の検査に、`marketplace.renames?.["sphica-pane"] === null` でなければ fail を足す。where は `.claude-plugin/marketplace.json`、why は「以前 sphica-pane を入れた人の手元で無効にしたまま残すため。消すとロードエラーに戻る」、fix は `"renames": {"sphica-pane": null}` を戻す
3. `scripts/lib/release-scope.mjs`: `PACKAGE_PREFIXES` から `pane/`、`VERSION_SOURCES` から `pane` と `paneRef` を消し、`withoutReleaseVersion` の git-subdir の ref を消す分岐とその注記を消す。コメントの「3 plugin channel manifests, and the sphica-pane plugin」を直す。`scripts/lib/release-scope.d.mts` の型から pane と paneRef を外す
4. pane を前提にした release のスクリプトとテストを直す: `scripts/release-plan.mjs`（版の行）、`scripts/release-status.mjs`（pane のキャッシュの確認と表示）、`server/test/release-scope.test.ts`・`release-plan.test.ts`・`check-mcp-version.test.ts`（pane の写しと pane のテストを消す）
5. 消すもの: `pane/`、`scripts/check-pane.mjs`、`scripts/lib/pane-report.mjs`・`pane-report.d.mts`、`scripts/claude-cli.mjs`・`claude-cli.d.mts`、`tools/claude-cli/`（全体）、`server/test/pane-sift.test.ts`・`pane-report.test.ts`・`claude-cli.test.ts`
6. pane を前提にした設定を直す: `package.json`（setup の `bun install --cwd tools/claude-cli`、check の `pane:check`、`pane:check` の script）、`.github/workflows/check.yml`（Linux の「The pinned Claude Code CLI」と Windows の「Validate and test the pane mod on Windows」の 2 ステップ）、`lefthook.yml`（2 つの glob から pane）、`.gitignore`（pane の型と tsconfig）、`scripts/check-english.mjs`・`oxfmt.mjs`・`oxlint.mjs`・`check-license-headers.mjs` の pane の行
7. 文書: README は導入の節（「Optional, Claude Code only: a pane …」の節）と更新の節の pane の行を消し、アンインストールの節を「以前 sphica-pane を入れていたら、マーケットプレイスを更新すると無効になる。消すには `claude plugin uninstall sphica-pane@sphica`（project / local に入れたなら同じ `--scope` を付ける）」にする。CLAUDE.md と AGENTS.md の version-sync から sphica-pane を外す。`.claude/rules/verification.md` の plugin の説明から the sphica-pane mod を外す。`.agents/skills/plugin-release/SKILL.md` は release 種別の表から the sphica-pane mod を外し、手順 7 を丸ごと消す
8. 版は 0.6.71。最初のパッケージ入力のコミットで VERSION_SOURCES の 4 つを上げる（pre-commit が main と同じ版のパッケージ入力のコミットを拒むため）

## 採った案と棄却した案

- 採用: エントリを消して `renames: {"sphica-pane": null}` を残す。棄却: エントリを消すだけ（入れた人の手元で failed to load が残る。実測）
- 採用: renames。棄却: `forceRemoveDeletedPlugins`（今後ほかのプラグインを消すときにも効く）
- 採用: 告知の版を挟まずに消す。棄却: 引退を告げる最後の pane の版を 1 リリース出す（renames で無効にでき、告知の版を更新しなかった人には別の対処が要る）
- 採用: ピン留めした CLI も一緒に消す。棄却: 残す（使うのは check-pane だけ）
- 採用: renames を check-ai-config で守る。棄却: 文書の規定だけ（版を上げれば renames を消しても通る）
- 採用: 撤去の確かめ方は plan と PR に残し、plugin-release の手順 7 は丸ごと消す。棄却: 撤去の確認を毎回のリリース手順に残す（一度きりの作業）

## 手順

- S1: marketplace のエントリを消して renames を置き、check-ai-config に renames の検査を足す（方針 1・2）
- S2: release-scope・release のスクリプト・そのテストから pane を外す（方針 3・4）
- S3: pane/ と pane だけのための検査・CLI・テストを消し、設定から pane の行を外す（方針 5・6）
- S4: 文書を直す（方針 7）
- S5: 版を 0.6.71 に上げる（方針 8）

## 完了条件

- A1: `git grep -n -i -E "sphica-pane|pane/|check-pane|pane-report|pane-sift|claude-cli|paneRef"` と `git ls-files | grep -i -E "pane|claude-cli"` → ヒットは server/evals/delivery/after-release-353.json、README のアンインストールの節、.claude-plugin/marketplace.json の renames、scripts/check-ai-config.mjs の renames の検査、`.claude/plans/2026/10/31-remove-sphica-pane.plan.md` と `.tasks.md` だけ
- A2: `git ls-files pane tools/claude-cli` → 空。`node -e 'const m=require("./.claude-plugin/marketplace.json");console.log(m.plugins.map(p=>p.name).join(),JSON.stringify(m.renames))'` → `sphica {"sphica-pane":null}`
- A3: 一時ディレクトリに `git worktree add` した独立の写しで、marketplace.json の renames を (a) 消す (b) `"x"` にする、のそれぞれで `bun run verify:ai` → 非 0 で、renames の検査の文が出る。null に戻すと `bun run verify:ai` → 0。写しは `git worktree remove` で外す
- A4: `caffeinate -i mise exec -- bun run verify` → exit 0
- A5: `bun run release:plan -- --base a58ee28214634317d721f6d64fd4b752ca9732cc` → kind plugin、版の行が 4 つとも 0.6.71
- A6: `diff -r <0.6.71 の pack を展開した先> <npm pack sphica@0.6.70 を展開した先>` → 違いは版の欄と README だけ（どちらもリポジトリの外に展開する）
- A7: `claude plugin list --json` → sphica-pane が enabled false でエラーなし、sphica は enabled（CLAUDE_CONFIG_DIR だけ使い捨て、HOME は替えない、SPHICA_DB・SPHICA_HOME・CODEX_HOME は外す。0.6.70 の marketplace.json の写し（ローカルディレクトリ）から sphica と sphica-pane を入れ、写しを候補の marketplace.json に置き換えて `claude plugin marketplace update sphica` した後）。`claude plugin uninstall sphica-pane@sphica` の後は sphica だけ。CODEX_HOME だけ使い捨てで候補の写しを `codex plugin marketplace add` した後の `codex plugin list` → sphica@sphica だけ。Claude Code と Codex の版を記録する
- A8: `gh pr checks <PR>` → 最終 head で、Linux・Windows を含む全件が pass か、タグの push でだけ走るジョブが skipping
- A9: 公開の後、plugin-release の手順 3〜6 の到達確認 → 持ち主の実機で `claude plugin marketplace update sphica` → `claude plugin update sphica@sphica` → `claude plugin list --json` で sphica が 0.6.71 で enabled、sphica-pane が enabled false でエラーなし → 新しいセッションを 2 回開いて plugin のロードエラーが無いこと、`sphica doctor` が通ること、anchor のある記録のファイルを読んで配信が届くこと → `claude plugin uninstall sphica-pane@sphica` → `claude plugin list --json` で sphica だけ

## リスク

- renames を解さない古い Claude Code の人の手元で、pane が failed to load になる → README のアンインストールの案内で消してもらう。報告が来たら版の下限を README に書く
- renames を後で誰かが消す → check-ai-config が落とす（A3）
- 公開の後、持ち主の実機でセッションの起動にロードエラーが出る（使い捨ての環境では見られなかった）→ 記録して、uninstall で消えるかを確かめ、README の案内を直す修正を出す

## 未解決

なし

## 変更履歴

- 2026-10-31 / README のアンインストールの案内に、2.1.193 より前の Claude Code では not found と出ることと、Codex では `codex plugin remove sphica-pane@sphica` で消すことを足した（T04） / 差分全体の review-shipping の指摘と、2.1.139・2.1.191・Codex 0.163.0 の実測から / 範囲は README の同じ節の中なので Go は取り直さない
