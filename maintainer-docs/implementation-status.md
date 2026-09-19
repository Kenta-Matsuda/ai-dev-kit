# Implementation status, known gaps, and target designs

この文書は「設計として望んでいること」と「現在production codeから到達できること」を区別するための台帳です。利用者向けREADMEでは、ここで**実装済み**または明示した**部分実装**だけを案内します。

## statusの定義

| status | 意味 |
| --- | --- |
| 実装済み | 公開CLIまたは同梱設定から到達でき、主要な失敗処理も存在する |
| 部分実装 | 部品はあるが、入口・復元・安全弁などに不足がある |
| 設計のみ | 文書・設定・agent指示には存在するが、production codeの完結経路がない |

## 機能matrix

| 機能 | status | 現在の到達範囲 | 主な不足 |
| --- | --- | --- | --- |
| Windows/POSIX installer | 実装済み | Node/Git確認、checkoutを指すlauncher作成 | checkout移動時は再installが必要 |
| `aidev init` | 実装済み | config、`.claude/`実体化、lock、後続案内 | policy/Wikiは別command。ADO接続試験はしない |
| static drift / `aidev check` | 実装済み | lock、policy、3SHA、strict warning | external serviceの完全診断ではない |
| `aidev doctor` | 実装済み | local runtime、repo、PAT有無、proxy、3SHA | Claude/npxの検査、ADO API認証試験はない |
| `aidev update` | 実装済み | 限定KIT_PATHSのfetch/checkout、`.claude`再生成 | package/pipeline/gitignore/maintainer docsは対象外 |
| permission candidate / approval | 実装済み | configから機械生成、human approve、weakening検出 | `permission-setting` agentとの対話生成ではない |
| structured Wiki | 実装済み | scan、mask、blob diff、inventory、manifest、checkpoint | prose意味品質は担当しない |
| prose Wiki agent | 実装済み（opt-in） | `--agent`でknowledge-builder起動、timeout/model指定 | `claude`なしではskip。costは外部管理 |
| 3SHA / sync lease | 実装済み | local/remote判定、TTL lease、resume/abort | hand-edit扱いがknowledge buildとsyncで不統一 |
| `aidev sync` | 実装済み | fetch、bump、structured Wiki、任意agent、commit/push/PR | ADO/PAT/push失敗時はmanual completionが必要 |
| wrapper PR dedup | 実装済み | stream marker検索、同branch更新、旧PR注記 | 新targetでは旧PRを自動closeしない |
| Azure Pipelines例 | 実装済み | check pipeline、scheduled sync pipeline | scheduled syncは`--agent`なし |
| Claude hooks | 部分実装 | freshness、write guard、quality gate、journal/queue記録 | background queue consumerなし。sandboxではない |
| workflow scaffold/approval/run | 部分実装 | JS scaffold、hash承認、iteration/time/failure/allowlist | token/USD計測、destructive前human gateなし。creator agent未接続 |
| task subcommands | 部分実装 | 既存local JSONのlist/show/resume/advance/abandon | 初期作成、ADOからのcache再構築なし |
| issue-to-pr orchestration | 設計のみ（agent定義あり） | agent promptとstate helperの一部 | Work Item入口、task作成、public work lease、E2E接続なし |
| cross-machine task resume | 設計のみ | Azure DevOps helperは一部存在 | Work Item/PRから決定論的cache再構築なし |
| self-evolution observation | 部分実装 | Stop hookがlocal journalを記録 | 集約、branch、中央kit PR作成なし |
| managed background refresh | 設計のみ | pending refresh fileを記録 | queueを消費するrunnerなし |
| MCP launcher | 実装済み | config/env解決、固定版packageのstdio起動 | offline/registry unavailableでは起動不可 |
| eject / re-adopt | 実装済み | dry-run、明示解除、marker、initによる再採用 | 高影響のため人間reviewが必要 |

## READMEで避ける表現

- 「すべて実装予定」: CLI moduleは既に存在する
- 「init 1 commandでpolicyとWikiまで完成」: どちらも別command
- 「initは`.claude`を生成しない」: templateから実体化する
- 「Python 3.11+が必要」: 現行workflowはNode.js
- 「knowledge buildが既定でproseを生成」: `--agent`が必要
- 「doctorがAzure DevOps認証を検証」: PAT環境変数の存在確認まで
- 「issue-to-prはどの端末からでも再開可能」: cache再構築経路がない
- 「Stop hookが非同期runnerでWikiを更新」: queue consumerがない
- 「自己進化が自動でPRを作る」: local journal記録まで
- 「workflowのtoken/USD budgetが強制される」: 実消費計測がない
- 「open sync PRを常に同じPRのまま新SHAへ更新」: source branchが変わるため新PRを作り旧PRを注記する場合がある

## issue-to-prのtarget design

以下は将来接続したい状態機械であり、現在のE2E機能ではありません。

```text
IMPLEMENTING
    │ PKG PR作成
    ▼
PKG_PR_OPEN ── close ──> PKG_PR_ABANDONED
    │ human merge + merge result SHA解決
    ▼
PKG_PR_MERGED
    │ sync開始
    ▼
SYNCHRONIZING ── failure ──> SYNC_FAILED
    │                           │ resume
    │<──────────────────────────┘
    │ Wiki更新 + check
    ▼
WRAPPER_PR_OPEN ── close ──> WRAPPER_PR_ABANDONED
    │ human merge
    ▼
DONE

any state ──> BLOCKED
```

完成条件:

1. Work Item IDを入口に、本文を外部データとして取得・schema化する
2. `triage.labels` / `area_path`でopt-inを検証する
3. 専用branchと許可pathを確定する
4. CLIだけが`.aidev/leases/<taskId>.json`を作る公開・監査可能な経路を用意する
5. PKG PR APIから実merge result SHAを取得する
6. task cacheがなくてもWork Item、PR、sync PR metadataから状態を再構築する
7. 同じ状態機械をuser resume、SessionStart、pipelineから呼べるようにする
8. PKG PRとwrapper PRは人間がmergeし、自動mergeしない

cacheに保持するのはID、branch、SHA、状態、履歴など導出・検証可能なmetadataだけとし、Work Item本文、diff、secretを保存しません。

## self-evolutionのtarget design

現在は`.aidev/cache/evolution-journal.json`への観測記録だけです。将来PR生成まで接続する場合も、次の制約を維持します。

- 毎sessionではなくcadence単位で重複を集約する
- 変更先は中央kitであり、wrapperのstatic assetを直接変更しない
- settings、MCP、policy、認証、security制御は自動変更対象外
- token削減を理由に確認、テスト、権限制限を削らない
- 根拠、影響範囲、期待効果、副作用、安全機構の差分をPRへ記載する
- human review必須、自動merge禁止

## known gaps

### Wiki hand-edit policyの不統一

`knowledge build`はself hash不一致を検出すると`--force`なしで停止します。`sync`は警告後もstructured rewriteへ進む経路があります。共通policyへ統一するまで、READMEでは手編集禁止と事前diffを案内します。

### pending proseのseverity

structured inventoryがtarget SHAへ進んだ時点で3SHAは一致し、`pendingPaths`はwarningです。これによりleaseを解放しsyncを完了できますが、prose完全性を必須にしたいCIでは`--agent`と`check --strict`が必要です。strictはremote aheadなど他warningもexit 2へします。

### update coverage

`aidev update`は`package.json`、`pipelines/`、`.gitignore`、`maintainer-docs/`を取り込みません。wrapperのCLIとpackage metadataがずれる可能性があります。対象を広げる場合はwrapper固有ファイルを誤上書きしないmigration設計が必要です。

### workflow safety

content hash、iteration、time、same failure、basename allowlistは実装済みです。token/USD、destructive operation approvalは定義だけです。UI上の表示を強制制御と誤解させないでください。

### hooksの限界

- settingsはmanaged settingsではなく利用者が変更可能
- Bash path抽出は既知command/redirection中心で完全ではない
- hookを削除するローカル変更そのものを、そのhookで確実には止められない
- static driftをCIで検出し、branch policyでmergeを止める必要がある

## 適用先ごとに決めること

| 項目 | 判断理由 |
| --- | --- |
| PKGのmerge方式 | merge result SHAと運用確認に影響 |
| tracking branchとforce-push policy | syncの非fast-forward頻度に影響 |
| wrapper PR botの認証主体 | 人間PATをautomationへ流用しないため |
| PAT scopeと有効期限 | server側の最終権限制御 |
| scheduled sync間隔 | remote aheadの許容時間と実行cost |
| proseをCIで生成するか | Claude実行環境、token cost、secret handling |
| large PKGのshard/concurrency | manifest sizeとagent負荷 |
| branch policy / required reviewer | kit control surfaceの保護 |
| 1 PKG = 1 wrapperの例外 | monorepoや複数PKGでは設計見直しが必要 |

## 保守時の完了条件

機能や文書を更新するときは、少なくとも次を確認します。

1. 利用者READMEが現在到達可能な操作だけを案内している
2. CLI help、README、`FLAGS`が一致している
3. `aidev.yaml`のdefault、validator、init template、referenceが一致している
4. stdout JSON契約とexit codeを壊していない
5. WindowsとPOSIX installer、path、shell差を考慮した
6. dry-runのnetwork/cache副作用を明記した
7. secretがconfig、log、PR description、fixtureへ入っていない
8. `npm run check`が成功する
9. wrapperへ影響する変更は`aidev update`の対象範囲も検討した
