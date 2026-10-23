# release-notes — 前回のリリースからの変更を CHANGELOG にまとめる標準 workflow

HEAD から辿れる最新の tag（または指定した起点）以降のコミットを読み、利用者から見える変更だけを CHANGELOG の次のバージョンの項に Keep a Changelog の形で書き、確認役の agent がコミットと突き合わせてから PR にします。言語やビルドの道具に依存しません（git の履歴だけを読みます）。

この README は複製されません（複製されるのは `workflow.yaml`、`agents/`、`skills/`）。使い方の正本はユーザーガイドの「標準 workflow から作る」節で、ここはその要約です。

## 流れ

| step | 内容 |
| --- | --- |
| `collect`（agent、何も書かない） | 起点（`since`。`latest` なら最新の tag）からのコミットを `git log` で集め、1 行 1 コミットの `commits.md` と、Added / Changed / Fixed … の候補と外す候補を書いた `groups.md` を実行の notes に置く。tag が無い・コミットが 0 件なら理由を報告して止まる |
| `draft`（agent + 確認役 agent） | CHANGELOG の先頭に `## [<version>] - <日付>` の項を書く。`release-notes-reviewer` が `commits.md` の全コミットが書かれているか理由付きで外されているか、創作・内部の作業の混入・形式の崩れが無いかを確かめ、足りなければ差し戻す（2 回まで） |
| `pr` | PR を作る |

## 前提

- git の履歴に起点がある: リリースごとの tag（`v1.2.0` など）を打っていること。打っていない PKG は `--input since=<commit か branch>` で起点を渡す
- CHANGELOG の置き場は `CHANGELOG.md`（既定）。`docs/releases/` に置く PKG は複製した YAML の `draft` の `writable` を直す
- agent は `Bash` で git を読む（`git log` / `git describe` / `git show`）。コミットを書き換えることはない

## 使い方

### 1. PKG に複製する（Engineering Manager）

```bash
aidev create workflow release-notes --from release-notes
```

`.aidev/workflows/release-notes/workflow.yaml`、`.aidev/agents/release-notes-{writer,reviewer}.md`、`.aidev/skills/release-notes-writing/SKILL.md` が書かれ、入力の一覧が表示されます。複製した時点で PKG のファイルです。

### 2. この PKG で違うところを直す

- **定義で違うもの** → 複製した `workflow.yaml` を直す: CHANGELOG の置き場（`draft` の `writable`）、費用の上限（`limits.max_usd`、既定 10）
- **書き方で違うもの** → 複製した `.aidev/skills/release-notes-writing/SKILL.md` を直す: 見出しの言語、参照の書き方、外す基準
- **値で違うもの** → 実行時の `--input`: `version`（必須）、`since`（省略時 `latest`）。毎回同じ値は無いので `aidev.yaml` に書くものはありません

### 3. 試して、提出する

```bash
aidev run workflow release-notes --trial --input version=1.2.0            # 最新の tag から。何も push しない
aidev run workflow release-notes --trial --input version=1.2.0 --input since=abc1234   # 起点を指定
aidev submit workflow release-notes                                        # レビューへ（マージが承認）
```

### 4. 実行する（マージ後、リリースの前に）

```bash
git fetch origin
aidev run workflow release-notes --input version=1.2.0
```

PR をレビューしてマージし、tag を打ってリリースします。次回は打った tag が起点になります。

## 新しい版を取り込む

ADK を更新したら、`aidev sync workflow release-notes` を実行します。複製時に書かれた `.aidev/workflows/release-notes/standard.json` を元に、この PKG で直したところを保ったまま、ファイルごとに ADK の変更を取り込みます（編集していないファイルは置き換え、編集したファイルは 3-way merge、同じ行を両方が変えていれば衝突マーカー）。`--dry-run` で先に何が変わるかを見られます。`git diff` でレビューして `aidev submit workflow` で提出します。`standard.json` の無い複製は `aidev sync workflow release-notes --from release-notes` と複製元を名指しします。
