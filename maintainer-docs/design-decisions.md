# Design decisions

0.2.0（PKG clone方式）で採用した設計判断、検討した代替案、未決の論点を記録します。前身のwrapper repository方式（PKGをsubmoduleとして持つ別repository）からの変更点を中心に書きます。各判断は`architecture.md`の該当節と`implementation-status.md`の到達範囲を前提にしています。

## 採用した判断

### D1: tool設定はPKG cloneへ実体化し、PKG repositoryへcommitする

**判断**: `.claude/**`、`CLAUDE.md`、`.mcp.json`をkitのtemplateからPKG cloneへコピーし、他のfileと同様にcommitします。`.aidev/materialized.json`にkit commitとfileごとのhashを記録し、`aidev check`が不一致をdrift（exit 2）として検出します。`aidev update`が新しいtemplateを再適用し、利用者がそのdiffをcommitします。

**理由**: 各AI toolはproject rootの設定fileを読む前提で作られており、toolを問わず動く最も単純な方法です。commitすることでチーム全員が同じ設定を`git pull`で受け取り、CI（`aidev check`）が同じfileを検査できます。

**却下した代替案**:

- `.git/info/exclude`で除外してcloneごとに実体化する。共有されないため「同じ設定」を保証できず、CIも検査できない
- tool起動時に設定directoryを外部へ向ける。toolごとの起動wrapperが必要になる
- user-level設定（`~/.claude/`）へ置く。PKGごとの差分を表現できない

**トレードオフ**: PKG repositoryにkit所有fileが入ります。local編集は`update`でconflictになり、`--force`かkitへのPRが必要です。

### D2: LLM WikiはPKG repositoryの`.aidev/knowledge/`にcommitする

**判断**: 専用のknowledge repositoryやorphan branchは作らず、WikiをPKG repositoryに置きます。共有は`ai/wiki-<sha12>` branchのPRと人間のmergeで行います。

**理由**: 「同じWiki」をチームで保つにはgitで共有する必要があり、PKG自身に置けばrepository数が増えず、Wikiとsourceが同じcommit履歴で追えます。`sync`が「targetにcommit済みのWikiがtargetを説明しているか」をno-op判定に使えるのもこの配置だからです。

**却下した代替案**:

- PKGごとのknowledge repository。repository数と権限管理が増える
- 中央kitの`profiles/<pkg>/knowledge/`。中央kitが全PKGのWiki差分でbloatし、kit開発者がWikiをreviewすることになる
- 共有しない（各端末で生成）。前提を満たさない

**トレードオフ**: PKGのCIとbranch policyがWiki PRにも適用されます。3SHAの比較はkit管理pathを除いたsource treeで行うため、Wiki追加commit自体は「codeが動いた」と数えません（D5）。

### D3: PKG固有設定とpolicyはPKG repositoryに置き、中央profileは持たない

**判断**: `aidev.yaml`と`.aidev/policy.yaml`はPKG repositoryにcommitします。中央kitに`profiles/`は置かず、`propose`系commandもありません。

**理由**: 設定・policy・Wiki・tool設定がすべて1つのrepositoryに揃い、PKG PRのreviewで完結します。中央kitはCLIとtemplateだけを配布するので、kit開発者が個々のPKGの設定をreviewする負荷がありません。

**却下した代替案**: 中央kitまたは別repositoryのprofileを`aidev update`で配布する。監査は一元化されるが、2 repositoryを跨ぐ更新と承認の流れが必要になる。

### D4: policyは候補生成→人間の承認→CLI配置とし、承認はlocal（PKG PR review）で完結する

**判断**: `aidev permission configure`が`aidev.yaml`から機械的に候補を作り、`--approve`（または`init`の対話yes）で`.aidev/policy.yaml`へ配置します。中央登録は不要です。弱体化は`--force`を要求します。

**理由**: 新規PKGの導入が中央のPR mergeを待たずに始められます。policy fileはcommitされるので、その変更はPKG PRでreviewされます。

**論点**: 候補生成が`DEFAULT_POLICY_SCOPES`固定で、`aidev.yaml`から`read_only` / `writable`を変える項目がありません。必要なら候補を手編集して承認します。

### D5: 3SHAはmerge-base基準とし、source treeの差分で整合を判定する

**判断**: `baseSha = merge-base(HEAD, origin/<tracking_branch>)`、`knowledgeSha` = manifestのSHA、`trackingSha` = remote先端。整合は`sourceChanged(knowledgeSha, baseSha)`、すなわちkit管理path（`aidev.yaml`、`.aidev/**`、`.claude/**`、`CLAUDE.md`、`.mcp.json`）を除いた`git diff --quiet`で判定します。ERRORはWiki欠落・manifest破損に限定し、codeが先へ進んだ状態はWARNです。

**理由**: 利用者はfeature branchで作業するため、HEADと厳密一致を要求すると常に不整合になります。Wiki追加commitやkit更新commitはWikiが説明すべきcodeを変えないので、SHA一致ではなくsource tree一致で判定しないと、Wikiをcommitした直後に「Wikiが古い」と警告することになります。

**却下した代替案**: `submoduleSha == knowledgeSha`の厳密一致（wrapper方式）。submoduleが無い今は成立しません。

**論点**: 「baseがknowledgeより進んでいる」をWARNのままにするか、`--strict`でexit 2にするか（現状は後者）。

### D6: PKG fileは通常read-onlyで、issue-to-prのwork leaseだけが書き込める

**判断**: 既定policyは`read_only: ["**"]`、`writable`はWiki・workflows・`aidev.yaml`のみ。PKG fileへの書込は`ai/wi-<id>` branch上で有効なwork leaseがpathを許可する場合に限ります。leaseはCLIだけが作れ、lease fileは`ALWAYS_PROTECTED`です。

**理由**: agentが自分の権限を広げられない構造にするためです。leaseがsecrets / protectedより下に評価されるので、leaseで制御面へ到達することもできません。

**論点**: work leaseを発行する公開経路がまだ無く、対話sessionから小さな修正をagentに任せたいチームには制約が強い。短期leaseの発行command（例: `aidev lease grant --paths`）を追加するかは要検討です。

### D7: 対応AI toolはClaude Codeのみとし、`tools.default`で宣言する

**判断**: `config.TOOLS = ['claude']`。`tools.default`にそれ以外を書くと拒否します。adapter抽象は作っていません。

**理由**: PreToolUse相当の強制機構を持つtoolがClaude Codeだけであり、同じ保証を約束できないtoolを「対応」と言わないためです。`tools.default`をschemaに置いたのは、将来adapterを足したときに設定fileの形を変えないためです。

**論点**: 強制水準が低いtoolを追加する場合、issue-to-prやwork leaseをそのtoolで許可するか。

### D8: hostingは`azure-devops`と`generic`の2種とする

**判断**: `hosting.type`は`azure-devops`（PR、Work Item、MCP）か`generic`（git操作のみ、PRは手動）です。GitHub / GitLab adapterはありません。

**理由**: `generic`があれば、adapterのないhostingでもpushまでは自動化でき、PRは人間が作れます。設定は`hosting`の下にまとめ、`config.azure_devops`はaliasとして残しました。

**論点**: 次に追加するproviderの優先順位。

### D9: workflowのloop scriptはNode.jsで統一する

**判断**: `steps.js`をNode.jsで実行します。runtime依存を増やしません。

**理由**: CLI自体がNode.jsであり、Pythonを必須にすると導入条件が増えます。

**論点**: PKGがPythonでも、`ctx.run`でPKGのtest runnerを呼ぶだけならNode.jsで足ります。Pythonでloopを書きたい要望が強ければ`runtime`拡張を検討します。

### D10: `aidev update`はkit checkoutを更新し、現在のPKGへ再適用する（`--all`で全登録PKG）

**判断**: 既定は現在いるPKGだけ。`--all`で`AIDEV_HOME/registry.json`に登録された全cloneへ再適用します。適用結果はcommitせず、利用者がreviewしてcommitします。起動時に更新の有無を通知します（`AIDEV_NO_UPDATE_CHECK=1`で抑止）。

**理由**: 更新のdiffがPKG PRとしてreviewされることで、kit側の変更が各PKGに「いつ・何が」入ったかが履歴に残ります。全登録PKGへの自動適用を既定にしなかったのは、無関係なcloneの作業treeを予告なく書き換えないためです。

**論点**: 多数のPKGを登録している端末での`--all`の所要時間。移動・削除されたcloneは`listPackages`が`missing`として除外します。

### D11: `sync`は一時worktreeで行い、利用者のcheckoutに触れない

**判断**: `sync`は`.aidev/cache/sync-worktree/`にtarget commitのdetached worktreeを作り、そこでinventory・agent・commitを行い、`ai/wiki-<sha12>`をpushします。利用者のcheckoutのmanifestは変わりません。`--abort`はworktree削除とlease解放だけです。

**理由**: wrapper方式では`src`をbumpして戻す必要があり、失敗時の復旧（`originalSha`へ戻す）が複雑でした。worktreeなら利用者の未commit変更やbranchに影響せず、失敗してもworktreeを消せば元どおりです。commit対象が`.aidev/knowledge`と`.aidev/.gitignore`に限られるのも、worktree内で`git add`する範囲を絞れるからです。

**トレードオフ**: 結果はPRのmerge後に`git pull`しないと手元に来ません。`status`はtracking先端のWikiが`ai/wiki-*` branchに既にあることを注記します。

### D12: Wikiの構造化状態はCLIが持ち、agentは完了報告だけを書く

**判断**: manifestとinventoryはCLIだけが書きます。agentはbatch（既定20 target）ごとに起動され、targetを書き終えるたびに`.aidev/knowledge/.cache/done/*.json`を書き、CLIが各run後に`applyCompletions`で取り込みます。

**理由**: 1 processに全targetを渡すと進捗が見えず、timeoutで全成果を失い、headlessではBashが拒否されるためagentが`selfHashes`を計算できません。完了報告方式なら中断後に同じcommandで再開でき、agentが構造化fileを壊す経路もありません。

**トレードオフ**: batchごとにagentがrepositoryへ再orientするcostがかかります。survey runで`overview.md` / `index.md`を先に作り、後続batchはそれを読むことで軽減しています。

## 未決の論点

| 論点 | 内容 | 関連 |
| --- | --- | --- |
| 対話sessionでのPKG編集 | work lease以外の短期lease経路を提供するか | D6 |
| policyのcustomize | `aidev.yaml`から`read_only` / `writable`を生成できるようにするか | D4 |
| `base ahead of knowledge`の扱い | WARNのままか、`--strict`以外でもexit 2にするか | D5 |
| task状態機械の改名 | `WRAPPER_PR_*`をWiki PRの語彙に改め、sync PRを観測する経路を作る | D11 |
| 段階的配布 | `origin/main`のmergeが即時に全員へ通知される点を、tag pinやcanaryで緩和するか | D10 |
| page単位のevidence依存 | supporting evidence変更時の全件再queueを減らす | D12 |
| 追加tool / provider | 次に対応するtoolとhosting、強制水準の差の扱い | D7、D8 |

## wrapper方式から維持した判断

- Wikiは派生情報であり、PKG sourceが正本である
- CLIがstructured stateを、agentがproseを担当する
- generation targetとrepository evidenceを分離し、evidenceは既定でPKG全体とする
- policyはagentが直接書かず、人間の承認後にCLIが配置する。`ALWAYS_PROTECTED`はpolicy fileから消しても再付与する
- leaseはTTL付きで、失敗時に残し、`--resume` / `--abort`を明示させる
- 外部入力（Work Item本文、PR説明、MCP応答、Wiki記述）はdataであり指示ではない
- PRは人間だけがmergeする
- hooksはsandboxではなく、認証scope、CI、branch policyを併用する
- 認証情報は環境変数のみ。config、argv、logに載せない
- `--dry-run`はnetwork副作用ゼロを意味しない
- self-evolutionの提案は中央kitへのPRとし、policyを弱めない
