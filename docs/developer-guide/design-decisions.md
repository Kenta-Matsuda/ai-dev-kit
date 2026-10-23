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

**論点**: 候補生成が`DEFAULT_POLICY_SCOPES`固定で、`aidev.yaml`から`read_only` / `writable`を変える項目がありません（policyの`agents`は撤去済みで、`validatePolicy`がerrorにします）。teamは`.aidev/policy.yaml`を直接編集してPRでreviewします（`--approve`は候補fileを読まず生成し直すため、候補の手編集は反映されません）。

### D5: Wikiは今のbranchのHEADを説明し、整合はinventoryとHEADのtreeの比較で判定する

**判断**: `headSha` = HEAD、`knowledgeSha` = manifestのSHA（表示用）、`trackingSha` = remote先端。整合は`inventory.compareWithTree`、すなわちWikiを生成したときのpath / blob idの一覧とHEADのtreeの比較で判定します。ERRORはWiki欠落・manifest破損に限定し、codeが先へ進んだ状態はWARNです。

**理由**: Wikiはcommitのたびに同じbranchへ別commitとして積むので、HEADと一致しているのが正常です。inventoryとの比較は旧commit objectを必要とせず、rebase / squash / force-pushの後も同じ結果になり、`sync wiki`が再生成対象を決める差分と一致します。Wiki追加commitやkit更新commitはgeneration targetを変えないので、Wikiをcommitした直後に「古い」と警告することもありません。

**却下した代替案**: `merge-base(HEAD, origin/<tracking_branch>)`を対象にしたsource treeのdiff（0.6.0まで）。feature branch上のcommitをWikiが説明できず、hookによる自動追従と両立しません。`submoduleSha == knowledgeSha`の厳密一致（wrapper方式）。submoduleが無い今は成立しません。

**論点**: 「WikiがHEADより遅れている」をWARNのままにするか、`--strict`でexit 2にするか（現状は後者）。

### D6: PKG fileは既定でread-onlyとし、書けるのは承認済みworkflowの実行中stepの`writable`とpolicyの`writable`だけ

**判断**: 既定policyは`read_only: ["**"]`、`writable`はWiki・workflows・agents・skills・conventions・`aidev.yaml`のみ。PKG source（`src/**`など）への書込は、`aidev run workflow`が起動したsessionで、そのworkflowが`origin/<tracking_branch>`と同一（承認済み）のとき、実行中のstep（`AIDEV_WORKFLOW_STEP`）の`writable`の範囲でだけ許します（`policy.decide`の第6段）。全員・全sessionに開くなら`.aidev/policy.yaml`の`writable`です。policy fileは`ALWAYS_PROTECTED`で、agentは書き換えられません。

**理由**: 「何を書いてよいか」を「何をさせるか」（workflow）と同じfileに置き、同じPR reviewで決めるためです。scopeはsecrets / protectedより下に評価されるので、広げても制御面へは到達できません。判定は書込のたびに行うので、agentが実行中にYAMLを書き換えても、originと食い違った瞬間に書込の許可を失います。範囲をworkflow全体でなくstepごとに持つのは、調査だけのstepを`[]`にし、書くstepだけに最小の範囲を与えるためです（D18）。

**却下した代替案**: policyのagent単位の許可（`agents.<name>.writable` + `branch`、`AIDEV_AGENT`。0.6.0〜0.7.0）。許可の置き場がworkflowと別で、teamがpolicyを手で編集する必要があり、対話sessionのsub-agentには効かず、workflowごとに範囲を変えられませんでした。承認済みworkflowの範囲に一本化し、撤去しました。workflow全体で1つの`scope.writable`（2026-09-23）。全stepが同じ範囲を持ち、調査stepも書けました。stepごとの`writable`に置き換えました（D18）。

**経緯**: 0.4.0までは「issue-to-prがCLI発行のwork lease（branch・path・TTL）の範囲でだけ書ける」設計でしたが、leaseを発行する経路も、それを前提にしたtask状態機械もwrapper repository時代のもので完結しておらず、0.5.0で撤去しました。0.6.0でagent単位の許可を足し、workflow-first化（D9）でworkflowの`scope.writable`に、さらにstepごとの`writable`に置き換えました。

### D7: AI toolはadapter registryで扱い、実機検証済みはClaude Codeだけとする

**判断**: `cli/lib/tools.js`の`REGISTRY`に`claude` / `copilot` / `codex` / `kiro`を持ち、`tools.default`で宣言したtoolのtemplate（`templates/<tool>/`）を実体化し、CLIから起動できます（0.3.0）。実機で検証しているのは`claude`だけで、他は`verified: false`として公開仕様に沿ったargvを持ち、`aidev run workflow --dry-run`で使うtoolとagentを確認できます。hookによる書込policyの実行時強制は、copilot / codex / kiro向けにもhooks設定（`.github/hooks/aidev.json`、`.codex/hooks.json`、`.kiro/agents/aidev.json`）とadapter（`tools.HOOK_ADAPTERS`）を配布していますが、実機で検証しているのはClaude Codeだけです。

**理由**: 設定fileの形をtoolごとに変えずに済ませ、tool固有の差をregistry 1か所に閉じるためです。「対応」と「検証済み」を分けるのは、PreToolUse相当の強制機構を持たないtoolに同じ保証を約束しないためです。

**論点**: claude以外のtoolでhook相当の強制をどう実現するか（`proposals/2026-09-22-wiki-update-flows.md` §5に調査あり）。Antigravity CLIは未対応。

### D8: hostingは`azure-devops`と`generic`の2種とする

**判断**: `hosting.type`は`azure-devops`（PR、Work Item、MCP）か`generic`（git操作のみ、PRは手動）です。GitHub / GitLab adapterはありません。

**理由**: `generic`があれば、adapterのないhostingでもpushまでは自動化でき、PRは人間が作れます。設定は`hosting`の下にまとめ、`config.azure_devops`はaliasとして残しました。

**論点**: 次に追加するproviderの優先順位。

### D9: 開発はworkflowだけから行い、workflowはYAMLのみ、承認は`origin/<tracking_branch>`との一致で判定する

**判断**: 利用者が開発に使うcommandは`aidev run|estimate|create|modify|edit|submit|list|remove … workflow`だけです（`aidev agent`は撤去）。workflowは`.aidev/workflows/<name>/workflow.yaml`の1 fileで、`objective`・`steps`（`agent` / `command` / `pull_request` / `parallel`（agent stepのgroup）。agent stepはstepごとの`writable`を持つ）・`limits`を書きます（agentの能力はagentのfrontmatterと、そのworkflowでだけ足すtop-levelの`agents:`。D18、D24）。実行logic（`until`の再試行loop、command実行、commit、push、PR）はkitのrunnerが持ちます。agentはstepから、skillはagentのfrontmatterから、`.aidev/agents/`・`.aidev/skills/`（PKG）かkit同梱を名前で参照し、複数のworkflowで再利用します。`approve` commandと`approval.json`は無く、「承認済み」= `workflow.yaml`と参照するPKG内agent / skillが`origin/<hosting.tracking_branch>`にあるものとbyte一致、です。

**理由**: 3つの役割を分けるためです。kit開発者は実行するもの（runner、step種別、同梱agent / skill。workflowは同梱しない）の品質を持ち、PKGの責任者は「AIに何をさせるか」をYAMLに書いてPRでreviewし、実作業者は`aidev run workflow`を実行して生成されたPRをreviewerに渡すだけで、成果物に責任を持ちません。YAMLで書けないことはkitへの変更（新しいstep種別）であり、実行codeの品質責務がkit開発者に閉じます。承認をhostingに任せるのは、誰が承認したかをPR reviewerとbranch policyが記録し、CLIの記録（環境変数由来）を認証に使わないためです。

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

**判断**: PKGのworkflow（規約を書くagent。kitは同梱しない）がWikiと根拠sourceから規約を`[確定]`（toolが強制）/ `[慣習]`（多数派、件数付き）/ `[未統一]`（割れている、teamの判断待ち）/ `[提案]`（現状の規約ではない）の区分で`.aidev/conventions/`（`index.md`、`coding.md`、`testing.md`、`review.md`）へ書きます。既定policyで`writable`です。既存pageの`## チーム決定`以下はagentが変更しません。testを書くPKGのagentは`testing.md`を前提に読む想定です（kitはtest-writer等の開発用agentを同梱しない）。

**理由**: `.aidev/knowledge/**`は生成物で、手編集禁止・syncでのorphan削除の対象なので、teamが決めた規約の置き場になりません。`.claude/**`とCLAUDE.mdはkit所有でPKG固有の内容を置けず、置けばdriftです。PKG sourceは既定read-onlyで、置き場がPKGごとに違うと他のagentが見つけられません。`.aidev/`はPKG固有設定の置き場として既に定義されています（D3）。

**却下した代替案**: Wiki内のpage（上記）。CLAUDE.mdへの追記（kit所有）。PKGの`docs/`配下（agent grantが要り、置き場が固定できない）。agent専用grantだけで書けるようにする（人間の手編集と対話sessionの追記を妨げる割に、内容はgit diffでreviewされる）。

**論点**: `## チーム決定`以外を再生成で上書きする運用でよいか。SessionStart hookが規約の有無を表示すべきか。

### D15: commandは動詞先行（`aidev <動詞> [<object>] [<名前>]`）とする

**判断**: 利用者向けcommandは動詞で始めます。開発は`run` / `estimate` / `create` / `modify` / `edit` / `submit` / `list` / `remove`（objectは`workflow`（`modify` / `estimate`は2026-10-12、`edit`は2026-10-13に追加）、`create`は`agent` / `skill` / `policy`も、`remove`は`agent` / `skill`も、`list`は複数形）、保守は`init` / `check` / `sync tools|wiki`、端末は`update`（objectなし。kit本体だけ）/ `doctor` / `uninstall [--all]`です（PKGの指定はD19）。objectを1つしか取らない動詞（`run` / `submit`）でもobjectを省略しません。旧`aidev status` / `knowledge update` / `permission *` / `workflow *` / `apply` / `configure` / `show` / `eject` / `mcp` / `evolve` / `update kit|wiki`は「unknown command」または「takes no object」です（2026-09-23）。

**理由**: 「何をするか」で引けるcommand面のほうが、機能名（`workflow`、`knowledge`、`permission`）で引くより覚えやすく、help一覧が役割（開発 / 保守 / 端末）で読めるためです。動詞に対してobjectを必ず書かせるのは、`aidev run x`が何を実行するのか一覧から読めるようにするためと、将来objectを増やしても文法が変わらないためです。

**却下した代替案**: `aidev run <name>` / `aidev submit <name>`のようにobjectを省く形（短いが、`create` / `list` / `remove`と文法がずれる）。機能名を残して動詞を足す形（2系統の入口が残る）。

### D16: `init`はWikiを生成せず、`status`は`check`に統合し、`doctor`は端末（と名指ししたPKG）を見る

**判断**: `init`は設定・template・policy・registryだけを行い、Wikiは状態を報告して`aidev sync wiki --no-commit`を案内します（`--wiki` / `--no-wiki`は無い）。`check`は旧`status`の一画面表示とCI exit codeを兼ね、`aidev.yaml`が解析できない・workflowがinvalidのときexit 1を足します。`doctor`はnode / git / kit / registry / 全AI tool / proxyを見て、`--package`を付けたときだけそのPKGの状態も一覧します。CIのexit契約は`check`だけが持ちます。

**理由**: `init`のexit 1が「設定できなかった」と「Wikiの本文が未完了」の両方を意味していて、CIや手順書で区別できませんでした。`status`と`check`は同じ検査の2つの出力で、人はexit codeを気にしないので1つで足ります。`doctor`がPKGも見ると`check`と重なり、どちらを見るかが毎回問題になります。

**却下した代替案**: `status`を残して`check`を「`status` + exit code」にする（2 commandが残る）。`doctor`を削って`check`に端末の検査も入れる（PKGの外で走らせるcommandが要る）。

### D17: kitはframeworkであり、開発用agent・workflow・MCP serverは配布しない

**判断**: kitが同梱するagentは仕組みのもの（knowledge-builder、workflow-creator、agents-creator、permission-setting）だけです。開発作業をするagent（実装、テスト、規約）、workflow、MCP serverはPKGのもので、`aidev create workflow --describe`の中でworkflow-creatorが必要な要素をagents-creatorのsubagentに書かせ、MCPは提案としてfinal messageに出して人が`.mcp.json`（PKG所有。kit管理外）に足します。`aidev mcp`、`templates/claude/.mcp.json`、issue-to-pr / test-writer / convention-builder、同梱workflowは撤去しました。`aidev hook`はAI toolのhooksが呼ぶ内部入口として残し（権限強制の実体）、helpには出しません。self-evolutionは`scripts/evolve.js`（`npm run evolve`）に移し、CLI commandではなくなりました。`eject`は`uninstall --package`に、`apply`は`sync tools`に畳みました。

**理由**: kitの責務を「workflowを作る・提出する・承認する・実行する仕組み」と「initなどPKGに依らず有益な処理」に限るためです。PKGごとに違う開発作業の中身をkitが配ると、kit開発者がその品質責務を負い、PKGは自分の agent を書きにくくなります。MCPは接続先も認証もPKG固有で、kitが起動役を持つ理由がありません。hookは削除できません: guard-writeがstepの`writable`とagentの能力を強制する実体で、対話sessionでも動きます。

**却下した代替案**: `aidev create mcp` / `create hook`（hookはkit管理の権限強制で、PKGが作るものではない。MCPは設定形式がtoolごとに違い、追加は人が行うほうが安全）。同梱workflowを「例」として残す（kitが開発作業の中身に責務を持つことになる）。


### D18: 能力はagentのfrontmatter、制約はworkflowのstepに置き、Claude Codeでは起動flagとhookの2段で強制する

**判断**: agentが使えるもの（`skills`・`tools`・`mcp`）は`.aidev/agents/<name>.md`のfrontmatterに書き、workflowにはstepごとの制約（`agent`・`writable`・`until`など）だけを書きます。workflowのtop-levelの`scope` / `agents` / `skills`は削除し、表にないkeyはerrorにしました。workflowがagentの能力を上書き・拡張するkeyはありません（→ D24でworkflowの`agents:`による追加を採用）。権限が違う仕事は別のagentにします（読むだけの`ticket-reader`と更新する`ticket-updater`など）。強制はClaude Codeで2段です: runnerがagent stepごとに`--mcp-config <agentのserverだけの一時file（repo外、step後に削除）> --strict-mcp-config`、`--allowedTools mcp__<server>,…`、`--tools <list>`で起動し（`mcp`の無いagentにはserverを渡さない）、guard-write（matcherに`mcp__.*`を追加）がworkflow step内で許されていないtool / MCP toolをdenyします。能力を絞れないtool（Copilot CLI、Codex、Kiro。adapterに`capabilities`が無い）では、`tools`か`mcp`を持つagentを起動前に拒否します。stepは毎回新しいprocessなので、先に完了したagent stepの最終報告を後のstepのpromptに入れます。

**理由**: 能力はagentの性質で、同じagentをどのworkflowで使っても同じ権限であるべきだからです。workflowで上書きできると、reviewerはagentのfileを読んでも実際の権限が分からず、workflowごとに組み合わせを確かめる必要が出ます。制約（どこに書くか、いつ終わるか）は仕事ごとに違うのでstepに置きます。起動flagだけではtool側の挙動変更に弱く、hookだけでは存在するtoolをAIが試す余地が残るので、2段にします（flagは`claude` 2.1.280で確認）。hookはworkflow外のMCP呼び出しには答えず、利用者に代わって承認しません。強制できないtoolで黙って起動すると、frontmatterに書いた制限が守られていると誤解させるので拒否します。

**却下した代替案**: workflowのtop-levelに`agents` / `skills`を並べ、skillを全stepに差し込む形（2026-09-23まで。stepごとに必要なskillが違っても全agentが同じものを受け取り、権限をworkflowとagentのどちらで読むべきかが曖昧）。workflow側でagentごとに`tools` / `mcp`を上書きする形（上記の理由）。制限できないtoolではfrontmatterの`tools` / `mcp`を無視して起動する形（見かけの制限になる）。

**論点**: `Bash`を持つagentはMCPを通さず外部へ出られるので、外部systemに触るagentに`Bash`を渡さないことはreview（templateのagents-creator / workflow-creatorの指示とuser guide）に頼っています。

### D19: 対象PKGは共通option `--package <name|path>`で指定し、一覧は`aidev list packages`で見る

**判断**: PKGに対して動くcommandはすべて`--package <name|path>`（短縮`-p`）を受け付け、cwdの代わりにそのPKGで動きます。解決はentry point（`aidev.js`）の1か所で、registryの名前を先に、無ければpathとして扱います。端末だけに作用する`update`と、toolが起点を渡す`hook`はerrorにします。一覧は`aidev list packages`で、名前・path・templateが最新かを出し、そのまま`--package`に渡せる名前を示します。`sync` / `doctor` / `uninstall`が個別に持っていた位置引数`<package>`は削除しました（2026-09-23）。

**理由**: 複数のPKG cloneを持つ人が`aidev update`のあと`cd`せずに追従でき、同じ書き方がどのcommandでも通じるからです。位置引数は`run workflow <name>`・`create agent <name>`のobjectと名前に衝突し、commandごとに意味が変わります。受け付けないcommandで黙って無視すると、別のPKGに対して実行したつもりの誤操作に気づけません。

**却下した代替案**: commandごとの位置引数`<package>`（上記）。gitと同じ`-C <path>`（pathしか受けず、`list packages`が出す名前を使えない）。machine向けcommandでも受け付けて無視する形（scriptで一律に付けられるが、誤操作を隠す）。

### D20: 無人の大規模実行は費用と回数の上限で止め、時間の天井は置かない

**判断**: `limits.max_usd`（必須）、`until.max_retries`（≤10）、`for_each.max_items`（≤10000）、agent 1回とcommand 1つの`timeout_minutes`（≤240）で実行を止めます。全体の時間`limits.max_minutes`は任意で、天井を置きません（旧: 必須ではないが既定・天井60分）。ただし費用を報告しないtool（claude以外）で動くagentがあるときは、`max_usd`が効かないので`max_minutes`（か`--max-minutes`）を要求します。`for_each.on_failure: continue`で、失敗した件の変更を戻して次の件へ進めます。予算は`limits`に`max_minutes`と並べて書きます（旧`cost.max_usd`）。時間はmsでなく分（`timeout_minutes`）で書きます（2026-10-13）。

**理由**: 数百〜数千件のE2E作成や大規模なversion upのように、実行したら終わるまで人が介入しない使い方では、60分の天井は「人が`--resume`する」ことを前提にしてしまいます。暴走の害は費用であり、それは`max_usd`で止まります。hangは`timeout_minutes`が止めます。1件の失敗で全体が止まると、数千件の仕事は終わりません。`cost`と`limits`が別keyなのは「実行を止める条件」が2か所に分かれて読みにくく、msの数値は桁を読み違えます。

**却下した代替案**: PKGごとの天井を`aidev.yaml`で上げる案（`proposals/2026-10-01-workflow-long-running.md`の提案4。天井を設定する場所が増えるだけで、無人実行の判断はworkflowのreviewで足りる）。失敗した件を戻さずに残す案（失敗したテストがPRに入りCIを壊す）。並列実行（同じ作業treeを共有するため、件ごとのworktreeが先に要る。→ D25で、書く場所が重ならない形に限って採用）。

### D21: stepの種類はkeyで決め、やり直しは`until`に属する

**判断**: stepの種類は`agent:` / `command:` / `pull_request:`のどのkeyを持つかで決めます（ちょうど1つ）。pull-request stepは`pull_request: { title: ... }`（titleが無ければ`pull_request: {}`）と書き、旧`kind: pull-request`とstep直下の`title`はerrorです。やり直しの回数は`until.max_retries`（既定3、≤10）に書き、step直下の`max_retries`はerrorです。`until`の無いstepはやり直さず、`unchanged`だけのstepの違反はそのstep（`for_each`ならその件）の不合格です（2026-10-13）。

**理由**: agent stepとcommand stepはkeyの有無で種類が決まるのに、PRだけ`kind`で書く形は揃っていませんでした。`max_retries`は「判定に落ちたらやり直す」回数なので、判定（`until`）の中にある方が読み手に意味が伝わり、`until`の無いstepに書いても意味が無いことが形で分かります。

**却下した代替案**: 全stepに`kind`を書かせる案（agent / command stepの記述が長くなるだけ）。`unchanged`だけのstepにも`max_retries`を残す案（判定の無いstepに再試行の数だけが残り、どこに書くかが2通りになる。やり直したいなら`until`を書く）。

### D22: 見積もりは記録で学び、AIに金額を推測させない

**判断**: `run workflow`は開始時の見積もりと実費を、stepごとにrecord（`.aidev/estimates/records/`）として残し、PKGにcommitしてteamで共有します。学習は3段です。(1) 見積もりのたびに、recordからsize classの価格と幅の倍率（過去の8割が入る最小の倍率）を計算する（AIなし）。(2) 幅を外れたstepが3つ溜まると、`run`の終わりにestimate-reviewer（読むだけ）が外れた理由を読み、agent別・仕事の種類別の1回の価格（prior）と注意書きを答え、CLIが検査して`priors.json` / `notes.md`に書く（`estimates.review: off`で止める）。(3) kit開発者が複数PKGのrecordをbacktestにかけ、見積もりの方法そのものをPRで直す（`npm run evolve -- estimates`）。価格はmodelの単価比で換算します。AI（cost-estimator、estimate-reviewer）は仕事の大きさ・種類・回数・件数とpriorの幅を返すだけで、見積もりの金額はkitが計算します（2026-10-13）。

**理由**: 実績の無い仕事の見積もりは粗く、modelで価格が何倍も違います。recordを個人の端末（`runs/`、gitignore）に置くと、人数分の実績が見積もりに届きません。recordは小さくpromptや出力を含まないので、commitしても秘密の経路になりません。金額をAIに推測させると根拠が検証できず、記録で補正もできません。方法そのものの変更は全PKGに効くので、PKG側の自動変更ではなく、kitのreview（PR）を通します。

**却下した代替案**: recordをgitignoreして各自の端末に置く案（共有されない）。1つの集計fileに追記する案（並行するbranchで必ずconflictする。run 1つにfile 1つ）。reviewerにpriorsを直接書かせる案（agentの書込経路が増える。CLIが答えを検査して書く）。kitが利用者のrecordを自動で送る案（tokenの埋め込みと送信先が要る。kit開発者の端末にあるPKGのrecordだけを使う）。

### D23: workflowのbrowser editorは手元のserverで、保存するのはYAMLだけ

**判断**: `aidev edit workflow <name>`は`127.0.0.1`にserverを立て、stepの流れの図、form、YAML、差分、見積もりを1つのpageで見せます。変更のたびにrunと同じ検証（`validateDefinition`、name、`resolveDependencies`）をserver側で行い、保存は検証が通ったときに`workflow.yaml`だけを書きます。approve・commit・submit・agentの起動はしません。APIは起動ごとのtoken（URLのfragment）、loopbackの`Host` / `Origin`、CSPで守ります（2026-10-13）。

**理由**: reviewerと責任者はYAMLの`until` / `for_each` / retryの組み合わせを頭で組み立てていました。図にすると流れとloopが一目で分かります。検証と書込をserver（CLIと同じcode）に置けば、pageは表示と入力だけになり、別の検証規則が生まれません。承認は`origin`との一致なので、保存を承認と混同させないことが重要です。

**却下した代替案**: 静的HTMLを書き出して見るだけにする案（直せない）。agentやskillもpageから編集する案（共有agentの変更は他のworkflowに波及する。`modify` / 手編集に残す）。`aidev submit`をpageのボタンにする案（pushと PR作成は外向きの操作で、terminalで明示的に行う）。外部のCDNのgraph libraryを使う案（offlineで動かず、CSPを広げる）。

### D24: workflowはtop-levelの`agents:`でagentに能力を足せる

**判断**: workflow.yamlのtop-levelに`agents: { <agent>: { skills, mcp, tools, subagents } }`を書けます（`subagents`は後から追加）。keyはstep（`agent:` / `until.agent:`）が使うagentと、それらが`subagents`に挙げるagentの名前だけです。`skills`・`mcp`・`subagents`はfrontmatterのものに足し、`tools`は書けばfrontmatterの`tools`を置き換えます。合わせた能力はfrontmatterの能力と同じ経路（promptへのskill差込、claudeの起動flag、guard-write）で強制し、`--dry-run`とsubmitのPR本文のstep一覧は合わせた後の能力を出します。stepごとの`skills` / `mcp` / `tools`は引き続き書けません（移動先をmessageで示す）。D18の「workflowで上書き・拡張しない」をこの範囲で改めます（2026-10-12）。

**理由**: 同じagentを、あるworkflowでだけ特定のMCP server（Azure DevOps）やskill（そのworkflow固有の手順書）付きで使いたい場面があり、frontmatterに足すとそのagentを使う全workflowに能力が広がります。workflowごとにagentを複製すると、本文の重複と修正漏れが増えます。D18が懸念した「reviewerがagentのfileだけでは実際の権限を読めない」点は、workflow.yamlが承認の対象（PRの差分に入る）であることと、submitのPR本文・`--dry-run`が各stepの実際の能力を出すことで補います。`tools`だけ置き換えにするのは、frontmatterが`tools`を書かない（既定の全部）agentに足すと何も変わらず、workflowで絞る手段にならないためです。

**却下した代替案**: stepごとの`skills` / `mcp` / `tools`（同じagentがstepで権限を変え、guardとreviewの単位がagentからstepに増える。権限が違うなら別agent、のままにする）。`tools`も和集合にする案（上記。既定の全部を持つagentを絞れない）。workflowが能力を減らす`deny`の類（frontmatterとworkflowの両方を読まないと結果が分からない。`tools`の置き換えで足りる）。

### D25: subagentは名前で許し、並列実行は同じ作業treeで「書く場所が重ならない」ことを条件にする

**判断**: agentは`subagents: [<name>]`（frontmatterかworkflowの`agents:`）で、`Agent` toolで起動してよいsubagentを名前で指定できます。指定したagentは、そのsubagentの定義（PKGか同梱のagent file）を`--agents`でその実行だけに渡され、guard-writeが`Agent` / `Task`の`subagent_type`と、subagent内の呼び出し（hook入力の`agent_id` / `agent_type`）をそのsubagentのgrantで判定します。subagentの`tools` / `mcp`は親の範囲内に限り、subagentは`subagents`を持てません。指定しないagentは従来どおりです。並列実行は2つです: `for_each.parallel: N`（対象をN件ずつ同時に。`writable`の全pathに`{item}`を要求し、guardは`AIDEV_WORKFLOW_ITEM`でその対象のpathだけを許す）と、`parallel:` group（agent stepを同時に起動し、全部終わってから次へ。member同士の`writable`、`writable`と他memberの`unchanged`が重なり得る定義は拒否）。どちらも同じ作業tree・同じbranchで動きます（2026-10-13）。

**理由**: subagentを名前で縛れないと、reviewerはagentのfileを読んでも、実行中にどの定義・どの権限のagentが動くかが分かりません（Claude Codeの組み込みgeneral-purposeは親と同じtoolを持つ）。subagentは親のsessionの中で動くので、親より広い権限は起動flagでもhookでも実現できず、書けても嘘になります。並列実行をworktreeで分ける案はD20で見送った理由（`node_modules`などgitignoreされた環境が無い、成果の合流でconflictする）が残るため、同じtreeのまま「同時に動くagentが同じfileを書けない」ことを定義の検証と書込ごとのguardで保証する形にしました。`{item}`を含むpathなら対象ごとの`writable`が構造上重ならず、`on_failure: continue`の戻しも他の対象に触れません。

**却下した代替案**: 件ごと・stepごとのgit worktree（上記。依存のinstallと合流の設計が先に要る）。`writable`の重なりを実行後のdiffで検出する案（壊れた後に分かる。書込時に止める方がよい）。subagentの権限を親と無関係に与える案（親のsessionの`--tools` / `--strict-mcp-config`の外のものは存在しない）。stepや`until`ごとのsubagent指定（権限の単位をagentに保つ。D18 / D24）。

**論点**: guard-writeのmatcherは書込・`Bash`・MCP・`Agent`だけなので、subagentの`Read` / `Grep`などはhookで見ず、`--agents`の`tools` / `disallowedTools`と親の`--tools`で絞ります。`--agents`のsubagentに`mcp__<server>`をallowする書き方は実機で未確認です。同時に動く`until.command`（同じport・DBを使うtest）はkitでは調停しません。費用の上限は同時に動く数だけ超え得ます。

### D26: 実行は専用のworktreeで、workflowごとに1つのbranchに、stepごとのcheckpointを積む

**判断**: `aidev run workflow`はPKGのcheckoutに触れず、`<AIDEV_HOME>/worktrees/<PKG>-<hash>/`の下のgit worktreeで動きます。branchはworkflowごとに1つ（`aidev/<name>`）で、実行のたびに同じbranch・worktreeを使い、`--dated`のときだけ`aidev/<name>-<yyyymmddHHMM>`を作ります。step（`for_each`なら件）が通るたびに、そのstepの`writable`の変更を`aidev(<name>): <step>`としてcommitします（checkpoint）。`--resume`はそのworktreeで、止まったstepの未commitの変更を戻して最後のcheckpointから続けます。実行記録（`runs/`）・notes・estimate recordはworktreeに置き、`--resume`・見積もり・`modify --from-run`はcheckoutと各worktreeを合わせて読みます。止まった実行からは`aidev modify workflow <name> --from-run <id>`で、記録（停止理由、繰り返した失敗の出力、確認役の指摘、失敗した件）をworkflow-creatorに渡して定義を直させ、その要約と原因を次の`aidev submit`のPR本文に入れます。submitのPR本文には、承認済みの版との差分（stepと項目）と見積もりの前後も入れます。D9のbranch名（`aidev/<name>-<yyyymmddHHMM>`）とpull-request stepのclean tree要求を改めます（2026-10-13）。

**理由**: 同じcheckoutで動かすと、実行中は人がそのcheckoutで作業できず、未commitの変更があると始められず、止まった実行の途中の変更が人の作業と混ざります。checkpointが無いと、`--resume`の起点が「作業treeに残っているもの」になり、止まったstepの半端な変更と終わったstepの成果を区別できません。実行ごとに日付のbranchを作ると、同じworkflowのPRが実行の数だけ並び、前の実行の成果に積めません。workflowの失敗は、agentが同じエラーに何度も当たって止まる形がほとんどで、その出力は実行記録に残っています。人がそれを読んで`--describe`に書き写すより、記録をそのまま渡す方が原因に近づき、PRのレビュアーも「なぜ定義が変わったか」を本文で読めます。worktreeをPKGの中ではなく`AIDEV_HOME`に置くのは、PKGで動くtest runner・linter・compilerが2つ目のsourceを拾わないためです。

**却下した代替案**: PKGの中（`.aidev/worktrees/`、gitignore）にworktreeを置く案（jest等がgitignoreを見ずに探索する）。実行記録をcheckoutに置きworktreeから参照する案（agentはcwdの外のfileを読めず、guardはrepoの外への書込を拒否するので、notesと報告がworktreeの外では使えない）。checkpointを`git stash`や別refに取る案（PRでstepごとに読めない）。新しい実行で前の実行のbranchを捨てる案（未mergeの成果が消える。mergeされていればbaseへ進め、未mergeならbaseをmergeする）。`--from-run`で失敗を自動で直して実行し直す案（定義の変更はPRのレビューを通す。D9）。

**論点**: gitが無視するもの（`node_modules`、`.env`、build結果）は新しいworktreeに無いので、要るworkflowはcommand step（`npm ci`等）で用意します。worktreeは自動では消しません（`git worktree remove`）。試走（D27）のbranch `aidev/<name>.trial`はこの判断の例外で、試走のたびにbaseへresetし、前の試走の成果を積みません。commandで作れないdata（仕様書など）は`provide:`（D29）と`file: true`の入力（D28）でworktreeへ持ち込めるようになりました。

### D27: 承認前の定義は`--trial`で試走し、試走はpushもPR作成もしない

**判断**: `aidev run workflow <name> --trial`は、checkoutにある今の定義（未commitの編集を含む`workflow.yaml`と、参照するPKG内のagent / skill）を、承認の有無に関わらず最後まで動かします。branchは`aidev/<name>.trial`（`--dated`で`aidev/<name>.trial-<yyyymmddHHMM>`。workflow名に`.`は使えないので、`aidev/<name>`や他のworkflowのbranchと衝突しません）、worktreeは通常の実行と同じ`<AIDEV_HOME>/worktrees/<PKG>-<hash>/`の下の専用のものです。pushもPR作成もしません: pull-request stepはcommitまで行い（本文に`approved: none (a trial run of the definition sha256:…)`と`trial run: not pushed`）、pushとPRを飛ばします。guard（`policy.decide`の第6段と`decideToolUse`）は、`origin/<tracking_branch>`との一致の代わりに、runnerがworktreeのgit directory（作業treeの外。`aidev-trial.json`）に書いた記録`{ name, token, hash }`と、agentの環境変数`AIDEV_WORKFLOW_TRIAL=<token>`を見ます。`hash`はreviewed files（workflow.yamlとPKG内のagent / skill）のpathとLF正規化した内容のsha256（`reviewedHash`）で、書込とtool呼び出しのたびにworktreeのfileから計算し直し、名前・token・hashが一致する間だけstepの`writable`を許します（rule id `workflow-trial-writable`。理由文は「a trial run of the definition sha256:…」で、「approved on」とは言いません）。記録は`run.json`に`trial: true`・`trialHash`・`approvedRef: null`・`approvedSha: null`として残ります（2026-10-14）。

これはD6 / D9の「承認 = `origin/<tracking_branch>`との一致」を次のように狭めます: **pushできる実行の根拠は、引き続きhostingの承認（tracking branch）だけ**です。手元の記録が許すのは、runnerがpushできない実行に限ります。pushできないことは4つで保証します: (1) pull-request stepがpushとPR作成を飛ばす、(2) 全child process（agentもcommand stepも）に`GIT_CONFIG_*`環境変数で`core.hooksPath`（kitの`cli/git-hooks/no-push/`。`pre-push` hookが拒否する。単一値なので、repositoryに`pushurl`があっても効く）と`remote.origin.pushurl`・`url.….pushInsteadOf`（https / http / ssh / git@）を渡し、`git push`を失敗させる（stepの`env`はrunnerの項目を上書きできず、`GIT_CONFIG*`は`env`に書けない）、(3) argvが`git … push`のcommand step / `until.command`は起動前に拒否する（「pushes; a trial run pushes nothing」）、(4) hook（guard-write）がBashの`git … push` / `gh pr create` / `az repos pr create` / `glab mr create`をdenyする。

**理由**: workflowは試行錯誤で完成するのに、承認を経ないと動かせないと、1回の修正ごとにPRのreviewとmergeが挟まり、`main`が未完成の定義のcommitで埋まります（`proposals/2026-10-14-workflow-trial-inputs-provide.md`）。承認が守っている線は「AIがPKG sourceを書ける範囲はreviewされた定義の`writable`だけ」で、試走はこの線の外へ出る経路（pushとPR）を閉じたうえで、承認の前に定義をそのまま動かします。

脅威model: reviewされていない定義でも、agentにMCP serverとallow-listedなBashを与えられます。これは対話sessionと同じ露出に、使い捨てのworktreeの中でのstepの`writable`を足したものです。試走が縛るのはrunnerとgitであって、reviewされていない定義のあらゆる副作用ではありません。記録は作業treeの外にあるので、Write / Editはrule 1で拒否され、Bashが届くかはPKGのallow ruleが許す範囲で、これは今のoriginのrefと同じ露出です。tokenはagentの環境変数にだけあり、file・log・出力には出しません。実行中に定義（か使うagent / skill）を編集するとhashが変わり、承認済みworkflowを編集すると承認を失うのと同じく、以後の書込が拒否されます。記録は実行の終わり（Ctrl-C / SIGTERMでも）に消し、crashで残ったものはtokenがどの環境にも無いので不活性で、次の試走が上書きします。

試走のbranchは使い捨てです: 新しい試走のたびにbaseへ`reset --hard`し、前の試走が残した未commitのfileを消します（gitが無視するものとD29の残骸は残す）。これはD26の「branchを保ち、baseをmergeして積む」の意図的な例外で、試走は「ここから実行したら何が起きるか」を見せるものであり、前の試走の上に積むものではないからです。試走の`--resume`には`--trial`が要り（通常の実行は`--trial`無しで。種類は記録のbranch名から読み、記録のflagは信用しない）、checkoutのreviewed filesのhashが記録の`trialHash`と一致しなければ「start a new trial」です。`--resume last`は同じ種類の最新の実行（`--trial`なら最新の試走、無しなら試走でない最新の実行）です。試走の記録は見積もりの学習（`readRecords` / `collectHistory`）から除き、試走の後に自動のestimate reviewerも起動しません。`aidev modify workflow --from-run`は試走も受け付けます。

**却下した代替案**: 承認の基準refをworkflowごとに変える`--approval-ref`（「どのbranchが承認か」が増えて汚染が移るだけで、pushしない保証も得られない）。定義をcommitしてそのcommitを承認扱いにする（試行錯誤のたびにcommitが要り、wip commitがPRに混ざる）。`--dry-run`を拡張してagentを起動する（`--dry-run`は「何も始めない」契約）。別の動詞`aidev try workflow`（`run`のflagのほうが`--resume` / `--task` / `--input` / `--log`と記録の形を共有できる）。hostingのPATを環境から外す（MCP serverが必要とすることがある）。試走の終わりにworktreeを消す（結果と記録を見てから`submit`する。削除は未決の論点）。

**論点**: 試走を止めても、command stepが起動したもの（container serverなど）は止まりません（未決の論点「実行の後始末」）。試走のworktree / branchは自動では消しません。

### D28: 実行ごとに変わる値は`inputs:`で宣言し、`--input name=value`で受け取る

**判断**: workflow.yamlのtop-levelに`inputs: { <name>: { description, default, pattern, path, file } }`を書き、`aidev run workflow <name> --input spec=docs/spec/login.txt --input browser=firefox`（繰り返し可）で値を渡します（`aidev estimate workflow`も`--input`を取ります）。`default`の無い入力は必須で、`required:` keyはありません。`{inputs.<name>}`を書ける場所は`objective`、agent stepの`prompt`、`until.prompt`、`until.command`、command stepの`command`、`env`の値（stepと`until`）だけで、`description`・stepの`description`・`pull_request.title`・`writable`・`unchanged`・`cwd`・`for_each.from`に書くと検証errorです。commandの実行file（argv[0]）にもできません。置換は実行前に定義に対して行い（inputsが先、`{item}`は対象ごとに後）、値は`{`と`}`を含めません（値はtemplateではない）。commandかenvの値に届く入力は`pattern`か`path: true` / `file: true`が必須で、その上で固定のwhitelist `^[A-Za-z0-9._@][A-Za-z0-9._/@:=+-]{0,999}$`（`..`のsegmentなし）を満たすことを要求します（for_each対象の`ITEM_RE`と同じ考え。作者の`pattern`は狭めるだけで、広げられません）。`path: true`はrepo相対のpathで、text file（referenceと同じく非textの拡張子を拒否）で、worktreeに届くもの（HEADでtracked、またはcheckoutでignoreされていて`provide`のglobに合う）でなければ起動前に止まります。`file: true`はこの端末のfileで、runnerが`.aidev/workflows/<name>/runs/<id>/inputs/<name><ext>`（worktree内、`runs/`ごとgitignore、agentが読める、commitされない）へ複製し、`{inputs.<name>}`はその複製のrepo相対pathです。`--resume`では記録の値を「与えられたもの」として検査し直します（`run.json`はagentが書けるfileなので）。`--task`は従来どおり自由文です（2026-10-14）。

**理由**: ITテスト作成のように「テスト仕様書」「browser名」を実行ごとに渡したい場面があり、`--task`の自由文に埋めるとagentが読み解くことになり、commandには入れられません。宣言すれば、kitが起動前に検査でき（無い・不正な値でagentを起動しない）、reviewerは`{inputs.<name>}`がどこに入るかをYAMLで静的に読めます。`writable`に書けないのは、reviewで書ける範囲が読めなくなるからです。commandに届く値をwhitelistで縛るのは、`{item}`と同じく、argvの1要素になる文字列にoptionや上のdirectoryを指すものを通さないためです。`file: true`は1人が持つfile（Excelから書き出した仕様書）のためで、teamが決まったignore済みのpathに置くdataは`provide`（D29）です。

**却下した代替案**: `--task`を構造化する（自由文の用途が消える）。入力を`writable`に書けるようにする（上記。件ごとのpathが要るなら`for_each`）。`required:` key（`default`が無ければ必須、で足り、同じことを2通りで書かせない）。入力をYAML fileで渡す（`--input`の繰り返しで足り、CIからも渡せる。要望があれば足す）。

### D29: gitが無視するdataは`provide:`でcheckoutから補給し、toolchainの残骸は`never_commit`で決してcommitしない

**判断**: `provide: [<glob>]`は、実行の開始時（最初のstepの前。`--resume`でも）に、checkoutでgitが無視しているfileのうちglobに合うものを、file単位でworktreeの同じpathへ複製します（上書き）。`git ls-files --others --ignored --exclude-standard`の列挙は、1 fileに合うglobでもignoreされたdirectory全体を挙げることがあるので、kitのmatcherで絞り直します。tracked fileと無視されていないuntracked fileは複製しません（実行はHEADから始まる）。`secrets_paths`に合うもの、`.aidev/`・`.git/`の下、symbolic link、最後の名前が認証情報のfile（`.env`、`.env.*`、`.npmrc`、`.netrc`、`.pypirc`、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`*.jks`、`*.keystore`）に見えるglobも複製しません。複製したfileはworktreeでもignoreされていなければならず（commit済みの`.gitignore`の規則で）、そうでなければ実行を止めます。checkoutで1つも合わないglobは、`--dry-run`と`run`を起動前に止めます。残骸は、kitの`NEVER_COMMITTED`（`**/node_modules/**`、`**/bower_components/**`、`**/.pnpm-store/**`、`**/.yarn/cache/**`、`**/.venv/**`、`**/venv/**`、`**/__pycache__/**`、`**/*.pyc`、`**/.pytest_cache/**`、`**/.mypy_cache/**`、`**/.ruff_cache/**`、`**/.tox/**`、`**/.nox/**`、`**/.gradle/**`、`**/.DS_Store`、`**/Thumbs.db`、`**/*.orig`、`**/*.rej`）とworkflowの`never_commit: [<glob>]`に合う**untracked**なfileで、決してcommitしません（tracked fileへの編集はどこにあってもrunの成果です）。適用箇所はstepと件のcheckpoint、pull-request stepの最終stage、`unchanged`の比較、失敗した件の戻し、until agentに見せるdiff、新しい実行の前の「未commitの変更」検査です。除いたpathは、log・`run.json`（stepの`leftOut`）・画面・PR本文（「## Left out」）で報告し、黙って捨てません。`never_commit`はstepの`writable`や`provide`の項目を覆えません（検証で拒否）（2026-10-14）。

**理由**: worktreeにはgitが無視するものが無く（D26の論点）、command stepで作れるもの（`npm ci`）はそれで足りますが、別リポジトリ由来の仕様書のようにcommandで作れないdataには手段がありませんでした。tracked fileやcheckoutの未commit変更を持ち込まないのは、「実行はHEADから始まる」を保つためです（試走でreviewed filesだけを持ち込むD27と同じ線）。残骸は、`until.command`やcommand stepの`npm ci`が`writable`の中（`.gitignore`の無い新しい`e2e/`など）に`node_modules`を作り、checkpointとpull-request stepが`writable`の中の変更をすべてstageするのでPRに入っていました。作る人がこれを予見できず、agentは自分の責務以上のこと（`.gitignore`を書く）をしません。untrackedに限るのは、vendoredでcommit済みの`node_modules`のfileをstepが編集したときに、それを隠してはいけないからです。build出力（`dist/`、`build/`、`target/`）をkitのlistに入れないのは、成果物のことがあるからです。

**却下した代替案**: `node_modules`のsymlink / hardlink（`npm ci`がcheckoutの`node_modules`を消す。Windowsの権限、cross-platformの差）。`.git/info/exclude`に書く（worktreeで共有され、人のcheckoutの`git status`も変わる）。`provide`を`aidev.yaml`に書く（要るかどうかはworkflowごとに違い、定義と一緒にreviewされるべき）。file数の閾値で止める（根拠が無く、止まると実行が無駄になる）。build出力をkitのlistに入れる（上記）。pathspecの`:(exclude,glob)`でtracked / untrackedを問わず隠す（最初の実装。tracked fileへの編集まで見えなくなった）。

**論点**: `provide`の複製は毎回上書きで、変更の無いfileを飛ばしません。`node_modules`を`provide`に書くこともできますが、複製は遅く、worktreeのlockfileと違えば壊れます。依存はcommand stepで入れます。

### D30: 標準workflowはkitが雛形として同梱し、`--from`で複製してPKGのものにする。PKGごとの値は`aidev.yaml`の`workflows.<name>.inputs`と`env_required`の環境変数で受け取る

**判断**: よくある仕事のworkflow（最初は`playwright-tests`: テスト仕様書の1ケースごとにPlaywrightのtestを書き、batchごとに通るまで直し、全体をreviewer agentが仕様と突き合わせてPR）を`templates/workflows/<standard>/`に`workflow.yaml`とagent / skillの組で同梱します。kitの中では動かず、`aidev create workflow <name> --from <standard>`がPKGの`.aidev/workflows/<name>/`・`.aidev/agents/`・`.aidev/skills/`へ複製し、以後はPKGが書いたworkflowと同じ扱い（`--trial`、submit、origin一致による承認、`modify`、`remove`）です。実行時にkitの雛形を参照する経路はありません。PKGごとに違うものは定義の外で受け取ります: 実行ごとに変わらない値（対象環境のURL、テストユーザー名）は`inputs:`に宣言し、PKGが`aidev.yaml`の`workflows.<name>.inputs`に書く（`--input` > `aidev.yaml` > `default`。`--input`と同じ検証）。認証情報（パスワード）は新しいtop-level `env_required:`に名前（と説明）だけを宣言し、実行する人のshellの環境変数で渡す。runnerは`preflight`で設定されていることを名前で確かめ（無ければ何も始めない）、値は読まず、agentとcommandには従来どおり環境として届き、prompt・記録・log・PR本文のどこにも値を書かない。`aidev.yaml`は認証情報らしい名前のinput（`password` / `token` / `secret` / `pat` / `api_key`…）を拒否する。あわせてagent stepにも`env:`（command stepと同じ固定値。`{inputs.<name>}`可）を書けるようにし、agentのprocessと`until.commands`の両方に渡す: agentが自分で走らせるtestとrunnerの判定が同じ設定（対象環境のURL）で動く（2026-10-21）。標準workflowの動作は、kitの中で動かない以上、通常のtestでは確かめられないので、**sandbox**（`npm run sandbox -- <standard>`）を置きます: 使い捨てのPKGへ`--from`で複製し、LLMの代わりに筋書き（`<standard>/sandbox/scenario.js`、必須）どおりにfileを書くscripted agentを`AIDEV_CLAUDE_BIN`で指して`run --trial`を実commandで通し、全stepの成功・push無し・`env_required`の値の非漏洩・筋書きの`expect`を検査する。筋書きには「1件目は間違えて書き、再試行で直す」のような失敗経路も入れる（2026-10-22）。

**理由**: 同じ仕事（仕様書からのIT test作成）を複数PKGで繰り返すとき、各PKGがworkflow-creatorに一から書かせると品質がばらつき、kit側で練った手順（batch化、`for_each.parallel`、smoke testによる環境確認、reviewer agent）が届きません。一方で「PRでreviewされてmainにあるものだけが動く」（D6 / D9）と「`writable`やcommandはPKGの配置に依る」（`writable`にinputは書けない、D28）を保つには、kitのfileを実行時に参照する形ではなく、PKGが自分のfileとして持ちreviewする形が要ります。複製後にkitの版が進んでも承認済みworkflowの動作は変わらず、取り込みは`--from … --force`の差分reviewとして明示されます。PKGごとに違う「値」を定義に書くと、PKGごとにYAMLが変わり共有できないので、`inputs`の値の出所として`aidev.yaml`を足しました（`--input`を毎回打たなくてよい。`aidev.yaml`はPKG所有でreviewされる。agentも書けるfileだが、値は`--input`と同じく「data」で、commandに届く値はwhitelistで縛られる）。パスワードは`inputs`（run.json・log・PR本文・promptに出る）にも`aidev.yaml`（commitされる）にも`env`（reviewされるYAML）にも置けないので、「shellの環境変数で渡し、kitは名前だけを検査する」を`env_required`として定義に書けるようにしました。従来も環境は子processに引き継がれていましたが、宣言が無いと欠落に気付くのがtestの失敗と再試行の後になります。

**却下した代替案**: kitのworkflowを実行時に名前で解決し、kit versionで信頼する案（agent / skillと同じ扱い。`writable`・command・依存の入れ方がPKGごとに違い、どのみち複製して直す必要がある。承認の線（origin一致）も崩れる）。`inputs`に`secret: true`の種類を足す案（値がinputsの経路（記録・prompt）を通る。別の経路にするなら名前だけの宣言で足りる）。`provide`で`.env`を持ち込む案（D29で拒否済み。fileは残る）。`aidev.yaml`に`env`の値を書く案（commitされる）。標準workflowを`templates/claude/.claude/agents/`のagentとして配る案（`sync tools`で全PKGの`.claude/agents/`に入り、対話sessionのsubagentにもなってしまう。標準workflowのagentは複製先の`.aidev/agents/`にだけ置く）。

## 未決の論点

| 論点 | 内容 | 関連 |
| --- | --- | --- |
| policyのcustomize | `aidev.yaml`から`read_only` / `writable`を生成できるようにするか。`create policy --approve`が生成し直して手編集を消す点をどう扱うか | D4、D6 |
| PR後のWiki追従 | `pull-request` stepの直後にrunnerが`aidev sync wiki`を呼ぶか（今はnightly pipelineか人手） | D9、D5 |
| 実行履歴の集約 | PRを作らないrunの`run.json`をWork Item commentや`aidev/audit` branchへ集めるか | D9 |
| `base ahead of knowledge`の扱い | WARNのままか、`--strict`以外でもexit 2にするか | D5 |
| 開発中のWiki追従 | branch上のHEADを対象にhookとsub-agentでWikiを追従させる仕組みは実装済み（`hook after-bash` / `session-stop`、`implementation-status.md`。設計は`proposals/2026-09-21-wiki-auto-update.md`、`2026-09-22-wiki-update-flows.md`）。claude以外のtoolで実機検証していない点が残る | D5、D11、D12 |
| 段階的配布 | `origin/main`のmergeが即時に全員へ通知される点を、tag pinやcanaryで緩和するか | D10 |
| page単位のevidence依存 | supporting evidence変更時の全件再queueを減らす | D12 |
| 追加tool / provider | 次に対応するtoolとhosting、強制水準の差の扱い | D7、D8 |
| self-evolutionの運用 | 閾値、`--auto`の既定、PR作成の経路 | D13 |
| 登録PKGへの一括実行 | `aidev sync tools --all` / `aidev check --all`でregistryの全PKGに順に実行するか。`--json`の形（PKGごとの配列か）、exitを最悪値にするか、`missing`のPKGを報告するか | D19 |
| 実行の後始末 | 実行の終わり（止まった試走を含む）に必ず走る`cleanup:`のcommand listを足すか。command stepが起動したcontainer serverは、試走を止めても動き続ける | D27、D20 |
| 試走のworktree / branchの処分 | 試走のworktreeとbranch（`aidev/<name>.trial`）を自動で消すか、一覧する（`aidev list workflows`）に留めるか。今は`git worktree remove`で手動 | D26、D27 |

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
