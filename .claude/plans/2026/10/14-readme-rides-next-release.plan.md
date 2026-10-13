---
kind: plan
status: approved
codex_session: 01a135c5-1e0b-76a2-befd-39ea30f32432
codex_rounds: 2
approved_at: 2026-10-14
---

# README.md だけの変更を、バージョンを上げずに main へ出せるようにする

## 要点

- `README.md` をバージョン検査の対象（`scripts/lib/release-scope.mjs` の入力）から外す。README.md だけの変更は kind `none` になり、bump なしでコミットでき、次のリリースの tarball に乗る
- `README.md` と `plugin/` や `server/src/` を一緒に変えた差分は、今までどおり bump を求められる。tarball に README.md が入ることも変えない
- `sphica doctor` がリポジトリとキャッシュを比べるときだけ、`README.md` の違いを「same version, different contents」に数えない。CLI とキャッシュ、キャッシュどうしの比較は今のまま
- 規範と手順（CLAUDE.md、AGENTS.md、verification.md、review-shipping、plugin-release の Skill、CONTRIBUTING.md）に、README.md だけの例外を書く。リリースのタグを push してから run が終わるまでは README.md も main へ push しない、と手順に足す
- README.md と README.ja.md の書き換え（先頭の中央寄せとバッジの入れ替え、設定の節への集約、経緯の記述の削除、日本語版に抜けていた項目の追加）を同じ PR に入れる
- doctor の変更が `server/src/` に入るので、この PR は 0.6.56 のリリースになる。main への直接 push が使えるのは、このリリースの後から
- main の ruleset、リリースの検査（祖先の確認、ツリーの比較）、fork からの PR の手順は変えない

## 持ち主の決定

- README.md だけの変更は、バージョンを上げずに main へ直接 push できるようにする。検査を変える案を選んだ（「2で進める」、2026-10-13）
- その代わり、npm のページの README が次のリリースまで古いままになることは受け入れる（案 2 の代償として示したうえで選んだ）
- リリースの手順の Skill なども合わせて直す（「リリーススキルとかも更新する必要ありそう」）
- README の先頭は、タイトルからバッジ・注記・言語の切り替え・説明文まで中央寄せにする。CI と Dependabot のバッジは外し、sphica のバージョンのバッジと、インストールへ誘導する大きなバッジを足す
- README の内容を今のコードと突き合わせ、確実に不要なところは削る。削ると微妙なものは、無理に README の外へ出さない

## 目的

- main で `README.md` だけを stage して `node scripts/check-mcp-version.mjs` を流すと 0 で終わる
- `bun run release:plan` が README.md だけの差分を `none` と言う
- `README.md` と package の入力を一緒に変えた差分は、stage の形でも `--base` の形でも 1 で終わる
- リポジトリの中で `sphica doctor` を流したとき、README.md だけがリポジトリとキャッシュで違っても「same version, different contents」が出ない

## 対象外

- tarball の中身。`scripts/bundle.mjs` は今までどおり `README.md` を `plugin/README.md` へ写す
- `README.ja.md`（今も入力ではない）
- main の ruleset と、リリースの検査（`release-gate.mjs` の祖先の確認、`release-finish.mjs` のツリーの比較）。緩めない
- README の内容を README の外（`docs/` など）へ出すこと

## 前提

- `scripts/lib/release-scope.mjs:7-17`: `EXACT_PACKAGE_INPUTS` に `README.md` がある。`isPackageInput` を `scripts/check-mcp-version.mjs:99` と `scripts/release-plan.mjs:47` が使う
- 実測（2026-10-13）: main で `README.md` だけを stage して `bun run scripts/check-mcp-version.mjs` → exit 1、「1 plugin channel inputs changed, but the npm package and plugin versions were not bumped together (for example README.md)」
- `lefthook.yml:35`: pre-commit の bundle ジョブの glob に `README.md` がある。`server/test/release-scope.test.ts:38-50` は入力が glob に入っていることだけを見る（glob に余分があっても通る）
- `server/src/plugin.ts:86,107`: `GENERATED` に `README.md` があり、リポジトリ側（`tracked: true`）は生成された `plugin/README.md` を比較に含める。`plugin.ts:601` の比較で違うと `plugin.ts:606` の文言が出る。`plugin.ts:677` のホストどうしの比較は `tracked` を渡さない
- `scripts/check-ai-config.mjs:140-146`: `.claude/rules/verification.md` に `` `plugin`: a change that goes into the package `` という文字列があることを必須にしている
- `scripts/release-gate.mjs:31-36`: タグのコミットが今の main を祖先に持たないと、リリースを止める（Codex が read-only で `mainIsAncestor: false` の拒否を確かめた）
- `.github/workflows/check.yml:61-62`: main への push でも `check-mcp-version.mjs --base <push の前>` を流す
- pre-push と CI は `verify` の中で bundle を流すので、pre-commit の glob から README.md を外しても、tarball の検査は新しい `plugin/README.md` を見る（`package.json` の `verify`、`check.yml:94-103`）
- 今のバージョンは 0.6.55（`plugin/package.json:3`、npm の latest も 0.6.55）
- README の数値とコマンドはコードと突き合わせた（`trace.ts:12` の 14 日、`github.ts:20` の 5 件、`export.ts:22` の 29 KiB、`capture.ts:61-62` の 30 日と 1,000 件、`delivery-view.ts:14` の 1〜90 日と既定 7 日、`search.ts:28` の 10 件、`plugin.ts:186` の 2.1.139、`codex-trust.ts:11` の 0.160.0、`plugin/.claude-plugin/plugin.json:20-38` の 3 つのオプション）
- 未検証: npm のページで `<div align="center">` の中の見出しとバッジがどう表示されるか（公開しないと確かめられない）

## 方針

1. `scripts/lib/release-scope.mjs` の `EXACT_PACKAGE_INPUTS` から `README.md` を外す。冒頭のコメントに、README.md は tarball に入るが、それだけの変更は次のリリースに乗ると書く。別の集合は作らない
2. `lefthook.yml` の bundle ジョブの glob から `README.md` を外す
3. テスト
   - `server/test/release-scope.test.ts`: `releaseKind(["README.md"])` は `none`、`releaseKind(["README.md", "server/src/mcp.ts"])` は `plugin`。bundle の glob に `README.md` が入っていないことも確かめる
   - `server/test/check-mcp-version.test.ts`: 一時リポジトリを main にして、(a) stage した README.md だけの変更が 0、(b) コミットした後の `--base <前のコミット>` でも 0、(c) README.md と `plugin/skills/a.md` を一緒に変えると、stage の形でも `--base` の形でも 1
4. `server/src/plugin.ts` の `differingFiles` で、`tracked` が真のときだけ、相対パス `README.md` を両側から外す。`GENERATED` はそのまま。テスト（`server/test/plugin.test.ts`）
   - `differingFiles(repo, cache, { tracked: true })` は、README.md の中身が違っても、片側に無くても、空
   - `differingFiles(a, b)` は README.md の違いを今までどおり返す
   - `report`: リポジトリが見えていて同じバージョンのとき、README.md だけ違うキャッシュには「same version, different contents」が出ない。`dist/mcp.js` が違えば今までどおり出る
5. バージョンを 0.6.56 にする（`plugin/package.json`、`plugin/.claude-plugin/plugin.json`、`plugin/.codex-plugin/plugin.json`、`.claude-plugin/marketplace.json` の npm source）。4 の変更と同じコミットに入れる
6. 文書を合わせる。README.md だけの変更は「tarball には入るが、bump は要らず、次のリリースに乗る」例外として書く
   - `CLAUDE.md` と `AGENTS.md` の version-sync の行（両方を同じ意味に保つ）
   - `CLAUDE.md` の「Branches and PRs」: 持ち主による README.md だけの変更は main へ直接でよい。今リリースされている挙動の説明に限る。fork からの変更は今までどおり fork-pr の手順
   - `.claude/rules/verification.md` の Release: `` `plugin`: a change that goes into the package `` の書き出しは残し、その行に例外を足す（`check-ai-config.mjs` は変えない）
   - `.claude/agents/review-shipping.md` の「Versions left unchanged」
   - `.agents/skills/plugin-release/SKILL.md`: kind の表と、タグを push してからリリースの run が終わるまで README.md も main へ push しない、という注意
   - `CONTRIBUTING.md` の Versions: 一覧から `README.md` を外し、README.md だけの変更は次のリリースで出ると 1 文で書く
7. README.md と README.ja.md の書き換えを入れる
   - 先頭を `<div align="center">` で中央寄せにする。順は、タイトル、太字の一文、言語の切り替え、説明文、バッジ、インストールのボタン、バッジの注記
   - バッジは npm のバージョン、License、OpenSSF Scorecard、OpenSSF Best Practices、SLSA Build L2。CI と Dependabot は外し、注記から CI の説明を外す
   - 3 つの設定の説明を新しい「Settings / 設定」の節に集め、元の場所はリンクにする
   - バージョン番号と経緯の記述（「0.5.7 より前」「0.6.0 がそう」）を外す。必要条件のバージョンは残す
   - 日本語版に「前に聞いたことを探す」を足し、コマンドの表に `sphica doctor --reindex` を足す

## 採った案と棄却した案

- 採用: `README.md` を入力から外す。棄却: 「次のリリースに乗る入力」という別の集合を作る（使う場所が無い）
- 採用: doctor はリポジトリとの比較のときだけ README.md を外す。棄却: `differingFiles` の全比較から外す（CLI とキャッシュ、キャッシュどうしで README.md の違いや欠落を見逃す。Codex の C2）
- 採用: リリース中は main へ push しないと手順に書く。棄却: 祖先の確認やツリーの比較から README.md を外す（リリースの検査を緩めることになる。Codex の C4）
- 採用: README の書き換えをこのリリースの PR に入れる。棄却: リリースの後に main へ直接 push する（npm のページが次のリリースまで古いままになる）
- 採用: `verification.md` の必須の文字列を残して例外を足す。棄却: `check-ai-config.mjs` の必須の文字列を変える（検査を変えずに済む）

## 手順

- S1: 入力から README.md を外す（方針 1・2・3）
- S2: doctor のリポジトリとの比較から README.md を外し、0.6.56 にする（方針 4・5）
- S3: 規範と手順の文書を合わせる（方針 6）
- S4: README.md と README.ja.md の書き換えを入れる（方針 7）

## 完了条件

- A1: `caffeinate -i bun run verify` → 全部通る
- A2: `rg -n "red" .claude/plans/2026/10/14-readme-rides-next-release.tasks.md` → 入力から README.md を外すタスクの結果行に、直す前のコードで足した `check-mcp-version.test.ts` の (a) が失敗した実測がある
- A3: `gh pr checks <この PR の番号>` → 最新の head で、check の全ジョブ、pr-body、release の dry run が全部 pass
- A4: リリースの後、main で README.md に 1 行の変更を stage し、`git diff --cached --name-only` が `README.md` だけであることを見てから、`node scripts/check-mcp-version.mjs` → 0、`bun run release:plan -- --base HEAD` → `none`。確かめたら stage と変更を戻す
- A5: `sphica doctor` → 「same version, different contents」が出ない（リリースの後、両ホストのキャッシュが 0.6.56 の状態で、リポジトリの中から流す）

## リスク

- README を main へ出した後、GitHub の README と npm のページが次のリリースまで食い違う → 受け入れ済み。まだリリースされていない挙動を README に先に書くと、手順と入っているものがずれるので、main へ直接出すのは今リリースされている挙動の説明に限る（方針 6 で規範に書く）
- リリースのタグを push した後に README を main へ push すると、リリースの run が止まる → 手順に書く。止まったら main を PR ブランチへ merge してタグを打ち直す、今の手順どおり
- npm のページで中央寄せの表示が崩れる → リリースの後にページを見て、崩れていたら README を直して次のリリースに乗せる

## 未解決

なし

## 変更履歴
