# ai-dev-kit — 自分のPKGに共通のClaude Code環境を作る

ai-dev-kitは、既存のPKGを変更せずに、チーム共通の **Claude Code実行環境**を用意するためのセットアップキットです。
中央のai-dev-kitを「ラッパーリポジトリ」の土台としてcloneし、対象PKGを`src/`サブモジュールとして組み込みます。

このREADMEは、**ai-dev-kitを使って自分のPKGへAI実行環境を導入・運用する人**のためのガイドです。ai-dev-kit自体の設計、内部データ形式、状態機械、保守上の判断は[maintainer-docs/](maintainer-docs/README.md)へ分離しています。`maintainer-docs/`は、利用PKGが持つ`docs/knowledge`や、本kitが生成する`knowledge/`とは別物です。

## 導入するとできること

| 用途 | 提供されるもの |
| --- | --- |
| Claude Code設定の統一 | 共通のAgents、Skills、hooks、MCP設定を`.claude/`などへ配置 |
| PKGごとの安全設定 | 読み取り対象、除外対象、秘密領域、書き込み権限を`aidev.yaml`とpolicyで管理 |
| AI向けPKG知識の共有 | ソースに対応したLLM Wikiをラッパー側の`knowledge/`へ生成 |
| PKG更新への追従 | `src/`の更新、Wikiの再計算、ラッパーPR作成を`aidev sync`で実行 |
| 構成のドリフト検出 | `aidev check`で共通設定、policy、ソースとWikiの不一致を検出 |
| チーム・CIでの再現 | 生成物をgit管理し、同じ環境を開発者とAzure Pipelinesで利用 |

## 最初に確認すること

ai-dev-kitは、次の運用に合う場合に使用してください。

- Claude Codeを利用する
- ソース管理・Work Item・CIにAzure DevOpsを利用する
- 対象PKGとAI実行環境を別リポジトリにし、PKGを`src/`サブモジュールとして参照できる
- AIが作成したPRと同期PRを人間がレビューし、自動マージしない
- hooksだけをセキュリティ境界とせず、最小権限の認証、必須CI、branch policyを併用できる

次の用途は対象外、または現時点では未完成です。

- Claude Code以外のAIツールとの互換レイヤー
- 既存`.claude/`設定の自動マージ
- 完全なsandboxや、個人が上書きできないmanaged settingsの配布
- Work Item取得からPKG PR、同期PRまでの完全自動`issue-to-pr`フロー
- 自己改善案を自動的に中央kitのPRへする処理

> **現在利用しやすい範囲**は、環境初期化、共通設定配布、policy生成・承認、Wiki生成、整合性チェック、PKG追従、同期PR、CIです。`issue-to-pr`、端末間のtask復元、自己進化PRなどの状況は[実装状況](maintainer-docs/implementation-status.md)を確認してください。

## 全体像

```text
中央 ai-dev-kit
      │ clone（upstreamとして保持）
      ▼
my-pkg-ai-dev/                 ← チームがClaude Codeを起動する場所
├─ src/                        ← 既存PKGのgit submodule
├─ .claude/                    ← 共通Agents / Skills / hooks
├─ aidev.yaml                  ← PKG固有設定
├─ .aidev/policy.yaml          ← 承認済み書き込みpolicy
├─ knowledge/                  ← このPKG用の生成LLM Wiki
└─ cli/、scripts/、templates/  ← aidevの実行・更新に必要
```

PKGのソース履歴は既存リポジトリに残ります。ラッパーリポジトリには、利用するPKGコミットへのポインタ、AI実行環境、生成Wikiをコミットします。

## 前提条件

### 必須

- Node.js **20以上**
- Git
- Claude Code
- 中央ai-dev-kit、対象PKG、作成するラッパーリポジトリへのアクセス
- Windows PowerShell、またはmacOS/Linux/WSLのbash

Pythonは不要です。workflowも現在はNode.jsで実行されます。

### Azure DevOps連携に必要

- Azure DevOps PATを環境変数で渡せること
- Gitのfetch/pushに必要な認証
- Azure DevOps MCPを使う場合は`npx`とnpm registryへの接続

既定のPAT環境変数名は`AZURE_DEVOPS_PAT`です。値は`aidev.yaml`、`.mcp.json`、コマンドライン引数へ書かないでください。

## 初回セットアップ

以下では、中央kitを`ai-dev-kit`、対象PKGを`my-pkg`、新しいラッパーを`my-pkg-ai-dev`とします。先にAzure DevOps上へ空の`my-pkg-ai-dev`リポジトリを作成してください。

### 1. 中央kitをラッパーの土台としてcloneする

```bash
git clone https://dev.azure.com/<org>/<project>/_git/ai-dev-kit my-pkg-ai-dev
cd my-pkg-ai-dev

git remote rename origin upstream
git remote add origin https://dev.azure.com/<org>/<project>/_git/my-pkg-ai-dev
```

- `origin`: PKG固有のラッパーリポジトリ
- `upstream`: 中央ai-dev-kit。後から`aidev update`で取り込む更新元

### 2. 対象PKGを`src/`へ追加する

```bash
git submodule add https://dev.azure.com/<org>/<project>/_git/my-pkg src
git submodule update --init --recursive
```

`src/`という配置はCLIの前提です。別名へ変更しないでください。

### 3. `aidev` CLIを使えるようにする

Windows / PowerShell:

```powershell
.\scripts\install.ps1
aidev --version
```

macOS / Linux / WSL:

```bash
./scripts/install.sh
export PATH="$HOME/.local/bin:$PATH"  # installerから案内された場合
aidev --version
```

installerは、このcheckout内の`cli/bin/aidev.js`を呼ぶlauncherを作ります。セットアップ後にラッパーのディレクトリを移動・削除するとlauncherが動かなくなるため、その場合はinstallerを再実行してください。

### 4. PATを現在のshellへ設定する

PowerShell:

```powershell
$env:AZURE_DEVOPS_PAT = "<your-pat>"
```

bash:

```bash
export AZURE_DEVOPS_PAT="<your-pat>"
```

PATは永続ファイルへ保存せず、組織の秘密情報管理方式に従って注入してください。

### 5. 初期化する

```bash
aidev init --dry-run
aidev init
```

`init`は主に次を行います。

1. `aidev.yaml`を生成する
2. `templates/claude-assets/`から`.claude/`を実体化する
3. 共通ファイルのハッシュを`.aidev-lock`へ記録する
4. PAT環境変数の有無、policyとWikiの未作成状態を案内する

`init`はpolicyやWikiを自動生成しません。次の手順を続けてください。

非対話で実行する場合は、推測できない値を明示します。

```bash
aidev init --yes \
  --org <org> \
  --project <project> \
  --repository my-pkg \
  --wrapper-repository my-pkg-ai-dev
```

既存の`.claude/`がkitの内容と異なる場合、`init`は上書きせず停止します。まず`--dry-run`で差分を確認してください。`--force`はローカル内容を破棄するため、復旧目的以外では使用しないでください。

### 6. `aidev.yaml`をPKGに合わせる

特に次を確認します。

```yaml
package:
  name: my-pkg
  include: ["src/src/**", "src/docs/**"]
  exclude:
    - "**/node_modules/**"
    - "**/generated/**"

secrets_paths:
  - "src/**/secrets/**"
  - "src/.env*"

azure_devops:
  organization: my-org
  project: my-project
  repository: my-pkg
  wrapper_repository: my-pkg-ai-dev
  auth_env: AZURE_DEVOPS_PAT

sync:
  tracking_branch: main
  auto_pr: true

model:
  agent: sonnet

# 必要なものだけ有効化
quality_gates:
  lint: npm run lint
  test: npm test
```

- `package.include`: AI向けWikiで追跡するPKG内のパス
- `package.exclude`: 生成物、依存物など追跡しないパス
- `secrets_paths`: AIに読ませず、Wikiでもマスクする領域
- `azure_devops.auth_env`: PATの値ではなく、PATを入れる環境変数名
- `quality_gates`: `src/`内で実行できる実在コマンドだけを指定

初期値の`src/src/**`や`src/docs/**`が自分のPKG構成に合わない場合は、Wiki生成前に修正してください。全項目は[設定リファレンス](maintainer-docs/configuration-reference.md)にあります。

### 7. 書き込みpolicyを生成・承認する

```bash
aidev permission configure
```

候補が`.aidev/policy.candidate.yaml`へ書かれます。内容を確認してから承認します。

```bash
aidev permission configure --approve
aidev permission show
```

承認後の`.aidev/policy.yaml`は保護対象です。直接編集せず、変更時は`aidev permission reconfigure`を使用してください。保護を弱める変更には、レビュー後さらに`--force`が必要です。

### 8. LLM Wikiを生成する

```bash
aidev knowledge build --agent
```

`--agent`を付けた場合だけ、`knowledge-builder`がprose本文を生成します。課金と実行時間を伴うため既定では無効です。

```bash
aidev knowledge build             # manifest / inventoryなど構造化部分のみ
aidev knowledge status            # SHA、未生成ページ、手編集を確認
aidev knowledge build --refresh --agent  # 中断後や差分の続き
```

`claude`コマンドが見つからない場合、構造化部分までは生成されますがproseは残ります。`knowledge status`で`pending pages`を確認してください。

### 9. 環境を確認する

```bash
aidev doctor
aidev check
```

- `doctor`: Node.js、Git、リポジトリ形状、PAT環境変数、proxy、3つのSHAを診断
- `check`: 共通ファイル、policy、PKGとWikiの整合性を検査

`doctor`はAzure DevOps APIへの完全なログイン試験や、Claude Code・`npx`の存在確認までは行いません。

### 10. 生成物をレビューしてpushする

```bash
git status --short
git diff

git add .gitmodules src aidev.yaml .claude .aidev-lock .aidev/policy.yaml knowledge
git commit -m "chore: initialize ai-dev-kit environment"
git push -u origin HEAD
```

候補ファイルやcache、PATなどが混入していないことを確認してからコミットしてください。

## 生成物と編集ルール

| パス | 役割 | 手編集 | git管理 |
| --- | --- | --- | --- |
| `aidev.yaml` | PKG固有設定 | 可 | する |
| `src/` | 対象PKGのsubmodule | PKG側の通常手順に従う | gitlinkを管理 |
| `.claude/**` | 共通Agents / Skills / hooks | 不可。中央kitへ変更を出す | する |
| `CLAUDE.md` / `.mcp.json` | 共通指示とMCP起動設定 | 不可。中央kitへ変更を出す | する |
| `.aidev-lock` | 共通ファイルのハッシュ | 不可 | する |
| `.aidev/policy.yaml` | 承認済みpolicy | CLI経由のみ | する |
| `knowledge/**` | 生成LLM Wiki | 原則不可。生成元を直す | する |
| `workflows/<name>/**` | レビュー対象のworkflow | 可 | 定義・承認情報を管理 |
| `.aidev/cache/**`、`.aidev/tasks/**`、`.aidev/leases/**` | ローカル状態 | 不可 | しない |
| `workflows/*/runs/**`、`knowledge/.cache/**` | ログ・中間生成物 | 不可 | しない |
| `cli/`、`scripts/`、`templates/` | kitの実行・更新に必要 | ラッパー側では不可 | する |

## チームメンバーのセットアップ

2人目以降は中央kitではなく、作成済みラッパーをcloneします。

```bash
git clone <my-pkg-ai-dev-url>
cd my-pkg-ai-dev
git submodule update --init --recursive
```

その後、各自のOS用installerを実行し、PATを各自のshellへ設定します。

```bash
aidev doctor
aidev check
claude
```

`.claude/settings.json`、Agents、Skills、hooksはClaude Codeのセッション開始時に読み込まれます。`aidev init`または`aidev update`後はClaude Codeを再起動してください。

## 日常運用

### AI作業を始める

AIを利用する作業はラッパーリポジトリで開始します。対象PKGだけをcloneしたディレクトリでは、共通Wiki、hooks、policyは読み込まれません。

```bash
git pull
git submodule update --init --recursive
aidev check
claude
```

> 現在の`issue-to-pr`はエンドツーエンドではありません。Work Itemから作業リースとtaskを初期作成する公開CLI経路が未接続のため、完全自動フローを前提にしないでください。

### PKGの追跡ブランチへ追従する

作業ツリーをcleanにし、最初に差分を確認します。

```bash
aidev knowledge status
aidev sync --dry-run
aidev sync --agent
aidev check
```

`aidev sync --agent`は次を行います。

1. `src/`の追跡ブランチをfetchする
2. `src/`を対象SHAへ進める
3. `knowledge/`のmanifest / inventoryを更新する
4. `knowledge-builder`で必要なproseを更新する
5. 条件が揃えば同期branchをpushし、ラッパーPRを作成する

PRを作らず作業ツリーで確認する場合は`--no-pr`を使用します。

```bash
aidev sync --no-pr --agent
```

中断時は、表示されたSHAと差分を確認してから次のどちらかを選びます。

```bash
aidev sync --resume  # 続行
aidev sync --abort   # 元のsrc SHAへ戻してleaseを解放
```

`--dry-run`でもfetchによりremote-tracking refは更新されますが、作業ツリーは変更しません。`--agent`なしの`sync`は構造化Wikiだけを更新し、proseがpendingのままになることがあります。

### 中央kitの更新を取り込む

作業ツリーをcleanにして実行します。

```bash
aidev update --dry-run
aidev update
git diff
aidev check
```

差分をレビューしてラッパー側へコミットし、Claude Codeを再起動します。ラッパー固有の`aidev.yaml`、`knowledge/`、`src/`は更新対象ではありません。`--force`はkit由来ファイルのローカル変更を破棄し得るため、通常運用では使わないでください。

### policyを変更する

`aidev.yaml`の`secrets_paths`などを変更した後に候補を再生成します。

```bash
aidev permission reconfigure
# 現行policyと.aidev/policy.candidate.yamlをレビュー
aidev permission reconfigure --approve
```

### workflowを作成・実行する

```bash
aidev workflow new my-flow
git diff -- workflows/my-flow/
aidev workflow approve my-flow
aidev workflow run my-flow
```

`workflow.yaml`と`steps.js`を必ずレビューしてください。承認後に内容が変わると、再承認するまで実行されません。token・金額上限や破壊操作前の人間承認は現時点で実消費量を強制停止する仕組みではないため、workflowへ任せきりにしないでください。

## モデルを変更する

対話中のClaude Codeモデルと、`aidev ... --agent`が起動するモデルは別に設定します。

### 各開発者の対話セッション

`.claude/settings.local.json`を作成します。このファイルはgit管理外で、ドリフト検出対象外です。

```json
{ "model": "opus" }
```

`.claude/settings.json`は中央kit管理なので直接変更しないでください。

### Wiki生成など、CLIが起動するエージェント

PKGの既定は`aidev.yaml`へ設定します。

```yaml
model:
  agent: sonnet
```

1回だけ変更する場合はflagを使用します。

```bash
aidev knowledge build --agent --agent-model opus
aidev sync --agent --agent-model opus
```

空文字を指定すると`--model`を渡さず、Claude Code自身の解決へ任せます。

## 主なCLIコマンド

| コマンド | 使う場面 |
| --- | --- |
| `aidev init` | 初回セットアップ。先に`--dry-run`を推奨 |
| `aidev doctor` | 環境・設定・認証変数・SHAの診断 |
| `aidev plan` | `init` / `update` / `sync`の概算確認 |
| `aidev update` | `upstream`から中央kitの管理対象を更新 |
| `aidev check` | ドリフト、policy、PKGとWikiの整合性を検査 |
| `aidev knowledge build\|status` | LLM Wikiの生成・状態確認 |
| `aidev permission configure\|reconfigure\|show` | policy候補、再生成、表示 |
| `aidev sync` | PKG追跡branchへの追従、Wiki更新、同期PR |
| `aidev workflow new\|approve\|run\|list` | workflowの作成、承認、実行、一覧 |
| `aidev eject` | kit管理から外す。必ず`--dry-run`後に実行 |

有効なoptionは実装を正本として確認できます。

```bash
aidev --help
aidev <command> --help
```

`aidev hook ...`と`aidev mcp azure-devops`は通常、`.claude/settings.json`と`.mcp.json`から呼ばれる内部コマンドです。`aidev task ...`は既存ローカルtaskの操作部分のみ実装済みで、通常の導入フローにはまだ含めません。

### 終了コード

| code | 意味 |
| --- | --- |
| `0` | 成功 |
| `1` | 一般エラー |
| `2` | kit管理ファイルのドリフト。`--strict`では警告も該当 |
| `3` | policy違反またはpolicy未配置 |
| `4` | `src/`とWikiの対象SHAが不一致 |

PKGのremoteが手元より先行しているだけなら通常は警告で、手元の`src/`とWikiが一致していれば作業継続可能です。CIで警告も失敗にする場合は`aidev check --strict`を使用してください。

## Azure Pipelinesへ組み込む

同梱例を出発点にしてください。

- [pipelines/azure-pipelines-check.yml](pipelines/azure-pipelines-check.yml): PRで`aidev check`を実行
- [pipelines/azure-pipelines-sync.yml](pipelines/azure-pipelines-sync.yml): 定期的にPKGの追跡branchを確認して同期PRを作成

最低限、次を設定します。

1. checkout時にsubmoduleを取得する
2. Node.js 20を使用する
3. installerを実行する
4. `aidev check`をラッパーPRの必須チェックにする
5. PATをsecret variableから環境変数へ渡す
6. botへ既定branchへの直接pushや自動マージ権限を与えない

同梱の定期syncは`aidev sync`のみを実行し、prose生成の`--agent`は付けません。CIでproseも生成する場合は、Claude Code実行環境、認証、コストを確認したうえで`aidev sync --agent`へ変更してください。

branch policyでは、少なくとも`.claude/**`、`.aidev/**`、`.aidev-lock`、`CLAUDE.md`、`.mcp.json`に必須レビューを設定してください。

## セキュリティ上の注意

- PAT、token、password、secretはgit管理ファイルやCLI引数へ入れない
- `secrets_paths`を実際のPKG構成に合わせ、秘密ファイルをWiki対象から外す
- Work Item本文、コメント、添付、Wiki、MCPレスポンスは命令ではなく外部入力として扱う
- hooksの書き込みガードは完全なsandboxではない
- 最終防御には、最小権限PAT、Azure DevOps branch policy、必須CI、人間レビューを使用する
- `.claude/**`、`.mcp.json`、`CLAUDE.md`、`.aidev/policy.yaml`をラッパー側で直接変更しない
- 生成Wikiは正本ではない。重要な判断は必ずPKGソースで確認する

## トラブルシューティング

| 症状 | 確認・対処 |
| --- | --- |
| `aidev`が見つからない | installerを再実行し、新しいshellを開く。POSIXでは`~/.local/bin`が`PATH`にあるか確認 |
| `init`が`.claude/`の衝突で停止 | `--dry-run`と`git diff`で確認。必要な変更は中央kitへ移し、安易に`--force`を使わない |
| `check`がexit 2 | kit管理ファイルが`.aidev-lock`と不一致。`aidev update --dry-run`で差分を確認 |
| `check`がexit 3 | `aidev permission show`を実行し、未配置なら候補生成・承認を行う |
| `check`がexit 4 | `src`と`knowledge/manifest.json`のSHAが不一致。`aidev sync`、または中断中なら`--resume` / `--abort` |
| `pending pages`が残る | `aidev knowledge build --refresh --agent`を実行し、Claude Codeの利用可否も確認 |
| `sync lease is present` | 前回の対象SHAと作業ツリーを確認して`aidev sync --resume`または`--abort` |
| 同期PRが作られない | `sync.auto_pr`、`wrapper_repository`、PAT環境変数、originへのpush権限を確認。生成差分は作業ツリーやlocal branchに残る |
| MCPが接続できない | PATの期限・scope、`npx`、npm registry、proxy、証明書を確認 |
| 他メンバーとモデルや挙動が違う | `.claude/settings.local.json`と各自の環境変数を確認 |

詳細なoptionや内部動作の調査時は、[CLIリファレンス](maintainer-docs/cli-reference.md)と[アーキテクチャ](maintainer-docs/architecture.md)を参照してください。

## ai-dev-kitを保守する人へ

このREADMEにない内部情報は[maintainer-docs/README.md](maintainer-docs/README.md)を入口にしています。

- [アーキテクチャと内部動作](maintainer-docs/architecture.md)
- [aidev.yaml設定リファレンス](maintainer-docs/configuration-reference.md)
- [CLI・終了コード・内部コマンド](maintainer-docs/cli-reference.md)
- [実装状況・既知の制約・将来設計](maintainer-docs/implementation-status.md)

変更後の保守者向け検証は`npm run check`です。利用PKGの`knowledge/`や`docs/knowledge`へ、ai-dev-kit本体の設計資料を混在させないでください。
