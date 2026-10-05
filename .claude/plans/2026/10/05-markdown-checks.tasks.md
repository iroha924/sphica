---
kind: tasks
plan: 05-markdown-checks.plan.md
branch: ci/markdown-checks
base: main
---

# 配る Markdown とリポジトリの Markdown を markdownlint-cli2 と lychee で検査し、手書きのリンク検査を置き換える のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: Markdown の構造の検査

markdownlint-cli2 が、リポジトリの Markdown の構造の崩れを pre-commit と verify で落とす

- [-] T01: F2 の plan と tasks を消す
  - 種別: 削除
  - 計画: S1
  - 依存: なし
  - 変更: `.claude/plans/2026/10/05-f2-init-project.plan.md`, `.claude/plans/2026/10/05-f2-init-project.tasks.md`
  - 完了条件: `git ls-files .claude/plans/2026/10/05-f2-init-project.*` → 0 件
  - コミット: `chore(plans): remove the finished F2 plan`
- [x] T02: markdownlint-cli2 を入れ、構造の規則だけで全文書を検査し、0.6.33 に上げる
  - 種別: 追加
  - 計画: S1
  - 依存: なし
  - 変更: `server/package.json`, `server/bun.lock`, `.markdownlint-cli2.jsonc`, `scripts/lib/markdown-files.mjs`, `scripts/check-markdown.mjs`, `package.json`, `lefthook.yml`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `knip.json`
  - 完了条件: `bun run markdown` → 終了コード 0。`[x]()` を足した一時的な変更で → MD042 で落ちる（戻す）。依存を stage した後の `bun run release:plan -- --base 30245523` → plugin、4 か所が 0.6.33。`bun run verify` → 終了コード 0
  - コミット: `ci(docs): lint the structure of Markdown with markdownlint-cli2`
  - 結果: `bun run markdown` → 32 ファイル、0 件。SECURITY.md に `[x]()` を足すと `MD042/no-empty-links` で落ちた（戻した）。依存を stage した後の `bun run release:plan -- --base 30245523` → `release kind: plugin`、4 か所を 0.6.33 に上げた。`bun run verify` → exit 0

## P2: リンクの検査

lychee が、相対リンク・画像・見出しアンカーと自分のリポジトリへの絶対 URL を、pre-commit・verify:ai・CI で落とす

- [x] T03: lychee を mise と CI に入れ、check-links.mjs を verify:ai と lefthook から流す
  - 種別: 追加
  - 計画: S2
  - 依存: T02（Markdown の一覧の共通の関数が要る）
  - 変更: `mise.toml`, `lychee.toml`, `scripts/check-links.mjs`, `package.json`, `lefthook.yml`, `.github/workflows/check.yml`, `.github/workflows/release.yml`, `scripts/check-pairs.mjs`, `knip.json`
  - 完了条件: `bun run verify:ai` → 終了コード 0。README.ja.md の見出しを指すアンカーを壊した一時的な変更で `node scripts/check-links.mjs` → 落ちる（戻す）。check.yml の lychee のバージョンだけを変えた一時的な変更で `bun run pairs` → 落ちる（戻す）。`actionlint` → 指摘なし。`bun run verify` → 終了コード 0
  - コミット: `ci(docs): check Markdown links and anchors offline with lychee`
  - 結果: `node scripts/check-links.mjs` → 39 リンク、14 OK（自分のリポジトリの blob/main の URL を remap で読み替え）、0 エラー。README.ja.md の `blob/main/README.ja.md#貢献` を `#no-such-heading` にすると `Cannot find fragment` で落ち、`bun run verify:ai` も exit 1（戻した）。check.yml の LYCHEE を 0.24.1 にすると `bun run pairs` が `LYCHEE 0.24.1 differs from mise.toml lychee 0.24.2` で落ちた（戻した）。CI で落とす tarball の sha256 は手元のダウンロードで一致、中身は `lychee-x86_64-unknown-linux-gnu/lychee` なので `--strip-components=1` で取り出す。`actionlint` → 指摘なし。`bun run verify` → exit 0
- [x] T04: check-ai-config.mjs の checkLocalLinks を消す
  - 種別: 削除
  - 計画: S3
  - 依存: T03（同じファイルを lychee が見ていることが要る）
  - 変更: `scripts/check-ai-config.mjs`
  - 完了条件: `git grep -n checkLocalLinks -- scripts` → 該当なし（終了コード 1）。存在しないファイルへの相対リンクを `.agents/skills` の SKILL.md に足した一時的な変更で `bun run verify:ai` → 落ちる（戻す）。`bun run verify` → 終了コード 0
  - コミット: `refactor(ai-config): leave link checks to lychee`
  - 結果: `git grep -n checkLocalLinks -- scripts` → 該当なし（exit 1）。`.agents/skills/knowledge-schema/SKILL.md` に `[the missing page](references/missing.md)` を足すと、lychee が `File not found` を出して `bun run verify:ai` が exit 1（戻した）。`bun run verify` → exit 0

- [x] T08: markdownlint をパッケージの入口から node で起動し、ファイル名を文字どおりに渡す
  - 種別: 修正
  - 計画: S1
  - 依存: T02（直す対象の検査が要る）
  - 変更: `scripts/check-markdown.mjs`, `scripts/lib/markdown-files.mjs`, `lefthook.yml`
  - red: `tmpglob/review{a,b}.md` に `[x]()` を書いて `git add -N` し `node scripts/check-markdown.mjs` → 33 件ではなく 32 件しか検査せず 0 件で通る。戻す
  - 完了条件: 同じ手順 → MD042 で落ちる。stage したファイルとして渡しても落ちる。`.claude/plans/` のファイルを渡すと検査しない。`bun run verify` → 終了コード 0
  - コミット: `fix(docs): run markdownlint through node and pass file names literally`
  - 結果: red（T02 の check-markdown.mjs）→ `Linting: 32 files`、`Summary: 0 issues`。`--` を付けても `Linting: 0 files` で文字どおりにならず、`:` を頭に付ける形にした。直した後: 全文書で `Linting: 33 files` と `tmpglob/review{a,b}.md:3:1 error MD042`、ファイルを渡す形でも exit 1、plan を渡すと exit 0（検査しない）。lychee は実在するファイル名をそのまま読む（同じ名前で `File not found` を正しく出した）。`bun run verify` → exit 0

- [x] T09: リンクの検査で、checkout のパスの `$` と、`-` で始まるファイル名を正しく扱う
  - 種別: 修正
  - 計画: S2
  - 依存: T03（直す対象の check-links.mjs が要る）
  - 変更: `scripts/check-links.mjs`
  - red: パスに `$` を含む一時的なディレクトリで同じ形の remap を作って lychee を流す → 正しいリンクが別のパス（`$work` が消えた先）で `File not found`。`--review.md` を `git add -N` して `node scripts/check-links.mjs` → lychee が引数の誤りで終了。どちらも戻す
  - 完了条件: 同じ手順 → どちらも通る。`bun run verify` → 終了コード 0
  - コミット: `fix(docs): keep the checkout path literal in the remap and end options before files`
  - 結果: red → `$` 入りのパスで `.../dollar.zcsq/repo/b.md#b` が File not found（`repo$work` が `repo` に化けた）、`--review.md` で lychee が `For more information, try '--help'` で終了。直した後: `$` を `$$` にした remap で通り、`--` の後に一覧を置くと `--review.md` を含めて 0 エラー。`bun run verify` → exit 0

- [x] T11: smol-toml を 1.9.0 の 1 つにそろえ、release の SBOM の検査を通す
  - 種別: 修正
  - 計画: S1
  - 依存: T02（markdownlint-cli2 の依存が要る）
  - 変更: `server/package.json`, `server/bun.lock`
  - red: release.yml と同じ syft 1.52.0 で HEAD の `server` を `git archive` して `node scripts/check-sbom.mjs` → `SBOM lists smol-toml 1.8.0, which is not bundled`
  - 完了条件: 同じ手順を stage した中身で → `SBOM: 102 components, exactly matching the bundled dependencies`。`bun run markdown` → 0 件。`bun run verify` → 終了コード 0
  - コミット: `fix(deps): resolve smol-toml to one version so the SBOM matches what ships`
  - 結果: red → syft 1.52.0 で `SBOM lists smol-toml 1.8.0, which is not bundled`（markdownlint-cli2 0.23.3 が smol-toml を 1.8.0 で完全固定し、bun.lock に入れ子の `markdownlint-cli2/smol-toml` ができた。syft は devDependency を名前で除くので、出荷する依存と同じ名前の入れ子が残る）。`overrides` に `"smol-toml": "1.9.0"` を足した後: 入れ子のエントリが消え、`SBOM: 102 components, exactly matching the bundled dependencies`、node_modules を消して入れ直しても `bun run markdown` → 0 件

- [x] T12: check-pairs で lychee の導入の step そのものを確かめ、lychee.toml のコメントを直す
  - 種別: 修正
  - 計画: S2
  - 依存: T03（直す対象の照合が要る）
  - 変更: `scripts/check-pairs.mjs`, `lychee.toml`
  - red: check.yml の Install lychee の step を消して `# LYCHEE: "0.24.2"` のコメントだけを残し `bun run pairs` → exit 0 で通る。戻す
  - 完了条件: 同じ手順 → `no Install lychee step` で落ちる。release.yml の LYCHEE だけを 0.24.1 にして → 落ちる（戻す）。`bun run verify` → 終了コード 0
  - コミット: `fix(pairs): require the lychee install step, not just its version string`
  - 結果: red → step を消してコメントだけ残しても `bun run pairs` が exit 0。直した後: `.github/workflows/check.yml: no Install lychee step that checks the SHA-256 and puts lychee on PATH`、release.yml の 0.24.1 で `LYCHEE 0.24.1 differs from mise.toml lychee 0.24.2`（どちらも戻した）。verify より後ろに置いた step も落とす。`bun run verify` → exit 0

- [x] T13: lychee の導入の step を行のまとまりとして確かめ、markdownlint の設定を JSONC に留める理由を書く
  - 種別: 修正
  - 計画: S2
  - 依存: T12（直す対象の照合が要る）, T11（理由を書く override が要る）
  - 変更: `scripts/check-pairs.mjs`, `.markdownlint-cli2.jsonc`
  - red: check.yml の `sha256sum -c -` の行をコメントにして `bun run pairs` → exit 0 で通る。戻す
  - 完了条件: 同じ手順 → 落ちる。偽の step を verify の前に置いて本物を後ろへ動かす → 落ちる。本物を verify の後ろへ動かす → 落ちる。正しい step に `id:` を足す → 通る（どれも戻す）。`bun run verify` → 終了コード 0
  - コミット: `fix(pairs): read the lychee install step as a block before verify in the same job`
  - 結果: red → SHA-256 の行をコメントにしても exit 0。直した後: コメント → `the Install lychee step does not check the SHA-256 and put lychee on PATH`、偽の step を前に → 同じく落ちる、後ろへ動かす → `Install lychee is not before bun run verify in the same job`、`id: lychee` を足す → exit 0（どれも戻した）。`bun run verify` → exit 0

- [x] T14: lychee の導入の step が LYCHEE の版をダウンロードすることも確かめる
  - 種別: 修正
  - 計画: S2
  - 依存: T13（直す対象の照合が要る）
  - 変更: `scripts/check-pairs.mjs`
  - red: check.yml の URL の `lychee-v${LYCHEE}` を `lychee-v0.24.1` にして `bun run pairs` → exit 0 で通る。戻す
  - 完了条件: 同じ手順 → 落ちる。`bun run verify` → 終了コード 0
  - コミット: `fix(pairs): require the lychee download to use the pinned version`
  - 結果: red → URL だけ 0.24.1 にしても exit 0（T13 の書き直しで、T12 の正規表現が見ていた URL の確認が抜けていた）。直した後: `the Install lychee step does not download LYCHEE, check its SHA-256, and put it on PATH` で落ちた（戻した）。`bun run verify` → exit 0

## P3: 配る Markdown の検査

展開した tarball の Markdown に両方がかかり、package の外を指す相対リンクが落ちる

- [x] T05: 包含の判定の関数とテストを書く
  - 種別: 追加
  - 計画: S4
  - 依存: なし
  - 変更: `scripts/lib/link-containment.mjs`, `scripts/lib/link-containment.d.mts`, `server/test/link-containment.test.ts`
  - 完了条件: `cd server && node --test --test-timeout=60000 test/link-containment.test.ts` → 成功と失敗の混ざった JSON、package の外の既存ファイル、正常な `../trace/SKILL.md` の各テストが pass
  - コミット: `feat(tarball): find relative links that resolve outside the package`
  - 結果: `cd server && node --test --test-timeout=60000 test/link-containment.test.ts` → 3 件 pass（成功と失敗の混ざった報告で package の外の既存ファイルだけを返し、`../trace/SKILL.md` と自分のアンカーと https は返さない。package の中から外へ向く symlink も外と数える。成功を数えるのに一覧が空の報告は --verbose 無しとして拒む）。`bun run verify` → exit 0
- [x] T06: check-tarball で展開した package に markdownlint と lychee をかけ、包含を確かめる
  - 種別: 追加
  - 計画: S4
  - 依存: T02（markdownlint の設定が要る）, T03（lychee と設定が要る）, T05（包含の判定が要る）
  - 変更: `scripts/check-tarball.mjs`
  - 完了条件: `bun run bundle && (cd plugin && npm pack)` の tarball で `node scripts/check-tarball.mjs <tgz>` → 終了コード 0。package の外の既存ファイルを指す相対リンクを plugin の Markdown に足して同じ手順 → 包含の判定で落ちる（戻す）。`bun run verify` → 終了コード 0
  - コミット: `ci(tarball): lint and link-check the packed Markdown`
  - 結果: `bun run bundle` の後に pack した tarball で `node scripts/check-tarball.mjs` → exit 0（50 ファイル、THIRD_PARTY_NOTICES と README のコピーも検査）。plugin/skills/trace/SKILL.md に `../../../../../../../../../../../../etc/hosts` へのリンクを足して同じ手順 → `packed Markdown links to files outside the package: ... file:///etc/hosts` で exit 1（戻した）。lychee の `--verbose` が除外した URL を stderr に大量に出すので、stderr は失敗したときだけ見せる。`bun run verify` → exit 0

## P4: 文書

- [x] T07: CLAUDE.md の command の節に lychee と Markdown の検査を書く
  - 種別: 変更
  - 計画: S5
  - 依存: T03（書く対象の検査が要る）
  - 変更: `CLAUDE.md`
  - 完了条件: `bun run verify:ai` → 終了コード 0
  - コミット: `docs(claude): mention lychee and the Markdown checks in the commands`
  - 結果: `bun run verify:ai` → exit 0（CLAUDE.md の行を含め、リンクは 0 エラー）

- [x] T10: AGENTS.md の command の行を CLAUDE.md にそろえる
  - 種別: 修正
  - 計画: S5
  - 依存: T07（そろえる先の CLAUDE.md の行が要る）
  - 変更: `AGENTS.md`
  - red: `git show 23ff0b33:AGENTS.md | grep -c lychee` → 0（CLAUDE.md だけ直して AGENTS.md の同じ行が古いまま）
  - 完了条件: `grep -c lychee AGENTS.md` → 2。`bun run verify:ai` → 終了コード 0
  - コミット: `docs(agents): mention lychee and the Markdown checks in the commands`
  - 結果: red → `git show 23ff0b33:AGENTS.md | grep -c lychee` は 0。直した後: `grep -c lychee AGENTS.md` → 2、`bun run verify:ai` → exit 0

## 記録
- 2026-10-05 / T02 / knip が scripts から実行ファイルのパスで呼ぶ markdownlint-cli2 を未使用と判定した。kysely-codegen と同じく server の ignoreDependencies に足し、変更欄に `knip.json` を足した（前: knip.json なし） / そのまま進めた
- 2026-10-05 / T03 / knip が scripts から呼ぶ外部の実行ファイル lychee を未登録と判定した。lefthook と同じくルートの ignoreBinaries に足し、変更欄に `knip.json` を足した（前: knip.json なし） / そのまま進めた
- 2026-10-05 / T03 / mise の aqua の lychee の登録が、0.24.2 が配っていないアセット名（lychee-arm64-macos.dmg）を探して入らなかった（lefthook の links の job で発覚）。mise.toml を `github:lycheeverse/lychee`（version_prefix `lychee-v`）に変え、check-pairs の照合もその書き方を読むように直した / そのまま進めた
- 2026-10-05 / T08 / T02 の Codex のレビュー（a67aee21）: F1 ファイル名が glob として読まれ、`{` などを含む名前が漏れる（再現）、F2 拡張子のない .bin を直接起動して Windows で動かない / 修正タスク T08 を足して直した
- 2026-10-05 / T09 / T03・T08 の Codex のレビュー（4296adde..32dc0443）: F1 checkout のパスの `$` が remap の置換の変数として読まれる（再現）、F2 `-` で始まるファイル名が lychee のオプションとして読まれる（再現）。T08 は指摘なし / 修正タスク T09 を足して直した
- 2026-10-05 / T01 / 取りやめ（[-]）。`git ls-files .claude/plans/2026/10/05-f2-init-project.*` → 0 件: done の検査は、チェックを付けたコミットが `.claude/plans/` の外を変えていることを求め、plan の中だけを変える T01 は通らない。F2 の plan と tasks の削除は `3e413a3c` で済んでいて、plan の S1 を片付けとして直した / tasks を組むときに plan の中だけのタスクを作らない
- 2026-10-05 / T10 / T07 で CLAUDE.md の command の行だけを直し、AGENTS.md の同じ行が古いままだった（rg-pairs の規定に反する） / 修正タスク T10 を足して直した
- 2026-10-05 / 全体 / plan の手順の S1 を外して振り直したので、各タスクの計画欄を 1 つずつ下げた（S2→S1 … S6→S5、中身は同じ）。取りやめた T01 の計画欄は S1 のまま（取りやめなので担わない） / 振り直しは機械的で、完了したタスクの中身は変えていない
- 2026-10-05 / T11 / review-shipping（再現）と全差分の Codex のレビュー（F1、P1）: markdownlint-cli2 の入れ子の smol-toml 1.8.0 で release の SBOM の検査が落ちる / overrides で 1.9.0 にそろえた（出荷する bundle はもともと 1.9.0）。依存を足すのではなく解決のしかたを変える直しなので、Go は取り直していない
- 2026-10-05 / T12 / 全差分の Codex のレビュー（F2、再現）: lychee の照合がバージョンの文字列しか見ず、導入の step を消しても通る。review-shipping: lychee.toml のコメントが「tarball の検査は plugin/ から」と古い / 修正タスク T12 を足して直した
- 2026-10-05 / T13 / T11・T12 の Codex の再レビュー（high）: F1 smol-toml 1.9.0 では markdownlint が TOML の設定の規則のオプションを落とす（再現。いまの設定は JSONC で影響なし）、F2 check-pairs の正規表現が step の境界をまたぎ、コメントにした SHA-256 の行や verify の後ろの本物の step を通す（再現） / T13 を足して直した。F1 は設定ファイルに JSONC に留める理由を書いて塞いだ
- 2026-10-05 / T14 / T13 の Codex の確認のレビュー: F2 URL が LYCHEE の版を使うかの確認が抜けた（再現、T13 の書き直しでの後退）→ T14 で直した。F1 SHA-256 の行を `: # ...` のように行の途中でコメントにするとすり抜ける（再現）→ 見送り: この照合はうっかりした食い違いを止めるもので、わざとの書き換えは PR のレビューで見える。PR 本文の Declined findings に書いた。レビューの往復が収束しないので、ここで区切った
