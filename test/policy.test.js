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
 * (.aidev/knowledge/**), the workflows (.aidev/workflows/**), the conventions
 * (.aidev/conventions/**) and aidev.yaml.
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

function run() {
  suite('policy: protected paths');

  test('kit-owned files are denied', () => {
    const fx = makeRepo();
    try {
      for (const p of ['.claude/settings.json', '.claude/agents/x.md', 'CLAUDE.md',
        '.aidev/policy.yaml', '.aidev/sync.lock', '.aidev/materialized.json',
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

  suite('policy: read-only PKG');

  test('PKG source is read-only for agents', () => {
    const fx = makeRepo();
    try {
      const d = decide(fx, 'src/api/auth.ts');
      eq(d.decision, 'deny');
      eq(d.rule, 'read-only');
      ok(/inside the scope\.writable of an approved workflow/.test(d.reason), d.reason);
      eq(decide(fx, '.aidev/knowledge/x.md').rule, 'writable');
      eq(decide(fx, '.aidev/agents/mine.md').rule, 'writable');
      eq(decide(fx, '.aidev/skills/mine/SKILL.md').rule, 'writable');
      eq(decide(fx, 'aidev.yaml').rule, 'writable');
    } finally { fx.cleanup(); }
  });

  suite('policy: approved workflow scope');

  const WF = (scope) => [
    'name: wf', 'objective: do it', 'scope:', `  writable: [${scope}]`,
    'steps:', '  - id: a', '    agent: dev', '    prompt: go', 'cost:', '  max_usd: 1', '',
  ].join('\n');
  const putOnMain = (fx, scope) => {
    fs.mkdirSync(path.join(fx.root, '.aidev', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(fx.root, '.aidev', 'agents', 'dev.md'), '---\nname: dev\ndescription: t\n---\n\nbody\n', 'utf8');
    fs.mkdirSync(path.join(fx.root, '.aidev', 'workflows', 'wf'), { recursive: true });
    fs.writeFileSync(path.join(fx.root, '.aidev', 'workflows', 'wf', 'workflow.yaml'), WF(scope), 'utf8');
    git(['add', '-A'], fx.root);
    git(['commit', '-q', '-m', 'workflow'], fx.root);
    git(['push', '-q', 'origin', 'main'], fx.root);
  };

  test('a session started by the workflow runner may write inside the approved scope, nobody else may', () => {
    const fx = makeRepo();
    try {
      putOnMain(fx, 'src/**');
      const d = decide(fx, 'src/api/auth.ts', { workflow: 'wf' });
      eq(d.decision, 'allow', d.reason);
      eq(d.rule, 'workflow-writable');
      ok(/approved on origin\/main/.test(d.reason), d.reason);
      const anon = decide(fx, 'src/api/auth.ts', { workflow: null });
      eq(anon.rule, 'read-only', 'an interactive session');
      ok(/not started by "aidev run workflow"/.test(anon.reason), anon.reason);
      const outside = decide(fx, 'docs/readme.md', { workflow: 'wf' });
      eq(outside.rule, 'read-only', 'outside the scope');
      ok(/does not cover this path/.test(outside.reason), outside.reason);
      const unknown = decide(fx, 'src/api/auth.ts', { workflow: 'nope' });
      eq(unknown.rule, 'read-only');
      ok(/no such workflow: nope/.test(unknown.reason), unknown.reason);
    } finally { fx.cleanup(); }
  });

  test('a scope never reaches protected paths or secrets, and a local edit revokes it', () => {
    const fx = makeRepo();
    try {
      putOnMain(fx, '"**"');
      eq(decide(fx, 'config/secrets/key.pem', { workflow: 'wf' }).rule, 'secrets');
      eq(decide(fx, '.claude/settings.json', { workflow: 'wf' }).rule, 'protected');
      eq(decide(fx, '.aidev/policy.yaml', { workflow: 'wf' }).rule, 'protected');
      eq(decide(fx, 'src/x.ts', { workflow: 'wf' }).rule, 'workflow-writable');
      // The agent widens its own scope mid-run: the file no longer matches origin/main.
      fs.appendFileSync(path.join(fx.root, '.aidev', 'workflows', 'wf', 'workflow.yaml'), '# widened\n', 'utf8');
      const revoked = decide(fx, 'src/x.ts', { workflow: 'wf' });
      eq(revoked.rule, 'read-only');
      ok(/not approved: .*differs from origin\/main/.test(revoked.reason), revoked.reason);
    } finally { fx.cleanup(); }
  });

  test('the workflow comes from the environment the runner sets, and old agent grants are refused', () => {
    const fx = makeRepo();
    try {
      putOnMain(fx, 'src/**');
      eq(decide(fx, 'src/x.ts').rule, 'read-only', 'no AIDEV_WORKFLOW in this process');
      process.env.AIDEV_WORKFLOW = 'wf';
      try { eq(decide(fx, 'src/x.ts').rule, 'workflow-writable'); } finally { delete process.env.AIDEV_WORKFLOW; }
      fs.appendFileSync(path.join(fx.root, '.aidev', 'policy.yaml'), 'agents:\n  issue-to-pr:\n    writable: ["src/**"]\n', 'utf8');
      let message = null;
      try { cfg.loadPolicy(fx.root); } catch (e) { message = e.message; }
      ok(/agents\.<name> grants no longer exist/.test(message || ''), message);
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
