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
    issue-to-pr: { tool: copilot, model: "" }

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

pathはPKG repository root基準です。kit管理path（`aidev.yaml`、`.aidev/**`、`.claude/**`、`CLAUDE.md`、`.mcp.json`）は`include`に一致しても対象になりません。`include`はknowledge-builderの調査範囲ではなく、調査範囲は`knowledge.evidence`です。kit管理pathは他toolのconfig（`.github/agents/**`等、`layout.TOOL_CONFIG_GLOBS`）も含みます。

### `secrets_paths`

string[]、既定`[]`。次の3か所で効きます。

- policy: `decide`の第2段で常にdeny。候補生成時に`protected`へ追加される
- Wiki: generation targetでは`masked: true`のrecordになり、evidenceからは除外される
- agent prompt: 「Secret patterns (never read)」として渡される

変更後はpolicyを再生成してください（`aidev permission reconfigure` → review → `--approve`）。同梱`settings.json`のdeny listには`*.pem` / `*.pfx` / `*.key` / `.env*`が固定で入っています。

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

`generic`では`sync`はpushまで行い、PRは手動作成の案内になります。`mcp azure-devops`は起動できません。

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

| key | 型 | 既定 | 範囲 | 説明 |
| --- | --- | --- | --- | --- |
| `auto_pr` | bool | `true` | — | push後にPRを作成/更新する。falseなら手動作成を案内 |
| `pr.target_branch` | string | `hosting.tracking_branch` | — | sync PRのtarget |
| `pr.reviewers` | string[] | `[]` | — | PR作成時のreviewer id |
| `remote_check_timeout_ms` | int | `3000` | 100〜60000 | `ls-remote`のtimeout |
| `remote_check_ttl_minutes` | int | `60` | 0〜10080 | remote確認cacheのTTL。0でcacheしない |
| `lease_ttl_minutes` | int | `120` | 1〜10080 | sync leaseのTTL |

`auto_pr: true`でも、hostingが`generic`、`auth_env`未設定、pushの失敗のいずれかでPRは作られません。commitは`aidev/wiki-<sha12>` branchに残ります。

### `quality_gates`

任意のkeyからcommand文字列へのmapping。PostToolUse hookが、編集対象にPKG file（kit管理path以外）が含まれるときだけ、repo rootでplatform shell経由に実行します（1 commandあたり120秒timeout）。失敗時は`additionalContext`で出力を返します。

- 実在し、非対話で終了するcommandだけを指定する
- watch modeや開発serverを指定しない
- 値はPKG所有の設定で、開発者自身の端末で実行される。信頼境界ではない

### `references`

topic名（`[a-z][a-z0-9_-]{0,39}`）からrepo-relative pathの配列へのmapping。`aidev agent run`とworkflowの`ctx.agent()`が、taskの末尾に「# Reference documents」sectionとしてtopicごとのfile一覧を付けます（`agent.resolveReferences`）。agentは自分のtopicの文書を先に読み、記述はcodeで検証する、という契約です（convention-builderは`conventions`、test-writerは`testing`）。`knowledge build` / `sync`のknowledge-builderには渡しません（evidenceで全fileを見るため）。

- 要素はfileまたはdirectory。directoryは再帰的にtext file（dot始まりと`node_modules`を除く、上限200）を列挙する
- `secrets_paths`に一致するpathは列挙せず「Not available」に書く。無いpathも同様（errorにはしない。`agent run`が警告を出す）
- **Excel / Word / PDF等（`config.NON_TEXT_REFERENCE_EXTENSIONS`）は`validateConfig`で拒否**する。AI toolはtextしか読めないので、Markdown / CSV / textに書き出したfileをcommitしてそれを載せる。directory内のこれらのfileは黙って除外する
- `..`を含むpathと絶対pathは拒否

## `.aidev/policy.yaml`（schema version 1）

`aidev permission configure --approve`または`aidev init --approve`（対話のyes含む）だけが配置します。`ALWAYS_PROTECTED`なので実行時にagentは書けません。

| section | 型 | 意味 |
| --- | --- | --- |
| `version` | int | `1`のみ |
| `protected` | string[] | 常にdeny。`ALWAYS_PROTECTED`が無条件に合成される |
| `read_only` | string[] | agentは書込不可（`writable`で個別に許可） |
| `writable_during_sync` | string[] | 整合性ERRORかつ有効なsync leaseのときに書込可 |
| `writable` | string[] | 通常時に書込可（`read_only`より先に評価） |
| `agents.<name>.writable` | string[] | CLIが起動したagent `<name>`（子processの`AIDEV_AGENT`）にだけ追加で書込可。`protected` / secretsより下位 |
| `agents.<name>.branch` | string | 任意。checkoutのbranchがこのglobに一致するときだけ上の許可が効く |

`config.DEFAULT_POLICY_SCOPES`（候補生成と`loadPolicy`のfallbackの既定）:

```js
read_only:            ['**']
writable:             ['.aidev/knowledge/**', '.aidev/workflows/**', '.aidev/conventions/**', 'aidev.yaml']
writable_during_sync: ['.aidev/knowledge/**']
```

`config.ALWAYS_PROTECTED`:

```text
.claude/**  CLAUDE.md  .mcp.json  .github/copilot-instructions.md  .github/agents/**  .github/skills/**
AGENTS.md  .kiro/steering/**  .kiro/agents/**  .aidev/policy.yaml
.aidev/sync.lock  .aidev/materialized.json  .aidev/.gitignore  .aidev/ejected.json
```

候補生成（`permission.buildCandidate`）は`ALWAYS_PROTECTED` + `secrets_paths`を`protected`にし、他は`DEFAULT_POLICY_SCOPES`をそのまま使い、`agents`は空（commentの記入例つき）です。`aidev.yaml`から`read_only` / `writable` / `agents`を変える設定項目は現在ありません。teamが広げるときは`.aidev/policy.yaml`を直接編集してcommitします（`--approve`は候補fileを読まず生成し直すので、手編集は候補ではなくpolicy本体に行う）。`reconfigure --approve`は生成し直した既定に戻すため、手で足した`writable` / `agents`は消えます（`agents`の追加は弱体化として`--force`を要求しますが、削除は要求しません）。

`agents`の例:

```yaml
agents:
  issue-to-pr:
    writable: ["src/**", "tests/**"]
    branch: "aidev/issue-*"   # 任意
```

globの意味（`paths.js`）: `*`は1 segment内、`?`は1文字、`**`は0個以上のsegment、`a/**`は`a`自身も一致。`..`は照合前に字句的に解決し、Windowsの`\`は`/`へ畳みます。

## model解決の優先順位

```text
CLI起動agent（knowledge build / sync / agent run / workflow ctx.agent。前2つは`--no-agent`で省略）:
  tool:  --agent-tool / --tool / workflow agent.tool  >  tools.agents.<name>.tool  >  tools.agent  >  tools.default[0]
  model: --agent-model / --model / workflow agent.model  >  tools.agents.<name>.model  >  tools.agent_model  >  DEFAULTS（sonnet）
  空文字 → model flag を渡さずtool側の解決に任せる

対話session: Claude Code側。managed settings > claude --model / ANTHROPIC_MODEL
  > .claude/settings.local.json > .claude/settings.json（kit配布の "sonnet"）> ~/.claude/settings.json
```

同梱agentのfrontmatterは`model: inherit`です。

## 環境変数

| 変数 | 読む場所 | 意味 |
| --- | --- | --- |
| `<hosting.auth_env>`（既定`AZURE_DEVOPS_PAT`） | `ado.js`、`mcp.js`、`sync`、`init` / `doctor`（有無のみ） | Azure DevOpsのPAT。値をlogに出さない |
| `AIDEV_HOME` | `home.js` | registryとupdate cacheの場所 |
| `AIDEV_NO_UPDATE_CHECK` | `aidev.js` | 起動時のkit更新確認を抑止 |
| `AIDEV_CLAUDE_BIN` | `tools.js` | `claude`の代わりに起動する実行file（`.js`ならnodeで実行、version検査を省略） |
| `AIDEV_COPILOT_BIN` / `AIDEV_CODEX_BIN` / `AIDEV_KIRO_BIN` | `tools.js` | 同じく`copilot` / `codex` / `kiro-cli`の代わりに起動する実行file |
| `AIDEV_AGENT` | `policy.js`（`decide`の既定値） | CLIが`agent.runAgent`で子processの環境に入れるagent名。hookがそれを継承し、policyの`agents.<name>`を適用する。人が設定するものではない |
| `AIDEV_KIT_DEVELOPER` | `home.js` | `1`でこの端末をkit開発者端末として扱う（`AIDEV_HOME/developer.json`と同じ。self-evolution用） |
| `AIDEV_DEBUG` | `aidev.js` | internal errorのstack traceを表示 |
| `CLAUDE_PROJECT_DIR` | `aidev.js`（`hook`のみ） | repo root探索の起点 |
| `HTTPS_PROXY` / `https_proxy` | `doctor` | 表示のみ |
| `NO_COLOR` | `ui.js` | 色を無効化 |
| `XDG_DATA_HOME` / `LOCALAPPDATA` | `home.js` | `AIDEV_HOME`の既定を決める |
| `AIDEV_BIN_DIR` | installer | launcherの配置先 |
| `USERNAME` / `USER` | `workflow approve`、`eject` | 監査用の記録（認証ではない） |

## CLIが書くその他のfile

| file | 書き手 | 形 |
| --- | --- | --- |
| `.aidev/materialized.json` | `init`、`apply` | `{schemaVersion: 4, kitCommit, kitVersion, tools, appliedAt, files: {rel: {kit: "sha256:…", file: "sha256:…"}}, conflicts: [rel]}`（schema 3以前の`files: {rel: "sha256:…"}`も読める） |
| `.aidev/ejected.json` | `eject` | `{schemaVersion: 1, ejectedAt, ejectedBy, kitCommit, removed[], hooksRemoved[], note}` |
| `.aidev/policy.candidate.yaml` | `init`、`permission configure/reconfigure` | policy v1のYAML |
| `.aidev/sync.lock` | `sync`、`knowledge build`（一時） | sync lease（`architecture.md` §5） |
| `.aidev/cache/remote-check.json` | `state.resolveRemoteSha` | `{branch, sha, reason, checkedAt}` |
| `.aidev/cache/agents/<tool>-<label>-<pid>-<time>.md` | `agent.runAgent`（`prompt: 'file'`のtool） | agentへ渡すprompt file |
| `.aidev/cache/evolution/<session>.md` | Claude session（Stop hookの指示で。kit開発者端末のみ） | 振り返り（事実 / 無駄と原因 / kit への提案 / 提案しないこと）。`aidev evolve run`が`done/`へ移す。`--auto`時は`<file>.evolve-launched` markerも置く |
| `AIDEV_HOME/developer.json` | `aidev evolve enable` | `{schemaVersion: 1, enabled: true, autoEvolve, enabledAt}` |
| `AIDEV_HOME/cache/evolve/<yyyymmdd>/`、`<yyyymmdd>-input/` | `aidev evolve run` | kit checkoutのworktree（branch `aidev/evolve-<yyyymmdd>`）と、そこへ渡す振り返りのcopy |
| `.aidev/cache/sync-worktree/` | `sync` | 一時git worktree |
| `.aidev/knowledge/.cache/agent-task-*.json` | `agent.prepareTask` | 大きいplan（`schemaVersion: 2`） |
| `.aidev/knowledge/.cache/done/*.json` | knowledge-builder | 完了報告`{target, targetSha, pages, note?}` |
| `.aidev/workflows/<name>/approval.json` | `workflow approve` | `{schemaVersion: 1, name, hash, approvedAt, approvedBy, limits, cost, commands}` |
| `.aidev/workflows/<name>/runs/<id>/` | `workflow run` | `log.txt`、`checkpoint.json` |
| `AIDEV_HOME/registry.json` | `init`、`update`、`eject` | `{schemaVersion: 1, packages: [{name, path, remote, kitCommit, registeredAt, updatedAt?}]}` |
| `AIDEV_HOME/cache/update-check.json` | `home.checkForUpdate` | `{checkedAt, localSha, remoteSha, newer}` |

## 設定を追加するとき

validator、`DEFAULTS`、`init.buildConfigYaml`、利用箇所、この文書、`docs/user-guide/chapters/07-configuration.adoc`、testを同時に更新してください。未定義keyは黙って無視されるため、typoは検証では見つかりません。

