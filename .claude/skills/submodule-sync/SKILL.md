---
name: submodule-sync
description: ラッパー側の同期手順。aidev sync の使い方、3SHAの読み方、失敗時に --resume / --abort のどちらを選ぶかの判断。
---

# submodule-sync

`aidev sync` は **「PKGの追跡ブランチが別のSHAになった」という1つの事象**に追従します。
その変更がAI経由で起きたか、PKG単体の直接修正で起きたかを**区別しません**。
だから経路が1本で済みます。

## 3つのSHA

| SHA | 意味 |
| --- | --- |
| `remoteSha` | PKG追跡ブランチの先端（**真のソース**） |
| `submoduleSha` | ラッパーが指している `src/` のSHA |
| `knowledgeSha` | Wikiが説明しているSHA |

| 状態 | 意味 | 扱い |
| --- | --- | --- |
| 3つとも一致 | 健全 | — |
| `remoteSha != submoduleSha` | 追従遅れ | **警告**（exit 0）。`aidev sync` で追従 |
| `submoduleSha != knowledgeSha` | **Wikiが別のコードを説明している** | **エラー**（exit 4）。書き込みも止まる |

`aidev knowledge status` でいつでも確認できます。セッション開始時にも表示されます。

## 使い方

```bash
aidev sync                 # 追跡ブランチの先端へ追従
aidev sync --check-only    # 判定だけ。何も書き換えない（まずこれ）
aidev sync --dry-run       # 差分だけ表示
aidev sync --to <sha>      # 特定SHAへ（追跡ブランチから到達可能なものだけ）
aidev sync --no-pr         # 作業ツリーに反映するだけ
aidev sync --resume        # 中断したsyncを再開
aidev sync --abort         # submoduleを元へ戻し、リースを解放
```

**迷ったらまず `--check-only`** です。何も壊さずに現状が分かります。

## 何が起きるか

```text
1. PKGリモートを fetch し、追跡ブランチから targetSha を解決
2. 操作冪等キーで重複を除外し、同期ストリームIDで既存のオープンPRを検索
3. .aidev/sync.lock を取得（syncリース）
4. submodule を targetSha へ bump
5. manifest の blob ハッシュと現ツリーを比較して変更セットを算出（LLM不要）
6. 影響範囲のWikiページだけ再生成し、manifest/inventory を更新
7. aidev check（3SHA一致・静的ファイルが lock と一致）
8. リース解放 → ラッパーPR
9. 【人間】ラッパーPRをマージ
```

**syncリース保持中は `knowledge/**` 以外への書き込みが拒否されます。これは仕様です。**
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

syncが途中で落ちると、**リースが残ったまま**になります。これは意図的です。
自動解放すると、bump途中の状態が放置されるためです。

| 状況 | 選ぶもの |
| --- | --- |
| 一時的な失敗（ネットワーク・APIタイムアウト・認証切れ） | **`--resume`**。原因を直してから |
| Wiki生成が途中で止まった | **`--resume`**（チェックポイントから再開） |
| 対象SHAを間違えた | **`--abort`** → 正しい `--to` で再実行 |
| bump後にPKG側の問題が判明した | **`--abort`** |
| 原因が分からない | **`--abort` せずに報告**。状態を保全したまま人間に判断を仰ぐ |

最後の行が重要です。**分からないまま `--abort` すると、調査材料が消えます。**

## やってはいけないこと

- `knowledge/**` を手編集する（生成物。`selfHashes` 不一致で検出され、次回生成で失われる）
- `src/` の中で直接コミットしてラッパーを放置する（3SHAが割れる）
- `.aidev/sync.lock` を手で消す（CLIだけが置きます。消すとリースの意味が消える）
- exit 4 のまま作業を続ける（Wikiが別のコードを説明している状態）
- ラッパーPRを自動マージする

## 状態が壊れて見えたら

`aidev check` と `aidev knowledge status` の**出力を添えて**報告してください。
推測せず、実際の出力を見せるのがいちばん速い解決です。

関連: [[knowledge-usage]] / [[azure-devops]] / [[failure-triage]] / [[commit-and-pr]]
