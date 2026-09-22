# 提案: 1 行でインストールする（`irm <url> | iex`）

日付: 2026-09-22 / 状態: 提案（未実装。ホスティング先 URL は未確定）

## ねらい

いまのインストールは「clone → cd → installer 実行 → 新しいターミナル」の 4 手順で、`<kit-url>` と clone 先を利用者が決める。これを AWS CLI や Scoop と同じ 1 行にする。

```powershell
# Windows
irm https://<kit-install-url>/install.ps1 | iex
```

```bash
# macOS / Linux / WSL
curl -fsSL https://<kit-install-url>/install.sh | bash
```

同じ行をもう一度実行すると更新になる（clone を `origin/main` へ fast-forward して launcher を置き直す）。`aidev update` はそのまま残す。

## 手元で確認した PowerShell の挙動（設計の前提）

pwsh 7.x と Windows PowerShell 5.1 の両方で確認した。

| 挙動 | 結果 | 設計への影響 |
| --- | --- | --- |
| 先頭の `[CmdletBinding()] param(...)` | `iex` 経由でも動く。既定値に `$env:AIDEV_*` を使える | 既存 `install.ps1` の param 構造を保てる |
| `$PSScriptRoot` / `$MyInvocation.MyCommand.Path` | `iex` 経由では空 | 「自分がどこから実行されたか」でモードを判定できる |
| `iex` の中の `exit` | 呼び出し元のセッションごと終了する | 取得直後に走る経路では `exit` を使わない。`throw` にする |
| `Set-StrictMode` / `$ErrorActionPreference` | `iex` 経由だと利用者のセッションに残る | 取得直後の経路はスコープを閉じる（後述の子プロセス方式） |
| `iex` と ExecutionPolicy | 文字列の評価なので `Restricted` でも動く | ただし clone 内の `.ps1` をファイルとして実行すると policy に掛かる |

## 設計

### 1. スクリプトは 1 つ、モードは 2 つ

`scripts/install.ps1` と `scripts/install.sh` を増やさず、実行のされ方で分岐する。URL に見えるファイル名が `install.ps1` / `install.sh` のままになり、docs の説明も 1 本で済む。

| モード | 判定 | 仕事 |
| --- | --- | --- |
| local（現行） | `$PSScriptRoot` が空でない / `${BASH_SOURCE[0]}` が空でない | いまと同じ。clone の中から launcher を置く |
| remote（新設） | `$PSScriptRoot` が空 / `${BASH_SOURCE[0]}` が空 | clone を用意し、clone 内の同じスクリプトを local モードで実行する |

remote モードの手順:

1. `git` があることを確認する（`node` の確認は local モードに任せる）。
2. `AIDEV_KIT_DIR` に clone が無ければ `git clone --branch <ref> <url>`。あれば `git fetch origin` と `git merge --ff-only origin/<ref>`。
   作業ツリーが汚れている、`main` でない、diverged のときは `aidev update` と同じ文言で止める（削除して再実行するか、`aidev update` の案内）。
3. clone 内の `scripts/install.ps1` を **子プロセス** で実行する。
   `& (Get-Process -Id $PID).Path -NoProfile -ExecutionPolicy Bypass -File "<kit>\scripts\install.ps1"`
   5.1 なら `powershell.exe`、7 なら `pwsh.exe` がそのまま使われる。POSIX は `bash "<kit>/scripts/install.sh"`。
4. 子の終了コードが 0 でなければ `throw`。
5. 子が user PATH に書いた bin ディレクトリを、この場のセッションの `$env:Path` にも足す（子プロセスの `$env:Path` 変更は親に戻らないため）。
6. `next: aidev doctor` を表示する。

子プロセスにする理由は 3 つ。local モードの `exit 1` をそのまま使える、`Restricted` な端末でも clone 内の `.ps1` を実行できる、`Set-StrictMode` などを利用者のセッションに残さない。

remote モード部分は全体を `& { ... }` で囲み、`param` の後にモード判定を置く。`exit` はこのブロックに書かない。

bash 側は末尾で `main "$@"` を呼ぶ形にして、ダウンロードが途中で切れたときに半端な内容が実行されないようにする。`curl | bash` では stdin がスクリプト本体なので、対話入力を読まない（git の認証プロンプトは `/dev/tty` を使うので影響しない）。

### 2. 引数ではなく環境変数で調整する

`irm | iex` には引数を渡せない。既存の `AIDEV_BIN_DIR` と同じ流儀で環境変数に統一する。

| 変数 | 既定 | 用途 |
| --- | --- | --- |
| `AIDEV_KIT_URL` | スクリプト内の定数（後述） | clone 元 |
| `AIDEV_KIT_REF` | `main` | clone するブランチ。CI 用 `pipelines/` の変数と名前を揃える |
| `AIDEV_KIT_DIR` | 後述 | clone 先（`installRoot`） |
| `AIDEV_BIN_DIR` | 現行どおり | launcher の置き場所 |
| `AIDEV_NO_PATH_UPDATE` | 未設定 | `1` なら user PATH を書かない。テスト用 |

引数を渡したい場合の書き方も docs に 1 行だけ載せる: `& ([scriptblock]::Create((irm <url>))) -BinDir C:\x`。

### 3. clone 先の既定

利用者が clone 先を決めなくてよいように既定を持つ。

| OS | 既定 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\ai-dev-kit\kit` |
| POSIX | `${XDG_DATA_HOME:-~/.local/share}/ai-dev-kit/kit` |

どちらも `AIDEV_HOME` の既定と同じ親ディレクトリで、Windows ではパスが短い。`aidev uninstall` は `installRoot` の削除コマンドを表示する仕組みが既にあるので変更不要。`cli/lib/home.js` 冒頭の「kit checkout は AIDEV_HOME の外」というコメントは「`kit/` に置くが registry とは独立」に書き換える。

手で clone した既存の利用者は local モードのまま使えるので移行作業は無い。

### 4. URL の置き場所（未確定のあいだの扱い）

URL は次の 3 か所に現れる。実装時はプレースホルダを入れ、確定したら一度に差し替える。

| 場所 | 内容 |
| --- | --- |
| `scripts/install.ps1` / `install.sh` の定数 `DEFAULT_KIT_URL` | clone 元の git URL。プレースホルダは `__AIDEV_KIT_URL__` |
| `docs/user-guide/_attributes.adoc`（JA/EN） | `:kit-url:`（git URL）と `:kit-install-url:`（スクリプトの配信 URL）。本文はこの属性だけを参照する |
| `README.md` | 1 行インストールの例 |

定数がプレースホルダのままなら、スクリプトは `AIDEV_KIT_URL` が設定されているときだけ動き、未設定なら「配信 URL が未設定。`AIDEV_KIT_URL` を指定する」と止める。テストは `AIDEV_KIT_URL` を渡すので、URL 未確定でも実装と検証は完了できる。

URL が確定したら、3 か所が同じ値かを `test/install.test.js` が突き合わせる（プレースホルダのあいだはこの検査を skip）。`pipelines/*.yml` の `AIDEV_KIT_URL` は既に変数なので触らない。

### 5. ホスティング先ごとの制約

`git clone` と「スクリプト本文の取得」は別の経路で、後者が匿名 GET できるかで 1 行が成立するかが決まる。

| ホスティング | スクリプトの URL | 匿名取得 |
| --- | --- | --- |
| GitHub public | `https://raw.githubusercontent.com/<org>/ai-dev-kit/main/scripts/install.ps1` | 可 |
| GitHub private | 同上 | 不可。token ヘッダーが要るので 1 行にならない |
| Azure DevOps public project | `https://dev.azure.com/<org>/<project>/_apis/git/repositories/ai-dev-kit/items?path=/scripts/install.ps1&api-version=7.1&download=true`（要確認） | 可 |
| Azure DevOps private project | 同上 | 不可。`irm -Headers @{Authorization=...}` が必要 |

private にする場合は、スクリプトだけを匿名で置ける場所（Azure Static Web Apps、Blob の公開コンテナ、社内の静的サイトなど）に自動で同期する経路が要る。これは URL 確定と一緒に決める。

`git clone` 側は private でもよい。Git Credential Manager がブラウザ認証を出すので PAT を環境変数に入れる必要は無い。

`irm` と `curl -L` はリダイレクトを追うので、短い入口 URL は後から被せられる。

スクリプト本文は ASCII だけで書く。5.1 の `irm` はレスポンスに charset が無いと ISO-8859-1 で読むため、非 ASCII を含めると壊れる（Azure DevOps の items API は charset を返さないことがある）。既存の `install.ps1` は既に ASCII なので、コメントや文言を増やすときに守る。

### 6. 安全面

`iex` は取得した内容を検査せずに実行する。docs には「中身を確認してから実行する」書き方も併記する。

```powershell
irm https://<kit-install-url>/install.ps1 -OutFile install.ps1
Get-Content .\install.ps1
.\install.ps1
```

https 以外の URL は使わない。ブランチは `main` 固定（`AIDEV_KIT_REF` で変えられるが docs には書かない）。

## 変更するファイル

| ファイル | 変更 |
| --- | --- |
| `scripts/install.ps1` | remote モード追加。`param` に `KitDir` / `KitUrl` / `KitRef`。`AIDEV_NO_PATH_UPDATE` |
| `scripts/install.sh` | 同上。`main` 関数化 |
| `cli/lib/home.js` | 冒頭コメント（kit checkout の置き場所） |
| `cli/commands/doctor.js` | `installRoot` を表示する行が無ければ足す（利用者が clone 先を知る手段） |
| `test/install.test.js` | 新規（後述） |
| `README.md` | インストール節を 1 行に |
| `docs/user-guide/chapters/02-install.adoc`、`en/chapters/02-install.adoc` | 手順を 1 行 + 確認に。手動 clone は「別の場所に置きたい場合」に格下げ |
| `docs/user-guide/chapters/10-troubleshooting.adoc`、`en/...` | 「`irm` が 401/404」「`git` が無い」「clone が汚れている」の行を追加 |
| `docs/user-guide/appendices/a-environment.adoc`、`en/...` | `AIDEV_KIT_URL` / `AIDEV_KIT_REF` / `AIDEV_KIT_DIR` を追加 |
| `docs/user-guide/_attributes.adoc`、`en/_attributes.adoc` | `:kit-url:` `:kit-install-url:` |
| `docs/developer-guide/architecture.md` | launcher の行に remote モードと既定の clone 先 |

## テスト（`npm run check` に載せる）

ネットワークは使わない。kit 自身（`ROOT`）を `file://` で clone 元にする。

1. **remote モード（bash）**: `AIDEV_KIT_URL=file://<ROOT>`、`AIDEV_KIT_DIR`・`AIDEV_BIN_DIR`・`HOME` を一時ディレクトリにして `bash -s < scripts/install.sh` を実行。clone が `main` で `origin` を持つこと、launcher が置かれて `--version` が動くことを確認する。
2. **remote モード（PowerShell）**: win32 のときだけ。`Get-Content -Raw scripts/install.ps1 | iex` を `pwsh -NoProfile -Command` で実行し、`powershell.exe` があれば 5.1 でも同じことを行う。`AIDEV_NO_PATH_UPDATE=1` で user PATH を触らない。
3. **再実行**: 1 と 2 をもう一度走らせ、fast-forward で終わり launcher が置き直されること。clone に未コミット変更を作ってから走らせると止まること。
4. **URL 未設定**: `AIDEV_KIT_URL` を外し、定数がプレースホルダなら止まること。
5. **local モード**: 既存の手動手順が壊れていないこと（clone の中から実行して launcher が置かれる）。
6. **URL の一致**: 定数と `_attributes.adoc` と README が同じ URL であること（プレースホルダ中は skip）。

`bash` / `pwsh` が無い環境では該当ケースを skip して理由を出す。既存の `test/assets.test.js` の kit ファイル一覧（`scripts/install.*`）は変えない。

## 実装の順序

1. `install.sh` に remote モードと `main` 関数化を入れ、テスト 1・3・4・5 を書く。
2. `install.ps1` に remote モードを入れ、テスト 2 を足す。5.1 と 7 の両方で手元確認する。
3. `home.js` コメント、`doctor` の表示。
4. docs（JA → EN）、README、`npm run docs:check`。
5. `npm run check`。
6. `CHANGELOG` / リリース。

## URL 確定後にやること

- [ ] 配信 URL の匿名 GET を `irm` と `curl` で確認する（5.1 では charset も見る）
- [ ] `scripts/install.ps1` / `install.sh` の `DEFAULT_KIT_URL` を差し替える
- [ ] `_attributes.adoc`（JA/EN）の `:kit-url:` `:kit-install-url:` を設定する
- [ ] `README.md` の 1 行を実 URL にする
- [ ] テスト 6 の skip が外れて通ることを確認する
- [ ] private ホスティングなら、スクリプトの匿名配信先とその同期（CI）を用意する

## 決めておくこと

- **公開か非公開か。** 非公開なら 1 行にするために配信先がもう 1 つ要る（§5）。
- **clone 先の既定を `%LOCALAPPDATA%\ai-dev-kit\kit` にしてよいか。** 見えにくい場所になるので `aidev doctor` で表示する。
- **スクリプト名。** URL に見えるので `install.ps1` / `install.sh` のままにする案（本提案）。`get-aidev.ps1` のように分ける案は docs が 2 本になる。
