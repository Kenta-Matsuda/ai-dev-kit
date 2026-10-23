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
- 前提（ログイン済み、特定のデータがある）は `test.beforeEach` で helper を使って作り、`test.afterEach` で戻す（下の「前提条件はテストが作り、終わったら戻す」）。他のテストの結果に依存しない
- 仕様にあって実装に無い振る舞い、期待結果が曖昧で検証できないものは、推測で緩めず `test.fixme(true, '<理由>')` にして最終報告に挙げる。前提のデータが環境に無いことは fixme の理由にならない（テストが作る）

## ロケータと待ち方

- 役割ベースを優先する: `getByRole` → `getByLabel` / `getByPlaceholder` → `getByText` → `getByTestId`。CSS / XPath は最後の手段
- ロケータは推測で書かない。画面の実装（テンプレート・コンポーネント・ルーティング）を PKG のソースで確かめる。`.aidev/knowledge/` に画面の説明があれば先に引く
- 待ちは web-first assertion で行う: `await expect(locator).toBeVisible()`、`await expect(page).toHaveURL(…)`。`page.waitForTimeout` は使わない
- 画面遷移は、操作のあとに `toHaveURL` か遷移先に固有の要素の `toBeVisible` で確かめる

## 前提条件はテストが作り、終わったら戻す（冪等性）

仕様の「前提条件」（利用者 ID「ium12345」の利用者が登録されていること、商品 X があること）は、環境に用意されていることを当てにせず、**テストが自分で作る**。無いからといって `test.fixme` にしない。同じ環境で何度実行しても同じ結果になり、終わったあとの環境が始める前と同じであること（冪等性）を 1 ケースごとに守る。workflow の `until` は同じテストを 2 回続けて実行し、2 回とも通ることで判定する。

- **作り方**: アプリ自身の画面（登録画面、インポート）か、この PKG に既にある API / fixture / seed の仕組みで作る。どの画面でどう作り、どの画面で消すかは plan.md の「前提条件の作り方」にある。作る・戻す操作は `tests/e2e/support/` の helper にして（`ensureUser(page, {...})`、`removeUser(page, id)` のように）batch 間で共有する。scaffold step が plan.md に挙がった前提の分を書き、足りなければ batch の中に書いて review step で support/ にまとめる
- **ensure 型にする**: 作る helper は「無ければ作り、あれば何もしない」で、作ったかどうかを返す（`const created = await ensureUser(page, …)`）。仕様が固定の ID（`ium12345`）を指定していればその ID で作る。既にあれば既存を使い、消さない
- **戻す**: テストが作ったものだけを、結果にかかわらず消す（`test.afterEach`。`created` が真のときだけ）。テストが変えた値（設定、利用者の属性）は元に戻す。既存のデータを消す・変える操作は、仕様の手順にあるものだけ
- **独立**: 他のケースが作ったデータや実行順に依存しない。一意性が要るデータは、仕様が値を固定していなければ時刻や乱数を含む名前にする
- **本当に作れないものだけ fixme**: 外部システムのデータ、テストユーザーに権限の無い操作、実装に無い機能。`test.fixme(true, '<何を・なぜ作れないか>')` にして最終報告に挙げる。「環境に無い」は理由にならない
- ログインは `tests/e2e/support/login.ts` の helper（`login(page)`）だけを使う。画面の入力欄とボタンは plan.md の調査結果に従う
- 対象環境はチームの検証環境である。仕様に無い操作（設定の変更、大量の登録）はしない

書き方（前提「利用者 ID「ium12345」の利用者が登録されていること」）:

```ts
test.describe('TC-502', () => {
  let created = false;
  test.beforeEach(async ({ page }) => {
    await login(page);
    created = await ensureUser(page, { id: 'ium12345', name: 'テスト 利用者' });   // 無ければ利用者登録画面で作る。作ったら true
  });
  test.afterEach(async ({ page }) => {
    if (created) await removeUser(page, 'ium12345');                             // 自分で作ったときだけ消す
  });
  test('検索条件処理確認 / 検索文字が末尾文字一致パターン', async ({ page, evidence }) => {
    await test.step('利用者検索画面で利用者 ID に「12345」を入力し、後方一致で検索する', async () => { /* 手順 */ await evidence.capture('search-result'); });
  });
});
```

## 実行と通し方

- 自分で `npx playwright test <batch のディレクトリ>/ --reporter=list --retries=0 --output test-results/<batch>` を実行する（workflow の `until` も同じコマンドで判定する）。パスの末尾の `/` と `--output` は必ず付ける: 引数は正規表現で、`cart` は `cart-coupon` にも当たる。`--output` が無いと Playwright は既定の `test-results/` を丸ごと消し、同時に動く他の batch の結果を壊す
- 通らないときは失敗の出力（どの手順のどの expect か、実際の画面）を読み、原因を 4 つに分ける: ロケータが違う / 待ちが足りない / 仕様の読み違い / 前提が作れていない（データが無い）。4 つとも直す（データが無いなら作る helper を書く）。テストユーザーに権限が無い、実装に無い機能だけが `test.fixme` の理由になる
- `until` は同じ batch を 2 回続けて実行する。1 回目は通って 2 回目に落ちるなら、後始末が無い（固定 ID の重複登録、変えた値が戻っていない）か、他のケースの残りに依存している。自分で確かめるときも 2 回続けて実行する
- アサーションを弱めて通さない。`test.skip` で通さない。`retries` を増やさない
- この PKG に既にある Playwright のテスト（fixture・helper・命名・ディレクトリ）があれば、その書き方に合わせる

## エビデンス（画面キャプチャ）

テスト中の画面遷移を PNG で残し、実行後にエビデンスとして確認できるようにします。仕組みは `tests/e2e/support/evidence.ts` の fixture 1 つで、scaffold step が下の参照実装を **そのまま** 書きます（変えない。足りないものは別の helper に書く）。

- spec は `test`・`expect` を `support/evidence` から import し、`evidence` fixture を受け取る: `test('…', async ({ page, evidence }) => { … })`
- 各手順（`test.step`）の終わりに `await evidence.capture('<何が見えているか>')` を 1 回、最後の期待結果を確かめた後にも 1 回。label は画面の状態（`after-login`、`items-list`、`ログイン後`）で、認証情報の値は入れない。テストの終わりには fixture が結果にかかわらず `final` を自動で残す（失敗したときは原因がそこに写っている。`afterEach` の後始末の後の状態なので、最後の期待結果の直後の capture は省かない）
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
