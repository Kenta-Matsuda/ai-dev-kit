# Implementation status, known gaps, and target designs

この文書は「設計として望んでいること」と「現在production codeから到達できること」を区別する台帳です。利用者ガイドには、ここで**実装済み**または明示した**部分実装**だけを書きます。対象は0.2.0（PKG clone方式）です。

## statusの定義

| status | 意味 |
| --- | --- |
| 実装済み | 公開CLIまたは同梱設定から到達でき、主要な失敗処理も存在する |
| 部分実装 | 部品はあるが、入口・復元・安全弁などに不足がある |
| 未実装 | 文書・設定・agent指示には存在するが、production codeの完結経路がない |

## 機能matrix

| 機能 | status | 現在の到達範囲 | 主な不足 |
| --- | --- | --- | --- |
| installer（Windows / POSIX） | 実装済み | Node 20+ / Git確認、kit checkoutを指すlauncher作成、PKGからのinstall拒否 | checkoutを移動したら再install |
| `aidev init` | 実装済み | 質問（初回のみ）、`aidev.yaml` v2、`.aidev/.gitignore`、選んだtoolのtemplate適用（初回のみ）、`materialized.json`、registry、policy候補/配置、eject markerの解除、Wiki build | Azure DevOps接続試験はしない |
| tool config apply / `aidev check` | 実装済み | `templates/<tool>/`の適用、pristine置換、teamの編集保持、3-way merge（base = lockの`kitCommit`のtemplate）、conflict marker、解消の記録、prune / retire、`check`は未解消conflict・kit hooks欠落・record欠落だけをexit 2 | kit checkoutにbase commitが無い（shallow）とmergeできず衝突扱い。`.claude/settings.local.json`は検査しない（設計どおり） |
| `aidev update` / `aidev apply` | 実装済み | `update`はkit checkoutのfast-forwardと「applyが必要なPKG」の一覧、`apply`はPKGへの適用（上記） | commitは利用者が行う |
| `aidev status` / `aidev doctor` | 実装済み | 一画面表示、環境診断、`claude` version、token有無、remote到達性 | Azure DevOps API認証試験はない |

| permission candidate / approval | 実装済み | `aidev.yaml`から機械生成、`--approve`、弱体化検出と`--force` | `permission-setting` agentとの対話生成ではない。`read_only` / `writable`を設定fileから変える項目がない |
| structured Wiki | 実装済み | generation target inventory、evidence走査とfingerprint、mask、blob diff、manifest v3、checkpoint、orphan削除（syncのみ） | page単位のevidence依存graphがなく、supporting evidence変更時は全target再queue。`knowledge build`はorphan pageを削除しない |
| prose Wiki agent | 実装済み（既定で起動、`--no-agent`で省略） | survey + batch起動、完了報告からCLIがhash / inventory / checkpointを更新、中断後は同じcommandで再開、Windows process tree kill、version検査、toolは`tools.agent` / `tools.agents.knowledge-builder` / `--agent-tool` | tool実行fileなしではskip。意味品質とcostは外部管理。完了報告protocolはclaude以外で実機未検証 |
| 3SHA / sync lease | 実装済み | merge-base基準、source-tree比較、TTL lease、`--resume` / `--abort` | — |
| `aidev sync` | 実装済み | fetch、no-op判定、一時worktree、inventory更新、任意agent、`aidev/wiki-<sha12>` commit/push、Azure DevOps PR作成/更新/superseded注記 | `generic` hostingとtoken不在ではPR手動。旧PRの自動closeなし |
| Azure Pipelines例 | 実装済み | check pipeline、scheduled sync pipeline（`--no-agent`） | — |
| Claude hooks | 部分実装 | SessionStart summary、guard-write（fail-closed）、quality-gate（PKG file編集時のみ）、Stop journal/queue記録 | queueを消費するrunnerなし。sandboxではない |
| workflow scaffold / approval / run | 部分実装 | JS scaffold、content hash承認、iteration / time / same-failure / allowlist、resume、`agent:`定義と`ctx.agent()`（tool / model / timeout、残り時間で打ち切り、報告costの合計で`max_usd`停止） | token計測なし。USDはtoolが報告した分だけ（claude）。destructive前human gateなし。creator agent未接続 |
| issue-to-pr | agent定義のみ | Work Itemの実装とPKG PR作成をagentが行う（`aidev agent run issue-to-pr`または対話）。マージ後のWikiは`aidev sync` | PKG sourceの書込はteamが`writable`を広げる必要がある。E2E検証なし。`aidev task`状態機械とwork leaseは0.5.0で撤去 |
| self-evolution | 部分実装 | Stop hookがlocal journalを記録し`due`を計算 | 集約、提案作成、中央kitへのPRなし |
| managed background refresh | 未実装 | `pending-refresh.json`を記録 | queueを消費するrunnerなし |
| MCP launcher | 実装済み | config / env解決、固定版packageのstdio起動 | offline / registry unavailableでは起動不可。`generic`では使えない |
| `aidev uninstall` | 実装済み | launcher（marker付きのみ）、Windows user PATH、`AIDEV_HOME`の`registry.json` / `cache/`の削除。kit checkoutとPKG内fileは残し、削除commandを表示 | user PATHの編集はPowerShell経由のbest-effort |
| eject / re-adopt | 実装済み | dry-run、`--yes`必須、hook解除→control surface削除の順序、marker、`init`で再採用 | 高影響のため人間reviewが必要 |
| 他のAI tool adapter | 部分実装 | `tools.js` registry（`claude` / `copilot` / `codex` / `kiro`）、toolごとの`templates/<tool>/`（copilot: `.github/copilot-instructions.md` + agents + skills、codex: `AGENTS.md`、kiro: `.kiro/steering` + agents）の適用 / prune、`ALWAYS_PROTECTED`と`settings.json` denyへの追加、`aidev agent run` / `--agent-tool` / workflow `ctx.agent`での起動、`AIDEV_<TOOL>_BIN` | claude以外は実機未検証（argvは各toolの公開non-interactive仕様準拠。`aidev agent run --dry-run`で確認）。claude以外のtemplateはclaude版から起こしたもので、kit保守者が手で同期する。hook / policyの実行時強制はclaudeのみ。Antigravity CLI未対応。codexはagentを名前で選べずprompt fileに定義を前置 |
| 他のhosting provider | 未実装 | `azure-devops` / `generic` | GitHub / GitLab adapterは存在しない |
| `aidev task start`、`aidev plan`、`aidev kit apply`、`aidev profile` / `config` / `pkg` / `evolve` | 未実装 / 削除済み | — | routing表にない。文書に書かない |

## 利用者向け文書で避ける表現

- 「`init` 1 commandでWikiまで完成」: Wikiは`knowledge build`が別途必要
- 「`init`が`.claude`を生成しない」: templateから適用する
- 「`aidev update`がPKGのfileを更新する」: kit本体だけ。PKGへは`aidev apply`
- 「kit所有fileの編集はdrift」: teamの編集は保持・mergeされる。exit 2は未解消conflictとkit hooks欠落だけ
- 「`knowledge build --no-agent`がproseを生成」: 構造だけ書き、proseはqueueに残る
- 「`doctor`がAzure DevOps認証を検証」: 環境変数の有無まで
- 「`sync`が手元のcheckoutを更新する」: 一時worktreeで作業し、結果はPRとして届く
- 「issue-to-prがCLIの状態機械で進行管理される」: 状態機械（`aidev task`）とwork leaseは撤去済み
- 「Stop hookが非同期でWikiを更新」: queue consumerがない
- 「自己進化が自動でPRを作る」: local journal記録まで
- 「workflowのtoken予算が強制される」: token計測がない。USDはtoolが報告した分（claude）だけで止まる

- 「Copilot / Codex / Kiroを実機で検証済み」「Claude Code以外でpolicyが実行時に強制される」: adapterは公開仕様準拠で未検証、hookはclaudeのみ
- 「GitHub / GitLabに対応」: 存在しない

## 既知の不整合（code側に残るwrapper時代の痕跡）

文書は0.2.0の挙動で書いてあります。以下はcodeを読むときに混乱するので、kitへのPRで順次直してください。

| 場所 | 内容 | 影響 |
| --- | --- | --- |

| `cli/commands/hook.js` `sessionStop` | `submoduleSha: st.submoduleSha`を記録しようとする | `computeState`に`submoduleSha`は無く常に`undefined`（JSONからは消える）。動作には影響しないが意図が失われている。commentの「README specifies async submission to the managed runner」「inside the submodule」「out of step with src/」も旧語彙 |

| `cli/commands/knowledge.js` | commentに「rename committed straight into the submodule」 | commentのみ |
| `cli/commands/eject.js` | header commentが`src/`とsubmodule、`knowledge/`（`.aidev/`なし）を説明。`unwireHooks`のcommentが「現在はexec form」と述べる | commentのみ。shipped `settings.json`は文字列形式で、regexは両形式を扱う |
| `cli/commands/workflow.js` | `steps.js` templateの`ctx.repoRoot`説明が「ラッパーリポジトリのルート」 | 生成されるfileの文言。PKG rootが正しい |
| `package.json` | `description`がwrapper + submodule構成を説明、`files`に存在しない`.claude/` `CLAUDE.md` `.mcp.json`を列挙し`templates/`が無い | `private: true`なので配布には影響しない |
| `manifest.kitCommit` | `knowledge build`はPKGのHEAD、`sync`はkit checkoutのHEADを書く | 意味が揺れている。どちらかに統一する |
| `templates/claude/.claude/settings.json` | deny listに`.aidev/.gitignore`と`.aidev/policy.candidate.yaml`が無い | guard-writeは`.aidev/.gitignore`をprotectedでdenyするので実害は小さい。候補fileはwritableでもない（`read_only: **`でdeny） |

## self-evolutionのtarget design

現在は`.aidev/cache/evolution-journal.json`への観測記録（Wiki不整合で終了、期限切れlease放置）と`cadence`に基づく`due`判定だけです。将来PR生成まで接続する場合も次を維持します。

- 毎sessionではなくcadence単位で集約する
- 変更先はkit repositoryであり、PKG内の`.claude/**`を直接変更しない（driftになる）
- settings、MCP、policy、認証、security制御は自動変更対象外
- token削減を理由に確認、テスト、権限制限を削らない
- human review必須、自動merge禁止

## known gaps

### pending proseのseverity

structured inventoryがtarget SHAへ進んだ時点で`knowledgeSha == baseSha`となり、`pendingPaths`はWARNです。これによりsync leaseを解放してsyncを完了できますが、prose完全性を必須にしたいCIでは`sync`（`--no-agent`なし、Claude Code必須）と`check --strict`が必要です。strictはtracking branch先行などの他のWARNもexit 2にします。

### evidence再生成の粒度

inventoryは「どのpageがどのsupporting evidenceへ依存したか」を記録しません。generation target外のcode / test / config / CIが1件でも変わると全generation targetをqueueします。改善はpage単位のdependency graphであり、evidence範囲を狭めて回避してはいけません。

### orphan削除の非対称

`sync`はorphan pageを削除しますが`knowledge build`は削除しません。`build --full`後に旧pageが残る可能性があります。

### hooksの限界

- `.claude/settings.json`はmanaged settingsではなく利用者が変更できる。hooksを外す編集はdriftとして`check`が捕まえ、branch policyで止める前提
- Bash path抽出は既知command / redirection中心で完全ではない。targetを1つも抽出できないBashはallowになる
- `read_only`のPKG fileをagentに編集させる方法は、teamが`.aidev/policy.yaml`の`writable`へpathを足すことだけ（`aidev.yaml`から生成する項目はない）

### updateの前提

`aidev update`はkit checkoutが`main` branchで、`origin`が中央kitであることを要求します。kit開発者が自分のfeature branchでlauncherを使っている端末では`update`は拒否されます（意図どおり）。`checkForUpdate`はlocalがremoteより先でも「newer」と報告します。

## 適用先ごとに決めること

| 項目 | 判断理由 |
| --- | --- |
| PKGのmerge方式 | merge result SHAの取り方に影響 |
| tracking branchとforce-push policy | sync対象の決まり方に影響 |
| sync PR botの認証主体 | 人間PATをpipelineへ流用しないため |
| PAT scopeと有効期限 | server側の最終権限制御 |
| scheduled sync間隔と`--no-agent`の有無 | 遅延許容、Claude実行環境、token cost |
| large PKGのshard / batch size / timeout | manifest sizeとagent負荷 |
| branch policy / required reviewer / `aidev check`必須化 | kit control surfaceの保護 |
| monorepoの扱い | 1 clone = 1 `aidev.yaml`。複数PKGは`package.include`で分けるか、設計見直し |

## 保守時の完了条件

機能や文書を更新するときは、少なくとも次を確認します。

1. 利用者ガイドが現在到達可能な操作だけを案内している
2. CLI help（`FLAGS` / `FLAG_HELP`）、`cli-reference.md`、利用者ガイドのcommand pageが一致している
3. `aidev.yaml`のdefault、validator、`init.buildConfigYaml`、`configuration-reference.md`が一致している
4. stdout JSON契約とexit codeを壊していない
5. WindowsとPOSIXのinstaller、path、shell差を考慮した
6. dry-runのnetwork / cache副作用を明記した
7. secretがconfig、log、PR description、fixtureへ入っていない
8. template（`templates/`）を変えたら`STATIC_ROOTS` / `KIT_MANAGED_GLOBS` / `ALWAYS_PROTECTED` / deny listの整合を確認した
9. `npm run check`と`npm run docs:check`が成功する
