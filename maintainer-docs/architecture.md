# Architecture and internal behavior

この文書はai-dev-kit本体の技術設計を説明します。利用者がPKGへ導入する手順は[ルートREADME](../README.md)を参照してください。

## 1. wrapper repository方式

ai-dev-kitは対象PKGへ直接設定をコピーするのではなく、中央kitをcloneしたwrapper repositoryをAI作業のrootにします。

```text
wrapper repository
├─ src/                    PKG git submodule
├─ .claude/                kit templateから実体化したClaude Code設定
├─ CLAUDE.md               kit static asset
├─ .mcp.json               kit static asset
├─ aidev.yaml              wrapper固有設定
├─ .aidev/policy.yaml      wrapper固有の承認済みpolicy
├─ .aidev-lock             static asset hashとkit commit
└─ knowledge/              srcを説明する派生Wiki
```

この分離により、PKG repositoryへAI環境や生成Wikiを混在させず、wrapper PRでsubmodule pointerとWikiを同時にレビューできます。

中央kitのremoteは`upstream`、PKG固有wrapperは`origin`として保持します。`aidev update`はupstreamからkit管理対象を取り込み、`aidev sync`はoriginへ同期branchをpushします。

## 2. static assetと実行時解決

### static asset

同じkit commitを適用したwrapperで、次のファイルはbyte-identicalであることを目標にします。

- `.claude/**`
- `CLAUDE.md`
- `.mcp.json`

`.claude/**`の正本は`templates/claude-assets/**`です。`aidev init`と`aidev update`が実体化します。`CLAUDE.md`と`.mcp.json`はclone時から存在します。

`.aidev-lock`はkit commitとstatic fileごとのSHA-256を保持します。`aidev check`は実ファイルとlockを比較し、変更・欠落をdriftとしてexit 2にします。個人用`.claude/settings.local.json`はstatic assetとdrift検出から除外します。

wrapperでstatic assetを直接変更せず、変更は中央kitへ戻します。`update --force`はローカル差分を捨てる復旧手段であり、通常更新の前提ではありません。

### 実行時解決

staticな`.claude/settings.json`や`.mcp.json`へPKG固有値を埋め込みません。

- hooksは`aidev hook <name>`だけを呼び、`aidev.yaml`と`.aidev/policy.yaml`を実行時に読む
- MCP設定は`aidev mcp azure-devops`だけを起動し、organization/projectを`aidev.yaml`、PATを環境変数から読む
- prose agentのmodelは`aidev.yaml`とCLI flagから解決する

この境界により、kit assetの完全性確認を単純化しながらwrapper固有設定をgit reviewできます。

## 3. 編集権限の層

AIへの指示文だけをセキュリティ境界にしません。

| 層 | 実体 | 位置付け |
| --- | --- | --- |
| 静的deny | `.claude/settings.json` | Claude Code側の第一防御。個人上書き可能 |
| 実行時guard | `aidev hook guard-write` | path、policy、整合性、leaseを評価 |
| 行動指示 | `CLAUDE.md` | 補助。強制境界ではない |
| 認証scope | PAT/OAuth権限 | server側で高い強制力を持つ |
| CI / branch policy | `aidev check`、必須review | マージ前の最終防御 |

policy candidateは`aidev.yaml`から機械生成します。agentは使いません。

```yaml
version: 1
protected:
  - ".claude/**"
  - "CLAUDE.md"
  - ".mcp.json"
  - ".aidev/policy.yaml"
  - ".aidev/leases/**"
  - ".aidev/sync.lock"
  - ".aidev-lock"
  - ".aidev-ejected"
read_only:
  - "src/**"
writable_during_sync:
  - "knowledge/**"
writable:
  - "knowledge/**"
  - "workflows/**"
  - "docs/**"
```

`secrets_paths`も`protected`へ追加されます。`ALWAYS_PROTECTED`はpolicy fileから項目を削除してもvalidatorが再付与します。

Bashは任意processを起動でき、command textから全書込先を完全には抽出できません。guardはsandboxではなく、server側制御と併用する補助防御です。

## 4. 3つのSHA

Wikiが現在のソースを説明しているか、次の3値で判定します。

| 値 | 実体 | 意味 |
| --- | --- | --- |
| `remoteSha` | PKG `origin/<tracking_branch>`の先端 | 追従候補となるsource of truth |
| `submoduleSha` | wrapperの`src` worktree / gitlink | 手元でAIが読むコード |
| `knowledgeSha` | `knowledge/manifest.json` | Wikiのstructured inventoryが説明するcommit |

### 状態判定

| 条件 | severity | 動作 |
| --- | --- | --- |
| 3つが一致 | OK | 通常動作 |
| `remoteSha != submoduleSha`かつ`submoduleSha == knowledgeSha` | WARN | 手元は内部整合。作業継続可能、syncを案内 |
| remote取得不能かつlocal 2値が一致 | INFO/WARN | cacheと確認時刻を表示し、local作業継続 |
| `submoduleSha != knowledgeSha` | ERROR | check exit 4、通常書込みを停止 |
| 3SHA一致だが`pendingPaths`あり | WARN | structured stateは一致。prose未完了 |

`check --strict`はremote aheadやpending proseなどのwarningもexit 2へ昇格します。

SessionStartではlocal比較を先に行い、remote確認にはtimeoutとTTL cacheを使います。offlineを理由にlocal作業を無条件停止しません。

## 5. sync lease

syncは、Wikiを再生成する前に`src`を新しいcommitへcheckoutする必要があります。その瞬間から`submoduleSha != knowledgeSha`となるため、単純な「不一致なら全書込deny」ではWikiを直せず自己deadlockします。

そこで、bump前に`.aidev/sync.lock`を取得します。主な記録は次です。

- `targetSha`
- `originalSha`
- operation/task識別子
- 取得時刻
- TTL

guardの考え方は次のとおりです。

| 状態 | 許可 |
| --- | --- |
| `submoduleSha == knowledgeSha` | 通常policy |
| SHA不一致かつ有効sync lease | syncが必要とする`knowledge/**`のみ例外許可 |
| SHA不一致かつleaseなし・期限切れ | 書込みdeny。`sync --resume`か`--abort`を案内 |

成功時はleaseを解放します。失敗時は半適用状態を隠さないためleaseを残します。`--abort`は記録された`originalSha`へ戻し、leaseを解放します。期限切れleaseを暗黙に引き継ぎません。

## 6. `aidev sync`の処理

```text
1. src/origin/<tracking_branch> をfetch
2. branch先端、またはそこから到達可能な --to SHAをtargetに決定
3. old inventoryとtarget treeからchange setを算出
4. sync leaseを取得
5. srcをtargetへdetached checkout
6. inventory shardとmanifestを更新し、orphan pageを削除
7. local 3SHAとstatic driftを検査
8. leaseを解放
9. --agent指定時だけknowledge-builderを起動
10. srcとknowledgeだけをcommitし、originへsync branchをpush
11. PATと設定が揃えばAzure DevOps wrapper PRを作成
```

prose agentをlease解放後に起動するのは、数分かかるsubprocessが全syncをblockしないようにするためです。この時点でmanifestの`knowledgeSha`はtargetへ進んでおり、pending proseはwarningとして表現します。

### target SHAの制約

agentの作業branch先端をそのままsync対象にしません。squash、rebase、reviewerの追加commit、複数PRの競合でmerge後SHAが変わるためです。syncはfetch済みtracking branchから到達可能なcommitだけを受け付けます。

### operationとPR

- operation keyはPKG repository、target SHA、wrapper repository等に基づくhash
- sync stream IDはPKG repository、tracking branch、wrapper repository等に基づくhash
- branch名は`ai/sync-<targetSha先頭12文字>`
- 同じstream・同じbranchのopen PRはdescriptionを更新
- 新targetでbranchが変わる場合は新PRを作り、旧PRへsuperseded注記を追加
- PRのcloseとmergeは自動化しない

PAT、`wrapper_repository`、`sync.auto_pr`、push権限のいずれかが欠ける場合、sync結果はworktreeまたはlocal branchに残ります。

## 7. knowledge manifestとinventory

LLM Wikiは正本ではなく、`src`から再生成できる派生情報です。CLIとagentの責務を分けます。

| 担当 | 責務 |
| --- | --- |
| CLI | generation-target走査、evidence走査、mask、blob hash、diff/fingerprint、inventory shard、manifest、checkpoint |
| knowledge-builder | evidence全体からsourceを理解・検証し、prose page、index、page hash、pending targetを消化 |

### manifest schema v2の例

```json
{
  "schemaVersion": 2,
  "knowledgeSha": "9f2c1ab...",
  "kitCommit": "3d7e40b...",
  "generatedAt": "2026-09-14T11:02:00Z",
  "inventoryShards": ["inventory/00.json"],
  "stats": {
    "files": 55,
    "pages": 42,
    "maskedFiles": 0,
    "evidenceFiles": 3184
  },
  "evidence": {
    "include": ["src/**"],
    "exclude": ["**/node_modules/**", "**/generated/**"],
    "trackedFiles": 3184,
    "supportingFiles": 3129,
    "fingerprint": "sha256:7788..."
  },
  "checkpoint": {
    "completedShards": 1,
    "pendingPaths": [],
    "staleIndexes": []
  }
}
```

### inventory recordの例

```json
{
  "path": "src/src/api/auth.ts",
  "blob": "a1b2c3d4...",
  "pages": ["knowledge/api/auth.md"],
  "selfHashes": {
    "knowledge/api/auth.md": "sha256:7788..."
  },
  "masked": false
}
```

generation-target inventoryのblob hashにより、旧commit objectがなくても現在treeとの差分を計算できます。同一blob・別pathはrename候補、旧recordのみは削除、新recordのみは追加です。`selfHashes`は生成pageの手編集検出に使います。

調査対象は別の`knowledge.evidence` scopeです。CLIはtarget commitを`git ls-tree`で走査し、scopeに一致するtracked fileから`secrets_paths`を除いた正確なpath一覧をagent planへ渡します。generation targetsは「どのページを更新するか」、evidenceは「記述を何から検証するか」であり、`--scope`は前者だけに適用します。

`manifest.evidence.fingerprint`はgeneration target外のsupporting evidenceのpath/blob、include/exclude、secret patternから計算します。fingerprintが変わった場合、ページ単位の依存graphがなくてもstale proseを残さないため、全generation targetを保守的にqueueします。target自身の変更は従来どおりinventory diffで増分queueします。

inventoryは`knowledge.inventory_shard_size`ごとに分割します。rootには必ず`knowledge/index.md`を置き、初回はCLIがstubを作成します。実際のprose構造はagentが維持します。大きいagent planはgitignore済み`knowledge/.cache/agent-task-*.json`へ保存され、`generationTargets`と`evidence.paths`を別配列で保持します。

### hand edit

`knowledge build`は手編集を検出すると`--force`なしで停止します。一方、現行`sync`は警告を表示した後も処理を続ける経路があります。この不一致が解消されるまで、利用者にはWikiを手編集しないよう案内し、sync前のdiff確認を求めます。

### 主要scenario

| scenario | 検出・処理 |
| --- | --- |
| PKG mainへのPR merge / direct push | remote aheadを検出し同じsync pathへ収束 |
| force-push / non-fast-forward | blob inventoryで差分を再計算し、自動mergeせずPR提示 |
| 旧commitがGC済み | old commitではなくinventory blobとtreeを比較 |
| renameのみ | 同一blobを利用し、不要なLLM再生成を避ける |
| generation target外のsource変更 | evidence fingerprint差分で全generation targetを保守的に再queue |
| docs-only generation target | `src/**` evidenceを別途渡し、実装・test・config・CIを横断調査 |
| `--scope`付きbuild | generation targetだけ絞り、repository evidenceは維持 |
| agent中断・失敗 | 既存`pendingPaths`を`--refresh`時に再queue |
| source削除 | orphan pageを削除し、parent indexをstaleへ記録 |
| excludeだけの変更 | prose対象なしでknowledge SHAを前進可能 |
| secret path変更 | 本文を読まずmasked recordとして扱う |
| Wiki手編集 | self hash差分を警告・停止判断へ利用 |
| sync途中の失敗 | leaseを残しresume / abortを要求 |
| 同じtargetの二重処理 | operation keyで識別 |
| open sync PR中に新target | stream IDで旧PRを見つけsuperseded注記 |
| fresh cloneがremoteより古い | local 2SHAが一致すればwarningで作業継続 |

## 8. hooks

同梱`.claude/settings.json`は次のeventを`aidev`へ接続します。

| event | command | 現在の責務 |
| --- | --- | --- |
| SessionStart | `aidev hook session-start` | 3SHAとremote freshnessの表示 |
| PreToolUse | `aidev hook guard-write` | path、policy、leaseによるallow/deny |
| PostToolUse | `aidev hook quality-gate` | configured gate実行 |
| Stop | `aidev hook session-stop` | pending refreshとevolution観測のlocal記録 |

重い処理をhook内で同期実行しない設計ですが、現時点でpending refresh queueを消費するbackground runnerはありません。Stop hookを「自動でWiki更新まで完了する」と説明してはいけません。

Windows/POSIX差をsettings側へ持ち込まないため、hook commandは`aidev`だけです。

## 9. workflow runner

`workflow new`は次を生成します。

```text
workflows/<name>/
├─ workflow.yaml
└─ steps.js
```

人間が内容をreviewし、`workflow approve`が両ファイルのcontent hashを`approval.json`へ記録します。`run`はhash一致を要求するため、承認後に1 byteでも変われば再承認が必要です。

現在強制する安全弁:

- 最大iteration
- 最大実行時間
- 同一失敗の連続回数
- command basename allowlist
- run logとcheckpoint

現在metadataに留まる安全弁:

- token実消費量
- USD実消費額
- destructive operation前の対話承認

runnerはNode.jsで、`loop.py`を生成・実行する設計ではありません。

## 10. Azure DevOps MCP

`.mcp.json`は次のstatic launcherだけを持ちます。

```json
{
  "mcpServers": {
    "azure-devops": {
      "command": "aidev",
      "args": ["mcp", "azure-devops"]
    }
  }
}
```

`aidev mcp azure-devops`は設定を読み、`npx -y @azure-devops/mcp@2.10.0 ...`をstdio serverとして起動します。packageはinstaller時に事前installせず、初回起動時にregistry accessが必要です。PATは環境からsubprocessへ継承し、argumentへ展開しません。

## 11. model解決

対話sessionとCLI起動agentを分離します。

```text
対話session:
managed settings
  > claude --model / ANTHROPIC_MODEL
  > .claude/settings.local.json
  > .claude/settings.json
  > ~/.claude/settings.json

CLI起動agent:
--agent-model
  > aidev.yaml model.agent
  > DEFAULTS.model.agent
```

同梱agent frontmatterを`model: inherit`にすることで、具体modelをhard-codeして上位の選択を無効化しません。

## 12. source references

- static asset: `cli/lib/assets.js`
- config / policy: `cli/lib/config.js`、`cli/lib/policy.js`
- state: `cli/lib/state.js`
- lease: `cli/lib/leases.js`
- generation inventory / evidence scope: `cli/lib/inventory.js`、`cli/lib/knowledge-scope.js`
- sync: `cli/commands/sync.js`
- hooks: `cli/commands/hook.js`
- workflow: `cli/commands/workflow.js`
- MCP: `cli/commands/mcp.js`
