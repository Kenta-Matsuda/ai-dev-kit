# ai-dev-kit

チームの各リポジトリ（PKG）に **共通の AI コーディングツール実行環境** と **PKG 専用の LLM Wiki** を配置し、`aidev` CLI で保守するキットです。

導入すると、PKG の clone に次が入ります。

- `.claude/`（agents・skills・hooks）、`CLAUDE.md` — チーム共通の Claude Code 設定。kit のテンプレートから `aidev sync tools` が配置・更新する。`.mcp.json` は PKG の所有（MCP server は PKG が用意する）
- `.aidev/knowledge/` — AI がソースを読む前に引く、根拠付きの Wiki。今いるブランチの HEAD を説明し、コミットのたびに hook が追従させて別コミットとして同じ PR に積む（手動は `aidev sync wiki`）
- `.aidev/policy.yaml` — AI が書いてよいパスの定義。hooks が毎回の書き込みを検査
- `aidev.yaml` — PKG 固有の設定（生成対象・秘密パス・Azure DevOps 接続先）

PR のマージは常に人間が行います。生成された Wiki のレビューは利用者の責任です。開発は `aidev run workflow <name>` から行い、workflow（`.aidev/workflows/<name>/workflow.yaml`）は PR でレビューされて `main` にあるものだけが実行されます。agent は `aidev sync wiki` と workflow から、`aidev.yaml` の `tools.agent`（agent ごとの上書きは `tools.agents.<name>`）で決めたツールで起動します。実機で検証済みのツールは Claude Code で、GitHub Copilot CLI・OpenAI Codex CLI・Kiro CLI のアダプタと hooks は各ツールの公開仕様に沿って実装しており未検証です。hosting は Azure DevOps または generic（git のみ）です。

## インストール（端末につき 1 回）

前提: Node.js 20+、Git、Claude Code 2.1.259+（他のツールを使う場合はそのツールの CLI）。

```powershell
# Windows
git clone <kit-url> C:\tools\ai-dev-kit
C:\tools\ai-dev-kit\scripts\install.ps1
```

```bash
# macOS / Linux / WSL
git clone <kit-url> ~/ai-dev-kit
~/ai-dev-kit/scripts/install.sh
```

新しいターミナルで `aidev --version` と `aidev doctor` を実行して確認します。

## PKG に導入する（導入担当者、PKG につき 1 人）

```bash
cd <pkg>
aidev init                              # 4 つの質問に答え、LLM Wiki を生成する（Enter で既定値。止まったら再実行。agent のツールが無いと本文未生成で exit 1）
aidev create policy --approve    # init で policy を置かなかった場合
aidev check                             # 0 なら整合
git add aidev.yaml .aidev .claude CLAUDE.md
git commit -m "chore: adopt ai-dev-kit"
```

PR を作ってマージします。Azure DevOps の PKG では、事前に `AZURE_DEVOPS_PAT` を環境変数に設定します（ファイルには書きません）。

## 導入済みの PKG を使う（メンバー）

```bash
git pull
aidev init       # 質問なし。配布ファイルの確認と端末への登録だけ
aidev check     # 2 行目が ✅ なら準備完了
claude
```

## 日常

- `aidev check` — 状態を 1 画面で確認（`[ai-dev-kit] head=… knowledge=… tracking=…` と判定。`⚠️ … run "aidev sync wiki"` なら更新）
- `git commit` — AI ツールの中なら hook が Wiki の構造を更新し、本文は knowledge-builder のサブエージェントが書き、`aidev sync wiki --no-agent` で別コミットになる
- `aidev sync wiki` — 手動で Wiki を HEAD に追従させ、別コミットとして積む。`main` 上では一時 worktree で更新し `aidev/wiki-<sha12>` の PR を作る
- `aidev update` — kit 本体（CLI とテンプレート）を更新
- `aidev sync tools` — 新しいテンプレートを PKG に取り込む（編集済みはマージ。差分をコミット）
- `aidev check` — CI 用。0=ok / 2=drift / 3=権限 / 4=Wiki

## ドキュメント

ユーザーガイドとコマンドリファレンス（1 コマンド 1 ページ）は `docs/user-guide/` にあります。

```bash
npm ci
npm run docs:build     # build/docs/ai-dev-kit-user-guide.html（日本語）と ai-dev-kit-user-guide.en.html（英語）
```

- 導入担当者の手順、メンバーの手順、日常の使い方、LLM Wiki、権限、自動化、トラブルシューティング
- `aidev.yaml` リファレンス、環境変数、PKG 内のファイル
- `aidev init` / `check` / `doctor [<package>]` / `run|estimate|create|modify|edit|submit|list|remove … workflow` / `create agent|skill|policy` / `sync tools|wiki [<package>]` / `update` / `uninstall [<package>] [--all]`。詳細は `docs/developer-guide/cli-reference.md`

CI の例は `pipelines/azure-pipelines-check.yml`（PR ごとの `aidev check`）と `pipelines/azure-pipelines-wiki.yml`（夜間に `main` で `aidev sync wiki --branch`。agent のツールと認証情報が必要）です。

kit 自体の設計と保守は [docs/developer-guide/](docs/developer-guide/README.md) を参照してください。

