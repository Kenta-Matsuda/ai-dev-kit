# playwright-tests — テスト仕様書から Playwright のテストを作る標準 workflow

テスト仕様書（CSV・Markdown・テキスト。1 行か 1 節が 1 ケース）の 1 ケースごとに Playwright のテストを書き、テスト対象環境に対して実行して通るまで直し、全件通ったら agent が仕様と突き合わせてレビューし、PR にします。ケースは batch に分けて同時に進めます。

この README は複製されません（複製されるのは `workflow.yaml`、`agents/`、`skills/`）。使い方の正本はユーザーガイドの「標準 workflow から作る」節で、ここはその要約です。

## 流れ

| step | 内容 |
| --- | --- |
| `deps`（command） | `npm ci` で依存を実行用 worktree に入れる。pnpm / yarn の PKG、テストが別ディレクトリにある PKG はこの command と `cwd` を直す |
| `playwright`（command） | `node node_modules/@playwright/test/cli.js --version`。`@playwright/test` がこの PKG の依存に無ければここで止まる |
| `plan`（agent、何も書かない） | 仕様書を読み、ケースを画面・機能ごとに `batch_size` 以下の batch に分けて、実行の notes に置く |
| `scaffold`（agent） | `tests/e2e/support/` に共通 helper（環境変数の読み取り、ログイン）、`tests/e2e/smoke/` に smoke test を書き、対象環境に対して通す。URL・ユーザー・パスワード・ログイン画面のどれかが違えばここで分かる |
| `generate`（agent、`for_each`、既定で 4 batch 同時） | batch ごとに `tests/e2e/cases/<batch>/<ケース ID>.spec.ts` を書き、その batch のテストが通るまで直す（3 回まで）。通らなかった batch は戻して次へ進む（`on_failure: continue`） |
| `review`（agent + 確認役 agent） | 全体を実行し、通らないものと重複した helper を直す。`playwright-test-reviewer` が仕様のケースごとに spec と検証内容を突き合わせ、足りなければ差し戻す（2 回まで） |
| `pr` | PR を作る。失敗して残った batch のケースは PR 本文の「Targets left out」に出る |

## 前提

- PKG に `@playwright/test` と `playwright.config.*` があり、`testDir` が `tests/e2e/` を含むこと（別の場所に置くなら、複製した YAML のパスを直す）
- 実行する端末にブラウザが入っていること（`npx playwright install`）
- `webServer` でローカルのサーバを起動する設定は、対象環境（`base_url`）に対するこの workflow では外すか、`generate` の `for_each.parallel` を 1 にする（同時に起動すると port がぶつかる）
- テストは `E2E_BASE_URL`・`E2E_USER`・`E2E_PASSWORD` を `process.env` から読む。前 2 つは各 agent step の `env` が入力から渡し、`E2E_PASSWORD` は実行する人の shell から届く

## 使い方

### 1. PKG に複製する（Engineering Manager）

```bash
aidev create workflow e2e-tests --from playwright-tests
```

`.aidev/workflows/e2e-tests/workflow.yaml`、`.aidev/agents/playwright-test-{planner,writer,reviewer}.md`、`.aidev/skills/playwright-testing/SKILL.md` が書かれ、入力の一覧・`aidev.yaml` に書く雛形・shell で設定する環境変数が表示されます。複製した時点で PKG のファイルです。

### 2. この PKG で違うところを直す

PKG ごとに違うものは 2 種類に分かれます。

- **定義で違うもの** → 複製した `workflow.yaml` を直す: 依存を入れるコマンド（`deps` の `npm ci`）、テストを置く場所（`tests/e2e/`）、同時に進める batch の数（`generate` の `for_each.parallel`、既定 4）、費用の上限（`limits.max_usd`、既定 50）
- **値で違うもの** → `aidev.yaml` に書く（定義は変えない）:

```yaml
workflows:
  e2e-tests:
    inputs:
      base_url: https://staging.example.com   # テスト対象環境のルート URL（ユーザー名:パスワード@ は入れない）
      test_user: qa-user@example.com          # テストユーザーのログイン ID
      batch_size: 10                          # 1 batch のケース数（省略時 10）
```

- **認証情報** → ファイルには書かない。実行する人が shell で設定する:

```bash
export E2E_PASSWORD='…'
```

`aidev.yaml` は `password` / `token` などの名前の入力と、パスワード入りの URL・トークンらしい値を拒否します。

### 3. 試して、提出する

```bash
aidev run workflow e2e-tests --dry-run --trial --input spec=~/specs/login.csv      # 起動前の検査だけ（env の行に E2E_PASSWORD: set / NOT SET）
aidev run workflow e2e-tests --trial --input spec=~/specs/login.csv --max-usd 5   # 少ないケースで試す。何も push しない
aidev submit workflow e2e-tests                                                    # レビューへ。マージが承認
```

### 4. 実行する（Developer、マージ後）

```bash
git fetch origin
export E2E_PASSWORD='…'
aidev run workflow e2e-tests --input spec=~/specs/all-cases.csv   # base_url / test_user は aidev.yaml から。--input で上書きできる
```

- 仕様書は `file: true` の入力です。実行する人の端末のファイルを渡します（Excel は CSV に書き出してから）。実行はそのコピーを `runs/<id>/inputs/` に置き、コミットしません
- `limits.max_usd` に達して止まったら `aidev run workflow e2e-tests --resume last` で続けられます
- 止まった理由から定義を直すには `aidev modify workflow e2e-tests --from-run last`

## 新しい版を取り込む

ADK を更新したら、もう一度 `aidev create workflow e2e-tests --from playwright-tests --force` で複製し直し、`git diff` で差分をレビューして `aidev submit workflow` で提出します。実行時に ADK 側のファイルを参照することはないので、取り込まない限り承認済みの workflow は変わりません。
