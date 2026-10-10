---
kind: tasks
plan: 11-own-words-authority.plan.md
branch: fix/own-words-authority
base: main
---

# 権限の根拠になる言葉を 1 つの検査に通し、引用の中の言葉を本人の言葉として受け付けない のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 引用の判定を作り直し、trace と harvest の保存を通す

新しい記録の採用・項目の定義・見直す条件・置き換えと衝突の根拠が、引用の中だけにある言葉を受け付けなくなる。

- [x] T01: 引用の規則と `ownWords` を作り、新しい記録の採用を通す
  - 種別: 修正
  - 計画: S1, S2, S8
  - 依存: なし
  - 変更: `server/src/own-words.ts`, `server/src/record.ts`, `server/test/own-words.test.ts`, `server/test/own-words-sites.test.ts`, `server/test/export.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - red: `node --import ./test/isolate-home.ts --test test/own-words-sites.test.ts` → 直す前のコードで、引用符の中の一部分と「導入文＋`>` の行」を採用に指定した記録が active になり、テストが失敗する
  - 完了条件: `node --import ./test/isolate-home.ts --test test/own-words.test.ts test/own-words-sites.test.ts test/record.test.ts` → 通る。`rg -n "quotedSpan|inlineQuoted" server/src` → 0 件
  - コミット: `fix(record): judge quoted spans from the whole message before words adopt`
  - 結果: red: `node --import ./test/isolate-home.ts --test test/own-words-sites.test.ts` → 直す前のコードで 0 pass, 2 fail。引用符の中の一部分・引用符ごと・「導入文＋`>` の行」を採用に指定した 3 件が active（期待は candidate）、前後の行に引用符がある本人の行が candidate（期待は active）
  - 結果: `node --import ./test/isolate-home.ts --test test/own-words.test.ts test/own-words-sites.test.ts test/record.test.ts` → 76 pass, 0 fail
  - 結果: `rg -n "quotedSpan|inlineQuoted" server/src` → 0 件

- [x] T02: 項目の定義・見直す条件・置き換えと衝突の根拠を `ownWords` に通す
  - 種別: 修正
  - 計画: S2
  - 依存: T01（`ownWords` と policy を T01 が作る）
  - 変更: `server/src/record.ts`, `server/test/own-words-sites.test.ts`, `server/src/own-words.ts`, `server/test/extract.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/own-words-sites.test.ts` → 直す前のコードで、引用の中の文による項目の定義と見直す条件が保存され、実在しない quote で trusted を通った衝突が計画に残り、テストが失敗する
  - 完了条件: `node --import ./test/isolate-home.ts --test test/own-words-sites.test.ts test/record.test.ts` → 通る
  - コミット: `fix(record): take field definitions, reconsider conditions, and link grounds from own words`
  - 結果: red: `node --import ./test/isolate-home.ts --test test/own-words-sites.test.ts` → 直す前のコードで 2 pass, 2 fail。「」の中の文による項目の定義に errors が出ない（空）、メンテナーが `>` で引用しただけの文を根拠にした harvest の `supersedes` に errors が出ない（空）
  - 結果: `node --import ./test/isolate-home.ts --test test/own-words-sites.test.ts test/record.test.ts test/own-words.test.ts` → 78 pass, 0 fail（見直す条件の引用、実在しない quote による trusted も拒まれる）

## P2: glean の操作を通す

glean の 7 つの操作が、引用の中だけにある言葉を理由や採用に受け付けなくなり、確かめた位置がそのまま保存される。

- [ ] T03: glean の 7 つの操作を `ownWords` に通し、保存が確かめ済みの span を使う
  - 種別: 修正
  - 計画: S3
  - 依存: T01（`ownWords` と `OwnWords` の型を T01 が作る）
  - 変更: `server/src/glean.ts`, `server/src/own-words.ts`, `server/test/own-words-sites.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/own-words-sites.test.ts` → 直す前のコードで、引用の中の文を指定した adopt・replace_anchor・retire_anchor・retract_evidence・retract_adoption・withdraw・resolve_conflict が保存され、テストが失敗する
  - 完了条件: `node --import ./test/isolate-home.ts --test test/own-words-sites.test.ts test/extract.test.ts test/reconcile.test.ts` → 通る。`rg -n "spanOf" server/src` → 0 件。`rg -n "MAINTAINERS = " server/src` → `server/src/own-words.ts` の 1 件
  - コミット: `fix(glean): refuse quoted words as the reason or adoption of an operation`

## P3: 隔離された記録の衝突を配信に効かせない

引用が見つからない記録や出典の無い記録が持つ衝突のリンクで、正常な記録の自動配信が止まらなくなる。

- [ ] T04: 配信の衝突の検索と read の説明で、隔離された記録のリンクを効かせない
  - 種別: 修正
  - 計画: S4
  - 依存: なし
  - 変更: `server/src/deliver.ts`, `server/src/read.ts`, `server/test/deliver.test.ts`, `server/test/read.test.ts`
  - red: `node --import ./test/isolate-home.ts --test test/deliver.test.ts` → 直す前のコードで、隔離された記録から衝突のリンクを張られた正常な記録が配信の対象から外れ、テストが失敗する
  - 完了条件: `node --import ./test/isolate-home.ts --test test/deliver.test.ts test/read.test.ts` → 通る
  - コミット: `fix(deliver): let a conflict from a quarantined record hold nothing back`

## P4: 既存の行の監査と、付け忘れを止める検査

持ち主が、既に DB にある行のうち新しい規則に通らないものを、DB を変えずに一覧で見られる。権限の表へ書く箇所が限定される。

- [ ] T05: `sphica doctor --audit-quotes` を足す
  - 種別: 追加
  - 計画: S5
  - 依存: T03（監査が使う規則と、確かめる対象の一覧が T01〜T03 で決まる）
  - 変更: `server/src/audit-quotes.ts`, `server/src/cli.ts`, `server/test/audit-quotes.test.ts`, `server/test/cli.test.ts`, `README.md`, `README.ja.md`
  - 完了条件: `node --import ./test/isolate-home.ts --test test/audit-quotes.test.ts test/cli.test.ts` → 通る（監査の前後で DB の全行の内容が同じ、列挙と件数が一致、`--reindex` との同時指定は拒まれる）
  - コミット: `feat(doctor): list authority rows that rest on quoted words, without changing them`

- [ ] T06: 権限の表へ書く箇所と `OwnWords` を作る箇所を architecture の検査に足す
  - 種別: 追加
  - 計画: S6
  - 依存: T02（record 側の書き込みが `OwnWords` を通っている）, T03（glean 側の書き込みが `OwnWords` を通っている）
  - 変更: `scripts/check-architecture.mjs`, `server/test/architecture.test.ts`
  - 完了条件: `bun run architecture` → 通る。`node --import ./test/isolate-home.ts --test test/architecture.test.ts` → 通る（`OwnWords` を通さない書き込みを置いた入力で検査が落ちる）
  - コミット: `test(architecture): limit where authority rows are written and own words are made`

## P5: 文面を直してリリースする

Skill と保証の説明が、機械が確かめる範囲（引用の位置）と確かめない範囲（採用の意味）を分けて書く。npm に出る。

- [ ] T07: glean・harvest・trace の Skill と ASSURANCE.md の文面を直す
  - 種別: 変更
  - 計画: S7, S9
  - 依存: T03（文面が書く拒み方が T01〜T03 で決まる）, T04（衝突の扱いの説明が T04 で決まる）
  - 変更: `plugin/skills/glean/SKILL.md`, `plugin/skills/harvest/SKILL.md`, `plugin/skills/trace/SKILL.md`, `ASSURANCE.md`
  - 完了条件: `bun run verify:ai` → 通る。`bun run pairs` → 通る
  - コミット: `docs(skills): say which quotes carry authority and what the check does not judge`

- [-] T08: npm と 3 つの plugin manifest のバージョンを上げる
  - 種別: 変更
  - 計画: S8, S9
  - 依存: T07（パッケージに入る変更が全部そろってから番号を決める）
  - 変更: `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `bun run release:plan -- --base <前のリリースのタグ>` → `plugin` で、4 つが同じバージョン。`bun run verify` → 通る
  - コミット: `chore(release): bump to the next version`

## 記録

- 2026-10-11 / T01 / `server/test/export.test.ts` の「a quote spanning lines keeps its line breaks inside the fence」が落ちた。閉じていないフェンスにかかる発言の全体を採用に指定していて、新しい規則（ブロックの引用に 1 行でも触れたら拒む）で候補に残るため / テストの採用を、フェンスの前の本人の行（`Use:`）に変えた。根拠は全体のままで、テストが見ている出力の形は変わらない。変更欄に `server/test/export.test.ts` を足した（前の値: 4 ファイル、新しい値: 5 ファイル）
- 2026-10-11 / T01, T07, T08 / コミット前の検査（`check-mcp-version`）が、`server/src` を変えるコミットにはバージョンの引き上げが入っていることを求め、T01 のコミットを止めた（「Bump the npm package and the 3 plugin channel manifests to the same new version」）。バージョンを最後に上げる並びは、このリポジトリでは成り立たない / バージョンの引き上げ（0.6.47 → 0.6.48）を T01 のコミットへ移した。T01 の計画: 前の値 `S1, S2`、新しい値 `S1, S2, S8`。T01 の変更欄に 4 つのバージョンのファイルを足した。T07 の計画: 前の値 `S7`、新しい値 `S7, S9`（リリースは最後のタスクの後）。T08 は取りやめ（やることが T01 と T07 に移った）
- 2026-10-11 / T02 / コミットの件名が、末尾の `(T02)` を足すと 102 文字になり、件名の上限（100 文字）を超える / T02 のコミット欄: 前の値 `…and link grounds only from own words`、新しい値 `…and link grounds from own words`。あわせて、`server/src/own-words.ts` の `MAINTAINERS` を外へ公開しない形にした（record.ts が使わなくなり、knip が未使用の公開として止めたため）。T02 の変更欄に `server/src/own-words.ts` を足した（前の値: 2 ファイル、新しい値: 3 ファイル）
- 2026-10-11 / T02 / `server/test/extract.test.ts` の「glean: withdrawing the successor brings back the record it replaced…」が落ちた。発言に無い言葉だけを根拠にした後継（`supersedes` 付き）を保存して隔離を確かめていたが、置き換えの根拠が実在する言葉だけを数えるようになり、保存の前に拒まれるため / テストの 2 つの記録を「根拠は実在し、採用の引用だけが見つからない」形に変えた（隔離されることと、枠を取らないことは今までどおり確かめられる）。拒むときのメッセージに「発言の中にあり、引用だけではない言葉」と足した。T02 の変更欄に `server/test/extract.test.ts` を足した（前の値: 3 ファイル、新しい値: 4 ファイル）
