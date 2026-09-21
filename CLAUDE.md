# CLAUDE.md — ai-dev-kit（中央 kit リポジトリ）

このリポジトリは **ai-dev-kit の本体**です。`aidev` CLI（`cli/`）、PKG へ配布するテンプレート
（`templates/`）、テスト（`test/`）、ユーザーガイド（`docs/user-guide/`）を保守します。
PKG へ配布される `CLAUDE.md` は `templates/root/CLAUDE.md` です。このファイルとは別物です。

## 作業の進め方

1. `maintainer-docs/architecture.md` で設計を確認してから変更する
2. `npm run check`（全モジュールのロード確認 + テスト）を通す
3. docs を変更したら `npm run docs:check`（AsciiDoc のビルド検証）を通す
4. テストは実 `claude` を起動しない。エージェント実行は `AIDEV_CLAUDE_BIN` のスタブで検証する

## 守ること

- CLI が書く権限ファイル（`.aidev/policy.yaml` など）をエージェントが書く経路を作らない
- PR は人間がマージする。自動マージを実装しない
- 秘密情報（PAT・トークン・鍵）をコミット・ログ・テストフィクスチャに含めない
- ユーザーガイドには実装済みの挙動だけを書く。設計中のものは `maintainer-docs/proposals/` に置く

## 推測を事実として報告しない

- テストを実行していないなら「テストが通った」と書かない
- 失敗は失敗として報告する
