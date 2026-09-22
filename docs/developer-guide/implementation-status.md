# Implementation status, known gaps, and target designs

この文書は「設計として望んでいること」と「現在production codeから到達できること」を区別する台帳です。利用者ガイドには、ここで**実装済み**または明示した**部分実装**だけを書きます。対象は現在の`main`（PKG clone方式）です。

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
| `aidev status` / `aidev doctor` | 実装済み | 一画面表示（policyの`agents`許可を含む）、環境診断、`tools.default`の各toolのversion、token有無、remote到達性 | Azure DevOps API認証試験はない |
| permission candidate / approval | 実装済み | `aidev.yaml`から機械生成、`--approve`、弱体化検出（`agents`の追加を含む）と`--force`、`show`に`agents` | `permission-setting` agentとの対話生成ではない。`read_only` / `writable` / `agents`を設定fileから変える項目がなく、teamはpolicy本体を直接編集する。`reconfigure --approve`は手編集を消す |
| structured Wiki | 実装済み | generation target inventory、evidence走査とfingerprint、mask、blob diff、manifest v3、checkpoint、orphan削除（syncのみ） | page単位のevidence依存graphがなく、supporting evidence変更時は全target再queue。`knowledge build`はorphan pageを削除しない |
| prose Wiki agent | 実装済み（既定で起動、`--no-agent`で省略） | survey + batch起動、完了報告からCLIがhash / inventory / checkpointを更新、中断後は同じcommandで再開、Windows process tree kill、version検査、toolは`tools.agent` / `tools.agents.knowledge-builder` / `--agent-tool` | tool実行fileなしではskip。意味品質とcostは外部管理。完了報告protocolはclaude以外で実機未検証 |
| 3SHA / sync lease | 実装済み | merge-base基準、source-tree比較、TTL lease、`--resume` / `--abort` | — |
| `aidev sync` | 実装済み | fetch、no-op判定、一時worktree、inventory更新、任意agent、`aidev/wiki-<sha12>` commit/push、Azure DevOps PR作成/更新/superseded注記 | `generic` hostingとtoken不在ではPR手動。旧PRの自動closeなし |
| Azure Pipelines例 | 実装済み | check pipeline、scheduled sync pipeline（`--no-agent`） | — |
| Claude hooks | 実装済み | SessionStart summary、guard-write（fail-closed、`AIDEV_AGENT`によるagent単位の許可）、quality-gate（PKG file編集時のみ）、Stop（kit開発者端末の振り返り要求のみ） | sandboxではない。Wikiの追従はhookから起動しない（下記「未実装」） |
| workflow scaffold / approval / run | 部分実装 | JS scaffold、content hash承認、iteration / time / same-failure / allowlist、resume、`agent:`定義と`ctx.agent()`（tool / model / timeout、残り時間で打ち切り、報告costの合計で`max_usd`停止） | token計測なし。USDはtoolが報告した分だけ（claude）。destructive前human gateなし。creator agent未接続 |
| issue-to-pr | agent定義のみ | Work Itemの実装とPKG PR作成をagentが行う（`aidev agent run issue-to-pr`または対話）。マージ後のWikiは`aidev sync`。PKG sourceの書込はpolicyの`agents.issue-to-pr.writable`（CLI起動時のみ有効、`branch`条件可）か`writable`で許可 | E2E検証なし。対話sessionのsub-agentは名前を判別できずread-onlyのまま。`aidev task`状態機械とwork leaseは0.5.0で撤去 |
| convention-builder | agent定義のみ | Wikiと根拠sourceから開発規約を`.aidev/conventions/`（`index.md` / `coding.md` / `testing.md` / `review.md`）へ`[確定]` / `[慣習]` / `[未統一]` / `[提案]`区分と根拠付きで書く。既定policyの`writable`に`.aidev/conventions/**`。`## チーム決定`は書き換えない。`references`（aidev.yaml）の文書は根拠に併記し、codeと違えば「文書が古い」項目として一覧化 | E2E検証なし。CLIは生成物を検査しない（reviewは`git diff`） |
| test-writer | agent定義のみ | 指定対象のunit / integration testを既存の書き方で書き、実行して`aidev/tests-<slug>`のPRにする。対象sourceは変更しない。`references.testing`の文書と既存test / CIが食い違えば後者を正とし、差分をPR本文に書く。書込はpolicyの`agents.test-writer.writable`か`writable` | E2E検証なし。integration test環境の用意は既存test / CIからの特定に依存 |
| agent単位の書込許可 | 実装済み | policy `agents.<name>.{writable, branch}`、`AIDEV_AGENT`による判定、`permission show` / weakening検出、`status`表示 | 対話sessionでのagent判別なし |
| self-evolution | 実装済み（kit開発者のみ） | 開発者marker、Stop hookのtranscript集計と1回のblock、振り返りfile、`aidev evolve run`（worktree + evolution agent、`--auto`でhookから起動） | PR作成はagentの手元tool（MCP / gh）任せで、CLIは作らない。閾値は固定。claude以外のtoolのsessionは対象外。実機E2E検証なし |
| MCP launcher | 実装済み | config / env解決、固定版packageのstdio起動 | offline / registry unavailableでは起動不可。`generic`では使えない |
| `aidev uninstall` | 実装済み | launcher（marker付きのみ）、Windows user PATH、`AIDEV_HOME`の`registry.json` / `cache/`の削除。kit checkoutとPKG内fileは残し、削除commandを表示 | user PATHの編集はPowerShell経由のbest-effort |
| eject / re-adopt | 実装済み | dry-run、`--yes`必須、hook解除→control surface削除の順序、marker、`init`で再採用 | 高影響のため人間reviewが必要 |
| 他のAI tool adapter | 部分実装 | `tools.js` registry（`claude` / `copilot` / `codex` / `kiro`）、toolごとの`templates/<tool>/`（copilot: `.github/copilot-instructions.md` + agents + skills、codex: `AGENTS.md`、kiro: `.kiro/steering` + agents）の適用 / prune、`ALWAYS_PROTECTED`と`settings.json` denyへの追加、`aidev agent run` / `--agent-tool` / workflow `ctx.agent`での起動、`AIDEV_<TOOL>_BIN` | claude以外は実機未検証（argvは各toolの公開non-interactive仕様準拠。`aidev agent run --dry-run`で確認）。claude以外のtemplateはclaude版から起こしたもので、kit保守者が手で同期する。hook / policyの実行時強制はclaudeのみ。Antigravity CLI未対応。codexはagentを名前で選べずprompt fileに定義を前置 |
| 他のhosting provider | 未実装 | `azure-devops` / `generic` | GitHub / GitLab adapterは存在しない |
| 開発中のWiki自動追従（branch上のHEADを対象、hookの注入とStop拒否、`aidev knowledge update`） | 未実装 | 設計のみ（`proposals/2026-09-21-wiki-auto-update.md`、`proposals/2026-09-22-wiki-update-flows.md`） | 現在の追従は`aidev sync`（tracking branch先端、別branchのPR）だけ |
| `aidev task`、`aidev plan`、`aidev kit apply`、`aidev profile` / `config` / `pkg` | 削除済み | — | routing表にない。文書に書かない |

## 利用者向け文書で避ける表現

- 「`init`がWikiを必ず完成させる」: `init`は`knowledge build`を同一processで実行するが、agentの失敗・timeout・Ctrl-Cで途中終了する（`init`再実行で続行）
- 「`init`が`.claude`を生成しない」: templateから適用する（`tools.default`のtoolぶん）
- 「`aidev update`がPKGのfileを更新する」: kit本体だけ。PKGへは`aidev apply`
- 「kit所有fileの編集はdrift」: teamの編集は保持・mergeされる。exit 2は未解消conflictとkit hooks欠落だけ
- 「`knowledge build --no-agent`がproseを生成」: 構造だけ書き、proseはqueueに残る
- 「`doctor`がAzure DevOps認証を検証」: 環境変数の有無まで
- 「`sync`が手元のcheckoutを更新する」: 一時worktreeで作業し、結果はPRとして届く
- 「issue-to-prがCLIの状態機械で進行管理される」: 状態機械（`aidev task`）とwork leaseは撤去済み
- 「自己進化が利用者の環境で動く」: kit開発者の端末（`aidev evolve enable`）だけ。利用者ガイドには書かない
- 「workflowのtoken予算が強制される」: token計測がない。USDはtoolが報告した分（claude）だけで止まる
- 「対話中のClaudeがsub-agentとして呼んだissue-to-prもsourceを書ける」: agent単位の許可はCLIが起動したagent（`AIDEV_AGENT`）だけに効く
- 「`reconfigure`が手で足した許可を保つ」: 候補は`aidev.yaml`から生成し直され、手で足した`writable` / `agents`は消える
- 「Wikiがcommitのたびに自動で追従する」: 未実装。追従は`aidev sync`か`aidev knowledge build`の実行
- 「Copilot / Codex / Kiroを実機で検証済み」「Claude Code以外でpolicyが実行時に強制される」: adapterは公開仕様準拠で未検証、hookはclaudeのみ
- 「GitHub / GitLabに対応」: 存在しない

## 既知の不整合（code側に残る旧語彙）

codeを読むときに混乱するので、kitへのPRで順次直してください。wrapper時代のcomment（`hook.js`、`knowledge.js`、`eject.js`、`workflow.js`）、`package.json`の`description` / `files`、`manifest.kitCommit`の不統一（現在は`knowledge build`も`sync`もkit checkoutのHEAD）は解消済みです。

| 場所 | 内容 | 影響 |
| --- | --- | --- |
| `cli/lib/leases.js` | commentに「half-bumped submodule」 | commentのみ |
| `templates/claude/.claude/settings.json` | deny listに`.aidev/policy.candidate.yaml`が無い | 候補fileはwritableでもない（`read_only: **`でguard-writeがdeny）ので実害は小さい |
| `cli/lib/config.js` | `validateConfig`が未定義keyを黙って無視する（撤去した`self_evolution`を書いても警告しない） | typoも旧keyも検出されない |

## self-evolutionの範囲

0.6.0で実装済み（architecture.md §13、design-decisions.md D13）。維持する制約:

- kit開発者の端末（`aidev evolve enable`）以外では、Stop hookは何もせず記録も残さない
- 振り返りは同じsessionが書く。promptや応答やdiffや秘密は書かない（hookの指示文で禁止）
- 変更先はkitのtemplateで、settings・hooks・policyの既定を緩める変更は対象外
- PRはagentが手元のtool（MCP / gh）で作り、人間がmergeする。自動mergeはしない

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
- `read_only`のPKG fileをagentに編集させる方法は、teamが`.aidev/policy.yaml`に`agents.<name>.writable`（CLI起動のagentだけ）か`writable`（全員）を書くことだけ（`aidev.yaml`から生成する項目はない）。対話sessionのsub-agentは名前を判別できない
- hookによる強制はClaude Codeだけ。copilot / codex / kiroで起動したagentにはpolicyが効かない（`ALWAYS_PROTECTED`はそれらのtoolの設定fileも含むが、守るのはclaudeのhookだけ）

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
8. template（`templates/`）を変えたら`layout.TOOL_CONFIG_GLOBS` / `KIT_MANAGED_GLOBS` / `ALWAYS_PROTECTED` / deny listの整合を確認し、claude以外のtoolの木も同じ趣旨で揃えた
10. 実装したproposalは`proposals/`から削除し、内容を上記の文書へ移した
9. `npm run check`と`npm run docs:check`が成功する
