# 提案: 自己進化（セッション内の振り返りと kit への PR）

日付: 2026-09-22 / 状態: 設計中（未実装）

## 大方針

- **振り返るのは、その作業をした本人（同じセッション）。** 後から別の agent に transcript を読ませるより、文脈を持つ本人が「どこで時間とトークンを無駄にしたか」を最も正確に言える。
- **kit 開発者の端末でだけ動く。PKG 利用者には見えず、コストもかからない。** 判定の鍵は PKG リポジトリに配布されるものではなく、端末側に置く。
- **変更先は kit のテンプレートであり、PKG ではない。** 改善は kit への PR として人間がレビューする。自動マージはしない。
- **記録するのは事実だけ。** プロンプト本文・応答・diff・Work Item 本文・秘密は残さない。

## ねらい

kit に同梱する agent の指示・skill・hook・既定値を、実際のセッションでの「処理時間・トークン・ミス」の観測から継続的に改善する。0.5.0 の `hook session-stop` は状態を記録するだけで、読む側が無い。

## 用語

| 語 | 意味 |
| --- | --- |
| Stop hook | Claude Code の hook イベント。**1 回の応答が終わるたび**に発火する（セッション終了ではない）。`session_id`、`transcript_path` を受け取る。`decision: "block"` と理由を返すと、Claude は止まらずその理由を指示として作業を続ける |
| SessionEnd | セッション終了時に 1 回発火する hook。ここでは Claude に何かを命じることはできない |
| transcript | `transcript_path` が指す JSONL。そのセッションのやり取り（ツール呼び出し、トークン使用量を含む）の全記録 |
| kit 開発者の端末 | `AIDEV_HOME/developer.json` がある端末（`aidev evolve enable` で作る。環境変数 `AIDEV_KIT_DEVELOPER=1` でも可） |
| 振り返り | セッション自身が書く改善メモ。`.aidev/cache/evolution/<session_id>.md` |

## 現状（0.5.0）

- `templates/claude/.claude/settings.json` の Stop hook が `aidev hook session-stop` を呼ぶ。
- hook は `.aidev/cache/pending-refresh.json` と `evolution-journal.json` に事実を記録するだけ。読む側は無い。
- `aidev.yaml` の `self_evolution.enabled` / `cadence` は記録の有無と周期を決めるが、PKG 利用者にも配布されている。

## 設計

### 1. 発動条件（kit 開発者の端末のみ）

- `aidev hook session-stop` は、`AIDEV_HOME/developer.json` も `AIDEV_KIT_DEVELOPER` も無ければ何もせず終了する。記録も書かない。
- `aidev.yaml` の `self_evolution` セクションは撤去する（PKG 側の設定で on/off する性質のものではない）。

### 2. いつ振り返るか（Stop hook）

- hook は transcript を読み、そのセッションの集計を取る: ツール呼び出し数、入出力トークン、cache の当たり外れ、権限拒否の回数、同じコマンドの再実行回数、経過時間。
- 次を満たすとき `decision: "block"` を返す。
  - 作業量が閾値を超えている（例: ツール呼び出し 30 回以上、または出力トークン 20k 以上）
  - このセッションでまだ振り返りを書いていない（`.aidev/cache/evolution/<session_id>.md` が無い）
  - `stop_hook_active` でない（block による続行中に再発火したときは素通し）
- block の理由に、集計値と振り返りの書式、出力先を含める。Claude は同じセッションの文脈で振り返りを書き、次の Stop で hook はファイルの存在を見て素通しする。
- 1 セッション 1 回。閾値未満のセッションは何も起きない。

### 3. 振り返りに書くこと（書式）

```markdown
# session <id> / <PKG name> / <tool> / <date>

## 事実
- 経過: 42 分、ツール呼び出し 87 回、出力 31k tokens、権限拒否 3 回
- 最も時間を使った段階: <段階> （<回数> / <tokens>）

## 無駄と原因
- <何が無駄だったか> — <原因（指示不足 / skill の手順 / hook の遅さ / 既定値）>

## kit への提案
- <どのテンプレートを、どう変えるか>（対象: templates/<tool>/<path>）

## 提案しないこと
- <PKG 固有で kit に入れるべきでないもの>
```

プロンプト本文・応答・diff は書かない（hook の理由文でも禁止を明示する）。

### 4. PR にする（`aidev evolve`）

- `aidev evolve` は kit 開発者の端末でだけ動く新コマンド。この端末の registry にある PKG の `.aidev/cache/evolution/*.md` を集め、kit の checkout（`installRoot`）で「evolution」agent を起動する。
- evolution agent は振り返りを読み、`templates/<tool>/` への変更をブランチ `aidev/evolve-<yyyymmdd>` にコミットする。settings の deny・hooks・policy に関わる緩和は変更対象外（agent 定義に明記し、`aidev check` 相当の検査でも弾く）。
- PR の作成先は kit checkout の `origin` から判定する: `dev.azure.com` / `*.visualstudio.com` → Azure DevOps（`ado.js` を流用）、`github.com` → GitHub API。設定は不要。kit の hosting を移しても追従する。
- 取り込んだ振り返りは `.aidev/cache/evolution/done/` へ移す。マージは人間。
- 起動は手動または cron を既定とする。Stop hook から `aidev evolve` を自動で呼ぶ選択肢は、agent を 1 本回すコストがあるため設定で opt-in（`developer.json` の `autoEvolve: true`）。

### 5. 他ツール

Stop hook 相当の仕組みがあるのは Claude Code だけ。Copilot / Codex / Kiro のセッションは当面対象外（transcript も取れない）。

## 影響範囲

| 場所 | 変更 |
| --- | --- |
| `cli/lib/home.js` | `developer.json` の読み書き（`aidev evolve enable` / `disable`） |
| `cli/commands/hook.js` | `session-stop` を書き直す: 開発者判定、transcript 集計、閾値、block 応答。`pending-refresh.json` / `evolution-journal.json` は廃止 |
| `cli/commands/evolve.js` | 新規: `enable` / `disable` / `run`（振り返りの収集、agent 起動、ブランチ、PR） |
| `cli/lib/config.js` | `self_evolution` セクション撤去 |
| `templates/claude/.claude/agents/evolution.md` | 新規 agent 定義（kit のテンプレートを改善する。緩和は禁止） |
| `cli/lib/ado.js` + 新 `cli/lib/github.js` | PR 作成の共通インターフェース（`origin` から判定） |
| docs | developer-guide に手順（利用者ガイドには書かない。利用者には無関係） |
| tests | hook の判定（開発者端末以外で何もしない、閾値、1 回だけ）、transcript 集計、evolve のブランチ・PR（stub） |

## 決めてほしいこと

1. 閾値の初期値（ツール呼び出し 30 回 / 出力 20k tokens）でよいか。
2. `aidev evolve` の自動起動を opt-in にするか、最初から自動にするか。
3. GitHub 側の PR 作成は `gh` CLI に頼るか、API を直接叩くか（`gh` なら認証を丸投げできる。API なら `GITHUB_TOKEN` が要る）。

## やらないこと

- PKG 利用者の端末で振り返りやジャーナルを書くこと。
- kit の deny・hooks・policy を緩める提案を自動で PR にすること。
- PR の自動マージ。
