# Sphica

[![License](https://img.shields.io/github/license/iroha924/sphica)](https://github.com/iroha924/sphica/blob/main/LICENSE)
[![CI](https://github.com/iroha924/sphica/actions/workflows/check.yml/badge.svg)](https://github.com/iroha924/sphica/actions/workflows/check.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/iroha924/sphica/badge)](https://scorecard.dev/viewer/?uri=github.com/iroha924/sphica)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/14787/badge)](https://www.bestpractices.dev/projects/14787)
[![SLSA Build L2](https://img.shields.io/badge/SLSA-Build%20L2-green)](https://www.npmjs.com/package/sphica#provenance)
[![Dependabot: GitHub Actions](https://img.shields.io/badge/Dependabot-GitHub%20Actions-025E8C?logo=dependabot)](https://github.com/iroha924/sphica/blob/main/.github/dependabot.yml)

バッジが示すもの: CI が流す検査は[貢献](https://github.com/iroha924/sphica/blob/main/README.ja.md#貢献)、リリースのビルドと公開の仕組みは[セキュリティ](https://github.com/iroha924/sphica/blob/main/README.ja.md#セキュリティ)にあります。バッジが通っていても、バグや脆弱性が無いという意味ではありません。

[English](https://github.com/iroha924/sphica/blob/main/README.md) | 日本語

**Claude Code と Codex のための、過去の実装と判断の記憶。**
Sphica は開発のセッションを記録し、決めたこと・捨てたこと・保留にしたこと・作ったことを、それぞれ元の言葉を引用した記録として残します。
エージェントは検索で記録を探せるほか、記録に関係するファイルを読んだり編集したりするときには、その記録が自動で届きます（Codex では、ファイル名を含むシェルのコマンドと `apply_patch` の前）。
DB は手元の SQLite の 1 ファイルです。

## できること

- **自動で記録する。** あなたの発言、各ターンのエージェントの最後の応答、そのターンで変わったファイルのパス（編集ツールによる変更と、ターンの終わりの `git status` で見えた変更）を残します。
- **出典付きの記録を作る。** `/sphica:trace` で、セッションから記録を作ります。捨てた案とその理由を含む決定、制約、実装、発見、うまくいかなかった試み、未解決の疑問です。どの記録も元の発言をそのまま引用します。決定が採用になるのは、あなたがそう言ったとき（あなたの判断）と、エージェントがそのセッションで自分で決めて応答にそう書いたとき（AI の判断）の 2 通りです。AI の判断はそれと分かる形で届き、あなたの判断を置き換えることはなく、公開しているインターフェース・セキュリティと権限・リリース・forget には使いません。
- **頼まなくても trace する（Claude Code）。** 新しいセッションを始めたときに、直近 14 日のセッションでまだ trace していないものがあると、あなたの依頼が片づいた後で、エージェントが古いものから最大 2 つを trace します。すぐ残したいときは `/sphica:trace` を、それより古いセッションは `/sphica:trace pending` を流してください。自動の trace を止めるには、Claude Code の `settings.json` の `env` に `"SPHICA_AUTO_TRACE": "off"` を書きます。記録と、手で流す `/sphica:trace` はそのまま動きます。
- **PR からも残す。** `/sphica:harvest <番号>` で、GitHub の PR（本文、コメント、レビュー、レビューコメント、コミット、本文で閉じると書かれた issue を最大 5 件）を残し、そこで決まったことを記録します。レビュアーの提案は、リポジトリのオーナーかメンテナーが採用しない限り提案のままで、マージだけでは何も採用になりません。
- **後から見つかった根拠を足す。** `/sphica:glean` で、既存の記録に根拠や訂正を足します。保存の前に出典（issue の URL、ファイルと行、議事録）を尋ね、出典の無い主張は「出典なし」としてだけ残し、事実としては使いません。
- **残すべきでなかったものを消す。** `/sphica:forget` で、あなたが選んだ発言・PR の項目・ファイルの抜粋を、検索の索引と DB ファイルに残るバイトごと消します。消す前にダイアログで確認します（ほかのセッションが DB を読んでいるときは、バイトを消し切るためにもう一度流すよう伝えます）。それを根拠にしていた記録は判断し直し、ほかに根拠が無ければ有効でなくなります。記録そのものの本文はそのまま残ります。
- **必要なときに見せる。** セッションの開始時には今の作業を、ファイルを読む・編集する前やシェルのコマンドにファイル名が含まれるときにはそのファイルに関係する判断を、発言に記録の選択肢やコードの名前がそのまま出てきたときにはその記録を渡します。AI の判断にはその印を付け、理由を書けば離れてよいと添えます。Claude Code でも Codex でも動きます。
- **日本語でも英語でも探せる。** 記録を作るときに日本語と英語の検索ワードを付けるので、どちらの言語で聞いても見つけやすくなっています。
- **今生きている判断と、見直しが要るものを見る。** overview を頼むと、`view: "live"` で有効な決定と制約を全部、関係するディレクトリごとに出します。`view: "look"` では、紐付いたファイルが消えた記録、関数名などが見つからない記録、却下した案を見直す条件としてあなたが言ったもの、置き換えられた記録を指している規約の行を出します。自動で失効させたり変えたりはしません。
- **記録に自分の項目を持たせる（試作）。** 記録に残したい項目（影響するテナント、p95 の値など）をセッションで伝えると、trace は会話に値がそのまま書かれているときだけ、その引用付きで値を保存します。`/sphica:fields` で、項目ごとに値の付いた記録の件数を見られます。
- **決定をファイルで共有する。** `/sphica:export` で、あなたが選んだ有効な決定を、根拠の引用と置き換えた古い決定付きで、リポジトリ内の Markdown ファイルに書き出します。Sphica を使っていない人も読めます。書く前にファイル全体を確かめられ、コミットはあなたが行います。
- **記録から規約の文面を作る。** `/sphica:rules` で、あなたが選んだ制約や決定から CLAUDE.md・AGENTS.md・`.claude/rules` 向けの行を下書きします。各行に記録のキーの印が付くので、記録が変わると overview が知らせます。ファイルは書き換えません。
- **レビューで過去の判断と照らす。** `/sphica:review` は観点ごとに独立したレビュアーを立てます（既定は正しさ・セキュリティ・明文化された規約・過去の判断、`full` で冗長さが加わる）。差分が触る記録と照らし合わせます。

記録は書き換えません。訂正は古い記録を置き換える新しい記録になり、経緯は残ります。
エージェントには、記録は過去のデータで指示ではないこと、記録と今のコードが食い違ったらコードのほうを信じることを伝えています。

## 必要なもの

- Node.js 24.15 以上
- Claude Code 2.1.139 以降か Codex（両方でもよい）。それより古い Claude Code は Sphica のフックを黙って飛ばすので、記録も配信も動きません（`sphica doctor` が知らせます）
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

Codex では `/hooks` を開き、Sphica のフックを信頼済みにしてください。信頼するまでは、自動記録が始まりません。plugin の更新でフックが変わったら、もう一度信頼してください。

**3. リポジトリで準備する**

```bash
cd ~/Projects/your-repo
sphica init
```

`~/.sphica/sphica.db` を作り、リポジトリを登録します。何度流しても大丈夫です（DB と登録は、すでにあればそのまま使います）。`origin` の remote が無いリポジトリは名前を付けます: `sphica init --name <名前>`。

`gh` にログインしていれば、init はそのアカウントをあなたの GitHub アカウントとして登録します。これで、コントリビューターとして出した他人のリポジトリの PR でも、あなたの発言で判断を採用できます。対象は登録の後に harvest した PR です。登録の前に harvest した PR のあなたの発言は、コントリビューターの発言のまま残ります。登録するのは最初の 1 つだけです。あとで `gh` を別のアカウントに切り替えても、init はそう伝えるだけで追加しません。登録を変えるコマンドは無いので、変えるときは DB を別の場所へ移してから init を流し直してください。`gh` が無くても init はセットアップを終え、登録できなかった理由を表示します。登録したアカウントは `sphica doctor` で確かめられます。

**4. 確かめる**

```bash
sphica doctor
```

`doctor` は Node.js、CLI と plugin のバージョン、DB、記録のキュー、登録したプロジェクトを確かめます。何かおかしいときは、まずこれを流してください。

## 使い始める

Sphica の DB に入るのは、登録したリポジトリ（プロジェクト）のセッションだけです。記録したいリポジトリごとに `sphica init` を流してください。

あとはいつもどおり作業します。Claude Code では、新しいセッションを始めるとエージェントが以前のセッションを自分で trace します。すぐ残したいときや Codex では、`/sphica:trace`（Codex では `$sphica:trace`）を流します。
`/sphica:trace pending` で、まだ trace していない以前のセッションが一覧できます。PR で決まったことを残すなら `/sphica:harvest 123` です。
後から根拠が見つかったら（「運用メモにこう書いてあった」「木村さんがチームで合意済みと言っていた」）、見つけたことを添えて `/sphica:glean` を流します。

以前の判断を知りたいときは、エージェントに聞いてください:

- 「ここのリトライの扱いって、もう決めてたっけ？」
- 「なぜこのやり方にしたの？何を捨てた？」
- 「サムネイルをワーカーで作ろうとしたことはある？」

### エージェントに自動で見せるもの

頼まなくても、Sphica は過去の記録をいくつかエージェントに見せます。どれも「指示ではなく過去の記録」と添えます。

- セッションの開始時: 今の作業と、プロジェクト全体の制約。Claude Code では、まだ trace していないセッションがあれば、依頼が片づいた後で trace するよう伝えます。
- 発言に、記録にあるコードの名前・ファイルのパス・選択肢が含まれるとき。
- 判断が当てはまるファイルを、エージェントが読む・編集する直前と、そのファイル名を含むシェルのコマンドの直前（ファイル名が含まれているだけで、読んだとは限りません）。読むときは、同じ記録を 1 セッションに 1 回だけ見せます。
- レビューの直前（Claude Code のみ）。あなた自身のレビューコマンド（名前に `review` を含むもの、または環境変数 `SPHICA_REVIEW_COMMANDS` にカンマ区切りで
  並べた名前）を流すと、手元の変更が触れている判断を渡します。`/sphica:review` は自分で過去の判断と照らし合わせます。

Codex でも、セッションの開始時、発言時、`apply_patch` での編集の直前、そうしたファイル名を含むシェルのコマンドの直前に同じことをします（Codex はシェルのコマンドでファイルを読むので、読む前もこれに含まれます）。
Codex にはレビューのフックがありません。`$sphica:review` を流してください。

エージェントは Sphica の `search` で検索し、`read` で記録の全文を開きます。`status` で履歴がどこまで trace 済みかが分かるので、検索で何も出なくても「まだ決めていない」と早合点しにくくなります。

## 何を記録し、どこに置くか

- **場所。** DB は `~/.sphica/sphica.db` です。記録したセッションはいったん手元のキュー `~/.sphica/spool` に置かれ、そこから DB に書かれます。DB はマシンごとにあり、マシンの間で共有しません。
- **中身。** あなたの発言、各ターンのエージェントの最後の応答、変わったファイルのパス。バックグラウンドのタスクの通知や、ほかのエージェントからのメッセージは、見分けられるものは除きます。ターンの途中の応答は残りません。編集ツールを使わずに 1 つのターンの中で作って消したファイルも残りません。
- **見せたもの。** 自動で渡したものは、どの記録を渡したかだけを残します（本文は残しません）。
- **登録していないリポジトリ。** 登録していないリポジトリのセッションはキューに残り、登録した後に DB に書かれます。30 日を過ぎたものは捨て、1,000 件を超えたら古いものから捨てます。
- **秘密情報。** あなたの発言、PR の文章、`/sphica:glean` が引いたファイルの行では、パターンで見分けられる秘密情報だけを伏せます（0.5.7 より前に保存した抜粋は、消すまでそのまま残ります）:
  - 既知の接頭辞を持つキー
  - `KEY=…` や `"password": …` の代入
  - URL の中の認証情報
  - 認証ヘッダー
  - `mysql -p`

  **それ以外は打ったとおりに残るので、セッションに秘密情報を貼らないでください。** 入ってしまったら、それを含む出典を `/sphica:forget` で消せます（Claude Code で。確認のダイアログが Codex では出ないことがあります）。記録がその言葉を繰り返していれば、記録の本文には残ります。
- **ネットワーク。** Sphica にはアカウント登録も外部のサービスもテレメトリもなく、Sphica 自身はネットワークに接続しません。`/sphica:harvest` と `/sphica:glean` は PR と issue を読むため、あなたの認証情報で `gh api` を流します。`sphica init` はあなたの GitHub アカウントを知るため `gh api user` を流します。`sphica doctor` は入っているバージョンを確かめるため `npm` と `claude` を流します。`gh api` の送り先は常に github.com です。
- **ほかの人が書いた文章。** PR と issue の文章は誰でも書けます。原文として残し、エージェントには指示ではなくデータとして渡します。決定を採用にできるのは、あなた自身・リポジトリのオーナー・メンテナーの言葉と、エージェントが自分で決めたことです。エージェントがほかの人の文章を引用したりまとめたりしたものは、採用になりません。

## まだできないこと

- 構造化された記録として残せるのは、trace・harvest・glean したものだけです。それ以外の会話は、記録した原文として検索できます（`search` の `sources: true`）。
- シェルのコマンドについては、ファイル名が含まれるかどうかまでしか見ていません。読んでいなくても判断を見せることがあり、シェルでの編集も編集としては扱えていません（Codex でシェルから `apply_patch` に渡したパッチは、編集として扱います）。
- Codex の `$sphica:trace`・`$sphica:harvest`・`$sphica:glean` は、Codex がセッションのディレクトリを伝えてくれるときだけ書き込めます。今の Codex は伝えてくれます。伝わらないときは、書き込まずに理由を表示します。
- 記録を見せても、エージェントがそれに従うとは限りません。
- エージェントが自分で決めたかどうかは応答に書かれたことから見分けるので、外れることがあります。
- AI の判断が採用になるのは、trace を Claude Code の対話のセッションで流したときだけです。headless や SDK での実行と Codex では、候補のまま残ります。自動の trace も Claude Code だけで、Codex ではまだ trace していないセッションがあることを知らせるだけです。
- Sphica の記録ツールをどのターンが呼んだか見分けられなかったとき（hook が時間切れになった、無効にされていた）は、そのプロジェクトでそれ以後に Claude Code のエージェントが書いた応答は、ずっと候補のまま残ります。あなたの判断には影響しません。
- 自動の trace は、サブスクリプションの使用量を使います。
- エージェントは AI の判断を取り下げません。あとの記録と食い違うときは、あなたが決着をつけるまで AI の判断を見せるのを止めます。あとの記録も、あなたの判断でなければ同じく止めます。
- 記録にあるコードの位置は、読むときに作業ツリーと照らし合わせます。記録が指すコードの名前（関数名など）が見つかっても、その判断がまだ有効だとまでは言えません。

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

更新したら、開いているセッションを開き直してください。DB が変わる更新（0.6.0 がそう）では、先に CLI を更新してから `sphica init` を 1 回流します。DB をその場で移行し、記録はそのまま残ります。それまでは Sphica が使えない状態になり、そう表示します。古い CLI は移行した DB を読めません。古い CLI が「退避して」と言っても退避せず、その CLI を更新してください。

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

まず `sphica doctor` を流してください。古くなっているところや、動いていないところを教えてくれます。よくある症状:

- **`sphica: command not found`。** plugin は CLI を PATH に置きません。`npm i -g sphica` を流してください。
- **何も記録されない。** `sphica doctor` の Projects にそのリポジトリがあるか確かめてください。Codex では、`/hooks` でフックが信頼済みかも確かめてください。
- **MCP サーバーのバージョンが古いままになっている。** セッションを開き直すか、Claude Code なら `/reload-plugins` を流してください。
- **検索で何も見つからない。** 検索はワードの一致です。別のワードやもう一方の言語、識別子で試すか、ワードを減らしてください。エージェントに `status` を見てもらうと、まだ trace していないセッションは原文としてしか検索できないことが分かります。
- **`doctor` が全文検索のインデックスが壊れていると表示する。** `sphica doctor --reindex` を流してください。

## コマンド

| コマンド | すること |
|---|---|
| `sphica init` | DB を作り、`gh` にログインしている GitHub アカウントを登録し、今のリポジトリを登録する |
| `sphica doctor` | バージョン、DB、記録、登録したプロジェクトを確かめる |
| `sphica uninstall` | `~/.sphica` を消し、plugin と CLI の外し方を表示する |

それ以外は Claude Code と Codex の中で、`/sphica:*` のコマンドと Sphica の MCP のツールを通して動きます。

## セキュリティ

脆弱性は [SECURITY.md](https://github.com/iroha924/sphica/blob/main/SECURITY.md) の手順で、非公開で報告してください。

リリースは、CI が通った PR の head に打った tag から GitHub Actions がビルドします。
メンテナーが GitHub でリリースの環境を承認してから公開し、npm へはトークンを置かない trusted publishing で届けます。
[npm のページ](https://www.npmjs.com/package/sphica#provenance)から、ビルドしたワークフローとコミットを辿れます。

依存の更新は、CI で使う GitHub Actions を Dependabot が毎週、パッケージにバンドルした npm の依存を Renovate が毎月、PR にします。

## 貢献

issue は歓迎します。外部からの PR はレビューせずに閉じます。このリポジトリのレビューツールはメンテナーの認証情報を持った環境で動くので、ほかの人が書いたコードを安全に checkout できないためです。

動作を追加・変更する PR には、自動テストも一緒に入れます。CI が PR ごとに `bun run verify` を実行します。

## ライセンス

[MIT](https://github.com/iroha924/sphica/blob/main/LICENSE)。公開しているパッケージは依存をバンドルしています。それらのライセンスはパッケージの中の `THIRD_PARTY_NOTICES.md` にあります。
