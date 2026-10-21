# Configuration reference

`aidev.yaml`はPKG固有の設定をそのPKG repositoryに保持します。秘密値は保持せず、認証情報は環境変数名だけを参照します。schemaの正本は`cli/lib/config.js`の`validateConfig`と`DEFAULTS`です。

## `aidev.yaml`（schema version 2）

### 全体例

`aidev init`が生成する内容より多くの任意項目を含みます。

```yaml
version: 2

package:
  name: my-pkg
  include:
    - "src/**"
    - "docs/**"
  exclude:
    - "**/node_modules/**"
    - "**/dist/**"
    - "**/build/**"
    - "**/vendor/**"
    - "**/generated/**"

secrets_paths:
  - ".env*"
  - "**/secrets/**"
  - "**/*.pem"
  - "**/*.pfx"
  - "**/*.key"

hosting:
  type: azure-devops          # azure-devops | generic
  organization: my-org
  project: my-project
  repository: my-pkg
  auth_env: AZURE_DEVOPS_PAT  # PATを保持する環境変数の名前
  tracking_branch: main

tools:
  default: [claude, copilot]
  agent: claude
  agent_model: sonnet
  agents:
    knowledge-builder: { model: opus }
    my-agent: { tool: copilot, model: "" }

knowledge:
  max_files_per_dir: 20
  inventory_shard_size: 2000
  agent_timeout_ms: 1800000
  agent_batch_size: 20
  evidence:
    include: ["**"]
    # exclude 省略時は package.exclude を継承

sync:
  auto_pr: true
  pr:
    target_branch: main
    reviewers: []
  remote_check_timeout_ms: 3000
  remote_check_ttl_minutes: 60
  lease_ttl_minutes: 120

quality_gates:
  lint: npm run lint
  typecheck: npm run typecheck
  test: npm test

references:
  conventions: [docs/coding-guide.md]
  testing: [docs/testing.md, CONTRIBUTING.md]

workflows:
  e2e-tests:
    inputs:
      base_url: https://staging.example.com
      test_user: qa-user@example.com
```

### 全体の規則

- top levelはmapping。`version`は整数で、`2`以外は「unsupported version」で拒否（v1はwrapper時代のschema）
- 各sectionはmappingであること。`null`は空mappingとして扱う
- list項目は文字列の配列。要素がobject / nullならエラー
- 整数項目は範囲を検証する。boolean項目は`true` / `false`（文字列も可）
- 未定義のkeyは無視される（エラーにはならないが、機能もしない）

### `package`

| key | 型 | 既定 | 説明 |
| --- | --- | --- | --- |
| `name` | string | **必須** | PKG名。表示とWiki stubに使う |
| `include` | string[] | `[]`（`init`はtreeから提案） | Wiki generation targetのglob。空はinclude制限なし |
| `exclude` | string[] | `[]`（`init`は依存物・生成物） | generation targetから除外するglob |

pathはPKG repository root基準です。kit管理path（`aidev.yaml`、`.aidev/**`、`.claude/**`、`CLAUDE.md`）は`include`に一致しても対象になりません。`include`はknowledge-builderの調査範囲ではなく、調査範囲は`knowledge.evidence`です。kit管理pathは他toolのconfig（`.github/agents/**`、`.github/hooks/**`、`.codex/**`等、`layout.TOOL_CONFIG_GLOBS`）も含みます。`sync wiki`のclean-tree検査（`inventory.dirtyTargets`）もこの`include` / `exclude`に一致するpathだけを見ます。

### `secrets_paths`

string[]、既定`[]`。次の3か所で効きます。

- policy: `decide`の第2段で常にdeny。候補生成時に`protected`へ追加される
- Wiki: generation targetでは`masked: true`のrecordになり、evidenceからは除外される
- agent prompt: 「Secret patterns (never read)」として渡される

変更後はpolicyを再生成してください（`aidev create policy` → review → `--approve`）。同梱`settings.json`のdeny listには`*.pem` / `*.pfx` / `*.key` / `.env*`が固定で入っています。

### `hosting`

| key | 型 | 既定 | 説明 |
| --- | --- | --- | --- |
| `type` | string | `generic` | `azure-devops`または`generic` |
| `organization` | string | `null` | `azure-devops`では必須 |
| `project` | string | `null` | `azure-devops`では必須 |
| `repository` | string | `null` | `azure-devops`では必須。PRのrepository idとして使う |
| `auth_env` | string | `AZURE_DEVOPS_PAT`（azure-devops）/ `null`（generic） | PATを保持する環境変数名 |
| `tracking_branch` | string | `main` | Wikiが追従する`origin/<branch>` |

`hosting`直下のkeyのうち`pat` / `token` / `password` / `secret`（大文字小文字不問）は「must not be set」で拒否します。`auth_env`以外の文字列値が`^[A-Za-z0-9+/=]{40,}$`に一致すると「looks like an embedded credential」で拒否します。

正規化後の`config`には互換aliasがあります。

- `config.azure_devops` = `{organization, project, repository, auth_env}`（`type`が`azure-devops`のとき）、それ以外は`null`。`ado.js`、`mcp.js`はこれを読む
- `config.sync.tracking_branch` = `hosting.tracking_branch`

`generic`ではtracking branch上の`sync wiki`（publish）はpushまで行い、PRは手動作成の案内になります。`mcp azure-devops`は起動できません。

### `tools`

| key | 型 | 既定 | 説明 |
| --- | --- | --- | --- |
| `default` | string[]（文字列1つも可） | `[claude]` | 設定を実体化するAI tool。`tools.js`のregistry（`claude` / `copilot` / `codex` / `kiro`）以外は拒否。空は拒否。1つでも複数でもよい |
| `agent` | string | `default[0]` | CLIがagentを起動するtool。registry外、または`default`に無いtoolは拒否 |
| `agent_model` | string | `sonnet` | CLI起動agentに渡すmodel。空文字は「model flagを渡さない」（`null`） |
| `agents.<name>` | mapping | 無し | agent単位の上書き。`tool`（`default`内のみ）と`model`（`asModel`。空文字は`null`、keyを省くと`agent_model`を継承）。nameは`AGENT_NAME_RE` |

`config.tools.agents`は`{ <name>: { tool, model? } }`に正規化され、`config.agentSettings(config, name)`が`{ tool, model }`を返します（上書き > PKG既定 > kit既定）。`config.model.agent`は`tools.agent_model`のaliasです。

model識別子は既知modelの列挙ではなく字形を検証します（`MODEL_RE`、最大200文字、先頭は英数字、使用可能文字は英数字と`. _ - : / @ [ ]`）。alias、固定名、`sonnet[1m]`、gateway path、Bedrock ARN等を通し、`-`で始まる値（Claude CLIがflagと誤読する）を拒否します。`--agent-model`も同じ`assertModel`で検証します。

### `knowledge`

| key | 型 | 既定 | 範囲 | 説明 |
| --- | --- | --- | --- | --- |
| `max_files_per_dir` | int | `20` | 1〜1000 | agentがpage構造を決める目安（promptと`index.md` stubに入る） |
| `inventory_shard_size` | int | `2000` | 1〜100000 | inventory shard 1 fileあたりのrecord数 |
| `agent_timeout_ms` | int | `1800000` | 10000〜7200000 | agent **1 run**（survey または1 batch）の時間予算 |
| `agent_batch_size` | int | `20` | 1〜500 | 1 runに渡すgeneration target数 |
| `evidence.include` | string[] | `["**"]` | — | agentが調査できるtracked path。空はinclude制限なし |
| `evidence.exclude` | string[] | `package.exclude`を継承 | — | 明示した場合は独立したlist（継承しない） |

`--agent-timeout`と`--agent-batch-size`はそれぞれの範囲で1回分だけ上書きします。

### `sync`

section名は歴史的なもので、`aidev sync`というcommandはありません。tracking branch上の`aidev sync wiki`（publish経路、`--branch`）とremote確認の設定です。

| key | 型 | 既定 | 範囲 | 説明 |
| --- | --- | --- | --- | --- |
| `auto_pr` | bool | `true` | — | push後にPRを作成/更新する。falseなら手動作成を案内 |
| `pr.target_branch` | string | `hosting.tracking_branch` | — | Wiki更新PRのtarget |
| `pr.reviewers` | string[] | `[]` | — | PR作成時のreviewer id |
| `remote_check_timeout_ms` | int | `3000` | 100〜60000 | `ls-remote`のtimeout |
| `remote_check_ttl_minutes` | int | `60` | 0〜10080 | remote確認cacheのTTL。0でcacheしない |
| `lease_ttl_minutes` | int | `120` | 1〜10080 | publish lease（`.aidev/sync.lock`）のTTL |

`auto_pr: true`でも、hostingが`generic`、`auth_env`未設定、pushの失敗のいずれかでPRは作られません。commitは`aidev/wiki-<sha12>` branchに残ります。

### `estimates`

| key | 型 | 既定 | 説明 |
| --- | --- | --- | --- |
| `review` | `auto` \| `off` | `auto` | `auto`: `run workflow`の終わりに、前回のreview以降で見積もりの幅を外れたstepが3つ以上あれば`estimate-reviewer`を起動する（architecture §9「見積もりの学習」）。`off`: 起動しない（`estimate workflow --review`は動く）。他の値は`validateConfig`がerror |

### `quality_gates`

任意のkeyからcommand文字列へのmapping。PostToolUse hookが、編集対象にPKG file（kit管理path以外）が含まれるときだけ、repo rootでplatform shell経由に実行します（1 commandあたり120秒timeout）。失敗時は`additionalContext`で出力を返します。

- 実在し、非対話で終了するcommandだけを指定する
- watch modeや開発serverを指定しない
- 値はPKG所有の設定で、開発者自身の端末で実行される。信頼境界ではない

### `references`

topic名（`[a-z][a-z0-9_-]{0,39}`）からrepo-relative pathの配列へのmapping。workflow runnerのagent stepが、promptの末尾に「# Reference documents」sectionとしてtopicごとのfile一覧を付けます（`agent.resolveReferences`）。agentは自分のtopicの文書を先に読み、記述はcodeで検証する、という契約です（例: 規約を書くworkflowのagentは`conventions`、testを書くagentは`testing`。topic名はworkflowのobjectiveで指示する）。`sync wiki`のknowledge-builderには渡しません（evidenceで全fileを見るため）。

- 要素はfileまたはdirectory。directoryは再帰的にtext file（dot始まりと`node_modules`を除く、上限200）を列挙する
- `secrets_paths`に一致するpathは列挙せず「Not available」に書く。無いpathも同様（errorにはしない。`agent run`が警告を出す）
- **Excel / Word / PDF等（`config.NON_TEXT_REFERENCE_EXTENSIONS`）は`validateConfig`で拒否**する。AI toolはtextしか読めないので、Markdown / CSV / textに書き出したfileをcommitしてそれを載せる。directory内のこれらのfileは黙って除外する
- `..`を含むpathと絶対pathは拒否

### `workflows`

workflow名（`layout.WORKFLOW_NAME_RE`）から`{ inputs: { <input>: <value> } }`へのmapping（`cfg.workflows`。既定`{}`。D30）。そのworkflowが`inputs:`に宣言したinputの、このPKGでの値です。`aidev run workflow` / `aidev estimate workflow`が`--input`の無いinputに使い（`--input` > ここ > 宣言の`default`）、`collectInputs`の`configured`として`--input`と同じ規則で検証します（`where`は`aidev.yaml: workflows.<name>.inputs`）。

- `workflows.<name>`のkeyは`inputs`だけ（他は`unknown key`）。input名は`layout.INPUT_NAME_RE`
- 値はplain scalar（文字列化する。list / mappingはerror）
- **認証情報は拒否**: 名前が`CREDENTIAL_NAME_RE`に当たるinputはerror。`password` / `passwd` / `passphrase` / `passcode` / `secret`をどこかに含む、`(api|access|private|ssh|signing)[_-]?key`を含む、`_` / `-`で区切った末尾の語が`pass` / `pw` / `pwd` / `pat` / `otp` / `auth` / `credential(s)`、`(auth|api|access|session|bearer|refresh)[_-]?token(s)`で終わる、`token(s)`そのもの（`pass_rate` / `token_limit` / `max_tokens` / `credential_type`は通る）。値は`credentialValueReason`で見る: パスワード入りURL（`://user:pw@`）、tokenの形（`ghp_` / `gh[osur]_` / `github_pat_`、`xox[abps]-`、`sk-`、`AKIA…`、JWT）、40文字以上のbase64らしい並び（40 / 64桁のhexはgit SHAとして通す）。このfileはcommitされるため。認証情報はworkflowの`env_required`で環境変数から受け取る
- 宣言に無い名前と`file: true`のinputはここでは検出できず、`run` / `estimate`のときに`collectInputs`がerrorにする
- `aidev.yaml`は既定policyでagentが書けるfileなので、ここに書いた値は`--input`と同じ「data」の扱い（commandに届く値は`COMMAND_VALUE_RE`と作者の`pattern`で縛られる）。承認の対象（`reviewedFiles`）ではない

## `.aidev/policy.yaml`（schema version 1）

`aidev create policy --approve`または`aidev init --approve`（対話のyes含む）だけが配置します。`ALWAYS_PROTECTED`なので実行時にagentは書けません。

| section | 型 | 意味 |
| --- | --- | --- |
| `version` | int | `1`のみ |
| `protected` | string[] | 常にdeny。`ALWAYS_PROTECTED`が無条件に合成される |
| `read_only` | string[] | agentは書込不可（`writable`で個別に許可） |
| `writable_during_sync` | string[] | 整合性ERRORかつ有効なpublish lease（`.aidev/sync.lock`）のときに書込可 |
| `writable` | string[] | 通常時に書込可（`read_only`より先に評価）。全員・全session向け |
| `agents` | — | **存在しない**。書くと`validatePolicy`がerror。PKG sourceへの書込は承認済みworkflowの実行中stepの`writable`（`architecture.md` §9） |

`config.DEFAULT_POLICY_SCOPES`（候補生成と`loadPolicy`のfallbackの既定）:

```js
read_only:            ['**']
writable:             ['.aidev/knowledge/**', '.aidev/workflows/**', '.aidev/agents/**', '.aidev/skills/**', '.aidev/conventions/**', 'aidev.yaml']
writable_during_sync: ['.aidev/knowledge/**']
```

`config.ALWAYS_PROTECTED`:

```text
.claude/**  CLAUDE.md  .github/copilot-instructions.md  .github/agents/**  .github/skills/**
AGENTS.md  .kiro/steering/**  .kiro/agents/**  .aidev/policy.yaml
.aidev/sync.lock  .aidev/materialized.json  .aidev/.gitignore  .aidev/ejected.json
```

候補生成（`permission.buildCandidate`）は`ALWAYS_PROTECTED` + `secrets_paths`を`protected`にし、他は`DEFAULT_POLICY_SCOPES`をそのまま使います。`aidev.yaml`から`read_only` / `writable`を変える設定項目は現在ありません。teamが広げるときは`.aidev/policy.yaml`を直接編集してcommitします（`--approve`は候補fileを読まず生成し直すので、手編集は候補ではなくpolicy本体に行う）。`aidev create policy --approve`は生成し直した既定に戻すため、手で足した`writable`は消えます。

### workflow.yaml（`.aidev/workflows/<name>/workflow.yaml`）

`workflow.validateDefinition`が検証します。項目と制約は`architecture.md` §9の表のとおりです。top-levelは`name`、`description`、`objective`、`tool`、`model`、`agents`、`inputs`、`env_required`、`provide`、`never_commit`、`steps`、`limits`（`max_usd`（必須）と`max_minutes`）だけで、他のkeyはerrorです（旧`cost`は「limits.max_usdへ」とerror）。`env_required`は環境変数名のlistか`{ NAME: description }`のmappingで、実行する人のshellに要る認証情報を名前で宣言します（runnerは`preflight`で存在だけを確かめ、値は読まない）。`agents`は`{<agent>: {skills, mcp, tools, subagents}}`のmappingで、そのworkflowの実行でだけagent（stepか`until.agent`が名指すもの、およびそのsubagent）に能力を足します（`skills` / `mcp` / `subagents`はfrontmatterに足し、`tools`は与えればfrontmatterの値を置き換える。どのstepも名指さないagentはerror）。stepの種類は`agent` / `command` / `pull_request` / `parallel`のどのkeyを持つかで決まります（1つだけ）。`parallel`はgroupで、`id`、`description`、`parallel`（同時に起動する2つ以上のagent stepのlist。各stepの`writable`は交わってはならず、groupの中にcommand / pull-request stepは置けない）。stepのkey: agent stepは`id`、`description`、`agent`、`prompt`、`writable`（必須）、`unchanged`（glob list）、`for_each`（mapping: `from`、`max_items`、`on_failure`、`parallel`（同時に動かす対象の数。既定1、最大16。2以上ならすべての`writable`が`{item}`を含む））、`until`（mapping: `command`（1行またはlist）、`cwd`、`env`、`timeout_minutes`、`agent`、`prompt`、`max_retries`（0〜10、既定3））、`timeout_minutes`。`for_each`のstepでは`prompt`に`{item}`が必須で、`writable`・`until`にも`{item}`（対象）を書ける（`writable`では`{item}`の前に固定のdirectoryが要る）。command stepは`id`、`description`、`command`、`cwd`、`env`、`timeout_minutes`、`writable`（任意。commitする範囲を示すだけ）。`cwd`はPKG内のdirectory（絶対pathと`..`はerror）、`env`は`NAME: value`のmapping（名前は`^[A-Za-z_][A-Za-z0-9_]{0,63}$`、`AIDEV_`で始まる名前と複数行の値はerror）、`timeout_minutes`は0より大きく240以下（分。旧`timeout_ms`は「timeout_minutesへ」とerror）。pull-request stepは`id`、`description`、`pull_request`（mapping。`title`だけ。空か`{}`なら既定のtitle）。旧`kind: pull-request`、stepの`title`、stepの`max_retries`は移動先を示すerrorです。`yaml.js`は`key: |` / `key: >`（末尾改行を消すなら`|-` / `>-`）のblock scalarを読めるので、`objective`と`prompt`は複数行で書けます。

### agentのfrontmatter（`.aidev/agents/<name>.md`、kit同梱agent）

`workflow.agentCapabilities`が読みます。値は`[a, b]`か`a, b`。

| key | 省略時 | 意味 |
| --- | --- | --- |
| `name` | — | file名と一致 |
| `description` | — | 一覧・workflow-creatorへの説明 |
| `skills` | `[]` | promptに本文を差し込むskill（`.aidev/skills/<name>/SKILL.md` → kit同梱） |
| `tools` | toolの既定の全部 | 渡す組み込みtool（`Read`、`Grep`、`Bash`…）。claudeでは`--tools`、guard-writeが第2段 |
| `mcp` | 無し | 使えるMCP server（PKGの`.mcp.json`の`mcpServers`のkey）。claudeでは一時`--mcp-config` + `--strict-mcp-config` + `--allowedTools mcp__<server>` |
| `subagents` | `[]`（toolが提供するものは何でも） | `Agent`（`Task`）toolで起動してよいagentの名前。claudeでは`--agents <一時file>`で定義を渡し、guard-writeが`subagent_type`を検査する |
| `model` | — | `inherit`など |

workflowの`agents:`はこれらにそのworkflowの実行でだけ足します（`tools`は置き換え）。`tools`・`mcp`・`subagents`のどれかを（frontmatterかworkflowの`agents:`で）持つagentは、adapterが`capabilities`を持つtool（claude）でしか起動しません。

globの意味（`paths.js`）: `*`は1 segment内、`?`は1文字、`**`は0個以上のsegment、`a/**`は`a`自身も一致。`..`は照合前に字句的に解決し、Windowsの`\`は`/`へ畳みます。

## model解決の優先順位

```text
CLI起動agent（sync wiki / run workflow。sync wikiは`--no-agent`で省略）:
  tool:  --agent-tool / workflow.yaml tool  >  tools.agents.<name>.tool  >  tools.agent  >  tools.default[0]
  model: --agent-model / workflow.yaml model  >  tools.agents.<name>.model  >  tools.agent_model  >  DEFAULTS（sonnet）
  空文字 → model flag を渡さずtool側の解決に任せる

対話session: Claude Code側。managed settings > claude --model / ANTHROPIC_MODEL
  > .claude/settings.local.json > .claude/settings.json（kit配布の "sonnet"）> ~/.claude/settings.json
```

同梱agentのfrontmatterは`model: inherit`です。

## 環境変数

| 変数 | 読む場所 | 意味 |
| --- | --- | --- |
| `<hosting.auth_env>`（既定`AZURE_DEVOPS_PAT`） | `ado.js`、`sync wiki`（publish）、`init` / `doctor`（有無のみ） | Azure DevOpsのPAT。値をlogに出さない |
| `AIDEV_HOME` | `home.js`、`runtree.js` | registry、update cache、workflow実行のworktree（`worktrees/<PKG>-<hash>/<branch>`）の場所 |
| `AIDEV_NO_UPDATE_CHECK` | `aidev.js` | 起動時のkit更新確認を抑止 |
| `AIDEV_CLAUDE_BIN` | `tools.js` | `claude`の代わりに起動する実行file（`.js`ならnodeで実行、version検査を省略） |
| `AIDEV_COPILOT_BIN` / `AIDEV_CODEX_BIN` / `AIDEV_KIRO_BIN` | `tools.js` | 同じく`copilot` / `codex` / `kiro-cli`の代わりに起動する実行file |
| `AIDEV_WORKFLOW` / `AIDEV_WORKFLOW_STEP` | `policy.js`（`decide` / `decideToolUse`の既定値）、`hook.js` | `aidev run workflow`がagent stepごとに子processの環境に入れるworkflow名とstep id。hookがそれを継承し、そのworkflowが承認済み（`origin/<tracking_branch>`と同一）ならそのstepの`writable`への書込と、そのagentのfrontmatterとworkflowの`agents:`が許すtool / MCP tool / subagentだけを許可する。人が設定するものではない |
| `AIDEV_WORKFLOW_ITEM` | `policy.js`（`decide` / `decideToolUse`の既定値） | `for_each`のstepで、runnerがその起動の対象を入れる。guardはstepの`writable`の`{item}`をこれで置き換える（無い・`ITEM_RE`に合わなければ`{item}`を含むpathは書けない）。人が設定するものではない |
| `AIDEV_WORKFLOW_RUN` | `policy.js`（`decide`の既定値） | 同じくrunnerが入れるrun id。承認済みworkflowのagent step（確認役を除く）に、そのrunの`runs/<id>/notes/`への書込を許可する（rule `workflow-notes`）。run idの形でない値は何も許可しない |
| `AIDEV_KIT_DEVELOPER` | `home.js` | `1`でこの端末をkit開発者端末として扱う（`AIDEV_HOME/developer.json`と同じ。self-evolution用） |
| `AIDEV_DEBUG` | `aidev.js` | internal errorのstack traceを表示 |
| `CLAUDE_PROJECT_DIR` | `aidev.js`（`hook`のみ） | repo root探索の起点 |
| `ANTHROPIC_API_KEY` | （CLIは読まない） | `pipelines/azure-pipelines-wiki.yml`がClaude Codeの子processへ渡すsecret variable |
| `HTTPS_PROXY` / `https_proxy` | `doctor` | 表示のみ |
| `NO_COLOR` | `ui.js` | 色を無効化 |
| `XDG_DATA_HOME` / `LOCALAPPDATA` | `home.js` | `AIDEV_HOME`の既定を決める |
| `AIDEV_BIN_DIR` | installer | launcherの配置先 |
| `USERNAME` / `USER` | `run workflow`（`run.json`の`startedBy`）、`uninstall --package` | 監査用の記録（認証ではない） |

## CLIが書くその他のfile

| file | 書き手 | 形 |
| --- | --- | --- |
| `.aidev/materialized.json` | `init`、`sync tools` | `{schemaVersion: 4, kitCommit, kitVersion, tools, appliedAt, files: {rel: {kit: "sha256:…", file: "sha256:…"}}, conflicts: [rel]}`（schema 3以前の`files: {rel: "sha256:…"}`も読める） |
| `.aidev/ejected.json` | `uninstall --package` | `{schemaVersion: 1, ejectedAt, ejectedBy, kitCommit, removed[], hooksRemoved[], note}` |
| `.aidev/policy.candidate.yaml` | `init`、`create policy`（`--approve`なし） | policy v1のYAML |
| `.aidev/sync.lock` | `sync wiki`（publish中は保持、ERROR状態の構造更新中は一時） | publish lease（`architecture.md` §5） |
| `.aidev/cache/remote-check.json` | `state.resolveRemoteSha` | `{branch, sha, reason, checkedAt}` |
| `.aidev/cache/last-head.json` | `hook session-start` / `after-bash` | `{sha, at}`。after-bashがHEADの変化を検出する基準 |
| `.aidev/cache/wiki-stop.json` | `hook session-stop`（`stop_hook_active`を持たないtool、現在はkiro） | `{sha, at}`。同じHEADで2回目のStopを通すためのguard。通したときに消す |
| `.aidev/knowledge/.cache/plan.json` | `sync wiki`（prose未完了時。残り0で削除） | `{schemaVersion: 2, targetSha, mode, hasOverview, generationScope, generationTargets, batches, evidence: {include, exclude, paths, excludedSecretPatterns}, maxFilesPerDir, reportDir, finish}`。hookがsessionのsubagentに渡す |
| `.aidev/cache/agents/<tool>-<label>-<pid>-<time>.md` | `agent.runAgent`（`prompt: 'file'`のtool） | agentへ渡すprompt file |
| `.aidev/cache/evolution/<session>.md` | Claude session（Stop hookの指示で。kit開発者端末のみ） | 振り返り（事実 / 無駄と原因 / kit への提案 / 提案しないこと）。`npm run evolve -- run`が`done/`へ移す。`--auto`時は`<file>.evolve-launched` markerも置く |
| `AIDEV_HOME/developer.json` | `npm run evolve -- enable` | `{schemaVersion: 1, enabled: true, autoEvolve, enabledAt}` |
| `AIDEV_HOME/cache/evolve/<yyyymmdd>/`、`<yyyymmdd>-input/` | `npm run evolve -- run` | kit checkoutのworktree（branch `aidev/evolve-<yyyymmdd>`）と、そこへ渡す振り返りのcopy |
| `.aidev/cache/wiki-worktree/` | `sync wiki`（publish） | HEADのdetached worktree。成功時と`--abort`で削除、失敗時は残す |
| `.aidev/knowledge/.cache/agent-task-*.json` | `agent.prepareTask` | 大きいplan（`schemaVersion: 2`） |
| `.aidev/knowledge/.cache/done/*.json` | knowledge-builder | 完了報告`{target, targetSha, pages, note?}` |
| `.aidev/cache/modify/<name>.json` | `modify workflow`（変更があったとき） | `{at, name, describe, beforeHash, afterHash, cause, report（末尾3000文字）, changed, added, removed, fromRun, costUsd}`。`submit`のPR本文の「Why this change」が読む |
| `.aidev/cache/modify/<name>-<stamp>/` | `modify workflow` | 変わった・消えたfile（`.aidev/workflows/<name>/`・`.aidev/agents/`・`.aidev/skills/`）の変更前の内容（`<rel>`のまま） |
| `.aidev/cache/submit/<name>.md` | `submit workflow` | PR本文の全文（Azure DevOpsへは4000文字に収めて送る） |
| `<AIDEV_HOME>/worktrees/<pkg>-<hash>/<branch>` | `run workflow`（`runtree.prepare`） | workflow実行のgit worktree（`<hash>`はcloneのreal pathのsha256先頭8桁、`<branch>`は`/`を`-`にしたbranch名）。run後も残し、`--resume`が続ける |
| `.aidev/workflows/<name>/workflow.yaml` | `create workflow`（template / `--describe`でworkflow-creator） | 定義。`submit`がPRにし、`origin/<tracking_branch>`との一致が承認 |
| `.aidev/estimates/records/<workflow>-<runId>.json` | `run workflow`の終わり（agentを起動したrunだけ）と、pull-request stepのcommit直前 | `{schemaVersion: 1, workflow, runId, hash, kitVersion, startedAt, done, costUsd, estimate, steps: [{id, kind, ok, attempts, starts, costUsd, items?, failed?}], calls: [{step, role, agent, item?, attempt, tool, model, actualModel?, ok, costUsd, durationMs, tokens?}]}`。commitしてteamで共有（gitignoreしない）。pull-request stepが`.aidev/estimates/`ごとstageする |
| `.aidev/estimates/priors.json` | `estimate-reviewer`の答えをCLIが検査して書く | `{schemaVersion: 1, reviewedAt, reviewedThrough: ["<wf>/<runId>"], costUsd, priors: [{agent | kind, role, perStart: [lo, hi]（sonnet換算のUSD）, why}]}` |
| `.aidev/estimates/notes.md` | 同上 | reviewerの注意書き（Markdown）。cost-estimatorのpromptに入る |
| `.aidev/estimates/judgments/<name>.json` | `estimate workflow --ai`（答えが読めたとき） | `{schemaVersion: 1, hash, steps: [{id, size, checkSize, kind}]}`。`hash`が今の定義の`contentHash`と同じ間だけ使う |
| `AIDEV_HOME/cache/evolve/estimates-<yyyymmdd>/`、`estimates-<yyyymmdd>-input/<pkg>/` | `npm run evolve -- estimates` | kit checkoutのworktree（branch `aidev/evolve-estimates-<yyyymmdd>`）と、PKGごとのrecordのcopy |
| `.aidev/workflows/<name>/runs/<id>/`（実行のworktreeの中） | `run workflow` | `log.txt`、`run.json`、`reports/`、`logs/`、`diffs/`、`notes/`、`pull-request.md`（`cli-reference.md`の`run`） |
| `AIDEV_HOME/registry.json` | `init`、`sync tools`、`uninstall --package`（書く）。`list packages`、`update`、`doctor`、`--package`（読む） | `{schemaVersion: 1, packages: [{name, path, remote, kitCommit, registeredAt, updatedAt?}]}` |
| `AIDEV_HOME/cache/update-check.json` | `home.checkForUpdate` | `{checkedAt, localSha, remoteSha, newer}` |

## toolごとのhook設定file

`aidev hook <name> --tool <id>`を呼ぶfileです。`tools.default`に応じて`templates/<tool>/`から実体化され、kit管理path（`ALWAYS_PROTECTED`）です。

| tool | file | 前提 |
| --- | --- | --- |
| `claude` | `.claude/settings.json`（`hooks`。PostToolUseの`Bash` matcherが`after-bash`） | — |
| `copilot` | `.github/hooks/aidev.json`（`bash` / `powershell`の両方に同じcommand、`timeoutSec`） | subagent内ではhookが動かない |
| `codex` | `.codex/hooks.json` | `~/.codex/config.toml`で`projects."<path>".trust_level = "trusted"`（初回の`codex`起動時に回答） |
| `kiro` | `.kiro/agents/aidev.json`（agent定義内の`hooks`。`postToolUse`の`execute_bash` matcherが`after-bash`） | `kiro-cli chat --agent aidev`で起動する。subagent内ではhookが動かず、`postToolUse`のstdoutは捨てられる |

`check`がhooks欠落として検査するのは`.claude/settings.json`だけです（`inspectConfig.hooksMissing`）。

## 設定を追加するとき

validator、`DEFAULTS`、`init.buildConfigYaml`、利用箇所、この文書、`docs/user-guide/chapters/07-configuration.adoc`、testを同時に更新してください。未定義keyは黙って無視されるため、typoは検証では見つかりません。

