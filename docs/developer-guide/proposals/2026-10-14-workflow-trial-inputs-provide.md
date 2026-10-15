# 提案: workflow の試走（trial）、入力（inputs）、worktree への補給（provide）と残骸の除外（never_commit）

日付: 2026-10-14 / 状態: 実装済み（2026-10-14。設計判断は `design-decisions.md` D27〜D29）

## 困っていること

PKG で workflow を作る人から、次の 5 点が挙がった。いずれも「workflow は試行錯誤で完成する」という実態と、「承認 = `origin/main` との一致」「実行 = 専用 worktree」という kit の仕組みの間の摩擦である。

| # | 困っていること | いまの仕組みで起きること |
| --- | --- | --- |
| 1 | 承認のたびに `main` にコミットが積まれる | 1 つの workflow が完成するまでに modify → submit → merge を何度も繰り返す。直すたびに `main` の履歴が workflow の試行錯誤で埋まる |
| 2 | `node_modules` などの残骸がコミットされる | 実行は専用 worktree で、`until.command` や command step の `npm ci` が `writable` の中（新しく作った `e2e/` など、`.gitignore` の無い場所）に `node_modules` を作る。checkpoint と pull-request step は `writable` の中の変更をすべて stage するので、残骸も PR に入る。作る人がこれを予見できず、agent は自分の責務以上のこと（`.gitignore` を書く）をしない |
| 3 | 実行に引数を渡せない | `--task` は自由文だけ。IT テスト作成 workflow に「テスト仕様書（Excel）のパス」のような入力を機械的に渡し、prompt やコマンドに入れる仕組みが無い |
| 4 | gitignore された資産が worktree に無い | テスト仕様書（別リポジトリ由来で gitignore 済み）や `node_modules` は新しい worktree に無い。command step で用意するのが原則だが、たいてい作成漏れする。仕様書のように「コマンドで作れないもの」には手段が無い |
| 5 | 直す → 承認 → 実行 → 失敗 → 直す、の繰り返し | 定義の誤りは実行して初めて分かる。承認を経ないと実行できないので、1 回の修正に PR のレビューとマージが挟まる。作るときに考慮できていないことが多いのに、確かめる手段が `--dry-run`（起動しない）しか無い |

5 の指摘が本質で、1 はその帰結である。2 と 4 は「worktree で動く」ことの帰結で、3 は独立した機能不足である。

## 決めたこと

### A. 試走（`aidev run workflow <name> --trial`）: 承認なしで最後まで動かし、何も push しない（困りごと 1・5）

承認が守っているのは「AI が PKG のソースを書ける範囲は、レビューされた定義の `writable` だけ」という線である。試走は、この線の **外側に出る経路（push と PR）を閉じたうえで**、承認の前に定義をそのまま動かす。push できる実行の根拠は引き続き hosting の承認（tracking branch）だけで、手元の記録が許すのは runner が push できない実行に限る（D27。D6 / D9 の承認の線をこの形で狭める）。

- 承認は要らない。定義が検証を通り、起動前の検査（`launchPlan` と E の `preflight`）に問題が無ければ動く
- branch は `aidev/<name>.trial`（`--dated` で `aidev/<name>.trial-<yyyymmddHHMM>`）、worktree は通常の実行と同じ `<AIDEV_HOME>/worktrees/<PKG>-<hash>/` の下の専用のもの（directory 名は `aidev-<name>.trial`）。`.` は workflow 名に使えない文字なので、`aidev/<name>` や他の workflow の branch とぶつからない
- **試走の branch は使い捨て**である。新しい試走（`--resume` でない）のたびに branch を checkout の HEAD へ `reset --hard` し（`worktreeSync: 'reset'`）、前の試走が残した未コミットの file を消す（「trial: N file(s) the last trial left were removed」）。残るのは git が無視する file と D の残骸だけなので、command step が入れた `node_modules` は次の試走でも使える。以前の試走の `runs/` は gitignore なので残り、`--from-run` から読める。D26 の「branch を保って base を merge する」の意図的な例外で、試走は「ここから実行したら何が起きるか」を見せるものであって、前の試走の上に積むものではない
- 手元の checkout の **今の定義**（`reviewedFiles`: `workflow.yaml` と、参照する PKG 内の agent と skill（`SKILL.md` のみ）。未コミットでよい）を worktree に複製し、`aidev(<name>): trial definition`（trailer `Aidev-Trial: definition`）としてコミットしてから始める。**それ以外の未コミットの変更は worktree に届かない**（実行は HEAD から始まる）。試走と `--dry-run --trial` は「the checkout has N uncommitted change(s) a run does not see (it starts from HEAD): …; commit them first if the steps need them」と警告する
- guard（policy 第 6 段と `decideToolUse`）は、承認の代わりに **試走の記録** を見る。runner が worktree の git directory（`<git dir>/aidev-trial.json`。作業 tree の外なので Write / Edit は rule 1 で拒否される）に `{ schemaVersion: 1, name, token, hash, runId, startedAt }`（`hash` = `reviewedHash`: reviewed files の path と LF 正規化した内容の sha256）を書き、**agent にだけ**（command step には渡さない）環境変数 `AIDEV_WORKFLOW_TRIAL=<token>` を渡す。hook は書込と tool 呼び出しのたびに worktree の reviewed files の hash を計算し直し、name・token・hash が一致する間だけその step の `writable` を許す（rule id `workflow-trial-writable`。理由文は「a trial run of the definition sha256:…」で、「approved on」とは言わない）。実行中に agent が定義（か使う agent / skill）を書き換えれば hash が変わり、承認済みの実行で定義を編集したときと同じく以後の書込が拒否される。記録は実行の終わり（Ctrl-C / SIGTERM でも）に消す。crash で残った記録は token がどの環境にも無いので不活性で、次の試走が上書きする。token はどの記録・log・出力にも出ない
- **push も PR 作成もしない**。pull-request step は commit まで行い（commit 本文に `approved: none (a trial run of the definition sha256:…)` と `trial run: not pushed`）、push と PR を飛ばす（`pr: { ok: false, trial: true, reason, branch, description }`、step の `pushed: false`）。これに加えて、(1) 全 child process（agent と command）に `GIT_CONFIG_*` 環境変数で `core.hooksPath`（kit の `cli/git-hooks/no-push/`。`pre-push` hook が「aidev: this is a trial run of the workflow; nothing is pushed from it」で拒否する。単一値なので repository に `pushurl` があっても効く）と `remote.origin.pushurl`・`url.….pushInsteadOf`（https / http / ssh / git@）を渡し、`git push` を失敗させる（step の `env` は runner の項目を上書きできず、`GIT_CONFIG*` は `env` に書けない）、(2) argv が `git … push` の command step / `until.command` は起動前に拒否する（「step X: "…" pushes; a trial run pushes nothing」）、(3) hook が agent の Bash の `git … push` / `gh pr create` / `az repos pr create` / `glab mr create` を deny する（「this is a trial run of the workflow; nothing is pushed and no pull request is opened from it」）
- **試走が保証すること・しないこと**: 試走が縛るのは runner と git である。他の tool や MCP server を通して agent ができることは、承認済みの実行と同じく PKG の allow rule が許す範囲で、レビューされていない定義のあらゆる副作用を止めるものではない（レビューされていない定義は agent に MCP server と allow-listed な Bash を与えられる。これは対話 session と同じ露出に、使い捨て worktree の中での step の `writable` を足したもの）。hosting の PAT は外さない（MCP server が必要とすることがある）。記録は作業 tree の外にあり、Bash が届くかは PKG の allow rule 次第で、これは今の origin の ref と同じ露出である
- 記録: `run.json` は `trial: true`、`trialHash`、`approvedRef: null`、`approvedSha: null` を持つ。estimate record は `trial: true` を持ち、`readRecords` / `collectHistory` は試走を読まない（次の見積もりに影響しない）。試走の後に自動の estimate reviewer は起動しない。`aidev modify workflow <name> --from-run last` は試走を受け付ける（digest の見出しに「(a trial run)」、入力と拒否された tool 呼び出しの一覧付き）
- `--resume` の規則: `--resume last` は同じ種類の最新の実行（`--trial` なら最新の試走、無しなら試走でない最新の実行。無ければ「workflow <name> has no recorded trial run (its runs were started without --trial)」/「… no recorded run that was not a trial (pass --trial to continue the last trial)」）。試走の再開には `--trial` が要り（「run <id> was a trial run; resume it with --trial」）、通常の実行は `--trial` 無しで再開する（「run <id> was not a trial run; resume it without --trial」。種類は記録の branch 名から読み、記録の flag は信用しない）。再開する試走は始めたときの定義を保つ: checkout の reviewed files の hash が `trialHash` と一致しなければ「the definition of <name> (or an agent or skill it uses) changed since trial run <id> started; start a new trial」。試走に限らず、終わった step の checkpoint が branch に無い実行（後の試走が reset した、merge 後に branch が動いた）は「the checkpoints of run <id> are no longer on <branch> …; start a new run」で再開を拒否する
- `--max-usd <n>`（`limits.max_usd` より下げる方向だけ）を `run` に足した。試走に限らず使える（`--dry-run` の `limits` 行は「$0.5 (limits.max_usd is $1)」）
- 画面: 試走の終わりに「trial run: nothing was pushed. <branch> holds N commit(s) since <base>」、確認用の git command、終わっていれば「when the result is right: aidev submit workflow <name>」。承認されていない workflow を `--trial` 無しで実行すると「To try it as it is first: aidev run workflow <name> --trial」、`--dry-run` は「dry run: the workflow is not approved and would be refused (try it as it is with --trial).」

これで「定義を編集 → `--trial` → 直す → `--trial` → 通ったら `submit`」が、`main` に 1 コミットも積まずに回る。`aidev create` / `modify` の後の案内（`nextSteps`）も 1. review、2. try（`--trial`）、3. submit、4. run の順になった。承認後の実行で初めて分かる失敗（別の task で踏む経路）は残るが、それは定義の変更としてレビューされるべきものである。

**却下した案**

- 承認の基準 branch を workflow ごとに変えられるようにする（`--approval-ref`）: 「どの branch が承認か」が増え、汚染が移るだけ。試走の「push しない」保証も得られない
- 定義をコミットしてそのコミットを承認扱いにする: 試行錯誤のたびにコミットが要り、`submit` はその時点の HEAD から branch を切るので、wip コミットが PR に混ざる
- `--dry-run` を拡張して agent を起動する: `--dry-run` は「何も始めない」ことが契約（`create` / `modify` / `submit` でも同じ）。別の flag にする
- 試走を別の動詞（`aidev try workflow`）にする: `run` の flag のほうが `--resume` / `--task` / `--input` / `--log` を共有でき、記録の形も同じになる
- hosting の PAT を agent の環境から外す: MCP server（Azure DevOps など）がそれを必要とすることがある。試走が縛るのは runner と git で、他の経路は PKG の allow rule に任せる
- 試走の終わりに worktree を消す: 結果と記録（`runs/`、`pull-request.md`）を見てから `submit` する。消すかどうかは未決

### B. 入力（`inputs:` と `--input name=value`）（困りごと 3）

```yaml
inputs:
  spec:
    description: the test specification to work from   # 実行する人、dry run、PR 本文のため
    file: true          # この端末のどこかにある file。実行はその複製を受け取る
  screen:
    description: the screen to cover
    pattern: '[a-z0-9-]+'   # quote する（裸の [ は YAML の list になる）
  browser:
    default: chromium
    pattern: '[a-z]+'
steps:
  - id: write
    agent: it-writer
    writable: [e2e/tests/**]
    prompt: "{inputs.spec} の {inputs.screen} の項目ごとにテストを書く。"
    until:
      command: npx playwright test --project {inputs.browser}
```

- 宣言は top-level の `inputs: { <name>: { description, default, pattern, path, file } }`。名前は `^[a-z][a-z0-9_-]{0,31}$`。**`required:` key は無い**: `default` の無い入力が必須である。`path` と `file` は排他で、`file` の入力は `default` を持てない
- 値は `aidev run workflow <name> --input spec=docs/spec/login.txt --input browser=firefox`（繰り返し可。`--input=name=value` も可）。必須の入力が無ければ「the workflow needs --input for: spec (the spec to work from)」（exit 1。何も始める前に。`--dry-run` でも）、宣言の無い名前は「the workflow declares no input "nope" (its inputs: …)」、同じ名前を 2 回は error。`--resume` と `--input` は同時に使えない（「--resume continues the run with the inputs it was started with; do not pass --input」）。`--resume` は記録の値を「与えられたもの」として検査し直す（`run.json` は agent が書ける file である）。`aidev estimate workflow <name> --input k=v` も取り、値は cost-estimator に渡す（必須の入力が無くても見積もりはできる。JSON の `inputs`）
- `{inputs.<name>}` を書ける場所: `objective`、agent step の `prompt`、`until.prompt`、`until.command`、command step の `command`、`env` の値（step と `until`）。それ以外（`description`、step の `description`、`pull_request.title`、`writable`、`unchanged`、`cwd`、`for_each.from`）は検証 error。command の実行 file（argv[0]）にはできない。宣言の無い `{inputs.x}` は error
- 置換は実行前に定義に対して行う（inputs が先、`{item}` は対象ごとに後）。値は template ではない: `{` と `}` を含めない
- 値の検査: 1 行、1000 文字以下、制御文字なし、`pattern` があれば全体が一致（kit が `^(?:…)$` で包む）。`default` も検証時に同じ検査を受ける
- **argv の whitelist**: command か env の値に届く入力（「reaches a command」）は `pattern` か `path: true` / `file: true` が必須で、その上で固定の whitelist `^[A-Za-z0-9._@][A-Za-z0-9._/@:=+-]{0,999}$`（`..` の segment なし）を満たすこと。`{item}` と同じ理由（argv の 1 要素になり、空白・先頭 `-`・上の directory を指す文字列を通さない）。作者の `pattern` はこれを狭められるが広げられない
- `path: true`: repo 相対の path（`/` 始まり・drive letter・`..` 不可）、text のみ（Excel / Word / PDF / 画像は reference と同じく「the AI tools read text; export … to Markdown, CSV or text first」で拒否）、worktree に届くもの（HEAD で tracked、または checkout で ignore されていて `provide` の glob に合う）。`--dry-run` と `run` が分類する: 「is not committed; a run starts from HEAD (commit it, or declare the input with file: true and pass the file)」/「is ignored by git and no provide: entry copies it into the run」。`provide` の複製の後、worktree に存在することを確かめる
- `file: true`: この端末の file の path（絶対か shell の cwd 相対）。存在し、file で、text であること（拡張子の規則は同じ）。runner が `.aidev/workflows/<name>/runs/<id>/inputs/<name><ext>` へ複製し（worktree 内、`runs/` ごと gitignore、agent が読める、commit されない）、`{inputs.<name>}` はその repo 相対 path。`run.json` にその path を記録し（log に「input spec: copied <from> to <to>」）、`--resume` は複製を使い回す（記録の値がその run の `inputs/` の下でなければ拒否）
- **`provide` と `file: true` の使い分け**: 1 人が持つ file（Excel から書き出した仕様書）は `file: true` で渡す。team が決まった ignore 済みの path に置く data は `provide`（C）
- 値の行き先: 全 agent と until agent の prompt の「## Inputs for this run」（`--task` と同じく data）に加えて、置換した本文。`--dry-run` の `inputs` 行（file 入力は「(copied from <path>)」付き）。`--dry-run` と submit の PR 本文の「## Inputs (--input name=value)」（名前、description、required / default、pattern、「a path in the repository」、「reaches a command」）。実行の PR 本文の「## Inputs」。最後の commit 本文の `inputs:` 行。`run.json` の `inputs`。`--log` の先頭と summary。`modify --from-run` の digest
- `--task` は従来どおり自由文として残す

**却下した案**: `--task` を構造化する（自由文の用途が消える）。入力を `writable` に書けるようにする（レビューで書ける範囲が読めなくなる。`{item}` のように件ごとの path が要るなら `for_each` を使う）。`required:` key（`default` が無ければ必須、で足り、同じことを 2 通りで書かせない）。入力 file（YAML）で渡す（`--input` の繰り返しで足り、CI からも渡せる。要望があれば足す）。

### C. 補給（`provide:`）: gitignore された file を checkout から worktree へ複製する（困りごと 4）

```yaml
provide: [docs/spec/**, e2e/fixtures/**]
```

- 実行の開始時（worktree を用意した後、最初の step の前。`--resume` でも）に、**手元の checkout で git が無視している file** のうち glob に合うものを、**file 単位で** worktree の同じ path へ複製する（上書き）。directory は単位ではない: glob は file を名指す（`docs/spec/**` = `docs/spec` の下の ignore された全 file）
- `--directory` の落とし穴: `git ls-files --others --ignored --exclude-standard` に glob を渡すと、1 file にしか合わない glob でも ignore された directory 全体を挙げることがある。挙がったものを kit の matcher（`paths.matches`）で絞り直し、glob が名指す file だけを複製する
- tracked file と、無視されていない untracked file は複製しない（tracked file は HEAD で worktree にあり、無視されていない untracked file は checkout 自身の状態である。実行は常に HEAD から始まる）
- 複製しないもの: `secrets_paths` に合うもの（「provide: <path> not copied (a secret path (secrets_paths: <pattern>))」として報告）、`.aidev/` と `.git/` の下、symbolic link。検証で拒否する glob: 固定の先頭 directory / file 名で始まらないもの（`**/*.txt`）、`.aidev` / `.git` / protected path を名指すもの、最後の名前が認証情報の file に見えるもの（`.env`、`.env.*`、`.npmrc`、`.netrc`、`.pypirc`、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`*.jks`、`*.keystore`）
- checkout で ignore された file に 1 つも合わない glob は、`--dry-run` と `run` を起動前に止める: 「provide: <glob> matches no file that git ignores in <checkout> (a run copies only ignored files from the checkout; put the file there, or take the entry out)」
- 複製した file は worktree でも ignore されていなければならない（ignore の規則が commit 済みの `.gitignore` にあること）。そうでなければ「provide: <file> is ignored in <checkout> by a rule the repository does not carry; commit the .gitignore that ignores it, so every run (and every teammate's) treats it alike」で止まる（`.git/info/exclude` や global excludes、未コミットの `.gitignore` の編集で ignore した file は、HEAD の worktree では新規 file に見え、checkpoint が commit してしまう）
- log: 「provide: N path(s) copied from the checkout: …」と、飛ばした path ごとに 1 行。`--dry-run` の `provide` 行。submit の PR 本文の「## Provided from the checkout」
- 依存（`node_modules`）は command step（`npm ci`）で入れる。`provide` は command で作れない data のためのもの、と template と workflow-creator に書く

**却下した案**: symlink（`npm ci` が checkout の `node_modules` を消す。Windows の権限）。hardlink の copy（cross-platform の差）。`aidev.yaml` に書く（要るかどうかは workflow ごとに違う。定義と一緒にレビューされるべき）。tracked file も複製する（上記）。

### D. 残骸の除外（kit の既定 list と `never_commit:`）（困りごと 2）

- kit が **決して commit しない path**（`NEVER_COMMITTED`）を持つ: `**/node_modules/**`、`**/bower_components/**`、`**/.pnpm-store/**`、`**/.yarn/cache/**`、`**/.venv/**`、`**/venv/**`、`**/__pycache__/**`、`**/*.pyc`、`**/.pytest_cache/**`、`**/.mypy_cache/**`、`**/.ruff_cache/**`、`**/.tox/**`、`**/.nox/**`、`**/.gradle/**`、`**/.DS_Store`、`**/Thumbs.db`、`**/*.orig`、`**/*.rej`。toolchain の残骸であって成果物ではないものに限る（`dist/`・`build/`・`target/` は成果物のこともあるので入れない）
- workflow は top-level の `never_commit: [<glob>]` で足せる（`e2e/test-results/**`、`e2e/playwright-report/**` など）。定義の一部なのでレビューされる。kit の list から取り除くことはできない
- **untracked file だけ**が対象である。tracked file への編集はどこにあっても run の成果（vendored で commit 済みの `node_modules` の file を step が編集すれば、他の file と同じく commit される）。最初に試した「pathspec の `:(exclude,glob)` で一律に隠す」方式は tracked file への編集まで隠したので却下した
- 適用箇所: step と件の checkpoint、pull-request step の最終 stage、`unchanged` の比較、失敗した件の戻し（`on_failure: continue`）、until agent に見せる diff、新しい実行の前の「未コミットの変更」検査（worktree に残った残骸は次の実行を止めない）
- 検証: step の `writable` か `provide` の項目を覆う `<dir>/**` 形の `never_commit` は拒否する（「never_commit <glob> covers what step <id> may write (<path>); nothing that step did would ever be committed」/「never_commit <glob> covers provide <glob>」）
- 除いた path は無言で捨てない: pull-request step の log に pattern ごとに「step <id>: N file(s) left out as never committed (<pattern>; e.g. <path>)」、`run.json` の step の `leftOut: { <pattern>: <count> }`、`--json` の `leftOut`、終了時の画面に「left out, never committed: N file(s) matching <pattern> (e.g. <path>)」、PR 本文の「## Left out」。`--dry-run` の `never commit` 行、submit の PR 本文の「## Never committed」
- `.gitignore` を kit が書くことはしない（PKG の file は PKG が決める。agent にも書かせない）

**却下した案**: file 数の閾値で止める（閾値の根拠が無く、止まると実行が無駄になる）。`.git/info/exclude` に書く（worktree で共有され、人の checkout の `git status` も変わる）。build 出力を kit の list に入れる（成果物のことがある）。pathspec で tracked / untracked を問わず除外する（上記）。

### E. 起動前の検査と実行の終わりの報告（困りごと 5 の補強）

試走は「動かして確かめる」手段だが、動かす前に分かることは動かす前に止める。`preflight` は `--dry-run` と `run` の両方で走り、問題があれば起動前に exit 1 になる:

- command step と `until.command` の実行 file が PATH に無い（「step <id>: npx was not found on PATH, so "…" could not run」。path 区切りを含まない名前だけを見る。`./run.sh` や `node_modules/.bin/x` のような相対 path は前の step が作ることがあるので見ない）
- `provide` の glob が checkout の ignore file に 1 つも合わない（C）
- `path: true` の入力の分類（B。存在しない / commit されていない / `provide` されていない）
- 試走では、argv が `git … push` の command step / `until.command`（A）

`inputs` の検査（B）は `preflight` の前に行う（宣言の無い名前、必須の欠落、`pattern` 不一致、whitelist 違反、`file: true` の file の不在）。

実行の終わりの報告は、試走に限らず全ての実行で出る:

- 「N file(s) changed outside what the steps may write, by a command step or past the guard; not committed: …」（JSON の `outside`。command step が `writable` の外に書いたもの、agent が guard を通らずに書いたもの）
- step ごとに「step <id>: the tool was refused N call(s): Write src/x.ts … (a path outside writable? see run.json "denied")」。Claude Code の `permission_denials` から取り、`run.json` の step の `denied: [...]`（20 件まで）、`calls[].denials` の件数、`--log` summary の「refused tool calls: …」、`--from-run` の digest（「tool calls the agent was refused …」）にも出る。step が落ちる一番多い理由（`writable` の外の path）を、記録を読まずに分かるようにする
- 残骸（D）: 「left out, never committed: …」

`aidev create workflow` の template（`TEMPLATE_YAML`。workflow-creator にも見せる）に `inputs:` / `provide:` / `never_commit:` と `--trial` を書き、`modify --from-run` の prompt には「gitignore された data file は `provide:` でしか worktree に届かない」「実行ごとに変わる値は `inputs:`」「command が残すもので commit してはいけないものは `never_commit:`」を候補として挙げた。

## 困りごとと対応の対応表

| # | 対応 |
| --- | --- |
| 1 | A（承認前に試走で完成させる。`main` には完成した定義の PR だけ） |
| 2 | D（kit の既定の除外 + `never_commit:`）、E（template と workflow-creator の指示、終了時の報告） |
| 3 | B |
| 4 | C（データ）、B の `file: true`（1 人が持つ file）、既存の command step（依存）、E（`path: true` と `provide` の検査で漏れを起動前に捕まえる） |
| 5 | A（試走）、E（起動前の検査、終了時の報告） |

## 変わった文書・出力

形が変わった出力（code の message をそのまま引く）。

- `aidev run workflow --dry-run` の表: `approved` 行は試走で「not required: --trial runs the definition as it is in this checkout (<通常の承認の表示>)」。`inputs` 行（値。file 入力は「(copied from <path>)」付き。宣言が無ければ「(none declared)」、与えられず default だけなら「(none given; defaults apply)」）、`provide` 行、`never commit` 行、`trial` 行（「nothing is pushed and no pull request is opened; the result stays on the trial branch」）を足した。`branch` 行は試走で `aidev/<name>.trial`、`limits` 行は `--max-usd` で「$0.5 (limits.max_usd is $1)」。steps の後に「## Inputs (--input name=value)」「## Provided from the checkout」「## Never committed」（定義にあるときだけ）。最後の行は「dry run: the definition validates and would run as a trial (nothing pushed).」か「dry run: the workflow is not approved and would be refused (try it as it is with --trial).」。`--json` に `trial` と `inputs`
- `run.json`: `trial`、`trialHash`（試走のみ）、`approvedRef` / `approvedSha`（試走では `null`）、`inputs`、step の `leftOut` と `denied`、pull-request step の `pushed: false` と `pr.trial: true`、`calls[].denials`
- `run --json` の出力: 上記の record に加えて `leftOut`（pattern ごとの件数）と `outside`
- 最後の commit（pull-request step）の本文: `approved: none (a trial run of the definition sha256:…)`（試走）、`inputs:` の行、`trial run: not pushed`（試走）
- `runs/<id>/pull-request.md`: 表の「approved on」が試走では「none (a trial run of the definition sha256:…)」。「## Inputs」「## Left out」の節
- `aidev submit` の PR 本文: 「## Inputs (--input name=value)」「## Provided from the checkout」「## Never committed」の節。「What changed against the approved workflow」に `inputs` / `provide` / `never_commit` の変更
- `--log` の file: 先頭の `run: <id> (trial)` と `inputs:`、summary の「(a trial run: nothing pushed)」「inputs:」「refused tool calls: …」
- `runs/<id>/log.txt`: 「trial run: the definition as it is in <checkout> (…); nothing is pushed, no pull request is opened」「input <name>: copied <from> to <to>」「provide: N path(s) copied from the checkout: …」「provide: <path> not copied (…)」「the checkout has N uncommitted change(s) this run does not see: …」「step <id>: <agent> was refused N tool call(s): …」「step <id>: N file(s) left out as never committed (…)」「step <id>: trial run: <branch> is not pushed and no pull request is opened」
- 画面: A の試走の終わり、「trial: N file(s) the last trial left were removed」「trial: the definition as it is here was committed on <branch> (…)」、E の 3 行
- `aidev modify --from-run` の digest: 見出しの「(a trial run)」、「inputs of the run:」、「tool calls the agent was refused …」
- `aidev create workflow` の template、`create` / `modify` の後の案内（1. review、2. try、3. submit、4. run）、`modify --from-run` の prompt
- `aidev run workflow` の exit 1 の原因に次を足した: 必須の `--input` の欠落・宣言の無い名前・不正な値、`provide` の glob が 1 つも合わない・複製した file が worktree で ignore されていない、`path: true` の入力が無い・commit されていない・`provide` されていない、実行 file が PATH に無い、`--max-usd` が正でない、試走の `--resume` に `--trial` が無い（と逆）、`--resume` と `--input` の併用、checkpoint が branch に無い実行の `--resume`、始めたときから定義が変わった試走の `--resume`、試走での `git push` の command step

## 未決

- 実行の後始末: 実行の終わり（止まった試走を含む）に必ず走る `cleanup:` の command list。試走を途中で止めると、command step が起動した container server は動いたままになる
- 試走の worktree / branch の処分: 自動では消さない（通常の実行と同じ）。試走の数が増えたときの `aidev list workflows` での表示や一括削除は、要望を見てから
- `provide` の複製は毎回上書きする。大きな directory を書いた PKG で遅ければ、変更の無い file を飛ばす最適化を足す
- 入力を file（YAML）で渡す形。`--input` の繰り返しで足りているうちは足さない
- 承認済みの実行でも残骸を除外するので、`writable` に残骸しか無い step は「nothing to commit」になる。これは意図どおり
