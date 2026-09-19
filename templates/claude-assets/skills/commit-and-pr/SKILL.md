---
name: commit-and-pr
description: ブランチ名・コミットメッセージ・PR本文の規約。品質ゲート通過後にのみPRを作る原則と、自動マージ禁止を含む。
---

# commit-and-pr

## 前提: 品質ゲートを先に通す

**PRは品質ゲート通過後にのみ作ります**（[[test-and-verify]]）。
落ちたまま「後で直す」PRを作らないでください。レビュアーの時間を奪い、
CIを赤いまま放置する文化を作ります。

## ブランチ

| 用途 | 形式 |
| --- | --- |
| issue-to-pr | `ai/wi-<id>` |
| 通常の機能開発 | `feature/<name>` |
| 修正 | `fix/<name>` |

- 既定ブランチ（`main`）へ直接コミット・pushしません
- `<name>` は英小文字・数字・ハイフン。日本語や空白を入れない
- **force-push・履歴改変（rebase後の強制上書き・`filter-branch`）は実行前に必ず確認**を取ります

## コミット

1コミット = 1つの論理的変更。「動く状態」を保ちます。

```text
<type>: <何をしたか（現在形・50字程度）>

<なぜそうしたか。何を変えたかはdiffが語るので、理由を書く>
<影響範囲・既知の制約・関連するWork Item>

Co-Authored-By: Claude Code <noreply@anthropic.com>
```

`type` は `feat` / `fix` / `refactor` / `test` / `docs` / `chore` / `perf` から選びます。

- **生成物・秘密情報・無関係なファイルを混ぜない**（[[secure-coding]]）
- 「WIP」「fix」「update」だけのメッセージにしない
- `--no-verify` でフックを飛ばさない

## PR本文

```markdown
## 何を
<1〜3行。レビュアーが最初に読む部分>

## なぜ
<背景。Work Item / Issue へのリンク>

## 変更内容
- <ファイル単位ではなく、論理単位で>

## 検証
- build: pass / lint: pass / typecheck: pass / test: pass (12 passed)
- <実行していないものは「未実行」と明記する>

## レビュー観点
<特に見てほしい箇所。判断に迷った設計上の選択>

## 破壊的変更
<有/無。有なら移行方法>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

### 検証セクションの書き方

ここが**本文で最も重要**です。通っていないものを通ったと書かないでください。

- 実行したコマンドと結果を具体的に書く
- 落ちているものがあるなら、**隠さずに書く**。「既存の失敗」ならそう明記する
- 秘密情報を含むログは貼らない

## マージ

> 🔴 **自動マージは禁止です。** PKG PR・ラッパーPR とも人間がマージします。

- auto-complete / `completionOptions` を設定しない
- 自分でマージしない。レビュー依頼までが範囲です
- 既存のオープンPRがあるなら、**新規作成せず更新**します

## PR作成前の最終確認

- [ ] 品質ゲートを通した（落ちたものは本文に明記した）
- [ ] 差分を最初から最後まで読んだ（[[code-review]] のセルフレビュー）
- [ ] 秘密情報・デバッグ出力・一時ファイルが入っていない
- [ ] 計画（[[change-planning]]）の範囲に収まっている
- [ ] ブランチ名が規約どおり
- [ ] 自動マージを設定していない

関連: [[test-and-verify]] / [[code-review]] / [[azure-devops]] / [[secure-coding]]
