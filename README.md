# ai-dev-kit

チームの各リポジトリ（PKG）に **共通の AI コーディングツール実行環境** と **PKG 専用の LLM Wiki** を配置し、`aidev` CLI で保守するキットです。

導入すると、PKG の clone に次が入ります。

- `.claude/`（agents・skills・hooks）、`CLAUDE.md`、`.mcp.json` — チーム共通の Claude Code 設定。kit のテンプレートから置かれ、チームが編集できる。新しいテンプレートは `aidev apply` で取り込む（編集済みはマージ、衝突はマーカーで残す）。`aidev.yaml` の `tools.default` に `copilot` / `codex` / `kiro` を足すと、そのツール用のテンプレート（`.github/copilot-instructions.md` と `.github/agents/`、`AGENTS.md`、`.kiro/`）も置かれる
- `.aidev/knowledge/` — AI がソースを読む前に引く、根拠付きの Wiki。tracking branch が進んだら `aidev sync` が PR で追従
- `.aidev/policy.yaml` — AI が書いてよいパスの定義。hooks が毎回の書き込みを検査
- `aidev.yaml` — PKG 固有の設定（生成対象・秘密パス・Azure DevOps 接続先）

PR のマージは常に人間が行います。agent は `aidev knowledge build` / `aidev sync` / `aidev agent run` / workflow の `ctx.agent` から、`aidev.yaml` の `tools.agent`（agent ごとの上書きは `tools.agents.<name>`）で決めたツールで起動します。実機で検証済みのツールは Claude Code で、GitHub Copilot CLI・OpenAI Codex CLI・Kiro CLI のアダプタは各ツールの非対話モードの公開仕様に沿って実装しており未検証です。hooks による policy の実行時強制は Claude Code だけです。hosting は Azure DevOps または generic（git のみ）です。

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
aidev init                              # 4 つの質問に答え、LLM Wiki を生成する（Enter で既定値。止まったら再実行）
aidev permission configure --approve    # init で policy を置かなかった場合
aidev check                             # 0 なら整合
git add aidev.yaml .aidev .claude CLAUDE.md .mcp.json
git commit -m "chore: adopt ai-dev-kit"
```

PR を作ってマージします。Azure DevOps の PKG では、事前に `AZURE_DEVOPS_PAT` を環境変数に設定します（ファイルには書きません）。

## 導入済みの PKG を使う（メンバー）

```bash
git pull
aidev init       # 質問なし。配布ファイルの確認と端末への登録だけ
aidev status     # 2 行目が ✅ なら準備完了
claude
```

## 日常

- `aidev status` — 状態を 1 画面で確認（`⚠️ … run "aidev sync"` なら `aidev sync`）
- `aidev sync` — tracking branch に追従して Wiki を更新し、`aidev/wiki-<sha>` の PR を作る
- `aidev update` — kit 本体（CLI とテンプレート）を更新
- `aidev apply` — 新しいテンプレートを PKG に取り込む（編集済みはマージ。差分をコミット）
- `aidev check` — CI 用。0=ok / 2=drift / 3=権限 / 4=Wiki

## ドキュメント

ユーザーガイドとコマンドリファレンス（1 コマンド 1 ページ）は `docs/user-guide/` にあります。

```bash
npm ci
npm run docs:build     # build/docs/ai-dev-kit-user-guide.html（日本語）と ai-dev-kit-user-guide.en.html（英語）
```

- 導入担当者の手順、メンバーの手順、日常の使い方、LLM Wiki、権限、自動化、トラブルシューティング
- `aidev.yaml` リファレンス、環境変数、PKG 内のファイル
- `aidev init` / `status` / `check` / `knowledge` / `sync` / `permission` / `task` / `workflow` / `update` / `doctor` / `eject` / `uninstall` / `hook` / `mcp`

CI の例は `pipelines/azure-pipelines-check.yml`（PR ごとの `aidev check`）と `pipelines/azure-pipelines-sync.yml`（夜間の `aidev sync`）です。

kit 自体の設計と保守は [docs/developer-guide/](docs/developer-guide/README.md) を参照してください。

