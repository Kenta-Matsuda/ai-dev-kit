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
| `aidev init` | 実装済み | 質問（初回のみ）、`aidev.yaml` v2、`.aidev/.gitignore`、選んだtoolのtemplate適用（初回のみ）、`materialized.json`、registry、policy候補/配置、eject markerの解除。Wikiは状態を報告するだけで生成しない（`aidev sync wiki`を案内。2026-09-23に分離） | Azure DevOps接続試験はしない |
| tool config apply / `aidev check` | 実装済み | `templates/<tool>/`の適用、pristine置換、teamの編集保持、3-way merge（base = lockの`kitCommit`のtemplate）、conflict marker、解消の記録、prune / retire、`check`は未解消conflict・kit hooks欠落・record欠落だけをexit 2 | kit checkoutにbase commitが無い（shallow）とmergeできず衝突扱い。`.claude/settings.local.json`は検査しない（設計どおり） |
| `aidev update` / `aidev sync tools|wiki` | 実装済み | `update`はkit checkoutのfast-forwardと「syncが必要なPKG」の一覧（objectは取らない）、`sync tools`はPKGへのtemplate適用（3-way merge。旧`apply`）、`sync wiki`はWikiのHEAD追従（旧`knowledge update`）。対象PKGは`--package` | commitは利用者が行う |
| `aidev list packages` / 共通option `--package <name|path>`（`-p`） | 実装済み（2026-09-23） | `list packages`はregistryの全PKGを名前・path・templateの状態（current / behind / missing）で一覧。`--package`はentry pointで解決し、PKG向けcommand（`init` / `check` / `doctor` / `create` / `modify` / `edit` / `estimate` / `remove` / `list` / `submit` / `run` / `sync` / `uninstall` / `ask`）をそのPKGで動かす。`update`ではerror | registryの全PKGへの一括実行（`--all`）は未実装（design-decisions.mdの未決の論点） |
| `aidev ask "<question>"` | 実装済み（2026-10-14） | kit自体の使い方への質問に、`kit-guide`（`cli/agents/kit-guide.md`）がkit checkoutでユーザーガイドとCLIのソースを読んで答える。常にclaude、Read / Glob / Grepだけ、MCPなし。promptに全commandとoptionの一覧。PKGの中ならPKGの名前とworkflow / agent / skillの名前も渡す。PKGのinstruction file（CLAUDE.mdほか）がAI toolに、kitの使い方を聞かれたら`aidev ask`を使うよう指示する | claude以外のtoolでは起動しない。testはstub。実際のClaude Code（2.1.296）では質問1件を手動で確認しただけ |
| `aidev check` / `aidev doctor` | 実装済み（2026-09-23に再編） | `check`はPKGの一画面表示とCI exit code（0 / 1=aidev.yaml不正・workflow不正 / 2 / 3 / 4）を兼ねる（旧`status`を統合）。`doctor`は端末（node / git / kit / registry / 全AI toolのversion / proxy）を見て、`--package`を付けるとそのPKGのaidev.yaml / origin / policy / agent tool / auth env / remote / Wiki状態 / workflowsも一覧する | Azure DevOps API認証試験はない |
| permission candidate / approval | 実装済み | `aidev create policy`: `aidev.yaml`から機械生成、`--approve`、弱体化検出（protected / read_only / writable_during_syncからの削除、sync時のみ書込可のpathのwritableへの昇格）と`--force`。有効なpolicyは`check` / `doctor --package`のpolicy行で見る。policyの`agents`は撤去し、`validatePolicy`がerrorにする | `permission-setting` agentとの対話生成ではない。`read_only` / `writable`を設定fileから変える項目がなく、teamはpolicy本体を直接編集する。`create policy --approve`は生成し直すので手編集を消す |
| structured Wiki | 実装済み | generation target inventory、evidence走査とfingerprint、mask、blob diff、manifest v3、checkpoint、orphan削除、clean-tree検査 | page単位のevidence依存graphがなく、supporting evidence変更時は全target再queue |
| prose Wiki agent | 実装済み（既定で起動、`--no-agent`で省略） | survey + batch起動、完了報告からCLIがhash / inventory / checkpointを更新、中断後は同じcommandで再開、Windows process tree kill、version検査、toolは`tools.agent` / `tools.agents.knowledge-builder` / `--agent-tool`。hook経路では`plan.json`を介して対話toolのsubagentが同じ契約でproseを書く | tool実行fileなしではprose未完了（exit 1）。意味品質とcostは外部管理。完了報告protocolはclaude以外で実機未検証 |
| Wiki整合判定 / publish lease | 実装済み | inventoryとHEAD treeの比較（rebase / squash / force-push後も同じ）、`head` / `knowledge` / `tracking`の表示、tracking先行の警告、TTL lease、同じcommandでの継続 / `--abort` | — |
| `aidev sync wiki` | 実装済み | clean-tree検査、HEAD走査とinventory diff、orphan削除、batch agent、prose完了時に`aidev: update Wiki for <sha12>`として別commit、prose未完了はexit 1 + `plan.json`。tracking branch上 / `--branch`では一時worktree（`.aidev/cache/wiki-worktree/`）・`aidev/wiki-<sha12>`・push・Azure DevOps PR作成/更新/superseded注記、prose完了時のみpublish | `generic` hostingとtoken不在ではPR手動。旧PRの自動closeなし。`--resume` / `--to` / `--check-only`は無い（設計どおり） |
| Azure Pipelines例 | 実装済み | check pipeline、scheduled Wiki pipeline（`aidev check --no-remote`で状態を報告し、`aidev sync wiki --branch`で`aidev/wiki-<sha12>`のPR。agent toolと認証情報が必要） | — |
| hooks | 実装済み | SessionStart summary、guard-write（fail-closed、承認済みworkflowの実行中stepの`writable`とagentのtool / MCP許可）、quality-gate（PKG file編集時のみ）、after-bash（HEAD変化で構造更新 + `plan.json` + subagent指示。rename-onlyは自前commit。dirtyなら案内のみ）、Stop（Wiki遅れで1回だけ拒否 + kit開発者端末の振り返り要求）。tool adapter（`tools.HOOK_ADAPTERS`）でclaude / copilot / codex / kiroの設定fileを配布 | sandboxではない。claude以外のhooksは実機未検証。copilot / kiroはsubagent内でhookが動かない（kiroのknowledge-builderはagent定義の`permissions`で書込を`.aidev/knowledge/**`に限定。copilotのknowledge-builder定義はtool・pathの制限を持たず、subagentの書込は検査されない）。kiroの`postToolUse`はcontextを注入できずStopで指示。`check`がhooks欠落を検査するのは`.claude/settings.json`だけ |
| workflow（`create` / `modify` / `estimate` / `submit` / `run` / `list` / `remove`） | 実装済み（2026-09-23） | YAMLのみの定義（`validateDefinition`）、`create workflow`（template / `--describe`でworkflow-creator。足りないagent / skillはagents-creatorをsubagentで起動して書く）、`create agent`（template / `--describe`でagents-creator）/ `create skill` / `create policy`、`list workflows|agents|skills`、`remove`（参照中のagent / skillは拒否）、`submit workflow`（branch + commit + push + Azure DevOps PR）、承認 = `origin/<tracking_branch>`との一致（`approvalStatus`。参照するPKG内agent / skillも対象）、runner（agent / command / pull-request step、`until`再試行（command と、`VERDICT:`で判定する確認役agent。確認役は`<id>:until`で書込不可）、同一失敗停止、`max_minutes`、`max_usd`、shellなしcommand、`AIDEV_WORKFLOW`によるscope）、`runs/<id>/run.json`、`check`のworkflow検証。2026-10-01: `until.command`のlist、commandの`cwd` / `env` / `timeout_ms`、commandの非同期実行と出力全文のlog、stepごとの記録書き出しと`--resume`、runの`notes/`、確認役へのdiff、PR本文へのstep報告、`unchanged`（guardのdenyと試行後の比較）、`for_each`（notesの一覧から対象ごとに起動、対象単位のresume）。2026-10-12: `modify workflow --describe`（workflow-creatorが今の定義をその場で直す。共有agentは編集させない、元fileは`.aidev/cache/modify/`）、`estimate workflow`（`run.json`の`calls`と定義からの楽観〜悲観、`--ai`でcost-estimatorがsize・試行・件数を推定）、`run --dry-run`の`cost`行。2026-10-13: `cost`を`limits.max_usd`へ統合、`limits.max_minutes`を任意・天井なしに（claude以外のtoolでは必須）、`timeout_ms`→`timeout_minutes`（≤240）、`for_each.max_items`≤10000と`on_failure: continue`（失敗した件の変更を戻して続行）、`run --log <file>`（全過程とsummary）。2026-10-13（D21）: stepの種類はkey（`agent` / `command` / `pull_request`）、`kind: pull-request`→`pull_request: { title }`、`max_retries`→`until.max_retries`。2026-10-13（D22）: 見積もりの学習（`.aidev/estimates/records/`をcommitして共有、`calibrate`によるsize価格と幅の補正、modelの単価比での換算、外れ3件で`run`の終わりにestimate-reviewerが`priors.json` / `notes.md`、`estimate --review`、`--ai`のjudgmentの保持、`for_each`の途中の残り費用の予測log、claudeのtoken数と実modelの記録、`npm run evolve -- estimates`と`npm run estimate:backtest`）。2026-10-13（D23）: `edit workflow`（browser editor）。2026-10-13（D26）: 専用worktree（`runtree.js`、`<AIDEV_HOME>/worktrees/`）での実行、workflowごとのbranch `aidev/<name>`（`--dated`で日付付き）、step / 件ごとのcheckpoint commit、worktreeの最後のcheckpointからの`--resume`、worktreeのlock、`modify --from-run`（`runDigest`、`CAUSE:`、`.aidev/cache/modify/<name>.json`）、submitのPR本文（承認済みの版との差分、見積もりの前後、Why this change、`.aidev/cache/submit/<name>.md`）。2026-10-13（D25）: `for_each.parallel`（`writable`の`{item}`で対象ごとの書込範囲、guardは`AIDEV_WORKFLOW_ITEM`）、`parallel:` group（agent stepの同時実行、`writable`の重なりを検証で拒否）、agentの`subagents`（`--agents`で定義を渡し、guardが`subagent_type`とsubagent内の呼び出しを判定）。editorはgroupを横並びで表示・編集。2026-10-14（D27–D29）: `run --trial`（承認を問わず、checkoutの定義をそのままbranch `aidev/<name>.trial`の専用worktreeで動かす。毎回checkoutのHEADへreset、定義（`reviewedFiles`）をcopyしてcommit、worktreeのgit dirのtrial record（agentの環境の`AIDEV_WORKFLOW_TRIAL`。定義が変われば失効）でguardがstepの`writable`を許可、push / PRなし（子processのgit設定・`preflight`・hookのBash拒否の3段）、`--max-usd`、`--resume`は同じ種類のrunだけ、見積もりの学習から除外、`modify --from-run`はtrialも読む）、`inputs:`と`--input name=value`（`description` / `default` / `pattern` / `path` / `file`。`{inputs.<name>}`は`objective`・prompt・`until.prompt`・`until.command`・command・envだけ。commandに届く値は固定のwhitelist。`file: true`はworktreeの`runs/<id>/inputs/`へcopy。promptの「Inputs for this run」、`estimate --input`）、`provide:`（checkoutでgitが無視するfileをfile単位でworktreeへcopy。`secrets_paths`・`.aidev`・`.git`・symlinkは除外、worktreeでも無視されていることを要求）、`never_commit:`とkitの`NEVER_COMMITTED`（untrackedのresidueをcheckpoint・PR・`unchanged`・戻し・確認役のstatus・run前の未commit検査から除き、「left out」として報告）、`preflight`（PATHに無いcommand、当たらない`provide`、届かない`path` input、trialの`git push`。`--dry-run`でも）、終了時の報告（`writable`の外の変更`outside`、claudeの`permission_denials`をstepの`denied`に）。2026-10-21（D30）: 標準workflowの同梱（`templates/workflows/<standard>/`。`playwright-tests`、2026-10-23に`implement-task` / `lint-fix` / `release-notes`）と`create workflow --from <standard>`（agent / skillごとPKGへ複製。内容の違う既存fileは`--force`。2026-10-23: 複製の記録`.aidev/workflows/<name>/standard.json`と`aidev sync workflow <name>`（kitの新しい版をPKGの編集を保って3-way mergeで取り込む。`sync tools`と同じ判定、baseはkit checkoutのgit履歴から。記録の無い複製は`--from`で複製元を名指しし、履歴の中で一致する版をbaseにする）。`playwright-tests`のエビデンス（`support/evidence.ts`のfixture。手順ごとの画面キャプチャを`test-results/evidence/<case>/`に。参照実装はskillにあり、sandboxがそれを実Playwrightで通す）。前提条件はテストが作って戻す（skillの規約、plannerの「前提条件の作り方」、scaffoldのensure型helper、reviewerの指摘。`until`は同じtestを2回続けて実行。sandboxはTC-006で実証）。`list workflows`の末尾と`--json`の`standard`、workflow-creatorのcatalogueに一覧）、`aidev.yaml`の`workflows.<name>.inputs`（`--input` > `aidev.yaml` > `default`。認証情報らしい名前は`validateConfig`が拒否）、top-levelの`env_required`（shellの環境変数を名前で宣言。`preflight`が存在だけを確かめ、promptには名前と説明だけ、`--dry-run`の`env`行、PR本文の「Environment variables the run needs」）、agent stepの`env`（agentのprocessと`until.commands`に渡す固定値。`{inputs.<name>}`はcommandに届く扱い、`{item}`も置換。`PATH` / `NODE_OPTIONS` / `HOME` / `CLAUDE_*` / `ANTHROPIC_*` / `GIT_*` / proxyはagent stepでは拒否）。2026-10-22: 標準workflowのsandbox（`npm run sandbox -- <standard>`。使い捨てPKGに`--from`で複製し、`AIDEV_CLAUDE_BIN`を`scripts/sandbox-agent.js`にして`sandbox/scenario.js`の筋書きどおりに書かせ、`run --trial`を実npm・実Playwrightで通して記録・log・prompt・commitに秘密が無いことと`expect`を検査。`test/sandbox.test.js`が筋書きの形とscripted agentの応答を実commandなしで検査） | tokenは記録するだけで上限には使わない。`--resume`は止まったstep（`for_each`なら止まった対象）を最初からやり直す（agentの会話は引き継がない）。同一失敗の判定は出力の完全一致なので、所要時間を出力するtest runnerでは働かない。`unchanged`はfile単位で、gitignoreされたfileとfileの一部の変更は見えない。subagentの`--agents`（`disallowedTools`・`mcp__<server>`のallow）とhookの`agent_id` / `agent_type`による判定は、Claude Code 2.1.296の`--help`と同梱のschemaの記述で確かめただけで、実claudeでは未検証（testはstub）。実行のworktreeにはgitが無視するもの（`node_modules`等）が無く、依存はworkflowのcommand step（`npm ci`）で、dataは`provide:`かfile input（`inputs.<name>.file: true`）で用意する。`provide`はfile単位のcopyで、大きなtreeでは遅い。`preflight`のPATH検査はpath区切りを含まない名前だけ（`./run.sh`・`node_modules/.bin/x`は見ない）。trial runが縛るのはrunnerとgit（push）で、未reviewの定義がMCP serverやallow listにあるBashを通して起こす副作用の全部ではない。trialでもhosting PATは外さない。worktree（trialの`aidev-<name>.trial`も）は自動で消さない。worktree以前（4.x）の実行記録は`--resume`できない。`for_each.parallel`とparallel groupは実行のworktreeを共有する（件ごと・stepごとのworktreeは無い）。同時に動く`until.command`の衝突（port・DB）は調停しない。費用の上限は同時に動く数だけ超え得る。`on_failure: continue`の戻しはgitignoreされたfileを見ない。端末の停止・toolの一時的な失敗からの自動再開は無い（`--resume`は人が実行する。残りの設計案は`proposals/2026-10-01-workflow-long-running.md`）。USDはtoolが報告した分だけ（claude）。見積もりの既定のsize別単価と`MODEL_PRICES`は目安（PKGの記録が増えると記録が優先。単価表は手で更新）。`modify`、cost-estimator、estimate-reviewer、`npm run evolve -- estimates`は実claudeで未検証（stubのみ）。`edit workflow`はheadless Chromeでの操作を確認したが、formから保存するとYAMLのコメントが消える。`generic` hostingではPR手動。PR後のWiki追従はrunnerが行わない。workflow-creatorのsubagent連携とclaude以外のtoolは実機未検証。実行時にkitのworkflow / 開発用agentを参照する経路は無い（framework-only）。同梱するのは標準workflowの雛形（`templates/workflows/`）だけで、`--from`で複製したPKGのfileとして動く。`playwright-tests`はsandbox（scripted agent + 実npm・実Playwright 1.56 + runner・worktree・再試行・trialのPR step）で端から端まで通ることを確かめたが、実claudeでは未検証（agentが筋書きどおりの品質で書けるかは別。前提: PKGにPlaywrightが入っていて`testDir`が`tests/e2e/`を含む。`webServer`を起動する設定と`for_each.parallel`は衝突し得る）。sandboxはhooksを通らない（scripted agentはtoolを呼ばない）。`env_required`の値はagentの環境にも届く（hosting PATと同じ露出。promptには書かないが、`Bash`を持つagentは読める） |
| workflow stepの`writable`による書込許可 | 実装済み（2026-09-23） | policy第6段: `AIDEV_WORKFLOW`が指すworkflowが承認済みなら、`AIDEV_WORKFLOW_STEP`が指すstepの`writable`を許可（書込ごとに再判定）。2026-10-14: trial run（`AIDEV_WORKFLOW_TRIAL`）では承認の代わりにworktreeのgit dirのtrial record（name・token・reviewed filesのhash）で許可（rule `workflow-trial-writable`。tool / MCP / subagentの判定も同じ記録）。top-levelの`scope` / `agents` / `skills`は削除し、未知のkeyはerror。policy `agents.<name>`は撤去し、`validatePolicy`がerrorにする | 対話sessionでは効かない（設計どおり）。command stepの`writable`はhookで強制しない（kitが実行するcommandのため。PRに入れる範囲を示すだけ） |
| agentの能力（frontmatterの`skills` / `tools` / `mcp` / `subagents`） | 実装済み（2026-09-23） | skillはagentのpromptに差し込む。claudeはagent stepごとに一時`--mcp-config`（agentのserverだけ、repo外、step後に削除）+ `--strict-mcp-config` + `--allowedTools mcp__<server>` + `--tools`で起動（Claude Code 2.1.280で確認）。guard-write（matcher `...|mcp__.*`）がworkflow step内の未許可tool / MCP toolをdeny、workflow外のMCP呼び出しには答えない。制限できないtool（copilot / codex / kiro）で`tools` / `mcp`を持つagent、`.mcp.json`に無いserverは起動前に拒否（`--dry-run`も表示してexit 1）。先に完了したagent stepの最終報告を後のstepのpromptへ（各末尾6000文字）。2026-10-12（D24）: workflowのtop-levelの`agents: { <agent>: { skills, mcp, tools, subagents } }`でそのworkflowだけ能力を足す（`skills` / `mcp` / `subagents`は和集合、`tools`は置き換え）。2.0.0のworkflow.yamlを今の書き方にする`scripts/convert-workflow-v2.ps1`（行単位でコメントを残し、kitの`validateDefinition`で検証してから書く）。2026-10-23: frontmatterで与えた`Bash` / `WebFetch` / `WebSearch`（`tools`が無ければ3つとも）を`--allowedTools`で事前承認（acceptEdits + `--permission-prompts none`では承認されず全て拒否されていた。実機で確認）。command stepとuntilのcommandが実行を止めたときは、その出力と`description`を画面に出す | `Bash`を持つagentはMCPを通さず外部へ出られる（reviewで防ぐ）。`convert-workflow-v2.ps1`はpwsh 7.4でだけ確認（Windows PowerShell 5.1は未確認）。stepを1行の`{ ... }`で書いた2.0.0の定義は手で直す。copilot / codex / kiroで`tools` / `mcp`を持たないagentは制限なしで動く。hookの第2段がclaude以外で働くかは実機未検証 |
| self-evolution | 実装済み（kit開発者のみ。CLI外） | 開発者marker、Stop hookのtranscript集計と1回のblock、振り返りfile、`npm run evolve -- run`（`scripts/evolve.js`。worktree + evolution agent、`--auto`でhookから起動） | PR作成はagentの手元tool任せで、CLIは作らない。閾値は固定。claude以外のtoolのsessionは対象外。実機E2E検証なし |
| MCP launcher | 削除済み（2026-09-23） | — | `.mcp.json`はPKGの所有。kitはMCP serverを配布・起動しない |
| `aidev uninstall [--all]` / re-adopt | 実装済み | `--package`でそのPKGからkitを外す（旧eject: dry-run、`--yes`必須、hook解除→control surface削除の順序、marker、`--keep-assets`、`--force`）、`--all`で登録PKG全部 + CLI本体、引数なしでCLI本体のみ。`init`で再採用 | 高影響のため人間reviewが必要 |
| 他のAI tool adapter | 部分実装 | `tools.js` registry（`claude` / `copilot` / `codex` / `kiro`）、toolごとの`templates/<tool>/`（copilot: `.github/copilot-instructions.md` + agents + skills + `.github/hooks/aidev.json`、codex: `AGENTS.md` + `.codex/hooks.json`、kiro: `.kiro/steering` + agents + `.kiro/agents/aidev.json`）の適用 / prune、`ALWAYS_PROTECTED`と`settings.json` denyへの追加、`aidev sync wiki --agent-tool` / `tools.agent` / `tools.agents.<name>.tool` / workflow.yamlの`tool:`での起動、`AIDEV_<TOOL>_BIN`、hook adapter（`--tool`） | claude以外は実機未検証（argvとhook形式は各toolの公開仕様準拠。`aidev run workflow --dry-run`で確認）。claude以外のtemplateはclaude版から起こしたもので、kit保守者が手で同期する。Antigravity CLI未対応。codexはagentを名前で選べずprompt fileに定義を前置 |
| 他のhosting provider | 未実装 | `azure-devops` / `generic` | GitHub / GitLab adapterは存在しない |
| 1行install（`irm <url> \| iex` / `curl \| bash`） | 未実装 | 設計は`proposals/2026-09-22-one-line-install.md`。`install.ps1` / `install.sh`がremote modeでclone→自分自身をlocal modeで子process実行 | ホスティング先URLが未確定。private hostingではscriptの匿名配信先が別に要る |
| Wiki自動追従（branch上のHEADを対象、hookの注入とStop拒否、`aidev sync wiki`） | 実装済み（2026-09-22） | 上記「`aidev sync wiki`」「hooks」の行。設計は`proposals/2026-09-21-wiki-auto-update.md`、`proposals/2026-09-22-wiki-update-flows.md` | claude以外のtoolでは実機未検証 |
| `aidev task`、`aidev plan`、`aidev kit apply`、`aidev profile` / `config` / `pkg`、`aidev sync`（旧: publish）、`aidev knowledge *`、`aidev agent *`、`aidev workflow *`、`aidev status`、`aidev permission *`、`aidev apply`、`aidev configure`、`aidev show`、`aidev eject`、`aidev mcp`、`aidev evolve`、`aidev update kit|wiki`、`aidev init --wiki` / `--no-wiki` | 削除済み | — | routing表にない。文書に書かない。2026-09-23の動詞先行化で `check` / `sync tools|wiki` / `create policy` / `uninstall --package` / `update`（kitのみ）へ。`evolve`は`scripts/evolve.js`（`npm run evolve`）、MCPはPKG所有 |

## 利用者向け文書で避ける表現

- 「`init`がWikiを生成する」: `init`は設定・template・policy・registryだけを行い、Wikiは状態を報告して`aidev sync wiki --no-commit`を案内する。生成・再開はすべて`aidev sync wiki`。`init`のexitはWikiに影響しない
- 「`init`が`.claude`を生成しない」: templateから適用する（`tools.default`のtoolぶん）
- 「`aidev update`がPKGのfileを更新する」: kit本体だけ。PKGへは`aidev sync tools`
- 「kit所有fileの編集はdrift」: teamの編集は保持・mergeされる。exit 2は未解消conflictとkit hooks欠落だけ
- 「`sync wiki --no-agent`がproseを生成」: 構造だけ書き、proseはqueueに残る（exit 1）。完了報告があれば取り込んでcommitする
- 「`doctor`がAzure DevOps認証を検証」: 環境変数の有無まで
- 「tracking branch上の`sync wiki`が手元のcheckoutを更新する」: 一時worktreeで作業し、結果は`aidev/wiki-<sha12>`のPRとして届く
- 「`--resume` / `--to` / `--check-only`がある」: 存在しない。継続は同じcommand、破棄は`--abort`、targetは常にHEAD、状態は`aidev check`
- 「Wikiが未commitの変更を説明する」: generation targetが汚れていれば`sync wiki`もhookも止まる。Wikiはcommitだけを説明する
- 「kitがissue-to-pr / test-writer / convention-builderや同梱workflowを配布する」: 2026-09-23に撤去。開発用agentとworkflowはPKGが`create workflow --describe`で作る（agents-creatorが書く）
- 「自己進化が利用者の環境で動く」: kit開発者の端末（`npm run evolve -- enable`）だけ。利用者ガイドには書かない
- 「workflowのtoken予算が強制される」: token計測がない。USDはtoolが報告した分（claude）だけで止まる。`workflow approve` / `approval.json` / `steps.js`は存在しない（承認は`origin/<tracking_branch>`との一致）
- 「対話中のClaudeがsub-agentとして呼んだagentもsourceを書ける」: PKG sourceを書けるのは`aidev run workflow`が起動したsession（`AIDEV_WORKFLOW` / `AIDEV_WORKFLOW_STEP`）で、承認済みworkflow（または`--trial`のtrial run。pushしない）の実行中stepの`writable`の範囲だけ
- 「workflowのstepは常に1つずつ動く」: `for_each.parallel`とparallel groupで同時に動く（D25）。どちらも同じ作業treeで、書く場所が重ならない定義だけ
- 「workflowがstepごとにagentの使えるtoolやskillを決める」: 能力はagentのfrontmatter（`skills` / `tools` / `mcp` / `subagents`）と、workflowのtop-levelの`agents:`（agent単位。`skills` / `mcp` / `subagents`は追加、`tools`は置き換え。D24）が決める。stepに`skills` / `mcp` / `tools` / `subagents`は書けない
- 「`create policy --approve`が手で足した許可を保つ」: 候補は`aidev.yaml`から生成し直され、手で足した`writable`は消える
- 「Wikiがcommitのたびに完全に自動で追従する」: hookは構造更新までを行い、proseは対話toolがsubagentで書き、最後に`aidev sync wiki --no-agent`を実行する。sessionがその指示に従わなければWikiは遅れたまま（Stop hookの拒否は1回だけ）
- 「Copilot / Codex / Kiroを実機で検証済み」: adapterとhook設定は公開仕様準拠で未検証（`verified: false`）
- 「GitHub / GitLabに対応」: 存在しない

## 既知の不整合（code側に残る旧語彙）

codeを読むときに混乱するので、kitへのPRで順次直してください。wrapper時代のcomment（`hook.js`、`knowledge.js`、`eject.js`、`workflow.js`）、`package.json`の`description` / `files`、`manifest.kitCommit`の不統一（現在は`sync wiki`がkit checkoutのHEADを書く）は解消済みです。

| 場所 | 内容 | 影響 |
| --- | --- | --- |
| `cli/lib/leases.js` | commentに「half-bumped submodule」 | commentのみ |
| `cli/lib/leases.js`、`.aidev/sync.lock`、`aidev.yaml`の`sync`節 | 名前が`sync`のまま（`aidev sync`は撤去済み。実体はpublish lease / publish設定） | 名前のみ |
| `templates/claude/.claude/settings.json` | deny listに`.aidev/policy.candidate.yaml`が無い | 候補fileはwritableでもない（`read_only: **`でguard-writeがdeny）ので実害は小さい |
| `cli/lib/config.js` | `validateConfig`が未定義keyを黙って無視する（撤去した`self_evolution`を書いても警告しない） | typoも旧keyも検出されない |

## self-evolutionの範囲

0.6.0で実装済み（architecture.md §13、design-decisions.md D13）。維持する制約:

- kit開発者の端末（`npm run evolve -- enable`）以外では、Stop hookは何もせず記録も残さない
- 振り返りは同じsessionが書く。promptや応答やdiffや秘密は書かない（hookの指示文で禁止）
- 変更先はkitのtemplateで、settings・hooks・policyの既定を緩める変更は対象外
- PRはagentが手元のtool（MCP / gh）で作り、人間がmergeする。自動mergeはしない

## known gaps

### pending proseのseverity

structured inventoryがHEADへ進んだ時点で整合判定は「遅れていない」になり、`pendingPaths`はWARNです。これによりpublish leaseを解放して構造更新を完了できますが、`sync wiki`はprose未完了ではcommitもpublishもしません（exit 1）。prose完全性をCIで必須にするには`check --strict`を使います。strictはtracking branch先行などの他のWARNもexit 2にします。

### hook経路はsessionの協力に依存する

after-bash / Stop hookは構造更新までを自分で行い、proseは対話toolのsessionがsubagentを起動して書きます。sessionが指示に従わない、subagentが報告を書かない、`aidev sync wiki --no-agent`を実行しない、のいずれでもWikiは遅れたままです（Stop hookの拒否は1回だけ）。`check --strict`をbranch policyに入れることでmerge前に捕まえます。hook経路はclaude以外で実機未検証です。

### evidence再生成の粒度

inventoryは「どのpageがどのsupporting evidenceへ依存したか」を記録しません。generation target外のcode / test / config / CIが1件でも変わると全generation targetをqueueします。改善はpage単位のdependency graphであり、evidence範囲を狭めて回避してはいけません。

### hooksの限界

- `.claude/settings.json`はmanaged settingsではなく利用者が変更できる。hooksを外す編集はdriftとして`check`が捕まえ、branch policyで止める前提
- Bash path抽出は既知command / redirection中心で完全ではない。targetを1つも抽出できないBashはallowになる
- `read_only`のPKG fileをagentに編集させる方法は、承認済みworkflow（`origin/<tracking_branch>`と同一。または`aidev run workflow --trial`のtrial run）の実行中stepの`writable`か、teamが`.aidev/policy.yaml`の`writable`（全員）に書くことだけ。対話sessionのsub-agentにはstepの`writable`は効かない
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
