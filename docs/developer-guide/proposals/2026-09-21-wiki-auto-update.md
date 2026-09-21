# 提案: 開発中に Wiki を追従させる（ブランチ上の差分更新）

日付: 2026-09-22（初版 2026-09-21）/ 状態: 設計中（未実装）

## 大方針

- **aidev の生成物は、すべてユーザーにレビューと品質担保の責任がある。** Wiki のコミットは PR の一部として人がレビューする。kit は生成と整合性検査までを担い、正しさを保証しない。
- **機械的にできる処理は CLI が行い、エージェントには文章生成だけを任せる。** 差分の特定、対象の列挙、台帳（inventory / manifest）の更新、コミットは CLI の仕事。トークンは prose にだけ使う。
- **Wiki は常に「あるコミットの HEAD」を説明する。** 作業ツリーが汚れた状態では更新しない。これにより「Wiki がどのコミットを説明しているか」が意味を持ち続ける。
- **ソースのコミットと Wiki のコミットは分ける。同じブランチ、同じ PR に載せる。**

## ねらい

利用者が Wiki のコマンドを意識しなくても、`aidev` で開発している間に Wiki が追従している状態にする。初回生成は `aidev init` に統合済み（0.3.0）。残るのは「開発中の追従」で、これができれば `aidev knowledge build` と現在の `aidev sync` は 1 つのコマンドに畳める。

## 用語

| 語 | 意味 |
| --- | --- |
| Wiki | `.aidev/knowledge/` の Markdown 群。PKG のコードを AI 向けに説明した派生物 |
| manifest | `.aidev/knowledge/manifest.json`。`knowledgeSha` に「この Wiki が説明するコミット」を持つ |
| inventory | ファイルごとの記録（パス、blob ハッシュ、対応ページ、ページのハッシュ） |
| generation target | `package.include` / `exclude` に一致する tracked file。Wiki のページを持つ対象 |
| tracking branch | `hosting.tracking_branch`（通常 `main`） |

## 現状（0.3.0）

- `aidev knowledge build` は feature ブランチの HEAD ではなく **main との merge-base** を対象にする。「Wiki は main のコミットだけを説明する」前提で作られている。
- 追従は `aidev sync` だけが行う。一時 worktree に main の先端を取り出し、`ai/wiki-<sha12>` ブランチにコミットして別 PR を出す。開発者の checkout もブランチも触らない。
- hook は Stop 時に `.aidev/cache/pending-refresh.json` へメモを書くだけで、それを読む仕組みが無い。
- 差分更新の機構は既に CLI にある。inventory の blob ハッシュで追加 / 変更 / 削除 / rename を判定し、rename は再生成せず、削除で不要になったページは CLI が消す。エージェントには変更された対象と読んでよい範囲だけを渡す。

つまり足りないのは「ブランチの HEAD を対象にする」「hook から確実に呼ぶ」「Wiki を自動コミットする」の 3 点で、差分更新そのものは作り直さない。

## 目標の流れ

### A. aidev（Claude Code + kit）で開発している場合

1. Claude がソースを直してコミットする。
2. PostToolUse hook（Bash）が HEAD の変化を検出し、CLI の `plan` を呼ぶ。CLI は次を機械的に行う。
   - generation target に未コミットの変更や未追跡ファイルがあれば、そのファイルを列挙して**更新しない**（エラー表示）。`.aidev/knowledge/` の汚れは対象外。
   - `knowledgeSha..HEAD` の差分を inventory で判定し、再生成が要る対象、rename、削除を確定する。
   - 対象と evidence の一覧を plan ファイル（`.aidev/knowledge/.cache/plan.json`、既存の agent-task 形式を流用）へ書く。
   - hook の追加コンテキストとして「Wiki が HEAD より N ファイル遅れている。knowledge-builder サブエージェントを plan で起動せよ」を返す。
3. **メインの Claude が knowledge-builder をサブエージェントとして起動する**（batch サイズごとに複数回でもよい）。サブエージェントはページと `index.md` を書き、対象ごとに完了報告（`.cache/done/`）を残す。manifest / inventory は書かない。
4. Claude が `aidev knowledge update` を実行する（または Stop hook が呼ぶ）。CLI は完了報告を取り込み、ページの存在とハッシュを検証し、inventory / manifest を `knowledgeSha = HEAD` で書き直し、**`.aidev/knowledge/` だけを固定メッセージで自動コミットする**。
5. Stop hook が状態を再検査する。まだ遅れていれば停止を拒否し理由を返す（Claude Code の `stop_hook_active` でループを防ぐ）。追いついていれば通す。
6. ソースのコミットと Wiki のコミットが同じブランチに並び、1 つの PR でレビューされる。

hook 自身はサブエージェントを起動できない。起動するのはメインの Claude で、hook はコンテキスト注入（手順 2）と停止拒否（手順 5）で「必ず呼ばれる」状態を作る。CI の `aidev check --strict` を最終防衛にし、Wiki が HEAD に追いついていない PR を落とす。

### B. aidev を使わずに開発した場合

利用者が自分のブランチで `aidev knowledge update` を実行する。CLI の機械的処理は A と同じ。違いはサブエージェントを呼ぶ Claude がいないことなので、CLI が knowledge-builder を headless で batch 起動する（既存の launcher）。結果は同じく自動コミットされ、利用者の PR に載る。

### C. tracking branch（main）自体が遅れた場合

Wiki 更新を伴わないマージが入ると main が Wiki より進む。この時だけ別ブランチが要る。`aidev knowledge update` を main 上（または `--branch`）で実行すると、CLI は `aidev/wiki-<sha12>` を切って B と同じ処理を行い、push と PR 作成まで行う（現在の sync の worktree 方式を流用）。`<sha12>` は Wiki が説明するコミット。ブランチ接頭辞は `ai/` から `aidev/` に変える。

## CLI とエージェントの責務

| 担当 | 責務 |
| --- | --- |
| CLI（`aidev knowledge update`） | クリーン判定、差分判定、plan 出力、完了報告の取り込みと検証、inventory / manifest、orphan 削除、自動コミット、main 向けブランチと PR、状態表示 |
| hook | HEAD 変化の検出、plan の呼び出し、コンテキスト注入、停止拒否 |
| メインの Claude | サブエージェントの起動と `aidev knowledge update` の実行 |
| knowledge-builder | evidence を読み、対象のページと index を書き、完了報告を残す |

claude 以外のツール（copilot / codex / kiro）ではサブエージェント起動の可否がツールごとに違うため、A の手順 3 が使えない場合は B の headless 起動に落とす。

## 必要な変更

1. **生成対象を HEAD にする。** `knowledge.js:94` の merge-base を HEAD に変える。
2. **状態判定を HEAD 基準にする。** `state.js` の「knowledgeSha と base のソース差分」を「knowledgeSha が HEAD の祖先で、その間にソース差分が無い」に変える。Wiki だけのコミットは kit 管理パスとして除外済みなので、自動コミット後も OK になる。tracking の先行は WARN として残す。
3. **クリーン判定を追加する。** generation target 内の未コミット変更 / 未追跡ファイルで停止し、ファイルを列挙する。
4. **`aidev knowledge update` を新設する。** `build` と `sync` を統合。フラグは `--full`、`--scope`、`--no-agent`、`--no-commit`、`--dry-run`、`--branch`（C 用）、`--force`（手編集ページの上書き）。
5. **hook を追加する。** PostToolUse（Bash）での HEAD 変化検出と plan 呼び出し、Stop での再検査と停止拒否。既存の `pending-refresh.json` は廃止。
6. **自動コミット。** `.aidev/knowledge/` と `.aidev/.gitignore` だけを stage し、固定メッセージ（例: `aidev: update Wiki for <sha12>`）でコミットする。CLI が行うコミットであり、エージェントにコミット権限を与えるものではない。
7. **ブランチ接頭辞** `ai/wiki-` → `aidev/wiki-`。
8. **知識 skill / CLAUDE.md テンプレート**に「hook が求めたら knowledge-builder をサブエージェントで起動する」手順を書く。
9. `state.test.js`、`knowledge` / `sync` のテスト、hook のテスト（stub agent）を書き換える。

## 削除するもの

- `aidev knowledge build` / `aidev knowledge status`（`status` は `aidev status` に統合済み）
- `aidev sync`（`knowledge update` に統合。名前を残すなら alias にせず削除する）
- Stop hook の `pending-refresh.json`
- ユーザーガイドの「Wiki を生成するコマンド」の章。「Wiki は init で作られ、コミットするたびに追従する。差分は同じ PR でレビューする」に置き換える

## 未決事項

1. コマンド名。`aidev knowledge update` を推す（設定・ディレクトリ・agent 名が `knowledge` で統一されているため）。`aidev wiki` にするなら関連名も揃えて変える。
2. C（main の追従）を同じコマンドに含めるか、別名にするか。
3. PostToolUse での HEAD 変化検出の方式。全 Bash 呼び出し後に HEAD を前回値と比べる（安価）か、コマンド文字列に `git commit` を含むときだけにするか。
4. サブエージェント 1 回あたりの対象数（`knowledge.agent_batch_size` を流用するか）。
