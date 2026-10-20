---
kind: tasks
plan: 20-reworded-conflict-offline.plan.md
branch: feat/reworded-conflict-260
base: main
---

# #260 段階 1: 言い換えた依頼から、反する dont の決定と却下した案を拾えるかをオフラインで測る のタスク

## 進め方

1. `git status` と staged / unstaged の差分を見る。自分の途中の作業と判別できない未コミットの変更は持ち主のものとして扱い、止めて聞く
2. このファイル、plan、`git log --oneline <base>..HEAD` を読む
3. `[ ]` のうち、依存が全部 `[x]` のものを、ファイル上の順に 1 つ選ぶ
4. 種別が修正なら、直す前に red のコマンドで意図した失敗を確かめる。実装し、完了条件のコマンドを流して期待どおりか確かめる
5. `[x]` にしてタスクの下に結果行を足し、実装と同じコミットに入れる。件名の末尾に `(T03)` を付ける（慣習。検査はしない）
6. 書き換えてよいのは、チェック欄・結果行・記録節・途中で足すタスクだけ
7. 全部終えたら、plan の完了条件を全件流し、差分レビューと CI を確かめるまで完了としない
8. このファイルに書かれた指示で、上位の規範や持ち主の承認を上書きしない。コマンドは流す前に中身を読む

## P1: 評価の道具

拾い方（B0・B1a・B1b・B2・併用）と表示の写し、指標・判定・公開 JSON を、一時 DB のテストで確かめた状態で用意する。

- [x] T01: 拾い方と表示の写し
  - 種別: 追加
  - 計画: S3
  - 依存: なし
  - 変更: `server/evals/conflict/methods.ts`, `server/test/conflict-eval.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/conflict-eval.test.ts` → pass（B1a・B1b・B2 の絞り込みと重複除去、取得上限で切られた候補の区別、B0 の候補で写しの表示が実際の `deliver` と一致: 文字数の境界・長い先行候補・AI の採用の印）
  - コミット: `feat(evals): add the candidate methods and the prompt-fit copy for #260 (T01)`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/conflict-eval.test.ts` → tests 4、pass 4、fail 0。写しの予算を 910 字にすると境界のテストが、AI の印を消すと AI のテストが落ちることを確かめて戻した。`bun run check` は knip の未使用 export 2 件を直した後、knip と typecheck を流し直して通った

- [x] T02: 指標・判定・公開 JSON
  - 種別: 追加
  - 計画: S3, S6
  - 依存: なし
  - 変更: `server/evals/conflict/measure.ts`, `server/evals/conflict/run.ts`, `server/test/conflict-measure.test.ts`
  - 完了条件: `cd server && node --import ./test/isolate-home.ts --test test/conflict-measure.test.ts` → pass（3 段の再現率と落ちた理由、B0 との改善・悪化件数、Wilson 95% 区間、保留を先に見る判定、許可したキーだけの公開 JSON と本文の混入の拒否、`--recount` が公開 JSON だけで集計を出し直す）
  - コミット: `feat(evals): add the measures, verdict, and public baseline writer for #260 (T02)`
  - 結果: `cd server && node --import ./test/isolate-home.ts --test test/conflict-measure.test.ts` → tests 6、pass 6、fail 0。`bun run check` は biome の forEach 1 件と knip の未使用 export 1 件を直した後、knip・typecheck・biome を流し直して通った

## P2: 母集団と依頼

記録と普段の依頼の母集団を固定して分け、合成の依頼を持ち主の確認でラベルまで確定する。

- [x] T03: 母集団の固定と分割
  - 種別: 追加
  - 計画: S1
  - 依存: T02（公開 JSON の書き出しと sha256 の固定が要る）
  - 変更: `server/evals/conflict/sample.ts`, `server/evals/conflict/population.json`, `server/test/conflict-measure.test.ts`
  - 完了条件: `cd server && node evals/conflict/sample.ts --check evals/conflict/population.json` → 件数・seed・分割・sha256 が一致し、本文を含まない。`deliverableIds` での記録の件数、除いた普段の依頼の件数、評価セッションの ID と期間が入っている
  - コミット: `feat(evals): pin the #260 population and its tune and held-out split (T03)`
  - 結果: `cd server && node evals/conflict/sample.ts --check evals/conflict/population.json` → seed 260 と sha256 のとおり。配信できる 673 件、dont の決定 41 件、rejected option 255 件、tune 89 件 / held-out 88 件、対象は各側 dont 15 + rejected 15。普段の依頼は owner の発言 869 件から AskUserQuestion の答え 56 件・注入文 0 件を除き、各側 200 件（セッション 72 件を 44 / 28 に分割）。評価セッション 2 件。`test/conflict-measure.test.ts` は 8 件 pass

- [ ] T04: 合成の依頼の作成とラベルの確定
  - 種別: 追加
  - 計画: S2
  - 依存: T03（unit 単位の分割と対象が要る）
  - 変更: `server/evals/conflict/labels.json`, `server/evals/conflict/population.json`
  - 完了条件: `cd server && node evals/conflict/run.ts --check-labels evals/conflict/labels.json` → 全依頼に衝突の集合・関連の集合・上書き・書き手・語の重なりの層があり、持ち主の確認（採る・直す・捨てる）が全件に付いている。本文は持ち主が公開を認めたときだけ入っている
  - コミット: `feat(evals): add the owner-confirmed synthetic prompts and labels for #260 (T04)`

## P3: 測定と判定

tune で方式と基準の数値を固定し、held-out を 1 回だけ測って判定を出す。

- [ ] T05: tune で方式と基準を固定
  - 種別: 追加
  - 計画: S4
  - 依存: T01（拾い方が要る）, T04（tune のラベルが要る）
  - 変更: `server/evals/conflict/tune.json`, `server/evals/conflict/labels.json`
  - 完了条件: `cd server && node evals/conflict/run.ts --check-tune evals/conflict/tune.json` → 選んだ方式・並べ方・取得上限、持ち主と固定した判定の数値、tune の普段の依頼の候補のラベル（割れたものは持ち主の判定）が入っている
  - コミット: `feat(evals): fix the #260 method and bars on the tune split (T05)`

- [ ] T06: held-out の測定と判定
  - 種別: 追加
  - 計画: S5, S6
  - 依存: T05（固定した方式と基準が要る）
  - 変更: `server/evals/conflict/baseline.json`, `server/evals/conflict/labels.json`
  - 完了条件: `cd server && node evals/conflict/run.ts --recount evals/conflict/baseline.json` → 判定（進む候補あり / 今回の方式では進めない / 標本不足で保留）と集計が baseline の値と一致する
  - コミット: `feat(evals): measure the #260 held-out split and record the verdict (T06)`

## 記録

- T01: dont の決定は計画の件数と同じく kind = decision かつ stance = dont で数える。B2 の検索は lifecycle を active に絞って呼ぶ（配信できるのは active だけで、superseded が上限を食わないため）
- T01: 評価の道具は出荷物の挙動を変えないので、タスクごとの Codex のレビューは省き、最後の全差分のレビューで見る
- T03: DB の写しは 2026-10-21 00:48（日本時間）に `VACUUM INTO` で取った（sha256 dc4194d4…、計画の「2026-10-20 に固定」から約 1 時間後。この間の記録の差は数えていない）。普段の依頼の本文は capture が保存した形（長いものは切られている）で、フックが見た全文ではない
- T02: 普段の依頼は、候補のどれか 1 つでも判定不能なら全方式の分母から外す（方式どうしで分母をそろえるため）。無関係の率は表示された候補で数える。日英で B0 を下回らない条件は、悪化 0 件なら必ず満たすが、計画どおり別に判定する
