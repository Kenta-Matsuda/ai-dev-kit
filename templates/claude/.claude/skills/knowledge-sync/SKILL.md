---
name: knowledge-sync
description: Wiki同期の手順。aidev sync の使い方、3SHAの読み方、失敗時に --resume / --abort のどちらを選ぶかの判断。
---

# knowledge-sync

`aidev sync` は **「PKGの追跡ブランチが別のSHAになった」という1つの事象**に追従します。
その変更がAI経由で起きたか、PKG単体の直接修正で起きたかを**区別しません**。
だから経路が1本で済みます。

## 3つのSHA

| SHA | 意味 |
| --- | --- |
| `trackingSha` | `origin/<tracking_branch>` の先端（**真のソース**） |
| `baseSha` | HEAD と追跡ブランチの merge-base（今の作業が乗っているコード） |
| `knowledgeSha` | Wikiが説明しているSHA |

| 状態 | 意味 | 扱い |
| --- | --- | --- |
| `knowledgeSha == baseSha` | 健全 | — |
| `trackingSha` が `baseSha` より先 | 追従遅れ | **警告**（exit 0）。`git pull` と `aidev sync` で追従 |
| `knowledgeSha` が `baseSha` より古い | Wikiが古い | **警告**（exit 0）。`aidev sync` を実行 |
| Wikiが無い / manifest が読めない | **Wikiが信用できない** | **エラー**（exit 4）。書き込みも止まる |

`aidev status` でいつでも確認できます。セッション開始時にも表示されます。

## 使い方

```bash
aidev sync                 # 追跡ブランチの先端へ追従
aidev sync --check-only    # 判定だけ。何も書き換えない（まずこれ）
aidev sync --dry-run       # 差分だけ表示
aidev sync --to <sha>      # 特定SHAへ（追跡ブランチから到達可能なものだけ）
aidev sync --no-agent      # 構造（inventory / manifest）だけ更新し、本文は後回しにする
aidev sync --no-pr         # ローカルの ai/wiki-<sha> ブランチにコミットするだけ（push・PRなし）
aidev sync --resume        # 中断したsyncを再開
aidev sync --abort         # 中断したsyncの作業ツリーを破棄し、リースを解放
```

**迷ったらまず `--check-only`** です。何も壊さずに現状が分かります。

## 何が起きるか

```text
1. origin/<tracking_branch> を fetch し、targetSha を解決
2. 操作冪等キーで重複を除外し、同期ストリームIDで既存のオープンPRを検索
3. .aidev/sync.lock を取得（syncリース）
4. targetSha をチェックアウトした一時 git worktree を作る
   （.aidev/cache/sync-worktree/。開発者のチェックアウトには触らない）
5. manifest の blob ハッシュと targetSha のツリーを比較して変更セットを算出（LLM不要）
6. worktree 内で inventory / manifest を書き換え、knowledge-builder が
   影響範囲のWikiページだけ再生成する（--no-agent なら本文は後回し）
7. 整合性の検証（worktree 内で 3SHA を再計算し、ERROR なら停止）
8. .aidev/knowledge/ をブランチ ai/wiki-<sha12> にコミット → push → Wiki PR
9. worktree を削除し、リース解放
10. 【人間】Wiki PRをマージ → 全員が git pull でWikiを受け取る
```

**syncリース保持中は `.aidev/knowledge/**` 以外への書き込みが拒否されます。これは仕様です。**
deny されたら回避策を探さず、syncの完了を待ってください。

## 重要: 作業ブランチの先端SHAを使わない

> 🔴 マージ結果は **PR API から解決**します。

| 事象 | 何が起きるか |
| --- | --- |
| squash マージ | 新しい単一コミットになる。ブランチ先端とは別物 |
| rebase マージ | 親が付け替わり、SHAが全部変わる |
| レビュアーの追加コミット | ブランチ先端に他人の変更が乗る |
| 複数PRの交互マージ | 追跡ブランチ先端が自分のマージ結果より進む |

## 失敗したとき: `--resume` か `--abort` か

syncが途中で落ちると、**リースと worktree が残ったまま**になります。これは意図的です。
自動解放すると、途中まで生成したWikiと調査材料が消えるためです。
開発者のチェックアウトは worktree の外にあるので、途中で落ちても壊れません。

| 状況 | 選ぶもの |
| --- | --- |
| 一時的な失敗（ネットワーク・APIタイムアウト・認証切れ） | **`--resume`**。原因を直してから |
| Wiki生成が途中で止まった | **`--resume`**（チェックポイントから再開） |
| 対象SHAを間違えた | **`--abort`** → 正しい `--to` で再実行 |
| 追従先のPKG側に問題が判明した | **`--abort`**（worktree を捨てるだけ。戻すものはない） |
| 原因が分からない | **`--abort` せずに報告**。状態を保全したまま人間に判断を仰ぐ |

最後の行が重要です。**分からないまま `--abort` すると、調査材料が消えます。**

## やってはいけないこと

- `.aidev/knowledge/**` を手編集する（生成物。`selfHashes` 不一致で検出され、次回生成で失われる）
- Wikiを `aidev sync` を通さずに別ブランチで直接コミットする（`knowledgeSha` と `baseSha` が割れる）
- `.aidev/sync.lock` を手で消す（CLIだけが置きます。消すとリースの意味が消える）
- `.aidev/cache/sync-worktree/` の中で作業する（一時領域。`--abort` で消える）
- exit 4 のまま作業を続ける（Wikiが信用できない状態）
- Wiki PR（`ai/wiki-<sha>`）を自動マージする

## 状態が壊れて見えたら

`aidev check` と `aidev status` の**出力を添えて**報告してください。
推測せず、実際の出力を見せるのがいちばん速い解決です。

関連: [[knowledge-usage]] / [[azure-devops]] / [[failure-triage]] / [[commit-and-pr]]
