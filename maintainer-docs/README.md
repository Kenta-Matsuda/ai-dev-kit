# ai-dev-kit maintainer documentation

このディレクトリは、**ai-dev-kit本体を設計・実装・レビュー・リリースする人**のための資料です。

利用者がPKG知識を置く`docs/knowledge`や、ai-dev-kitがラッパーリポジトリに生成する`knowledge/`とは用途が異なります。ここにはPKGの業務知識を置かず、逆にai-dev-kitの内部実装を生成Wikiへ混在させないでください。

## 資料一覧

| ファイル | 内容 |
| --- | --- |
| [architecture.md](architecture.md) | wrapper構成、静的asset、3SHA、lease、Wiki inventory、sync、hooks、policy、workflow、MCP |
| [configuration-reference.md](configuration-reference.md) | `aidev.yaml`の全設定、既定値、制約、モデル解決 |
| [cli-reference.md](cli-reference.md) | 公開CLI、内部subcommand、終了コード、dry-run、冪等性、eject |
| [implementation-status.md](implementation-status.md) | 実装済み・部分実装・未接続の区別、既知の制約、将来状態機械、保守上の未決事項 |

利用者向けの導入・日常運用はルートの[README.md](../README.md)を正本とします。

## 文書化の原則

1. **現在の実装と将来設計を分ける。** 実装されていない経路を、利用可能な機能としてREADMEへ書かない。
2. **公開契約はコードとテストを正本にする。** command一覧は`cli/bin/aidev.js`、設定は`cli/lib/config.js`、exit codeは`cli/lib/errors.js`を参照する。
3. **生成物の読者を混ぜない。** `knowledge/`は対象PKGをAIへ説明する派生情報であり、本kitの保守資料ではない。
4. **認証情報を例へ埋め込まない。** 例では環境変数名だけを示す。
5. **安全機構を過大評価しない。** hooksは補助防御であり、最小権限認証、CI、branch policy、人間レビューが最終防御となる。

## ソース上の主な正本

| 関心 | 正本 |
| --- | --- |
| CLI routing / help | `cli/bin/aidev.js` |
| `aidev.yaml` / policy schema | `cli/lib/config.js` |
| 初期化 | `cli/commands/init.js` |
| CLI self-update | `cli/bin/aidev.js`、`cli/commands/update.js` |
| wrapperのkit assetとlock | `cli/lib/assets.js`、`cli/commands/kit.js` |
| 3SHA | `cli/lib/state.js` |
| Wiki manifest / inventory / evidence scope | `cli/lib/inventory.js`、`cli/lib/knowledge-scope.js`、`cli/commands/knowledge.js` |
| syncとwrapper PR | `cli/commands/sync.js`、`cli/lib/ado.js`、`cli/lib/leases.js` |
| policy評価 | `cli/lib/policy.js`、`cli/commands/permission.js` |
| hooks | `cli/commands/hook.js`、`templates/claude-assets/settings.json` |
| workflow | `cli/commands/workflow.js` |
| 同梱Agents / Skills | `templates/claude-assets/agents/`、`templates/claude-assets/skills/` |
| pipeline例 | `pipelines/` |

## 保守者向け検証

```bash
npm run lint   # 全moduleのload確認
npm test       # test/run.js
npm run check  # 上記2つ
```

`package.json`は`private: true`で、Node.js 20以上を要求します。公開npm packageとしての配布ではなく、専用にcloneしたai-dev-kit checkoutへinstallerがlauncherを作る方式です。開発者がwrapper checkoutからinstallすることは拒否し、旧wrapper pipelineの移行互換として`TF_BUILD=True`の一時環境だけを例外にします。

## 更新時の注意

`aidev update`は、launcherが指すCLI専用ai-dev-kit checkoutを固定の`origin/main`へfast-forwardします。wrapperのremoteやworktreeは更新しません。wrapperを導入元にした旧launcherは拒否されるため、専用checkoutからinstallerを再実行してください。

wrapperへ中央kitの管理対象を取り込む操作は`aidev kit apply`へ分離されています。対象は次に限定されています。

- `templates/claude-assets/`
- `CLAUDE.md`
- `.mcp.json`
- `cli/`
- `scripts/`

`package.json`、`pipelines/`、`.gitignore`、この`maintainer-docs/`はwrapperへの自動適用対象ではありません。対象を広げる場合は、`cli/commands/kit.js`の`KIT_PATHS`、ドリフト検出、移行手順をまとめて設計してください。
