# Architecture and internal behavior

この文書はai-dev-kit（PKG clone方式）の技術設計を、本体を保守する人向けに説明します。利用者向けの手順は`docs/user-guide/`を参照してください。

## 1. PKG clone方式

`aidev`は利用者自身のPKG git cloneの中で動きます。wrapper repositoryもsubmoduleもありません。kitがPKGへ追加するものはすべてそのPKG repositoryへcommitされ、チーム全員がgitで同じ設定・同じWikiを受け取ります。

```text
<pkg clone>/
├─ aidev.yaml                     PKG固有設定（schema v2）
├─ CLAUDE.md                      templates/claude から適用（kit配布、teamが編集可）
├─ .mcp.json                      PKG の所有（kit は配布しない。MCP server は PKG が用意する）
├─ .claude/                       templates/claude/.claude から適用（同上）
│  ├─ settings.json               hooks / deny / ask
│  ├─ agents/  skills/
│  └─ settings.local.json         個人設定。kit所有ではなくdrift検出から除外
├─ .github/  AGENTS.md  .codex/  .kiro/   tools.default に copilot / codex / kiro があるときだけ（§2）
└─ .aidev/
   ├─ .gitignore                  CLIが書く。runtime stateをgitから外す
   ├─ policy.yaml                 承認済みpolicy（CLIだけが配置）
   ├─ policy.candidate.yaml       承認待ちの候補（一時）
   ├─ materialized.json           適用したtemplateとfileのhash record、未解消conflict（applyのmerge基準）
   ├─ ejected.json                aidev uninstall <package> の marker（通常は存在しない）
   ├─ knowledge/                  LLM Wiki（manifest.json, inventory/, index.md, overview.md, pages）
   │  └─ .cache/                  plan.json（hook経路のbatch計画）、agent task、完了報告 done/（ignored）
   ├─ conventions/                開発規約（PKG の workflow が生成し、team が review して commit）
   ├─ workflows/<name>/           workflow.yaml（runs/ はignored）。承認 = origin/<tracking_branch> と同一
   ├─ agents/<name>.md            PKG固有のagent定義（workflowが名前で参照。kit同梱より優先）
   ├─ skills/<name>/SKILL.md      PKG固有のskill（同上）
   ├─ sync.lock                   publish lease（ignored）
   └─ cache/                      remote-check.json, last-head.json, wiki-stop.json, wiki-worktree/,
                                  agents/（prompt file）, evolution/<session>.md（kit開発者端末の振り返り）（ignored）
```

`.aidev/.gitignore`の内容は`layout.AIDEV_GITIGNORE`で固定です（`cache/`、`sync.lock`、`knowledge/.cache/`、`workflows/*/runs/`）。`init`、`apply`、`sync wiki`（worktree内でも）が`ensureAidevGitignore`で書き、内容が違えば上書きします。

path名の正本は`cli/lib/layout.js`です。`KIT_MANAGED_GLOBS`（`aidev.yaml`、`.aidev/**`、全toolの`TOOL_CONFIG_GLOBS`: `.claude/**`、`CLAUDE.md`、`.mcp.json`、`.github/copilot-instructions.md`、`.github/agents/**`、`.github/skills/**`、`.github/hooks/**`、`AGENTS.md`、`.codex/**`、`.kiro/steering/**`、`.kiro/agents/**`）に一致するpathはWikiのgeneration targetにもevidenceにもならず、PostToolUseのquality gateも走りません。`git.findRepoRoot`は`aidev.yaml`または`.aidev/`を持つdirectoryまで上へ辿り、無ければgit top-levelへfallbackします。

### 端末側: kit checkoutと`AIDEV_HOME`

| 場所 | 役割 |
| --- | --- |
| kit checkout（`installRoot`） | ai-dev-kit自身のclone。launcherが`cli/bin/aidev.js`を指す。`aidev update`が`origin/main`へfast-forwardする。templateの読み出し元 |
| launcher | `scripts/install.ps1`が`%LOCALAPPDATA%\ai-dev-kit\bin\aidev.cmd` / `.ps1`、`scripts/install.sh`が`~/.local/bin/aidev`を作る（`AIDEV_BIN_DIR`で変更可） |
| `AIDEV_HOME` | 既定はWindows `%LOCALAPPDATA%\ai-dev-kit`、POSIX `$XDG_DATA_HOME/ai-dev-kit`（未設定なら`~/.local/share/ai-dev-kit`）。`registry.json`、`cache/update-check.json`、kit開発者端末では`developer.json`と`cache/evolve/`（§13）を置く |

`registry.json`（`{schemaVersion: 1, packages: [{name, path, remote, kitCommit, registeredAt, updatedAt?}]}`）は`init`と`apply`が登録し、`eject`が削除します。`uninstall`は`registry.json`と`cache/`ごと消します（PKG側には触れず、kit所有fileを消す`git rm`を表示するだけ）。`update`はここに載っているcloneのうちlockの`kitCommit`が現在のkitと違うものを「`aidev sync tools`が必要」として一覧します（適用はしません）。

## 2. tool configのtemplate、apply、記録

### template → PKG

toolごとに`templates/<tool>/`があり、PKG rootにそのまま重なるtreeです（`tools.templateDir(id)`）。対応表はありません。

| tool | template tree（PKGでの位置と同じ） |
| --- | --- |
| `claude` | `templates/claude/.claude/**`、`templates/claude/CLAUDE.md` |
| `copilot` | `templates/copilot/.github/copilot-instructions.md`、`.github/agents/<agent>.agent.md`、`.github/skills/<skill>/**`、`.github/hooks/aidev.json` |
| `codex` | `templates/codex/AGENTS.md`、`.codex/hooks.json` |
| `kiro` | `templates/kiro/.kiro/steering/ai-dev-kit.md`、`.kiro/agents/<agent>.json`、`.kiro/agents/aidev.json`（hooksを持つ主担当agent） |

treeはkit保守者が手で揃えます（toolごとの差はtemplateから生成できないため）。claude以外のtreeは実機未検証で、fileの先頭にその旨を書いています。`layout.TOOL_CONFIG_GLOBS`がkit所有pathの正本で、`isKitManaged` / `ALWAYS_PROTECTED` / `settings.json`のdeny listはこれに従います。`.claude/settings.local.json`は個人設定で常に除外です（`STATIC_EXCLUDE`）。

### apply（`assets.applyTemplates`）

`aidev init`（初回、lockが無いとき、または`--force`）と`aidev sync tools`が呼びます。`aidev update`はkit checkoutを進めるだけでPKGには触れません。適用はcopyではなくmergeです。file単位の判定:

| 状態 | 結果 |
| --- | --- |
| 無い | `created` |
| templateと同一 | `unchanged` |
| 前回適用したtemplateのまま（`pristine`: hashがlockの`kit`と一致） | `updated`（新templateで置換） |
| 編集済み、kitは不変（lockの`kit`が新templateのhashと一致） | `kept`（そのまま。lockの`file`を更新） |
| 編集済み、kitも変更 | 3-way merge。base = lockの`kitCommit`にあったtemplate（kit checkoutの`git show <sha>:templates/<tool>/<rel>`）。cleanなら`merged`、同一箇所ならgit merge-fileのmarker付きで書き`conflicts`、baseが履歴に無ければ触らず`conflicts` |
| lockに無く、templateと違う（初回に既存fileがある） | 触らず`conflicts`（`--force`でkit版） |
| 前回のconflict、markerが残っている | 触らず`conflicts` |
| 前回のconflict、markerが消えた | `resolved`（現在の内容を記録） |
| templateから消えた（kitが配布をやめた、toolが`tools.default`から外れた） | pristineなら`pruned`、編集済みなら`retired`（残してlockから外す） |

`--force`は全fileをkit版にします。`--dry-run`はfileもlockも書きません。空になったtool directoryは`pruneToolDirs`が消します（`.claude/`自体は残す）。

### `.aidev/materialized.json`（schemaVersion 4）

```json
{
  "schemaVersion": 4,
  "kitCommit": "<kit checkoutのHEAD>",
  "kitVersion": "0.4.0",
  "tools": ["claude", "copilot"],
  "appliedAt": "...",
  "files": { "<rel>": { "kit": "sha256:<適用したtemplate>", "file": "sha256:<書いた/受け入れた内容>" } },
  "conflicts": ["<rel>", "..."]
}
```

schema 3以前の`files: { rel: "sha256:…" }`は`kit: null, file: <hash>`として読みます。`inspectConfig`は次を返し、`status`と`check`が使います。

| field | 意味 | `check` |
| --- | --- | --- |
| `noLock` | 記録が無い | exit 2 |
| `conflicts` | lockの`conflicts`に載っている、またはmarkerがあるfile | exit 2 |
| `hooksMissing` | `.claude/settings.json`にtemplateの`aidev hook …`の一部が無い（claudeのみ） | exit 2 |
| `missing` | 記録にあるがdiskに無い | 情報（`apply`が復元） |
| `customised` | pristineでないfile（teamの編集） | 情報 |
| `outdated` | lockの`kitCommit`が現在のkitと違う | 情報（「`aidev sync tools`で取り込める」） |

teamの編集はdriftではありません。`check`が止めるのは「merge前に誰かが見るべき状態」（未解消conflict、hooks欠落）だけです。

## 3. 編集権限の層

| 層 | 実体 | 位置付け |
| --- | --- | --- |
| 静的deny / ask | `.claude/settings.json` | Claude Code側の第一防御。`Edit(.claude/**)`等をdeny、`git push`・`aidev create policy`・`aidev uninstall <package>`・`aidev uninstall`をask |
| 実行時guard | `aidev hook guard-write` | path、policy、承認済みworkflowのscope（`AIDEV_WORKFLOW`）、整合性、leaseを評価して`permissionDecision`を返す |
| 制御面の検査 | `aidev check`（exit 2）+ branch policy | hooksを消した編集と未解消のconflict markerをmerge前に止める（teamの他の編集は止めない） |
| 行動指示 | `CLAUDE.md`、Agents / Skills | 補助。強制境界ではない |
| 認証scope | tokenの権限 | server側で最も強い強制力 |

### policy評価順序（`policy.decide`）

`policy.js`の`decide()`は次の順で判定し、最初に当たった規則で確定します（`rule`はJSON出力・hook理由に入る識別子）。

1. repository外へ解決されるpath、またはroot自身 → deny `outside-repo`（`paths.toRepoRelative`が`..`を字句的に解決してから判定）
2. `secrets_paths`一致 → deny `secrets`（leaseがあっても不可）
3. `protected`一致 → deny `protected`（`ALWAYS_PROTECTED`はpolicy fileから消しても`validatePolicy`が再付与）
4. 整合性gate: `computeState(checkRemote: false)`が**ERROR**のとき
   - 有効なsync leaseが無い → deny `consistency-no-lease`（全書込停止）
   - あり、かつ`writable_during_sync`一致 → allow `sync-lease`
   - あり、かつ不一致 → deny `sync-lease-scope`
5. `writable`一致 → allow `writable`（Wiki・workflows・agents・skills・conventions・`aidev.yaml`は`read_only: ["**"]`の内側にあるため、read_onlyより先に評価する）
6. 承認済みworkflowのscope: `AIDEV_WORKFLOW`（`aidev run workflow`が子processの環境に入れる。hookはそれを継承する）が指すworkflowを`workflow.inspect`で読み、`workflow.yaml`と参照するPKG内agent / skillが`origin/<hosting.tracking_branch>`と同一（`approvalStatus`）で、pathが`scope.writable`に一致 → allow `workflow-writable`。未承認や範囲外は理由を持ち越して次へ。判定は書込のたびに行うので、agentが実行中に`workflow.yaml`を書き換えてscopeを広げても、その時点でoriginと食い違って拒否される
7. `read_only`一致 → deny `read-only`（理由にworkflowの承認状態と範囲を含める）
8. どれにも当たらない → allow `default`（既定policyは`read_only: ["**"]`なので、通常この分岐に到達するpathはない）

`decideMany`は複数targetのうち最初のdenyで確定します。

### 既定policy

```yaml
version: 1
protected:            # ALWAYS_PROTECTED + secrets_paths
  - ".claude/**"
  - "CLAUDE.md"
  - ".aidev/policy.yaml"
  - ".aidev/sync.lock"
  - ".aidev/materialized.json"
  - ".aidev/.gitignore"
  - ".aidev/ejected.json"
read_only:
  - "**"
writable_during_sync:
  - ".aidev/knowledge/**"
writable:
  - ".aidev/knowledge/**"
  - ".aidev/workflows/**"
  - ".aidev/agents/**"
  - ".aidev/skills/**"
  - ".aidev/conventions/**"
  - "aidev.yaml"
```

`.aidev/workflows/**`・`.aidev/agents/**`・`.aidev/skills/**`が既定で`writable`なのは、workflow-creator / agents-creatorの出力先だからです。`.aidev/conventions/**`はPKGのworkflowが書く開発規約の置き場です。PKG source（`src/**`など）を書けるのは承認済みworkflowの`scope.writable`だけで、policyにagent単位の許可（旧`agents.<name>`）はありません。`validatePolicy`は`agents`キーをerrorにします。

候補は`permission.buildCandidate(config)`が`aidev.yaml`から機械生成します。agentは使いません。`--approve`は候補fileを読まず生成し直すので、teamの追加（`writable`）は`.aidev/policy.yaml`を直接編集してPRでreviewします。policy fileが無い場合、`loadPolicy`は上記と同じ内容の`_fallback: true`を返します（未初期化repoが無防備にならない）。

### Bash targetの抽出

`extractBashTargets`はredirection（`>`、`>>`）と既知の書込command（`rm mv cp tee truncate install shred dd chmod chown ln mkdir rmdir touch sed -i patch`）のoperandを拾います。sandboxではなく、明らかな回避を捕まえる補助です。targetが1つも取れなければallow（「no filesystem target identified」）になります。

## 4. Wikiの整合判定（head / knowledge / tracking）

Wikiは**今のbranchのHEAD**を説明します。`state.computeState(repoRoot, config, { checkRemote, force })`が返す主な値は次のとおりです。

| 値 | 実体 | 意味 |
| --- | --- | --- |
| `headSha` | checkoutのHEAD | Wikiが説明すべきcode |
| `knowledgeSha` | `.aidev/knowledge/manifest.json`の`knowledgeSha` | Wikiを生成したときのHEAD。**情報のみ**で、判定の根拠にはしない |
| `trackingSha` | `origin/<tracking_branch>`の先端（remote `ls-remote`、不可なら手元のremote-tracking ref） | tracking branchが先へ進んだことを警告するためだけに使う |
| `baseSha` | `merge-base(HEAD, origin/<tracking_branch>)`。remote-tracking refが無ければHEAD | tracking先行の判定（`sourceChanged(baseSha, localTrackingSha)`）にだけ使う |

整合は**inventory（Wikiを生成したときのpathとblob idの一覧）とHEADのtree**の比較です（`inventory.compareWithTree(repoRoot, config, records, { ref: 'HEAD' })`が`{ behind, changed, added, modified, removed, renamed }`を返す）。旧commit objectを必要としないので、fetch・rebase・squash・force-pushの後でも同じ判定になり、`aidev sync wiki`が再生成対象を決める差分と一致します。`knowledgeSha`がHEADと違っても内容が同じならOKです（Wiki追加commitやkit更新commitはgeneration targetを変えないので「遅れ」になりません）。`state.sourceChanged(repoRoot, a, b)`（kit管理pathを除いた`git diff --quiet`）はtracking先行の判定にだけ残っています。

### severity（判定順）

| 条件 | severity | message要旨 |
| --- | --- | --- |
| manifestが無い | ERROR | Wiki未生成。`aidev init`（または`sync wiki`） |
| HEADが解決できない | ERROR | commitが無い |
| manifestに有効な`knowledgeSha`が無い | ERROR | manifest破損 |
| HEADのtreeを列挙できない | ERROR | 比較不能 |
| inventoryとHEADのtreeが違う（`behind.behind`） | WARN | Wikiが遅れている（`+a ~m -r →n`）。`aidev sync wiki` |
| `checkpoint.pendingPaths`が残っている | WARN | prose未完了。`aidev sync wiki` |
| remote確認を要求したが到達不能 | UNKNOWN | local状態は整合 |
| 手元の`origin/<branch>`が`baseSha`より先で、source差分あり | WARN | tracking branchが先行。merge / rebaseしてから`sync wiki` |
| remoteの先端が手元のremote-tracking refと違う | WARN | 未fetchの新commit |
| それ以外 | OK | WikiはHEADを説明している |

ERRORは**構造破損のみ**です。PreToolUse guardは`checkRemote: false`で判定するため、networkがERRORを作ることはありません。`formatSummary`は`[ai-dev-kit] head=… knowledge=… tracking=…`の1行とicon付きmessageを返し、SessionStart hookと`status`が表示します。戻り値の`wikiBehind`、`behind`（件数）、`pendingPages`、`hasWiki`をhookの`needsFollowUp`（`hasWiki && !ERROR && (wikiBehind || pendingPages > 0)`）が使います。

remote確認は`git ls-remote --heads`（local refを変更しない）を`sync.remote_check_timeout_ms`で打ち切り、結果を`.aidev/cache/remote-check.json`に`sync.remote_check_ttl_minutes`だけcacheします。`force: true`（`doctor`）はcacheを無視します。

### `aidev check`の変換

`check`は`check.inspect`の検査で、tool config（record欠落・未解消conflict・kit hooks欠落 → exit 2）→ policy（exit 3）→ Wiki（exit 4）の順で最初の問題のcodeを返します。exit 4はERROR severity、inventory不整合（同じpageに異なるhash）、期限切れpublish leaseです。`--strict`は他に問題が無いときWARN（Wiki behind HEAD、pending prose、tracking先行）をexit 2へ昇格します。`.aidev/ejected.json`がある、または`aidev.yaml`が無いrepositoryはexit 0です。

## 5. lease

leaseはsync leaseの1種類だけです（work leaseは0.5.0で撤去）。fileは`ALWAYS_PROTECTED`なので、agentが自分でleaseを作る・延長することはできません。`evaluateLease`は`acquiredAt + ttlMinutes`で期限を判定し、壊れた記録は無効扱いです。

### publish lease（`.aidev/sync.lock`）

```json
{ "schemaVersion": 1, "kind": "sync", "targetSha": "…", "originalSha": "…",
  "taskId": null, "acquiredAt": "…", "ttlMinutes": 120, "pid": 12345 }
```

file名と`kind`は歴史的にsyncのままです。保持者は`aidev sync wiki`の2経路です。

- publish経路（tracking branch上、または`--branch`）: worktree作成から後片付けまで保持し、成功時に解放、失敗時は残す。既存leaseの`targetSha`がHEADと同じならそのまま継続（同じcommandの再実行）、違えば`--abort`（破棄）か`--force`（引き継ぎ）を要求する
- in-place経路（`updateInPlace`）: 状態がERRORかつWikiが存在するとき、inventory/manifestを書く間だけ取得して即解放する。ERROR状態で`knowledge/**`を書ける唯一の経路がこのleaseなので、updateが自分で取らないと出口が無くなる（自己deadlock）。agent起動はlease解放後、manifestが`targetSha`へ進んでWARN/OKになってから行う

sync leaseがguardで効くのは、状態がERRORのときだけです（§3の第4段）。

PKG sourceへのagentの書き込みは、承認済みworkflowの`scope.writable`（§9）か、teamが`.aidev/policy.yaml`の`writable`（全員）に書いたpathだけです。一時的な許可（TTL付きのwork lease）も、agent単位の許可（旧`agents.<name>`）もありません。

## 6. Wiki: manifest、inventory、evidence、agent

LLM Wikiは正本ではなくPKG sourceから再生成できる派生情報です。CLIとagentの責務を分けます。

| 担当 | 責務 |
| --- | --- |
| CLI | clean-tree検査、generation target走査、evidence走査とfingerprint、mask、blob hash diff、inventory shard、manifest、checkpoint、page hash、agentのbatch起動（またはhook経路の`plan.json`）、完了報告の取り込み、orphan page削除、`.aidev/knowledge/`のcommit |
| knowledge-builder | evidenceを調査してprose pageと`index.md` / `overview.md`を書き、対象ごとに完了報告を残す。manifest / inventoryは書かない。commitもしない |

### clean-treeの規則

Wikiは「commitされた木」だけを説明します。`inventory.dirtyTargets(root, config)`（`git status --porcelain`をgeneration targetに絞ったもの。kit管理pathと`.aidev/knowledge/`は除外）に1件でもあれば、`sync wiki`はpathを列挙してexit 1、hookはpathを挙げるだけで何もしません。`.aidev/knowledge/`やtool設定fileの汚れは問いません（Wiki commitはそれらだけをstageするため）。

### generation targetとevidence

- **generation target** = `package.include` / `package.exclude`に一致する、target commitのtracked file（`inventory.scanPackage(repoRoot, config, {ref})`、`git ls-tree`ベース）。kit管理pathは除外。`secrets_paths`一致は`masked: true`のrecordとして残す
- **evidence** = `knowledge.evidence.include` / `exclude`（既定は`**`と`package.exclude`の継承）に一致し、`secrets_paths`に一致しないtracked file（`knowledge-scope.scanEvidence`）。agentが**読んでよい範囲**であり、正確なpath一覧としてpromptに渡す
- `--scope`はgeneration targetだけを絞り、evidenceは狭めない

`buildEvidenceSnapshot`はgeneration target外のevidence（supporting evidence）のpath/blob、include/exclude、secret patternからfingerprintを作り、`manifest.evidence`へ保存します。fingerprintが変わると、page単位の依存graphが無いため全generation targetを保守的に再queueします。

### manifest（schemaVersion 3）

```json
{
  "schemaVersion": 3,
  "knowledgeSha": "9f2c1ab…",
  "kitCommit": "3d7e40b…",
  "generatedAt": "2026-09-21T09:00:00.000Z",
  "inventoryShards": ["inventory/00.json"],
  "stats": { "files": 55, "pages": 42, "maskedFiles": 1, "evidenceFiles": 3184 },
  "evidence": {
    "include": ["**"], "exclude": ["**/node_modules/**"],
    "trackedFiles": 3184, "supportingFiles": 3129, "fingerprint": "sha256:…"
  },
  "checkpoint": { "completedShards": 1, "pendingPaths": [], "staleIndexes": [] }
}
```

`knowledgeSha`は生成時のHEADで、表示用です（整合判定はinventoryとHEADのtreeの比較。§4）。`kitCommit`はkit checkoutのHEAD（Wikiを生成したkitの版）です。`state.knowledgeSha`は`knowledgeSha`が無ければ`targetSha`も読みますが、書き手は常に`knowledgeSha`です。

### inventory record（`.aidev/knowledge/inventory/NN.json`）

```json
{
  "path": "src/api/auth.ts",
  "blob": "a1b2c3d4…",
  "masked": false,
  "pages": [".aidev/knowledge/api/auth.md"],
  "selfHashes": { ".aidev/knowledge/api/auth.md": "sha256:…" }
}
```

recordは`path`順にsortし、`knowledge.inventory_shard_size`件ごとに`00.json`, `01.json`…へ分割します。`diffInventory`は旧recordと新scanをpathとblobで突き合わせ、`added` / `modified` / `removed` / `renamed`（同一blob・別path、prose再生成不要）/ `unchanged`を返します。旧commit objectが無くても（GC、force-push後でも）差分が取れるのがblob方式の理由です。`selfHashes`はpage手編集の検出に使い、`detectHandEdits`が`modified` / `missing`を返します。`sync wiki`は`modified`があると`--force`なしで停止します。`compareWithTree`は同じrecordをHEADのtreeと突き合わせて整合判定に使います（§4）。

`removed`だけが参照していたpageは`orphanedPages`で求め、`removeOrphanedPages`が`.aidev/knowledge/`内に限って削除し、親`index.md`を`staleIndexes`へ記録します。`index.md`はorphanにしません。

### batch実行と完了報告

`agent.runWikiAgent`は1 processに全targetを渡しません。単一runは終わるまで進捗が見えず、timeoutで全成果を失い、headless実行ではBashが拒否されるためagentが`selfHashes`を計算できないからです。

1. **survey run**（`overview.md`が無い、全件生成、または`--survey`。`--no-survey`で抑止）: generation targetなしでrepositoryを地図化し、`.aidev/knowledge/overview.md`と`index.md`を書く。報告は`__survey__.json`で、両pageを含まなければ失敗
2. **batch run**: `knowledge.agent_batch_size`（既定20）件ずつ、1 batch = 1 process、それぞれ`agent_timeout_ms`（既定30分）の予算。人間向け出力では`batch i/n`、15秒ごとの経過表示、完了batchの平均時間からの残り時間目安を出す
3. agentは対象を1つ書き終えるたびに`.aidev/knowledge/.cache/done/<path with / → __>.json`（`{target, targetSha, pages, note?}`）を書く
4. 各run終了後、CLIが`inventory.applyCompletions`で報告を読み、pageが`.aidev/knowledge/`内の実在fileであることを検証してsha256を計算し、recordの`pages` / `selfHashes`を置き換え、共有pageのhashを全recordへ揃え、`checkpoint.pendingPaths`から除く。取り込んだ報告と拒否した報告は削除する。manifestが無い・checkpointが無い・`knowledgeSha`が`targetSha`と違う場合は報告を残したまま`manifestInvalid`を返す
5. batchの全対象が報告済みなら次へ。timeout、process失敗、報告不足（exit 0だが未報告あり）なら停止する。完了分はすでにcheckpointに反映済み

`sync wiki`は開始時にも`done/`に残っている報告を取り込むため、Ctrl-Cで止めた実行やhook経路のsubagentの成果も次回へ引き継がれます。promptが8 KiBを超える場合、planは`.aidev/knowledge/.cache/agent-task-<sha12>-<label>.json`（`schemaVersion: 2`、`mode`、`generationTargets`、`evidence.paths`）へ書き、promptはそのfileを指します。

### hook経路の`plan.json`

対話toolのsession内では、CLIはagentを自分で起動しません（hookの時間予算にLLMは収まらない）。`updateInPlace`はprose未完了のとき`.aidev/knowledge/.cache/plan.json`（`writePlanFile`）を書き、残り0で消します。

```json
{
  "schemaVersion": 2, "targetSha": "…", "mode": "generate", "hasOverview": true,
  "generationScope": null, "generationTargets": ["src/a.ts", "…"],
  "batches": [["src/a.ts", "…"], ["…"]],
  "evidence": { "include": ["**"], "exclude": ["…"], "paths": ["…"], "excludedSecretPatterns": ["…"] },
  "maxFilesPerDir": 20, "reportDir": ".aidev/knowledge/.cache/done", "finish": "aidev sync wiki --no-agent"
}
```

hookはこのfileの`batches`数とともに「batch *i*ごとにknowledge-builderをsubagentとして起動し、`reportDir`へ完了報告を書かせ、全部終わったら`finish`を実行する」とsessionに指示します（§8）。subagentは通常のbatch runと同じ契約で報告を書き、`finish`（`--no-agent`）が`applyCompletions`で取り込んでcommitします。

### commit

prose完了（`remaining === 0`かつagent失敗なし）で、`commit`が要求されていれば`commitWiki(root, targetSha)`: `git add -A -- .aidev/knowledge .aidev/.gitignore` → stageが空なら`committed: false` → `git commit -m "aidev: update Wiki for <sha12>"`（本文に「Generated by ai-dev-kit; review it like any other change in this pull request.」）。source commitはdeveloperの、Wiki commitはkitのもので、同じbranch・同じPRに並びます。`--no-commit`（`init`もこれ）は作業treeに残します。prose未完了ならcommitせずexit 1で、同じcommandがcheckpointから続きます。

### 結果の判定

subprocessのexit 0はtransport成功にすぎません。呼び出し側はmanifestを再読込し、`assessWikiProgress`で次を判定します。

- manifestの`knowledgeSha`が変わった、checkout SHAが変わった、`pendingPaths`が配列でない → `checkpointInvalid`。sourceとmanifest targetが動いていなければ、pre-agentのqueueをそのまま書き戻す（`checkpointRestored`）
- queueした全pathが消えた → 成功
- 一部だけ消えた → `partial`、1つも消えていない → `noProgress`

partial / noProgress / checkpointInvalidはClaudeの最終回答の要約（制御文字を除去、1600文字上限）を表示してexit 1です。JSONでは`ok: false, structuredOk: true`で「構造化更新は成功、prose未完了」を区別します。

### Claude launcher

- tool固有の事項は`cli/lib/tools.js`の`REGISTRY`（`claude` / `copilot` / `codex` / `kiro`）に集約する。各recordは`bin`、`envBin`、`minVersion`、`verified`、`prompt`（`stdin` | `file`）、`namedAgents`、`argv()`、`parse()`、`configGlobs`、`configDirs`を持つ。`agent.js`はtool idを見ずadapterに委譲する
- `tools.resolveBinary(tool)`: `AIDEV_<TOOL>_BIN`（`.js`ならnodeで実行しversion検査を省く。testはこれでstubを差す）→ Windowsは`where.exe <bin>`で絶対pathへ解決（`.cmd`/`.bat`は`cmd.exe /d /s /c`経由）→ それ以外はPATHの`<bin>`
- `tools.checkVersion`: `<bin> --version`。`minVersion`があるtool（claude: 2.1.259）はそれ未満で起動しない。無いtoolは起動できれば通す
- claudeのargvは`-p --input-format text [--agent <name>] [--model <m>] --output-format json --permission-mode acceptEdits --permission-prompts none`。promptはargvでなくstdinへ書く（Windowsのshell分割対策）。`--model`はmodelがnullのとき省略し、tool側の解決に任せる。`runAgent({ definition })`でagent定義を渡すと`--agent`を付けず、定義本文をpromptの先頭に置く（PKG外で動く`evolution` agent用）。`extraArgv`はそのまま末尾に足す
- `runAgent`は`env`をそのまま子processに渡す。workflow runnerは`AIDEV_WORKFLOW=<name>`を足して起動し、toolが起動するhookがそれを継承してguard-writeが承認済みscopeを適用する
- `prompt: 'file'`のtool（copilot / codex / kiro）はpromptを`.aidev/cache/agents/<tool>-<label>-<pid>-<time>.md`へ書き、argvには`filePointerPrompt(rel)`の1文だけを載せる。`namedAgents: false`のtool（codex）はそのfileの先頭に同梱agent定義の本文を置く。argv: copilot `-p <pointer> --allow-all-tools [--agent <name>] [--model <m>]`、codex `exec --sandbox workspace-write [--model <m>] <pointer>`、kiro `chat --no-interactive --trust-all-tools [--agent <name>] [--model <m>] <pointer>`。claude以外は実機未検証（`verified: false`）で、`aidev run workflow --dry-run`がcommand lineを表示する
- 結果はadapterの`parse()`が`{ok, result, costUsd, sessionId, permissionDenials, reason}`へ正規化する。claudeはJSON契約、他はexit codeとstdout本文
- timeoutではWindowsで`taskkill /T /F`によりprocess tree全体を止め、それ以外はSIGTERM→5秒後SIGKILL
- 起動失敗（ENOENT）は`skipped`として構造化結果は保持したまま報告し、例外にはしない

### 参照文書（`aidev.yaml`の`references`）

workflow runnerのagent stepは、`agent.resolveReferences(repoRoot, config)`が返す「# Reference documents」sectionをpromptの末尾に付けます。topicごとのfile一覧（directoryは再帰列挙）と、渡せなかったpath（無い、`secrets_paths`に一致、text fileが無いdirectory）の一覧です。中身は渡さず、pathだけを渡してagentに読ませます（agentの読み取りはpolicyとhookが検査するため）。Excel / Word / PDFは`validateConfig`が拒否し、textへの書き出しを求めます。詳細は`configuration-reference.md`の`references`。

## 7. `aidev sync wiki`

3つの部分（structure / prose / commit）を、単独で実行・再開・省略できるように分けています（`cli/commands/knowledge.js`）。

```text
 0. clean-tree検査（generation targetに未commit変更があればpathを列挙して停止）
 1. done/ に残る完了報告を取り込む（前回のCtrl-Cやsubagentの成果）
 2. HEADのtreeを走査し、記録済みinventoryとdiff（added / modified / removed / renamed）。
    evidence fingerprintが変わっていれば全targetを再queue。checkpoint.pendingPaths は常に再queue
 3. inventoryがHEADと一致し、queueも構造変更も無ければ no-op（未commitの完成Wikiがあればcommitして終了）
 4. 手編集pageがあれば --force なしで停止
 5. orphan page削除 → inventory shard → manifest（knowledgeSha = HEAD、checkpoint.pendingPaths）→ .aidev/.gitignore
 6. --no-agent でなければ knowledge-builder を batch 起動し、報告を取り込む
 7. 残りがあれば .aidev/knowledge/.cache/plan.json を書き、exit 1（commitしない）。無ければplan.jsonを消す
 8. 残り0なら .aidev/knowledge と .aidev/.gitignore だけを stage して "aidev: update Wiki for <sha12>" をcommit
    （--no-commit なら作業treeに残す）
```

呼び出し元は3つです。`aidev sync wiki`（人間、CI）、`aidev init`（`commit: false`）、hook（`updateInPlace`を`--no-agent --json`相当で。§8）。

### publish経路（tracking branch上、`--branch`）

protected branchには直接commitできないので、`update()`はcheckoutのbranchが`sync.tracking_branch`のとき（`--no-commit` / `--dry-run`でなければ）、または`--branch`で`publish()`へ分岐します。利用者のcheckoutには触れません。

```text
 1. publish lease（.aidev/sync.lock）を取得。既存leaseがHEADと同じtargetなら継続、違えば --abort / --force を要求
 2. .aidev/cache/wiki-worktree/ にHEADでdetached worktreeを作る（同一SHAなら再利用、違えば作り直す）
 3. worktree内で上記 0〜7 を commit: false で実行
 4. no-op → worktree削除・lease解放でexit 0
    prose未完了 → 何もpushせずexit 1（lease / worktreeは残す。同じcommandで継続、--abort で破棄）
 5. worktree内で aidev/wiki-<sha12> を checkout -B し、commitWiki
 6. --no-push でなければ push --force-with-lease --set-upstream origin <branch>
 7. sync.auto_pr が true、hosting が azure-devops、auth env が設定済みならPRを作成/更新。それ以外は手動作成を案内
 8. worktreeを削除し、leaseを解放
```

例外時はleaseとworktreeを残します。`--abort`はworktreeを削除してleaseを解放するだけで、checkoutは変更しません。`--resume` / `--to` / `--check-only`はありません（継続は同じcommand、targetは常にHEAD、状態は`aidev check`）。

### 識別子とPR

- operation key: `hosting.type`、organization、project、repository、target SHAのsha256先頭32桁
- wiki stream ID: 同じ材料でtarget SHAの代わりに`tracking_branch`
- PR descriptionに`<!-- aidev:wiki-stream <id> -->`を埋め、同じstreamのopen PRを検索する。同じsource branchならdescriptionを更新、branchが変わっていれば新PRを作り旧PRへ「Superseded」注記を追記する。closeは人間が行う
- PRのtitleはcommit messageの1行目、target branchは`sync.pr.target_branch`、reviewerは`sync.pr.reviewers`

### 主要scenario

| scenario | 処理 |
| --- | --- |
| feature branchでのcommit | after-bash hookが構造を更新し、subagentがprose、`--no-agent`がcommit（§8）。手動なら`sync wiki` |
| tracking branchへのmerge（Wiki commitを含む） | inventoryがHEADと一致するのでno-op |
| tracking branchへのmerge（Wikiなし） | `check`がWARN。夜間pipelineまたは手動の`knowledge update --branch`が`aidev/wiki-<sha12>`のPRを作る |
| force-push / rebase / squash / 旧commitがGC済み | inventory blobとHEAD treeを比較するため影響なし |
| renameのみ | 同一blobで`renamed`、prose再生成なし。hook経路ではhookがそのままcommit |
| generation target外のsource変更 | evidence fingerprint差分で全target再queue |
| 削除 | orphan page削除、親indexを`staleIndexes`へ |
| kit更新やWiki追加だけのcommit | generation targetが変わらないのでno-op |
| generation targetに未commit変更 | pathを列挙して停止（hookは案内だけ） |
| Wiki手編集 | `selfHashes`差分で停止、`--force`で破棄 |
| prose未完了 | plan.jsonを書きexit 1。同じcommandがcheckpointから継続 |
| publish途中の失敗 | lease / worktreeを残し、同じcommandで継続 / `--abort` |
| 同じtargetの再実行 | worktree再利用、同一branchへ`--force-with-lease` |
| open PR中に新target | 新branch・新PR、旧PRへsuperseded注記 |
| tracking branchのWikiがPR待ち | `check`が`aidev/wiki-<sha12>`の存在を注記 |

## 8. hooks

同梱のhook設定は次のeventを`aidev hook <name> [--tool <id>]`（文字列形式、PATH上の`aidev`）へ接続します。`CLAUDE_PROJECT_DIR`が設定されていればrepo root探索の起点にします。hookはnetworkにもLLMにも触れず（`session-start`だけTTL cacheと3秒timeoutのremote確認）、toolのhook timeout（既定30秒）に収まります。

| event（claudeの名前） | matcher | 責務 |
| --- | --- | --- |
| SessionStart | — | `formatSummary`とpublish leaseの状態、Wikiが遅れていれば追従の予告を`additionalContext`で返す。HEADを`.aidev/cache/last-head.json`に記録 |
| PreToolUse | `Write|Edit|MultiEdit|NotebookEdit|Bash` | `targetsFrom`でpathを集め`policy.decideMany`。deny理由を`permissionDecisionReason`へ |
| PostToolUse | `Write|Edit|MultiEdit` | `quality_gates`のcommandをrepo rootで実行。編集対象がkit管理pathだけなら`skipped` |
| PostToolUse | `Bash` | **after-bash**。HEADが`last-head.json`と違い、`needsFollowUp`（Wiki behind または prose pending）なら`followUp`（下記） |
| Stop | — | **session-stop**。`needsFollowUp`かつcleanなら1回だけ`decision: block`で`followUp`の指示を返す。2回目（claude / copilot / codexは`stop_hook_active`、kiroはkitの`.aidev/cache/wiki-stop.json`で判定）は警告付きで通す。dirtyなら止めない。その後、kit開発者端末（`home.readDeveloper`）でだけtranscriptを集計し、閾値超えの未振り返りsessionに`decision: block`で振り返りを書かせる（§13） |

### `followUp`（after-bash / session-stop共通）

1. `inventory.dirtyTargets`に1件でもあれば`dirty`: pathを最大8件挙げて「commitすればWikiは更新される」と伝えるだけ
2. cleanなら`knowledge.updateInPlace`を`{ 'no-agent': true, json: true }`・`commit: true`で実行（構造更新。§7の0〜5と7〜8）
3. 残り0なら`committed`: rename-onlyや報告取り込みだけで完成した場合はhookがその場でcommitした旨（またはすでにHEADを説明している旨）を伝える
4. 残りがあれば`plan`: `plan.json`のbatch数と`finish`（`aidev sync wiki --no-agent`）を含む`planInstructions`を返す。「batchごとに`knowledge-builder`をsubagent起動（`adapter.subagentHint`でtoolごとの言い回し）→ 全部終わったら`finish` → まだ残りと言われたら再起動。Wiki pageを手で編集しない、manifest / inventoryに触らない」
5. 例外は`error`として文面に含める（hookは落とさない）

### tool adapter（`tools.HOOK_ADAPTERS`）

`hook.js`はtool idを見ず、adapterに出力の形と「subagentの起動の仕方」を委ねます。

| tool | 設定file | event名 | subagent内でhook | 備考 |
| --- | --- | --- | --- | --- |
| `claude` | `.claude/settings.json` | SessionStart / PreToolUse / PostToolUse / Stop | 動く | 実機検証済み。`hookSpecificOutput`形式、`stop_hook_active` |
| `copilot` | `.github/hooks/aidev.json` | sessionStart / preToolUse / postToolUse / agentStop | 動かない | `additionalContext` / `permissionDecision`をtop levelに置く。knowledge-builderは`.github/agents/`の定義で`.aidev/knowledge/**`に限定。未検証 |
| `codex` | `.codex/hooks.json` | SessionStart / PreToolUse / PostToolUse / Stop | 動く | claudeと同じ形。projectが`~/.codex/config.toml`で`trust_level = "trusted"`である必要。未検証 |
| `kiro` | `.kiro/agents/aidev.json` | agentSpawn / preToolUse / postToolUse / stop | 動かない | hooksはagent定義内なので`kiro-cli chat --agent aidev`で起動。`agentSpawn`のstdoutはraw textとしてcontextになるが`postToolUse`のstdoutは捨てられるため、指示はStop hookが担う。deny時はexit 2。`stop_hook_active`が無いのでkitのstop guardを使う。未検証 |

guard-writeはfail-closedです。payloadがJSONでない、policyが読めない、例外が出た、いずれもdenyを返します。Stop hookは利用者の端末でも動きますが、Wikiが遅れていなければ`{ok: true, skipped}`を返すだけです。

## 9. workflow: 開発の唯一の入口

利用者が開発に使うcommandは`aidev run|create|submit|list|remove … workflow`です（`aidev agent`は無い）。kitはframeworkで、同梱するagentは仕組みのもの（knowledge-builder、workflow-creator、agents-creator、permission-setting）だけです。開発作業をするagent（実装する、テストを書く、規約を書き出す…）、workflow、MCP serverはPKGのもので、`create workflow --describe`の中でworkflow-creatorがagents-creatorをsubagentとして起動して書きます。3つの役割が分かれます: kit開発者は実行するもの（runner、step種別、仕組みのagent / skill）の品質を持ち、PKGの責任者は「AIに何をさせるか」をYAMLに書いてPRでreviewし、実作業者は`aidev run workflow <name>`を実行して生成されたPRをreviewerに渡します。実作業者は成果物に責任を持ちません。

### 定義（`cli/lib/workflow.js`）

`.aidev/workflows/<name>/workflow.yaml`の1 fileです。実行logicはYAMLに書けません（`steps.js`、`commands` allowlist、`ctx.agent`は撤去）。`validateDefinition`が検証する項目:

| 項目 | 内容 |
| --- | --- |
| `name` | directory名と一致。`^[a-z0-9][a-z0-9-]{0,63}$` |
| `objective` | 必須。全agent stepのpromptに入る |
| `scope.writable` | 必須（`[]`可）。この workflow のagentが書けるglob。`ALWAYS_PROTECTED`は列挙できない |
| `agents` / `skills` | 名前のlist（任意）。stepで使うagentは自動で補完 |
| `tool` / `model` | 任意。`tool`はregistry、`model`は`assertModel` |
| `steps[]` | `agent`（`prompt`必須、`until`・`max_retries`（≤10、`until`があれば既定3）・`timeout_ms`任意）、`command`、`kind: pull-request`（`title`任意、最大1つ）のどれか1つ。`id`は`^[a-z0-9][a-z0-9-]{0,31}$` |
| `limits.max_minutes` | ≤60（既定60） |
| `cost.max_usd` | 必須 |

`until`と`command`は空白で分割してshellなしで実行します（`|&;<>`$"'\`を含むと拒否）。実行fileの解決は`tools.resolveCommand`（Windowsでは`where.exe`で`.cmd` shimを`cmd.exe /d /s /c`経由にする。`npm test`が動く理由）。

agentとskillは名前で解決します（`resolveAgent` / `resolveSkill`）: `.aidev/agents/<name>.md`・`.aidev/skills/<name>/SKILL.md`（PKG）→ `templates/claude/.claude/agents/`・`.claude/skills/`（kit checkout）。runnerはagent本文とskill本文を`definitionForPrompt`で1つにし、`runAgent({ definition })`でpromptの先頭に置きます（`--agent`は付けない）。名前でagentを選べないtoolでも同じ契約になります。

### 承認 = `origin/<hosting.tracking_branch>`との一致

`approve` commandも`approval.json`もありません。`approvalStatus`は`workflow.yaml`と、参照するPKG内のagent / skill（`reviewedFiles`）について、working fileと`git show origin/<branch>:<path>`（`git.showFile`、LF正規化）をbyte比較します。全て一致で`approved`、それ以外は`missing`（未submit / 未merge）、`changed`（編集済み）、`absent`。kit同梱のagent / skillはkitのversionで信頼し、比較しません。誰が承認したかはPR reviewerとgitのauthorが記録し、hostingのbranch policy（`.aidev/workflows/**`・`.aidev/agents/**`・`.aidev/skills/**`にrequired reviewer）が実体です。判定は最後にfetchした`origin/<branch>`で行うのでofflineでも動きます。

### commands（動詞先行）

利用者向けcommandは`aidev <動詞> [<object>] [<名前>]`です（D15）。開発の動詞は`run` / `create` / `submit` / `list` / `remove`、objectは`workflow`（`list`は`workflows` / `agents` / `skills`、`create` / `remove`は`agent` / `skill`も）。`bin/aidev.js`の`SUBCOMMANDS`がobjectを検査し、無い・違うobjectはmoduleに入る前にexit 1です。動詞modul（`create.js`等）は薄く、workflowの実装は`cli/commands/workflow.js`が持ちます。

- `create agent <name>` / `create skill <name>`: `.aidev/agents/<name>.md` / `.aidev/skills/<name>/SKILL.md`のtemplateを書く。agentの`--describe`は`agents-creator`を起動し、書いたあとfrontmatterの`name`を検証する
- `list agents` / `list skills`: PKG（`.aidev/`）とkit同梱を出所付きで一覧（同名はPKG優先）
- `remove workflow|agent|skill <name>`: fileを削除する（workflowは`runs/`ごと）。参照しているworkflowが残るagent / skillは拒否する

- `create workflow <name>`: template YAMLを書く（agentは`my-agent`のplaceholder）。`--describe "<text>"`は`workflow-creator` agent（`tools.agent`）に、参照できるagent / skillの一覧とschemaのtemplateを添えてYAMLを書かせる。足りないagent / skillはworkflow-creatorが`agents-creator`をsubagentで起動して`.aidev/agents/`・`.aidev/skills/`に書く。MCPが要るときはworkflow-creatorが`.mcp.json`（PKG所有）への追加案をfinal messageに書き、人が足す。終了後に`loadDefinition` + `resolveDependencies`で検証して結果を表示する。`create policy [--approve] [--force]`は`permission.configure`（policy候補の生成と配置）
- `submit workflow <name>`: 検証 → `aidev/workflow-<name>`へ`checkout -B` → `reviewedFiles`だけを`aidev: workflow <name>`でcommit → `push --set-upstream` → `azure-devops`ならPR作成（同じsource branchのactive PRがあれば本文更新）。`generic`は手動。`--no-push`
- `run workflow <name>`: 承認判定に失敗すればexit 1。`pull-request` stepがあればclean treeを要求し`aidev/<name>-<yyyymmddHHMM>`を`checkout -b`。stepを順に実行し、`runs/<id>/run.json`と`log.txt`（gitignore）に記録する。`--task` / `--task-file`は全agent stepのpromptに「Task for this run」として入る（外部入力。Work Item本文と同じdata）。`--max-minutes`は下げる方向にだけ効く。`--dry-run`は承認状態・file別の状態・scope・agentとtool・stepsを表示し、承認済みならexit 0
- `list workflows`: 各workflowの`approved` / `not on origin/main` / `changed since origin/main` / `invalid: …`と、同梱workflowの一覧

### runnerの動作

agent step: `stepPrompt`（workflow名・`objective`・task・step prompt・前回の`until`失敗の出力（末尾4000文字）・Rules（scope、commit禁止、報告））+ 参照文書 → `runAgent`（tool / modelは`workflow.yaml` > `tools.agents.<name>` > `tools.agent`。`env`に`AIDEV_WORKFLOW=<name>`。時間予算は`min(timeout_ms || DEFAULT_TIMEOUT_MS, 残り時間)`）。agentが失敗すれば停止。`until`があればcommandを実行し、exit 0で完了。失敗ならagentを再起動（`max_retries`回まで）、exit codeと出力（末尾2000文字）が前回と同じなら「同一失敗」で即停止。`command` step: 1回実行、exit 0以外で停止。`pull-request` step: `git add -A -- :(glob)<scope>…`でscopeだけをstage、変更が無ければskip、あれば run記録（workflow hash・run id・base SHA・承認ref・task）を本文にしてcommit → push → `azure-devops`ならPR作成（本文にagent runs・費用・step一覧）。`generic`は理由を残して手動。

安全弁: `limits.max_minutes`（≤60）、`max_retries`（≤10）、`cost.max_usd`必須（報告された`costUsd`の合計がこれに達したら次のagentを起動しない。claude以外は0）、同一失敗検知、shellなしcommand、`scope.writable`のみ書込可（hookが強制）。tokenは計測しません。

### 同梱しないもの

kitはworkflow・開発用agent・MCP serverを配布しません（framework-only）。PKGは`aidev create workflow <name> --describe`で自分のworkflowを作り、そこで必要になったagent / skillはagents-creatorが`.aidev/agents/`・`.aidev/skills/`に書き、MCP serverはPKGが自分の`.mcp.json`（kit管理外。`TOOL_CONFIG_GLOBS`にもprotectedにも無い）に用意します。

## 10. MCP

kitはMCP serverを起動しません（旧`aidev mcp azure-devops`と`templates/claude/.mcp.json`は2026-09-23に撤去）。`.mcp.json`はPKGの所有で、PKGが必要なserver（Azure DevOpsなど）を書き、認証情報は環境変数で渡します。kitのhostingとの通信（Wiki publishのPR、workflowのPR）は`cli/lib/ado.js`が直接REST APIで行い、MCPに依存しません。

## 11. update と version通知

`aidev update`はkit checkoutだけを進めます（`selfUpdate`: 未commit変更なし・`main` branch上を確認し、`origin/main`をfetchして`merge --ff-only`。divergeは拒否）。PKGには触れず、registryのcloneのうちlockの`kitCommit`が古いものを一覧して`aidev sync tools`を案内します。PKGへの適用（`aidev sync tools`）を分けているのは、teamの編集とのmergeやconflict解消に時間をかけられるようにするためです。

更新されたCLIは次回起動から使われます。`aidev.js`は`hook` / `update` / `uninstall`以外のcommandで`home.checkForUpdate`を呼び（`--json`と`AIDEV_NO_UPDATE_CHECK`で抑止）、kit checkoutの`origin/main`と比べて新しければ警告を出し、TTYなら「今updateするか」を尋ねて`update`を実行します。kit checkoutのHEADが進んだら、同じargvで新しいCLIを子processとして実行し（`AIDEV_NO_UPDATE_CHECK=1`を付けて再確認を防ぐ）、その終了codeで終わります。進まなければ現在のprocessで続けます。結果は`AIDEV_HOME/cache/update-check.json`に24時間cacheされ、確認失敗はcacheしません。

## 12. model解決

```text
対話session（Claude Code側）:
  managed settings > claude --model / ANTHROPIC_MODEL > .claude/settings.local.json
  > .claude/settings.json（kitが "sonnet" を配布）> ~/.claude/settings.json

CLI起動agent（aidev sync wiki, aidev run workflow）:
  tool:  --agent-tool / workflow.yaml tool
         > aidev.yaml tools.agents.<name>.tool > aidev.yaml tools.agent > tools.default[0]
         （tools.default に無い tool は assertToolEnabled が拒否）
  model: --agent-model / workflow.yaml model
         > aidev.yaml tools.agents.<name>.model > aidev.yaml tools.agent_model > DEFAULTS（sonnet）
  空文字は「model flag を渡さない」
```

同梱agentのfrontmatterは`model: inherit`で、具体modelを固定しません。

## 13. self-evolution（kit開発者向け）

利用者には存在しない機能です。判定の鍵は`AIDEV_HOME/developer.json`（`npm run evolve -- enable`）または`AIDEV_KIT_DEVELOPER=1`で、PKGに配布されるfileには何も無く、PKG側の設定にもありません。

1. **Stop hook**（`hook.js sessionStop`）: 開発者端末でのみ、`transcript_path`のJSONLを`summarizeTranscript`で集計（tool call数、tool error、`ai-dev-kit:`のdeny、入出力token、cache、経過時間）。`stop_hook_active`でなく、`.aidev/cache/evolution/<session_id>.md`が無く、閾値（`REFLECT_MIN_TOOL_CALLS` 30 / `REFLECT_MIN_OUTPUT_TOKENS` 20000）を超えていれば`{decision: "block", reason}`を返す。reasonは集計値と書式（事実 / 無駄と原因 / kit への提案 / 提案しないこと）と「promptや応答やdiffや秘密を書かない」規則を含む。同じsessionが自分の文脈で振り返りを書き、次のStopでfileを見て素通しする。1 session 1回。`--auto`で有効化した端末では、振り返りが揃った時点で`npm run evolve -- run`を1回だけdetachedで起動する（marker `<file>.evolve-launched`）。
2. **`npm run evolve -- run`**（`evolve.js`）: 開発者端末のみ。registryのPKGと現在のPKGから`.aidev/cache/evolution/*.md`を集め、kit checkoutの`git worktree add -b aidev/evolve-<yyyymmdd> <AIDEV_HOME>/cache/evolve/<date> main`で作業treeを作り、`cli/agents/evolution.md`の定義を**promptに前置**（`runAgent({ definition })`。kitには`.claude/agents/`が無いので`--agent`は使わない）して`evolution` agentを起動する。claudeには`--allowedTools`でRead/Glob/Grep/Edit/Write/Bash(git|npm|node|gh)を渡す。agentがtemplateを直し、`npm run check` / `docs:check`を通し、commitし、手元のtool（GitHub MCP / `gh` / Azure DevOps MCP）でPRを作る。CLIはPR作成先を判定しない（agentが`origin`に合うtoolを使う）。成功した振り返りは`done/`へ移す。worktreeは残し、削除commandを表示する。
3. `evolution` agent定義は`cli/agents/`に置き、`templates/`には含めない（PKGに配布しない）。

## 14. source references

- 配置: `cli/lib/layout.js`（`TOOL_CONFIG_GLOBS`を含む）、`cli/lib/home.js`
- tool adapter: `cli/lib/tools.js`、`cli/commands/agent.js`
- self-evolution: `scripts/evolve.js`（`npm run evolve`。CLI commandではない）、`cli/agents/evolution.md`、`cli/commands/hook.js`（`sessionStop`）、`cli/lib/home.js`（developer marker）
- tool config: `cli/lib/assets.js`（`templates/<tool>/`のtreeを`applyTemplates`で適用。3-way merge、conflict marker、lock schema 4、`inspectConfig`）、`cli/commands/apply.js`
- config / policy: `cli/lib/config.js`、`cli/lib/policy.js`、`cli/lib/paths.js`
- state（head / knowledge / tracking、inventoryとHEADの比較）: `cli/lib/state.js`、`cli/lib/inventory.js`（`compareWithTree`、`dirtyTargets`）、`cli/lib/git.js`
- lease: `cli/lib/leases.js`
- Wiki: `cli/lib/inventory.js`、`cli/lib/knowledge-scope.js`、`cli/lib/agent.js`、`cli/commands/knowledge.js`（`updateInPlace`、`writePlanFile`、`commitWiki`）
- publish（worktree、`aidev/wiki-<sha12>`、PR）: `cli/commands/knowledge.js`（`publish`）、`cli/lib/ado.js`
- hooks: `cli/commands/hook.js`、`cli/lib/tools.js`（`HOOK_ADAPTERS`）、`templates/claude/.claude/settings.json`、`templates/copilot/.github/hooks/aidev.json`、`templates/codex/.codex/hooks.json`、`templates/kiro/.kiro/agents/aidev.json`
- pipeline: `pipelines/azure-pipelines-check.yml`、`pipelines/azure-pipelines-wiki.yml`
- workflow: `cli/commands/workflow.js`
- update: `cli/commands/update.js`、`cli/bin/aidev.js`
