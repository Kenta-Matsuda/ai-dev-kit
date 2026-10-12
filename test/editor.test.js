'use strict';
/**
 * `aidev edit workflow` — the editor's server, without a browser. The server
 * checks are async, and the harness is not, so `editor-driver.js` runs them
 * in a process of its own and this suite reports each one:
 *
 *   - the page is served with a strict CSP; the API needs the token, the
 *     loopback Host and (when sent) the loopback Origin
 *   - state carries the definition, its approval, the agents and a check
 *   - check writes the form's definition as YAML and validates it as a run would
 *   - save writes only workflow.yaml, only valid text, only over the copy it loaded
 *   - close ends it
 *
 * Here: the command's refusals, and that what the form writes reads back the same.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, ok, eq } = require('./harness');
const { makeRepo, write, git } = require('./fixtures');
const yaml = require('../cli/lib/yaml');
const { aidev } = require('./completion.test');
const { WF } = require('./editor-driver');

const KIT = path.resolve(__dirname, '..');

function run() {
  suite('edit workflow: the editor server');

  const fx = makeRepo({ hosting: 'generic' });
  try {
    write(path.join(fx.root, '.aidev', 'agents', 'coder.md'), '---\nname: coder\ndescription: writes code\ntools: Read, Edit\n---\n\nYou code.\n');
    write(path.join(fx.root, '.aidev', 'workflows', 'demo', 'workflow.yaml'), WF);
    git(['add', '-A'], fx.root);
    git(['commit', '-q', '-m', 'demo'], fx.root);
    git(['push', '-q', 'origin', 'main'], fx.root);

    const r = spawnSync(process.execPath, [path.join(__dirname, 'editor-driver.js'), fx.root, KIT], { encoding: 'utf8', timeout: 120000 });
    let report = null;
    try { report = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { report = null; }
    if (!report) test('the editor server runs', () => { throw new Error(`no report: ${r.stdout}${r.stderr}`); });
    else for (const [name, error] of report.results) test(name, () => { if (error) throw new Error(error); });

    test('aidev edit workflow refuses what it cannot open', () => {
      ok(/no such workflow: nope/.test(aidev(fx.root, ['edit', 'workflow', 'nope', '--no-open']).out));
      ok(/--port must be a port number/.test(aidev(fx.root, ['edit', 'workflow', 'demo', '--port', 'x', '--no-open']).out));
      ok(/expected one of workflow/.test(aidev(fx.root, ['edit', 'agent', 'coder']).out));
    });

    test('the form\'s YAML reads back as written, for strings a reviewer writes', () => {
      const vals = ['plain', 'a, b', 'e2e/**', 'npx playwright test {item}', '{x}', '- x', 'a: b', 'x #y', "don't", 'say "hi"', '123', 'true', 'No', '~', '*x', ' lead', 'x:', 'http://x.y/z', '日本語'];
      for (const v of vals) {
        for (const o of [{ k: v }, { l: [v, 'z'] }, { s: [{ id: v }] }, { m: `line1\n${v}\n` }]) eq(yaml.parse(yaml.stringify(o)), o, JSON.stringify(o));
      }
      eq(yaml.stringify({ writable: ['e2e/**', 'src/**/*.ts'] }), 'writable: [e2e/**, src/**/*.ts]\n', 'a short list stays on one line');
    });
  } finally { fx.cleanup(); }
}

module.exports = { run };

if (require.main === module) {
  const { summary } = require('./harness');
  run();
  process.exit(summary() ? 0 : 1);
}
