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
| structured Wiki | 実装済み | generation target inventory、evidence走査とfingerprint、mask、blob diff、manifest v3、checkpoint、orphan削除、clean-tree検査 | page単位のevidence依存graphがなく、supporting evidence変更時は全target再queue |
| prose Wiki agent | 実装済み（既定で起動、`--no-agent`で省略） | survey + batch起動、完了報告からCLIがhash / inventory / checkpointを更新、中断後は同じcommandで再開、Windows process tree kill、version検査、toolは`tools.agent` / `tools.agents.knowledge-builder` / `--agent-tool`。hook経路では`plan.json`を介して対話toolのsubagentが同じ契約でproseを書く | tool実行fileなしではprose未完了（exit 1）。意味品質とcostは外部管理。完了報告protocolはclaude以外で実機未検証 |
| Wiki整合判定 / publish lease | 実装済み | inventoryとHEAD treeの比較（rebase / squash / force-push後も同じ）、`head` / `knowledge` / `tracking`の表示、tracking先行の警告、TTL lease、同じcommandでの継続 / `--abort` | — |
| `aidev knowledge update` | 実装済み | clean-tree検査、HEAD走査とinventory diff、orphan削除、batch agent、prose完了時に`aidev: update Wiki for <sha12>`として別commit、prose未完了はexit 1 + `plan.json`。tracking branch上 / `--branch`では一時worktree（`.aidev/cache/wiki-worktree/`）・`aidev/wiki-<sha12>`・push・Azure DevOps PR作成/更新/superseded注記、prose完了時のみpublish | `generic` hostingとtoken不在ではPR手動。旧PRの自動closeなし。`--resume` / `--to` / `--check-only`は無い（設計どおり） |
| Azure Pipelines例 | 実装済み | check pipeline、scheduled Wiki pipeline（`knowledge update --branch`。agent toolと認証情報が必要） | — |
| hooks | 実装済み | SessionStart summary、guard-write（fail-closed、`AIDEV_AGENT`によるagent単位の許可）、quality-gate（PKG file編集時のみ）、after-bash（HEAD変化で構造更新 + `plan.json` + subagent指示。rename-onlyは自前commit。dirtyなら案内のみ）、Stop（Wiki遅れで1回だけ拒否 + kit開発者端末の振り返り要求）。tool adapter（`tools.HOOK_ADAPTERS`）でclaude / copilot / codex / kiroの設定fileを配布 | sandboxではない。claude以外のhooksは実機未検証。copilot / kiroはsubagent内でhookが動かない（knowledge-builderはagent定義で`.aidev/knowledge/**`に限定）。kiroの`postToolUse`はcontextを注入できずStopで指示。`check`がhooks欠落を検査するのは`.claude/settings.json`だけ |
| workflow scaffold / approval / run | 部分実装 | JS scaffold、content hash承認、iteration / time / same-failure / allowlist、resume、`agent:`定義と`ctx.agent()`（tool / model / timeout、残り時間で打ち切り、報告costの合計で`max_usd`停止） | token計測なし。USDはtoolが報告した分だけ（claude）。destructive前human gateなし。creator agent未接続 |
| issue-to-pr | agent定義のみ | Work Itemの実装とPKG PR作成をagentが行う（`aidev agent run issue-to-pr`または対話）。Wikiはcommit後にhookが追従（または`aidev knowledge update`）。PKG sourceの書込はpolicyの`agents.issue-to-pr.writable`（CLI起動時のみ有効、`branch`条件可）か`writable`で許可 | E2E検証なし。対話sessionのsub-agentは名前を判別できずread-onlyのまま。`aidev task`状態機械とwork leaseは0.5.0で撤去 |
| convention-builder | agent定義のみ | Wikiと根拠sourceから開発規約を`.aidev/conventions/`（`index.md` / `coding.md` / `testing.md` / `review.md`）へ`[確定]` / `[慣習]` / `[未統一]` / `[提案]`区分と根拠付きで書く。既定policyの`writable`に`.aidev/conventions/**`。`## チーム決定`は書き換えない。`references`（aidev.yaml）の文書は根拠に併記し、codeと違えば「文書が古い」項目として一覧化 | E2E検証なし。CLIは生成物を検査しない（reviewは`git diff`） |
| test-writer | agent定義のみ | 指定対象のunit / integration testを既存の書き方で書き、実行して`aidev/tests-<slug>`のPRにする。対象sourceは変更しない。`references.testing`の文書と既存test / CIが食い違えば後者を正とし、差分をPR本文に書く。書込はpolicyの`agents.test-writer.writable`か`writable` | E2E検証なし。integration test環境の用意は既存test / CIからの特定に依存 |
| agent単位の書込許可 | 実装済み | policy `agents.<name>.{writable, branch}`、`AIDEV_AGENT`による判定、`permission show` / weakening検出、`status`表示 | 対話sessionでのagent判別なし |
| self-evolution | 実装済み（kit開発者のみ） | 開発者marker、Stop hookのtranscript集計と1回のblock、振り返りfile、`aidev evolve run`（worktree + evolution agent、`--auto`でhookから起動） | PR作成はagentの手元tool（MCP / gh）任せで、CLIは作らない。閾値は固定。claude以外のtoolのsessionは対象外。実機E2E検証なし |
| MCP launcher | 実装済み | config / env解決、固定版packageのstdio起動 | offline / registry unavailableでは起動不可。`generic`では使えない |
| `aidev uninstall` | 実装済み | launcher（marker付きのみ）、Windows user PATH、`AIDEV_HOME`の`registry.json` / `cache/`の削除。kit checkoutとPKG内fileは残し、削除commandを表示 | user PATHの編集はPowerShell経由のbest-effort |
| eject / re-adopt | 実装済み | dry-run、`--yes`必須、hook解除→control surface削除の順序、marker、`init`で再採用 | 高影響のため人間reviewが必要 |
| 他のAI tool adapter | 部分実装 | `tools.js` registry（`claude` / `copilot` / `codex` / `kiro`）、toolごとの`templates/<tool>/`（copilot: `.github/copilot-instructions.md` + agents + skills + `.github/hooks/aidev.json`、codex: `AGENTS.md` + `.codex/hooks.json`、kiro: `.kiro/steering` + agents + `.kiro/agents/aidev.json`）の適用 / prune、`ALWAYS_PROTECTED`と`settings.json` denyへの追加、`aidev agent run` / `--agent-tool` / workflow `ctx.agent`での起動、`AIDEV_<TOOL>_BIN`、hook adapter（`--tool`） | claude以外は実機未検証（argvとhook形式は各toolの公開仕様準拠。`aidev agent run --dry-run`で確認）。claude以外のtemplateはclaude版から起こしたもので、kit保守者が手で同期する。Antigravity CLI未対応。codexはagentを名前で選べずprompt fileに定義を前置 |
| 他のhosting provider | 未実装 | `azure-devops` / `generic` | GitHub / GitLab adapterは存在しない |
| Wiki自動追従（branch上のHEADを対象、hookの注入とStop拒否、`aidev knowledge update`） | 実装済み（2026-09-22） | 上記「`aidev knowledge update`」「hooks」の行。設計は`proposals/2026-09-21-wiki-auto-update.md`、`proposals/2026-09-22-wiki-update-flows.md` | claude以外のtoolでは実機未検証 |
| `aidev task`、`aidev plan`、`aidev kit apply`、`aidev profile` / `config` / `pkg`、`aidev sync`、`aidev knowledge build` / `status` | 削除済み | — | routing表にない。文書に書かない（`sync` / `build` / `status`は2026-09-22に`aidev knowledge update`と`aidev status`へ統合） |

## 利用者向け文書で避ける表現

- 「`init`がWikiを必ず完成させる」: `init`は`knowledge update --no-commit`相当を同一processで実行するが、agent toolが無い、agentの失敗・timeout・Ctrl-Cでprose未完了のままexit 1になる（`init`再実行で続行）。commitは利用者が行う
- 「`init`が`.claude`を生成しない」: templateから適用する（`tools.default`のtoolぶん）
- 「`aidev update`がPKGのfileを更新する」: kit本体だけ。PKGへは`aidev apply`
- 「kit所有fileの編集はdrift」: teamの編集は保持・mergeされる。exit 2は未解消conflictとkit hooks欠落だけ
- 「`knowledge update --no-agent`がproseを生成」: 構造だけ書き、proseはqueueに残る（exit 1）。完了報告があれば取り込んでcommitする
- 「`doctor`がAzure DevOps認証を検証」: 環境変数の有無まで
- 「tracking branch上の`knowledge update`が手元のcheckoutを更新する」: 一時worktreeで作業し、結果は`aidev/wiki-<sha12>`のPRとして届く
- 「`--resume` / `--to` / `--check-only`がある」: 存在しない。継続は同じcommand、破棄は`--abort`、targetは常にHEAD、状態は`aidev status`
- 「Wikiが未commitの変更を説明する」: generation targetが汚れていれば`knowledge update`もhookも止まる。Wikiはcommitだけを説明する
- 「issue-to-prがCLIの状態機械で進行管理される」: 状態機械（`aidev task`）とwork leaseは撤去済み
- 「自己進化が利用者の環境で動く」: kit開発者の端末（`aidev evolve enable`）だけ。利用者ガイドには書かない
- 「workflowのtoken予算が強制される」: token計測がない。USDはtoolが報告した分（claude）だけで止まる
- 「対話中のClaudeがsub-agentとして呼んだissue-to-prもsourceを書ける」: agent単位の許可はCLIが起動したagent（`AIDEV_AGENT`）だけに効く
- 「`reconfigure`が手で足した許可を保つ」: 候補は`aidev.yaml`から生成し直され、手で足した`writable` / `agents`は消える
- 「Wikiがcommitのたびに完全に自動で追従する」: hookは構造更新までを行い、proseは対話toolがsubagentで書き、最後に`aidev knowledge update --no-agent`を実行する。sessionがその指示に従わなければWikiは遅れたまま（Stop hookの拒否は1回だけ）
- 「Copilot / Codex / Kiroを実機で検証済み」: adapterとhook設定は公開仕様準拠で未検証（`verified: false`）
- 「GitHub / GitLabに対応」: 存在しない

## 既知の不整合（code側に残る旧語彙）

codeを読むときに混乱するので、kitへのPRで順次直してください。wrapper時代のcomment（`hook.js`、`knowledge.js`、`eject.js`、`workflow.js`）、`package.json`の`description` / `files`、`manifest.kitCommit`の不統一（現在は`knowledge update`がkit checkoutのHEADを書く）は解消済みです。

| 場所 | 内容 | 影響 |
| --- | --- | --- |
| `cli/lib/leases.js` | commentに「half-bumped submodule」 | commentのみ |
| `cli/lib/leases.js`、`.aidev/sync.lock`、`aidev.yaml`の`sync`節 | 名前が`sync`のまま（`aidev sync`は撤去済み。実体はpublish lease / publish設定） | 名前のみ |
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

structured inventoryがHEADへ進んだ時点で整合判定は「遅れていない」になり、`pendingPaths`はWARNです。これによりpublish leaseを解放して構造更新を完了できますが、`knowledge update`はprose未完了ではcommitもpublishもしません（exit 1）。prose完全性をCIで必須にするには`check --strict`を使います。strictはtracking branch先行などの他のWARNもexit 2にします。

### hook経路はsessionの協力に依存する

after-bash / Stop hookは構造更新までを自分で行い、proseは対話toolのsessionがsubagentを起動して書きます。sessionが指示に従わない、subagentが報告を書かない、`aidev knowledge update --no-agent`を実行しない、のいずれでもWikiは遅れたままです（Stop hookの拒否は1回だけ）。`check --strict`をbranch policyに入れることでmerge前に捕まえます。hook経路はclaude以外で実機未検証です。

### evidence再生成の粒度

inventoryは「どのpageがどのsupporting evidenceへ依存したか」を記録しません。generation target外のcode / test / config / CIが1件でも変わると全generation targetをqueueします。改善はpage単位のdependency graphであり、evidence範囲を狭めて回避してはいけません。

### hooksの限界

- `.claude/settings.json`はmanaged settingsではなく利用者が変更できる。hooksを外す編集はdriftとして`check`が捕まえ、branch policyで止める前提
- Bash path抽出は既知command / redirection中心で完全ではない。targetを1つも抽出できないBashはallowになる
- `read_only`のPKG fileをagentに編集させる方法は、teamが`.aidev/policy.yaml`に`agents.<name>.writable`（CLI起動のagentだけ）か`writable`（全員）を書くことだけ（`aidev.yaml`から生成する項目はない）。対話sessionのsub-agentは名前を判別できない
- hook設定はclaude / copilot / codex / kiroに配布するが、実機で確認しているのはclaudeだけ。copilot / kiroはsubagent内でhookが動かず、kiroの`postToolUse`はcontextを注入できない。`check`のhooks欠落検査は`.claude/settings.json`だけ

### updateの前提

`aidev update`はkit checkoutが`main` branchで、`origin`が中央kitであることを要求します。kit開発者が自分のfeature branchでlauncherを使っている端末では`update`は拒否されます（意図どおり）。`checkForUpdate`はlocalがremoteより先でも「newer」と報告します。

## 適用先ごとに決めること

| 項目 | 判断理由 |
| --- | --- |
| PKGのmerge方式 | Wiki commitがsource commitと同じPRで届くか（squashでも1 commitに畳まれるだけで整合判定には影響しない） |
| tracking branchとforce-push policy | publish対象（`aidev/wiki-<sha12>`）の決まり方に影響 |
| Wiki publish PR botの認証主体 | 人間PATをpipelineへ流用しないため |
| PAT scopeと有効期限 | server側の最終権限制御 |
| scheduled Wiki pipelineの間隔とagent toolの認証 | 遅延許容、agent実行環境、token cost（proseが無ければpublishしない） |
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
