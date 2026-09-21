'use strict';
/**
 * Policy-engine tests.
 *
 * These encode the security contract, so they assert precedence explicitly:
 * a lease must never outrank protection, the consistency error must never be
 * escapable without a lease, and the `writable` regions must not bypass the
 * consistency gate.
 *
 * Layout under test: the PKG is the repository itself. `read_only: ["**"]`
 * makes every PKG file read-only; `writable` opens the Wiki
 * (.aidev/knowledge/**), the workflows (.aidev/workflows/**) and aidev.yaml.
 */

const fs = require('fs');
const path = require('path');
const { suite, test, eq, ok } = require('./harness');
const { makeRepo, advancePkg, pullPkg, git } = require('./fixtures');
const policy = require('../cli/lib/policy');
const leases = require('../cli/lib/leases');
const cfg = require('../cli/lib/config');
const state = require('../cli/lib/state');

function ctx(fx) {
  return {
    config: cfg.loadConfig(fx.root),
    policy: cfg.loadPolicy(fx.root),
  };
}

function decide(fx, p, extra = {}) {
  return policy.decide(fx.root, p, { ...ctx(fx), ...extra });
}

/** Put the clone on the leased branch: work leases are branch-scoped. */
function checkoutTaskBranch(fx, id = '1234') {
  git(['checkout', '-q', '-b', `ai/wi-${id}`], fx.root);
}

function run() {
  suite('policy: protected paths');

  test('kit-owned files are denied', () => {
    const fx = makeRepo();
    try {
      for (const p of ['.claude/settings.json', '.claude/agents/x.md', 'CLAUDE.md', '.mcp.json',
        '.aidev/policy.yaml', '.aidev/sync.lock', '.aidev/materialized.json', '.aidev/leases/wi-1.json',
        '.aidev/ejected.json', '.aidev/.gitignore']) {
        const d = decide(fx, p);
        eq(d.decision, 'deny', `${p} should be denied`);
        eq(d.rule, 'protected', `${p} rule=${d.rule}`);
      }
    } finally { fx.cleanup(); }
  });

  test('the floor holds even when the policy file is missing', () => {
    const fx = makeRepo({ withPolicy: false });
    try {
      const d = decide(fx, '.aidev/materialized.json');
      eq(d.decision, 'deny');
      eq(d.rule, 'protected');
      const ro = decide(fx, 'notes.md');
      eq(ro.decision, 'deny', 'fallback policy is read-only, not open');
      eq(ro.rule, 'read-only');
    } finally { fx.cleanup(); }
  });

  test('secret paths are denied ahead of everything else', () => {
    const fx = makeRepo();
    try {
      const d = decide(fx, 'config/secrets/key.pem');
      eq(d.decision, 'deny');
      eq(d.rule, 'secrets');
    } finally { fx.cleanup(); }
  });

  test('traversal cannot reach a protected path', () => {
    const fx = makeRepo();
    try {
      const d = decide(fx, '.aidev/knowledge/../../.claude/settings.json');
      eq(d.decision, 'deny');
      eq(d.rule, 'protected');
      const abs = decide(fx, path.join(fx.root, '.aidev', 'knowledge', '..', 'policy.yaml'));
      eq(abs.decision, 'deny');
      eq(abs.rule, 'protected');
    } finally { fx.cleanup(); }
  });

  test('paths outside the repository are denied', () => {
    const fx = makeRepo();
    try {
      const d = decide(fx, path.join(fx.root, '..', 'elsewhere.txt'));
      eq(d.decision, 'deny');
      eq(d.rule, 'outside-repo');
      eq(decide(fx, fx.root).rule, 'outside-repo', 'the root itself is refused');
    } finally { fx.cleanup(); }
  });

  suite('policy: writable regions');

  test('the Wiki, workflows and aidev.yaml are writable by policy when state is OK', () => {
    const fx = makeRepo();
    try {
      eq(state.computeState(fx.root, ctx(fx).config, { checkRemote: false }).severity, 'ok');
      for (const p of ['.aidev/knowledge/x.md', '.aidev/knowledge/api/auth.md', '.aidev/knowledge/inventory/00.json',
        '.aidev/workflows/my-flow/loop.py', 'aidev.yaml']) {
        const d = decide(fx, p);
        eq(d.decision, 'allow', `${p}: ${d.reason}`);
        eq(d.rule, 'writable', `${p} rule=${d.rule}`);
      }
    } finally { fx.cleanup(); }
  });

  test('ordinary PKG files are read-only, so nothing falls through to the default', () => {
    const fx = makeRepo();
    try {
      for (const p of ['notes.md', 'README.md', 'src/api/auth.ts', 'docs/readme.md', 'brand-new-dir/file.txt']) {
        const d = decide(fx, p);
        eq(d.decision, 'deny', `${p}: ${d.reason}`);
        eq(d.rule, 'read-only', `${p} rule=${d.rule}`);
        eq(d.pattern, '**');
      }
    } finally { fx.cleanup(); }
  });

  test('the default rule only applies to paths no read_only pattern matches', () => {
    const fx = makeRepo();
    try {
      const narrow = { ...ctx(fx).policy, read_only: ['src/**'] };
      const d = decide(fx, 'notes.md', { policy: narrow });
      eq(d.decision, 'allow');
      eq(d.rule, 'default');
      eq(decide(fx, 'src/api/auth.ts', { policy: narrow }).rule, 'read-only');
    } finally { fx.cleanup(); }
  });

  test('a WARN state (code moved under the Wiki) does not block writes', () => {
    const fx = makeRepo();
    try {
      advancePkg(fx);
      pullPkg(fx);
      eq(state.computeState(fx.root, ctx(fx).config, { checkRemote: false }).severity, 'warn');
      const wiki = decide(fx, '.aidev/knowledge/x.md');
      eq(wiki.decision, 'allow');
      eq(wiki.rule, 'writable');
      const ro = decide(fx, 'notes.md');
      eq(ro.decision, 'deny');
      eq(ro.rule, 'read-only', 'denied for being read-only, not for consistency');
    } finally { fx.cleanup(); }
  });

  suite('policy: consistency gate');

  test('a consistency error with no lease blocks every write, including writable regions', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      const st = state.computeState(fx.root, ctx(fx).config, { checkRemote: false });
      eq(st.severity, 'error');
      for (const p of ['.aidev/knowledge/api/auth.md', '.aidev/workflows/x.py', 'aidev.yaml', 'notes.md', 'src/api/auth.ts']) {
        const d = decide(fx, p);
        eq(d.decision, 'deny', `${p} during error state`);
        eq(d.rule, 'consistency-no-lease');
        eq(d.state, 'error');
      }
    } finally { fx.cleanup(); }
  });

  test('a corrupt manifest is an error state too', () => {
    const fx = makeRepo();
    try {
      fs.writeFileSync(state.manifestPath(fx.root), JSON.stringify({ schemaVersion: 3, knowledgeSha: 'nope' }));
      const d = decide(fx, '.aidev/knowledge/api/auth.md');
      eq(d.decision, 'deny');
      eq(d.rule, 'consistency-no-lease');
    } finally { fx.cleanup(); }
  });

  test('the sync lease unblocks .aidev/knowledge/** and nothing else', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      leases.acquireSyncLease(fx.root, {
        targetSha: fx.setupSha, originalSha: fx.pkgSha, ttlMinutes: 120,
      });

      const wiki = decide(fx, '.aidev/knowledge/api/auth.md');
      eq(wiki.decision, 'allow', 'wiki writable under lease');
      eq(wiki.rule, 'sync-lease');
      eq(wiki.lease.targetSha, fx.setupSha);

      const other = decide(fx, '.aidev/workflows/x.py');
      eq(other.decision, 'deny', 'workflows still denied');
      eq(other.rule, 'sync-lease-scope');

      const conf = decide(fx, 'aidev.yaml');
      eq(conf.decision, 'deny', 'writable regions do not bypass the gate');
      eq(conf.rule, 'sync-lease-scope');

      const src = decide(fx, 'src/api/auth.ts');
      eq(src.decision, 'deny', 'src still denied under sync lease');
      eq(src.rule, 'sync-lease-scope');

      const prot = decide(fx, '.claude/settings.json');
      eq(prot.decision, 'deny', 'protection outranks the lease');
      eq(prot.rule, 'protected');

      const secret = decide(fx, 'config/secrets/key.pem');
      eq(secret.decision, 'deny', 'secrets outrank the lease');
      eq(secret.rule, 'secrets');
    } finally { fx.cleanup(); }
  });

  test('an expired sync lease does not unblock writes', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      leases.acquireSyncLease(fx.root, { targetSha: fx.setupSha, originalSha: fx.pkgSha, ttlMinutes: 60 });
      const p = cfg.syncLockPath(fx.root);
      const l = JSON.parse(fs.readFileSync(p, 'utf8'));
      l.acquiredAt = new Date(Date.now() - 120 * 60000).toISOString();
      fs.writeFileSync(p, JSON.stringify(l));

      const d = decide(fx, '.aidev/knowledge/api/auth.md');
      eq(d.decision, 'deny');
      eq(d.rule, 'consistency-no-lease');
      ok(/expired/.test(d.reason), 'reason mentions expiry');
    } finally { fx.cleanup(); }
  });

  test('a sync lease grants nothing once the state is no longer an error', () => {
    const fx = makeRepo();
    try {
      leases.acquireSyncLease(fx.root, { targetSha: fx.setupSha, originalSha: fx.pkgSha, ttlMinutes: 60 });
      const d = decide(fx, 'src/api/auth.ts');
      eq(d.decision, 'deny');
      eq(d.rule, 'read-only', 'the lease is only consulted under the gate');
      eq(decide(fx, '.aidev/knowledge/x.md').rule, 'writable');
    } finally { fx.cleanup(); }
  });

  test('a caller-supplied state is honoured instead of recomputed', () => {
    const fx = makeRepo();
    try {
      const d = decide(fx, '.aidev/knowledge/x.md', { state: { severity: 'error', message: 'injected' } });
      eq(d.decision, 'deny');
      eq(d.rule, 'consistency-no-lease');
    } finally { fx.cleanup(); }
  });

  suite('policy: read-only PKG and work leases');

  test('PKG source is read-only without a lease', () => {
    const fx = makeRepo();
    try {
      const d = decide(fx, 'src/api/auth.ts');
      eq(d.decision, 'deny');
      eq(d.rule, 'read-only');
      ok(/no work lease/.test(d.reason), d.reason);
    } finally { fx.cleanup(); }
  });

  test('a scoped work lease on the right branch permits the write', () => {
    const fx = makeRepo();
    try {
      checkoutTaskBranch(fx);
      leases.createWorkLease(fx.root, {
        taskId: 'wi-1234', workItemId: 1234, branch: 'ai/wi-1234',
        allowedPaths: ['src/**'], ttlMinutes: 120,
      });
      const d = decide(fx, 'src/api/auth.ts');
      eq(d.decision, 'allow', d.reason);
      eq(d.rule, 'work-lease');
      eq(d.lease, { kind: 'work', taskId: 'wi-1234', branch: 'ai/wi-1234' });
      eq(decide(fx, 'src/api/brand-new.ts').decision, 'allow', 'new files inside the scope too');
    } finally { fx.cleanup(); }
  });

  test('a work lease does not apply on a different branch', () => {
    const fx = makeRepo();
    try {
      leases.createWorkLease(fx.root, {
        taskId: 'wi-1234', branch: 'ai/wi-1234', allowedPaths: ['src/**'],
      });
      // The clone is still on main, not the leased branch.
      const d = decide(fx, 'src/api/auth.ts');
      eq(d.decision, 'deny');
      eq(d.rule, 'read-only');
      ok(/scoped to branch/.test(d.reason), d.reason);

      // A detached HEAD cannot satisfy a branch-scoped lease either.
      git(['checkout', '-q', '--detach'], fx.root);
      const det = decide(fx, 'src/api/auth.ts');
      eq(det.decision, 'deny');
      ok(/could not be determined/.test(det.reason), det.reason);
    } finally { fx.cleanup(); }
  });

  test('a work lease does not reach outside its allowed paths', () => {
    const fx = makeRepo();
    try {
      checkoutTaskBranch(fx);
      leases.createWorkLease(fx.root, {
        taskId: 'wi-1234', branch: 'ai/wi-1234', allowedPaths: ['src/api/**'],
      });
      eq(decide(fx, 'src/api/auth.ts').decision, 'allow');
      const outside = decide(fx, 'docs/readme.md');
      eq(outside.decision, 'deny', 'outside lease scope');
      eq(outside.rule, 'read-only');
      ok(/no work lease covers/.test(outside.reason), outside.reason);
    } finally { fx.cleanup(); }
  });

  test('a work lease never overrides secrets or protection', () => {
    const fx = makeRepo();
    try {
      checkoutTaskBranch(fx);
      leases.createWorkLease(fx.root, {
        taskId: 'wi-1234', branch: 'ai/wi-1234', allowedPaths: ['**'],
      });
      const d = decide(fx, 'config/secrets/key.pem');
      eq(d.decision, 'deny');
      eq(d.rule, 'secrets');
      const prot = decide(fx, '.claude/settings.json');
      eq(prot.decision, 'deny');
      eq(prot.rule, 'protected');
      const lease = decide(fx, '.aidev/leases/wi-1234.json');
      eq(lease.decision, 'deny', 'a lease cannot extend itself');
      eq(lease.rule, 'protected');
    } finally { fx.cleanup(); }
  });

  test('an expired work lease stops authorising', () => {
    const fx = makeRepo();
    try {
      checkoutTaskBranch(fx);
      leases.createWorkLease(fx.root, {
        taskId: 'wi-1234', branch: 'ai/wi-1234', allowedPaths: ['src/**'], ttlMinutes: 60,
      });
      const lp = leases.leasePath(fx.root, 'wi-1234');
      const l = JSON.parse(fs.readFileSync(lp, 'utf8'));
      l.acquiredAt = new Date(Date.now() - 120 * 60000).toISOString();
      fs.writeFileSync(lp, JSON.stringify(l));
      const d = decide(fx, 'src/api/auth.ts');
      eq(d.decision, 'deny');
      eq(d.rule, 'read-only');
      ok(/expired/.test(d.reason), d.reason);
    } finally { fx.cleanup(); }
  });

  test('package.exclude and package.include still apply under a work lease', () => {
    const fx = makeRepo();
    try {
      checkoutTaskBranch(fx);
      leases.createWorkLease(fx.root, {
        taskId: 'wi-1234', branch: 'ai/wi-1234', allowedPaths: ['**'],
      });
      const excluded = decide(fx, 'src/node_modules/pkg/index.js');
      eq(excluded.decision, 'deny');
      eq(excluded.rule, 'work-lease-scope');
      const notIncluded = decide(fx, 'README.md');
      eq(notIncluded.decision, 'deny', 'outside package.include');
      eq(notIncluded.rule, 'work-lease-scope');
      eq(decide(fx, 'docs/readme.md').rule, 'work-lease', 'inside package.include');
    } finally { fx.cleanup(); }
  });

  test('a work lease does not change the answer for writable regions', () => {
    const fx = makeRepo();
    try {
      checkoutTaskBranch(fx);
      leases.createWorkLease(fx.root, {
        taskId: 'wi-1234', branch: 'ai/wi-1234', allowedPaths: ['**'],
      });
      eq(decide(fx, '.aidev/knowledge/x.md').rule, 'writable');
      eq(decide(fx, 'aidev.yaml').rule, 'writable');
    } finally { fx.cleanup(); }
  });

  suite('policy: bash target extraction');

  test('redirections are detected', () => {
    const t = policy.extractBashTargets('echo hi > .claude/settings.json');
    ok(t.includes('.claude/settings.json'), JSON.stringify(t));
    ok(policy.extractBashTargets('cat x >> CLAUDE.md').includes('CLAUDE.md'));
  });

  test('write commands are detected', () => {
    ok(policy.extractBashTargets('rm -rf .claude').includes('.claude'));
    ok(policy.extractBashTargets('mv a.txt .mcp.json').includes('.mcp.json'));
    ok(policy.extractBashTargets("sed -i 's/a/b/' CLAUDE.md").includes('CLAUDE.md'));
    ok(policy.extractBashTargets('tee .aidev/policy.yaml').includes('.aidev/policy.yaml'));
    ok(policy.extractBashTargets('touch .aidev/materialized.json').includes('.aidev/materialized.json'));
  });

  test('read-only commands yield no targets', () => {
    eq(policy.extractBashTargets('cat CLAUDE.md'), []);
    eq(policy.extractBashTargets('ls -la'), []);
    eq(policy.extractBashTargets('grep -r foo src/'), []);
    eq(policy.extractBashTargets("sed 's/a/b/' CLAUDE.md"), [], 'sed without -i does not write');
  });

  test('/dev/null redirection is ignored', () => {
    eq(policy.extractBashTargets('noisy 2> /dev/null'), []);
  });

  test('chained commands are all inspected', () => {
    const t = policy.extractBashTargets('cd x && rm -f CLAUDE.md');
    ok(t.includes('CLAUDE.md'), JSON.stringify(t));
    const t2 = policy.extractBashTargets('ls; sudo tee .aidev/sync.lock | cat');
    ok(t2.includes('.aidev/sync.lock'), JSON.stringify(t2));
  });

  test('decideMany denies as soon as one target violates policy', () => {
    const fx = makeRepo();
    try {
      const r = policy.decideMany(fx.root, ['.aidev/knowledge/x.md', '.claude/settings.json'], ctx(fx));
      eq(r.decision, 'deny');
      eq(r.first.rule, 'protected');
      eq(r.results.length, 2);
      const ro = policy.decideMany(fx.root, ['notes.md', '.claude/settings.json'], ctx(fx));
      eq(ro.decision, 'deny');
      eq(ro.first.rule, 'read-only', 'stops at the first denial');
      eq(ro.results.length, 1);
      const okAll = policy.decideMany(fx.root, ['.aidev/knowledge/x.md', 'aidev.yaml'], ctx(fx));
      eq(okAll.decision, 'allow');
    } finally { fx.cleanup(); }
  });
}

module.exports = { run };

if (require.main === module) {
  const { summary } = require('./harness');
  run();
  process.exit(summary() ? 0 : 1);
}
