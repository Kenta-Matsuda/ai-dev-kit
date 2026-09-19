---
name: repository-discovery
description: PKG（submodule src/）の構成・言語・ビルド方法を最小トークンで把握する調査手順。Wikiが無い/古い場合や、knowledge-builder が初回生成する前に使う。
---

# repository-discovery

**目的はトークン削減**です。闇雲な `grep -r` や全ファイル読み込みをやめ、
「少数の決定的なファイル」から構成を割り出します。

## 順番（この順で止められるところまで）

1. **Wikiを先に引く** — `knowledge/index.md` があればそれが答えです（[[knowledge-usage]]）
2. **`aidev.yaml`** — `package.include` / `exclude` / `secrets_paths`。
   **調査範囲はここが決めます**。include 外を調べても無駄です
3. **リポジトリ直下のマニフェスト** — 言語とビルド方法はほぼこれで確定します

| ファイル | 言語 / ビルド |
| --- | --- |
| `package.json` | Node。`scripts` がそのまま品質ゲート候補 |
| `pyproject.toml` / `setup.cfg` / `requirements.txt` | Python |
| `go.mod` | Go |
| `Cargo.toml` | Rust |
| `pom.xml` / `build.gradle(.kts)` | Java / Kotlin |
| `*.csproj` / `*.sln` / `Directory.Build.props` | .NET |
| `Gemfile` | Ruby |
| `composer.json` | PHP |
| `CMakeLists.txt` / `Makefile` | C / C++ |

4. **CI定義** — `azure-pipelines*.yml`、`.github/workflows/*`、`Jenkinsfile`。
   **CIが実際に流すコマンドが、そのPKGの正しいビルド手順**です。
   READMEの記述より信頼できます（READMEは腐りますが、CIは落ちれば直される）
5. **ディレクトリの形** — 深さ2〜3までの一覧だけ見ます。全展開しない

```bash
# 深さを切って構造だけ見る（node_modules等は aidev.yaml の exclude に従って除外）
find src -maxdepth 3 -type d -not -path '*/node_modules/*' -not -path '*/.git/*' | sort
```

6. **エントリポイント** — `main` / `index` / `Program.cs` / `__main__.py` / `cmd/`
7. **ここまでで足りなければ**、初めて個別ソースを読みます

## モノレポの判定

`package.json` の `workspaces`、`pnpm-workspace.yaml`、`lerna.json`、`go.work`、
`Cargo.toml` の `[workspace]`、`settings.gradle` の `include` があればモノレポです。
この場合、**パッケージ単位で上記1〜6を繰り返します**。全体を一度に把握しようとしないでください。

## 記録する内容

調査結果は次の形にまとめます。Wiki生成の入力にもなります。

- 言語・フレームワークとそのバージョン（マニフェストの記述を根拠として引用）
- ビルド / lint / typecheck / test の**実際のコマンド**（根拠: CI定義の行）
- エントリポイントと主要モジュールの責務
- 外部依存（DB・外部API・認証基盤）
- **分からなかったこと**（「調べたが確定できない」と明示する。推測で埋めない）

## やってはいけないこと

- `aidev.yaml` の `include` 外・`exclude` 該当・`secrets_paths` 該当を読む
- 生成物（`dist/`・`build/`・`node_modules/`・`vendor/`・`*.min.js`）を読む
- ロックファイル（`package-lock.json` 等）を読む。数万行あり、得るものはほぼ無い
- README のビルド手順を検証せず事実として報告する（[[test-and-verify]] で実際に流す）
- 見つからなかったものを「存在しない」と結論する

関連: [[knowledge-usage]] / [[change-planning]] / [[test-and-verify]] / [[secure-coding]]
