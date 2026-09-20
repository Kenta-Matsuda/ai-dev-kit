# CLI reference and contracts

公開entrypointは`aidev`、routingの正本は`cli/bin/aidev.js`です。ここでは保守者向けに、利用者READMEでは省略したcommand契約と内部commandをまとめます。

実際に受け付けるoptionは各moduleの`FLAGS`が正本です。

```bash
aidev --help
aidev <command> --help
```

## 公開command

| command | subcommand | 主な責務 |
| --- | --- | --- |
| `init` | — | `aidev.yaml`、`.claude/**`、`.aidev-lock`の初期化。policy/Wikiは案内のみ |
| `update` | — | `upstream`からkit管理対象を取り込み、`.claude/`再実体化とlock更新 |
| `check` | — | static drift、policy、3SHA、pending prose等の判定 |
| `doctor` | — | Node/Git、repo形状、PAT環境変数、proxy、3SHA等の診断 |
| `plan` | — | init/update/syncの概算・差分確認 |
| `sync` | — | PKG tracking branchへの追従、inventory更新、任意agent、任意wrapper PR |
| `knowledge` | `build`, `status` | structured Wiki生成、任意prose agent、状態表示 |
| `permission` | `configure`, `reconfigure`, `show` | policy候補生成、承認配置、表示 |
| `task` | `list`, `show`, `resume`, `advance`, `abandon` | 既存local task cacheの表示・状態遷移 |
| `workflow` | `new`, `approve`, `run`, `list` | JS workflow scaffold、content hash承認、実行 |
| `eject` | — | kit管理の解除 |

## 内部command

| command | caller | 用途 |
| --- | --- | --- |
| `aidev hook session-start` | Claude Code SessionStart | local 3SHA判定、期限付きremote確認、警告表示 |
| `aidev hook guard-write` | Claude Code PreToolUse | tool inputから対象pathを抽出し、policyとleaseを評価 |
| `aidev hook quality-gate` | Claude Code PostToolUse | 設定されたquality gateを`src/`で実行 |
| `aidev hook session-stop` | Claude Code Stop | refresh queueとevolution journalを記録 |
| `aidev mcp azure-devops` | `.mcp.json` | `aidev.yaml`と環境変数を解決して固定版MCPをstdio起動 |

内部commandを人間向けworkflowの入口として扱わないでください。引数やstdin payloadはClaude Code設定との契約です。

## 主なoption

### `aidev init`

```text
--dry-run --resume --yes --force
--org --project --repository --wrapper-repository
--name --tracking-branch --agent-model --json
```

- `--resume`は既存`aidev.yaml`を再生成する分岐に関係します。Wiki proseのcheckpoint再開flagではありません。
- `--yes`はpromptを止めるだけです。submodule URLから推測できない値は明示が必要です。
- `--force`はkit管理assetのローカル差分を置換し得ます。

### `aidev knowledge build`

```text
--scope <path> --refresh --resume --dry-run --force --no-remote --json
--agent --agent-name <name> --agent-timeout <ms> --agent-model <model>
```

- `--agent`または`--agent-name`を指定した場合だけprose agentを起動します。`--agent-timeout` / `--agent-model`だけでは起動しません。
- `--scope`はgeneration targetsだけを狭めます。repository evidenceは`knowledge.evidence`のままで、scope外のコードも根拠として調査できます。
- `--scope`外のgeneration targetはmanifest checkpointへdeferされます。
- CLI表示のqueueはagentが調査できる全ファイルではなく、今回更新するgeneration targetです。tracked・非secret evidence件数は別表示されます。
- supporting evidenceだけが変わった場合は、依存を取りこぼさないため全generation targetをqueueします。
- `--refresh` / `--resume`は既存`checkpoint.pendingPaths`も再投入します。
- 手編集ページは通常停止し、破棄には`--force`が必要です。
- structured write完了後にagentが失敗した場合、checkpointを残してexit 1です。

### `aidev sync`

```text
--to <sha> --dry-run --no-pr --resume --abort --check-only --json --force
--agent --agent-name <name> --agent-timeout <ms> --agent-model <model>
```

- `--to`はfetch済みtracking branchから到達可能なcommitだけを許可します。
- `--dry-run`はworktreeを書き換えませんが、tracking branchのfetchは行います。
- `--no-pr`はbumpとWiki差分をworktreeへ残します。
- `--resume`はexisting sync leaseを検証して続行します。
- `--abort`はrecord済み`originalSha`へ戻しleaseを解放します。
- 捕捉した失敗でも、半適用状態を隠さないためleaseを意図的に残します。

### `aidev permission`

```text
configure|reconfigure|show
--approve --force --dry-run --json
```

承認なしでは`.aidev/policy.candidate.yaml`だけを書きます。`--approve`でCLIが`.aidev/policy.yaml`へ配置しcandidateを削除します。既存policyより保護を弱める場合、`--approve --force`が必要です。

### `aidev update`

```text
--remote <name> --ref <ref> --dry-run --force --json
```

既定は`upstream/main`です。dirty worktreeは通常拒否します。`--dry-run`でもfetchします。現在の取込対象は`templates/claude-assets`、`CLAUDE.md`、`.mcp.json`、`cli`、`scripts`です。

## 終了code

entrypointは`AidevError`を次の公開codeへ変換します。

| code | symbolic meaning | 主な利用箇所 |
| --- | --- | --- |
| `0` | success | 正常、またはwarningのみ |
| `1` | general | 実行エラー、agent失敗など |
| `2` | drift | static asset drift。strict modeのwarning昇格 |
| `3` | permission | policy違反、policy未配置など |
| `4` | knowledge consistency | `submoduleSha != knowledgeSha` |

`remoteSha != submoduleSha`のみで、`submoduleSha == knowledgeSha`なら通常はwarning / exit 0です。pending proseも通常はwarningで、`check --strict`ではexit 2へ昇格します。

## JSON出力

`--json`対応commandは、stdoutへ単一JSON documentを出す契約です。診断文はstderrへ分離します。新しいcommandやwarningを追加するときにstdoutへhuman textを混在させないでください。

## dry-runの意味

本CLIの`--dry-run`は基本的に「作業ツリーの管理対象を書き換えない」という意味です。完全な副作用ゼロではありません。

- `update --dry-run`: upstreamをfetchし、remote-tracking refが更新され得る
- `sync --dry-run`: `src`のoriginをfetchする
- `plan` / state確認: remote確認cacheを更新し得る

READMEやhelpで「network accessも含め何もしない」と表現しないでください。

## syncの冪等性

同期には2種類の識別子があります。

- operation key: organization、project、PKG repository、target SHA、wrapper repositoryをhash化。特定targetへの処理を識別
- sync stream ID: organization、project、PKG repository、tracking branch、wrapper repositoryをhash化。継続する同期系列を識別

同じstream・同じsource branchのopen PRはdescriptionを更新します。target SHAが変わるとbranch名も変わるため新しいPRを作り、旧PRへsuperseded注記を追加します。Azure DevOps上で旧PRを自動closeしません。

syncがcommit時にstageするのは`src`と`knowledge`だけです。無関係な作業ツリー差分を`git add -A`で巻き込みません。

## `task`の現在の契約

subcommandは実装されていますが、入口は既存の`.aidev/tasks/*.json`です。production codeには次がありません。

- Work Itemを取得して最初のtask cacheを作る公開command
- 初回work leaseを取得する公開経路
- 新規cloneでAzure DevOpsからcacheを再構築する処理

したがって、`task advance`や`task resume`をcross-machine orchestrationとして利用者へ約束しないでください。

## workflowの現在の契約

`workflow new <name>`は`workflow-creator` agentを起動せず、固定の`workflow.yaml`と`steps.js` scaffoldを作ります。

`approve`は両ファイルのcontent hashを`approval.json`へ記録します。`run`はhash一致、最大反復、最大時間、同一失敗、実行command basename allowlistを検査します。一方、token/USD budgetの実消費量計測と、破壊操作前の対話承認は未実装です。

## eject

管理解除は高影響操作です。

```bash
aidev eject --dry-run
aidev eject --yes
```

既定ではkit static assetsと制御状態を削除し、`.aidev-ejected` markerを作ります。`src/`、`knowledge/`、`aidev.yaml`、`workflows/`は残します。static assetsを残す場合は`--keep-assets`を使います。

実行後は`aidev check`による管理対象外となるため、利用者向け説明では必ずdry-run、差分確認、復旧方針を先に案内してください。
