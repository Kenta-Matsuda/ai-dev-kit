# templates/workflows — kit が同梱する標準 workflow

`aidev create workflow <name> --from <standard>` が PKG に複製する雛形です。1 つの標準 workflow は 1 ディレクトリで、次を持ちます。

| path | 複製先 | 内容 |
| --- | --- | --- |
| `<standard>/workflow.yaml` | `.aidev/workflows/<name>/workflow.yaml`（`name:` 行は `<name>` に書き換える） | 定義。PKG ごとに違う値は `inputs:`（値は `aidev.yaml` の `workflows.<name>.inputs` か `--input`）と `env_required:`（shell の環境変数）で受け取り、YAML には書かない |
| `<standard>/agents/<agent>.md` | `.aidev/agents/<agent>.md` | その workflow の agent（frontmatter に能力） |
| `<standard>/skills/<skill>/SKILL.md` | `.aidev/skills/<skill>/SKILL.md` | agent が frontmatter で参照する skill |

複製したあとは PKG のファイルです。`templates/claude/` と違い `aidev sync tools` は触らず、新しい版は `--from … --force` で複製し直して差分をレビューします。実行時に kit 側のファイルを参照することはありません。

`test/workflow.test.js` が、ここにある全 workflow が検証を通り、複製後に agent / skill が解決できることを確かめます。
