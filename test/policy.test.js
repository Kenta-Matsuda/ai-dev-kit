'use strict';
/**
 * Policy-engine tests.
 *
 * These encode the security contract, so they assert precedence explicitly:
 * a lease must never outrank protection, and the consistency error must never
 * be escapable without a lease.
 */

const fs = require('fs');
const path = require('path');
const { suite, test, eq, ok } = require('./harness');
const { makeRepo, advancePkg, git } = require('./fixtures');
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

function run() {
  suite('policy: protected paths');

  test('kit-owned files are denied', () => {
    const fx = makeRepo();
    try {
      for (const p of ['.claude/settings.json', '.claude/agents/x.md', 'CLAUDE.md', '.mcp.json',
        '.aidev/policy.yaml', '.aidev/sync.lock', '.aidev-lock', '.aidev/leases/wi-1.json']) {
        const d = decide(fx, p);
        eq(d.decision, 'deny', `${p} should be denied`);
        ok(d.rule === 'protected' || d.rule === 'secrets', `${p} rule=${d.rule}`);
      }
    } finally { fx.cleanup(); }
  });

  test('secret paths are denied ahead of everything else', () => {
    const fx = makeRepo();
    try {
      const d = decide(fx, 'src/config/secrets/key.pem');
      eq(d.decision, 'deny');
      eq(d.rule, 'secrets');
    } finally { fx.cleanup(); }
  });

  test('traversal cannot reach a protected path', () => {
    const fx = makeRepo();
    try {
      const d = decide(fx, 'knowledge/../.claude/settings.json');
      eq(d.decision, 'deny');
      eq(d.rule, 'protected');
    } finally { fx.cleanup(); }
  });

  test('paths outside the repository are denied', () => {
    const fx = makeRepo();
    try {
      const d = decide(fx, path.join(fx.root, '..', 'elsewhere.txt'));
      eq(d.decision, 'deny');
      eq(d.rule, 'outside-repo');
    } finally { fx.cleanup(); }
  });

  suite('policy: consistency gate');

  test('when all SHAs agree, ordinary files are writable', () => {
    const fx = makeRepo();
    try {
      const d = decide(fx, 'workflows/my-flow/loop.py');
      eq(d.decision, 'allow');
      eq(d.rule, 'default');
    } finally { fx.cleanup(); }
  });

  test('a consistency error with no lease blocks every write', () => {
    const fx = makeRepo();
    try {
      // Bump the submodule so submoduleSha != knowledgeSha.
      const newSha = advancePkg(fx);
      git(['fetch', '-q', 'origin', 'main'], fx.pkgDir);
      git(['checkout', '-q', newSha], fx.pkgDir);
      const st = state.computeState(fx.root, ctx(fx).config, { checkRemote: false });
      eq(st.severity, 'error');
      for (const p of ['knowledge/api/auth.md', 'workflows/x.py', 'notes.md']) {
        const d = decide(fx, p);
        eq(d.decision, 'deny', `${p} during error state`);
        eq(d.rule, 'consistency-no-lease');
      }
    } finally { fx.cleanup(); }
  });

  test('the sync lease unblocks knowledge/** and nothing else', () => {
    const fx = makeRepo();
    try {
      const newSha = advancePkg(fx);
      git(['fetch', '-q', 'origin', 'main'], fx.pkgDir);
      git(['checkout', '-q', newSha], fx.pkgDir);
      leases.acquireSyncLease(fx.root, {
        targetSha: newSha, originalSha: fx.pkgSha, ttlMinutes: 120,
      });

      const wiki = decide(fx, 'knowledge/api/auth.md');
      eq(wiki.decision, 'allow', 'wiki writable under lease');
      eq(wiki.rule, 'sync-lease');

      const other = decide(fx, 'workflows/x.py');
      eq(other.decision, 'deny', 'non-wiki still denied');
      eq(other.rule, 'sync-lease-scope');

      const src = decide(fx, 'src/src/api/auth.ts');
      eq(src.decision, 'deny', 'src still denied under sync lease');

      const prot = decide(fx, '.claude/settings.json');
      eq(prot.decision, 'deny', 'protection outranks the lease');
      eq(prot.rule, 'protected');
    } finally { fx.cleanup(); }
  });

  test('an expired sync lease does not unblock writes', () => {
    const fx = makeRepo();
    try {
      const newSha = advancePkg(fx);
      git(['fetch', '-q', 'origin', 'main'], fx.pkgDir);
      git(['checkout', '-q', newSha], fx.pkgDir);
      leases.acquireSyncLease(fx.root, { targetSha: newSha, originalSha: fx.pkgSha, ttlMinutes: 60 });
      const p = cfg.syncLockPath(fx.root);
      const l = JSON.parse(fs.readFileSync(p, 'utf8'));
      l.acquiredAt = new Date(Date.now() - 120 * 60000).toISOString();
      fs.writeFileSync(p, JSON.stringify(l));

      const d = decide(fx, 'knowledge/api/auth.md');
      eq(d.decision, 'deny');
      eq(d.rule, 'consistency-no-lease');
      ok(/expired/.test(d.reason), 'reason mentions expiry');
    } finally { fx.cleanup(); }
  });

  suite('policy: read-only src and work leases');

  test('src is read-only without a lease', () => {
    const fx = makeRepo();
    try {
      const d = decide(fx, 'src/src/api/auth.ts');
      eq(d.decision, 'deny');
      eq(d.rule, 'read-only');
    } finally { fx.cleanup(); }
  });

  test('a scoped work lease on the right branch permits the write', () => {
    const fx = makeRepo();
    try {
      git(['checkout', '-q', '-b', 'ai/wi-1234'], fx.pkgDir);
      leases.createWorkLease(fx.root, {
        taskId: 'wi-1234', workItemId: 1234, branch: 'ai/wi-1234',
        allowedPaths: ['src/src/**'], ttlMinutes: 120,
      });
      const d = decide(fx, 'src/src/api/auth.ts');
      eq(d.decision, 'allow');
      eq(d.rule, 'work-lease');
    } finally { fx.cleanup(); }
  });

  test('a work lease does not apply on a different branch', () => {
    const fx = makeRepo();
    try {
      leases.createWorkLease(fx.root, {
        taskId: 'wi-1234', branch: 'ai/wi-1234', allowedPaths: ['src/src/**'],
      });
      // Submodule is on main (detached/main), not the leased branch.
      const d = decide(fx, 'src/src/api/auth.ts');
      eq(d.decision, 'deny');
      eq(d.rule, 'read-only');
      ok(/scoped to branch|could not be determined/.test(d.reason), d.reason);
    } finally { fx.cleanup(); }
  });

  test('a work lease does not reach outside its allowed paths', () => {
    const fx = makeRepo();
    try {
      git(['checkout', '-q', '-b', 'ai/wi-1234'], fx.pkgDir);
      leases.createWorkLease(fx.root, {
        taskId: 'wi-1234', branch: 'ai/wi-1234', allowedPaths: ['src/src/api/**'],
      });
      eq(decide(fx, 'src/src/api/auth.ts').decision, 'allow');
      const outside = decide(fx, 'src/docs/readme.md');
      eq(outside.decision, 'deny', 'outside lease scope');
    } finally { fx.cleanup(); }
  });

  test('a work lease never overrides secrets', () => {
    const fx = makeRepo();
    try {
      git(['checkout', '-q', '-b', 'ai/wi-1234'], fx.pkgDir);
      leases.createWorkLease(fx.root, {
        taskId: 'wi-1234', branch: 'ai/wi-1234', allowedPaths: ['src/**'],
      });
      const d = decide(fx, 'src/config/secrets/key.pem');
      eq(d.decision, 'deny');
      eq(d.rule, 'secrets');
    } finally { fx.cleanup(); }
  });

  test('an expired work lease stops authorising', () => {
    const fx = makeRepo();
    try {
      git(['checkout', '-q', '-b', 'ai/wi-1234'], fx.pkgDir);
      leases.createWorkLease(fx.root, {
        taskId: 'wi-1234', branch: 'ai/wi-1234', allowedPaths: ['src/src/**'], ttlMinutes: 60,
      });
      const lp = leases.leasePath(fx.root, 'wi-1234');
      const l = JSON.parse(fs.readFileSync(lp, 'utf8'));
      l.acquiredAt = new Date(Date.now() - 120 * 60000).toISOString();
      fs.writeFileSync(lp, JSON.stringify(l));
      const d = decide(fx, 'src/src/api/auth.ts');
      eq(d.decision, 'deny');
      ok(/expired/.test(d.reason), d.reason);
    } finally { fx.cleanup(); }
  });

  test('package.exclude still applies under a work lease', () => {
    const fx = makeRepo();
    try {
      git(['checkout', '-q', '-b', 'ai/wi-1234'], fx.pkgDir);
      leases.createWorkLease(fx.root, {
        taskId: 'wi-1234', branch: 'ai/wi-1234', allowedPaths: ['src/**'],
      });
      const d = decide(fx, 'src/src/node_modules/pkg/index.js');
      eq(d.decision, 'deny');
      eq(d.rule, 'work-lease-scope');
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
  });

  test('read-only commands yield no targets', () => {
    eq(policy.extractBashTargets('cat CLAUDE.md'), []);
    eq(policy.extractBashTargets('ls -la'), []);
    eq(policy.extractBashTargets('grep -r foo src/'), []);
  });

  test('/dev/null redirection is ignored', () => {
    eq(policy.extractBashTargets('noisy 2> /dev/null'), []);
  });

  test('chained commands are all inspected', () => {
    const t = policy.extractBashTargets('cd x && rm -f CLAUDE.md');
    ok(t.includes('CLAUDE.md'), JSON.stringify(t));
  });

  test('decideMany denies as soon as one target violates policy', () => {
    const fx = makeRepo();
    try {
      const r = policy.decideMany(fx.root, ['notes.md', '.claude/settings.json'], ctx(fx));
      eq(r.decision, 'deny');
      eq(r.first.rule, 'protected');
    } finally { fx.cleanup(); }
  });
}

module.exports = { run };
