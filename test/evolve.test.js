'use strict';
/**
 * `aidev evolve` — the kit-developer-only half of self-evolution.
 *
 *   - enable/disable/status keep their marker under AIDEV_HOME, never in a PKG
 *   - run is refused on an ordinary machine
 *   - run --dry-run lists the reflections of registered packages and starts nothing
 *
 * The real run creates a worktree of the kit checkout; that is not exercised
 * here (it would touch the developer's kit repository).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, ok, eq } = require('./harness');
const { makeRepo, write } = require('./fixtures');
const { aidev, lastJson } = require('./completion.test');
const home = require('../cli/lib/home');
const evolveMod = require('../cli/commands/evolve');

function run() {
  suite('evolve: kit developer marker and gating');

  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-evolve-home-'));
  const env = (extra = {}) => ({ AIDEV_HOME: HOME, ...extra });
  const fx = makeRepo();
  try {
    test('status on an ordinary machine says so; run is refused', () => {
      const s = lastJson(aidev(fx.root, ['evolve', 'status', '--json'], { env: env() }).out);
      eq(s.enabled, false);
      const r = aidev(fx.root, ['evolve', 'run'], { env: env() });
      eq(r.code, 1);
      ok(/kit developers only/.test(r.out), r.out);
    });

    test('enable writes the marker under AIDEV_HOME, not in the package', () => {
      const r = aidev(fx.root, ['evolve', 'enable', '--json'], { env: env() });
      eq(r.code, 0, r.out);
      const j = lastJson(r.out);
      eq(j.enabled, true); eq(j.autoEvolve, false);
      ok(fs.existsSync(path.join(HOME, 'developer.json')), 'marker missing');
      ok(!fs.existsSync(path.join(fx.root, '.aidev', 'developer.json')), 'marker leaked into the package');
      eq(home.readDeveloper({ AIDEV_HOME: HOME }).enabled, true);
      eq(home.readDeveloper({ AIDEV_HOME: HOME, AIDEV_KIT_DEVELOPER: undefined }).autoEvolve, false);
    });

    test('enable --auto records the auto flag; disable removes the marker', () => {
      eq(lastJson(aidev(fx.root, ['evolve', 'enable', '--auto', '--json'], { env: env() }).out).autoEvolve, true);
      eq(aidev(fx.root, ['evolve', 'disable', '--json'], { env: env() }).code, 0);
      ok(!fs.existsSync(path.join(HOME, 'developer.json')), 'marker still present');
      eq(home.readDeveloper({ AIDEV_HOME: HOME }).enabled, false);
      eq(home.readDeveloper({ AIDEV_HOME: HOME, AIDEV_KIT_DEVELOPER: '1' }).enabled, true, 'the env switch works without a marker');
    });

    test('run --dry-run lists the reflections of this package and starts nothing', () => {
      aidev(fx.root, ['evolve', 'enable', '--json'], { env: env() });
      write(path.join(fx.root, '.aidev', 'cache', 'evolution', 'sess-9.md'), '# session sess-9\n## kit への提案\n- x\n');
      const stub = path.join(fx.root, 'never-run.js');
      fs.writeFileSync(stub, "require('fs').writeFileSync(process.env.STUB_RAN, '1');\n", 'utf8');
      const ran = path.join(fx.root, 'ran.txt');
      const r = aidev(fx.root, ['evolve', 'run', '--dry-run', '--json'], { env: env({ AIDEV_CLAUDE_BIN: stub, STUB_RAN: ran }) });
      eq(r.code, 0, r.out);
      const j = lastJson(r.out);
      eq(j.dryRun, true);
      eq(j.reflections.length, 1, JSON.stringify(j.reflections));
      ok(/aidev\/evolve-\d{8}/.test(j.branch), j.branch);
      ok(!fs.existsSync(ran), 'the agent was started during a dry run');
      eq(evolveMod.collectReflections(fx.root).map((x) => x.session), ['sess-9']);
    });

    test('the evolution agent definition ships with the kit and is not a PKG template', () => {
      const def = path.join(__dirname, '..', ...evolveMod.AGENT_DEF_REL.split('/'));
      ok(fs.existsSync(def), `${evolveMod.AGENT_DEF_REL} missing`);
      ok(!fs.existsSync(path.join(__dirname, '..', 'templates', 'claude', '.claude', 'agents', 'evolution.md')), 'evolution.md must not be distributed to packages');
    });
  } finally {
    fx.cleanup();
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

module.exports = { run };

if (require.main === module) {
  const { summary } = require('./harness');
  run();
  process.exit(summary() ? 0 : 1);
}
