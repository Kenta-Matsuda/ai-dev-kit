# ai-dev-kit

チームの各リポジトリ（PKG）に **共通の AI コーディングツール実行環境** と **PKG 専用の LLM Wiki** を配置し、`aidev` CLI で保守するキットです。

導入すると、PKG の clone に次が入ります。

- `.claude/`（agents・skills・hooks）、`CLAUDE.md` — チーム共通の Claude Code 設定。kit のテンプレートから `aidev sync tools` が配置・更新する。`.mcp.json` は PKG の所有（MCP server は PKG が用意する）
- `.aidev/knowledge/` — AI がソースを読む前に引く、根拠付きの Wiki。今いるブランチの HEAD を説明し、コミットのたびに hook が追従させて別コミットとして同じ PR に積む（手動は `aidev sync wiki`）
- `.aidev/policy.yaml` — AI が書いてよいパスの定義。hooks が毎回の書き込みを検査
- `aidev.yaml` — PKG 固有の設定（生成対象・秘密パス・Azure DevOps 接続先）

PR のマージは常に人間が行います。生成された Wiki のレビューは利用者の責任です。agent は `aidev sync wiki` と workflow から、`aidev.yaml` の `tools.agent`（agent ごとの上書きは `tools.agents.<name>`）で決めたツールで起動します。実機で検証済みのツールは Claude Code で、GitHub Copilot CLI・OpenAI Codex CLI・Kiro CLI のアダプタと hooks は各ツールの公開仕様に沿って実装しており未検証です。hosting は Azure DevOps または generic（git のみ）です。

## インストール（端末につき 1 回）

前提: Node.js 20+、Git、Claude Code 2.1.259+（他のツールを使う場合はそのツールの CLI）。

```powershell
# Windows
git clone <kit-url> C:\tools\ai-dev-kit
C:\tools\ai-dev-kit\scripts\install.ps1
```

```bash
# macOS / Linux / WSL
git clone <kit-url> ~/ai-dev-kit
~/ai-dev-kit/scripts/install.sh
```

新しいターミナルで `aidev --version` と `aidev doctor` を実行して確認します。

## PKG に導入する（導入担当者、PKG につき 1 人）

```bash
cd <pkg>
aidev init                              # 4 つの質問に答える（Enter で既定値）。Wiki は生成せず状態を報告するだけで、終了コードは Wiki に依存しない
aidev create policy --approve           # init で policy を置かなかった場合
aidev sync wiki --no-commit             # LLM Wiki を生成する（時間がかかる。止まったら再実行で続きから）
aidev check                             # 0 なら整合
git add aidev.yaml .aidev .claude CLAUDE.md
git commit -m "chore: adopt ai-dev-kit"
```

PR を作ってマージします。Azure DevOps の PKG では、事前に `AZURE_DEVOPS_PAT` を環境変数に設定します（ファイルには書きません）。

## 導入済みの PKG を使う（メンバー）

```bash
git pull
aidev init       # 質問なし。配布ファイルの確認と端末への登録だけ
aidev check     # 2 行目が ✅ なら準備完了
claude
```

## 日常

- `aidev check` — 状態を 1 画面で確認（`[ai-dev-kit] head=… knowledge=… tracking=…` と判定。`⚠️ … run "aidev sync wiki"` なら更新）
- `git commit` — AI ツールの中なら hook が Wiki の構造を更新し、本文は knowledge-builder のサブエージェントが書き、`aidev sync wiki --no-agent` で別コミットになる
- `aidev sync wiki` — 手動で Wiki を HEAD に追従させ、別コミットとして積む。`main` 上では一時 worktree で更新し `aidev/wiki-<sha12>` の PR を作る
- `aidev update` — kit 本体（CLI とテンプレート）を更新
- `aidev sync tools` — 新しいテンプレートを PKG に取り込む（編集済みはマージ。差分をコミット）
- `aidev sync workflow <name>` — 標準 workflow の新しい版を、PKG で直したところを保って複製に取り込む（差分をレビューして提出）
- `aidev check` — CI 用。0=ok / 1=設定・workflow / 2=drift / 3=権限 / 4=Wiki

## workflow（AI に仕事をさせる）

開発は `aidev run workflow <name>` から行います。workflow は `.aidev/workflows/<name>/workflow.yaml` に書く手順書で、agent step（何を書いてよいか `writable` で区切り、`until` のコマンドや確認役 agent が通るまで直す）と command step（`npm ci`、テスト）を並べ、最後の `pull_request` step で PR にします。PR でレビューされて `main` にあるものだけが実行されます。

- **どこで動くか**: 手元のチェックアウトではなく専用の git worktree（`<AIDEV_HOME>/worktrees/…`）で、workflow ごとのブランチ `aidev/<name>` の上で動き、ステップが通るたびにコミットします。記録（`run.json`、ログ、agent の報告、notes）は worktree の `.aidev/workflows/<name>/runs/<id>/` に残ります
- **試す**: 承認前の定義は `aidev run workflow <name> --trial` で試せます。手元の定義をそのままブランチ `aidev/<name>.trial` で動かし、何も push しません。`--dry-run` は起動前の検査だけ、`--resume last` は止まった実行の続きです
- **PKG ごとの値**: `inputs:` で宣言した値は `--input <name>=<value>` で渡すか、PKG ごとに同じ値なら `aidev.yaml` の `workflows.<name>.inputs` に書きます。パスワードなどの認証情報は `env_required:` に名前だけ宣言し、実行する人の shell の環境変数で渡します（どこにも記録されません）
- **agent の権限**: agent の frontmatter（`tools`・`mcp`・`skills`）と step の `writable` が全てで、hook が毎回の呼び出しを検査します。与えた `Bash` は実行中は承認済みとして扱われ（agent が自分でテストを動かせる）、`.claude/settings.json` の `deny` / `ask` と試走の push 禁止は効き続けます

### 標準 workflow

よくある仕事は標準 workflow として同梱しています。`aidev list workflows` の末尾に一覧が出ます。

| 標準 workflow | 内容 | 入力 |
| --- | --- | --- |
| `playwright-tests` | テスト仕様書（CSV など）の 1 ケースごとに Playwright のテストを書き、batch ごとに並列で通るまで直し、全件通ったら agent が仕様と突き合わせて PR。手順ごとの画面キャプチャをエビデンスとして残し、前提条件はテストが作って戻す（冪等） | `spec`（仕様書）、`base_url`、`test_user`、`batch_size`。環境変数 `E2E_PASSWORD` |
| `implement-task` | タスク（Issue 本文）を読んで計画し、テストと一緒に実装し、テストが通ったら確認役 agent がタスクと突き合わせて PR | `--task` / `--task-file` |
| `lint-fix` | lint の指摘があるファイルを並列で直し（ファイルごとに lint が通るまで）、全体の lint とテストが通ったら確認役 agent が検査して PR | `scope`（省略時 `.`） |
| `release-notes` | 前回の tag からのコミットを集め、CHANGELOG に次のバージョンの項を書き、確認役 agent が漏れを検査して PR | `version`、`since`（省略時は最新の tag） |

使い方は 4 段階です。

```bash
aidev create workflow e2e-tests --from playwright-tests      # 1. 複製する（agent・skill ごと PKG のファイルになる。使い方の README の場所が表示される）
#  2. この PKG で違うところを直す: 定義で違うもの（依存の入れ方、テストの場所、同時に進める数）は複製した YAML、
#     値で違うもの（対象環境の URL、テストユーザー）は aidev.yaml の workflows.e2e-tests.inputs、認証情報は shell の環境変数
aidev run workflow e2e-tests --trial --input spec=~/specs/login.csv --max-usd 5   # 3. 少ないケースで試す（何も push しない）
aidev submit workflow e2e-tests                                                    #    レビューへ（マージが承認）
aidev run workflow e2e-tests --input spec=~/specs/all-cases.csv                    # 4. 実行する（マージ後）
```

複製は `.aidev/workflows/<name>/standard.json` に記録されます。kit を更新して標準 workflow の新しい版を取り込むには `aidev sync workflow <name>` を実行します。この PKG で直したところを保ったまま、ファイルごとに kit の変更を取り込みます（編集していないファイルは置き換え、編集したファイルは複製時の版を base に 3-way merge、同じ行を変えていれば衝突マーカー）。記録の無い古い複製は `--from <standard>` で複製元を名指しします。

標準 workflow の雛形は `templates/workflows/<name>/` にあり、それぞれの `README.md` が流れ・前提・複製から実行までの手順を説明します。kit 開発者は `npm run sandbox -- <name>` で、使い捨ての PKG と筋書きどおりに書く agent を使って、標準 workflow が実コマンド（npm、Playwright、git）の上で端から端まで動くことを確かめられます（`templates/workflows/README.md`）。

自分の仕事の workflow は `aidev create workflow <name>`（雛形）か `--describe "<文>"`（workflow-creator agent が書く）で作り、`aidev modify workflow <name> --describe "<文>"` や `--from-run last`（止まった実行から直す）で育てます。

## ドキュメント

ユーザーガイドとコマンドリファレンス（1 コマンド 1 ページ）は `docs/user-guide/` にあります。

```bash
npm ci
npm run docs:build     # build/docs/ai-dev-kit-user-guide.html（日本語）と ai-dev-kit-user-guide.en.html（英語）
```

- 導入担当者の手順、メンバーの手順、日常の使い方、LLM Wiki、権限、自動化、トラブルシューティング
- `aidev.yaml` リファレンス、環境変数、PKG 内のファイル
- `aidev init` / `check` / `doctor` / `run|estimate|create|modify|edit|submit|list|remove … workflow` / `create agent|skill|policy` / `sync tools|wiki|workflow` / `update` / `uninstall [--all]`。PKG に作用するコマンドは `--package <name|path>`（`-p`）で対象を指定できる。詳細は `docs/developer-guide/cli-reference.md`

CI の例は `pipelines/azure-pipelines-check.yml`（PR ごとの `aidev check`）と `pipelines/azure-pipelines-wiki.yml`（夜間に `main` で `aidev check --no-remote` で状態を報告し、`aidev sync wiki --branch` で `aidev/wiki-<sha12>` の PR を作る。agent のツールと認証情報が必要）です。

kit 自体の設計と保守は [docs/developer-guide/](docs/developer-guide/README.md) を参照してください。

