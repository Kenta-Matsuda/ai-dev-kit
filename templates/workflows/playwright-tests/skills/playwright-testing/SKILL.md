---
name: playwright-testing
description: テスト仕様書から Playwright のテストを書くときの規約。接続情報は環境変数から読む、1 ケース 1 spec ファイル、役割ベースのロケータと web-first assertion、ログイン helper、通らないときの直し方、書いてはいけないこと。playwright-tests workflow の agent が使う。
---

# playwright-testing

テスト仕様書の 1 ケースを、環境変数 `E2E_BASE_URL`（workflow の入力 `base_url`）の環境に対する Playwright のテスト 1 つに写す手順と規約です。

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
- ファイル冒頭のコメントに、仕様のそのケース（ID・タイトル・前提・手順・期待結果）を **原文のまま** 写す。レビューする人が仕様と突き合わせられるようにする。ただし仕様にパスワード・トークンなど認証情報の値が書かれていれば `<credential>` に置き換える（コメントも PR に入る）
- `test.describe('<ケース ID>', …)` の中に `test('<仕様のタイトル原文>', …)` を 1 つ。手順ごとに `test.step('<手順の原文>', …)` で区切り、期待結果ごとに `expect` を書く。`test`・`expect` は `@playwright/test` からでなく `../../support/evidence` から import する（下の「エビデンス」）
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

- 自分で `npx playwright test <batch のディレクトリ>/ --reporter=list --retries=0 --output test-results/<batch>` を実行する（workflow の `until` も同じコマンドで判定する）。パスの末尾の `/` と `--output` は必ず付ける: 引数は正規表現で、`cart` は `cart-coupon` にも当たる。`--output` が無いと Playwright は既定の `test-results/` を丸ごと消し、同時に動く他の batch の結果を壊す
- 通らないときは失敗の出力（どの手順のどの expect か、実際の画面）を読み、原因を 4 つに分ける: ロケータが違う / 待ちが足りない / 仕様の読み違い / 環境の問題（データが無い、権限が無い）。前 3 つは直す。環境の問題は `test.fixme` に理由を付けて報告する
- アサーションを弱めて通さない。`test.skip` で通さない。`retries` を増やさない
- この PKG に既にある Playwright のテスト（fixture・helper・命名・ディレクトリ）があれば、その書き方に合わせる

## エビデンス（画面キャプチャ）

テスト中の画面遷移を PNG で残し、実行後にエビデンスとして確認できるようにします。仕組みは `tests/e2e/support/evidence.ts` の fixture 1 つで、scaffold step が下の参照実装を **そのまま** 書きます（変えない。足りないものは別の helper に書く）。

- spec は `test`・`expect` を `support/evidence` から import し、`evidence` fixture を受け取る: `test('…', async ({ page, evidence }) => { … })`
- 各手順（`test.step`）の終わりに `await evidence.capture('<何が見えているか>')` を 1 回、最後の期待結果を確かめた後にも 1 回。label は画面の状態（`after-login`、`items-list`、`ログイン後`）で、認証情報の値は入れない。テストの終わりには fixture が結果にかかわらず `final` を自動で残す（失敗したときは原因がそこに写っている）
- 保存先は `<E2E_EVIDENCE_DIR>/<ケース ID>/<NN>-<label>.png`。既定は Playwright を実行したディレクトリの `test-results/evidence/`、ケース ID はファイル名から。全ページ、パスワード欄はマスク。Playwright のレポートにも添付される
- review step の最後の全体実行で全ケースの分が揃う。`test-results/` は workflow の `never_commit` なので PR には入らず、実行の worktree に残る。PR に入れるなら、複製した YAML の `review` step の `env` に `E2E_EVIDENCE_DIR: evidence`、`writable` に `evidence/**` を足す

参照実装（scaffold step がこのまま書く）:

```ts
// tests/e2e/support/evidence.ts — 画面キャプチャをエビデンスとして残す fixture（playwright-testing skill の参照実装）
import { test as base, expect, type Page, type TestInfo } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

// 保存先のルート。既定は Playwright を実行したディレクトリの test-results/evidence/（workflow の never_commit の中）
const ROOT = process.env.E2E_EVIDENCE_DIR || path.join('test-results', 'evidence');

/** 1 テストの画面キャプチャ: <NN>-<label>.png を順に保存し、Playwright のレポートにも添付する。 */
export class Evidence {
  private n = 0;
  private readonly page: Page;
  private readonly info: TestInfo;
  readonly dir: string;

  constructor(page: Page, info: TestInfo, dir: string) {
    this.page = page;
    this.info = info;
    this.dir = dir;
  }

  /** 手順の終わりと、期待結果を確かめた後に呼ぶ。label は何が見えているか（例 'after-login', 'items-list'）。 */
  async capture(label: string): Promise<string> {
    this.n += 1;
    const name = `${String(this.n).padStart(2, '0')}-${label.replace(/[^\p{L}\p{N}._-]+/gu, '_')}.png`;
    const file = path.join(this.dir, name);
    fs.mkdirSync(this.dir, { recursive: true });
    await this.page.screenshot({ path: file, fullPage: true, mask: [this.page.locator('input[type="password"]')] });
    await this.info.attach(name, { path: file, contentType: 'image/png' });
    return file;
  }
}

export const test = base.extend<{ evidence: Evidence }>({
  evidence: async ({ page }, use, testInfo) => {
    // ケース ID はファイル名から（tc-012.spec.ts → tc-012）。前回の分は消し、この実行の分だけ残す
    const caseId = path.basename(testInfo.file).replace(/\.(spec|test)\.[cm]?[jt]sx?$/, '');
    const dir = path.join(ROOT, caseId);
    fs.rmSync(dir, { recursive: true, force: true });
    const evidence = new Evidence(page, testInfo, dir);
    await use(evidence);
    // 最後の状態は結果にかかわらず残す（失敗したときは原因がここに写っている）
    try { await evidence.capture(testInfo.status === 'passed' ? 'final' : `final-${testInfo.status}`); } catch { /* ページが閉じていれば諦める */ }
  },
});

export { expect };
```

## 書いてはいけないもの

- 認証情報の値（仕様から写したコメントの中も）、`.only`、`page.waitForTimeout`、`playwright.config.*` / `package.json` の変更、`console.log` による値の出力。テストを書く step では `tests/e2e/` の外（実行の notes ディレクトリを除く）に書かない
