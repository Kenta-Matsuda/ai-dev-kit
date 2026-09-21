---
name: repository-discovery
description: PKG（リポジトリルート）の構成・言語・ビルド方法を少ないトークンで横断調査する手順。Wikiが無い/古い場合や、knowledge-builder が生成前に使う。
---

# repository-discovery

対象PKGリポジトリを闇雲に全文読まず、構造を地図化してから必要なソースへ辿ります。

## 調査範囲

1. `aidev.yaml` の `knowledge.evidence.include` / `exclude` が読み取り調査範囲を決めます
2. `package.include` / `exclude` はWikiの**生成対象**であり、調査範囲ではありません
3. `secrets_paths` は常に除外します。evidenceに含まれて見えても読みません
4. CLIからtask JSONが渡された場合、`evidence.paths` がtarget commitの正確なtracked・非secret一覧です

生成対象が文書だけでも、evidenceに含まれるコード、テスト、設定、CIを横断してください。`--scope` で狭まるのも生成対象だけです。

## 調査順序

1. **既存Wiki** — `.aidev/knowledge/index.md` を仮説と索引として使う。ただし古い可能性があるため正本扱いしない
2. **リポジトリマニフェスト** — 言語、workspace、entrypoint、build方法を特定する

| ファイル | 言語 / ビルド |
| --- | --- |
| `package.json` | Node。`scripts` とworkspaceを確認 |
| `pyproject.toml` / `setup.cfg` / `requirements.txt` | Python |
| `go.mod` / `go.work` | Go |
| `Cargo.toml` | Rust |
| `pom.xml` / `build.gradle(.kts)` / `settings.gradle(.kts)` | Java / Kotlin |
| `*.csproj` / `*.sln` / `Directory.Build.props` | .NET |
| `Gemfile` | Ruby |
| `composer.json` | PHP |
| `CMakeLists.txt` / `Makefile` | C / C++ |

3. **CI定義** — `azure-pipelines*.yml`、`.github/workflows/*`、`Jenkinsfile`。CIが実行するcommandをREADMEより強い根拠として扱う
4. **ディレクトリ構造** — evidence path一覧を深さ2〜3で分類し、生成物・依存物を除外する。最初から全ファイル本文を読まない
5. **エントリポイントと公開境界** — `main` / `index` / `Program.cs` / `__main__.py` / `cmd/`、export、route、handler、DI登録を追う
6. **依存とデータフロー** — import/call/referenceを `Grep` で追い、呼び出し元・呼び出し先・型・設定・テストを読む
7. **文書の照合** — READMEや設計文書の主張を実装とテストで確認し、矛盾を記録する

## モノレポ

`package.json` の `workspaces`、`pnpm-workspace.yaml`、`lerna.json`、`go.work`、Cargo workspace、Gradle settingsなどで判定します。workspace単位で上記の調査を繰り返し、最後にworkspace間依存を統合します。`Task` を使う場合も、各担当へevidence pathの部分集合を渡します。

## 記録する内容

- 言語・frameworkとversion（manifestを根拠にする）
- build / lint / typecheck / testの実command（CI・scriptを根拠にする）
- entrypoint、公開API、主要moduleの責務
- module間依存、主要データフロー、外部境界
- testが保証する振る舞い
- 文書と実装の不一致
- 分からなかったこと（推測で埋めず「未確認」）

## やってはいけないこと

- `knowledge.evidence` 外または `secrets_paths` 該当を読む
- `package.include` を調査境界だと解釈する
- 生成物、依存物、minified bundleを読む
- lockfileを無目的に全文読む
- Markdownだけから実装の振る舞いを断定する
- 見つからなかったものを「存在しない」と断定する

関連: [[knowledge-usage]] / [[change-planning]] / [[test-and-verify]] / [[secure-coding]]
