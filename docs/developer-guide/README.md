# ai-dev-kit developer guide

このディレクトリは、**ai-dev-kit本体（CLI・template・同梱Agents/Skills）を設計・実装・レビュー・リリースする人**のための資料です。

利用者向けの導入・日常運用は`docs/user-guide/`（AsciiDoc、`npm run docs:build`で日本語版と英語版のHTML）を正本とします。ここには対象PKGの業務知識を置かず、逆にai-dev-kitの内部実装を利用者向けガイドや生成Wikiへ混在させないでください。

対象は **PKG clone方式**（0.2.0で採用、現在は`package.json`の版）です。`aidev`は利用者のPKG git cloneの中で動き、kitが追加するファイルはすべてそのPKG repositoryへcommitされます。

## 資料一覧

| ファイル | 内容 |
| --- | --- |
| [architecture.md](architecture.md) | PKG clone内の配置、`AIDEV_HOME`、tool configのtemplate適用（3-way merge）、3SHA（source-tree比較）、sync lease、Wiki inventory / manifest v3とbatch agent実行、worktreeベースのsync、hooks、policy評価順序（agent単位の許可を含む）、workflow、MCP、update、self-evolution |
| [cli-reference.md](cli-reference.md) | 全command・subcommand・option・終了code。`aidev <cmd> --help`と一致させる |
| [configuration-reference.md](configuration-reference.md) | `aidev.yaml` schema v2（`validateConfig` / `DEFAULTS`）、`.aidev/policy.yaml`（`agents`を含む）、`DEFAULT_POLICY_SCOPES`、model解決、環境変数、CLIが書く各fileの形 |
| [implementation-status.md](implementation-status.md) | 実装済み・部分実装・未実装の台帳、既知の不整合、保守時の完了条件 |
| [design-decisions.md](design-decisions.md) | 採用した設計判断と却下した代替案、未決の論点 |
| `proposals/` | 実装前の設計文書。実装したら上記へ反映し、設計文書は削除する（履歴はgitに残る） |

## 文書化の原則

1. **現在の実装と将来設計を分ける。** codeから到達できない経路を、利用可能な機能として利用者ガイドへ書かない。将来設計は`proposals/`に置き、`implementation-status.md`から参照する。
2. **公開契約はcodeとtestを正本にする。** command一覧とhelpは`cli/bin/aidev.js`と各moduleの`FLAGS` / `FLAG_HELP`、設定は`cli/lib/config.js`、exit codeは`cli/lib/errors.js`を参照する。文書とcodeが食い違ったらcodeを直すか文書を直すかを決め、放置しない。
3. **生成物の読者を混ぜない。** `.aidev/knowledge/`は対象PKGをAIへ説明する派生情報であり、本kitの保守資料ではない。
4. **認証情報を例へ埋め込まない。** 例では環境変数名（`hosting.auth_env`）だけを示す。`validateConfig`はtokenらしき値を拒否する。
5. **安全機構を過大評価しない。** hooksは補助防御であり、最小権限のtoken、`aidev check`を必須にしたCI、branch policy、人間レビューが最終防御となる。
6. **撤去した語彙を持ち込まない。** wrapper repository、`src/` submodule、`.aidev-lock`、`aidev kit apply`、`aidev plan`、`aidev task`、work lease、`submoduleSha` / `remoteSha`、`pending-refresh.json`、`self_evolution`設定は現在のcodeに存在しない。codeのcommentに残っている箇所は`implementation-status.md`の「既知の不整合」に列挙している。

## ソース上の主な正本

| 関心 | 正本 |
| --- | --- |
| CLI routing / help / update通知 | `cli/bin/aidev.js` |
| PKG内の配置とkit管理path | `cli/lib/layout.js` |
| `AIDEV_HOME`（registry、update check cache、`developer.json`） | `cli/lib/home.js` |
| `aidev.yaml` / policy schema、既定値 | `cli/lib/config.js` |
| 初期化 | `cli/commands/init.js` |
| AI tool adapter（registry、binary解決、argv、結果のparse） | `cli/lib/tools.js` |
| tool configの適用・検査 | `cli/lib/assets.js`、`cli/commands/apply.js`、`templates/<tool>/` |
| self-update | `cli/commands/update.js` |
| 3SHA | `cli/lib/state.js`、`cli/lib/git.js` |
| Wiki manifest / inventory / 完了報告 | `cli/lib/inventory.js` |
| evidence scope | `cli/lib/knowledge-scope.js` |
| agent起動（batch、prompt、launcher、`AIDEV_AGENT`） | `cli/lib/agent.js`、`cli/commands/agent.js` |
| `knowledge build` / `status` | `cli/commands/knowledge.js` |
| sync（worktree、branch、PR） | `cli/commands/sync.js`、`cli/lib/ado.js` |
| sync lease | `cli/lib/leases.js` |
| policy評価（agent単位の許可を含む） | `cli/lib/policy.js`、`cli/lib/paths.js`、`cli/commands/permission.js` |
| hooks | `cli/commands/hook.js`、`templates/claude/.claude/settings.json` |
| workflow | `cli/commands/workflow.js` |
| self-evolution（kit開発者のみ） | `cli/commands/evolve.js`、`cli/agents/evolution.md`、`cli/commands/hook.js`（`sessionStop`） |
| self-evolution（kit開発者向け） | `cli/commands/evolve.js`、`cli/agents/evolution.md`、`cli/commands/hook.js`（`session-stop`） |
| eject | `cli/commands/eject.js` |
| uninstall | `cli/commands/uninstall.js` |
| MCP launcher | `cli/commands/mcp.js`、`templates/claude/.mcp.json` |
| 同梱Agents / Skills | `templates/claude/.claude/agents/`、`templates/claude/.claude/skills/`（他toolの形式は`templates/copilot/`、`templates/codex/`、`templates/kiro/`に手で同期） |
| installer | `scripts/install.ps1`、`scripts/install.sh` |
| pipeline例 | `pipelines/` |
| 利用者ガイド | `docs/user-guide/`、`scripts/build-docs.js` |

## 保守者向け検証

```bash
npm run lint        # 全moduleのload確認（test/loadall.js）
npm test            # test/run.js（各suiteはnode test/<file>.jsで単独実行可）
npm run check       # 上記2つ
npm run docs:check  # 利用者ガイドのbuildと必須ID検証
```

testは実際の`claude`を起動しません。agent経路は`AIDEV_CLAUDE_BIN`でstubを指します。CLIを起動するtestは`AIDEV_HOME`を一時directoryへ、`AIDEV_NO_UPDATE_CHECK=1`を必ず設定します（設定しないとregistryが本物のhomeへ書かれ、update checkがnetworkへ出ます）。self-evolutionのtestは`AIDEV_HOME`を一時directoryにした上で`aidev evolve enable`か`AIDEV_KIT_DEVELOPER=1`で開発者端末の状態を作り、`evolve run`の実起動（kit checkoutのworktree作成）は行いません。

help出力を文書へ写すときは次で実際に確認します。

```bash
AIDEV_NO_UPDATE_CHECK=1 node cli/bin/aidev.js --help
AIDEV_NO_UPDATE_CHECK=1 node cli/bin/aidev.js <command> --help
```

`package.json`は`private: true`で、Node.js 20以上を要求します。npm packageとして配布せず、専用にcloneしたai-dev-kit checkout（`installRoot`）へinstallerがlauncherを作ります。installerは`aidev.yaml`や`.aidev/`を持つdirectory（kitを使うPKG）からのinstallを拒否し、checkoutが`main` branchで`origin`を持つことを要求します。

## kit更新の流れ

`aidev update`は、launcherが指すkit checkoutを`origin/main`へfast-forwardするだけです。PKGへの適用は各PKGのteamが`aidev apply`で行い、`templates/<tool>/`を3-way mergeで取り込んで`.aidev/materialized.json`を書き直します。結果はPKG cloneの通常のdiffなので、利用者がreviewしてcommitします。kit側で配布物を変えるときは次を同時に更新してください。

- `templates/<tool>/**`（→ PKG rootにそのまま重なる。claudeは`.claude/**`、`CLAUDE.md`、`.mcp.json`。copilot / codex / kiroの木も同じ趣旨で揃える）
- `layout.TOOL_CONFIG_GLOBS`（kit所有pathの正本。`KIT_MANAGED_GLOBS`、`config.ALWAYS_PROTECTED`、`assets`のdrift検出がこれに従う）
- `templates/claude/.claude/settings.json`のdeny list（protected pathを増やした場合）
- `test/assets.test.js`など配布物を検証するtest

kit自身に同梱するが PKG には配布しないagent（self-evolutionの`evolution`）は`cli/agents/`に置きます。`aidev evolve run`がその定義をpromptへ埋め込んで起動します。
