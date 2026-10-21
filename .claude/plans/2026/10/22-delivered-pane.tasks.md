---
kind: tasks
plan: 22-delivered-pane.plan.md
branch: feat/delivered-pane
base: main
---

# Sphica が渡した記録を並べる読み取り専用の Claude Code mod を、任意のプラグイン `sphica-pane` として出す（#370）のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: ペインの mod

`pane/` が手元の `claude --plugin-dir pane` で動き、拾う関数が実際の配信文で検査される

- [x] T01: `pane/` の骨組み（マニフェスト、types、README、LICENSE）と `sift.ts`（拾う関数と描画の割り付け）を足し、実際の deliver の出力で検査する
  - 種別: 追加
  - 計画: S2
  - 依存: なし
  - 変更: `pane/.claude-plugin/plugin.json`, `pane/package.json`, `pane/types/index.d.ts`, `pane/hooks/sift.ts`, `pane/README.md`, `pane/LICENSE`, `server/test/pane-sift.test.ts`, `scripts/check-english.mjs`, `scripts/oxlint.mjs`, `scripts/oxfmt.mjs`
  - 完了条件: `cd server && node --test test/pane-sift.test.ts` → pass（SessionStart・読む前・編集の前・プロンプト・SubagentStart・unavailable・#218 の deny の実際の出力を全部拾い、他のプラグインの文面と空を拾わない。`layout` が 8,000 文字と 1 件 1,500 文字に収め、省略の件数を返す）。`bun run typecheck`・`bun run lint`・`bun run english`・`bun run headers`・`bun run comments` → 0 で終わる
  - コミット: `feat(pane): add the sphica-pane plugin skeleton and the sift of Sphica's hook text (T01)`
  - 結果: `cd server && node --test test/pane-sift.test.ts` → 2 件 pass（SessionStart・SubagentStart・編集の前・読む前・プロンプト・#218 の停止・unavailable の実際の出力を 1 件ずつ拾い、停止は stop として拾った。他のプラグインの文面・空・undefined は拾わなかった。layout の上限ちょうどと 1 文字超えを確かめた）
  - 結果: `bun run check` → 0 で終わった（typecheck・lint・english・headers・comments を含む）
- [x] T02: `register.tsx`（5 つの classic hook、`/sphica-pane`、ペインの描画）と `register.test.tsx` を足す
  - 種別: 追加
  - 計画: S3
  - 依存: T01（`sift` と `layout`、state の型が要る）
  - 変更: `pane/hooks/hooks.json`, `pane/hooks/register.tsx`, `pane/hooks/register.test.tsx`, `pane/hooks/sift.ts`, `pane/types/index.d.ts`
  - 完了条件: `claude plugin validate --strict pane` → 0 で終わる。`claude plugin test pane` → pass（5 つのイベントで、返り値が下流の結果と同じ、下流は 1 回、入力は変わらない、state の中身、同時の 2 配信が両方残る、`keep` が失敗しても結果を返す）
  - コミット: `feat(pane): register the classic hooks and draw the delivered pane (T02)`
  - 結果: `claude plugin validate --strict pane` → （2.1.306）Validation passed。hooks は 5 つの classic・session.start・command.run・ui.render、calls は $.command.register・$.state.get・$.state.set・$.ui.open・$.ui.resolve、5 つの classic すべて with .catch
  - 結果: `claude plugin test pane` → 4 件 pass（4 つの classic で返り値が下流と同じ・下流 1 回・入力の source が残る、PreToolUse の context と stop、updatedInput が下の tool.call に届き deny は呼び出しを止める、同時の 2 件が両方残り 122 件のうち新しい 100 件、/sphica-pane と新しい順の描画）。hook の返り値を書き換える壊し方では 1 件目が落ちた
  - 結果: エンジンの型（2.1.306 の claude-code.d.ts）を置いた scratch の写しで `tsc -p` → 0 で終わった。`bun run lint`・`bun run typecheck`・`bun run english`・`bun run headers`・`node --test test/pane-sift.test.ts` → 0 で終わった

- [x] T07: 1 件の上限に省略記号を含め、RAN・AUTO_TRACE 付きの SessionStart・review の実際の出力も sift のテストに足す（T01 のレビューの F1・F2）
  - 種別: 修正
  - 計画: S2
  - 依存: T01（直す sift.ts とテストが要る）
  - 変更: `pane/hooks/sift.ts`, `server/test/pane-sift.test.ts`
  - red: `node --input-type=module -e 'import("./pane/hooks/sift.ts").then(({layout}) => console.log(layout([{at:"t",event:"e",kind:"context",text:"x".repeat(1501)}]).shown[0].text.length))'` → 1501（上限の 1500 を超える）
  - 完了条件: `cd server && node --test test/pane-sift.test.ts` → pass（RAN、AUTO_TRACE の行が付いた SessionStart、review の「no local change」と「past decisions that apply to this change」も、空でない実際の出力を 1 件ずつ拾う。各行が 1500 文字以内）
  - コミット: `fix(pane): keep a cut row within its limit and test every text deliver writes (T07)`
  - 結果: `node --input-type=module -e ...` → 直す前は 1501（red と同じコマンド）
  - 結果: `cd server && node --test test/pane-sift.test.ts` → 2 件 pass。RAN（dead end 6 件で止めた後の再実行）、AUTO_TRACE の付いた SessionStart（CLAUDE_CODE_ENTRYPOINT=cli）、review の no local change と past decisions を含む 11 種の出力を 1 件ずつ拾い、各行が 1500 文字以内。拾う条件を `Sphica` で始まるものだけに狭めると edit の出力で落ちた

## P2: CI で配る実物を検査する

固定した Claude Code CLI で、Linux と Windows の CI が `pane/` を validate と test にかけ、許可した hook と呼び出しの外に出たら落ちる

- [x] T03: claude CLI の版を選んで固定し、入れ方を実測で決め、CI の Linux と Windows のジョブで `pane/` の validate と test を流す
  - 種別: 追加
  - 計画: S1
  - 依存: T02（CI で流す mod とテストが要る）
  - 変更: `tools/claude-cli/package.json`, `tools/claude-cli/bunfig.toml`, `tools/claude-cli/bun.lock`, `scripts/claude-cli.mjs`, `.github/workflows/check.yml`
  - 完了条件: `node scripts/claude-cli.mjs --version` → npm の公開時刻から 604800 秒以上たった版。同じ launcher の `plugin validate --strict pane` と `plugin test pane` が手元で通り、check.yml の Linux の static と Windows のジョブに同じ 3 つの手順がある（actionlint が通る）。CI での実行は PR の CI（plan の A2）で確かめ、Windows で通らなければそこで止めて持ち主に戻す
  - コミット: `ci: pin the Claude Code CLI and validate and test the pane mod on Linux and Windows (T03)`
  - 結果: `node scripts/claude-cli.mjs --version` → 2.1.300（npm の公開 2026-10-14T14:27:26Z、確かめた時刻 2026-10-21T17:15Z で 7 日を超えた最新。2.1.301 は 6 日）
  - 結果: `node scripts/claude-cli.mjs plugin validate --strict pane` → Validation passed。`node scripts/claude-cli.mjs plugin test pane` → 4 件 pass。`actionlint .github/workflows/check.yml` → 0 で終わった。`bun run check` → 0 で終わった
- [x] T04: `scripts/check-pane.mjs` を足す（`git archive` で取り出した `pane/` に validate --strict --json と plugin test を流し、hook・calls・state を許可リストと突き合わせる）。`bun run pane:check` を check・ci:static・Windows のジョブに入れる
  - 種別: 追加
  - 計画: S4
  - 依存: T03（固定した CLI の版と入れ方が要る）
  - 変更: `scripts/check-pane.mjs`, `scripts/lib/pane-report.mjs`, `scripts/lib/pane-report.d.mts`, `server/test/pane-report.test.ts`, `scripts/claude-cli.mjs`, `package.json`, `.github/workflows/check.yml`
  - 完了条件: `bun run pane:check` → 0 で終わる。`register.tsx` に許可していない `$.fs.read` を一時的に足して `bun run pane:check` → calls の違いを名指しして 1 で終わる（戻してからコミット）
  - コミット: `chore(scripts): check the archived pane mod against its allowed hooks and calls (T04)`
  - 結果: `bun run pane:check` → 0 で終わった（git が追跡する pane/ のファイルを一時ディレクトリに写し、2.1.300 の validate --strict --json と plugin test を流し、hooks・calls・state が許可リストと一致）
  - 結果: `bun run pane:check` → register.tsx に `$.fs.read` を一時的に足すと「calls: not allowed $.fs.read」と test の失敗を名指しして 1 で終わった（戻してある）
  - 結果: `cd server && node --test test/pane-report.test.ts` → 2 件 pass（書式の変わった注記は「validate reported none」で落ちる）。`bun run check` → 0 で終わった

- [x] T08: register.tsx 以外のモジュールの注記も失敗にし、コピー中に失敗しても一時ディレクトリを消す（T04 のレビューの F1・F2）
  - 種別: 修正
  - 計画: S4
  - 依存: T04（直す check-pane.mjs と pane-report.mjs が要る）
  - 変更: `scripts/lib/pane-report.mjs`, `scripts/lib/pane-report.d.mts`, `scripts/check-pane.mjs`, `server/test/pane-report.test.ts`
  - red: `cd server && node --test --test-name-pattern="any module" test/pane-report.test.ts` → `./extra.tsx calls: $.fs.read` を含む注記で differences が空を返して落ちる
  - 完了条件: `cd server && node --test test/pane-report.test.ts` → 3 件 pass。追跡ファイルを作業ツリーから一時的に消して `node scripts/check-pane.mjs` → 1 で終わり、一時ディレクトリが増えない
  - コミット: `fix(scripts): fail the pane check on any other module and clean up after a failed copy (T08)`
  - 結果: `cd server && node --test --test-name-pattern="any module" test/pane-report.test.ts` → 直す前は actual: [] で落ちた
  - 結果: `node scripts/check-pane.mjs` → pane/LICENSE を一時的に動かすと、直す前は一時ディレクトリが 0 から 1 に増え、直した後は 1 のまま（1 で終わった）。戻して流すと 0 で終わった
  - 結果: `cd server && node --test test/pane-report.test.ts` → 3 件 pass。`bun run typecheck` → 0 で終わった

## P3: リリースに載せる

`pane/` の変更がリリースの判定・バージョンの検査・タグのゲート・到着の確認に掛かり、マーケットプレイスから入れられる

- [x] T05: release-scope・check-mcp-version・release-plan・release-gate・release-status に pane のマニフェストと marketplace の ref を足し、version-sync の文書と plugin-release の Skill を直す
  - 種別: 変更
  - 計画: S5
  - 依存: T01（pane のマニフェストが要る）
  - 変更: `scripts/lib/release-scope.mjs`, `scripts/lib/release-scope.d.mts`, `scripts/check-mcp-version.mjs`, `scripts/release-plan.mjs`, `scripts/release-gate.mjs`, `scripts/release-status.mjs`, `CLAUDE.md`, `AGENTS.md`, `.claude/rules/verification.md`, `.agents/skills/plugin-release/SKILL.md`, `lefthook.yml`, `server/test/release-scope.test.ts`, `server/test/check-mcp-version.test.ts`, `server/test/release-plan.test.ts`, `.claude-plugin/marketplace.json`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `pane/.claude-plugin/plugin.json`
  - 完了条件: `node -e 'import("./scripts/lib/release-scope.mjs").then(m => console.log(m.releaseKind(["pane/hooks/register.tsx"])))'` → `plugin`。`cd server && node --test test/release-scope.test.ts test/check-mcp-version.test.ts test/release-plan.test.ts test/release-gate.test.ts` → pass（pane のマニフェストか marketplace の ref だけが取り残されると落ちる）。`bun run release:plan -- --base v0.6.65` → `plugin`。`bun run verify:ai` と `bun run check` → 0 で終わる
  - コミット: `chore(release): treat the pane plugin as a package input and gate its version and ref (T05)`
  - 結果: `node -e '...releaseKind(["pane/hooks/register.tsx"])...'` → plugin
  - 結果: `cd server && node --test test/release-scope.test.ts test/check-mcp-version.test.ts test/release-plan.test.ts test/release-gate.test.ts test/release-gate-cli.test.ts test/release-finish.test.ts` → 55 件 pass（pane のマニフェストが 1.0.0 のまま、または marketplace の ref が v1.0.0 のままのとき、どちらも名指しで落ちる）
  - 結果: `bun run release:plan -- --base v0.6.65` → release kind: plugin（版を上げる前に流した）。`bun run verify:ai` → 0 で終わった
- [ ] T06: `check-pane.mjs` に marketplace のエントリの照合を足し、README に入れ方・確かめた版・Codex には入れないこと・外し方を書き、plugin-release の Skill に出荷後の確認を足す
  - 種別: 追加
  - 計画: S6
  - 依存: T04（エントリの照合を足す先の検査が要る）, T05（エントリとバージョンが要る）
  - 変更: `scripts/check-pane.mjs`, `README.md`, `.agents/skills/plugin-release/SKILL.md`
  - 完了条件: `bun run pane:check` → エントリの照合を含めて 0 で終わる。`path` を `panes` に書き換えて `bun run pane:check` → path の違いを名指しして 1 で終わる（戻してからコミット）。`bun run verify` → 0 で終わる
  - コミット: `feat(pane): list sphica-pane in the marketplace and document it (T06)`

## 記録

- 2026-10-22 / T01 / 変更欄に足りないファイルがあった（pane/ を lint と format の対象に入れる oxlint.mjs・oxfmt.mjs、node が pane の .ts を ES module として読むための pane/package.json） / 変更欄に足した。前の値は 8 ファイル、新しい値は 11 ファイル。その後 `server/tsconfig.json` を外した（パッケージの入力で、変えるとバージョンを上げることになる。テストが sift.ts を import するので tsc はそれだけで検査する）。最終は 10 ファイル
- 2026-10-22 / T02 / types の契約は自己完結でなければ validate が落とす（import 禁止）ため、Delivered の型を types/index.d.ts に置き、sift.ts がそこから import する形に直した / 変更欄に sift.ts と types/index.d.ts を足した（前の値は 3 ファイル、新しい値は 5 ファイル）
- 2026-10-22 / T02 / keep が失敗したときに結果をそのまま返すことはテストで確かめられなかった。テストキットは下流の結果の形を先に検査し、state.set の stub は mod の書き込みに届かない。テストを書くと常に通るので外した / 実装は try 相当の .catch(() => {}) と、hook の .catch（Caught の replay で下流を再実行しない）で守る。未検証として PR 本文に書く
- 2026-10-22 / T02 / Registration の .catch の引数名 next が oxlint の promise(no-callback-in-promise) に Promise の catch と誤って当たった / 引数名を replay にした
- 2026-10-22 / T07 / T01 の Codex レビュー（b87808f7）の F1（省略記号で 1 件が 1501 文字になる、再現済み）と F2（RAN・AUTO_TRACE・review の出力がテストに無い）を受理 / 修正タスク T07 を足した
- 2026-10-22 / T03 / CLI の入れ方を実測で決めた。server の devDependency はパッケージの入力でバージョンを上げることになり、mise の npm バックエンドはこのリポジトリで持ち主の `claude` を固定版の shim で隠す。`tools/sandbox` と同じく `tools/claude-cli` に独自の package.json と 7 日の bunfig を置き、`--ignore-scripts` で入れてプラットフォームのパッケージの本体を直接起動する形にした。版は package.json の 1 か所 / 変更欄を `scripts/lib/claude-cli.mjs`・check.yml・package.json から tools/claude-cli の 3 ファイル・scripts/claude-cli.mjs・check.yml に変えた
- 2026-10-22 / T03 / check.yml は main 向けの PR でしか走らず、途中で PR を作ると GitHub の Codex が作りかけをレビューする / 完了条件の CI の観測を PR の CI（A2）に移した。前の値は「gh run view で Linux と Windows のジョブが通っている」、新しい値は「手元で通り、check.yml に手順がある。CI は A2」
- 2026-10-22 / T03 / 2.1.300 の validate は「組織が管理する Claude Code では、利用者が入れたプラグインの classic hook は動かない」と注記した / README（T06）に書く
- 2026-10-22 / T04 / plan は `git archive HEAD pane` と書いていたが、手元の check がコミット前の変更を見ないので、`git ls-files` で追跡しているファイルを作業ツリーから写す形にした（配る対象はタグの時点の追跡ファイルで、CI では HEAD と同じ） / 許可リストと注記の読み取りは単体テストのため scripts/lib/pane-report.mjs に分け、変更欄に足した（前の値は 3 ファイル、新しい値は 5 ファイル）。テストが「gating hook without .catch」の取りこぼしを見つけて直した
- 2026-10-22 / T04 / CI の Linux では `bun run check` が pane:check を流すので、T03 で足した個別の validate と test の手順を CLI の --version だけにし、CLI は `bun run setup` で入れる形にした / Windows のジョブは `bun run pane:check` を流す
- 2026-10-22 / T02・T07 / Codex のレビュー（167446c9、bdacdbb0） → 指摘なし。keep の失敗・.catch の発火・時間切れは実機で未検証と返った（T02 の記録と同じ）
- 2026-10-22 / T03 / Codex のレビュー（3985515a） → 指摘なし。CLI が ~/.claude を読まないことは未実測と返った / T04 で launcher の HOME と USERPROFILE も一時ディレクトリに向け、変更欄に scripts/claude-cli.mjs と型宣言の pane-report.d.mts を足した（前の値は 5 ファイル、新しい値は 7 ファイル）
- 2026-10-22 / T05・T06 / pane/ をパッケージの入力にすると、T01〜T04 の pane の変更にもバージョンアップが要り、T05 のコミットを pre-commit が止める。marketplace の ref を読む検査はエントリが無いと落ちる / バージョンアップとエントリを T06 から T05 に移した。T05 の変更欄は 11 から 19 ファイル（版の 5 ファイル、release-scope の型、lefthook.yml、テスト 2 本を足し、symlink の .claude/skills 側を外した）、完了条件に版の検査のテストと release:plan を足した。T06 の変更欄は check-pane.mjs・README.md・plugin-release の Skill に、完了条件は ref から path の書き換えに変えた
- 2026-10-22 / T05 / 版を読む場所が 4 本のスクリプトに別々に書かれていた / scripts/lib/release-scope.mjs の VERSION_SOURCES 1 か所にまとめ、check-mcp-version・release-plan・release-gate・release-status がそこから読む形にした（rg-pairs の対を型の代わりに 1 か所にした）。git-subdir の ref は withoutReleaseVersion で版と一緒に外す
- 2026-10-22 / T05 / pre-commit の bundle の glob（パッケージの入力）と oxlint・oxfmt の glob に pane/ が無かった。release-scope のテストが bundle の glob の抜けを落とした / lefthook.yml に足した
- 2026-10-22 / T04 / Codex のレビュー（731a2474）の F1（register.tsx 以外のモジュールの注記を読み飛ばす、再現済み）と F2（コピー中の失敗で一時ディレクトリが残る、再現済み）を受理 / 修正タスク T08 を足す
- 2026-10-22 / T05 / review-shipping → コミットを止める指摘なし。tarball は 0.6.65 と版以外同じ、既存利用者の更新は Claude Code 2.1.139・2.1.306・Codex 0.163.0 で通った。指摘: 2.1.139 では sphica-pane が読み込みに失敗する（受理、T06 の README に最低版を書く）、Codex に sphica-pane を入れると毎セッション hooks.json の modules で警告が出る（plan のリスクどおり PR の段階で持ち主に聞く）、release の prepare が CLI も取得する（棄却: 取得元は他の依存と同じ npm で、OSV の扱いは tools/sandbox と同じ）
