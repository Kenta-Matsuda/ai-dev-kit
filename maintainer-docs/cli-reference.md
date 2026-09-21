# CLI reference and contracts

公開entrypointは`aidev`、routingの正本は`cli/bin/aidev.js`です。各command moduleは`run(ctx)`、`FLAGS`（受け付けるoption）、任意の`FLAG_HELP`、`summary`を公開します。この文書は`AIDEV_NO_UPDATE_CHECK=1 node cli/bin/aidev.js <cmd> --help`の出力（0.2.0）と一致させています。help文言を変えたら文書も直してください。

## 共通契約

- `aidev --help` / `-h` / `help`、`aidev --version` / `-V` / `version`
- `aidev <command> --help`はその`FLAGS`を表示する。`FLAG_HELP`で`false`を指定したflagは受理するが表示しない（隠しflag）
- optionは各commandの`FLAGS`で宣言され、未知のoptionはエラー（exit 1）。`--flag=value`形式も可。boolean flagに`=true|false`以外の値は不可。`--`以降はpositional
- subcommandを持つcommand（`knowledge`、`permission`、`task`、`workflow`、`hook`、`mcp`）はsubcommand必須
- repo rootは`git.findRepoRoot(cwd)`（`aidev.yaml`または`.aidev/`を上へ探索）。`hook`だけは`CLAUDE_PROJECT_DIR`を起点にする
- `hook`・`mcp`・`update`以外は実行前にkit更新の有無を確認し（`AIDEV_NO_UPDATE_CHECK=1`または`--json`で抑止）、新しければ警告し、TTYなら先に`update --kit-only`するか尋ねる
- `AidevError`は`ui.fail`でstderrへ出し、`code`をexit codeにする。それ以外の例外は`internal error`としてexit 1、`AIDEV_DEBUG=1`でstack traceを出す

### 終了code（`cli/lib/errors.js`）

| code | 意味 | 主な発生箇所 |
| --- | --- | --- |
| `0` | success | 正常、またはwarningのみ |
| `1` | general | 実行エラー、agent失敗、`status`が未初期化、`doctor`のfail、`workflow run`未完了 |
| `2` | drift | tool configがrecordと不一致、`init` / `update`のconflict、`check --strict`のwarning昇格 |
| `3` | permission | policy欠落・不正、弱体化を`--force`なしで承認、`permission show`でpolicy不在 |
| `4` | knowledge | Wiki欠落・manifest破損、inventory不整合、期限切れsync lease、`sync --check-only`でERROR |

### `--json`

`--json`対応commandはstdoutへ**単一のJSON document**だけを書きます。診断はstderr（`ui.fail`）へ分離します。人間向け文（`ui.ok`等）はstdoutなので、`--json`時は出さないよう各commandが`human`で分岐しています。新しい出力を足すときはこの契約を壊さないでください。

### `--dry-run`

「作業treeの管理対象を書き換えない」の意味で、副作用ゼロではありません。

- `sync --dry-run`: tracking branchをfetchする（remote-tracking refが動く）
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
--tracking-branch <v> --tools <list> --agent-model <v> --approve
```

処理順: 前提確認（git repo、commitあり、repo root）→ eject marker削除 → `aidev.yaml`作成/維持 → `.aidev/.gitignore` → template実体化 → `.aidev/materialized.json` → registry登録 → auth envの有無表示 → policy（既存なら維持、無ければ候補を表示し`--approve`または対話でyesなら配置、否なら`.aidev/policy.candidate.yaml`）→ Wiki有無 → 次の手順の案内。

- hostingはorigin URL（`dev.azure.com`、`*.visualstudio.com`、`ssh.dev.azure.com`）から推測し、それ以外は`generic`
- `package.include`は`src lib app apps packages services api cmd pkg internal core docs doc`のうちtreeにあるものを`<dir>/**`で提案し、無ければ`**`
- `--include`等はcomma区切り。既定のexclude・secretsは`init.js`の`DEFAULT_EXCLUDE` / `DEFAULT_SECRETS`
- `--tools`は`tools.js`のregistry（`claude` / `copilot` / `codex` / `kiro`）から選ぶ。`tools.default`に応じてclaude templateのcopyとderived config（`assets.listTemplateFiles(installRoot, { tools })`）を実体化し、lockに`tools`を記録する
- 生成した`aidev.yaml`は書き込む前に`validateConfig`を通す
- kit所有fileがlocal編集されていればconflictとして表示しexit 2（`--force`でkit版に置換）
- exit: 0 / 1 / 2

### `aidev status`

一画面の状態表示。`--json --no-remote`。`aidev.yaml`が無ければexit 1（ejected repositoryはその旨を表示）。それ以外はexit 0。表示: package / hosting / tools / kit（記録commitと実行中commitが違えば`update`を案内）、`formatSummary`、tracking先端のWikiが`ai/wiki-<sha12>` branch（localまたはorigin）に既にあるかの注記、Wiki統計、tool config（matches / DRIFT / not recorded）、policy、手編集page、inventory不整合、sync lease、有効なwork lease。

`status.inspect(repoRoot, config, {checkRemote})`が`check`と共有する検査本体です。

### `aidev check`

CI gate。`--strict --json --no-remote`。`.aidev/ejected.json`がある、または`aidev.yaml`が無ければ「対象外」としてexit 0。判定順は drift（`materialized.json`欠落または不一致 → 2）→ policy（欠落・不正 → 3）→ Wiki（ERROR severity、inventory不整合、期限切れsync lease → 4）→ `--strict`かつWARN → 2。最初の問題のcodeを返します。JSONには`problems[]`、`severity`、3SHA、`handEdits`を含みます。

### `aidev knowledge build|status`

```text
--scope <path> --full --dry-run --json --force --no-remote
--no-agent --agent-name <name> --agent-tool <tool> --agent-timeout <ms> --agent-model <model>
--agent-batch-size <n> --survey --no-survey
```

`status`: 3SHA、generatedAt、target数、evidence数、shard数、masked数、pending数、`formatSummary`、手編集page、inventory不整合。ERRORならexit 4。`--no-remote`はここでだけ意味を持ちます。

`build`:

- target SHAは`resolveBase`の`baseSha`（merge-base、無ければHEAD）
- 開始時に`done/`の残存報告を取り込む
- 増分が既定。`--full`は記録済みinventoryを捨てて全件をqueueする。`checkpoint.pendingPaths`の残りは常に再queue、supporting evidence変更時は全件queue
- `--scope`はgeneration targetだけを絞り、scope外のqueueは`deferred`としてcheckpointへ残す。scopeに1件も一致しなければexit 1
- 手編集page（`modified`）があれば`--force`か`--dry-run`でない限りexit 1
- ERRORかつWikiありの状態では書き込みの間だけsync leaseを取る（期限切れleaseがあれば`--resume` / `--abort`を案内して失敗）
- inventory shard、manifest（`knowledgeSha = targetSha`、`kitCommit = PKG HEAD`）、無ければ`index.md` stubを書く
- agentは既定で起動する。`--no-agent`で構造だけ書いてproseをqueueに残す（`--agent-name`との併用はexit 1）。queueが空ならagentは起動せず、flagの検証だけ行う。toolの実行fileが見つからなければ警告してexit 0（構造は書かれている）
- toolは`--agent-tool` > `tools.agents.<agent>.tool` > `tools.agent`。`tools.default`に無いtoolはexit 1。modelも同じ順（`--agent-model` > `tools.agents.<agent>.model` > `tools.agent_model`）
- 終了後にmanifestを再読込して`assessWikiProgress`。partial / no-progress / checkpoint invalidはexit 1。JSONは`{ok, structuredOk, targetSha, files, generationTargets, evidenceFiles, shards, pending, deferred, remaining, agent}`

### `aidev sync`

```text
--to <sha> --dry-run --no-pr --resume --abort --check-only --json --force
--no-agent --agent-name --agent-timeout --agent-model --agent-batch-size --survey --no-survey
```

- `--abort`: worktree削除とlease解放のみ。lease不在でもexit 0
- `--check-only`: cacheを無視して状態表示。ERRORならexit 4
- 既存leaseがあり`--resume`も`--force`も無ければexit 1（`--resume` / `--abort`を案内）
- fetch → target決定（`--to`はtracking先端から到達可能なcommitのみ）→ no-op判定（targetにcommit済みのWikiがtargetを説明している／手元のWikiとtargetにsource差分が無い。`--force`で無視）→ change set表示 → `--dry-run`はここで終了
- lease → worktree → 手編集検査（`--force`なしで失敗）→ inventory / manifest / orphan削除 → ERRORなら失敗 → prose（`--no-agent`で省略）→ commit（`.aidev/knowledge`と`.aidev/.gitignore`のみstage）→ push（`--no-pr`で省略）→ PR（`sync.auto_pr`、hosting azure-devops、auth env設定時のみ）→ worktree削除 → lease解放
- 失敗時はleaseとworktreeを残す
- JSON: `{ok, structuredOk, targetSha, opKey, streamId, branch, committed, pushed, pendingPages, diff, pr, agent}`。no-opは`{ok, noop, targetSha, opKey, streamId}`
- exit: 0 / 1（agent失敗を含む）/ 4（worktree内の検証失敗）

### `aidev agent list|show|run`

```text
--json --dry-run --tool <tool> --model <model> --timeout <ms> --prompt-file <path>
```

- `list`: `tools.listBundledAgents(installRoot)`（`templates/claude-assets/agents/*.md`のfrontmatter）と、`config.agentSettings`で決まる各agentのtool / model。`aidev.yaml`が無ければkit既定（claude）で表示
- `show <name>`: 説明、定義file、tool、model、実際のcommand line（`previewCommand`: `tools.resolveBinary` + `agent.buildArgv`。`prompt: 'file'`のtoolはpointer文の位置をplaceholderで示す）。`verified: false`のtoolは警告
- `run <name> [task...]`: `aidev.yaml`必須。task は引数の結合 > `--prompt-file` > 非TTYのstdin。tool / modelは`--tool` / `--model` > `tools.agents.<name>` > `tools.agent` / `tools.agent_model`。`tools.default`に無いtool、registryに無いtool、同梱に無いagentはspawn前にexit 1。`--dry-run`はcommand lineを表示して起動しない。`agent.runAgent`の結果を人間向け / JSON（`{ok, agent, tool, model, timeoutMs, result, reason, skipped, timedOut, exitCode, durationMs, costUsd, permissionDenials, promptFile}`）で返し、失敗・skip・timeoutはexit 1
- exit: 0 / 1

### `aidev permission configure|reconfigure|show`

```text
--approve --force --dry-run --json
```

- `configure`: `.aidev/policy.yaml`が既にあれば`reconfigure`か`--force`を要求。候補を`aidev.yaml`から生成し`validatePolicy`で検証。`--approve`なしなら`.aidev/policy.candidate.yaml`を書く。`--approve`で`.aidev/policy.yaml`へ配置し候補を削除
- 現行policyより保護が減る（protected / read_only / writable_during_syncからの削除、sync時のみ書込可のpathがwritableへ昇格）場合、`--approve`だけでは配置せずexit 3。`--approve --force`で配置
- `--dry-run`は候補を表示するだけ（`--approve`と併用しても書かない）
- `show`: 有効なpolicy（無ければ内蔵floor）を表示。policy fileが無ければexit 3

### `aidev task list|show|resume|advance|abandon`

```text
--json --all --dry-run --force --state <STATE> --reason <text> --no-remote
```

入口は既存の`.aidev/tasks/<taskId>.json`（`task.cache_dir`）です。cacheを作る公開commandはありません（`implementation-status.md`）。

- `list`: 非terminalのtask。`--all`でterminalも
- `show <id>`: state、work item、branch、PR id、merged SHA、operationKey、syncStreamId、次に取り得るstate
- `advance [<id>]`: idなしで非terminal全件を順に進め、1件でも失敗すればexit 1（`--state`はid必須）。`PKG_PR_OPEN`はPR APIで完了/放棄を観測しmerge commit SHAをfetch後に検証、`PKG_PR_MERGED`→`SYNCHRONIZING`、`SYNCHRONIZING` / `SYNC_FAILED`は`computeState`で判定、`WIKI_PR_OPEN`はWiki PRを観測（現在は常に失敗する。`implementation-status.md`）。遷移後はWork Itemへstate commentをbest-effortで投稿
- `resume <id>`: 変化が無くなるまで`advance`を繰り返し、次に人間/agentがすべきことと work leaseの状態を表示
- `abandon <id>`: `WIKI_PR_OPEN`なら`WIKI_PR_ABANDONED`、それ以外は`PKG_PR_ABANDONED`へ。work leaseを解放。open PRには触れない
- `--force`と`--no-remote`は`FLAGS`にありますが`task.js`内で参照されていません

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
--dry-run --json --kit-only --all --force
```

kit checkout（`installRoot`）を`origin/main`へfast-forward-onlyで更新し、`--kit-only`でなければ現在のPKG（`aidev.yaml`がある場合）または`--all`でregistryの全PKGへtemplateを再適用します。未commit変更、`main`以外のbranch、divergeは拒否（exit 1）。conflictがあればexit 2（`--force`でkit版に置換）。PKG側の変更はcommitしません。

### `aidev doctor`

`--json`。node（20以上）、platform、git、aidevのversionと`installRoot`、kit checkoutのcommit、kit更新の有無、`AIDEV_HOME`、登録PKG数、`claude`のversion（2.1.259以上か）を確認します。PKG内なら`aidev.yaml` schema、git repo、origin、policy、agent model、`hosting.auth_env`の有無（値は読まない）、`HTTPS_PROXY`、remote到達性（cache無視）、Wiki状態も確認します。`fail`が1つでもあればexit 1、warnのみは0。

### `aidev eject`

```text
--yes --dry-run --json --force --keep-assets
```

kit管理を解除します。既にejected（marker あり）なら`--force`なしでexit 0。`aidev.yaml` / `materialized.json` / `policy.yaml`のどれも無ければ`--force`なしで拒否。有効なsync lease / work leaseがあれば`--force`なしで拒否。

順序: `.claude/settings.json`から`aidev hook`を呼ぶhookだけを外す → `policy.yaml`、`policy.candidate.yaml`、`materialized.json`、`sync.lock`、`leases/`、`cache/`、`tasks/`を削除 → `--keep-assets`でなければ`.claude/**`、`CLAUDE.md`、`.mcp.json`を削除 → 空になった`.aidev/`を削除 → registryから除外 → `.aidev/ejected.json`を書く。`--yes`なしでは一覧を表示してexit 1。PKG file、`.aidev/knowledge/`、`aidev.yaml`、`.aidev/workflows/`は残します。

## 内部command

| command | caller | 用途 |
| --- | --- | --- |
| `aidev hook session-start` | Claude Code SessionStart | 3SHA summary、lease、task cacheの要対応を`additionalContext`で返す |
| `aidev hook guard-write` | Claude Code PreToolUse | tool inputからpathを抽出し`policy.decideMany`。deny時は`permissionDecision: deny` |
| `aidev hook quality-gate` | Claude Code PostToolUse | 編集対象にPKG fileが含まれるときだけ`quality_gates`をrepo rootで実行 |
| `aidev hook session-stop` | Claude Code Stop | pending refresh記録とevolution journal追記 |
| `aidev mcp azure-devops` | `.mcp.json` | 設定と環境変数を解決し、固定版MCP serverをstdioで起動 |

`hook`のoption: `--input <file>`（stdinの代わりにfileからpayloadを読む。testとデバッグ用）、`--json`。payloadは`{tool_name, tool_input: {file_path | edits[] | command …}}`。`guard-write`は常にexit 0で、失敗はdenyとして表現します。

`mcp`のoption: `--dry-run`（起動せず解決結果を表示）、`--json`（同内容をJSONで）。実起動時のexit codeは子processのものです。`hosting.auth_env`が未設定ならexit 1。

内部commandを人間向けworkflowの入口として扱わないでください。引数やstdin payloadはClaude Code設定との契約です。

## 削除されたcommand

`aidev plan`と`aidev kit apply`は0.2.0に存在せず、`aidev plan`は「unknown command」です。wrapper repositoryへkit管理対象を取り込む操作は`aidev update`のtemplate再適用に置き換わりました。
