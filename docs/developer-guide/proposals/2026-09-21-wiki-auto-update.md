# 提案: 開発中に Wiki を自動で更新する（hook + agent）

日付: 2026-09-21 / 状態: 設計中（未実装）

## ねらい

利用者が `aidev knowledge` を意識しなくても、`aidev` で開発している間に LLM Wiki が更新されている状態にする。
初回生成は `aidev init` に統合済み（0.3.0）。残るのは「開発中の追従」で、これができれば `aidev knowledge` コマンドは不要になる。

## 現状

- Wiki は tracking branch のコミット単位で管理している（3 SHA: base / knowledge / tracking）。`knowledgeSha` と base のツリー差分で「古い」を判定する。
- 追従は `aidev sync`（一時 worktree → `ai/wiki-<sha>` ブランチ → PR）。開発者の checkout では更新しない。
- Stop hook は `.aidev/cache/pending-refresh.json` に記録するだけで、消費する runner が無い。

## 案

### A. Stop hook がバックグラウンドで増分 build を起動する（推奨）

1. PostToolUse hook（既存の quality-gate と同じ発火点）が、編集された PKG ファイルのパスを `.aidev/cache/pending-refresh.json` に追記する。
2. Stop hook が pending があれば、`aidev` の増分 build（構造 + knowledge-builder）を **detached な子プロセス** として起動して即座に戻る。同時起動はロック（sync lease と同じ仕組み）で 1 つに抑える。
3. 次の SessionStart で結果（完了 / 残り N 件 / 失敗理由）をコンテキストに出す。
4. 開発者は Wiki の差分をコードと **同じ PR** でコミットする。

利点: 人間にも Claude にも指示が要らない。欠点: セッション終了ごとに token を使う（`knowledge.agent_batch_size` と時間予算で上限を決める）。Windows での detached 起動と log の置き場が要検証。

### B. 対話セッション内で Claude が knowledge-builder を呼ぶ

`CLAUDE.md` と skill で「PKG のファイルを変更したら、変更分について knowledge-builder subagent を起動する」と指示し、完了報告を Stop hook が inventory に取り込む（LLM 不要の fold）。

利点: 追加プロセス無し、変更の文脈をそのまま使える。欠点: Claude が指示を守らないと更新されない。A の補助として併用する。

## 前提となる変更（要判断）

Wiki が **作業ツリー** を説明し、コードと同じ PR で運ばれるようにするには、状態判定をコミット SHA 比較から **inventory の blob ハッシュ比較** に変える必要がある。

- `state.js`: `sourceChanged(kSha, baseSha)` → 「inventory に記録した blob と今のツリーの差分」。`knowledgeSha` は情報表示だけにする。
- `sync.js`: no-op 判定と `ai/wiki-<sha>` の命名を inventory ベースに。sync の役割は「未生成分の補完」になる。
- `status` / `check` / hooks のメッセージと `state.test.js` を書き換える。

これをしないと、開発者が Wiki を更新してコミットした直後に「Wiki が古い」と誤判定され、sync が同じ内容を作り直す。

## その後の整理

- `aidev knowledge build|status` を削除する。`--full` / `--scope` の作り直しは `aidev init --wiki --full` か `aidev sync` に吸収し、`status` は `aidev status` に統合済みの表示で足りる。
- ユーザーガイドから「Wiki を生成するコマンド」の章を無くし、「Wiki は init で作られ、開発中に自動で追従する」と 1 段落で説明する。

## 未決事項

1. 状態モデルを inventory ベースに変えてよいか（sync / CI / PR の運用が変わる）。
2. バックグラウンド build の token 上限と、実行前に確認するかどうか。
3. Windows の detached プロセスと log 出力先。
