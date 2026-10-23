# lint-fix — lint の指摘を並列で直して PR にする標準 workflow

`aidev create workflow <name> --from lint-fix` で PKG に複製して使います。linter（eslint）の指摘を 1 ファイル 1 対象として同時に直し、全体の lint とテストが通ったら agent が「振る舞いを変えていないか」をレビューして PR にします。設定は変えず、`eslint-disable` も足しません。

## 流れ

| step | 内容 |
| --- | --- |
| `deps`（command） | `npm ci` で依存を実行用 worktree に入れる。pnpm / yarn の PKG はこの command を直す |
| `linter`（command） | `npx eslint --version`。`eslint` がこの PKG の依存に無ければここで止まる。他の linter を使う PKG は各 step の command を直す |
| `plan`（agent、何も書かない） | `npx eslint <scope> -f json` を実行し、`src/` の下で指摘のあるファイルを 1 行 1 ファイルで notes に置く（`src/` の外の指摘は review step へ） |
| `fix`（agent、`for_each`、既定で 4 ファイル同時） | ファイルごとに指摘を原因から直し、`npx eslint src/<file>` が通るまで直す（3 回まで）。通らなかったファイルは戻して次へ進む（`on_failure: continue`） |
| `review`（agent + 確認役 agent） | `npx eslint <scope>` と `npm test` を通し、残った指摘（`src/` の外、戻されたファイル）を直す。`lint-reviewer` が差分を読み、振る舞いの変更・指摘を黙らせた書き換え・設定の変更を指摘する（2 回まで） |
| `pr` | PR を作る。失敗して残ったファイルは PR 本文の「Targets left out」に出る |

## 前提

- PKG に `eslint` と設定（`eslint.config.*` か `.eslintrc.*`）があり、`npx eslint .` が動くこと。無い PKG はまず eslint を入れて設定を commit してから（この workflow は依存も設定も足しません）
- ソースが `src/` の下にあること。別の場所なら、複製した YAML の `fix` step の `src`（`writable`・`until`・prompt の 3 か所）と `review` step の `writable` を直す。`src/` の外のファイルの指摘は review step が順に直す
- `npm test` でテストが動くこと（review step の判定に使う。無い PKG は until の command から外す）
- 並列で直すのは 1 ファイル 1 対象で、同時に書くのはそのファイルだけ（`writable: [src/{item}]`）。import の整理のように複数ファイルにまたがる直しは review step で行われる

## 使い方

### 1. PKG に複製する（Engineering Manager）

```bash
aidev create workflow lint-fix --from lint-fix
```

`.aidev/workflows/lint-fix/workflow.yaml`、`.aidev/agents/lint-{planner,fixer,reviewer}.md`、`.aidev/skills/lint-fixing/SKILL.md` が書かれ、複製が `standard.json` に記録されます。複製した時点で PKG のファイルです。

### 2. この PKG で違うところを直す

- **値で違うもの** → `aidev.yaml` に書く（定義は変えない）: `scope`（eslint に渡す範囲。既定の `.` は設定の `ignores` 以外すべて）

```yaml
workflows:
  lint-fix:
    inputs:
      scope: src        # 省略時 .
```

- **定義で違うもの** → 複製した `workflow.yaml` を直す:

- 依存を入れるコマンド（`deps` の `npm ci`）
- linter（`linter` step と各 step の `npx eslint`。ruff や golangci-lint を使う PKG は command と、`lint-planner` が読む出力形式を合わせる）
- ソースの置き場（`fix` step の `src`、`review` step の `writable`）
- テストのコマンド（`review` の `until` の `npm test`）
- 同時に直すファイルの数（`fix` の `for_each.parallel`、既定 4）と費用の上限（`limits.max_usd`、既定 20）

### 3. 試して、提出する

```bash
aidev run workflow lint-fix --dry-run --trial     # 起動前の検査だけ
aidev run workflow lint-fix --trial --max-usd 5   # 試走。何も push しない。結果は aidev/lint-fix.trial に残る
aidev submit workflow lint-fix                    # レビューへ（マージが承認）
```

### 4. 実行する（Developer、マージ後）

```bash
git fetch origin
aidev run workflow lint-fix
```

費用の上限に達したら `--resume last` で続けられます。誤検知として残した指摘は、PR 本文の各 step の報告に出ます。

## 新しい版を取り込む

ADK を更新したら、`aidev sync workflow lint-fix` を実行します。複製時に書かれた `.aidev/workflows/lint-fix/standard.json` を元に、この PKG で直したところ（command、`src`、`writable`）を保ったまま、ファイルごとに ADK の変更を取り込みます: 編集していないファイルは置き換え、編集したファイルは複製時の版を base に 3-way merge、同じ行を両方が変えていれば衝突マーカー（解消してもう一度実行）。`--dry-run` で先に何が変わるかを見られます。`git diff` で差分をレビューして `aidev submit workflow` で提出します。

```bash
aidev update
aidev sync workflow lint-fix --dry-run
aidev sync workflow lint-fix
git diff
aidev submit workflow lint-fix
```

`standard.json` の無い複製は `aidev sync workflow lint-fix --from lint-fix` と複製元を名指しします。定義ごと ADK の版に戻すなら `aidev sync workflow lint-fix --force` です。
