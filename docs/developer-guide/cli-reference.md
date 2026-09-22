# CLI reference and contracts

公開entrypointは`aidev`、routingの正本は`cli/bin/aidev.js`です。各command moduleは`run(ctx)`、`FLAGS`（受け付けるoption）、任意の`FLAG_HELP`、`summary`を公開します。この文書は`AIDEV_NO_UPDATE_CHECK=1 node cli/bin/aidev.js <cmd> --help`の出力と一致させています。help文言を変えたら文書も直してください。

## 共通契約

- `aidev --help` / `-h` / `help`、`aidev --version` / `-V` / `version`
- `aidev <command> --help`はその`FLAGS`を表示する。`FLAG_HELP`で`false`を指定したflagは受理するが表示しない（隠しflag）
- optionは各commandの`FLAGS`で宣言され、未知のoptionはエラー（exit 1）。`--flag=value`形式も可。boolean flagに`=true|false`以外の値は不可。`--`以降はpositional
- subcommandを持つcommand（`knowledge`、`agent`、`permission`、`workflow`、`evolve`、`hook`、`mcp`）はsubcommand必須
- repo rootは`git.findRepoRoot(cwd)`（`aidev.yaml`または`.aidev/`を上へ探索）。`hook`だけは`CLAUDE_PROJECT_DIR`を起点にする
- `hook`・`mcp`・`update`・`uninstall`（`QUIET_COMMANDS`）以外は実行前にkit更新の有無を確認し（`AIDEV_NO_UPDATE_CHECK=1`または`--json`で抑止）、新しければ警告し、TTYなら先に`update`するか尋ねる（PKGへの適用は別途`apply`）
- `AidevError`は`ui.fail`でstderrへ出し、`code`をexit codeにする。それ以外の例外は`internal error`としてexit 1、`AIDEV_DEBUG=1`でstack traceを出す

### 終了code（`cli/lib/errors.js`）

| code | 意味 | 主な発生箇所 |
| --- | --- | --- |
| `0` | success | 正常、またはwarningのみ |
| `1` | general | 実行エラー、agent失敗、`status`が未初期化、`doctor`のfail、`workflow run`未完了 |
| `2` | drift | tool configのrecord欠落、`apply`のconflict（新規・未解消）、`.claude/settings.json`のkit hooks欠落、`init`初回の既存file衝突、`check --strict`のwarning昇格 |
| `3` | permission | policy欠落・不正、弱体化を`--force`なしで承認、`permission show`でpolicy不在 |
| `4` | knowledge | Wiki欠落・manifest破損、inventory不整合、期限切れpublish lease（`.aidev/sync.lock`） |

### `--json`

`--json`対応commandはstdoutへ**単一のJSON document**だけを書きます。診断はstderr（`ui.fail`）へ分離します。人間向け文（`ui.ok`等）はstdoutなので、`--json`時は出さないよう各commandが`human`で分岐しています。新しい出力を足すときはこの契約を壊さないでください。

### `--dry-run`

「作業treeの管理対象を書き換えない」の意味で、副作用ゼロではありません。

- `knowledge update --dry-run`: 管理対象もcacheも書かない（`done/`の残存報告も取り込まない）。networkには触れない
- `update --dry-run`: kit checkoutのoriginをfetchする
- `status` / `check` / `doctor`: `.aidev/cache/remote-check.json`と`AIDEV_HOME/cache/update-check.json`を更新し得る
- `init --dry-run`: `.aidev/.gitignore`、eject marker、registryにも触れない

## commands

### `aidev init`

PKG cloneのrootでkitを導入します。`aidev.yaml`が無ければ質問（TTYかつ`--yes`/`--json`なし）または推測で作成し、ある場合は質問せず検証だけ行います。

```text
--dry-run --yes --force --json
--name <v> --include <globs> --exclude <globs> --secrets <globs>
--hosting <azure-devops|generic> --org <v> --project <v> --repository <v>
--tracking-branch <v> --tools <list> --agent-model <v> --approve --wiki --no-wiki
```

処理順: 前提確認（git repo、commitあり、repo root）→ eject marker削除 → `aidev.yaml`作成/維持 → `.aidev/.gitignore` → template適用（lockが無いとき、または`--force`。lockがあれば`inspectConfig`で報告のみ） → `.aidev/materialized.json` → registry登録 → auth envの有無表示 → policy（既存なら維持、無ければ候補を表示し`--approve`または対話でyesなら配置、否なら`.aidev/policy.candidate.yaml`）→ Wiki（完成済みなら維持。無い/未完了なら`knowledge.update(ctx, config, { commit: false })`を同一processで実行し、結果は作業treeに残す。初回は既定yes、設定ありWiki無し=チームのPR未マージは既定no、未完了は再開。TTYでは質問、`--wiki`/`--no-wiki`で省略）→ 次の手順の案内。exit codeはWiki updateの結果に従う（agent toolが無い、agent失敗・途中終了はprose未完了としてexit 1、`aidev init`再実行で続行）。

- hostingはorigin URL（`dev.azure.com`、`*.visualstudio.com`、`ssh.dev.azure.com`）から推測し、それ以外は`generic`
- `package.include`は`src lib app apps packages services api cmd pkg internal core docs doc`のうちtreeにあるものを`<dir>/**`で提案し、無ければ`**`
- `--include`等はcomma区切り。既定のexclude・secretsは`init.js`の`DEFAULT_EXCLUDE` / `DEFAULT_SECRETS`
- `--tools`は`tools.js`のregistry（`claude` / `copilot` / `codex` / `kiro`）から選ぶ。`tools.default`に応じてclaude templateのcopyとderived config（`assets.listTemplateFiles(installRoot, { tools })`）を実体化し、lockに`tools`を記録する
- 生成した`aidev.yaml`は書き込む前に`validateConfig`を通す
- kit所有fileがlocal編集されていればconflictとして表示しexit 2（`--force`でkit版に置換）
- exit: 0 / 1 / 2

### `aidev status`

一画面の状態表示。`--json --no-remote`。`aidev.yaml`が無ければexit 1（ejected repositoryはその旨を表示）。それ以外はexit 0。表示: package / hosting / tools / kit、tool config（適用commit、customised数、conflict、hooks欠落、`apply`の案内）、`formatSummary`（`[ai-dev-kit] head=… knowledge=… tracking=…`と判定）、tracking先端のWikiが`aidev/wiki-<sha12>` branch（localまたはorigin）に既にあるかの注記、Wiki統計（page数、target数、pending数）、policy（protected数と`agents`の許可一覧）、手編集page、inventory不整合、publish lease。旧`knowledge status`の内容はここに統合されています。

`status.inspect(repoRoot, config, {checkRemote})`が`check`と共有する検査本体です。

### `aidev check`

CI gate。`--strict --json --no-remote`。`.aidev/ejected.json`がある、または`aidev.yaml`が無ければ「対象外」としてexit 0。判定順は tool config（`materialized.json`欠落、未解消conflict marker、kit hooks欠落 → 2。teamの編集は通る）→ policy（欠落・不正 → 3）→ Wiki（ERROR severity、inventory不整合、期限切れpublish lease → 4）→ `--strict`かつWARN（Wiki behind HEAD、pending prose、tracking branch先行） → 2。最初の問題のcodeを返します。JSONには`problems[]`、`severity`、`headSha` / `knowledgeSha` / `trackingSha` / `baseSha`、`wikiBehind`、`handEdits`を含みます。人間向け表示は`head` / `knowledge` / `tracking`の3行です。

### `aidev knowledge update`

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

`init`はin-placeを`commit: false`で、hookは`updateInPlace`を`{ 'no-agent': true, json: true }`で呼びます（内部command参照）。

### `aidev agent list|show|run`

```text
--json --dry-run --tool <tool> --model <model> --timeout <ms> --prompt-file <path>
```

- `list`: `tools.listBundledAgents(installRoot)`（`templates/claude/.claude/agents/*.md`のfrontmatter）と、`config.agentSettings`で決まる各agentのtool / model。`aidev.yaml`が無ければkit既定（claude）で表示
- `show <name>`: 説明、定義file、tool、model、実際のcommand line（`previewCommand`: `tools.resolveBinary` + `agent.buildArgv`。`prompt: 'file'`のtoolはpointer文の位置をplaceholderで示す）。`verified: false`のtoolは警告
- `run <name> [task...]`: `aidev.yaml`必須。task は引数の結合 > `--prompt-file` > 非TTYのstdin。tool / modelは`--tool` / `--model` > `tools.agents.<name>` > `tools.agent` / `tools.agent_model`。`tools.default`に無いtool、registryに無いtool、同梱に無いagentはspawn前にexit 1。`--dry-run`はcommand lineを表示して起動しない。`agent.runAgent`の結果を人間向け / JSON（`{ok, agent, tool, model, timeoutMs, result, reason, skipped, timedOut, exitCode, durationMs, costUsd, permissionDenials, promptFile}`）で返し、失敗・skip・timeoutはexit 1
- exit: 0 / 1

### `aidev permission configure|reconfigure|show`

```text
--approve --force --dry-run --json
```

- `configure`: `.aidev/policy.yaml`が既にあれば`reconfigure`か`--force`を要求。候補を`aidev.yaml`から生成し（`agents`は常に空で、記入例をcommentで添える）`validatePolicy`で検証。`--approve`なしなら`.aidev/policy.candidate.yaml`を書く。`--approve`で`.aidev/policy.yaml`へ配置し候補を削除
- `--approve`は候補fileを読まず、その場で`aidev.yaml`から生成した内容を配置する。手で編集した候補や、現行policyに手で足した`writable` / `agents`は引き継がれない（teamの追加は`.aidev/policy.yaml`を直接編集してPRでreviewする）
- 現行policyより保護が減る（protected / read_only / writable_during_syncからの削除、sync時のみ書込可のpathがwritableへ昇格、`agents.<name>.writable`の追加、`agents.<name>.branch`の削除）場合、`--approve`だけでは配置せずexit 3。`--approve --force`で配置
- `--dry-run`は候補を表示するだけ（`--approve`と併用しても書かない）
- `show`: 有効なpolicy（無ければ内蔵floor）と`agents`の許可を表示。policy fileが無ければexit 3


### `aidev workflow new|approve|run|list`

```text
--json --force --dry-run --yes --max-iterations <n> --max-minutes <n> --resume
```

- `new <name>`: 名前は`^[a-z0-9][a-z0-9-]{0,63}$`。既存なら`--force`
- `approve <name>`: 定義を検証（`cost.max_tokens`か`max_usd`必須、`commands`非空、上限超過は拒否）し、content hashを`approval.json`へ記録
- `run <name>`: 承認hash一致を要求。`--max-iterations` / `--max-minutes`は下げる方向にだけ効く。`--resume`は同一hashの未完了runからiterationを引き継ぐ。完了でexit 0、上限到達等でexit 1
- `list`: approved / CHANGED since approval / not approved
- `workflow.yaml`の`agent:`（`name`必須、`tool` / `model` / `timeout_ms`任意）を`validateDefinition`が検証し、`approval.json`にも記録する。`steps.js`は`ctx.agent(prompt, { name?, tool?, model?, timeoutMs? })`で同梱agentを起動できる（`aidev.yaml`必須、toolは`tools.default`内、残り時間で打ち切り、報告costの合計が`cost.max_usd`に達したら次の起動を拒否してloop停止）。`checkpoint.json`に`agentRuns` / `costUsd`
- `--dry-run`は`agent`行（使うagentとtool）も表示する

### `aidev update`

```text
--dry-run --json
```

kit checkout（`installRoot`）を`origin/main`へfast-forward-onlyで更新します。未commit変更、`main`以外のbranch、divergeは拒否（exit 1）。PKGには触れません。更新後、registryのcloneのうちlockの`kitCommit`が現在と違うものを一覧し、`aidev apply`を案内します。JSONは`{ok, dryRun, kit: {updated, from, to, versionFrom, versionTo}, packagesBehind: [{path, name, applied}]}`。

### `aidev apply`

```text
--dry-run --json --force
```

`aidev.yaml`必須。`tools.default`の各toolの`templates/<tool>/`を`assets.applyTemplates`でPKGに適用します（architecture.md §2の判定表）。結果を`created / updated / merged / kept / resolved / pruned / retired / unchanged / conflicts`で表示し、lockと`.aidev/.gitignore`を書き、registryを更新します。conflictが1つでもあればexit 2（新規のmarker、または前回のmarkerが未解消）。`--force`は全fileをkit版にし、conflictも消します。`--dry-run`は何も書きません（lockも）。JSONは各分類のpath配列と`conflicts: [{path, reason}]`。

### `aidev doctor`

`--json`。node（20以上）、platform、git、aidevのversionと`installRoot`、kit checkoutのcommit、kit更新の有無、`AIDEV_HOME`、登録PKG数、`claude`のversion（2.1.259以上か）を確認します。PKG内なら`aidev.yaml` schema、git repo、origin、policy、agent model、`hosting.auth_env`の有無（値は読まない）、`HTTPS_PROXY`、remote到達性（cache無視）、Wiki状態も確認します。`fail`が1つでもあればexit 1、warnのみは0。

### `aidev eject`

```text
--yes --dry-run --json --force --keep-assets
```

kit管理を解除します。既にejected（marker あり）なら`--force`なしでexit 0。`aidev.yaml` / `materialized.json` / `policy.yaml`のどれも無ければ`--force`なしで拒否。有効なsync leaseがあれば`--force`なしで拒否。

順序: `.claude/settings.json`から`aidev hook`を呼ぶhookだけを外す → `policy.yaml`、`policy.candidate.yaml`、`materialized.json`、`sync.lock`、`cache/`を削除 → `--keep-assets`でなければkit所有file（lockに記録されたfileと現在のtemplateが置くfile。teamが追加したfileは含まない）を削除 → 空になった`.aidev/`を削除 → registryから除外 → `.aidev/ejected.json`を書く。`--yes`なしでは一覧を表示してexit 1。PKG file、`.aidev/knowledge/`、`aidev.yaml`、`.aidev/workflows/`は残します。

### `aidev uninstall`

```text
--yes --dry-run --json
```

installerが置いたものをこの端末から消します。順序: bin directory（`AIDEV_BIN_DIR`、既定はWindows `%LOCALAPPDATA%ai-dev-kitin`、POSIX `~/.local/bin`）の`aidev.cmd` / `aidev.ps1` / `aidev`のうち"Generated by ai-dev-kit"を含むものを削除 → Windowsではuser PATHからbin directoryを除去（PowerShell経由、best-effort、entryがあるときだけ書く） → `AIDEV_HOME`の`registry.json`と`cache/`を削除 → 空になったbin directoryと`AIDEV_HOME`を削除。`--yes`なしでは一覧を表示してexit 1。消すものが無くてもexit 0。

削除しないもの: kit checkout（`installRoot`。実行中のprocessの居場所で、Windowsでは内側からの削除が不安定）と登録済みPKG内のkit所有file（commit済みでteam共有）。どちらも消すcommandを表示します。PKG向けには`aidev eject --yes`と、`assets.listStaticFiles`を`collapsePaths`で「kit所有fileしか無いdirectory」まで畳んだ`git rm -r -q -- …`（`.aidev`と`aidev.yaml`を含む。ejectと違いWikiも消える）を出します。

### `aidev evolve enable|disable|status|run`（kit開発者向け）

```text
--json --dry-run --auto --tool <tool> --model <model> --timeout <ms>
```

- `enable [--auto]`: `AIDEV_HOME/developer.json`を書く（`--auto`は`autoEvolve: true`）。`disable`は消す。`status`は有効可否とこの端末の振り返り一覧
- `run`: 開発者端末以外はexit 1。振り返りが無ければexit 0。あればkit checkoutのworktree（`aidev/evolve-<yyyymmdd>`）で`evolution` agentを起動し、結果を表示。`--dry-run`は振り返り一覧とcommand lineだけ。agent失敗はexit 1（worktreeは残す）。JSONは`{ok, branch, worktree, reflections, tool, model, result, reason, durationMs, costUsd}`

## 内部command

| command | caller | 用途 |
| --- | --- | --- |
| `aidev hook session-start` | SessionStart | `formatSummary`（`head` / `knowledge` / `tracking`と判定）とpublish leaseの状態、Wikiが遅れていれば追従の予告を`additionalContext`で返す。HEADを`.aidev/cache/last-head.json`に記録する |
| `aidev hook guard-write` | PreToolUse | tool inputからpathを抽出し`policy.decideMany`。deny時は`permissionDecision: deny` |
| `aidev hook quality-gate` | PostToolUse（Write / Edit） | 編集対象にPKG fileが含まれるときだけ`quality_gates`をrepo rootで実行 |
| `aidev hook after-bash` | PostToolUse（Bash / shell） | HEADが`last-head.json`と違い、Wikiが遅れている（または prose pending）なら`followUp`: generation targetが汚れていればpathを挙げるだけ。cleanなら`knowledge.updateInPlace`を`--no-agent --json`で実行し、残り0なら（rename-onlyなど）その場でcommit、残りがあれば`plan.json`のbatch数とともに「batchごとにknowledge-builderをsubagent起動 → `aidev knowledge update --no-agent`」の指示を`additionalContext`で返す |
| `aidev hook session-stop` | Stop | Wikiが遅れている（または prose pending）かつcleanなら1回だけ`decision: block`で`after-bash`と同じ指示を返す（2回目は`stop_hook_active`、無いtoolは`.aidev/cache/wiki-stop.json`で判定し、警告付きで通す。dirtyなら止めない）。続けてkit開発者端末でのみ、transcriptを集計して閾値超えのsessionに`decision: block`で振り返りを書かせる |
| `aidev mcp azure-devops` | `.mcp.json` | 設定と環境変数を解決し、固定版MCP serverをstdioで起動 |

`hook`のoption: `--input <file>`（stdinの代わりにfileからpayloadを読む。testとデバッグ用）と`--tool <claude|copilot|codex|kiro>`（`tools.hookAdapter`で出力の形をtoolに合わせる。既定`claude`）です。出力はadapterが決めるJSON（kiroの`session-start`だけはraw text、kiroの`postToolUse`は何も出さない）です。payloadは`{tool_name, tool_input: {file_path | edits[] | command …}}`（`session-stop`は`{session_id, transcript_path, stop_hook_active}`）。`guard-write`は常にexit 0で、失敗はdenyとして表現します（kiroのadapterはdeny時exit 2）。hooksはnetworkにもLLMにも触れません。

`mcp`のoption: `--dry-run`（起動せず解決結果を表示）、`--json`（同内容をJSONで）。実起動時のexit codeは子processのものです。`hosting.auth_env`が未設定ならexit 1。

内部commandを人間向けworkflowの入口として扱わないでください。引数やstdin payloadはClaude Code設定との契約です。

## 削除されたcommand

`aidev plan`、`aidev kit apply`、`aidev config` / `pkg` / `profile`（wrapper時代）、`aidev task`（0.5.0で状態機械とwork leaseごと撤去）、`aidev sync`、`aidev knowledge build`、`aidev knowledge status`（2026-09-22に`aidev knowledge update`と`aidev status`へ統合。`--resume` / `--to` / `--check-only` / `--no-pr`も無い）は存在せず、「unknown command」です。wrapper repositoryへkit管理対象を取り込む操作は`aidev apply`に置き換わりました。

