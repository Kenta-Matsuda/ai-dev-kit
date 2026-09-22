---
name: knowledge-update
description: Wiki を HEAD に追従させる手順。hook の指示で knowledge-builder をサブエージェント起動する流れ、aidev sync wiki の使い方、状態の読み方、失敗時の判断。
---

# knowledge-update

Wiki（`.aidev/knowledge/`）は **コミット 1 つ** を説明します。説明しているコミットは
`manifest.json` の `knowledgeSha` にあり、判定は「Wiki が生成された時点のファイル一覧と指紋（inventory）が
HEAD の木と一致するか」で行います。ソースをコミットするたびに Wiki を HEAD に追従させ、
**ソースのコミットとは別のコミット** として同じブランチ・同じ PR に積みます。

## 状態の読み方

セッション開始時と `aidev check` に 1 行が出ます。

```text
[ai-dev-kit] head=<sha7>  knowledge=<sha7>  tracking=<sha7>
```

| 状態 | 意味 | 扱い |
| --- | --- | --- |
| ✅ OK | Wiki は HEAD を説明している | — |
| ⚠️ Wiki が HEAD より遅れ（+a ~m -r →rn） | ソースが変わった | コミット後に hook が更新を始める。手動なら `aidev sync wiki` |
| ⚠️ prose 未完了（N 件） | 構造は更新済み、ページがまだ | 下の手順で knowledge-builder を起動し、`aidev sync wiki --no-agent` |
| ⚠️ tracking branch が先行 | origin/main が進んだ | merge / rebase してから更新 |
| ❌ Wiki が無い / manifest が読めない | 信用できない | **エラー**（exit 4）。書き込みも止まる。`aidev init` |

## hook に「Wiki が遅れている」と言われたら

コミット後の hook（PostToolUse）か、停止時の hook（Stop）が次の内容を伝えます。
**他の作業より先に** そのとおりに進めます。

1. `.aidev/knowledge/.cache/plan.json` を読む。`batches[i]` ごとに生成対象が並んでいる
2. batch ごとに **Agent tool で `knowledge-builder` サブエージェントを起動** し、次を指示する
   > `.aidev/knowledge/.cache/plan.json` を読み、batch *i* の generationTargets について knowledge-builder の契約どおりページを書き、対象ごとに完了報告を `reportDir` に書く。`targetSha` は plan の値を使う
3. 全 batch が終わったら `aidev sync wiki --no-agent` を実行する。CLI が報告を取り込み、
   `.aidev/knowledge/` を `aidev: update Wiki for <sha12>` としてコミットする
4. 「残り N 件」と言われたら、残った batch を再度サブエージェントに渡して 3 に戻る

Wiki ページを自分で編集しない。`manifest.json` と `inventory/**` には触らない（CLI が書く）。
Stop hook は Wiki が遅れたままだと 1 回だけ停止を拒否します。2 回目は警告付きで通ります。

## 手動で更新するとき

```bash
aidev sync wiki             # HEAD に追従。knowledge-builder を CLI が起動し、完了したらコミット
aidev sync wiki --dry-run   # 何が更新されるかだけ表示
aidev sync wiki --no-agent  # 構造（inventory / manifest）だけ更新し、本文は後回し（exit 1）
aidev sync wiki --no-commit # 作業ツリーに残す（コミットしない）
aidev sync wiki --full      # 全対象を作り直す
aidev sync wiki --force     # 手編集されたページを上書きする
aidev sync wiki --abort     # 中断した publish（tracking branch 上の更新）を破棄
```

前提: **生成対象（`package.include`）に未コミットの変更が無いこと**。あると対象ファイルを列挙して止まります。
先にコミットするか stash します。`.aidev/knowledge/` や kit の設定ファイルが汚れているのは問題ありません。

## tracking branch（main）上で実行した場合

main には直接コミットできないので、CLI は一時 worktree で更新し、`aidev/wiki-<sha12>` ブランチにコミットして
push し、PR を作ります（`--no-push` で push しない）。開発者の checkout には触りません。
途中で止まると lease と worktree が残ります。同じコマンドで続きから再開でき、`--abort` で破棄します。

## 失敗したとき

| 状況 | 選ぶもの |
| --- | --- |
| サブエージェントが途中で止まった | 残りの batch を再度起動し、`aidev sync wiki --no-agent` |
| CLI 起動の agent が timeout | `aidev sync wiki` を再実行（checkpoint から続き） |
| 手編集ページで止まった | 編集を生成元へ移すか、`--force` |
| 未コミットの対象で止まった | コミットしてから再実行 |
| 原因が分からない | `aidev check` の出力を添えて報告。`--abort` は調査材料を消す |

## やってはいけないこと

- `.aidev/knowledge/**` を手編集する（`selfHashes` 不一致で検出され、次回生成で失われる）
- `manifest.json` / `inventory/**` を書く
- `.aidev/sync.lock` を手で消す（CLI が置く lease）
- `.aidev/cache/wiki-worktree/` の中で作業する
- exit 4 のまま作業を続ける
- Wiki PR（`aidev/wiki-<sha>`）や Wiki コミットを含む PR を自動マージする。**Wiki の内容はレビューで担保する**

関連: [[knowledge-usage]] / [[commit-and-pr]] / [[failure-triage]]
