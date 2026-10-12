'use strict';
/**
 * `npm run evolve --` — the kit-developer-only half of self-evolution.
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
const { lastJson } = require('./completion.test');
const home = require('../cli/lib/home');
const evolveMod = require('../scripts/evolve');
const { execFileSync } = require('child_process');

/** The kit-developer script: `npm run evolve -- <sub>`, run here directly. */
function evolve(root, args, { env = {} } = {}) {
  try {
    const out = execFileSync(process.execPath, [path.resolve(__dirname, '..', 'scripts', 'evolve.js'), ...args], {
      cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AIDEV_NO_UPDATE_CHECK: '1', ...env },
    });
    return { code: 0, out };
  } catch (e) { return { code: e.status == null ? 1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` }; }
}

function run() {
  suite('evolve: kit developer marker and gating');

  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-evolve-home-'));
  const env = (extra = {}) => ({ AIDEV_HOME: HOME, ...extra });
  const fx = makeRepo();
  try {
    test('status on an ordinary machine says so; run is refused', () => {
      const s = lastJson(evolve(fx.root, ['status', '--json'], { env: env() }).out);
      eq(s.enabled, false);
      const r = evolve(fx.root, ['run'], { env: env() });
      eq(r.code, 1);
      ok(/kit developers only/.test(r.out), r.out);
    });

    test('enable writes the marker under AIDEV_HOME, not in the package', () => {
      const r = evolve(fx.root, ['enable', '--json'], { env: env() });
      eq(r.code, 0, r.out);
      const j = lastJson(r.out);
      eq(j.enabled, true); eq(j.autoEvolve, false);
      ok(fs.existsSync(path.join(HOME, 'developer.json')), 'marker missing');
      ok(!fs.existsSync(path.join(fx.root, '.aidev', 'developer.json')), 'marker leaked into the package');
      eq(home.readDeveloper({ AIDEV_HOME: HOME }).enabled, true);
      eq(home.readDeveloper({ AIDEV_HOME: HOME, AIDEV_KIT_DEVELOPER: undefined }).autoEvolve, false);
    });

    test('enable --auto records the auto flag; disable removes the marker', () => {
      eq(lastJson(evolve(fx.root, ['enable', '--auto', '--json'], { env: env() }).out).autoEvolve, true);
      eq(evolve(fx.root, ['disable', '--json'], { env: env() }).code, 0);
      ok(!fs.existsSync(path.join(HOME, 'developer.json')), 'marker still present');
      eq(home.readDeveloper({ AIDEV_HOME: HOME }).enabled, false);
      eq(home.readDeveloper({ AIDEV_HOME: HOME, AIDEV_KIT_DEVELOPER: '1' }).enabled, true, 'the env switch works without a marker');
    });

    test('run --dry-run lists the reflections of this package and starts nothing', () => {
      evolve(fx.root, ['enable', '--json'], { env: env() });
      write(path.join(fx.root, '.aidev', 'cache', 'evolution', 'sess-9.md'), '# session sess-9\n## kit への提案\n- x\n');
      const stub = path.join(fx.root, 'never-run.js');
      fs.writeFileSync(stub, "require('fs').writeFileSync(process.env.STUB_RAN, '1');\n", 'utf8');
      const ran = path.join(fx.root, 'ran.txt');
      const r = evolve(fx.root, ['run', '--dry-run', '--json'], { env: env({ AIDEV_CLAUDE_BIN: stub, STUB_RAN: ran }) });
      eq(r.code, 0, r.out);
      const j = lastJson(r.out);
      eq(j.dryRun, true);
      eq(j.reflections.length, 1, JSON.stringify(j.reflections));
      ok(/aidev\/evolve-\d{8}/.test(j.branch), j.branch);
      ok(!fs.existsSync(ran), 'the agent was started during a dry run');
      eq(evolveMod.collectReflections(fx.root).map((x) => x.session), ['sess-9']);
    });

    test('estimates --dry-run replays the records of this package and starts nothing; the backtest scores them', () => {
      const recDir = path.join(fx.root, '.aidev', 'estimates', 'records');
      const rec = (runId, actual) => ({
        schemaVersion: 1, workflow: 'wf', runId, startedAt: runId, done: true,
        estimate: { steps: [{ id: 'work', agent: 'coder', size: 'M', maxAttempts: 1, maxItems: null, model: 'sonnet', usd: [0.3, 1] }] },
        steps: [{ id: 'work', kind: 'agent', ok: true, attempts: 1, starts: 1, costUsd: actual }],
        calls: [{ step: 'work', role: 'agent', agent: 'coder', attempt: 1, model: 'sonnet', ok: true, costUsd: actual }],
      });
      [['r1', 0.5], ['r2', 0.6], ['r3', 3]].forEach(([id, c]) => write(path.join(recDir, `wf-${id}.json`), JSON.stringify(rec(id, c))));
      const backtest = require('../scripts/estimate-backtest');
      const b = backtest.backtest([fx.root]);
      // r1: size M 0.3–1 holds 0.5. r2: one sample 0.5 → 0.25–1 holds 0.6. r3: 0.5, 0.6 → 0.25–1.2 misses 3.
      eq([b.pairs, b.coverage], [3, 2 / 3]);
      eq(b.packages[0].records, 3);
      const stub = path.join(fx.root, 'never-run.js');
      const ran = path.join(fx.root, 'ran.txt');
      const r = evolve(fx.root, ['estimates', '--dry-run', '--json'], { env: env({ AIDEV_CLAUDE_BIN: stub, STUB_RAN: ran }) });
      eq(r.code, 0, r.out);
      const j = lastJson(r.out);
      eq([j.dryRun, j.sources.length, j.sources[0].records, j.baseline.pairs], [true, 1, 3, 3]);
      ok(/aidev\/evolve-estimates-\d{8}/.test(j.branch), j.branch);
      ok(!fs.existsSync(ran), 'the agent was started during a dry run');
      evolve(fx.root, ['disable', '--json'], { env: env() });
      ok(/kit developers only/.test(evolve(fx.root, ['estimates'], { env: env() }).out), 'estimates is refused on an ordinary machine');
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
