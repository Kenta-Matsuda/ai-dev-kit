# implement-task — タスクから実装して PR にする標準 workflow

タスク（Issue 本文・依頼文）を `--task` で渡すと、planner がこの PKG のソースを調べて「どこを、どう変え、何で確かめるか」を決め、implementer がテスト付きの最小の変更を書いてこの PKG のテストを通し、reviewer がタスクを満たしているかを確かめて、PR にします。

この README は複製されません（複製されるのは `workflow.yaml`、`agents/`、`skills/`）。使い方の正本はユーザーガイドの「標準 workflow から作る」節で、ここはその要約です。

## 流れ

| step | 内容 |
| --- | --- |
| `deps`（command） | `npm ci` で依存を実行用 worktree に入れる。pnpm / yarn / pip / gradle の PKG はこの command を直す |
| `plan`（agent、何も書かない） | タスクを受け入れ条件に書き直し、ソースを調べて、変えるファイル・足すテスト・作法・不明点を notes の `plan.md` に置く。タスクが無ければ止まる |
| `implement`（agent） | `plan.md` のとおりに実装し、テストを書き、`npm test` が通るまで直す（3 回まで）。README / docs も更新する |
| `review`（agent + 確認役 agent） | 指摘があれば直して `npm test` を通す。`task-reviewer` が受け入れ条件・テストの検証・余計な変更の有無・ドキュメントを突き合わせ、足りなければ差し戻す（2 回まで） |
| `pr` | PR を作る。本文にタスクの本文と各 step の報告が入る |

## 前提

- `npm ci` と `npm test` でこの PKG の依存が入りテストが動くこと（既定は Node.js。ほかの言語・ツールの PKG は複製した YAML の command を直す）
- ソース・テスト・ドキュメントが `src/`・`lib/`・`test/`・`tests/`・`docs/`・`README.md` にあること（違うなら `implement` / `review` の `writable` を直す。`writable` の外は agent が書けない）
- タスクは実行時に `--task "<本文>"` か `--task-file <file>` で渡す。定義にも `aidev.yaml` にも書かない

## 使い方

### 1. PKG に複製する（Engineering Manager）

```bash
aidev create workflow implement --from implement-task
```

`.aidev/workflows/implement/workflow.yaml`、`.aidev/agents/task-{planner,implementer,reviewer}.md`、`.aidev/skills/implementing-tasks/SKILL.md` が書かれます。複製した時点で PKG のファイルです。

### 2. この PKG で違うところを直す

この workflow に `inputs` はありません。違うところはすべて定義（複製した `workflow.yaml`）で直します。

- 依存を入れるコマンド（`deps` の `npm ci`）
- テストのコマンド（`implement` / `review` の `until.command` の `npm test`）
- 書いてよい場所（`implement` / `review` の `writable`）
- 費用の上限（`limits.max_usd`、既定 20）
- issue tracker の MCP server があれば `agents: { task-planner: { mcp: [...] } }` で planner に渡す（コメントにある）

### 3. 試して、提出する

```bash
aidev run workflow implement --dry-run --trial --task "src/calc.js に multiply を足す"   # 起動前の検査だけ
aidev run workflow implement --trial --task-file issue-123.md --max-usd 5              # 小さなタスクで試す。何も push しない
aidev submit workflow implement                                                        # レビューへ（マージが承認）
```

### 4. 実行する（Developer、マージ後）

```bash
git fetch origin
aidev run workflow implement --task-file issue-123.md
```

タスク本文は PR 本文の「Task」に入ります。費用の上限に達したら `--resume last` で続けられます（`--task` は渡し直さない）。

## 新しい版を取り込む

ADK を更新したら、`aidev sync workflow implement` を実行します。複製時に書かれた `.aidev/workflows/implement/standard.json` を元に、この PKG で直したところ（command、`writable`、agent の手順）を保ったまま、ファイルごとに ADK の変更を取り込みます: 編集していないファイルは置き換え、編集したファイルは複製時の版を base に 3-way merge、同じ行を両方が変えていれば衝突マーカー（解消してもう一度実行）。`--dry-run` で先に何が変わるかを見られます。`git diff` で差分をレビューして `aidev submit workflow` で提出します。実行時に ADK 側のファイルを参照することはないので、取り込まない限り承認済みの workflow は変わりません。

```bash
aidev update
aidev sync workflow implement --dry-run
aidev sync workflow implement
git diff
aidev submit workflow implement
```

`standard.json` の無い複製（記録が入る前に複製したもの）は `aidev sync workflow implement --from implement-task` と複製元を名指しします。定義ごと ADK の版に戻すなら `aidev sync workflow implement --force` です。
