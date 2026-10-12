# 提案: 長く・多く・失敗しやすい仕事のための workflow 改善

日付: 2026-10-01 / 状態: 提案（一部実装。2026-10-13: 提案 1 の `on_failure` を実装、提案 4 は D20 で置き換え）

## ねらい

PKG がこれから作る workflow は、IT テスト（Playwright）の作成やフレームワークのバージョンアップのように、1 回が長く、失敗と再試行が多く、対象が多数ある。2026-10-01 に、止まった実行の再開（`--resume`）、`until.command` の list と `cwd` / `env` / `timeout_ms`、コマンド出力の log、run の `notes/`、確認役への diff、PR 本文への報告、`unchanged`、`for_each` を実装した（`architecture.md` §9）。この文書は、その後に残っている点の提案である。

| 困ること | 提案 |
| --- | --- |
| `for_each` は 1 件の失敗で止まり、直列でしか動かない | 1 |
| `unchanged` は file 単位で、file の一部の変更を見られない | 2 |
| 再試行のたびに agent が調査からやり直す | 3 |
| 60 分を超える仕事 | 4 |
| その他（入力の宣言、失敗時の draft PR、worktree 実行、実行中の費用上限、PR branch の Wiki） | 5 |

## 提案 1: `for_each` の失敗の扱いと並列

> 2026-10-13: `for_each.on_failure: stop | continue` を実装（`architecture.md` §9）。失敗した件の変更は件の開始時の snapshot へ戻す。並列は未実装。

いまは 1 件が不合格ならそこで止まる。通らない件を飛ばすには、人が一覧の file からその行を消して `--resume` する。

- `for_each.on_failure: stop | continue`（既定 `stop`）。`continue` は失敗した件を `run.json` と PR 本文に並べて次の件へ進む。未決: 失敗した件の途中の変更が作業 tree に残り、pull-request step がそれも commit する。件ごとの変更を kit が戻すには、件の開始時の状態を取って差分を戻す必要があり（`unchanged` の `changedState` を `writable` に対して使う）、agent 以外が同じ file を変えていないことが前提になる
- 並列実行。同じ作業 tree に複数の agent が書くので、件ごとの worktree（提案 5）が前提になる

## 提案 2: file の一部の変更を見る

`unchanged` が比べるのは file の内容全体で、`writable` に残した file の中の変更（新しいテストの `test.skip`、`package.json` の `scripts` の書き換え）は見えない。いまは「`until.command` で test runner を直接呼ぶ」「確認役の agent に差分を見せる」で補っている。

- `package.json` のような JSON の一部を固定する: `unchanged_keys: { package.json: [scripts] }`。kit が開始時と試行後で JSON を読み、その key の値を比べる
- 追加された行の pattern を拒否する: `forbid_added: ['\.skip\(', '\.only\(']`。`git diff` の追加行に一致したら不合格。正規表現を YAML に書かせるので、review の負担と誤検出を見てから決める

## 提案 3: 再試行で同じ session を続ける

再試行は新しい process で、agent は毎回調査からやり直す。Playwright の修正 loop では費用と時間の大半がここに消える。claude の adapter の `parse()` は `sessionId` を返しているので、再試行を `--resume <sessionId>` で続けられる可能性がある。

- 実装前に確認すること: headless（`-p`）での resume が起動 flag（`--tools`、`--mcp-config`、`--strict-mcp-config`）を再適用するか。適用されないなら採らない（D18 の 2 段の強制が崩れる）
- 同一失敗の判定（出力の完全一致）は、所要時間を出力する test runner では働かない。比較の前に時刻と秒数を正規化するか、判定を「exit code と失敗したテスト名の集合」に変える

## 提案 4: `limits.max_minutes` の天井（60 分）

> 2026-10-13: 採らず、天井そのものを撤去した（`design-decisions.md` D20）。`limits.max_minutes` は任意で、無人実行は `limits.max_usd` と再試行・件数の上限で止める。

install・build・全テストを数回まわす仕事は 60 分に収まらない。`for_each` で件数が増えるとなおさらである。`--resume` が上限を数え直すので、人が続ければ進められるようにはなった。無人で長く走らせたい PKG には、`aidev.yaml`（PR で review される）で PKG ごとの天井を上げる項目を足す。

```yaml
# aidev.yaml
workflow:
  max_minutes_ceiling: 180    # 既定 60。kit の絶対上限は 480
```

`workflow.yaml` の `limits.max_minutes` はこの天井まで書ける。天井を workflow 自身が上げられない点は変えない。

## 提案 5: その他

| 項目 | 内容 |
| --- | --- |
| 入力の宣言（`inputs`） | `--task` は自由文だけ。`inputs: { target_version: { pattern: '^[0-9.]+$', required: true } }` を宣言し、`--input target_version=4.2` で渡して prompt と command の `{input.target_version}` に入れる。`pattern` 必須（command に入るため） |
| 失敗時の draft PR | 止まった run の変更は `aidev/…` branch の作業 tree に残るだけ。pull-request step に `on_failure: draft` を足し、途中の変更と停止理由を draft PR にする |
| worktree で実行 | 利用者の checkout で `checkout -b` し、終了後もその branch に残る。Wiki publish と同じく worktree で動かせば作業を止めず、並列にも実行できる。`node_modules` が無いので install step が必要になる |
| 実行中の費用上限 | `cost.max_usd` は agent が終わった後にしか見ない。tool に残り予算を渡す flag があれば渡す（claude の flag は未確認） |
| PR branch の Wiki | runner は自分で commit するので after-bash hook が動かず、PR の Wiki は遅れたままになる（`check --strict` は WARN を exit 2 にする）。pull-request step の前に `sync wiki` 相当を走らせるかを決める |

## 進め方

提案 4 は `for_each` を実際の PKG で走らせて、60 分で何件進むかを見てから決める。提案 3 は tool の挙動確認が先。提案 1・2・5 は実際の run の記録（`run.json`）と、レビューで見つかった「弱められたテスト」の実例を見てから決める。
