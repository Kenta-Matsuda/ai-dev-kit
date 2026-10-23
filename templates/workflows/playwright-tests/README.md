# playwright-tests — テスト仕様書から Playwright のテストを作る標準 workflow

テスト仕様書（CSV・Markdown・テキスト。1 行か 1 節が 1 ケース）の 1 ケースごとに Playwright のテストを書き、テスト対象環境に対して実行して通るまで直し、全件通ったら agent が仕様と突き合わせてレビューし、PR にします。ケースは batch に分けて同時に進めます。

この README は複製されません（複製されるのは `workflow.yaml`、`agents/`、`skills/`）。使い方の正本はユーザーガイドの「標準 workflow から作る」節で、ここはその要約です。

## 流れ

| step | 内容 |
| --- | --- |
| `deps`（command） | `npm ci` で依存を実行用 worktree に入れる。pnpm / yarn の PKG、テストが別ディレクトリにある PKG はこの command と `cwd` を直す |
| `playwright`（command） | `node node_modules/@playwright/test/cli.js --version`。`@playwright/test` がこの PKG の依存に無ければここで止まる（[Playwright がまだ無い PKG に入れる](#playwright-がまだ無い-pkg-に入れる最初の-1-回)） |
| `browsers`（command） | `npx playwright install chromium`。この端末にブラウザが無ければ入れ、あれば何もしない |
| `plan`（agent、何も書かない） | 仕様書を読み、ケースを画面・機能ごとに `batch_size` 以下の batch に分けて、実行の notes に置く |
| `scaffold`（agent） | `tests/e2e/support/` に共通 helper（環境変数の読み取り、ログイン）、`tests/e2e/smoke/` に smoke test を書き、対象環境に対して通す。URL・ユーザー・パスワード・ログイン画面のどれかが違えばここで分かる |
| `generate`（agent、`for_each`、既定で 4 batch 同時） | batch ごとに `tests/e2e/cases/<batch>/<ケース ID>.spec.ts` を書き、その batch のテストが **2 回続けて** 通るまで直す（3 回まで。2 回目だけ落ちるのは後始末の抜け）。通らなかった batch は戻して次へ進む（`on_failure: continue`） |
| `review`（agent + 確認役 agent） | 全体を 2 回続けて実行し、通らないものと重複した helper を直す。`playwright-test-reviewer` が仕様のケースごとに spec と検証内容を突き合わせ、足りなければ差し戻す（2 回まで）。この最後の全体実行で全ケースの画面キャプチャ（エビデンス）が揃う |
| `pr` | PR を作る。失敗して残った batch のケースは PR 本文の「Targets left out」に出る |

## 前提

- PKG に `@playwright/test`（と `package-lock.json`）と `playwright.config.*` があり、`testDir` が `tests/e2e/` を含むこと（別の場所に置くなら、複製した YAML のパスを直す）。無い PKG は次の節の手順で入れてから
- 実行する端末にブラウザが入っていること。無ければ `browsers` step が入れる（network が要る）
- `webServer` でローカルのサーバを起動する設定は、対象環境（`base_url`）に対するこの workflow では外すか、`generate` の `for_each.parallel` を 1 にする（同時に起動すると port がぶつかる）
- テストは `E2E_BASE_URL`・`E2E_USER`・`E2E_PASSWORD` を `process.env` から読む。前 2 つは各 agent step の `env` が入力から渡し、`E2E_PASSWORD` は実行する人の shell から届く

## Playwright がまだ無い PKG に入れる（最初の 1 回）

この workflow は Playwright を入れません。依存を足すのは PKG の判断で、PR でレビューするものだからです。無い PKG で実行すると最初の step で止まります（`deps` の `npm ci` は `package.json` / `package-lock.json` が無いと失敗し、`playwright` は `@playwright/test` が無いと失敗する。画面にその command の出力の末尾と step の説明が出ます。`--dry-run` はこれを見ません）。次を一度やって commit してから、複製・実行します。

**Node.js の PKG**（ルートに `package.json` がある）:

```bash
npm install --save-dev @playwright/test   # package.json と package-lock.json に入る（pnpm: pnpm add -D、yarn: yarn add -D。deps step の command も合わせる）
npx playwright install chromium           # この端末のブラウザ（workflow の browsers step も毎回確かめる）
```

`playwright.config.ts` が無ければ次を置く（あるなら `testDir` が `tests/e2e/` を含むことと、`webServer` を見直す）:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 0,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },   // テストは対象環境の URL を E2E_BASE_URL から読む（scaffold step の helper）
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
```

`.gitignore` に `node_modules/`、`test-results/`、`playwright-report/`、`blob-report/` を入れます。

`deps` の `npm ci` を `npm install` に変えても動きますが、worktree で変わった `package-lock.json` は `writable` の外なので commit されません。lockfile は上のとおり checkout で作って commit し、`npm ci` のままにする方が再現性があります。`npm ci` / `npm install` が **127** で止まるのは「command を起動できなかった」で、画面に出る出力の先頭に理由があります: `package.json` の `prepare` / `postinstall` が呼ぶ tool（husky、lefthook、patch-package など）が worktree に無い（`sh: husky: command not found`）なら、その tool を `devDependencies` に入れるか command を `npm ci --ignore-scripts` にする。`<command> was not found on PATH` なら aidev を動かす shell の PATH、`the directory <cwd> does not exist` なら `cwd`（worktree には commit されたものしか無い）を直す。

**Node.js でない PKG**（Java / Python / .NET など）: ルートに Playwright のためだけの `package.json` を置くのが簡単です（`npm init -y` のあと上の 2 行。アプリのビルドには関係しない）。別ディレクトリ（`e2e/` など）に置くなら、複製した YAML の `deps`・`playwright`・`browsers` の command に `cwd: e2e/` を、agent step の `until.command` にも `cwd: e2e/` を付け、`writable`・`never_commit`・`objective` のパスを `e2e/tests/e2e/…` に直します。

**ブラウザ**は端末ごと（CI runner も）に要ります。`browsers` step が `npx playwright install chromium` を毎回実行するので、入っていれば何もせず、無ければ download します（network が要る）。`playwright.config` の projects が firefox / webkit も使うなら、step のブラウザ名に足します。Linux で起動時に共有ライブラリが無いと言われたら、一度 `npx playwright install --with-deps chromium` を手で実行します（管理者権限が要るので step にはしない）。

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

## エビデンス（画面キャプチャ）

テストは手順ごとに画面キャプチャを残します。仕組みは `tests/e2e/support/evidence.ts` の fixture 1 つで（scaffold step が skill の参照実装をそのまま書く）、spec は `test`・`expect` をそこから import し、各手順の終わりに `await evidence.capture('<何が見えているか>')` を呼びます。テストの終わりには結果にかかわらず `final` が自動で残ります。

| 項目 | 内容 |
| --- | --- |
| 場所 | `<Playwright を実行したディレクトリ>/test-results/evidence/<ケース ID>/<NN>-<label>.png`（全ページ、パスワード欄はマスク）。環境変数 `E2E_EVIDENCE_DIR` で変えられる |
| 揃うとき | `review` step の最後の全体実行（`generate` の batch ごとの実行でも残るが、最後の全体実行が上書きする） |
| 実行後の見方 | 実行の worktree の `test-results/evidence/` を開く（画面の `worktree:` のパス）。Playwright のレポートにも添付される |
| PR に入れる | 既定では入らない（`test-results/**` は `never_commit`）。入れるなら、複製した YAML の `review` step の `env` に `E2E_EVIDENCE_DIR: evidence`、`writable` に `evidence/**` を足す（PNG が PR とリポジトリに入る） |
| 確認役 | `playwright-test-reviewer` が、`support/evidence` から import していない spec とキャプチャの無い手順を指摘する |

## 前提条件と冪等性

仕様の「前提条件」（利用者 ID「ium12345」の利用者が登録されていること、商品 X があること）は、環境に用意されていることを当てにせず、テストが自分で作って終わったら戻します。無いからといって `test.fixme` で飛ばしません。

| 項目 | 内容 |
| --- | --- |
| 作り方 | `plan` step が、前提の種類ごとに「どの画面で作り、どの画面で消すか」を plan.md に書く。`scaffold` step がそれを ensure 型の helper（`ensureUser(page, {...})` は無ければ作り、作ったかを返す。`removeUser(page, id)` は作ったものを消す）として `tests/e2e/support/` に書く |
| テストの形 | `test.beforeEach` でログインと前提の作成、`test.afterEach` で作ったものだけ削除（結果にかかわらず）。固定 ID が仕様にあればその ID で作り、既にあれば既存を使って消さない |
| 判定 | `generate` と `review` の `until` は同じテストを 2 回続けて実行し、2 回とも通ることで判定する。1 回目は通って 2 回目に落ちるなら後始末の抜け（固定 ID の重複登録、戻していない値） |
| fixme にしてよいもの | 外部システムのデータ、テストユーザーに権限の無い操作、実装に無い機能だけ。「環境に無い」は理由にならない（reviewer agent が指摘する） |
| 対象環境 | チームの検証環境。テストが消すのは自分で作ったものだけで、既存のデータを消す・変える操作は仕様の手順にあるものだけ |

## 新しい版を取り込む

ADK を更新したら、`aidev create workflow e2e-tests --from playwright-tests --update` を実行します。agent・skill が ADK の今の版に置き換わり（同じ内容なら残る）、この PKG で直した `workflow.yaml`（`cwd`、パス、`inputs` など）はそのままです。定義が ADK のものと違えば、比べるための `git diff --no-index` のコマンドが表示されるので、取り込みたい変更だけ写します。`git diff` で差分をレビューして `aidev submit workflow` で提出します。実行時に ADK 側のファイルを参照することはないので、取り込まない限り承認済みの workflow は変わりません。定義ごと ADK の版に戻すなら `--from … --force` です。
