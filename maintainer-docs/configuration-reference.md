# `aidev.yaml` configuration reference

`aidev.yaml`は、同じ中央kitを使うラッパー間のPKG固有差分を保持します。秘密値は保持せず、認証情報は環境変数名だけを参照します。schemaの正本は`cli/lib/config.js`です。

## 全体例

次は現行schemaで利用できる項目をまとめた例です。`aidev init`が生成する内容より多くの任意項目を含みます。

```yaml
version: 1

package:
  name: my-pkg
  include:
    - "src/src/**"
    - "src/docs/**"
  exclude:
    - "**/node_modules/**"
    - "**/generated/**"
    - "**/vendor/**"

secrets_paths:
  - "src/**/*.pem"
  - "src/**/*.pfx"
  - "src/**/secrets/**"
  - "src/.env*"

azure_devops:
  organization: my-org
  project: my-project
  repository: my-pkg
  wrapper_repository: my-pkg-ai-dev
  auth_env: AZURE_DEVOPS_PAT
  triage:
    labels: ["ai-ready"]
    area_path: "my-project\\Backend"

sync:
  tracking_branch: main
  auto_pr: true
  wrapper_pr:
    target_branch: main
    reviewers: ["team-leads"]
  remote_check_timeout_ms: 3000
  remote_check_ttl_minutes: 60
  lease_ttl_minutes: 120

task:
  state_backend: azure_devops
  cache_dir: .aidev/tasks
  lease_ttl_minutes: 120
  retention_days: 90
  max_concurrent: 3

knowledge:
  max_files_per_dir: 20
  subagent_concurrency: 4
  inventory_shard_size: 2000
  agent_timeout_ms: 1800000

model:
  agent: sonnet

self_evolution:
  enabled: true
  cadence: weekly

quality_gates:
  format: npm run format
  lint: npm run lint
  typecheck: npm run typecheck
  test: npm test
```

## 必須項目

| key | 型 | 説明 |
| --- | --- | --- |
| `version` | integer | 現在は`1`のみ |
| `package.name` | string | 表示・生成Wikiに使うPKG名 |
| `azure_devops.organization` | string | Azure DevOps organization |
| `azure_devops.project` | string | project |
| `azure_devops.repository` | string | 対象PKG repository |

`package.include`が空でもschema上は通りますが、Wiki対象がなくなるため、実用上はPKGに合うglobを必ず設定します。

## `package`

| key | 型 | 既定 | 説明 |
| --- | --- | --- | --- |
| `name` | string | 必須 | PKG名 |
| `include` | string[] | `init`では`src/src/**`, `src/docs/**` | inventoryへ含めるpath |
| `exclude` | string[] | `init`では依存物・生成物・vendor | `include`から除外するpath |

pathはラッパーリポジトリroot基準です。対象PKGが`src/`にあるため、通常は`src/`から始まります。

## `secrets_paths`

AIに読み書きさせず、Wikiでも内容をマスクするglobの配列です。policy候補を作ると、各項目は`protected`へ追加されます。

設定変更後はpolicyを再生成してください。

```bash
aidev permission reconfigure
# candidateをレビュー
aidev permission reconfigure --approve
```

## `azure_devops`

| key | 型 | 既定 | 説明 |
| --- | --- | --- | --- |
| `organization` | string | 必須 | organization名 |
| `project` | string | 必須 | project名 |
| `repository` | string | 必須 | PKG repository名またはID |
| `wrapper_repository` | string/null | `init`が`<repository>-ai-dev`を提案 | 同期PRの作成先。未設定なら自動PR不可 |
| `auth_env` | string | `AZURE_DEVOPS_PAT` | PATを保持する環境変数名 |
| `triage.labels` | string[] | `[]` | Work Itemのopt-in用として設計されたlabel |
| `triage.area_path` | string/null | `null` | Work Itemのopt-in用area path |

`pat`、`token`、`password`、`secret`というkeyは拒否されます。長いcredentialらしい文字列も`auth_env`以外では拒否されます。

`triage`は将来の`issue-to-pr`設計に含まれますが、Work Itemからtaskを初期作成するproduction経路は未接続です。

## `sync`

| key | 型 | 既定 | 制約・説明 |
| --- | --- | --- | --- |
| `tracking_branch` | string | `main` | `src`で追跡する`origin/<branch>` |
| `auto_pr` | boolean | `true` | sync後にbranch pushとwrapper PRを試みる |
| `wrapper_pr.target_branch` | string | `main` | wrapper PRのtarget |
| `wrapper_pr.reviewers` | string[] | `[]` | PR作成時のreviewer指定 |
| `remote_check_timeout_ms` | integer | `3000` | 100〜60000ms |
| `remote_check_ttl_minutes` | integer | `60` | 0〜10080分 |
| `lease_ttl_minutes` | integer | `120` | 1〜10080分 |

`auto_pr: true`でも、`wrapper_repository`、PAT、originへのpush権限がなければPRは作成されません。syncで計算した差分は作業ツリーまたはlocal branchに残ります。

## `task`

| key | 型 | 既定 | 制約・説明 |
| --- | --- | --- | --- |
| `state_backend` | string | `azure_devops` | `azure_devops`または`local` |
| `cache_dir` | string | `.aidev/tasks` | task JSONのlocal cache |
| `lease_ttl_minutes` | integer | `120` | 1〜10080分 |
| `retention_days` | integer | `90` | 1〜3650日 |
| `max_concurrent` | integer | `3` | 1〜100 |

これらの設定とtask操作コードは存在しますが、Work Itemからcacheを初期作成する公開CLI経路と、別端末でAzure DevOpsからcacheを再構築する処理は未実装です。

## `knowledge`

| key | 型 | 既定 | 制約・説明 |
| --- | --- | --- | --- |
| `max_files_per_dir` | integer | `20` | 1〜1000。agentがページ構造を決める目安 |
| `subagent_concurrency` | integer | `4` | 1〜64。knowledge-builder用設定 |
| `inventory_shard_size` | integer | `2000` | 1〜100000 records/shard |
| `agent_timeout_ms` | integer | `1800000` | 10000〜7200000ms |

構造化inventoryはCLIが生成します。prose本文は`--agent`指定時だけknowledge-builderが生成します。

## `model`

`model.agent`は、`aidev knowledge build --agent`や`aidev sync --agent`が起動するClaude Code subprocessへ渡すモデルです。対話セッションのモデルではありません。

優先順位は次のとおりです。

```text
--agent-model <value>
  > aidev.yaml の model.agent
  > kit default（sonnet）
```

alias、固定model名、provider固有IDを許容するため既知modelの列挙ではなく文字形を検証します。

- 最大200文字
- 先頭は英数字
- 使用可能文字は英数字と`. _ - : / @ [ ]`
- 空文字は「`--model`を渡さずClaude Codeへ任せる」

対話セッションはClaude Code側で解決します。チーム共通既定は`.claude/settings.json`、個人上書きはgitignore済みの`.claude/settings.local.json`です。同梱agentのfrontmatterは上位設定を固定modelで打ち消さないよう`model: inherit`を使用します。

## `self_evolution`

| key | 型 | 既定 | 説明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Stop hookで観測journalへ記録するか |
| `cadence` | string | `weekly` | 将来の集約頻度を表すmetadata |

現時点で実装されているのはlocal journalへの記録までです。集約、中央kit branch、PR作成は実装されていません。

## `quality_gates`

任意のkeyからcommand文字列へのmappingです。PostToolUse hookが対象編集後に`src/`内で実行します。

- 実在し、非対話で終了するコマンドだけを指定する
- watch modeや開発serverを指定しない
- PKGごとの順序・コストを確認する
- commandが失敗したときに、AIが安全に修正できる範囲をpolicyと合わせる

## 不明なkey

現行validatorは定義済みkeyを正規化して利用します。未定義keyを書いても機能が増えるわけではありません。新しい設定を追加するときは、validator、既定値、init template、利用箇所、README、移行テストを同時に更新してください。
