---
name: playwright-testing
description: テスト仕様書から Playwright のテストを書くときの規約。接続情報は環境変数から読む、1 ケース 1 spec ファイル、役割ベースのロケータと web-first assertion、ログイン helper、通らないときの直し方、書いてはいけないこと。playwright-tests workflow の agent が使う。
---

# playwright-testing

テスト仕様書の 1 ケースを、`{inputs.base_url}` で動いている環境に対する Playwright のテスト 1 つに写す手順と規約です。

## 接続情報は環境変数から読む（値は書かない）

| 変数 | 内容 |
| --- | --- |
| `E2E_BASE_URL` | テスト対象環境のルート URL |
| `E2E_USER` | テストユーザーのログイン ID |
| `E2E_PASSWORD` | テストユーザーのパスワード（実行する人の shell にだけある） |

- `tests/e2e/support/env.ts` が 3 つを一か所で読み、無ければ **変数名を挙げて** throw する（値は出さない）。テストはこの module から受け取る
- URL・ユーザー名・パスワードを、テスト・設定・コメント・最終報告のどこにも書かない。`.env` も作らない
- `playwright.config.*` は変えられない（workflow の `writable` の外）。`baseURL` の設定に頼らず、`env.baseUrl` から `page.goto(new URL('/path', env.baseUrl).toString())` のように組み立てる。`test.use({ baseURL: env.baseUrl })` を spec の先頭に書いてもよい

## 1 ケース = 1 spec ファイル

- `tests/e2e/cases/<batch>/<ケース ID>.spec.ts`。ファイル名はケース ID を小文字の英数字とハイフンにしたもの（`TC-012` → `tc-012.spec.ts`）
- ファイル冒頭のコメントに、仕様のそのケース（ID・タイトル・前提・手順・期待結果）を **原文のまま** 写す。レビューする人が仕様と突き合わせられるようにする
- `test.describe('<ケース ID>', …)` の中に `test('<仕様のタイトル原文>', …)` を 1 つ。手順ごとに `test.step('<手順の原文>', …)` で区切り、期待結果ごとに `expect` を書く
- 前提（ログイン済み、特定のデータがある）は test の先頭で helper を使って作る。他のテストの結果に依存しない
- 仕様にあって実装に無い振る舞い、期待結果が曖昧で検証できないものは、推測で緩めず `test.fixme(true, '<理由>')` にして最終報告に挙げる

## ロケータと待ち方

- 役割ベースを優先する: `getByRole` → `getByLabel` / `getByPlaceholder` → `getByText` → `getByTestId`。CSS / XPath は最後の手段
- ロケータは推測で書かない。画面の実装（テンプレート・コンポーネント・ルーティング）を PKG のソースで確かめる。`.aidev/knowledge/` に画面の説明があれば先に引く
- 待ちは web-first assertion で行う: `await expect(locator).toBeVisible()`、`await expect(page).toHaveURL(…)`。`page.waitForTimeout` は使わない
- 画面遷移は、操作のあとに `toHaveURL` か遷移先に固有の要素の `toBeVisible` で確かめる

## ログインと状態

- ログインは `tests/e2e/support/login.ts` の helper（`login(page)`）だけを使う。画面の入力欄とボタンは plan.md の調査結果に従う
- データを作る・変えるケースは、一意な名前（時刻や乱数を含む）を使い、仕様に後始末があれば行う。削除系の操作は仕様にあるものだけ
- 対象環境はチームの検証環境である。仕様に無い操作（設定の変更、大量の登録）はしない

## 実行と通し方

- 自分で `npx playwright test <path> --reporter=list` を実行する（workflow の `until` も同じコマンドで判定する）
- 通らないときは失敗の出力（どの手順のどの expect か、実際の画面）を読み、原因を 4 つに分ける: ロケータが違う / 待ちが足りない / 仕様の読み違い / 環境の問題（データが無い、権限が無い）。前 3 つは直す。環境の問題は `test.fixme` に理由を付けて報告する
- アサーションを弱めて通さない。`test.skip` で通さない。`retries` を増やさない
- この PKG に既にある Playwright のテスト（fixture・helper・命名・ディレクトリ）があれば、その書き方に合わせる

## 書いてはいけないもの

- 認証情報の値、`.only`、`page.waitForTimeout`、`playwright.config.*` / `package.json` の変更、`tests/e2e/` の外のファイル、`console.log` による値の出力
