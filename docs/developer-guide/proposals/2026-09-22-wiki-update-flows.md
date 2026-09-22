# Wiki 更新の処理フロー（認識合わせ用）

日付: 2026-09-22 / 状態: 実装済み（2026-09-22）/ 親文書: `2026-09-21-wiki-auto-update.md`

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
2. inventory に記録された対象（パスと blob）と HEAD の木（`git ls-tree -r HEAD` を `package.include` / `exclude` で絞ったもの）が一致しない → **BEHIND**「Wiki は K を説明している。HEAD より遅れ」。
3. `checkpoint.pendingPaths` が残っている → PENDING「prose 未完了」。
4. それ以外 → OK「Wiki は HEAD を説明している」。

BEHIND の判定はコミット K を必要としない。inventory は「Wiki が説明した時点のファイル一覧と中身の指紋」なので、HEAD の木と直接比べられる。K のコミットが手元に無くても（fetch 前、force-push 後の GC）判定できるため、現状の「K が手元に無い → WARN、fetch かブランチ確認」は不要になる。K は「どのコミットを説明しているか」を人に示す情報として manifest に残す。

Wiki だけのコミット（`.aidev/knowledge/**`）は generation target に含まれないので手順 2 で差分に数えない。したがって自動コミット直後は OK になる。

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

## 4. 決定事項（2026-09-22）

1. prose が残っている間は Wiki をコミットしない。部分コミットはしない。
2. Stop 拒否は「クリーンかつ BEHIND」の時だけ。`stop_hook_active` が立った 2 回目は警告だけ出して通す。
3. HEAD 変化の検出は、全 Bash 呼び出し後に HEAD を前回値と比べる方式。
4. サブエージェント 1 回あたりの対象数は `knowledge.agent_batch_size` に揃える。
5. Claude 以外のツールでも経路 2 を成立させる。ツール間の差分は kit が吸収する（§5）。headless 起動への切り替えは「そのツールが経路 2 を成立させられない場合」の最後の手段に限る。

## 5. ツール間の差分を kit が吸収する方法

経路 2 が必要とする機能は 4 つ。各ツールがどう提供しているかを公式文書で確認した（2026-09 時点。kit 側は claude 以外を実機未検証）。

| 機能 | Claude Code | GitHub Copilot CLI | OpenAI Codex CLI | Kiro CLI |
| --- | --- | --- | --- | --- |
| hook 設定の置き場（repo 内） | `.claude/settings.json` | `.github/hooks/*.json`（`version: 1`） | `.codex/hooks.json`（project の `.codex/` を trusted にした時だけ読む） | agent 定義 JSON（`.kiro/agents/<name>.json`）の `hooks` 欄。repo 全体ではなく **agent ごと** |
| ツール実行後に文脈を注入 | `PostToolUse` → `hookSpecificOutput.additionalContext` | `postToolUse` → `additionalContext` | `PostToolUse` → `hookSpecificOutput.additionalContext` | **不可**。`postToolUse` の stdout は捨てられる（公式文書） |
| 停止を拒否して続行させる | `Stop` → `decision: block` + `reason`、`stop_hook_active` | `agentStop` → `decision: block` + `reason`、`stop_hook_active` | `Stop` → `decision: block` + `reason`、`stop_hook_active` | `stop` → `decision: block` + `reason`（reason は次のユーザー発話として渡る）。ループ防止フラグは文書に無く、kit 側で回数を数える |
| 名前付きサブエージェントの起動 | Agent tool、`.claude/agents/*.md` | custom agent（`.github/agents/*.agent.md`）。名前を指示するか説明文から推論。`/agent` で明示も可 | `.codex/agents/*.toml`。ツール名は無く、AGENTS.md や指示文の「委任せよ」で spawn する | `subagent` tool、`.kiro/agents/*.json`。呼び出し側 agent の `tools` に `subagent` と `toolsSettings.subagent.availableAgents` が要る |
| hook 経由の入力 | stdin JSON | stdin JSON（`toolName`、`toolArgs`、`toolResult`、`cwd`） | stdin JSON（`session_id`、`cwd`、`hook_event_name`、`turn_id`） | stdin JSON（`hook_event_name`、`cwd`、`session_id`、`tool_name`、`tool_input`、`tool_response`） |
| サブエージェント内で hook（guard-write）が効くか | 効く | **効かない**（`preToolUse` が task tool 経由のサブエージェントに適用されない。issue #2392、closed だが解決内容は未確認） | 効く（全イベントが main / subagent で同じに発火。`SubagentStart` / `SubagentStop` もある） | **効かない**（公式文書「Hooks will not trigger in subagents」。issue #7755 は not planned で close） |

### 吸収の設計

**主経路は Stop 拒否、PostToolUse 注入は早期通知。** 4 ツールとも Stop 系イベントで `decision: block` + `reason` を返せる。この 1 本があれば「Wiki が遅れたまま終われない」は成立する。PostToolUse の注入は、コミット直後に気付かせるための前倒しで、Claude / Copilot / Codex で有効にする。Kiro は `postToolUse` の stdout が捨てられるので Stop 拒否だけで運用する（Kiro の `stop` には `stop_hook_active` 相当が無いので、kit が `.aidev/cache/` に拒否回数を記録して 2 回目を通す）。

**CLI 側の変更は 3 か所に閉じる。**

1. `cli/lib/tools.js` の registry に `hooks` レコードを足す。内容は hook 設定ファイルの置き場、イベント名の対応（`postToolUse` / `stop` を各ツールの名前へ）、stdin の取り方（`toolName` / `tool_name`、`cwd`）、出力の形（`additionalContext` を包む構造、`decision` / `reason` の形、`stop_hook_active` の読み方）。`hook.js` はツール id を見ず、adapter に「注入したい文」「拒否理由」を渡して JSON を作らせる。
2. `templates/<tool>/` に hook 設定を足す。`templates/copilot/.github/hooks/aidev.json`、`templates/codex/.codex/hooks.json`、`templates/kiro/.kiro/hooks/aidev.json`。中身は既存の `templates/claude/.claude/settings.json` と同じく `aidev hook <name> --tool <id>` を呼ぶだけ。kit 管理パスとして `TOOL_CONFIG_GLOBS` と `ALWAYS_PROTECTED` に加える。
3. 注入する文面をツール別に持つ。「knowledge-builder をサブエージェントで起動せよ」の言い方が違う。Claude: 「Agent tool で `knowledge-builder` を起動」。Copilot: 「custom agent `knowledge-builder` に委任」。Codex: 「`knowledge-builder` エージェントに委任（spawn）」。Kiro: 「`subagent` tool で `knowledge-builder` を起動」。文面は registry の `subagentHint(planPath, batch)` から取る。

**knowledge-builder 自体は既にツール別に配布している**（`templates/*/agents`）。完了報告の形式（`done/*.json`）と plan の形式はツールに依らないので、CLI の取り込み（0-d）は 1 本で済む。

### ツール固有の注意

- **Codex**: repo 内 `.codex/hooks.json` は project が trusted のときだけ読まれる。trusted は利用者の `~/.codex/config.toml` に `projects."<path>".trust_level = "trusted"` として記録され、その PKG で最初に `codex` を起動した時の「このディレクトリを信頼するか」への回答で書かれる。`aidev init` の完了メッセージで「最初の `codex` 起動で trust に答える」を案内し、`aidev doctor` で `~/.codex/config.toml` に当該 path の trusted があるかを検査する（読むだけ。kit は書かない）。サブエージェント起動にツール名が無いので、`AGENTS.md`（`templates/codex/AGENTS.md`）に「hook が求めたら `knowledge-builder` に委任する」を書く。hook はサブエージェント内でも発火するので guard-write が効く。
- **Kiro**: CLI の hook は agent 定義 JSON の `hooks` 欄に書く（repo 全体の設定は無い）。したがって kit の hook を効かせるには、kit が主担当 agent `.kiro/agents/aidev.json` を配布し、そこに `hooks`（`postToolUse` → `aidev hook after-bash --tool kiro`、`stop` → `aidev hook session-stop --tool kiro`）、`tools` に `subagent`、`toolsSettings.subagent.availableAgents: ["knowledge-builder"]` と `trustedAgents` を持たせる。利用者は `kiro-cli chat --agent aidev` で起動する（`aidev init` が案内）。既定 agent で対話すると hook もサブエージェント起動も無いので、`aidev doctor` は警告だけ出す。サブエージェント内では hook が発火せず guard-write が効かないため、`knowledge-builder.json` の `permissions` に `fs_write` の `match` を `.aidev/knowledge/**` だけ `allow`、他を `deny` とする規則を書く（`toolsSettings` の書き込み制限は deprecated なので `permissions` を使う）。
- **Copilot**: hook は `bash` と `powershell` のスクリプト文字列で書く。Windows と POSIX の両方を書いておく（`aidev hook ... --tool copilot` の 1 行なので差は無い）。`preToolUse` がサブエージェントに適用されない issue（#2392）があり、closed だが解決版は未確認。knowledge-builder の `.agent.md` は `tools` でシェル系を外し、書き込み範囲は CI の `aidev check`（kit 管理パスの drift 検査）と PR レビューで担保する。実機で確認するまで `verified: false` のまま。
- **どのツールでも**: hook の予算は既定 30 秒。0-a〜0-c は git の木の比較だけなので収まる。

### 経路 2 が成立しない場合の扱い

上の 4 機能のうち Stop 拒否かサブエージェント起動が使えないツールでは、hook の注入文を「`aidev knowledge update` を実行せよ」に変え、CLI が knowledge-builder を headless 起動する（経路 1 と同じ）。registry の `hooks` レコードが無いツールはこの扱いにする。現時点でその条件に当たるツールは無い。

## 6. 調査で確定した点と残る判断

確定（2026-09-22、公式文書と公開 issue で確認）:

1. Kiro の `postToolUse` は stdout が捨てられ、文脈注入はできない。Kiro は Stop 拒否だけで運用する。
2. Kiro CLI の hook は agent 定義の `hooks` 欄にしか書けない。kit が主担当 agent `.kiro/agents/aidev.json` を配布し、hook とサブエージェント設定をそこに持たせる。
3. Codex の trusted は `~/.codex/config.toml` の `projects."<path>".trust_level`。初回起動の trust プロンプトで書かれる。`aidev init` の完了メッセージで案内し、`aidev doctor` で検査する。
4. サブエージェント内で hook が効くのは Claude と Codex。Copilot と Kiro は効かないので、knowledge-builder の書き込み範囲を agent 定義側（Kiro: `permissions`、Copilot: `tools`）と CI / レビューで担保する。
5. Kiro は kit が主担当 agent `.kiro/agents/aidev.json` を配布し、利用者は `kiro-cli chat --agent aidev` で起動する（決定 2026-09-22）。`aidev init` が起動コマンドを案内し、`aidev doctor` は既定 agent での利用を警告する。

残る確認（実機が要る）:

1. Copilot issue #2392 の解決版の確認。
2. claude 以外の 3 ツールは実機未検証（`verified: false`）。hook 設定と注入文は `aidev agent run --dry-run` 相当の表示で確認できるようにする。

出典（2026-09-22 確認）: GitHub Docs「Hooks configuration」「Using hooks with Copilot CLI」「Creating and using custom agents for Copilot CLI」、github/copilot-cli issue #2392、OpenAI「Hooks」「Subagents」、Codex `projects.<path>.trust_level`（config reference）、Kiro Docs「Hooks (CLI)」「Custom agents configuration reference」「Invoking as sub-agents」、kirodotdev/Kiro issue #7755。
