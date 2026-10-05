---
kind: plan
status: approved
codex_session: 01a10ad4-cb98-7b82-9984-3a3596a117ce
codex_rounds: 4
approved_at: 2026-10-05
---

# 配る Markdown とリポジトリの Markdown を markdownlint-cli2 と lychee で検査し、手書きのリンク検査を置き換える

## 要点

- markdownlint-cli2（server の devDependency）で、Markdown の構造の崩れ（空リンク、同じ文書のアンカー、未定義の参照ラベル、表の列数など）を検査する。既定の規則はすべて切り、壊れ方に関わる規則だけを名指しで入れる
- lychee（mise で 0.24.2 に固定、CI は SHA-256 を確かめてダウンロード）で、相対リンク・画像・ファイルをまたぐ見出しアンカーを `--offline --include-fragments` で検査する。自分のリポジトリの `blob/main` の絶対 URL は、ローカルのファイルに読み替えて検査する
- pre-commit: markdownlint は stage した `*.md`、lychee は毎回全文書。verify・verify:ai と CI: コミットされた全文書
- check-tarball: 展開した package の Markdown に両方をかけ、相対リンクの解決先が package の中にあることも確かめる
- check-ai-config.mjs の手書きの `checkLocalLinks` を消す（lychee が同じファイルを見る）
- 変えないもの: 外部 URL の検査はしない（週 1 回のジョブも作らない）。文章の質の検査（Vale・textlint）は入れない。配る中身は変わらない

## 持ち主の決定

- markdownlint-cli2 と lychee の組み合わせを、計画にして入れる（「OK、計画にして進めよう」）
- 作業はメインの checkout でブランチを切って行う（worktree は使わない）

## 目的

- リポジトリの Markdown と、npm の tarball に入る Markdown のどちらでも、相対リンク・画像のパス・見出しアンカー・Markdown の構造が壊れたら、pre-commit か verify か CI のどこかで落ちる
- tarball の Markdown が、package の外のファイルを相対リンクで指していたら落ちる

## 対象外

- 外部 URL（HTTP）の到達性。誤って落ちやすく、ネットワークに頼るため
- コードフェンスの閉じ忘れ。CommonMark では文書の終わりまでコードとして成立し、保守されている標準の規則で見つけるものが無い。起きたら見直す
- 文章の質（言い回し・表記の揺れ）。Vale・textlint は壊れ方を見ないため
- `.claude/plans/` の Markdown。完了したら消す作業用の文書で、リンクも計画の時点のもの

## 前提

- 配る Markdown（`plugin/` で `npm pack --dry-run`）: README.md、THIRD_PARTY_NOTICES.md（bundle が生成）、skills/*/SKILL.md 8 件、skills/review/reviewers/*.md 6 件、skills/review/references/peer-model.md
- 追跡している Markdown は `.claude/plans/` を除いて 43 件。相対リンクは `plugin/skills/harvest/SKILL.md:39`（`../trace/SKILL.md`）と `plugin/skills/review/SKILL.md:253`（`references/peer-model.md`）の 2 件だけ。README.md には自分のリポジトリへの `https://github.com/iroha924/sphica/blob/main/...` の絶対 URL があり、`README.ja.md#貢献` のようなアンカー付きのものも含む
- `scripts/check-ai-config.mjs:61-68` の `checkLocalLinks` は正規表現でリンクを取り出し、`#` 以降を捨ててファイルの存在だけを見る。呼び出しは `.claude/skills/*/SKILL.md`（171）、`.agents/skills/*/SKILL.md`（185）、`plugin/skills/*/SKILL.md`（421）
- 2026-10-05 の試し流し（手元の lychee 0.24.2）: 43 件に `--offline --include-fragments` → エラー 0、OK 2、除外 37。markdownlint-cli2 0.23.3 の既定の規則 → MD013 1,277 件、MD060 180 件、MD029 12 件、MD041 8 件、MD036 8 件、MD040 7 件、MD012 1 件。MD042・MD051・MD052・MD056 は 0 件
- lychee の `--root-dir` は相対リンクを package の中に閉じ込めない。`--format json` だけでは成功したリンクが `success_map` に入らず、`--verbose` を付けると入る（Codex が lychee 0.24.2 で実測）
- 依存の出どころ: markdownlint-cli2 は npm の maintainer が davidanson、repository が `github.com/DavidAnson/markdownlint-cli2`、engines は node >= 22。lychee 0.24.2 は `lycheeverse/lychee` の GitHub Release で、`lychee-x86_64-unknown-linux-gnu.tar.gz` の sha256 は `1f4e0ef7f6554a6ed33dd7ac144fb2e1bbed98598e7af973042fc5cd43951c9a`。mise の registry では `aqua:lycheeverse/lychee`
- actionlint は `mise.toml` で固定し、CI では SHA-256 を確かめてダウンロードしている（`.github/workflows/zizmor.yml:49-55`）
- check-tarball は CI の check（`.github/workflows/check.yml:89`）と release の prepare（`release.yml:149`）で流れる。どちらにも lychee が要る
- `server/package.json` は package の入力（`scripts/lib/release-scope.mjs`）なので、devDependency を足すと release:plan は plugin になり、0.6.33 として出す

## 方針

### markdownlint-cli2

- `server/package.json` の devDependencies に `"markdownlint-cli2": "0.23.3"`（固定）
- 設定はリポジトリのルートの `.markdownlint-cli2.jsonc`。`ignores` に `.claude/plans/**` を入れ、`globs` は置かない（stage したファイルで流すときに全文書が足されないように）。`config` は `"default": false` にし、壊れ方に関わる規則だけを `true` にする。候補: MD011（逆向きのリンク）、MD042（空リンク）、MD051（同じ文書のアンカー）、MD052（未定義の参照ラベル、`shortcut_syntax` は false のまま）、MD056（表の列数）、MD058（表の前後の空行）。最終の一覧は実装のときに今のファイルへ流して決め、違反 0 件で入れる
- 対象は追跡している `*.md` のうち `.claude/plans/` を除くもの。一覧は `scripts/lib/markdown-files.mjs`（新規、`git ls-files`）が lychee と共通で作る。`scripts/check-markdown.mjs`（新規）がその一覧を markdownlint-cli2 に渡し、`bun run markdown` として `check` に入れる

### lychee

- `mise.toml` に `lychee = "0.24.2"`
- 設定はリポジトリのルートの `lychee.toml`: `offline = true`、`include_fragments = "anchor-only"`、`no_progress = true`（0.24.2 では `include_fragments` は文字列。`true` は起動しない）。呼び出しはどれも `--config` に絶対パスで渡す（lychee は今のディレクトリの設定しか探さず、check-tarball は `plugin/` から起動される）
- `scripts/check-links.mjs`（新規）: `git ls-files '*.md'` から `.claude/plans/` を除いた一覧を lychee に渡す（`execFileSync`、シェルを通さない）。リポジトリの検査に限り、`--remap` で `https://github.com/iroha924/sphica/blob/main/(.*)` をリポジトリの中のファイルに読み替えて、README の自分への絶対 URL とアンカーも検査する。`verify:ai` を `node scripts/check-ai-config.mjs && node scripts/check-links.mjs` にして、`verify:ai` を直接流す経路にもリンクの検査を残す（`check` は今どおり `verify:ai` を通る）
- CI: check の verify のジョブと、release の prepare のジョブで、actionlint と同じ形（バージョンと SHA-256 を env に書き、`sha256sum -c` で確かめて展開）で lychee を入れ、PATH に置く
- `scripts/check-pairs.mjs` のツールのバージョンの節で、mise.toml の lychee と check.yml・release.yml の lychee のバージョンが同じで、どちらの workflow にも導入の step があることを照合する

### pre-commit（lefthook）

- `markdown`: glob `*.md`、stage したファイルに markdownlint-cli2（`--no-globs`、設定の `ignores` で `.claude/plans/` を外す）
- `links`: glob なし（毎回）、`mise exec -- node scripts/check-links.mjs`。見出しやファイルの変更が別の文書のリンクを壊すため。部分的な stage は厳密には見ない（CI が見る）
- `ai-config` の job は `bun run verify:ai` ではなく `node scripts/check-ai-config.mjs` を直接流す（リンクは `links` が毎回見るので、二重に流さない）

### check-tarball

- 展開した package の Markdown 全部（README のコピーと生成された THIRD_PARTY_NOTICES を含む）に、同じ markdownlint の設定と lychee をかける。どちらにもリポジトリのルートの設定ファイルと実行ファイルを絶対パスで渡し、入力は展開先の絶対パスで列挙する。remap はしない（remap は check-links.mjs の引数だけに置く。package の中に GitHub のファイルは無い）
- lychee は `--format json --verbose` で流し、`success_map` の `file://` の URL を URL として解析して、fragment を除いた実際のパス（realpath）が展開した package の root の中にあることを確かめる。文字列の前方一致や `../` の字面では判定しない
- 包含の判定は `scripts/lib/` の関数にし、テストを書く（成功と失敗の混ざった JSON、package の外の既存ファイル、正常な `../trace/SKILL.md`）

### checkLocalLinks の置き換え

- `links` が同じファイル（`.claude/skills`、`.agents/skills`、`plugin/skills` の SKILL.md）を見ることを確かめてから、`checkLocalLinks` と 3 か所の呼び出しを消す。frontmatter や allowed-tools などの検査は残す

### 文書

- CLAUDE.md の command の節: `mise install` の説明に lychee を足し、`bun run verify` の説明に Markdown を足す

### 片付け

- 前の PR の F2 の plan と tasks（`.claude/plans/2026/10/05-f2-init-project.*`）を消す。手順の S にもタスクにもせず、作業ブランチのコミット `3e413a3c` で行った

### リリース

- release:plan は stage した差分で種別を決めるので、markdownlint-cli2 と lockfile の変更を stage してから `bun run release:plan -- --base 30245523` で plugin を確かめ、同じコミットで 4 か所を 0.6.33 に上げる。plugin-release の手順で出す

## 採った案と棄却した案

- 採用: markdownlint-cli2 + lychee。棄却: remark-validate-links（ファイルをまたぐ見出しに remark-cli と repository:false・root の設定が要り、lychee ならリポジトリと tarball を 1 つの CLI で見られる）
- 棄却: markdown-link-check（ファイルをまたぐアンカーを見ない）、Vale・textlint（文章の質の検査で、壊れ方を見ない）
- 採用: markdownlint は `default: false` で規則を名指し。棄却: 既定から書き方の規則を外していく（意図しない規則が残る）
- 採用: pre-commit の lychee は毎回全文書。棄却: stage したファイルだけ（見出しを変えた側では、別の文書からのリンク切れが見えない）
- 採用: tarball の相対リンクの包含は lychee の JSON の解決先の realpath で判定。棄却: `--root-dir` に頼る（閉じ込めない）、`../` の字面で判定する（正常な `../trace/SKILL.md` と区別できない）
- 採用: 外部 URL の検査は入れない。棄却: 週 1 回のジョブ（誤って落ちやすく、保守の手間に見合わない）
- 採用: lychee は mise と SHA-256 で固定。棄却: lychee-action（Action を増やし、tarball の検査と同じ CLI で呼べない）

## 手順

- S1: markdownlint-cli2 と設定、Markdown の一覧の共通の関数、`bun run markdown`、lefthook の `markdown`、release:plan の後に 0.6.33 に上げる
- S2: lychee（mise・`lychee.toml`・`scripts/check-links.mjs`・remap）、`verify:ai` への組み込み、lefthook の `links` と `ai-config`、CI での導入、check-pairs での照合
- S3: `checkLocalLinks` を消す
- S4: check-tarball に両方をかけ、包含の判定の関数とテスト
- S5: CLAUDE.md の command の節

## 完了条件

- A1: `bun run markdown && bun run verify:ai` → 終了コード 0
- A2: README.ja.md の見出しを指すアンカーを壊した一時的な変更で `node scripts/check-links.mjs` → 落ちる（`bun run verify:ai` でも落ちる）。`[x]()` を足した一時的な変更で `bun run markdown` → MD042 で落ちる（どちらも戻す）
- A3: package の外の既存ファイルを指す相対リンクを足した plugin の Markdown を `bun run bundle` してから `node scripts/check-tarball.mjs <tgz>` → 包含の判定で落ちる（戻す）
- A4: `git grep -n checkLocalLinks -- scripts` → 該当なし（終了コード 1）
- A5: `bun run verify` → 終了コード 0。check.yml の lychee のバージョンだけを変えた一時的な変更で `bun run pairs` → 落ちる（戻す）
- A6: `gh pr checks <PR>` → 全項目 pass。check の verify と check-tarball のログに lychee の結果が出ている
- A7: `bun run release:status` → 0.6.33 のリリースの後に `release ledger is consistent`（release の prepare で lychee が流れている）

## リスク

- markdownlint の構造の規則が、今は 0 件でも将来の書き方と合わない → 規則を外すときは理由を設定ファイルのコメントに書く
- lychee のアンカーの判定が GitHub の描画とずれ、正しいリンクが落ちる → その URL だけ除外し、理由を `lychee.toml` に書く
- release の prepare で lychee のダウンロードが失敗する → SHA-256 の不一致なら止めて調べる。ネットワークの失敗なら run を再実行する

## 未解決

なし

## 変更履歴
- 2026-10-05 / 手順から S1（F2 の plan の削除）を外して S2〜S6 を S1〜S5 に振り直し、tasks の T01 を取りやめにした / done の検査は、チェックを付けたコミットが `.claude/plans/` の外を変えていることを求め、plan の中だけを変える T01 は通らない。削除は `3e413a3c` で済んでいる / Go 不要（範囲は変わらない）
