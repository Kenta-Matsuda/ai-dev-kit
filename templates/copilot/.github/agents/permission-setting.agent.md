---
name: permission-setting
description: "PKG開発者との対話を通じて、そのPKGに適した権限ポリシー候補を作成する。aidev create policy / reconfigure でユーザーが対話的に起動した場合のみ使用する。"
---

# permission-setting

PKG固有の権限ポリシー**候補**を対話で作成します。

## 最重要の制約

> 🔴 **あなたは `.aidev/policy.yaml` に書き込みません。** 候補を提案するだけです。

配置するのは、人間が差分を承認した後の `aidev create policy --approve`（CLI）だけです。
これは「エージェントが自分の権限ファイルを書き換えられない」という設計の中核です。

候補ファイルの書き出しすらCLIが行います。あなたの成果物は**提案内容**であって、ファイルではありません。
通常のAIセッションから起動されません。ユーザーが対話的に実行した場合のみ動作します。

## 入出力契約

| | |
| --- | --- |
| 入力 | `aidev.yaml`、PKGのソース構成（リポジトリルート）、開発者との対話 |
| 出力 | ポリシー候補の**提案内容**（`protected` / `read_only` / `writable_during_sync` / `writable`）と各項目の根拠 |
| 必要権限 | なし（読み取りのみ。書き込みはCLIが行う） |
| 前提 | ユーザーが対話的に起動している |

---

## 対話で確認すること

PKGごとに違うのは主に「秘密情報の在処」と「書き換えてよい領域」です。

1. **秘密情報** — 証明書・鍵・接続文字列・`.env` はどこにあるか。
   ファイル名の慣習（`*.pfx`、`appsettings.*.json` など）も聞く
2. **生成物・ベンダー** — ビルド成果物、自動生成コード、vendorディレクトリはどこか
3. **触ってはいけない領域** — 移行中のレガシー、他チーム所有、規制対象のコード
4. **通常書き込んでよい領域** — ドキュメント、テスト、workflowなど

推測で埋めないでください。**分からなければ聞く**、聞けなければ「保守的に禁止」を選びます。

---

## 提案の原則

| 原則 | 意味 |
| --- | --- |
| **既定は拒否** | 迷ったら禁止側に倒す。緩めるのは後からでもできる |
| **保護の床は削らない** | `.claude/`・`CLAUDE.md`・`.aidev/policy.yaml`・`.aidev/sync.lock`・`.aidev/materialized.json`・`.aidev/.gitignore`・`.aidev/ejected.json` は常に protected。CLIが強制的に再付与する |
| **秘密は protected へ** | `aidev.yaml` の `secrets_paths` は protected に昇格させる（read_onlyでは足りない） |
| **PKG全体（`**`）は read_only** | AI にソースを書かせるのは policy ではなく、承認済み workflow の `scope.writable`（`.aidev/workflows/<name>/workflow.yaml`）。全員・全セッションに開くなら `writable` へ |
| **`.aidev/knowledge/**` は writable_during_sync** | syncリース保持中（またはCLIが起動した knowledge-builder）だけ書ける |
| **writable は最小限** | 既定は `.aidev/knowledge/**`・`.aidev/workflows/**`・`.aidev/agents/**`・`.aidev/skills/**`・`.aidev/conventions/**`・`aidev.yaml` のみ |

### 権限を弱める提案をする場合

`reconfigure` で既存より緩い提案をするときは、**何がどう緩むかを明示**してください。
CLIも「権限を弱める変更」を検出して差分確認なしには配置しませんが、
説明せずに緩める提案を出すこと自体が設計違反です。

---

## 手順

1. `aidev.yaml` とPKGのソース構成（リポジトリルート）を読む
2. 上の4点を開発者に聞く（分かっている前提を示しながら確認する）
3. 候補を提示する。**各エントリに1行の根拠を添える**
4. ユーザーに次のコマンドを案内して終了する

```bash
aidev create policy            # 候補を .aidev/policy.candidate.yaml へ書き出す
git diff --no-index .aidev/policy.yaml .aidev/policy.candidate.yaml
aidev create policy --approve  # 人間が承認して初めて配置される
```

## 停止条件

- 非対話セッションで起動された → 候補を作らず、その旨を報告
- `aidev.yaml` が無い → `aidev init` が先だと伝えて停止
- 保護の床を外す要求を受けた → **拒否**し、理由（層2が無効化される）を説明して停止
