# 提案: PKG を引数で指定する（`-C <path>`、`--all`）

日付: 2026-09-23 / 状態: 提案（未実装。利用者ガイドには書かない。実装したらこの文書を削除し、architecture.md / cli-reference.md / design-decisions.md へ移す）

この文書はもともと 4 節あった。§1（`init` から Wiki 生成を外す）、§2（`check` = PKG の検査、`doctor` = 端末の検査、`status` の統合）、§3（`create` / `remove` / `list` を作成・削除・一覧の入口にする）は動詞先行のコマンド面（`aidev <verb> [<object>] [<name>]`）として 2026-09-23 に実装され、cli-reference.md と利用者ガイドに移った。残るのはこの §4 だけ。

## ねらい

すべての PKG 向け command が cwd から repo root を探す（`git.findRepoRoot(cwd)`）。`hook` だけ `CLAUDE_PROJECT_DIR` を起点にする。別の PKG に対して `eject` / `apply` / `check` を実行するには `cd` が要る。`aidev update kit` は「apply が必要な PKG」を path で列挙するが、その先は人が移動する。

## 決定

- 全 command に共通の option **`-C <path>`**（git と同じ意味。長い形は `--pkg <path>`）を足す。`aidev.js` が `findRepoRoot(path)` に渡す。`hook` は `CLAUDE_PROJECT_DIR` を優先し、`-C` は無視しない（両方あれば `-C`）
- 位置引数にしない。`run workflow <name>`・`create agent <name>` のように object と名前を位置引数に持つ command と衝突する
- 対象: `init`（root を指す）、`check`、`update wiki`、`run` / `create` / `submit` / `list` / `remove`、`configure` / `show`、`apply`、`eject`。`update kit` / `doctor` / `uninstall` は端末向けなので `-C` を受け付けるが無視する（エラーにはしない。scripting で一律に付けられるように）
- `aidev apply --all` と `aidev check --all`: registry（`AIDEV_HOME/registry.json`）の全 PKG に対して順に実行し、PKG ごとの結果を 1 行ずつ表にする。exit は最悪のもの。`--all` と `-C` は併用不可。`eject --all` は作らない（高影響）
- `aidev update kit` の案内文を `Run "aidev apply -C <path>" in each, or "aidev apply --all"` に変える

## 利用者ガイドへの影響

コマンドリファレンスの「共通オプション」に `-C <path>` を足す。`eject` の例を `aidev eject -C C:\work\demo-pkg --yes` にする。「PKG 用のコマンドは PKG の clone の中で実行します」を「PKG の中で実行するか、`-C <path>` で指定します」にする。

## 主な file

`cli/bin/aidev.js`、`cli/commands/apply.js`、`cli/commands/check.js`、`cli/lib/home.js`、`test/cli.test.js`。version 0.9.0。互換は保たない（pre-release）。

## 残す論点

- `--all` の `--json` の形（PKG ごとの結果の配列にするか）
- registry に無い PKG（clone したが `init` していない）を `--all` が報告するか
