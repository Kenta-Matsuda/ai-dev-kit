# CLI reference and contracts

公開entrypointは`aidev`、routingの正本は`cli/bin/aidev.js`です。各command moduleは`run(ctx)`、`FLAGS`（受け付けるoption）、任意の`FLAG_HELP`、`summary`を公開します。この文書は`AIDEV_NO_UPDATE_CHECK=1 node cli/bin/aidev.js <cmd> --help`の出力と一致させています。help文言を変えたら文書も直してください。

## 共通契約

- `aidev --help` / `-h` / `help`、`aidev --version` / `-V` / `version`
- `aidev <command> --help`はその`FLAGS`を表示する。`FLAG_HELP`で`false`を指定したflagは受理するが表示しない（隠しflag）
- optionは各commandの`FLAGS`で宣言され、未知のoptionはエラー（exit 1）。`--flag=value`形式も可。boolean flagに`=true|false`以外の値は不可。`--`以降はpositional
- objectを持つcommand（`bin/aidev.js`の`SUBCOMMANDS`: `create` workflow|agent|skill|policy、`modify` / `edit` / `estimate` / `submit` / `run` workflow、`remove` workflow|agent|skill、`list` workflows|agents|skills|packages、`sync` tools|wiki、`hook` session-start|guard-write|quality-gate|after-bash|session-stop）はobject必須
- repo rootは`git.findRepoRoot(cwd)`（`aidev.yaml`または`.aidev/`を上へ探索）。`hook`だけは`CLAUDE_PROJECT_DIR`を起点にする
- `--package <name|path>`（`-p`、`--package=<v>`）は`aidev.js`の`takePackageOption`が各commandの`parseArgs`より先に取り除き、`home.resolvePackage`（registry名、同名が複数ならerror、なければdirectory）→`findRepoRoot(dir) || dir`をrepo rootにする。`ctx.packageRef`に元の値が入る。受け付けるのは`PACKAGE_COMMANDS`（`init` / `check` / `doctor` / `create` / `modify` / `edit` / `estimate` / `remove` / `list` / `submit` / `run` / `sync` / `uninstall` / `ask`）だけで、`update`と`hook`はexit 1（黙って無視しない）。2回指定、値なしもexit 1。`--`以降は見ない。`--help`は`PACKAGE_COMMANDS`に`package:`欄を出す
- `hook`・`update`（`QUIET_COMMANDS`）以外は、`--help`・`--version`を含め起動直後にkit更新の有無を確認し（`AIDEV_NO_UPDATE_CHECK=1`で抑止）、新しければstderrに警告する。TTYで`--json`でも`uninstall`（`NO_OFFER_COMMANDS`）でもなければ先に`update`するか尋ねる（PKGへの適用は別途`aidev sync tools`）
- `AidevError`は`ui.fail`でstderrへ出し、`code`をexit codeにする。それ以外の例外は`internal error`としてexit 1、`AIDEV_DEBUG=1`でstack traceを出す

### 終了code（`cli/lib/errors.js`）

| code | 意味 | 主な発生箇所 |
| --- | --- | --- |
| `0` | success | 正常、またはwarningのみ |
| `1` | general | 実行エラー、agent失敗、`check`の`aidev.yaml`解析失敗・invalidなworkflow、`doctor`のfail、`run workflow`未完了 |
| `2` | drift | tool configのrecord欠落、`sync tools`のconflict（新規・未解消）、`.claude/settings.json`のkit hooks欠落、`init`初回の既存file衝突、`check --strict`のwarning昇格 |
| `3` | permission | policy欠落・不正（`check`）、弱体化を`--force`なしで承認（`create policy --approve`） |
| `4` | knowledge | Wiki欠落・manifest破損、inventory不整合、期限切れpublish lease（`.aidev/sync.lock`） |

### `--json`

`--json`対応commandはstdoutへ**単一のJSON document**だけを書きます。診断はstderr（`ui.fail`）へ分離します。人間向け文（`ui.ok`等）はstdoutなので、`--json`時は出さないよう各commandが`human`で分岐しています。新しい出力を足すときはこの契約を壊さないでください。

### `--dry-run`

「作業treeの管理対象を書き換えない」の意味で、副作用ゼロではありません。

- `sync wiki --dry-run`: 管理対象もcacheも書かない（`done/`の残存報告も取り込まない）。networkには触れない
- `update --dry-run`: kit checkoutのoriginをfetchする
- `check` / `doctor`: `.aidev/cache/remote-check.json`と`AIDEV_HOME/cache/update-check.json`を更新し得る
- `init --dry-run`: `.aidev/.gitignore`、eject marker、registryにも触れない

## commands

### `aidev init`

PKG cloneのrootでkitを導入します。`aidev.yaml`が無ければ質問（TTYかつ`--yes`/`--json`なし）または推測で作成し、ある場合は質問せず検証だけ行います。

```text
--dry-run --yes --force --json
--name <v> --include <globs> --exclude <globs> --secrets <globs>
--hosting <azure-devops|generic> --org <v> --project <v> --repository <v>
--tracking-branch <v> --tools <list> --agent-model <v> --approve
```

処理順: 前提確認（git repo、commitあり、repo root）→ eject marker削除 → `aidev.yaml`作成/維持 → `.aidev/.gitignore` → template適用（lockが無いとき、または`--force`。lockがあれば`inspectConfig`で報告のみ） → `.aidev/materialized.json` → registry登録 → auth envの有無表示 → policy（既存なら維持、無ければ候補を表示し`--approve`または対話でyesなら配置、否なら`.aidev/policy.candidate.yaml`）→ Wiki（生成しない。manifestを読んで状態だけ報告する: 完成済みなら維持、未完了ならpending page数と`aidev sync wiki`、無ければ`aidev sync wiki --no-commit`を案内。`--wiki` / `--no-wiki`は無い）→ 次の手順の案内。exit codeはWikiの状態に依存しない。

- hostingはorigin URL（`dev.azure.com`、`*.visualstudio.com`、`ssh.dev.azure.com`）から推測し、それ以外は`generic`
- `package.include`は`src lib app apps packages services api cmd pkg internal core docs doc`のうちtreeにあるものを`<dir>/**`で提案し、無ければ`**`
- `--include`等はcomma区切り。既定のexclude・secretsは`init.js`の`DEFAULT_EXCLUDE` / `DEFAULT_SECRETS`
- `--tools`は`tools.js`のregistry（`claude` / `copilot` / `codex` / `kiro`）から選ぶ。`tools.default`に応じてclaude templateのcopyとderived config（`assets.listTemplateFiles(installRoot, { tools })`）を実体化し、lockに`tools`を記録する
- 生成した`aidev.yaml`は書き込む前に`validateConfig`を通す
- kit所有fileがlocal編集されていればconflictとして表示しexit 2（`--force`でkit版に置換）
- exit: 0 / 1 / 2（Wikiの状態はexitに影響しない）

### `aidev check`

一画面の状態表示とCI gateを兼ねます。`--strict --json --no-remote`。`.aidev/ejected.json`がある、または`aidev.yaml`が無ければ「対象外」としてexit 0（無い場合は`aidev init`を案内）。`aidev.yaml`が解析できなければexit 1。

表示: package / hosting / tools / kit、`formatSummary`（`[ai-dev-kit] head=… knowledge=… tracking=…`と判定）、tracking先端のWikiが`aidev/wiki-<sha12>`にあるときの案内、head / knowledge / tracking、Wiki（page数、target数、pending）、tool config（適用commit、customised数、conflict、hooks欠落、`sync tools`の案内）、policy、workflows（数、approved数、INVALID数）、手編集page、publish lease。

判定順は tool config（`materialized.json`欠落、未解消conflict marker、kit hooks欠落 → 2。teamの編集は通る）→ policy（欠落・不正 → 3）→ Wiki（ERROR severity、inventory不整合、期限切れpublish lease → 4。WARNは`--strict`のときだけ2）→ workflow（`workflow.inspect`がinvalid: 定義が不正、参照するagent / skillが無い → 1）。最初の問題のcodeがexit。JSONは`{ok, exitCode, problems[], package, hosting, tools, kit, severity, trackingSha, headSha, baseSha, knowledgeSha, wikiBehind, state, wiki, toolConfig, policy, syncLease, workflows[], handEdits}`。

`check.inspect(repoRoot, config, {checkRemote, installRoot})`が検査本体で、hook（session-start）と`uninstall`も使います。

### `aidev update`

kit本体だけを更新します。objectは取りません（`aidev update wiki`は「takes no object」でexit 1。Wikiは`aidev sync wiki`、tool設定は`aidev sync tools`）。

```text
--dry-run --json
```

kit checkout（`installRoot`）を`origin/main`へfast-forward-onlyで更新します。未commit変更、`main`以外のbranch、divergeは拒否（exit 1）。PKGには触れません。更新後、registryのcloneのうちlockの`kitCommit`が現在と違うものを一覧し、`aidev sync tools --package <name>`を案内します。JSONは`{ok, dryRun, kit: {updated, from, to, versionFrom, versionTo}, packagesBehind: [{path, name, applied}]}`。

### `aidev sync tools|wiki [--package <name|path>]`

対象PKGは共通の`--package`（省略時はcwdのPKG）。2つ目のpositional（旧`<package>`）は`unexpected argument`でexit 1。`aidev update`のあと、端末上の複数PKGを1か所から追従させるためにあります。flagは両objectの和集合（`--force`は両方で意味がある: toolsは編集を捨ててkit版、wikiは手編集pageの上書き / staleなleaseの引き継ぎ）。

#### `aidev sync tools`

```text
--dry-run --json --force
```

`aidev.yaml`必須。`tools.default`の各toolの`templates/<tool>/`を`assets.applyTemplates`でPKGに適用します（architecture.md §2の判定表）。結果を`created / updated / merged / kept / resolved / pruned / retired / unchanged / conflicts`で表示し、lockと`.aidev/.gitignore`を書き、registryを更新します。conflictが1つでもあればexit 2（新規のmarker、または前回のmarkerが未解消）。`--force`は全fileをkit版にし、conflictも消します。`--dry-run`は何も書きません（lockも）。JSONは各分類のpath配列と`conflicts: [{path, reason}]`。

#### `aidev sync wiki`

```text
--scope <path> --full --dry-run --json --force --no-commit --branch --no-push --abort
--no-agent --agent-name <name> --agent-tool <tool> --agent-timeout <ms> --agent-model <model>
--agent-batch-size <n> --survey --no-survey
```

WikiをHEADに追従させ、`.aidev/knowledge/`を別commitとして積みます（`knowledge.js`の`update` → `updateInPlace`または`publish`）。旧`knowledge build` / `knowledge status` / `sync`はこれに統合されました。

共通:

- `--abort`: publishのworktree削除とlease解放のみ。lease不在でも警告してexit 0
- **clean-tree**: generation target（`package.include`）に未commit変更があれば（`inventory.dirtyTargets`）、pathを最大20件列挙してexit 1。kit管理pathと`.aidev/knowledge/`の汚れは問わない
- 経路の選択: `--branch`、またはcheckoutのbranchが`sync.tracking_branch`で`--no-commit` / `--dry-run`でない → publish。それ以外はin-place。`--branch`と`--no-commit`の併用、`--no-push`を`--branch`なしで付けるのはexit 1

in-place（`updateInPlace`）:

- target SHAはHEAD（`gitMod.headSha(root)`）。解決できなければexit 1
- 開始時に`done/`の残存報告を`applyCompletions`で取り込む（`--dry-run`では行わない）
- 増分が既定。`--full`は記録済みinventoryを捨てて全件をqueueする。`checkpoint.pendingPaths`の残りは常に再queue、supporting evidence変更時は全件queue。`renamed`（同一blob・別path）はprose再生成なし
- `--scope`はgeneration targetだけを絞り、scope外のqueueは`deferred`としてcheckpointへ残す。scopeに1件も一致しなければexit 1
- 手編集page（`modified`）があれば`--force`か`--dry-run`でない限りexit 1
- inventoryがHEADのtreeと一致し、queueも構造変更も無ければno-op。folded reportsで完成しているが未commitならここでcommitする
- ERRORかつWikiありの状態では構造を書く間だけpublish leaseを取る
- inventory shard、orphan page削除（`removed`だけが参照していたpage）、manifest（`knowledgeSha = targetSha`、`kitCommit = kit checkoutのHEAD`、`checkpoint.pendingPaths`）、`.aidev/.gitignore`、無ければ`index.md` stubを書く
- agentは既定で起動する（`agent.runWikiAgent`、batch = `knowledge.agent_batch_size`、各batch `knowledge.agent_timeout_ms`）。`--no-agent`で構造だけ書いてproseをqueueに残す。queueが空ならagentは起動しない
- toolは`--agent-tool` > `tools.agents.<agent>.tool` > `tools.agent`。`tools.default`に無いtoolはexit 1。modelも同じ順
- 終了後にmanifestを再読込して`assessWikiProgress`。残りがあれば`.aidev/knowledge/.cache/plan.json`を書き（`writePlanFile`）、無ければ消す
- **commit**: 残り0かつagentが失敗していなければ`commitWiki`（`git add -A -- .aidev/knowledge .aidev/.gitignore` → `git commit -m "aidev: update Wiki for <sha12>"`。stageが空なら`committed: false`）。`--no-commit`では作業treeに残す。prose未完了ならcommitせずexit 1
- JSON: `{ok, structuredOk, targetSha, branch, files, generationTargets, evidenceFiles, shards, diff, orphans, pending, deferred, remaining, agent, committed, commitSha, commitReason, plan}`。no-opは`{ok, noop, targetSha, remaining: 0, committed, commitSha}`

publish（`publish`。tracking branch上または`--branch`）:

- publish lease（`.aidev/sync.lock`）: 既存leaseの`targetSha`がHEADと同じなら継続、違えばexit 1（`--abort`か`--force`を案内。`--force`で引き継ぐ）
- `.aidev/cache/wiki-worktree/`にHEADのdetached worktreeを作る（同一SHAのworktreeがあれば再利用、違えば作り直す）
- worktree内で`updateInPlace`（`commit: false`）。no-opならworktree削除・lease解放でexit 0
- prose未完了なら何もpushせずexit 1（leaseとworktreeは残す。同じcommandで継続、`--abort`で破棄）
- 完了したら`git checkout -B aidev/wiki-<sha12>` → `commitWiki` → `--no-push`でなければ`push --force-with-lease --set-upstream origin` → `sync.auto_pr`かつhosting azure-devopsかつauth env設定時のみPR作成/更新（`<!-- aidev:wiki-stream <id> -->`で同一streamのopen PRを探し、同じsource branchなら説明を更新、違えば新PR + 旧PRへsuperseded注記）→ worktree削除 → lease解放
- 例外時はleaseとworktreeを残す
- JSON: `{ok, targetSha, branch, committed, commitSha, pushed, diff, pr, agent}`。no-opは`{ok, noop, targetSha, branch}`
- exit: 0 / 1（prose未完了、agent失敗、lease競合、commit / push失敗は0のまま`pr.reason`に理由）

hookは`updateInPlace`を`{ 'no-agent': true, json: true }`で呼びます（内部command参照）。`init`はWikiを更新しません。

### `aidev create|modify|edit|estimate|submit|run|list|remove … workflow`（開発のcommand）

動詞ごとに1 module（`create.js` / `modify.js` / `edit.js` / `estimate.js` / `submit.js` / `run.js` / `list.js` / `remove.js`）で、workflowの実装は`cli/commands/workflow.js`（`newWorkflow` / `modifyWorkflow` / `estimateWorkflow` / `submit` / `runWorkflow` / `list`）、`cli/lib/workflow.js`、`cli/lib/editor.js`（`edit`）です。objectは`bin/aidev.js`の`SUBCOMMANDS`で検査され、無い・違うobjectはmoduleに入る前にexit 1。

```text
create:  --json --force --dry-run --describe <text> --approve
submit:  --json --dry-run --no-push
run:     --json --dry-run --task <text> --task-file <path> --max-minutes <n> --resume <run id|last> --dated --log <file>
list:    --json
remove:  --json --dry-run
modify:  --json --dry-run --describe <text> --from-run <run id|last>
edit:    --json --port <n> --no-open
estimate: --json --task <text> --task-file <path> --ai --review
```

- `create workflow <name>`: 名前は`^[a-z0-9][a-z0-9-]{0,63}$`。既存なら`--force`。既定はtemplate YAML。`--describe "<text>"`は`aidev.yaml`必須で、`workflow-creator` agentを`tools.agent`（`tools.agents.workflow-creator`で上書き）で起動し、終了後に`loadDefinition` + `resolveDependencies`で検証。検証失敗はexit 1（fileは残す）。`--dry-run`は書かない・起動しない
- `submit workflow <name>`: `aidev.yaml`必須。定義と依存を検証し、`approvalStatus`が既に`approved`なら何もせずexit 0。`aidev/workflow-<name>`へ`checkout -B`、`reviewedFiles`（`workflow.yaml` + stepが名指すPKG内agent + それらが起動できるPKG内subagent + それらのagent・subagentがfrontmatterの`skills`かworkflowの`agents.<agent>.skills`に挙げるPKG内skill）だけをcommit（`aidev: workflow <name>`）、`push --set-upstream origin`、`hosting.type: azure-devops`ならPR作成（本文は目的、`describeSteps`の「Steps」節（stepごとのagent・`description`・`writes`・`skills; tools; mcp`・`until`）、「Agents and skills」、上限、「Files under review」。同じsource branchのactive PRがあれば本文更新。失敗は警告で手動）、`generic`は手動案内。`--no-push`はcommitまで。JSON: `{ok, name, branch, target, sha, committed, pushed, pr, files}` PR本文は`submitDescription`（承認済みの版との差分`definitionChanges`、見積もりの前後、file の`new` / `changed`、modifyのnoteがあれば「Why this change」）。全文を`.aidev/cache/submit/<name>.md`に書き、JSONの`description`がそのpath。Azure DevOpsへは`fitDescription`で4000文字まで。
- `run workflow <name>`: `aidev.yaml`必須。`loadDefinition` → `resolveDependencies` → `approvalStatus`。未承認はexit 1（理由と手順）。tool / modelはagentごとに`workflow.yaml`の`tool` / `model` > `tools.agents.<name>` > `tools.agent` / `tools.agent_model`（`assertToolEnabled`）。toolのadapterが`capabilities`を持たないのに`tools` / `mcp`を持つagent、`.mcp.json`に無い（または`.mcp.json`が無い）MCP serverを挙げるagentは、何も始めずにexit 1。agent stepごとに`AIDEV_WORKFLOW` / `AIDEV_WORKFLOW_STEP`（`for_each`なら`AIDEV_WORKFLOW_ITEM`も）を渡し、claudeはagentのserverだけの一時`--mcp-config`・`--strict-mcp-config`・`--allowedTools mcp__<server>,…`・（agentが`subagents`を持てば）`--agents <一時file>`・`--tools`で起動する。parallel groupのstepと`for_each.parallel`の対象は同時に起動する（architecture §9）。`subagents`を持つagentがあり、PKGの`.claude/settings.json`のguard-writeが`Agent`を見なければ起動前にexit 1。先に完了したagent stepの最終報告（各末尾6000文字）を後のagent stepのpromptに入れる。`--task` / `--task-file`（排他）は全agent stepに「Task for this run」として渡す。`--max-minutes`は`limits.max_minutes`があれば下げる方向にだけ効き、無ければそのrunの時間の上限になる。`limits.max_minutes`も`--max-minutes`も無く、claude以外のtoolで動くagentがあれば起動前にexit 1。`--log <file>`はrunの全過程とsummaryをそのfileに書く（architecture §9）。PKGのcheckoutには触れず、`runtree.prepare`のworktree（`<AIDEV_HOME>/worktrees/<PKG>-<hash>/<branch>`）でbranch `aidev/<name>`（`--dated`なら`aidev/<name>-<yyyymmddHHMM>`）の上で作業する（新しい実行は`writable`に未commitの変更があればexit 1、branchはbaseへ進めるかbaseをmerge。衝突・別processのlock・worktreeの定義が承認済みでなければexit 1）。stepが通るたびに`aidev(<name>): <step>`のcheckpointをcommitし、記録の`checkpoint`に入れる。stepを順に実行し、全stepが完了でexit 0、停止（agent失敗、`until`（commandか確認役agent）の再試行切れ、同一失敗、`command`のexit 0以外、時間、費用、commit / push失敗）はexit 1。終了時に`.aidev/estimates/records/<name>-<runId>.json`を書き、条件を満たせばestimate-reviewerを起動する（architecture §9「見積もりの学習」。JSONに`estimateRecord`・`estimateReview`）。記録はworktreeの`runs/<id>/`に実行しながら書く: `run.json`（`{runId, name, hash, approvedRef, approvedSha, startedAt, finishedAt, startedBy, branch, baseSha, task, steps[], done, stopReason, agentRuns, costUsd, pr, calls[], estimate, resumes?}`。`estimate`は開始時の見積もり（`compactEstimate`。resumeでは最初のもの）。`calls`はagentの起動ごとに`{step, role: agent|until, agent, item?, attempt, tool, model, actualModel?, ok, costUsd, durationMs, tokens?}`（resumeでも前回分を引き継ぐ。`estimate`が読む）。stepが終わるたびに更新し、実行中は`finishedAt: null`・`done: false`。stepは`{id, kind, ok, attempts, result?, review?, log?, output?, sha?, pushed?, skipped?, items?}`。`for_each`のstepは`items: [{item, ok, attempts, result?, review?, log?, report?}]`を持ち、`attempts`は全対象の合計）、`unchanged/<step>.json`（`unchanged`のpathのstep開始時の状態）、`log.txt`（追記）、`reports/<step>.md`と`reports/<step>.until.md`（完了したagent stepと確認役の最終報告の全文）、`logs/<step>.<attempt>.<n>.log`（commandの出力全文）、`diffs/<step>.<attempt>.diff`（確認役に見せた`git diff HEAD`）、`notes/`（agent stepが後のstepへ残すfile）、`pull-request.md`（PR本文の全文。`pr.description`がそのpath）。`--resume <run id|last>`は`done: false`の記録（PKGのcheckoutと各worktreeから探す）を続ける: `hash`が今の定義と同じこと、記録に`branch`があることを要求し（違えばexit 1）、そのworktreeの`writable`の未commitの変更を戻して最後のcheckpointから、`ok`のstepを飛ばして報告を`reports/`から読み戻し、`for_each`のstepは一覧を読み直して`ok`または`failed`だった対象を飛ばし、task・`baseSha`・run idを引き継ぐ。`--task` / `--task-file`とは併用不可。時間と費用の上限はその起動で数え直し、`agentRuns` / `costUsd`は合計、`resumes[]`に`{at, step}`を足す。手元のbranchは問わない。`--dry-run`は承認状態・file別状態・agents（tool、出所）・limits・taskと、stepごとの内容（agent、`writes`、`skills; tools; mcp`、`until`）を表示し、起動前に拒否される問題があれば並べる。承認済みかつ問題なしならexit 0、それ以外はexit 1。`cost`行に`estimate`（AIなし）の楽観〜悲観を出す。JSON: `{ok, name, hash, approval, problems, estimate, dryRun}`
- `modify workflow <name> --describe "<text>" | --from-run <run id|last>`: `aidev.yaml`必須。`workflow.yaml`が無ければexit 1、`--describe`も`--from-run`も無ければexit 1。`--from-run`は`findRun`で探し（無ければexit 1）、`runDigest`をpromptに入れ、最終messageの`CAUSE:`行を`cause`として読む（定義が今validateしなくてもよい）。`workflow-creator`を`create --describe`と同じtool / modelで起動し、promptに今のYAML全文・変更の指示・`catalogue`と、他のworkflowも名指すPKG agent（`sharedAgents`）を「編集せず新しいagentを作る」として渡す。起動前後で`.aidev/workflows/<name>/`（`runs/`を除く）・`.aidev/agents/`・`.aidev/skills/`のfileを比べ（`definitionFiles` / `fileChanges`）、変わった・消えたfileの元の内容を`.aidev/cache/modify/<name>-<stamp>/<rel>`に書く。その後`loadDefinition` + `resolveDependencies`。exit 0は「変更あり・検証OK」だけで、agent失敗・検証失敗・変更なしはexit 1（fileは残す）。共有agentが変わったら警告。`--dry-run`は起動しない。JSON: `{ok, name, changed, added, removed, problem, editedShared, backup, costUsd}` 変更があれば`.aidev/cache/modify/<name>.json`を書く（`submit`のPR本文が読む）。JSONに`fromRun`（`runId`・`stopReason`・`repeated`・`step`・`excerpt`・`agentRuns`・`costUsd`）と`cause`。
- `edit workflow <name> [--port <n>] [--no-open] [--json]`: `aidev.yaml`必須。`workflow.yaml`が無ければexit 1。`lib/editor.js`の`startEditor`を`127.0.0.1:<port>`（既定0 = 空きport）でlistenし、`http://127.0.0.1:<port>/#t=<token>`をbrowserで開く（`--no-open` / `AIDEV_NO_BROWSER`で開かない）。pageの`POST /api/close`かSIGINT / SIGTERMでexit 0。保存は`workflow.yaml`だけ（検証が通り、読み込んだときのsha256と今のfileが同じとき）。`--port`が1–65535の整数でない、listenできないはexit 1。JSON: 開始時`{ok, name, url, port, listening: true}`、終了時`{ok, name, listening: false, saved}`（architecture §9「workflow editor」）
- `estimate workflow <name> [--task|--task-file] [--ai] [--review]`: `aidev.yaml`必須。承認は問わない。`lib/estimate.js`の`collectHistory`（`.aidev/estimates/records/`のrecordと、recordの無いこの端末の`run.json`の`calls`と`steps[].items`）、`readPriors`、`readJudgment`、`launchPlan`のmodelと定義から`estimateDefinition`で計算する（`calibrate`の補正込み）。`--ai`で答えが読めたらsize・checkSize・kindを`.aidev/estimates/judgments/<name>.json`に書く。`--review`は先に`reviewEstimates({force: true})`（新しいrecordが無ければ`review.ok: false`と理由。exit 0のまま）。`--ai`は`cli/agents/cost-estimator.md`（PKGに配布しない）を`definition`で前置して`tools.agents.cost-estimator` / `tools.agent`のtoolで起動し、claudeなら`--tools Read Glob Grep`と空の`--mcp-config`。最終messageの最後の```jsonを`parseAiAnswer`で読み、読めなければ警告して定義だけで計算（exit 0）。JSON: `{ok, approved, task, history: {starts, records}, estimator, judgment, review, priors, name, optimistic, pessimistic, uncapped, worstCase, budget, cap, reportsCost, overBudget, steps[], ai, calibration: {pairs, coverage, widen, sizes}}`
- `list workflows`: 各workflowの`{name, description, status, steps, writable}`（`writable`は全stepの和集合。statusは`approved` / `not on <ref>` / `changed since <ref>` / `invalid: <理由>`）。JSONは`{workflows: [...], ref}`（同梱workflowは無い）。`aidev.yaml`が無くても動く（refは`origin/main`）
- exit: 0 / 1

- `create agent <name>`: `.aidev/agents/<name>.md`のtemplate（frontmatter（`name`・`description`・`skills: []`・`tools`・`mcp: []`・`subagents: []`・`model: inherit`）+ 入出力契約 / 手順 / 停止条件）。`--describe`は`agents-creator`を`tools.agent`で起動し、書いたあとfrontmatterの`name`と`skills` / `tools` / `mcp` / `subagents`の書式（`capabilityError`）を検証。`create skill <name>`: `.aidev/skills/<name>/SKILL.md`のtemplate（`--describe`は無い）。既存は`--force`
- `list agents` / `list skills`: PKG（`.aidev/`）とkit同梱を出所付きで一覧。同名はPKGが優先
- `list packages`: registry（`home.listPackages`）の全PKG。PKGの外でも動く。`templates`は`home.appliedKitCommit`（PKGのlockの`kitCommit`、無ければregistryの値）とkit checkoutのHEADを比べて`current` / `behind` / `unknown`。`aidev.yaml`が消えたentryは`present: false`で残す（registryからは消さない）。cwdのPKGに`*`。`behind`の行には`aidev sync tools --package <name>`（名前が重複するならpath）を添える。JSONは`{kitCommit, packages: [{name, path, present, here, templates, applied}]}`
- `remove workflow|agent|skill <name>`: fileを削除する（workflowは`runs/`ごと）。PKGのworkflowのstepまたは`until.agent`が名指すagent、それらがsubagentとして起動できるagent（frontmatterの`subagents`、workflowの`agents.<agent>.subagents`）、それらのagent・subagentがfrontmatterの`skills`に挙げるskill、workflowの`agents.<agent>.skills`が挙げるskillは拒否。commitは人が行う
- `create policy [--approve] [--force] [--dry-run]`: 権限policyの候補生成と配置（`permission.configure`。旧`permission configure|reconfigure`）。名前は取らない
- 動作: 候補を`aidev.yaml`から生成し`validatePolicy`で検証。`--approve`なしなら`.aidev/policy.candidate.yaml`を書く。`--approve`で`.aidev/policy.yaml`へ配置し候補を削除。policyが既にあっても同じ（旧`reconfigure`は無い）
- `--approve`は候補fileを読まず、その場で`aidev.yaml`から生成した内容を配置する。手で編集した候補や、現行policyに手で足した`writable`は引き継がれない（teamの追加は`.aidev/policy.yaml`を直接編集してPRでreviewする）
- 現行policyより保護が減る（protected / read_only / writable_during_syncからの削除、sync時のみ書込可のpathがwritableへ昇格）場合、`--approve`だけでは配置せずexit 3。`--approve --force`で配置
- `--dry-run`は候補を表示するだけ（`--approve`と併用しても書かない）
- 有効なpolicyの表示は`aidev check`（policy行）と`aidev doctor --package <name>`（policy行）。`agents`キーを持つpolicyは`validatePolicy`がexit 3で拒否する
- 実装は`cli/commands/permission.js`（`configure`）。入口は`create.js`（`create policy`）
- `create workflow --describe`はworkflow-creatorに、参照できるagent / skillの一覧とschemaのtemplateを添える。kitは開発用agent・workflowを同梱しないので、足りないagent / skillはworkflow-creatorが`agents-creator`をsubagentで起動して`.aidev/agents/`・`.aidev/skills/`に書き、MCPは`.mcp.json`（PKG所有）への追加案としてfinal messageに出す

### `aidev doctor [--package <name|path>]`

`--json`。この端末を見ます: node（20以上）、platform、git、aidevのversionと`installRoot`、kit checkoutのcommit、kit更新の有無、`AIDEV_HOME`、登録PKG（数と一覧）、registryの全AI tool（`tools.js`）の有無とversion、proxy。`--package`を付けたときだけ、そのPKGの`aidev.yaml`（schema）、git repo / branch、origin、policy、agent tool / model、auth env、remote到達性、Wiki状態、workflows（数、approved、invalid）も✓ / ⚠ / ✗で並べます。✗があればexit 1。CIのexit契約は`aidev check`だけが持ちます。

### `aidev uninstall [--package <name|path>] [--all]`

```text
--yes --dry-run --json --all --force --keep-assets
```

- 引数なし: この端末からCLIを消す（下記）。`--package`: そのPKGからkitを外す（旧`eject`。`cli/lib/eject.js`）。`--all`: 登録PKG全部を外してからCLIを消す。`--package`と`--all`は排他。positionalはexit 1。どれも`--yes`必須、`--dry-run`で予告

#### 端末（引数なし、または`--all`の最後）

```text
--yes --dry-run --json
```

installerが置いたものをこの端末から消します。順序: bin directory（`AIDEV_BIN_DIR`、既定はWindows `%LOCALAPPDATA%ai-dev-kitin`、POSIX `~/.local/bin`）の`aidev.cmd` / `aidev.ps1` / `aidev`のうち"Generated by ai-dev-kit"を含むものを削除 → Windowsではuser PATHからbin directoryを除去（PowerShell経由、best-effort、entryがあるときだけ書く） → `AIDEV_HOME`の`registry.json`と`cache/`を削除 → 空になったbin directoryと`AIDEV_HOME`を削除。`--yes`なしでは一覧を表示してexit 1。消すものが無くてもexit 0。

削除しないもの: kit checkout（`installRoot`。実行中のprocessの居場所で、Windowsでは内側からの削除が不安定）と登録済みPKG内のkit所有file（commit済みでteam共有）。どちらも消すcommandを表示します。PKG向けには`aidev uninstall --package "<path>" --yes`と、`assets.listStaticFiles`を`collapsePaths`で「kit所有fileしか無いdirectory」まで畳んだ`git rm -r -q -- …`（`.aidev`と`aidev.yaml`を含む。ejectと違いWikiも消える）を出します。

#### `--package`（旧eject）

```text
--yes --dry-run --json --force --keep-assets
```

kit管理を解除します。既にejected（marker あり）なら`--force`なしでexit 0。`aidev.yaml` / `materialized.json` / `policy.yaml`のどれも無ければ`--force`なしで拒否。有効なsync leaseがあれば`--force`なしで拒否。

順序: `.claude/settings.json`から`aidev hook`を呼ぶhookだけを外す → `policy.yaml`、`policy.candidate.yaml`、`materialized.json`、`sync.lock`、`cache/`を削除 → `--keep-assets`でなければkit所有file（lockに記録されたfileと現在のtemplateが置くfile。teamが追加したfileは含まない）を削除 → 空になった`.aidev/`を削除 → registryから除外 → `.aidev/ejected.json`を書く。`--yes`なしでは一覧を表示してexit 1。PKG file、`.aidev/knowledge/`、`aidev.yaml`、`.aidev/workflows/`は残します。

### `aidev ask "<question>"`

```text
--json
```

`cli/commands/ask.js`。positionalを空白で連結したものが質問（空ならexit 1、4000文字超もexit 1）。PKGの外でも動く。`cli/agents/kit-guide.md`（PKGに配布しない）を`definition`で前置し、**常にclaude**で、cwdを**kit checkout**（`installRoot`）にして起動する: `--tools Read Glob Grep`、空の`--mcp-config`と`--strict-mcp-config`、promptはstdin（kit checkoutに何も書かない。`update`はclean treeを要求する）、10分。modelは`agentSettings(config, 'kit-guide')`のtoolが`claude`のときだけそのmodel（他toolのmodelはclaudeに渡さない）。promptは質問（data扱い）、`bin/aidev.js`の`commandReference()`（`ctx.commandReference`。`HIDDEN_COMMANDS`以外の全commandのobject・summary・`FLAGS`/`FLAG_HELP`、`PACKAGE_COMMANDS`なら`--package`）、PKGの中なら名前・hosting・`tools.agent`・`tools.default`・workflow / agent / skillの名前（agentはPKGを読めない）。最終messageをそのまま表示し、`costUsd`をdimで出す。答えが空・tool失敗・claude不在はexit 1。JSON: `{ok, answer, reason, tool, model, costUsd}`

### self-evolution（`npm run evolve -- enable|disable|status|run`。CLI commandではない）

`scripts/evolve.js`。kit checkoutで`npm run evolve -- <sub>`として実行します（`aidev evolve`は無い）。flagと動作は従来どおり（`--json --dry-run --auto --tool --model --timeout`。`enable`は`AIDEV_HOME/developer.json`、`run`はkit developer端末のみでworktree + evolution agent）。Stop hookの`--auto`起動は`scripts/evolve.js run --json`をdetachedで呼びます。

## 内部command

| command | caller | 用途 |
| --- | --- | --- |
| `aidev hook session-start` | SessionStart | `formatSummary`（`head` / `knowledge` / `tracking`と判定）とpublish leaseの状態、Wikiが遅れていれば追従の予告を`additionalContext`で返す。HEADを`.aidev/cache/last-head.json`に記録する |
| `aidev hook guard-write` | PreToolUse | `AIDEV_WORKFLOW`があれば`policy.decideToolUse`（stepのagentのfrontmatterとworkflowの`agents:`に無いtool / MCP toolをdeny。hook入力に`agent_id`と`agent_type`があればsubagentの呼び出しとしてそのsubagentの許可で判定し、`Agent` / `Task`は`subagent_type`が許可された`subagents`に無ければdeny）。MCP toolはそこで終わり、workflow外では何も返さない。それ以外はtool inputからpathを抽出し`policy.decideMany`。deny時は`permissionDecision: deny` |
| `aidev hook quality-gate` | PostToolUse（Write / Edit） | 編集対象にPKG fileが含まれるときだけ`quality_gates`をrepo rootで実行 |
| `aidev hook after-bash` | PostToolUse（Bash / shell） | HEADが`last-head.json`と違い、Wikiが遅れている（または prose pending）なら`followUp`: generation targetが汚れていればpathを挙げるだけ。cleanなら`knowledge.updateInPlace`を`--no-agent --json`で実行し、残り0なら（rename-onlyなど）その場でcommit、残りがあれば`plan.json`のbatch数とともに「batchごとにknowledge-builderをsubagent起動 → `aidev sync wiki --no-agent`」の指示を`additionalContext`で返す |
| `aidev hook session-stop` | Stop | Wikiが遅れている（または prose pending）かつcleanなら1回だけ`decision: block`で`after-bash`と同じ指示を返す（2回目は`stop_hook_active`、無いtoolは`.aidev/cache/wiki-stop.json`で判定し、警告付きで通す。dirtyなら止めない）。続けてkit開発者端末でのみ、transcriptを集計して閾値超えのsessionに`decision: block`で振り返りを書かせる |

`hook`のoption: `--input <file>`（stdinの代わりにfileからpayloadを読む。testとデバッグ用）と`--tool <claude|copilot|codex|kiro>`（`tools.hookAdapter`で出力の形をtoolに合わせる。既定`claude`）です。出力はadapterが決めるJSON（kiroの`session-start`だけはraw text、kiroの`postToolUse`は何も出さない）です。payloadは`{tool_name, tool_input: {file_path | edits[] | command …}}`（`session-stop`は`{session_id, transcript_path, stop_hook_active}`）。`guard-write`は常にexit 0で、失敗はdenyとして表現します（kiroのadapterはdeny時exit 2）。hooksはnetworkにもLLMにも触れません。

内部commandを人間向けworkflowの入口として扱わないでください。引数やstdin payloadはClaude Code設定との契約です。

## 削除されたcommand

`aidev plan`、`aidev kit apply`、`aidev config` / `pkg` / `profile`（wrapper時代）、`aidev task`（0.5.0）、`aidev sync`（旧publish。2026-09-22）、`aidev knowledge *`、`aidev status`、`aidev agent *`、`aidev permission *`、`aidev workflow *`、`aidev apply`、`aidev configure`、`aidev show`、`aidev eject`、`aidev mcp`、`aidev evolve`、`aidev update kit|wiki`、`aidev init --wiki` / `--no-wiki`（2026-09-23の動詞先行化・framework化）は存在せず、「unknown command」「takes no object」「needs an object」のいずれかです。現在の入口は`init` / `check` / `doctor` / `run` / `estimate` / `create` / `modify` / `edit` / `submit` / `list` / `remove` / `sync` / `update` / `uninstall`と内部の`hook`だけです。

