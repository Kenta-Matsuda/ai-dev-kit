# Architecture and internal behavior

この文書はai-dev-kit（PKG clone方式）の技術設計を、本体を保守する人向けに説明します。利用者向けの手順は`docs/user-guide/`を参照してください。

## 1. PKG clone方式

`aidev`は利用者自身のPKG git cloneの中で動きます。wrapper repositoryもsubmoduleもありません。kitがPKGへ追加するものはすべてそのPKG repositoryへcommitされ、チーム全員がgitで同じ設定・同じWikiを受け取ります。

```text
<pkg clone>/
├─ aidev.yaml                     PKG固有設定（schema v2）
├─ CLAUDE.md                      templates/claude から適用（kit配布、teamが編集可）
├─ .mcp.json                      templates/claude から適用（同上）
├─ .claude/                       templates/claude/.claude から適用（同上）
│  ├─ settings.json               hooks / deny / ask
│  ├─ agents/  skills/
│  └─ settings.local.json         個人設定。kit所有ではなくdrift検出から除外
├─ .github/  AGENTS.md  .kiro/    tools.default に copilot / codex / kiro があるときだけ（§2）
└─ .aidev/
   ├─ .gitignore                  CLIが書く。runtime stateをgitから外す
   ├─ policy.yaml                 承認済みpolicy（CLIだけが配置）
   ├─ policy.candidate.yaml       承認待ちの候補（一時）
   ├─ materialized.json           適用したtemplateとfileのhash record、未解消conflict（applyのmerge基準）
   ├─ ejected.json                aidev eject の marker（通常は存在しない）
   ├─ knowledge/                  LLM Wiki（manifest.json, inventory/, index.md, overview.md, pages）
   │  └─ .cache/                  agent plan、完了報告 done/（ignored）
   ├─ conventions/                開発規約（convention-builder が生成、teamがreviewしてcommit。index.md, coding.md, testing.md, review.md）
   ├─ workflows/<name>/           workflow.yaml, steps.js, approval.json（runs/ はignored）
   ├─ sync.lock                   sync lease（ignored）
   └─ cache/                      remote-check.json, sync-worktree/, agents/（prompt file）,
                                  evolution/<session>.md（kit開発者端末の振り返り）（ignored）
```

`.aidev/.gitignore`の内容は`layout.AIDEV_GITIGNORE`で固定です（`cache/`、`sync.lock`、`knowledge/.cache/`、`workflows/*/runs/`）。`init`、`apply`、`sync`（worktree内）が`ensureAidevGitignore`で書き、内容が違えば上書きします。

path名の正本は`cli/lib/layout.js`です。`KIT_MANAGED_GLOBS`（`aidev.yaml`、`.aidev/**`、全toolの`TOOL_CONFIG_GLOBS`: `.claude/**`、`CLAUDE.md`、`.mcp.json`、`.github/copilot-instructions.md`、`.github/agents/**`、`.github/skills/**`、`AGENTS.md`、`.kiro/steering/**`、`.kiro/agents/**`）に一致するpathはWikiのgeneration targetにもevidenceにもならず、PostToolUseのquality gateも走りません。`git.findRepoRoot`は`aidev.yaml`または`.aidev/`を持つdirectoryまで上へ辿り、無ければgit top-levelへfallbackします。

### 端末側: kit checkoutと`AIDEV_HOME`

| 場所 | 役割 |
| --- | --- |
| kit checkout（`installRoot`） | ai-dev-kit自身のclone。launcherが`cli/bin/aidev.js`を指す。`aidev update`が`origin/main`へfast-forwardする。templateの読み出し元 |
| launcher | `scripts/install.ps1`が`%LOCALAPPDATA%\ai-dev-kit\bin\aidev.cmd` / `.ps1`、`scripts/install.sh`が`~/.local/bin/aidev`を作る（`AIDEV_BIN_DIR`で変更可） |
| `AIDEV_HOME` | 既定はWindows `%LOCALAPPDATA%\ai-dev-kit`、POSIX `$XDG_DATA_HOME/ai-dev-kit`（未設定なら`~/.local/share/ai-dev-kit`）。`registry.json`、`cache/update-check.json`、kit開発者端末では`developer.json`と`cache/evolve/`（§13）を置く |

`registry.json`（`{schemaVersion: 1, packages: [{name, path, remote, kitCommit, registeredAt, updatedAt?}]}`）は`init`と`apply`が登録し、`eject`が削除します。`uninstall`は`registry.json`と`cache/`ごと消します（PKG側には触れず、kit所有fileを消す`git rm`を表示するだけ）。`update`はここに載っているcloneのうちlockの`kitCommit`が現在のkitと違うものを「`aidev apply`が必要」として一覧します（適用はしません）。

## 2. tool configのtemplate、apply、記録

### template → PKG

toolごとに`templates/<tool>/`があり、PKG rootにそのまま重なるtreeです（`tools.templateDir(id)`）。対応表はありません。

| tool | template tree（PKGでの位置と同じ） |
| --- | --- |
| `claude` | `templates/claude/.claude/**`、`templates/claude/CLAUDE.md`、`templates/claude/.mcp.json` |
| `copilot` | `templates/copilot/.github/copilot-instructions.md`、`.github/agents/<agent>.agent.md`、`.github/skills/<skill>/**` |
| `codex` | `templates/codex/AGENTS.md` |
| `kiro` | `templates/kiro/.kiro/steering/ai-dev-kit.md`、`.kiro/agents/<agent>.json` |

treeはkit保守者が手で揃えます（toolごとの差はtemplateから生成できないため）。claude以外のtreeは実機未検証で、fileの先頭にその旨を書いています。`layout.TOOL_CONFIG_GLOBS`がkit所有pathの正本で、`isKitManaged` / `ALWAYS_PROTECTED` / `settings.json`のdeny listはこれに従います。`.claude/settings.local.json`は個人設定で常に除外です（`STATIC_EXCLUDE`）。

### apply（`assets.applyTemplates`）

`aidev init`（初回、lockが無いとき、または`--force`）と`aidev apply`が呼びます。`aidev update`はkit checkoutを進めるだけでPKGには触れません。適用はcopyではなくmergeです。file単位の判定:

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
| `outdated` | lockの`kitCommit`が現在のkitと違う | 情報（「`aidev apply`で取り込める」） |

teamの編集はdriftではありません。`check`が止めるのは「merge前に誰かが見るべき状態」（未解消conflict、hooks欠落）だけです。

## 3. 編集権限の層

| 層 | 実体 | 位置付け |
| --- | --- | --- |
| 静的deny / ask | `.claude/settings.json` | Claude Code側の第一防御。`Edit(.claude/**)`等をdeny、`git push`・`aidev permission *`・`aidev eject`・`aidev uninstall`をask |
| 実行時guard | `aidev hook guard-write` | path、policy（`AIDEV_AGENT`によるagent単位の許可を含む）、整合性、leaseを評価して`permissionDecision`を返す |
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
5. `writable`一致 → allow `writable`（Wiki・workflows・`aidev.yaml`は`read_only: ["**"]`の内側にあるため、read_onlyより先に評価する）
6. agent単位の許可: `AIDEV_AGENT`（CLIが`agent.runAgent`で子processの環境に入れる。hookはそれを継承する）がpolicyの`agents.<name>`にあり、pathが`agents.<name>.writable`に一致 → `branch`があればcheckoutのbranchがそのglobに一致するときだけ allow `agent-writable`（不一致は deny `agent-branch`、detached HEADも不一致）
7. `read_only`一致 → deny `read-only`（理由にagent名と許可の有無を含める）
8. どれにも当たらない → allow `default`（既定policyは`read_only: ["**"]`なので、通常この分岐に到達するpathはない）

`decideMany`は複数targetのうち最初のdenyで確定します。

### 既定policy

```yaml
version: 1
protected:            # ALWAYS_PROTECTED + secrets_paths
  - ".claude/**"
  - "CLAUDE.md"
  - ".mcp.json"
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
  - ".aidev/conventions/**"
  - "aidev.yaml"
agents: {}            # 候補は空。teamが policy.yaml に直接書く（例: issue-to-pr: { writable: ["src/**"], branch: "aidev/issue-*" }）
```

`.aidev/conventions/**`が既定で`writable`なのは、convention-builder（`aidev agent run convention-builder`）が書く開発規約の置き場だからです。生成物はCLIが検査せず、teamが`git diff`でreviewしてcommitします（D14）。test-writerはPKGのtest pathを書くので、issue-to-prと同じく`agents.test-writer.writable`（必要なら`branch: "aidev/tests-*"`）をteamが足します。

候補は`permission.buildCandidate(config)`が`aidev.yaml`から機械生成します。agentは使いません。`--approve`は候補fileを読まず生成し直すので、teamの追加（`writable` / `agents`）は`.aidev/policy.yaml`を直接編集してPRでreviewします。policy fileが無い場合、`loadPolicy`は上記と同じ内容の`_fallback: true`を返します（未初期化repoが無防備にならない）。

### Bash targetの抽出

`extractBashTargets`はredirection（`>`、`>>`）と既知の書込command（`rm mv cp tee truncate install shred dd chmod chown ln mkdir rmdir touch sed -i patch`）のoperandを拾います。sandboxではなく、明らかな回避を捕まえる補助です。targetが1つも取れなければallow（「no filesystem target identified」）になります。

## 4. 3つのSHA

`state.computeState(repoRoot, config, { checkRemote, force })`が返す3値です。

| 値 | 実体 | 意味 |
| --- | --- | --- |
| `trackingSha` | `origin/<tracking_branch>`の先端（remote `ls-remote`、不可なら手元のremote-tracking ref） | Wikiが次に説明すべきcode |
| `baseSha` | `merge-base(HEAD, origin/<tracking_branch>)`。remote-tracking refが無ければHEAD | 今の作業が立脚するtracking commit |
| `knowledgeSha` | `.aidev/knowledge/manifest.json`の`knowledgeSha` | Wikiが説明するcommit |

feature branch上ではHEADとtracking branchが違うのが正常なので、整合性は`HEAD == knowledgeSha`ではなく「Wikiは今の作業の土台を説明しているか」で判定します。比較は**source treeの差分**です。`state.sourceChanged(repoRoot, a, b)`は`git diff --quiet a b -- . :(exclude)<kit-managed>`で、kit管理path（`KIT_MANAGED_GLOBS`: `aidev.yaml`、`.aidev`、全toolの設定file）を除いた変更の有無を返します。Wikiを追加しただけのcommitやkit更新commitは「codeが動いた」と数えません。commitが手元に無い場合は「変更あり」に倒します。

### severity（判定順）

| 条件 | severity | message要旨 |
| --- | --- | --- |
| manifestが無い | ERROR | Wiki未生成、`knowledge build` |
| HEADが解決できない | ERROR | commitが無い |
| manifestに有効な`knowledgeSha`が無い | ERROR | manifest破損 |
| `knowledgeSha`のcommitが手元に無い | WARN | fetch / branch確認 / sync |
| `sourceChanged(knowledgeSha, baseSha)` | WARN | 土台のcodeが変わった、`aidev sync` |
| `checkpoint.pendingPaths`が残っている | WARN | prose未完了、`knowledge build` |
| remote確認を要求したが到達不能 | UNKNOWN | local状態は整合 |
| 手元の`origin/<branch>`が`baseSha`より先で、source差分あり | WARN | tracking branchが先行（fetch済み） |
| remoteの先端が手元のremote-tracking refと違う | WARN | 未fetchの新commit |
| それ以外 | OK | Wikiは土台を説明している |

ERRORは**構造破損のみ**です。PreToolUse guardは`checkRemote: false`で判定するため、networkがERRORを作ることはありません。`formatSummary`は`[ai-dev-kit] base=… knowledge=… tracking=…`の1行とicon付きmessageを返し、SessionStart hookと`status`が表示します。

remote確認は`git ls-remote --heads`（local refを変更しない）を`sync.remote_check_timeout_ms`で打ち切り、結果を`.aidev/cache/remote-check.json`に`sync.remote_check_ttl_minutes`だけcacheします。`force: true`（`doctor`、`sync --check-only`）はcacheを無視します。

### `aidev check`の変換

`check`は`status.inspect`と同じ検査を行い、tool config（record欠落・未解消conflict・kit hooks欠落 → exit 2）→ policy（exit 3）→ Wiki（exit 4）の順で最初の問題のcodeを返します。exit 4はERROR severity、inventory不整合（同じpageに異なるhash）、期限切れsync leaseです。`--strict`は他に問題が無いときWARNをexit 2へ昇格します。`.aidev/ejected.json`がある、または`aidev.yaml`が無いrepositoryはexit 0です。

## 5. lease

leaseはsync leaseの1種類だけです（work leaseは0.5.0で撤去）。fileは`ALWAYS_PROTECTED`なので、agentが自分でleaseを作る・延長することはできません。`evaluateLease`は`acquiredAt + ttlMinutes`で期限を判定し、壊れた記録は無効扱いです。

### sync lease（`.aidev/sync.lock`）

```json
{ "schemaVersion": 1, "kind": "sync", "targetSha": "…", "originalSha": "…",
  "taskId": null, "acquiredAt": "…", "ttlMinutes": 120, "pid": 12345 }
```

`acquireSyncLease`は有効なleaseがあれば拒否し、期限切れでも黙って引き継がず`--resume` / `--abort`を案内します（`force`でのみ上書き）。保持者は次の2つです。

- `aidev sync`: worktree作成から後片付けまで保持し、成功時に解放、失敗時は残す
- `aidev knowledge build`: 状態がERRORかつWikiが存在するとき、inventory/manifestを書く間だけ取得して即解放する。ERROR状態で`knowledge/**`を書ける唯一の経路がsync leaseなので、buildが自分で取らないとsyncしか出口が無くなる（自己deadlock）。agent起動はlease解放後、manifestが`targetSha`へ進んでWARN/OKになってから行う

sync leaseがguardで効くのは、状態がERRORのときだけです（§3の第4段）。

PKG sourceへのagentの書き込みは、teamが`.aidev/policy.yaml`に`agents.<name>.writable`（CLIが起動したそのagentだけ。任意で`branch`）か`writable`（全員）を書くことで許可します。一時的な許可（TTL付きのwork lease）は再導入しません。

## 6. Wiki: manifest、inventory、evidence、agent

LLM Wikiは正本ではなくPKG sourceから再生成できる派生情報です。CLIとagentの責務を分けます。

| 担当 | 責務 |
| --- | --- |
| CLI | generation target走査、evidence走査とfingerprint、mask、blob hash diff、inventory shard、manifest、checkpoint、page hash、agentのbatch起動、完了報告の取り込み、orphan page削除 |
| knowledge-builder | evidenceを調査してprose pageと`index.md` / `overview.md`を書き、対象ごとに完了報告を残す。manifest / inventoryは書かない |

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

`kitCommit`は`knowledge build`も`sync`もkit checkoutのHEAD（Wikiを生成したkitの版）です。`state.knowledgeSha`は`knowledgeSha`が無ければ`targetSha`も読みますが、書き手は常に`knowledgeSha`です。

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

recordは`path`順にsortし、`knowledge.inventory_shard_size`件ごとに`00.json`, `01.json`…へ分割します。`diffInventory`は旧recordと新scanをpathとblobで突き合わせ、`added` / `modified` / `removed` / `renamed`（同一blob・別path、prose再生成不要）/ `unchanged`を返します。旧commit objectが無くても（GC、force-push後でも）差分が取れるのがblob方式の理由です。`selfHashes`はpage手編集の検出に使い、`detectHandEdits`が`modified` / `missing`を返します。`knowledge build`と`sync`は`modified`があると`--force`なしで停止します。

`removed`だけが参照していたpageは`orphanedPages`で求め、`removeOrphanedPages`が`.aidev/knowledge/`内に限って削除し、親`index.md`を`staleIndexes`へ記録します。`index.md`はorphanにしません。orphan削除は現在`sync`だけが行います。

### batch実行と完了報告

`agent.runWikiAgent`は1 processに全targetを渡しません。単一runは終わるまで進捗が見えず、timeoutで全成果を失い、headless実行ではBashが拒否されるためagentが`selfHashes`を計算できないからです。

1. **survey run**（`overview.md`が無い、全件生成、または`--survey`。`--no-survey`で抑止）: generation targetなしでrepositoryを地図化し、`.aidev/knowledge/overview.md`と`index.md`を書く。報告は`__survey__.json`で、両pageを含まなければ失敗
2. **batch run**: `knowledge.agent_batch_size`（既定20）件ずつ、1 batch = 1 process、それぞれ`agent_timeout_ms`（既定30分）の予算。人間向け出力では`batch i/n`、15秒ごとの経過表示、完了batchの平均時間からの残り時間目安を出す
3. agentは対象を1つ書き終えるたびに`.aidev/knowledge/.cache/done/<path with / → __>.json`（`{target, targetSha, pages, note?}`）を書く
4. 各run終了後、CLIが`inventory.applyCompletions`で報告を読み、pageが`.aidev/knowledge/`内の実在fileであることを検証してsha256を計算し、recordの`pages` / `selfHashes`を置き換え、共有pageのhashを全recordへ揃え、`checkpoint.pendingPaths`から除く。取り込んだ報告と拒否した報告は削除する。manifestが無い・checkpointが無い・`knowledgeSha`が`targetSha`と違う場合は報告を残したまま`manifestInvalid`を返す
5. batchの全対象が報告済みなら次へ。timeout、process失敗、報告不足（exit 0だが未報告あり）なら停止する。完了分はすでにcheckpointに反映済み

`knowledge build`と`sync`は開始時にも`done/`に残っている報告を取り込むため、Ctrl-Cで止めた実行の成果も次回へ引き継がれます。promptが8 KiBを超える場合、planは`.aidev/knowledge/.cache/agent-task-<sha12>-<label>.json`（`schemaVersion: 2`、`mode`、`generationTargets`、`evidence.paths`）へ書き、promptはそのfileを指します。

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
- `runAgent`は子processの環境に`AIDEV_AGENT=<name>`を入れる。toolが起動するhookはそれを継承し、guard-writeがpolicyの`agents.<name>`を適用する
- `prompt: 'file'`のtool（copilot / codex / kiro）はpromptを`.aidev/cache/agents/<tool>-<label>-<pid>-<time>.md`へ書き、argvには`filePointerPrompt(rel)`の1文だけを載せる。`namedAgents: false`のtool（codex）はそのfileの先頭に同梱agent定義の本文を置く。argv: copilot `-p <pointer> --allow-all-tools [--agent <name>] [--model <m>]`、codex `exec --sandbox workspace-write [--model <m>] <pointer>`、kiro `chat --no-interactive --trust-all-tools [--agent <name>] [--model <m>] <pointer>`。claude以外は実機未検証（`verified: false`）で、`aidev agent run --dry-run`がcommand lineを表示する
- 結果はadapterの`parse()`が`{ok, result, costUsd, sessionId, permissionDenials, reason}`へ正規化する。claudeはJSON契約、他はexit codeとstdout本文
- timeoutではWindowsで`taskkill /T /F`によりprocess tree全体を止め、それ以外はSIGTERM→5秒後SIGKILL
- 起動失敗（ENOENT）は`skipped`として構造化結果は保持したまま報告し、例外にはしない

### 参照文書（`aidev.yaml`の`references`）

`aidev agent run`と`ctx.agent()`は、`agent.resolveReferences(repoRoot, config)`が返す「# Reference documents」sectionをtaskの末尾に付けます。topicごとのfile一覧（directoryは再帰列挙）と、渡せなかったpath（無い、`secrets_paths`に一致、text fileが無いdirectory）の一覧です。中身は渡さず、pathだけを渡してagentに読ませます（agentの読み取りはpolicyとhookが検査するため）。Excel / Word / PDFは`validateConfig`が拒否し、textへの書き出しを求めます。詳細は`configuration-reference.md`の`references`。

## 7. `aidev sync`

利用者のcheckoutには触れません。処理はすべて一時worktreeで行い、結果は`aidev/wiki-<sha12>` branchのcommitとPRとして共有されます。

```text
 1. origin/<tracking_branch> をfetchし、先端（または --to で指定した到達可能なcommit）をtargetに決定
 2. targetにcommitされたWikiがtargetのsourceを既に説明している → no-op（"git pull"を案内）
    手元のWikiのknowledgeShaとtargetにsource差分が無い → no-op
 3. change set算出（dry-runは手元のWikiを"before"にして表示して終了）
 4. sync leaseを取得（--resume / --force で既存leaseを引き継ぐ）
 5. .aidev/cache/sync-worktree/ にtargetでdetached worktreeを作る（中断時のworktreeは同一SHAなら再利用）
 6. worktree内のWikiを"before"として change set を再計算。手編集pageがあれば --force なしで停止
 7. worktree内でinventory shard / manifest を書き直し、orphan pageを削除、.aidev/.gitignoreを確保
 8. worktree内で computeState（ERRORなら失敗）
 9. --no-agent でなければ worktree を cwd として knowledge-builder を batch 起動し、完了報告を取り込む
10. worktree内で aidev/wiki-<sha12> を checkout -B し、.aidev/knowledge と .aidev/.gitignore だけを stage して commit
11. --no-pr でなければ push --force-with-lease --set-upstream origin <branch>
12. sync.auto_pr が true、hosting が azure-devops、auth env が設定済みならPRを作成/更新。それ以外は手動作成を案内
13. worktreeを削除し、leaseを解放
```

失敗（例外）時はleaseとworktreeを残し、`--resume`か`--abort`を案内します。`--abort`はworktreeを削除してleaseを解放するだけで、checkoutは変更しません。`--check-only`はremote cacheを無視して状態を表示します。

### target SHAの制約

agentの作業branch先端をそのままsync対象にしません。squash、rebase、reviewerの追加commitでmerge後SHAが変わるためです。`--to`はfetch済みtracking branchから到達可能なcommitだけを受け付けます。`--resume`時にleaseの`targetSha`とtracking先端が違えば`--resume --to <leaseのSHA>`か`--abort`を要求します。

### 識別子とPR

- operation key: `hosting.type`、organization、project、repository、target SHAのsha256先頭32桁
- sync stream ID: 同じ材料でtarget SHAの代わりに`tracking_branch`
- PR descriptionに`<!-- aidev:sync-stream <id> -->`を埋め、同じstreamのopen PRを検索する。同じsource branchならdescriptionを更新、branchが変わっていれば新PRを作り旧PRへ「Superseded」注記を追記する。closeは人間が行う
- PRのtarget branchは`sync.pr.target_branch`、reviewerは`sync.pr.reviewers`

### 主要scenario

| scenario | 処理 |
| --- | --- |
| tracking branchへのmerge / direct push | `status`がWARN。`sync`が同じ経路で収束 |
| force-push / 旧commitがGC済み | inventory blobとtarget treeを比較するため影響なし |
| renameのみ | 同一blobで`renamed`、LLM再生成なし |
| generation target外のsource変更 | evidence fingerprint差分で全target再queue |
| 削除 | orphan page削除、親indexを`staleIndexes`へ |
| kit更新やWiki追加だけのcommit | `sourceChanged`が偽なのでno-op |
| Wiki手編集 | `selfHashes`差分で停止、`--force`で破棄 |
| sync途中の失敗 | lease / worktreeを残し`--resume` / `--abort` |
| 同じtargetの再実行 | worktree再利用、同一branchへ`--force-with-lease` |
| open PR中に新target | 新branch・新PR、旧PRへsuperseded注記 |
| tracking branchに既にWikiがある | no-op、`git pull`を案内 |

## 8. hooks

同梱`.claude/settings.json`は次のeventを`aidev hook <name>`（文字列形式、PATH上の`aidev`）へ接続します。`CLAUDE_PROJECT_DIR`が設定されていればrepo root探索の起点にします。

| event | matcher | 責務 |
| --- | --- | --- |
| SessionStart | — | `formatSummary`とsync leaseの状態を`additionalContext`で返す |
| PreToolUse | `Write|Edit|MultiEdit|NotebookEdit|Bash` | `targetsFrom`でpathを集め`policy.decideMany`。deny理由を`permissionDecisionReason`へ |
| PostToolUse | `Write|Edit|MultiEdit` | `quality_gates`のcommandをrepo rootで実行。編集対象がkit管理pathだけなら`skipped` |
| Stop | — | kit開発者端末（`home.readDeveloper`）でだけ動く。transcriptを集計し、閾値（tool call 30回 / 出力20k tokens）を超えた未振り返りのsessionに`decision: block`で振り返り（`.aidev/cache/evolution/<session>.md`）を書かせる。それ以外は何もしない（§13 self-evolution） |

guard-writeはfail-closedです。payloadがJSONでない、policyが読めない、例外が出た、いずれもdenyを返します（exit 0のまま）。hookはnetworkに触れず、`session-start`だけTTL cacheと3秒timeoutのremote確認を行います。

Stop hookはWiki更新を起動しません。利用者の端末では`{ok: true, skipped}`を返すだけで、fileも書きません。

## 9. workflow runner

`workflow new <name>`は`.aidev/workflows/<name>/workflow.yaml`と`steps.js`を固定templateから生成します（`workflow-creator` agentは起動しません）。人間がdiffをreviewし、`approve`が両fileのcontent hash（改行をLFに正規化）を`approval.json`へ記録します。`run`はhash一致を要求し、1 byteでも変われば再承認が必要です。

強制する安全弁: 最大iteration（10）、最大分（60）、同一失敗の連続回数（3）、command basename allowlist、`runs/<id>/log.txt`と`checkpoint.json`。定義で上限を下げることはできますが上げられません。`--resume`は同じhashの未完了runからiteration数を引き継ぎます。`cost.max_tokens` / `max_usd`は必須項目です。tokenは計測しません。USDはtoolが報告した`costUsd`（claudeのみ）を合算し、`max_usd`に達すると次の`ctx.agent`は`budgetExhausted`で拒否されloopを止めます。`approvals.before_pr` / `before_destructive`はmetadataで、runnerはPRを作らず対話承認も行いません。

`steps.js`には`ctx.agent(prompt, { name?, tool?, model?, timeoutMs? })`が渡されます。既定は`workflow.yaml`の`agent:`（`validateDefinition`が`name`をAGENT_NAME_RE、`tool`をregistry、`model`を`assertModel`、`timeout_ms`を10000〜7200000で検証）、省略分は`config.agentSettings(config, name)`（`tools.agents.<name>` → `tools.agent` / `tools.agent_model`）です。toolは`tools.default`にあるものだけ（`assertToolEnabled`）。1回の起動は`min(timeout_ms, deadline - now)`で打ち切り、結果objectは`agent.runAgent`の戻りを`{ok, result, reason, costUsd, durationMs, timedOut, skipped, tool, agent, model}`へ整えます。失敗はthrowせず返します。`checkpoint.json`に`agentRuns`と`costUsd`を記録します。

## 10. Azure DevOps MCP

`templates/claude/.mcp.json`は`aidev mcp azure-devops`だけを起動します。CLIは`aidev.yaml`を読み、`npx -y @azure-devops/mcp@2.10.0 <organization> --authentication pat`をstdioで起動します。`ADO_MCP_DEFAULT_PROJECT`にproject、`PERSONAL_ACCESS_TOKEN`に`aidev:<pat>`のbase64を子processの環境だけで渡し、argvにも出力にも載せません。`hosting.type`が`generic`のときは`config.azure_devops`が`null`なので起動できません。

## 11. update と version通知

`aidev update`はkit checkoutだけを進めます（`selfUpdate`: 未commit変更なし・`main` branch上を確認し、`origin/main`をfetchして`merge --ff-only`。divergeは拒否）。PKGには触れず、registryのcloneのうちlockの`kitCommit`が古いものを一覧して`aidev apply`を案内します。PKGへの適用（`aidev apply`）を分けているのは、teamの編集とのmergeやconflict解消に時間をかけられるようにするためです。

更新されたCLIは次回起動から使われます。`aidev.js`は`hook` / `mcp` / `update` / `uninstall`以外のcommandで`home.checkForUpdate`を呼び（`--json`と`AIDEV_NO_UPDATE_CHECK`で抑止）、kit checkoutの`origin/main`と比べて新しければ警告を出し、TTYなら「今updateするか」を尋ねて`update`を実行します。kit checkoutのHEADが進んだら、同じargvで新しいCLIを子processとして実行し（`AIDEV_NO_UPDATE_CHECK=1`を付けて再確認を防ぐ）、その終了codeで終わります。進まなければ現在のprocessで続けます。結果は`AIDEV_HOME/cache/update-check.json`に24時間cacheされ、確認失敗はcacheしません。

## 12. model解決

```text
対話session（Claude Code側）:
  managed settings > claude --model / ANTHROPIC_MODEL > .claude/settings.local.json
  > .claude/settings.json（kitが "sonnet" を配布）> ~/.claude/settings.json

CLI起動agent（aidev knowledge build, aidev sync, aidev agent run, workflow ctx.agent）:
  tool:  --agent-tool / --tool / workflow agent.tool
         > aidev.yaml tools.agents.<name>.tool > aidev.yaml tools.agent > tools.default[0]
         （tools.default に無い tool は assertToolEnabled が拒否）
  model: --agent-model / --model / workflow agent.model
         > aidev.yaml tools.agents.<name>.model > aidev.yaml tools.agent_model > DEFAULTS（sonnet）
  空文字は「model flag を渡さない」
```

同梱agentのfrontmatterは`model: inherit`で、具体modelを固定しません。

## 13. self-evolution（kit開発者向け）

利用者には存在しない機能です。判定の鍵は`AIDEV_HOME/developer.json`（`aidev evolve enable`）または`AIDEV_KIT_DEVELOPER=1`で、PKGに配布されるfileには何も無く、PKG側の設定にもありません。

1. **Stop hook**（`hook.js sessionStop`）: 開発者端末でのみ、`transcript_path`のJSONLを`summarizeTranscript`で集計（tool call数、tool error、`ai-dev-kit:`のdeny、入出力token、cache、経過時間）。`stop_hook_active`でなく、`.aidev/cache/evolution/<session_id>.md`が無く、閾値（`REFLECT_MIN_TOOL_CALLS` 30 / `REFLECT_MIN_OUTPUT_TOKENS` 20000）を超えていれば`{decision: "block", reason}`を返す。reasonは集計値と書式（事実 / 無駄と原因 / kit への提案 / 提案しないこと）と「promptや応答やdiffや秘密を書かない」規則を含む。同じsessionが自分の文脈で振り返りを書き、次のStopでfileを見て素通しする。1 session 1回。`--auto`で有効化した端末では、振り返りが揃った時点で`aidev evolve run`を1回だけdetachedで起動する（marker `<file>.evolve-launched`）。
2. **`aidev evolve run`**（`evolve.js`）: 開発者端末のみ。registryのPKGと現在のPKGから`.aidev/cache/evolution/*.md`を集め、kit checkoutの`git worktree add -b aidev/evolve-<yyyymmdd> <AIDEV_HOME>/cache/evolve/<date> main`で作業treeを作り、`cli/agents/evolution.md`の定義を**promptに前置**（`runAgent({ definition })`。kitには`.claude/agents/`が無いので`--agent`は使わない）して`evolution` agentを起動する。claudeには`--allowedTools`でRead/Glob/Grep/Edit/Write/Bash(git|npm|node|gh)を渡す。agentがtemplateを直し、`npm run check` / `docs:check`を通し、commitし、手元のtool（GitHub MCP / `gh` / Azure DevOps MCP）でPRを作る。CLIはPR作成先を判定しない（agentが`origin`に合うtoolを使う）。成功した振り返りは`done/`へ移す。worktreeは残し、削除commandを表示する。
3. `evolution` agent定義は`cli/agents/`に置き、`templates/`には含めない（PKGに配布しない）。

## 14. source references

- 配置: `cli/lib/layout.js`（`TOOL_CONFIG_GLOBS`を含む）、`cli/lib/home.js`
- tool adapter: `cli/lib/tools.js`、`cli/commands/agent.js`
- self-evolution: `cli/commands/evolve.js`、`cli/agents/evolution.md`、`cli/commands/hook.js`（`sessionStop`）、`cli/lib/home.js`（developer marker）
- tool config: `cli/lib/assets.js`（`templates/<tool>/`のtreeを`applyTemplates`で適用。3-way merge、conflict marker、lock schema 4、`inspectConfig`）、`cli/commands/apply.js`
- config / policy: `cli/lib/config.js`、`cli/lib/policy.js`、`cli/lib/paths.js`
- state: `cli/lib/state.js`、`cli/lib/git.js`
- lease: `cli/lib/leases.js`
- Wiki: `cli/lib/inventory.js`、`cli/lib/knowledge-scope.js`、`cli/lib/agent.js`、`cli/commands/knowledge.js`
- sync: `cli/commands/sync.js`、`cli/lib/ado.js`
- hooks: `cli/commands/hook.js`、`templates/claude/.claude/settings.json`
- workflow: `cli/commands/workflow.js`
- MCP: `cli/commands/mcp.js`、`templates/claude/.mcp.json`
- update: `cli/commands/update.js`、`cli/bin/aidev.js`
