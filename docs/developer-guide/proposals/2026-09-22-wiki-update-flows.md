# Wiki 更新の処理フロー（認識合わせ用）

日付: 2026-09-22 / 状態: 設計中（未実装）/ 親文書: `2026-09-21-wiki-auto-update.md`

2 つの経路を、担当・入力・出力・失敗時の扱いまで書き下ろす。どちらも同じ CLI の機械的処理（§0）を共有し、違いは「誰が knowledge-builder を起動するか」だけにする。

## 0. 共通部品（すべて CLI、LLM を使わない）

### 0-a. 状態判定 `state`

| 名前 | 実体 |
| --- | --- |
| HEAD | 今のブランチの先端 |
| K（knowledgeSha） | `manifest.json` が「説明している」と記録するコミット |
| tracking | `origin/<tracking_branch>` の先端（表示と WARN 用。判定の主役ではなくなる） |

判定の順序:

1. manifest が無い → ERROR「Wiki 未生成。`aidev init` を実行」。書き込みは止まる（現状どおり）。
2. K が手元に無いコミット → WARN「fetch かブランチ確認」。
3. K と HEAD の間に PKG ソースの差分がある（kit 管理パスは除く）→ **BEHIND**「Wiki は K を説明している。HEAD より遅れ」。
4. `checkpoint.pendingPaths` が残っている → PENDING「prose 未完了」。
5. それ以外 → OK「Wiki は HEAD を説明している」。

Wiki だけのコミット（`.aidev/knowledge/**`）は kit 管理パスなので手順 3 で差分に数えない。したがって自動コミット直後は OK になる。

### 0-b. クリーン判定 `clean`

`git status --porcelain -- <package.include>`（kit 管理パスと `.aidev/knowledge/` は除外）に 1 行でもあれば **汚れ**。汚れていれば対象ファイルを列挙して停止する。Wiki は「コミットされた木」だけを説明する、という原則のため。

### 0-c. 差分計画 `plan`

1. HEAD の `git ls-tree -r` から generation target（`package.include` / `exclude`、secrets はマスク）と evidence（読んでよい範囲）を列挙する。blob ハッシュは git から得るので中身は読まない。
2. 既存 inventory（K 時点の記録）と突き合わせ、`added` / `modified` / `removed` / `renamed` / `unchanged` に分ける。evidence の指紋が変わっていれば全対象を再生成に回す。
3. 手編集されたページ（`selfHashes` 不一致）があれば `--force` なしで停止する。
4. `removed` だけが参照していたページを削除し、親 `index.md` を `staleIndexes` へ記録する。
5. 新しい inventory shard と manifest を書く。`knowledgeSha = HEAD`、`checkpoint.pendingPaths = added + modified + staleIndexes`。
6. `pendingPaths` が空なら（rename と削除だけ、または変更なし）→ **エージェント不要**。そのまま 0-e へ。
7. 空でなければ plan ファイル `.aidev/knowledge/.cache/plan.json` に `{ targetSha, mode, generationTargets, evidence.paths, batches[] }` を書く（既存の agent-task 形式を流用）。

### 0-d. 完了報告の取り込み `fold`

1. `.aidev/knowledge/.cache/done/*.json` を読む。`targetSha` が manifest の K と違う報告は捨てる。
2. 報告のページが `.aidev/knowledge/` 内の実在ファイルか検証し、sha256 を計算して inventory の `pages` / `selfHashes` を更新し、`pendingPaths` から除く。
3. `index.md` / `overview.md` の存在を検証する。
4. 取り込んだ報告と拒否した報告を削除する。
5. 残り件数を返す。

### 0-e. 確定 `commit`

1. `pendingPaths` が空でなければコミットしない。「残り N 件」を表示して終了コード 1。作業結果は checkpoint に残り、次回の実行で続きから再開する。
2. 空なら `.aidev/knowledge/**` と `.aidev/.gitignore` だけを `git add` し、固定メッセージ `aidev: update Wiki for <sha12>` でコミットする。`--no-commit` ならステージのみ。
3. コミット後の HEAD は Wiki コミットになる。0-a の手順 3 は差分なしと判定するので状態は OK。

## 1. ユーザー自身が Wiki を更新する（aidev を使わずに開発した場合）

前提: 利用者が feature ブランチでソースを編集し、コミット済み。Claude Code は関与していない。

| # | 担当 | 処理 | 出力・失敗時 |
| --- | --- | --- | --- |
| 1 | 利用者 | ブランチ上で `aidev knowledge update` を実行 | |
| 2 | CLI | 0-b クリーン判定 | 汚れていれば対象ファイルを列挙して終了コード 1。「コミットするか stash してから再実行」 |
| 3 | CLI | 0-c 差分計画 | 変更なしなら「Wiki は HEAD を説明済み」で終了 0。手編集ページがあれば停止し `--force` を案内 |
| 4 | CLI | `pendingPaths` が空（rename / 削除だけ）なら 0-e へ | |
| 5 | CLI | knowledge-builder を **headless で batch 起動**（既存 launcher、`agent_batch_size` 件ずつ、batch ごとに `agent_timeout_ms`）。進捗を `batch i/n` で表示 | `--no-agent` なら起動せず、構造だけ書いて「残り N 件」で終了 1 |
| 6 | knowledge-builder | plan の対象を調べ、ページと index を書き、対象ごとに `done/` へ報告 | manifest / inventory は書かない |
| 7 | CLI | batch ごとに 0-d 取り込み | timeout / 失敗 / 未報告があれば停止。取り込み済み分は checkpoint に残る |
| 8 | CLI | 全対象完了で 0-e 自動コミット | 「commit <sha12> / 次は push して PR」 |
| 9 | 利用者 | push、PR 作成 | PR にはソースのコミットと Wiki のコミットが並ぶ |
| 10 | レビュアー | ソースと Wiki の両方をレビュー | Wiki の正しさはレビューで担保する（大方針） |
| 11 | CI | `aidev check --strict` | Wiki が PR の HEAD より遅れていれば失敗し、手順 1 を案内 |

中断と再開: 手順 7 で止まっても manifest は既に HEAD を指し `pendingPaths` に残りがある。同じコマンドをもう一度実行すると 0-c で「残り」だけを plan に載せ、続きから走る。

## 2. aidev が Wiki を更新する（Claude Code + kit で開発した場合）

前提: PKG に kit の hooks が入っている。Claude が対話セッション（または issue-to-pr）でソースを編集している。

| # | 担当 | 処理 | 出力・失敗時 |
| --- | --- | --- | --- |
| 1 | Claude | ソースを編集（guard-write は現状どおり policy / lease で判定） | |
| 2 | Claude | `git commit`（Bash） | |
| 3 | hook: PostToolUse(Bash) | `aidev hook after-bash`（新設）。HEAD を `.aidev/cache/last-head` と比べ、変わっていなければ即終了 | 変わっていなければ何も出さない |
| 4 | CLI（hook 内） | 0-a 状態判定。BEHIND でなければ終了（Wiki コミット直後はここで抜ける） | |
| 5 | CLI（hook 内） | 0-b クリーン判定 | 汚れていれば「次のファイルをコミットしてから Wiki を更新」を追加コンテキストとして返し、終了 |
| 6 | CLI（hook 内） | 0-c 差分計画。plan.json を書く | `pendingPaths` が空なら 0-e まで hook 内で完了し「Wiki コミット <sha12> を追加」を返す |
| 7 | hook | 追加コンテキスト: 「Wiki は HEAD より遅れ（変更 a / 追加 b / 削除 c）。plan.json の batch ごとに knowledge-builder サブエージェントを起動し、終わったら `aidev knowledge update --no-agent` を実行」 | |
| 8 | Claude | skill の手順に従い、batch ごとに knowledge-builder を **サブエージェント（Agent tool）** で起動。plan のパスと担当 batch を渡す | 起動しなければ手順 12 で止められる |
| 9 | knowledge-builder（サブエージェント） | evidence を読み、ページと index を書き、`done/` へ報告 | 書き込みは policy の `writable: knowledge/**` で許可される |
| 10 | Claude | `aidev knowledge update --no-agent` を実行 | |
| 11 | CLI | 0-d 取り込み → 残り 0 なら 0-e 自動コミット | 残りがあれば「残り N 件」で終了 1。Claude は残りの batch を再度起動して 10 へ |
| 12 | hook: Stop | 0-a を再判定。BEHIND かつクリーンなら停止を拒否し、手順 7 と同じ理由を返す。`stop_hook_active` が立っている 2 回目は警告だけ出して通す | 汚れている（作業途中）なら警告だけで通す |
| 13 | Claude / issue-to-pr | push、PR 作成（既存の流れ） | PR にはソースのコミットと Wiki のコミットが並ぶ |
| 14 | レビュアー / CI | 経路 1 の手順 10〜11 と同じ | |

hook は自分ではサブエージェントを起動できない。手順 7 の注入と手順 12 の停止拒否で「必ず呼ばれる」状態を作り、CI を最終防衛にする。

### 経路 2 の hook が守るべき予算

PostToolUse hook は数秒で戻る必要がある。0-a〜0-c は `git ls-tree` と JSON 比較だけで、ファイルの中身は読まないので数千ファイルでも 1 秒未満を見込む。LLM を呼ぶ処理は hook に置かない。

## 3. 2 つの経路の違い（まとめ）

| 観点 | 経路 1（利用者） | 経路 2（aidev） |
| --- | --- | --- |
| 起点 | 利用者がコマンドを打つ | コミット後に hook が検出する |
| knowledge-builder の起動 | CLI が headless で batch 起動 | メインの Claude がサブエージェントとして起動 |
| 機械的処理 | CLI（0-a〜0-e） | 同じ CLI |
| Wiki のコミット | CLI が自動 | CLI が自動 |
| 強制力 | CI の `aidev check --strict` | hook の注入 + Stop 拒否 + CI |

## 4. この文書で決めたい点

1. 0-e: prose が残っている間はコミットしない、でよいか（部分コミットを許すか）。
2. 手順 2-12: Stop 拒否は「クリーンかつ BEHIND」の時だけ、2 回目は通す、でよいか。
3. 手順 2-3: HEAD 変化の検出を「全 Bash 呼び出し後に HEAD を比べる」方式でよいか（`git commit` の文字列検出より確実）。
4. 手順 2-8: サブエージェント 1 回あたりの対象数を `knowledge.agent_batch_size` に揃えるか。
5. 経路 2 で Claude 以外のツール（copilot / codex / kiro）の場合は経路 1 の headless 起動に落とす、でよいか。
