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

- [x] T04: 合成の依頼の作成とラベルの確定
  - 種別: 追加
  - 計画: S2
  - 依存: T03（unit 単位の分割と対象が要る）
  - 変更: `server/evals/conflict/labels.json`, `server/evals/conflict/run.ts`, `server/evals/conflict/measure.ts`, `server/test/conflict-measure.test.ts`
  - 完了条件: `cd server && node evals/conflict/run.ts --check-labels evals/conflict/labels.json` → 全依頼に衝突の集合・関連の集合・上書き・書き手・語の重なりの層があり、書き手と別のモデルの確認（採る・直す・捨てる）が全件に付いている。本文は入っていない
  - コミット: `feat(evals): add the cross-reviewed synthetic prompts and labels for #260 (T04)`
  - 結果: `cd server && node evals/conflict/run.ts --check-labels evals/conflict/labels.json` → 母集団が求める依頼すべてにラベルがあり、positive 120 件・hard negative 60 件（捨てた 0 件、直した 12 件）、普段の依頼 400 件、本文は非公開。`test/conflict-measure.test.ts` は 10 件 pass

## P3: 測定と判定

tune で方式と基準の数値を固定し、held-out を 1 回だけ測って判定を出す。

- [x] T05: tune で方式と基準を固定
  - 種別: 追加
  - 計画: S4
  - 依存: T01（拾い方が要る）, T04（tune のラベルが要る）
  - 変更: `server/evals/conflict/tune.json`, `server/evals/conflict/run.ts`, `server/evals/conflict/methods.ts`, `server/evals/conflict/measure.ts`, `server/test/conflict-measure.test.ts`, `server/test/conflict-eval.test.ts`, `biome.json`
  - 完了条件: `cd server && node evals/conflict/run.ts --check-tune evals/conflict/tune.json` → 選んだ方式・並べ方・取得上限、固定した判定の数値、tune の普段の依頼の候補のラベル（割れたものは 1 回の見直しの後、なお割れたら判定不能）と一致数が入っている
  - コミット: `feat(evals): fix the #260 method and bars on the tune split (T05)`
  - 結果: `cd server && node evals/conflict/run.ts --check-tune evals/conflict/tune.json` → 数え直しが書いた値と一致、選んだ方式 B1b-m3、held-out で測る 8 方式、基準はラベルと同じ、普段の依頼の候補 619 組（初回一致 544、見直しで一致 52、判定不能 23）。`test/conflict-measure.test.ts` 12 件・`test/conflict-eval.test.ts` 4 件 pass

- [x] T06: held-out の測定と判定
  - 種別: 追加
  - 計画: S5, S6
  - 依存: T05（固定した方式と基準が要る）
  - 変更: `server/evals/conflict/baseline.json`, `server/evals/conflict/labels.json`
  - 完了条件: `cd server && node evals/conflict/run.ts --recount evals/conflict/baseline.json` → 判定（進む候補あり / 今回の方式では進めない / 標本不足で保留）と集計が baseline の値と一致する
  - コミット: `feat(evals): measure the #260 held-out split and record the verdict (T06)`
  - 結果: `cd server && node evals/conflict/run.ts --recount evals/conflict/baseline.json` → `not_now, as written`（今回の方式では進めない）。`--rerun` で DB の写しと held-out の依頼 290 件の sha256 が一致し、全方式の候補と表示が baseline と同じ

## 記録

- T01: dont の決定は計画の件数と同じく kind = decision かつ stance = dont で数える。B2 の検索は lifecycle を active に絞って呼ぶ（配信できるのは active だけで、superseded が上限を食わないため）
- T01: 評価の道具は出荷物の挙動を変えないので、タスクごとの Codex のレビューは省き、最後の全差分のレビューで見る
- T03: DB の写しは 2026-10-21 00:48（日本時間）に `VACUUM INTO` で取った（sha256 dc4194d4…、計画の「2026-10-20 に固定」から約 1 時間後。この間の記録の差は数えていない）。普段の依頼の本文は capture が保存した形（長いものは切られている）で、フックが見た全文ではない
- T04: 変更欄を「labels.json, population.json」から「labels.json, run.ts, measure.ts, conflict-measure.test.ts」に変えた。`--check-labels` とラベルの組み立てが run.ts に、ラベルの公開キーの許可が measure.ts に要るため。population.json は変えない（依頼を書いた Codex の会話はリポジトリの外で走らせ、capture されないので評価セッションに足すものが無い）
- T04: 衝突の集合の候補は、対象の記録の文（依頼ではない）で検索して読んだ。同じ衝突を裏付ける dont の決定や却下した案は 60 件のどれにも見つからず、衝突の集合は対象の記録 1 件ずつ。同じ話題の記録は関連の集合に入れた
- T04, T05: 完了条件の「持ち主の確認」「持ち主と固定した判定の数値」「割れたものは持ち主の判定」を、別のモデルの確認・叩き台の値の固定・1 回の見直しと判定不能に変えた（plan の変更履歴 2026-10-21。持ち主が任せたため）
- T04: 書き手は Codex 90 件・Claude 90 件。確認は書き手と別のモデルで、Claude は Codex の 90 件をすべて採り、Codex は Claude の 90 件のうち 12 件を直した（直した文は Claude が確かめて採った）。ほかの対象にも反するかの確認で、u437o351 の positive に u352、u607o418 の positive に u558 を衝突の集合へ足した。語の重なりは positive で none 4・partial 92・most 24
- T04: コミットの件名を「owner-confirmed」から「cross-reviewed」に変えた（持ち主の確認が無いため）
- T05: 変更欄を「tune.json, labels.json」から「tune.json, run.ts, methods.ts, measure.ts, conflict-measure.test.ts」に変えた。普段の依頼の候補のラベルは labels.json ではなく tune.json と baseline.json の依頼に入れ、測定・組み立て・検査を run.ts に、alias の並べ方と最低一致数を methods.ts に、判定する方式の指定を measure.ts に足すため
- T05: tune の最初の測定で、B1a の候補に反する記録が入っても上位 3 から漏れる例が 16 件あり、alias の候補が記録 id 順に並ぶのが原因だった。計画の「並べ方は tune で固定」の範囲で、一致した alias の数と長さで並べる版（order: matches）と、一致した alias の最低数（minAliases 2・3）を足して比べた
- T05: held-out の判定は tune で固定した 1 方式だけにする（judged）。ほかの方式は並べて報告するが進む候補にしない。held-out で複数の方式を判定すると、偶然どれかが基準を超える見込みが増えるため
- T05: 方式の選び方（確定ラベルを見る前に決めた）: tune で、B0 から悪化 0 件かつ普段の依頼で無関係な候補が出た割合の Wilson 上限が基準（10%）以下の方式のうち、positive で表示される割合が最も高いもの。同率なら普段の依頼で何か表示した件数が少ないもの。該当が無ければ、B0 より表示される割合が高い方式のうち Wilson 上限が最も低いもの。held-out では選んだ方式に加え、B0・B1a・B1b（id 順と matches 順）・B2（取得上限は表示される割合が同じなら最小）・併用を報告する
- T05: tune の結果（Claude と Codex の確定ラベル）: B0 は positive 60 件中 2 件を表示。B1a-m は 45 件（日 21・英 24）を表示するが、普段の依頼 180 件中 21 件で無関係な記録を出し、Wilson 上限 17%。B1b-m は 46 件・上限 60%。B2（取得上限 5・10・20）は 11 件で上限 39〜42%。基準（上限 10% 以下）を満たしたのは B1a-m2（23 件、7.1%）・B1a-m3（12 件）・B1b-m3（23 件、5.6%）で、同率の B1a-m2 と B1b-m3 のうち普段の依頼で何か出した件数が少ない B1b-m3 を選んだ。tune でも基準をすべて満たす方式は無い（判定は not_now）
- T05: 公開ファイルの候補 ID の列は positive にだけ残し、ほかの依頼は表示した記録だけにした（数えるのに使うのはそれだけで、tune.json が 1.6 MB になったため）。依頼を 1 行ずつ書き、biome.json で `server/evals/conflict/*.json` を整形の対象から外した（整形すると 5.9 万行になるため）
- T06: held-out の普段の依頼の候補 523 組は tune と同じく Claude と Codex が別々に付け、割れた 60 組を 1 回だけ見直した（初回一致 463、見直しで一致 41、判定不能 19）。判定不能を含む依頼は 18 件（200 件の 9%）で、保留の線（10%）の内側
- T06: held-out の結果: 判定した B1b-m3 は positive 60 件中 20 件（日 9・英 11）を表示し、B0 から悪化 0 件・改善 19 件、普段の依頼で無関係な記録を出したのは 182 件中 2 件（Wilson 上限 3.9%）。表示される割合の基準（60%）に届かず not_now。並べて報告した方式では B1a-m が 38 件・無関係の上限 20%、B1b-m が 42 件・60%、B2-5 が 13 件・37%、B1a-m と B2-5 の併用が 41 件・49% で、表示を増やす方式はどれも無関係な記録を基準の 2 倍以上出す
- T06: labels.json は変えていない（変更欄に挙げたが、held-out の普段の依頼のラベルは baseline.json の依頼に入れるため）
- T02: 普段の依頼は、候補のどれか 1 つでも判定不能なら全方式の分母から外す（方式どうしで分母をそろえるため）。無関係の率は表示された候補で数える。日英で B0 を下回らない条件は、悪化 0 件なら必ず満たすが、計画どおり別に判定する
