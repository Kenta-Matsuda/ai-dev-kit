# 提案: agent 単位の書き込み許可

日付: 2026-09-22 / 状態: 設計中（未実装）

## 大方針

- **既定は全員 read-only のまま。** PKG のソースを agent に書かせるのは、チームが policy で明示したときだけ。
- **「誰が書くか」は CLI が決め、agent は名乗れない。** agent 名は CLI が子プロセスを起動するときに環境変数で渡す。agent が自分の権限を広げる経路は作らない。
- **policy の変更は今までどおり人間が承認し、PR でレビューする。** 機構を足しても、承認の流れは変えない。

## ねらい

issue-to-pr のように PKG のソースを編集する agent を、`writable` を全員に開かずに動かせるようにする。0.5.0 で作業リースを撤去した後、ソースを書ける経路は「`writable` にパスを足す」だけになり、これは対話セッションを含む全員に開いてしまう。

## 用語

| 語 | 意味 |
| --- | --- |
| policy | `.aidev/policy.yaml`。`protected` / `read_only` / `writable` / `writable_during_sync` の 4 区分 |
| guard-write | PreToolUse hook（`aidev hook guard-write`）。Write / Edit / Bash のたびに対象パスを policy で判定する |
| CLI 起動 agent | `aidev agent run`、`aidev knowledge build` / `sync`、workflow の `ctx.agent` が子プロセスとして起動する agent |
| 対話セッション | 人が `claude` などを起動して作業しているセッション。サブエージェント呼び出しを含む |

## 現状（0.5.0）

- guard-write は対象パスだけを見る。「どの agent が書こうとしているか」を知る手段が無い。
- 判定順: protected → Wiki 整合性（sync lease）→ writable → read_only（拒否）。
- `read_only: ["**"]` が既定なので、Wiki・workflows・`aidev.yaml` 以外は書けない。issue-to-pr は実装したくてもソースを書けない。

## 設計

### policy の追加区分

```yaml
version: 1
protected: [...]
read_only: ["**"]
writable: [".aidev/knowledge/**", ".aidev/workflows/**", "aidev.yaml"]
writable_during_sync: [".aidev/knowledge/**"]
agents:
  issue-to-pr:
    writable: ["src/**", "tests/**"]
    branch: "aidev/issue-*"      # 任意。指定時はこのブランチ上でだけ有効
```

- `agents.<name>.writable`: その agent が CLI から起動されているときに追加で書けるパス。
- `agents.<name>.branch`: 任意。checkout のブランチがこの glob に一致するときだけ有効。detached HEAD は不一致扱い。
- `protected` と `secrets_paths` は `agents` より上位で、どう書いても書けない。
- `permission configure` の候補生成は `agents` を空で出す。足すのはチーム。`reconfigure --approve` の弱体化検出は「`agents` が増えた」も弱体化として `--force` を要求する。

### 「誰が書くか」の伝え方

- CLI が agent を起動するとき、子プロセスの環境に `AIDEV_AGENT=<name>` を入れる（`agent.runAgent`）。対象: `aidev agent run`、`aidev knowledge build` / `sync`、workflow `ctx.agent`。
- hook は Claude Code のプロセス環境を継承するので、guard-write は `process.env.AIDEV_AGENT` を読める。
- agent 自身は自分のプロセス環境を変えられない。Bash から `AIDEV_AGENT=x aidev hook ...` と打っても、hook を呼ぶのは Claude Code であって agent ではないので効かない。agent が別の `claude` を子として起動する経路は、policy の `protected` と `branch` 条件で被害を限定する。

### 判定順（変更後）

1. リポジトリ外 → 拒否
2. `protected` / `secrets_paths` → 拒否
3. Wiki 整合性 ERROR → sync lease の規則（現行どおり）
4. `writable` → 許可
5. `AIDEV_AGENT` が `agents` にあり、パスが `agents.<name>.writable` に一致し、`branch` 条件を満たす → 許可（理由に agent 名とブランチを含める）
6. `read_only` → 拒否（理由に「agent ごとの許可は policy の agents で」と案内）
7. それ以外 → 許可

### 対話セッションの扱い

人が対話セッションでサブエージェントとして issue-to-pr を呼んだ場合、hook が agent 名を確実に知る手段は未確認。この経路は当面 read-only のまま（`writable` を広げない限り）。ソースを書かせたいときは `aidev agent run issue-to-pr "..."` から起動する。Claude Code の hook 入力に agent 識別子が含まれることが確認できたら、`AIDEV_AGENT` と同じ扱いに広げる。

### 表示

- `aidev permission show` に `agents` を表示する。
- `aidev status` の policy 行に「agent 許可: issue-to-pr (src/**, tests/**)」を添える。
- 拒否理由の文面に、その agent に許可があるかどうかを含める（「issue-to-pr は src/** を書けますが、このセッションは CLI から起動されていません」など）。

## 影響範囲

| 場所 | 変更 |
| --- | --- |
| `cli/lib/config.js` | `validatePolicy` に `agents` を追加（名前は `AGENT_NAME_RE`、`writable` は glob 配列、`branch` は glob 文字列） |
| `cli/lib/policy.js` | 判定 5 を追加。`branch` は `git.currentBranch` |
| `cli/lib/agent.js` | `runAgent` が子プロセス環境に `AIDEV_AGENT` を入れる |
| `cli/commands/permission.js` | 候補生成・弱体化検出・`show` |
| `cli/commands/status.js` | policy 行 |
| templates | issue-to-pr agent の「必要権限」の説明、CLAUDE.md の書き込みルール表、permission-setting agent の規則 |
| docs | 08-permissions（JA/EN）、configuration-reference、architecture §3 |
| tests | policy（agent 許可・ブランチ条件・protected 優先）、permission（弱体化検出）、agent（環境変数の受け渡し） |

## 決めてほしいこと

1. `branch` を必須にするか任意にするか。必須にすると「issue-to-pr は必ず `aidev/issue-*` で作業する」が policy で強制できる。
2. `agents.<name>.writable` を `package.include` の内側に限定するか（撤去した作業リースはそうしていた）。
3. 対話セッションでの agent 判別を調べるか、当面は CLI 起動に限るか。

## やらないこと

- 一時的な許可（TTL 付きのリース）は再導入しない。許可は policy に書いてコミットする。
- `aidev.yaml` から policy を生成する項目は増やさない。policy は policy ファイルだけで決める。
