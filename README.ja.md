# Sphica

[![License](https://img.shields.io/github/license/iroha924/sphica)](https://github.com/iroha924/sphica/blob/main/LICENSE)
[![CI](https://github.com/iroha924/sphica/actions/workflows/check.yml/badge.svg)](https://github.com/iroha924/sphica/actions/workflows/check.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/iroha924/sphica/badge)](https://scorecard.dev/viewer/?uri=github.com/iroha924/sphica)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/14787/badge)](https://www.bestpractices.dev/projects/14787)
[![SLSA Build L2](https://img.shields.io/badge/SLSA-Build%20L2-green)](https://www.npmjs.com/package/sphica#provenance)
[![Dependabot: GitHub Actions](https://img.shields.io/badge/Dependabot-GitHub%20Actions-025E8C?logo=dependabot)](https://github.com/iroha924/sphica/blob/main/.github/dependabot.yml)

[English](https://github.com/iroha924/sphica/blob/main/README.md) | 日本語

**Claude Code と Codex のための、過去の実装と判断の記憶。**
Sphica は開発のセッションを記録し、決めたこと・捨てたこと・保留にしたこと・作ったことを、それぞれ元の言葉を引用した記録として残します。
エージェントは検索でそれらを引けるうえ、記録が当てはまるファイルを編集する前には、該当する記録を自動で受け取ります。
DB は手元の SQLite の 1 ファイルです。

## できること

- **自動で記録する。** あなたの発言、各ターンのエージェントの最後の応答、そのターンで変わったファイルのパス（編集ツールによる変更と、ターンの終わりの `git status` で見えた変更）を残します。
- **出典付きの記録を作る。** `/sphica:trace` で、セッションから記録を作ります。捨てた案とその理由を含む決定、制約、実装、発見、行き止まり、未解決の問いです。どの記録も元の発言をそのまま引用し、決定は「あなたがそう言った」ときだけ採用として扱います。
- **PR からも残す。** `/sphica:harvest <番号>` で、GitHub の PR（本文、コメント、レビュー、レビューコメント、コミット、閉じた issue）を残し、そこで決まったことを記録します。レビュアーの提案は、持ち主かメンテナーが採用しない限り提案のままで、マージだけでは何も採用になりません。
- **後から見つかった根拠を足す。** `/sphica:glean` で、既存の記録に根拠や訂正を足します。保存の前に出典（issue の URL、ファイルと行、議事録）を尋ね、出典の無い主張は「出典なし」としてだけ残し、事実としては使いません。
- **必要なときに見せる（Claude Code）。** セッションの開始時には今の作業を、編集の前にはそのファイルに結び付いた有効な判断を、発言が記録の選択肢やコードの名前をそのまま含むときにはその記録を渡します。
- **日本語でも英語でも引ける。** 記録には両方の言語の検索語が付くので、片方の言語の問いで、もう片方の言語の記録が見つかります。
- **レビューで過去の判断と照らす。** `/sphica:review` は観点ごとに独立したレビュアーを立てます（既定は正しさ・セキュリティ・明文化された規約・過去の判断、`full` で冗長さが加わる）。差分が触る記録と照らし合わせます。

記録は書き換えません。訂正は古い記録を置き換える新しい記録になり、経緯は残ります。
エージェントには、記録は過去のデータであって指示ではないこと、記録といまのコードが食い違えばコードを正とすることを伝えています。

## 必要なもの

- Node.js 24.15 以上
- Claude Code か Codex（両方でもよい）
- `git`（登録するリポジトリを見分けるため）
- `/sphica:harvest` と、`/sphica:glean` で GitHub の出典を取り込む場合: GitHub CLI（`gh`）。`gh auth login` でログインしておく

## インストール

plugin には MCP サーバー・フック・Skill が入っています。`sphica` の CLI は npm から別に入れます。両方が要ります。

**1. CLI を入れる**

```bash
npm i -g sphica
```

**2. plugin を入れる**

Claude Code:

```bash
claude plugin marketplace add iroha924/sphica
claude plugin install sphica@sphica
```

Codex:

```bash
codex plugin marketplace add iroha924/sphica --ref main
codex plugin add sphica@sphica
```

Codex では `/hooks` を開き、Sphica のフックを信頼済みにしてください。そうするまで何も記録されません。plugin の更新でフックが変わったら、もう一度信頼してください。

**3. リポジトリで準備する**

```bash
cd ~/Projects/your-repo
sphica init
```

`~/.sphica/sphica.db` を作り、リポジトリを登録します。もう一度流しても、どちらもそのままです。`origin` の remote が無いリポジトリは名前を付けます: `sphica init --name <名前>`。

**4. 確かめる**

```bash
sphica doctor
```

`doctor` は Node.js、CLI と plugin のバージョン、DB、記録の送信待ち、登録したプロジェクトを確かめます。何かおかしいときは、まずこれを流してください。

## 使い始める

Sphica が記録するのは、登録したリポジトリ（プロジェクト）のセッションだけです。記録したいリポジトリごとに `sphica init` を流してください。

あとはいつもどおり作業します。残したいことがあったセッションの終わりに `/sphica:trace`（Codex では `$sphica:trace`）を流します。
`/sphica:trace pending` で、まだ trace していない以前のセッションが一覧できます。PR で決まったことを残すなら `/sphica:harvest 123` です。
後から根拠が見つかったら（「運用メモにこう書いてあった」「木村さんがチームで合意済みと言っていた」）、見つけたことを添えて `/sphica:glean` を流します。

以前の判断を呼び戻すには、エージェントに聞きます:

- 「ここのリトライの扱いって、もう決めてたっけ？」
- 「なぜこのやり方にしたの？何を捨てた？」
- 「サムネイルを別スレッドで作ろうとしたことはある？」

### エージェントに自動で見せるもの

頼まなくても、Sphica は過去の記録をいくつかエージェントに見せます。どれも「指示ではなく過去の記録」と添えます。

- セッションの開始時: 今の作業と、プロジェクト全体の制約。
- 発言が、記録にあるコードの名前・ファイルのパス・選択肢を名指ししたとき。
- 判断が当てはまるファイルを、エージェントが読む・編集する直前と、そのファイルを名指しするシェルのコマンドの直前（名指ししただけで、読んだ証拠にはなりません）。読むときは、同じ記録を 1 セッションに 1 回だけ見せます。
- レビューの直前。あなた自身のレビューコマンド（名前に `review` を含むもの、または環境変数 `SPHICA_REVIEW_COMMANDS` にカンマ区切りで
  並べた名前）を流すと、手元の変更が触れている判断を渡します。`/sphica:review` は自分で確かめます。Claude Code のみです。

Codex でも、セッションの開始時、発言時、`apply_patch` での編集の直前、そうしたファイルを名指しするシェルのコマンドの直前に同じことをします。
Codex にはレビューのフックがありません。`$sphica:review` を流してください。

エージェントは Sphica の `search` で検索し、`read` で記録の全文を開きます。`status` で履歴がどこまで trace 済みかが分かるので、検索が空でも「決めていない」と取り違えません。

## 何を記録し、どこに置くか

- **場所。** DB は `~/.sphica/sphica.db` です。記録はいったん手元のキュー `~/.sphica/spool` に置かれ、そこから DB に書かれます。DB はマシンごとにあり、マシンの間で共有しません。
- **中身。** あなたの発言、各ターンのエージェントの最後の応答、変わったファイルのパス。バックグラウンドのタスクの通知や、ほかのエージェントからのメッセージは、形式で見分けられるものを除きます。ターンの途中の応答と、1 つのターンの中で作って消したファイルは見えません。
- **見せたもの。** 自動で渡したものは、どの記録を渡したかだけを残します（本文は残しません）。
- **登録していないリポジトリ。** 登録していないリポジトリのセッションはキューに残り、登録した後に DB に書かれます。30 日を過ぎたものと、1,000 件を超えた分の古いものから捨てます。
- **秘密情報。** 形で見分けられる秘密情報だけを伏せます:
  - 既知の接頭辞を持つキー
  - `KEY=…` や `"password": …` の代入
  - URL の中の資格情報
  - 認証ヘッダー
  - `mysql -p`

  **それ以外は打ったとおりに残るので、セッションに秘密情報を貼らないでください。**
- **ネットワーク。** Sphica にはアカウントもホストされたサービスもテレメトリも無く、Sphica 自身はネットワークにつなぎません。`/sphica:harvest` と `/sphica:glean` は PR と issue を読むため、あなたの資格情報で `gh api` を流します。`sphica doctor` は入っているバージョンを確かめるため `npm` と `claude` を流します。
- **ほかの人が書いた文章。** PR と issue の文章は誰でも書けます。原文として残し、エージェントには指示ではなくデータとして渡します。決定を採用にできるのは、持ち主かメンテナーの言葉だけです。

## 0.5.1 の限界

- 構造化された記録があるのは、trace・harvest・glean したものだけです。それ以外は記録した原文として検索できるだけです（`search` の `sources: true`）。
- シェルのコマンドがファイルを名指ししただけで（読んでいなくても）判断を見せます。シェルのコマンドでの編集も、編集としてではなく、名指ししたコマンドとして見せるだけです（Codex でシェルから `apply_patch` に渡したパッチは、編集として扱います）。Claude Code で対象になるのは Bash ツールで、PowerShell ツール（Git Bash の無い Windows）で流したコマンドには見せません。
- Codex の `$sphica:trace`・`$sphica:harvest`・`$sphica:glean` が書き込めるのは、Codex がセッションのディレクトリを Sphica に伝えるときだけです。Codex 0.157.1 は実験的な MCP の capability で伝えます。今後の Codex が伝えなくなったら、書き込まずに理由を返して止まります。
- 記録を見せても、エージェントが従うとは限りません。私たちの評価では、Codex は依頼に反する以前の判断を受け取り、自分でも検索で見つけたうえで、依頼どおりに実装しました。
- 記録のコードの位置は、読むときに作業ツリーと照らします（located / moved / missing）。名前が見つかっても、判断がまだ効いている証明にはなりません。

## 0.4 からの移行

0.5.0 は記録を新しい形で持ちます。0.4 の DB は変更せずに拒否し、その記録は引き継ぎません。
`~/.sphica/sphica.db` を別の場所へ移し（古いデータが要るなら残しておく）、各リポジトリで `sphica init` をもう一度流してください。

## 更新

CLI と plugin は別々に更新します。

```bash
npm i -g sphica@latest
```

Claude Code:

```bash
claude plugin marketplace update sphica
claude plugin update sphica@sphica
```

Codex:

```bash
codex plugin marketplace upgrade sphica
codex plugin add sphica@sphica
```

更新したら、開いているセッションを開き直してください。

## アンインストール

```bash
sphica uninstall
```

確認のうえ `~/.sphica`（DB と記録のキュー）を消し、残りを外すコマンドを表示します:

```bash
claude plugin uninstall sphica@sphica && claude plugin marketplace remove sphica
codex plugin remove sphica@sphica && codex plugin marketplace remove sphica
npm uninstall -g sphica
```

## 困ったとき

まず `sphica doctor` を流してください。どこが古いか、動いていないかを示します。よくあるもの:

- **`sphica: command not found`。** plugin は CLI を PATH に置きません。`npm i -g sphica` を流してください。
- **何も記録されない。** `sphica doctor` の Projects にそのリポジトリがあるか確かめてください。Codex では、`/hooks` でフックが信頼済みかも確かめてください。
- **MCP サーバーが古いバージョンを名乗る。** セッションを開き直すか、Claude Code なら `/reload-plugins` を流してください。
- **検索で何も見つからない。** 検索は語の一致です。別の語、もう一方の言語、識別子、少ない語で試してください。エージェントに `status` を見てもらうと、まだ trace していないセッションは原文としてしか検索できないことが分かります。
- **`doctor` が全文検索の索引が壊れていると言う。** `sphica doctor --reindex` を流してください。

## コマンド

| コマンド | すること |
|---|---|
| `sphica init` | DB を作り、今のリポジトリを登録する |
| `sphica doctor` | バージョン、DB、記録、登録したプロジェクトを確かめる |
| `sphica uninstall` | `~/.sphica` を消し、plugin と CLI の外し方を表示する |

それ以外は Claude Code と Codex の中で、`/sphica:*` のコマンドと Sphica の MCP のツールを通して動きます。

## セキュリティ

脆弱性は [SECURITY.md](https://github.com/iroha924/sphica/blob/main/SECURITY.md) の手順で、非公開で報告してください。

0.37.1 以降のリリースは、CI が通った PR の head に打った tag から GitHub Actions がビルドし、npm にステージします。
メンテナーが SHA-512 のチェックサムと provenance を確かめ、2 要素認証で承認してから公開します。
これらのバージョンでは、[npm のページ](https://www.npmjs.com/package/sphica#provenance)から、ビルドしたワークフローとコミットを辿れます。

Dependabot は CI で使う GitHub Actions を更新する PR を作ります。パッケージにバンドルした npm の依存は対象外です。このリポジトリが使う Bun の lockfile の形式（v2）を、Dependabot が読めないためです。

## 貢献

issue は歓迎します。外部からの PR はレビューせずに閉じます。ここのレビューのツールはメンテナーの資格情報を持った環境で動くので、ほかの人が書いたコードを安全に checkout できないためです。

動作を足す・変える変更には、同じ PR に自動テストを入れます。CI が PR ごとに `bun run verify` で流します。

## ライセンス

[MIT](https://github.com/iroha924/sphica/blob/main/LICENSE)。公開しているパッケージは依存をバンドルしています。それらのライセンスはパッケージの中の `THIRD_PARTY_NOTICES.md` にあります。
