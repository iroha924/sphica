---
kind: tasks
plan: 23-import-history.plan.md
branch: feat/import-history
base: main
---

# 導入より前のホストの会話記録を、ライブの capture と同じ経路で取り込めるようにする（#215） のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 読み取り

transcript 1 本から、ライブの capture と同じ形の記録を作れるようになる

- [x] T01: Claude Code と Codex の transcript から spool の記録を作る純粋な関数
  - 種別: 追加
  - 計画: S2
  - 依存: なし
  - 変更: `server/src/history.ts`, `server/src/capture.ts`, `server/test/history.test.ts`, `plugin/package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `.claude-plugin/marketplace.json`
  - 完了条件: `cd server && node --test test/history.test.ts` → 持ち主の発言、通知と peer の除外、AskUserQuestion、編集、サブエージェントと exec の除外の各ケースが pass
  - コミット: `feat(history): read past Claude Code and Codex sessions into capture records (T01)`
  - 結果: `node --test test/history.test.ts` → 7 pass。`bun run verify` → exit 0（受け入れ 151/151）

- [x] T02: 持ち主の手元での突き合わせ（ライブの記録と、取り込み直した記録）
  - 種別: 追加
  - 計画: S1, S4
  - 依存: T01（読み取りの関数が要る）
  - 変更: `server/evals/history/compare.ts`, `knip.json`
  - 完了条件: `node server/evals/history/compare.ts --db <持ち主の DB の写し>` → Claude Code と Codex それぞれ、ライブで記録済みのセッションの持ち主の発言の一致数とずれの理由ごとの件数が出て、理由のないずれが 0。Codex で理由のないずれが残れば、記録節に書いて Codex を外す
  - コミット: `test(history): compare imported sessions with the live capture (T02)`
  - 結果: 持ち主の DB の写し（2026-11-23）で `node server/evals/history/compare.ts --db <写し>` → Codex は 4 セッションで持ち主の発言 4/4・返答 4/4 が id と本文まで一致。Claude Code は 2 セッションで持ち主の発言 41 件一致、ライブだけ 24 件（ホストの system-reminder のイベント 19、通知 1、human の origin の無い行 4。理由のないものは 0）、取り込みだけ 4 件（ライブに記録が無い。うち 1 件は写しの後に打った発言）。返答は 128 件一致、取り込みだけ 4 件。プロンプトのブロックを空行でつないでいたのをライブと同じ改行 1 つに直して 2 件のずれが消えた

## P2: 実行

`sphica init --history` で取り込め、2 回目は何も増えない

- [x] T03: `init --history` の配線、既にあるセッションの飛ばし、spool への積み込みと送信、出力
  - 種別: 追加
  - 計画: S3
  - 依存: T01（読み取りの関数が要る）
  - 変更: `server/src/cli.ts`, `server/src/history.ts`, `server/src/capture.ts`, `server/test/history-live.test.ts`, `scripts/lib/bundle-budget.mjs`
  - 完了条件: `cd server && node --test test/history-live.test.ts` → 一時 HOME で `sphica init --history` を 2 回流し、1 回目で入り、2 回目は 0 件増。`--history` 無しの init は件数の 1 行だけを出す
  - コミット: `feat(cli): import past sessions with sphica init --history (cli.js 647.3 KB) (T03)`
  - 結果: `node --test test/history-live.test.ts` → 2 pass（両ホストのログの発見と記録済みの除外、init --history の 2 回目が 0 件増）。持ち主の DB の写しと実物のログで `SPHICA_HOME=<一時> node server/src/cli.ts init --history` → 12 秒、取り込み 0、記録済み 6、codex exec 635 を除外、セッション数 933 のまま。`bun run verify` → exit 0（受け入れ 151/151）。cli.js が 647,250 バイトになり予算を 636,000 から 652,000 に上げた

## P3: 文書とリリース

README と Skill が新しい旗と、ホストごとの違いを説明する

- [x] T04: README（英日）、plugin-release / knowledge-schema の Skill、受け入れケース、バージョン
  - 種別: 追加
  - 計画: S5, S6
  - 依存: T03（旗の名前と出力が決まっている必要がある）
  - 変更: `README.md`, `README.ja.md`, `.agents/skills/knowledge-schema/SKILL.md`
  - 完了条件: `caffeinate -i mise exec -- bun run verify` → exit 0、`bun run release:plan -- --base v0.6.72` → `release kind: plugin`、版が 0.6.73 でそろう
  - コミット: `docs(history): describe sphica init --history (T04)`
  - 結果: `bun run verify` → exit 0（受け入れ 151/151）。`bun run release:plan -- --base v0.6.72` → `release kind: plugin`、npm・plugin・marketplace・Codex がすべて 0.6.73

## 記録

- 2026-11-24 / T02 / T02 の結果行の「理由のないもの 0」は誤り。突き合わせはツール結果の行も「human の origin の無い行」と数え、どのずれにも理由が付いていた。その陰で作業中の発言（queued_command）を取り込みが落としていた / 突き合わせを readLogs を使い、ライブの id を生む行を突き止めて理由を付ける形に作り直した。結果は PR 本文に書く。完了したタスクの欄は変えない
- 2026-11-24 / T01, T03 / /sphica:review full の round 1 の指摘を 1 つのコミットで直した（plan の変更履歴の 3 行）。受け入れケースは足さない（driver はフックを再生し CLI の init を通らない。init --history の挙動は history-live のテストが持つ）

- 2026-11-23 / T04 / 受け入れケースは hook を再生する driver の上にあり、CLI の init は通らない。init --history の挙動は子プロセスのテスト（T03）が持つ / 変更欄から `server/evals/acceptance/cases.json` を外した。plugin-release の Skill は CLI の 3 コマンドの記述のままで正しいので外した

- 2026-11-23 / T03 / `--history` 無しの init で件数を数えるには全ログを読む（実測 12 秒）ので、新しく登録したときだけ `--history` を案内する 1 行にした（plan の「件数の 1 行」から変更） / 完了条件の欄はそのまま、出力の文面だけ変えた

- 2026-11-23 / T01, T04 / pre-commit は package の入力を変える最初のコミットで版の上げを求める / 0.6.73 への上げを T04 から T01 に移した（T01 の変更欄に版の 4 ファイルを足し、T04 から外した）

- 2026-11-23 / T01 / フィクスチャはファイルにせずテストの中に書いた。zstd はファイルを読む側（T03）のテストに移す / 変更欄から `server/test/fixtures/history/` を外し、ライブと同じ式で id を作るため `capture.ts` の `messageOf` を足した
- 2026-11-23 / T02 / 突き合わせで、ライブの capture が Claude デスクトップアプリの差し込むイベント（`<system-reminder>` に包まれた side-sessions・CI monitor のイベント）を持ち主の発言として記録していると分かった（19 件）。この計画の範囲外として持ち主に報告する
