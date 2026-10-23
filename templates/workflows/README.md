# templates/workflows — kit が同梱する標準 workflow

`aidev create workflow <name> --from <standard>` が PKG に複製する雛形です。1 つの標準 workflow は 1 ディレクトリで、次を持ちます。

| path | 複製先 | 内容 |
| --- | --- | --- |
| `<standard>/workflow.yaml` | `.aidev/workflows/<name>/workflow.yaml`（`name:` 行は `<name>` に書き換える） | 定義。PKG ごとに違う値は `inputs:`（値は `aidev.yaml` の `workflows.<name>.inputs` か `--input`）と `env_required:`（shell の環境変数）で受け取り、YAML には書かない |
| `<standard>/agents/<agent>.md` | `.aidev/agents/<agent>.md` | その workflow の agent（frontmatter に能力） |
| `<standard>/skills/<skill>/SKILL.md` | `.aidev/skills/<skill>/SKILL.md` | agent が frontmatter で参照する skill |
| `<standard>/README.md` | （複製しない） | 使い方の要約（流れ・前提・複製から実行までの手順）。`aidev create workflow --from` が場所を案内する |
| `<standard>/sandbox/scenario.js` | （複製しない） | sandbox の筋書き（下記）。kit 開発者が `npm run sandbox -- <standard>` でその workflow を端から端まで動かすためのもので、必須 |

複製したあとは PKG のファイルです。`templates/claude/` と違い `aidev sync tools` は触らず、新しい版は `--from … --force` で複製し直して差分をレビューします。実行時に kit 側のファイルを参照することはありません。

`test/workflow.test.js` が、ここにある全 workflow が検証を通り、複製後に agent / skill が解決できることを確かめます。

## sandbox: 標準 workflow を実際に動かして確かめる

```bash
npm run sandbox -- --list              # 標準 workflow と、sandbox の筋書きの有無
npm run sandbox -- playwright-tests    # 端から端まで動かし、結果を検査する（network と browser が要る）
npm run sandbox -- playwright-tests --keep --json   # PKG・worktree・記録を残す。結果を JSON でも出す
```

`scripts/sandbox-workflow.js` は、使い捨ての PKG（`aidev init` 後の状態 + 筋書きの `files`）を作り、筋書きの `prepare`（test runner の install など）を流して commit し、`aidev create workflow <name> --from <standard>` で複製し、筋書きが起動したサービス（テスト対象のアプリ）に向けて `aidev run workflow <name> --trial --json` を `--dry-run` のあとに実行します。agent だけが本物ではなく、`AIDEV_CLAUDE_BIN` で `scripts/sandbox-agent.js` を指します: これは起動されるたびに step・対象・試行回数・inputs・prompt を筋書きの `agent(ctx)` に渡し、返ってきた `files`（worktree 相対）と `notes`（run の notes 相対）を書き、`report`（と確認役なら `verdict`）を claude adapter が読む stream-json で返します。それ以外（YAML の検証、worktree、`npm ci`、`until` の command が起動する test runner、再試行とその prompt、checkpoint、notes、trial の pull_request step）は実物です。

通るとわかること: 同梱の YAML・agent・skill が、kit の runner と実際の command（npm、Playwright …）の上で、筋書きが「有能な agent ならこう書く」と決めた内容で端から端まで動く。わからないこと: 実際の agent がその内容を書けるか（LLM は起動しない）、hooks の挙動（scripted agent はツールを呼ばない）。

kit 開発者の端末に Playwright が無くても動きます: 筋書きの `prepare` が使い捨て PKG に `@playwright/test`（端末にブラウザがある版、無ければ最新）を install して `package-lock.json` を作り、`playwright install chromium` でブラウザも入れます（どちらも network が要る。Linux で起動時に共有ライブラリが無いと言われたら、一度 `npx playwright install --with-deps chromium` を手で）。

筋書きが export するもの（`scripts/sandbox-workflow.js` の冒頭に同じ一覧）:

| export | 内容 |
| --- | --- |
| `description` | 1 行 |
| `workflowName` | PKG に複製するときの名前（省略時は標準 workflow の名前） |
| `files` | `{ 相対path: 本文 }`。PKG 自身のファイル（テスト対象のアプリ、test runner の設定） |
| `prepare({ pkgRoot, base })` | commit 前に PKG で流す `[{ command, args }]`（test runner の install） |
| `spec` / `fileInput` | file input の本文と、それを受ける input の名前（省略時 `spec`） |
| `inputs` | その他の input の値。`start()` が決める値（対象の URL）はここでは placeholder |
| `env` | run の環境変数。`env_required` の全部に値を与える（値が記録・prompt・commit のどこにも出ないことを runner が検査する） |
| `start({ pkgRoot, base })` | テスト対象のサービスを起動し `{ inputs, env, stop }` を返す |
| `agent(ctx)` | scripted agent。`ctx` は `{ workflow, step, role ('agent' / 'until'), stepId, item, attempt, inputs, prompt, worktree, notesDir }`、戻りは `{ files, notes, report, verdict }` |
| `expect({ record, worktree, runDir, log, calls, inputs, git })` | 共通の検査（run が終わった、全 step が通った、push していない、秘密が漏れていない）に加えて確かめること。問題があれば throw |

`test/sandbox.test.js`（`npm test` の一部）は、全標準 workflow に筋書きがあり形が正しいこと、scripted agent が各 step・各対象・再試行・確認役の起動すべてに答え、`writable`（と run の notes）の外に書かないことを、実 command なしで確かめます。
