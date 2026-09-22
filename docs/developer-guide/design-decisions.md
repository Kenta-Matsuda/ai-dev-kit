# Design decisions

PKG clone方式（0.2.0で採用）以降の設計判断、検討した代替案、未決の論点を記録します。前身のwrapper repository方式（PKGをsubmoduleとして持つ別repository）からの変更点と、その後の版で足した判断を書きます。各判断は`architecture.md`の該当節と`implementation-status.md`の到達範囲を前提にしています。

## 採用した判断

### D1: tool設定はPKG cloneへ実体化し、PKG repositoryへcommitする

**判断**: toolごとの`templates/<tool>/`をPKG cloneへコピーし、他のfileと同様にcommitします。PKG teamはそのcopyを編集してよく、`.aidev/materialized.json`に適用したtemplateのhashとfileのhashを記録します。`aidev update`はkit本体だけを更新し、`aidev sync tools`（teamが好きなときに実行）が新templateを3-way mergeで取り込み、衝突はgit同様のmarkerを書いてteamに解消を委ねます。`aidev check`は未解消conflictとkit hooksの欠落だけをexit 2にし、teamの編集は止めません。

**理由**: 各AI toolはproject rootの設定fileを読む前提で作られており、toolを問わず動く最も単純な方法です。commitすることでチーム全員が同じ設定を`git pull`で受け取り、CI（`aidev check`）が同じfileを検査できます。

**却下した代替案**:

- `.git/info/exclude`で除外してcloneごとに実体化する。共有されないため「同じ設定」を保証できず、CIも検査できない
- tool起動時に設定directoryを外部へ向ける。toolごとの起動wrapperが必要になる
- user-level設定（`~/.claude/`）へ置く。PKGごとの差分を表現できない

**トレードオフ**: PKG repositoryにkit所有fileが入ります。kitとteamが同じ箇所を変えると`apply`でconflictになり、teamが解消するか`--force`でkit版にします。

### D2: LLM WikiはPKG repositoryの`.aidev/knowledge/`にcommitする

**判断**: 専用のknowledge repositoryやorphan branchは作らず、WikiをPKG repositoryに置きます。共有は`aidev/wiki-<sha12>` branchのPRと人間のmergeで行います。

**理由**: 「同じWiki」をチームで保つにはgitで共有する必要があり、PKG自身に置けばrepository数が増えず、Wikiとsourceが同じcommit履歴で追えます。`sync wiki`が「commit済みのinventoryがHEADのtreeと一致するか」をno-op判定に使えるのもこの配置だからです。

**却下した代替案**:

- PKGごとのknowledge repository。repository数と権限管理が増える
- 中央kitの`profiles/<pkg>/knowledge/`。中央kitが全PKGのWiki差分でbloatし、kit開発者がWikiをreviewすることになる
- 共有しない（各端末で生成）。前提を満たさない

**トレードオフ**: PKGのCIとbranch policyがWiki commitにも適用されます。整合判定はinventoryとHEADのtreeの比較で、kit管理pathはgeneration targetにならないため、Wiki追加commit自体は「codeが動いた」と数えません（D5）。

### D3: PKG固有設定とpolicyはPKG repositoryに置き、中央profileは持たない

**判断**: `aidev.yaml`と`.aidev/policy.yaml`はPKG repositoryにcommitします。中央kitに`profiles/`は置かず、`propose`系commandもありません。

**理由**: 設定・policy・Wiki・tool設定がすべて1つのrepositoryに揃い、PKG PRのreviewで完結します。中央kitはCLIとtemplateだけを配布するので、kit開発者が個々のPKGの設定をreviewする負荷がありません。

**却下した代替案**: 中央kitまたは別repositoryのprofileを`aidev update`で配布する。監査は一元化されるが、2 repositoryを跨ぐ更新と承認の流れが必要になる。

### D4: policyは候補生成→人間の承認→CLI配置とし、承認はlocal（PKG PR review）で完結する

**判断**: `aidev create policy`が`aidev.yaml`から機械的に候補を作り、`--approve`（または`init`の対話yes）で`.aidev/policy.yaml`へ配置します。中央登録は不要です。弱体化は`--force`を要求します。

**理由**: 新規PKGの導入が中央のPR mergeを待たずに始められます。policy fileはcommitされるので、その変更はPKG PRでreviewされます。

**論点**: 候補生成が`DEFAULT_POLICY_SCOPES`固定で、`aidev.yaml`から`read_only` / `writable` / `agents`を変える項目がありません。teamは`.aidev/policy.yaml`を直接編集してPRでreviewします（`--approve`は候補fileを読まず生成し直すため、候補の手編集は反映されません）。

### D5: Wikiは今のbranchのHEADを説明し、整合はinventoryとHEADのtreeの比較で判定する

**判断**: `headSha` = HEAD、`knowledgeSha` = manifestのSHA（表示用）、`trackingSha` = remote先端。整合は`inventory.compareWithTree`、すなわちWikiを生成したときのpath / blob idの一覧とHEADのtreeの比較で判定します。ERRORはWiki欠落・manifest破損に限定し、codeが先へ進んだ状態はWARNです。

**理由**: Wikiはcommitのたびに同じbranchへ別commitとして積むので、HEADと一致しているのが正常です。inventoryとの比較は旧commit objectを必要とせず、rebase / squash / force-pushの後も同じ結果になり、`sync wiki`が再生成対象を決める差分と一致します。Wiki追加commitやkit更新commitはgeneration targetを変えないので、Wikiをcommitした直後に「古い」と警告することもありません。

**却下した代替案**: `merge-base(HEAD, origin/<tracking_branch>)`を対象にしたsource treeのdiff（0.6.0まで）。feature branch上のcommitをWikiが説明できず、hookによる自動追従と両立しません。`submoduleSha == knowledgeSha`の厳密一致（wrapper方式）。submoduleが無い今は成立しません。

**論点**: 「WikiがHEADより遅れている」をWARNのままにするか、`--strict`でexit 2にするか（現状は後者）。

### D6: PKG fileは既定でread-onlyとし、書けるのは承認済みworkflowの`scope.writable`とpolicyの`writable`だけ

**判断**: 既定policyは`read_only: ["**"]`、`writable`はWiki・workflows・agents・skills・conventions・`aidev.yaml`のみ。PKG source（`src/**`など）への書込は、`aidev run workflow`が起動したsessionで、そのworkflowが`origin/<tracking_branch>`と同一（承認済み）のとき、`scope.writable`の範囲でだけ許します（`policy.decide`の第6段）。全員・全sessionに開くなら`.aidev/policy.yaml`の`writable`です。policy fileは`ALWAYS_PROTECTED`で、agentは書き換えられません。

**理由**: 「何を書いてよいか」を「何をさせるか」（workflow）と同じfileに置き、同じPR reviewで決めるためです。scopeはsecrets / protectedより下に評価されるので、広げても制御面へは到達できません。判定は書込のたびに行うので、agentが実行中にYAMLを書き換えても、originと食い違った瞬間にscopeを失います。

**却下した代替案**: policyのagent単位の許可（`agents.<name>.writable` + `branch`、`AIDEV_AGENT`。0.6.0〜0.7.0）。許可の置き場がworkflowと別で、teamがpolicyを手で編集する必要があり、対話sessionのsub-agentには効かず、workflowごとに範囲を変えられませんでした。承認済みworkflowのscopeに一本化し、撤去しました。

**経緯**: 0.4.0までは「issue-to-prがCLI発行のwork lease（branch・path・TTL）の範囲でだけ書ける」設計でしたが、leaseを発行する経路も、それを前提にしたtask状態機械もwrapper repository時代のもので完結しておらず、0.5.0で撤去しました。0.6.0でagent単位の許可を足し、workflow-first化（D9）でworkflowのscopeに置き換えました。

### D7: AI toolはadapter registryで扱い、実機検証済みはClaude Codeだけとする

**判断**: `cli/lib/tools.js`の`REGISTRY`に`claude` / `copilot` / `codex` / `kiro`を持ち、`tools.default`で宣言したtoolのtemplate（`templates/<tool>/`）を実体化し、CLIから起動できます（0.3.0）。実機で検証しているのは`claude`だけで、他は`verified: false`として公開仕様に沿ったargvを持ち、`aidev run workflow --dry-run`で使うtoolとagentを確認できます。hookによる書込policyの実行時強制はClaude Codeだけです。

**理由**: 設定fileの形をtoolごとに変えずに済ませ、tool固有の差をregistry 1か所に閉じるためです。「対応」と「検証済み」を分けるのは、PreToolUse相当の強制機構を持たないtoolに同じ保証を約束しないためです。

**論点**: claude以外のtoolでhook相当の強制をどう実現するか（`proposals/2026-09-22-wiki-update-flows.md` §5に調査あり）。Antigravity CLIは未対応。

### D8: hostingは`azure-devops`と`generic`の2種とする

**判断**: `hosting.type`は`azure-devops`（PR、Work Item、MCP）か`generic`（git操作のみ、PRは手動）です。GitHub / GitLab adapterはありません。

**理由**: `generic`があれば、adapterのないhostingでもpushまでは自動化でき、PRは人間が作れます。設定は`hosting`の下にまとめ、`config.azure_devops`はaliasとして残しました。

**論点**: 次に追加するproviderの優先順位。

### D9: 開発はworkflowだけから行い、workflowはYAMLのみ、承認は`origin/<tracking_branch>`との一致で判定する

**判断**: 利用者が開発に使うcommandは`aidev create workflow|submit|run|list`だけです（`aidev agent`は撤去）。workflowは`.aidev/workflows/<name>/workflow.yaml`の1 fileで、`objective`・`scope.writable`・`agents` / `skills`・`steps`（`agent` / `command` / `pull-request`）・`limits`・`cost`を書きます。実行logic（`until`の再試行loop、command実行、commit、push、PR）はkitのrunnerが持ちます。agentとskillは`.aidev/agents/`・`.aidev/skills/`（PKG）かkit同梱を名前で参照し、複数のworkflowで再利用します。`approve` commandと`approval.json`は無く、「承認済み」= `workflow.yaml`と参照するPKG内agent / skillが`origin/<hosting.tracking_branch>`にあるものとbyte一致、です。

**理由**: 3つの役割を分けるためです。kit開発者は実行するもの（runner、step種別、同梱workflow / agent / skill）の品質を持ち、PKGの責任者は「AIに何をさせるか」をYAMLに書いてPRでreviewし、実作業者は`aidev run workflow`を実行して生成されたPRをreviewerに渡すだけで、成果物に責任を持ちません。YAMLで書けないことはkitへの変更（新しいstep種別）であり、実行codeの品質責務がkit開発者に閉じます。承認をhostingに任せるのは、誰が承認したかをPR reviewerとbranch policyが記録し、CLIの記録（環境変数由来）を認証に使わないためです。

**却下した代替案**: (1) `steps.js`（自由なJavaScript）+ content hashの`approval.json`（0.3.0〜0.7.0）。reviewerがscriptを読む必要があり、実行codeの責務がPKG側に漏れ、承認記録が手元fileでした。(2) 1 taskごとに自然言語からworkflowを生成してreviewしてから実行する形。毎taskで責任者の承認が要るので「押すだけ」にならず、実作業者が計画をreviewすると責務が戻ります。代わりにworkflowの最初のstepで計画を書かせ、PR本文で見ます。(3) workflow単位でagentを同梱する形。同じagentを複数のworkflowで使えないので、名前参照にしました。

**論点**: `pull-request` stepの直後にWikiを追従させる（runnerが`aidev sync wiki`を呼ぶ）か。PRを作らないrunの記録を中央に集めるか。claude以外のtoolでの実機検証。

### D10: `aidev update`はkit checkoutだけを更新し、PKGへの適用は`aidev sync tools`に分ける

**判断**: `update`は`origin/main`へのfast-forwardだけを行い、`AIDEV_HOME/registry.json`のcloneのうち古いtemplateのままのものを一覧します。PKGへの適用はteamが都合のよいときに`aidev sync tools`で行い、結果はcommitせず利用者がreviewしてcommitします。起動時に更新の有無を通知します（`AIDEV_NO_UPDATE_CHECK=1`で抑止）。

**理由**: 更新のdiffがPKG PRとしてreviewされることで、kit側の変更が各PKGに「いつ・何が」入ったかが履歴に残ります。適用を分けたのは、teamの編集とのmergeやconflictの解消に時間をかけられるようにするためで、無関係なcloneの作業treeを予告なく書き換えないためでもあります（0.4.0。それ以前は`update`が現在のPKGへ再適用していました）。

**論点**: 移動・削除されたcloneは`listPackages`が`missing`として除外します。

### D11: tracking branch上のWiki更新は一時worktreeで行い、利用者のcheckoutに触れない

**判断**: tracking branch上（または`--branch`）の`sync wiki`は`.aidev/cache/wiki-worktree/`にHEADのdetached worktreeを作り、そこでinventory・agent・commitを行い、`aidev/wiki-<sha12>`をpushします。利用者のcheckoutのmanifestは変わりません。`--abort`はworktree削除とlease解放だけです。feature branch上ではworktreeを使わず、そのbranchへ直接別commitを積みます。

**理由**: wrapper方式では`src`をbumpして戻す必要があり、失敗時の復旧（`originalSha`へ戻す）が複雑でした。worktreeなら利用者の未commit変更やbranchに影響せず、失敗してもworktreeを消せば元どおりです。commit対象が`.aidev/knowledge`と`.aidev/.gitignore`に限られるのも、worktree内で`git add`する範囲を絞れるからです。

**トレードオフ**: 結果はPRのmerge後に`git pull`しないと手元に来ません。`check`はtracking先端のWikiが`aidev/wiki-*` branchに既にあることを注記します。

### D12: Wikiの構造化状態はCLIが持ち、agentは完了報告だけを書く

**判断**: manifestとinventoryはCLIだけが書きます。agentはbatch（既定20 target）ごとに起動され、targetを書き終えるたびに`.aidev/knowledge/.cache/done/*.json`を書き、CLIが各run後に`applyCompletions`で取り込みます。

**理由**: 1 processに全targetを渡すと進捗が見えず、timeoutで全成果を失い、headlessではBashが拒否されるためagentが`selfHashes`を計算できません。完了報告方式なら中断後に同じcommandで再開でき、agentが構造化fileを壊す経路もありません。

**トレードオフ**: batchごとにagentがrepositoryへ再orientするcostがかかります。survey runで`overview.md` / `index.md`を先に作り、後続batchはそれを読むことで軽減しています。

### D13: self-evolutionはkit開発者の端末だけで動かし、振り返りは同じsessionが書く

**判断**: 発動条件は`AIDEV_HOME/developer.json`（`npm run evolve -- enable`）または`AIDEV_KIT_DEVELOPER=1`で、PKGに配布されるfileや`aidev.yaml`には置きません。Stop hookはtranscriptを集計し、閾値（tool call 30回 / 出力20k tokens）を超えた未振り返りのsessionに1回だけ`decision: block`で振り返りを書かせます。`npm run evolve -- run`が振り返りを集め、kit checkoutのworktree（`aidev/evolve-<date>`）で`evolution` agentを起動し、agentがtemplateを直してPRを作ります。mergeは人間です。

**理由**: 後から別のagentにtranscriptを読ませるより、文脈を持つ本人が「どこで時間とtokenを無駄にしたか」を正確に言えます。PKG利用者の端末で動かさないのは、利用者にcostと挙動の差を生まないためです。変更先をkitのtemplateに限るのは、PKG内の`.claude/**`を直接変えるとdriftになるためです。

**却下した代替案**: `aidev.yaml`の`self_evolution`でPKGごとにon/offする（0.5.0まで。journal記録だけで読む側が無く、PKG側の設定で決める性質でもないため撤去）。SessionEndで集計する（Claudeに指示を出せない）。

**論点**: 閾値の初期値。`--auto`（Stop hookから`evolve run`を起動）を既定にするか。GitHub側のPR作成をagentの`gh` / MCP任せにしたままでよいか。

### D14: 開発規約は`.aidev/conventions/`に置き、agentが根拠付きで生成してteamがcommitする

**判断**: PKGのworkflow（規約を書くagent。kitは同梱しない）がWikiと根拠sourceから規約を`[確定]`（toolが強制）/ `[慣習]`（多数派、件数付き）/ `[未統一]`（割れている、teamの判断待ち）/ `[提案]`（現状の規約ではない）の区分で`.aidev/conventions/`（`index.md`、`coding.md`、`testing.md`、`review.md`）へ書きます。既定policyで`writable`です。既存pageの`## チーム決定`以下はagentが変更しません。test-writer agentは`testing.md`を前提に読みます。

**理由**: `.aidev/knowledge/**`は生成物で、手編集禁止・syncでのorphan削除の対象なので、teamが決めた規約の置き場になりません。`.claude/**`とCLAUDE.mdはkit所有でPKG固有の内容を置けず、置けばdriftです。PKG sourceは既定read-onlyで、置き場がPKGごとに違うと他のagentが見つけられません。`.aidev/`はPKG固有設定の置き場として既に定義されています（D3）。

**却下した代替案**: Wiki内のpage（上記）。CLAUDE.mdへの追記（kit所有）。PKGの`docs/`配下（agent grantが要り、置き場が固定できない）。agent専用grantだけで書けるようにする（人間の手編集と対話sessionの追記を妨げる割に、内容はgit diffでreviewされる）。

**論点**: `## チーム決定`以外を再生成で上書きする運用でよいか。SessionStart hookが規約の有無を表示すべきか。

### D15: commandは動詞先行（`aidev <動詞> [<object>] [<名前>]`）とする

**判断**: 利用者向けcommandは動詞で始めます。開発は`run` / `create` / `submit` / `list` / `remove`（objectは`workflow`、`create`は`agent` / `skill` / `policy`も、`remove`は`agent` / `skill`も、`list`は複数形）、保守は`init` / `check` / `sync tools|wiki [<package>]`、端末は`update`（objectなし。kit本体だけ）/ `doctor [<package>]` / `uninstall [<package>] [--all]`です。objectを1つしか取らない動詞（`run` / `submit`）でもobjectを省略しません。旧`aidev status` / `knowledge update` / `permission *` / `workflow *` / `apply` / `configure` / `show` / `eject` / `mcp` / `evolve` / `update kit|wiki`は「unknown command」または「takes no object」です（2026-09-23）。

**理由**: 「何をするか」で引けるcommand面のほうが、機能名（`workflow`、`knowledge`、`permission`）で引くより覚えやすく、help一覧が役割（開発 / 保守 / 端末）で読めるためです。動詞に対してobjectを必ず書かせるのは、`aidev run x`が何を実行するのか一覧から読めるようにするためと、将来objectを増やしても文法が変わらないためです。

**却下した代替案**: `aidev run <name>` / `aidev submit <name>`のようにobjectを省く形（短いが、`create` / `list` / `remove`と文法がずれる）。機能名を残して動詞を足す形（2系統の入口が残る）。

### D16: `init`はWikiを生成せず、`status`は`check`に統合し、`doctor`は端末（と名指ししたPKG）を見る

**判断**: `init`は設定・template・policy・registryだけを行い、Wikiは状態を報告して`aidev sync wiki --no-commit`を案内します（`--wiki` / `--no-wiki`は無い）。`check`は旧`status`の一画面表示とCI exit codeを兼ね、`aidev.yaml`が解析できない・workflowがinvalidのときexit 1を足します。`doctor`はnode / git / kit / registry / 全AI tool / proxyを見て、`<package>`（registry名かpath）を渡したときだけそのPKGの状態も一覧します。CIのexit契約は`check`だけが持ちます。

**理由**: `init`のexit 1が「設定できなかった」と「Wikiの本文が未完了」の両方を意味していて、CIや手順書で区別できませんでした。`status`と`check`は同じ検査の2つの出力で、人はexit codeを気にしないので1つで足ります。`doctor`がPKGも見ると`check`と重なり、どちらを見るかが毎回問題になります。

**却下した代替案**: `status`を残して`check`を「`status` + exit code」にする（2 commandが残る）。`doctor`を削って`check`に端末の検査も入れる（PKGの外で走らせるcommandが要る）。

### D17: kitはframeworkであり、開発用agent・workflow・MCP serverは配布しない

**判断**: kitが同梱するagentは仕組みのもの（knowledge-builder、workflow-creator、agents-creator、permission-setting）だけです。開発作業をするagent（実装、テスト、規約）、workflow、MCP serverはPKGのもので、`aidev create workflow --describe`の中でworkflow-creatorが必要な要素をagents-creatorのsubagentに書かせ、MCPは提案としてfinal messageに出して人が`.mcp.json`（PKG所有。kit管理外）に足します。`aidev mcp`、`templates/claude/.mcp.json`、issue-to-pr / test-writer / convention-builder、同梱workflowは撤去しました。`aidev hook`はAI toolのhooksが呼ぶ内部入口として残し（権限強制の実体）、helpには出しません。self-evolutionは`scripts/evolve.js`（`npm run evolve`）に移し、CLI commandではなくなりました。`eject`は`uninstall <package>`に、`apply`は`sync tools`に畳みました。

**理由**: kitの責務を「workflowを作る・提出する・承認する・実行する仕組み」と「initなどPKGに依らず有益な処理」に限るためです。PKGごとに違う開発作業の中身をkitが配ると、kit開発者がその品質責務を負い、PKGは自分の agent を書きにくくなります。MCPは接続先も認証もPKG固有で、kitが起動役を持つ理由がありません。hookは削除できません: guard-writeがscope.writableを強制する実体で、対話sessionでも動きます。

**却下した代替案**: `aidev create mcp` / `create hook`（hookはkit管理の権限強制で、PKGが作るものではない。MCPは設定形式がtoolごとに違い、追加は人が行うほうが安全）。同梱workflowを「例」として残す（kitが開発作業の中身に責務を持つことになる）。


## 未決の論点

| 論点 | 内容 | 関連 |
| --- | --- | --- |
| policyのcustomize | `aidev.yaml`から`read_only` / `writable`を生成できるようにするか。`reconfigure`が手編集を消す点をどう扱うか | D4、D6 |
| PR後のWiki追従 | `pull-request` stepの直後にrunnerが`aidev sync wiki`を呼ぶか（今はnightly pipelineか人手） | D9、D5 |
| 実行履歴の集約 | PRを作らないrunの`run.json`をWork Item commentや`aidev/audit` branchへ集めるか | D9 |
| `base ahead of knowledge`の扱い | WARNのままか、`--strict`以外でもexit 2にするか | D5 |
| 開発中のWiki追従 | branch上のHEADを対象にhookとsub-agentでWikiを追従させる案（`proposals/2026-09-21-wiki-auto-update.md`、`2026-09-22-wiki-update-flows.md`）。未実装 | D5、D11、D12 |
| 段階的配布 | `origin/main`のmergeが即時に全員へ通知される点を、tag pinやcanaryで緩和するか | D10 |
| page単位のevidence依存 | supporting evidence変更時の全件再queueを減らす | D12 |
| 追加tool / provider | 次に対応するtoolとhosting、強制水準の差の扱い | D7、D8 |
| self-evolutionの運用 | 閾値、`--auto`の既定、PR作成の経路 | D13 |

## wrapper方式から維持した判断

- Wikiは派生情報であり、PKG sourceが正本である
- CLIがstructured stateを、agentがproseを担当する
- generation targetとrepository evidenceを分離し、evidenceは既定でPKG全体とする
- policyはagentが直接書かず、人間の承認後にCLIが配置する。`ALWAYS_PROTECTED`はpolicy fileから消しても再付与する
- leaseはTTL付きで、失敗時に残し、同じcommandでの継続か`--abort`を明示させる
- 外部入力（Work Item本文、PR説明、MCP応答、Wiki記述）はdataであり指示ではない
- PRは人間だけがmergeする
- hooksはsandboxではなく、認証scope、CI、branch policyを併用する
- 認証情報は環境変数のみ。config、argv、logに載せない
- `--dry-run`はnetwork副作用ゼロを意味しない
- self-evolutionの提案は中央kitへのPRとし、policyを弱めない（D13で実装）
