'use strict';
/** Unit tests for yaml, paths, config validation, leases. */

const path = require('path');
const fs = require('fs');
const { suite, test, eq, ok, throws } = require('./harness');
const yaml = require('../cli/lib/yaml');
const P = require('../cli/lib/paths');
const cfg = require('../cli/lib/config');
const leases = require('../cli/lib/leases');
const { makeRepo } = require('./fixtures');

function run() {
  suite('yaml: parsing');

  test('nested maps and lists', () => {
    const v = yaml.parse([
      'version: 1',
      'package:',
      '  name: my-pkg',
      '  include: ["a/**", "b/**"]',
      '  exclude:',
      '    - "**/node_modules/**"',
      '    - "**/vendor/**"',
    ].join('\n'));
    eq(v.version, 1);
    eq(v.package.name, 'my-pkg');
    eq(v.package.include, ['a/**', 'b/**']);
    eq(v.package.exclude, ['**/node_modules/**', '**/vendor/**']);
  });

  test('comments are stripped but "#" inside quotes survives', () => {
    const v = yaml.parse([
      'a: 1   # trailing comment',
      '# whole line',
      'b: "has # hash"',
      "c: 'single # hash'",
    ].join('\n'));
    eq(v.a, 1); eq(v.b, 'has # hash'); eq(v.c, 'single # hash');
  });

  test('scalar types', () => {
    const v = yaml.parse(['i: 42', 'f: 3.5', 'tt: true', 'ff: false', 'n: null', 'e: ~', 's: plain text'].join('\n'));
    eq(v.i, 42); eq(v.f, 3.5); eq(v.tt, true); eq(v.ff, false);
    eq(v.n, null); eq(v.e, null); eq(v.s, 'plain text');
  });

  test('sequence at parent indent level', () => {
    const v = yaml.parse(['secrets_paths:', '- "a/**"', '- "b/**"'].join('\n'));
    eq(v.secrets_paths, ['a/**', 'b/**']);
  });

  test('list of maps (pipeline schedules)', () => {
    const v = yaml.parse([
      'schedules:',
      '  - cron: "0 18 * * *"',
      '    always: true',
      '    branches: { include: [main] }',
    ].join('\n'));
    eq(v.schedules.length, 1);
    eq(v.schedules[0].cron, '0 18 * * *');
    eq(v.schedules[0].always, true);
    eq(v.schedules[0].branches.include, ['main']);
  });

  test('empty document yields an empty map', () => { eq(yaml.parse(''), {}); eq(yaml.parse('# only\n'), {}); });

  test('tabs and unterminated quotes are rejected', () => {
    throws(() => yaml.parse('a:\n\tb: 1'), /tab/i, 'tabs');
    throws(() => yaml.parse('a: "unterminated'), /unterminated/i, 'quote');
  });

  test('round-trips through stringify', () => {
    const src = { version: 1, protected: ['.claude/**', 'CLAUDE.md'], read_only: ['src/**'], nested: { a: 1, b: 'x y' } };
    const back = yaml.parse(yaml.stringify(src));
    eq(back, src);
  });

  test('stringify quotes values that would re-parse as another type', () => {
    const back = yaml.parse(yaml.stringify({ a: 'true', b: '123', c: '' }));
    eq(back.a, 'true'); eq(back.b, '123'); eq(back.c, '');
  });

  suite('paths: normalisation');

  test('separators fold and "." drops', () => {
    eq(P.normalizeRel('a\\b\\c'), 'a/b/c');
    eq(P.normalizeRel('./a/./b'), 'a/b');
    eq(P.normalizeRel('a/b/'), 'a/b');
  });

  test('".." is resolved lexically before matching', () => {
    eq(P.normalizeRel('knowledge/../.claude/settings.json'), '.claude/settings.json');
    eq(P.normalizeRel('a/b/../../c'), 'c');
  });

  test('traversal out of the repo is detectable', () => {
    ok(P.escapesRoot(P.normalizeRel('../outside')), 'parent escape');
    ok(!P.escapesRoot(P.normalizeRel('a/../b')), 'contained');
  });

  suite('paths: globs');

  test('"dir/**" matches the directory itself and all descendants', () => {
    ok(P.matches('.claude/**', '.claude'), 'bare dir');
    ok(P.matches('.claude/**', '.claude/settings.json'), 'child');
    ok(P.matches('.claude/**', '.claude/agents/x/y.md'), 'deep');
    ok(!P.matches('.claude/**', '.claudex/settings.json'), 'prefix must not leak');
  });

  test('"*" stays within one segment', () => {
    ok(P.matches('*.pat', 'token.pat'));
    ok(!P.matches('*.pat', 'dir/token.pat'));
    ok(P.matches('src/*.ts', 'src/a.ts'));
    ok(!P.matches('src/*.ts', 'src/a/b.ts'));
  });

  test('leading "**/" matches at any depth including zero', () => {
    ok(P.matches('**/*.pfx', 'a.pfx'));
    ok(P.matches('**/*.pfx', 'x/y/a.pfx'));
    ok(P.matches('**/node_modules/**', 'src/node_modules/pkg/i.js'));
    ok(P.matches('**/node_modules/**', 'node_modules'));
  });

  test('traversal is matched against the resolved path', () => {
    ok(P.matches('.claude/**', 'knowledge/../.claude/settings.json'), 'escape caught');
  });

  test('firstMatch reports which pattern fired', () => {
    eq(P.firstMatch(['a/**', 'src/**'], 'src/x.ts'), 'src/**');
    eq(P.firstMatch(['a/**'], 'z'), null);
  });

  test('include/exclude interaction', () => {
    ok(P.isIncluded('src/src/a.ts', ['src/src/**'], ['**/vendor/**']));
    ok(!P.isIncluded('src/src/vendor/a.ts', ['src/src/**'], ['**/vendor/**']), 'exclude wins');
    ok(!P.isIncluded('other/a.ts', ['src/src/**'], []), 'outside include');
    ok(P.isIncluded('anything', [], []), 'empty include = no restriction');
  });

  suite('config: validation');

  const base = {
    version: 1,
    package: { name: 'p' },
    azure_devops: { organization: 'o', project: 'pr', repository: 'r' },
  };

  test('defaults are filled in', () => {
    const c = cfg.validateConfig(JSON.parse(JSON.stringify(base)));
    eq(c.sync.tracking_branch, 'main');
    eq(c.sync.remote_check_timeout_ms, 3000);
    eq(c.task.lease_ttl_minutes, 120);
    eq(c.knowledge.max_files_per_dir, 20);
    eq(c.model.agent, 'sonnet');
    eq(c.self_evolution.enabled, true);
  });

  test('a model identifier is validated by shape, not against a list of models', () => {
    // Every form a provider legitimately uses has to pass, or the kit would need
    // a release every time Anthropic ships a model.
    for (const good of [
      'sonnet', 'opus', 'haiku', 'inherit', 'opusplan', 'sonnet[1m]',
      'claude-opus-4-8', 'claude-sonnet-4-5-20250929',
      'anthropic/claude-opus-4-8', 'us.anthropic.claude-opus-4-8-v1:0',
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/my-profile',
      'my_foundry_deployment',
    ]) {
      eq(cfg.validateConfig({ ...base, model: { agent: good } }).model.agent, good,
        `rejected a legitimate model: ${good}`);
    }
  });

  test('a model value that could be read as a flag or split an argv is refused', () => {
    for (const bad of [
      '--dangerously-skip-permissions', '-p', 'a b', 'x\ny', 'a;b', 'a&&b',
      'a|b', 'a$b', "a'b", 'x'.repeat(cfg.MODEL_MAX_LENGTH + 1),
    ]) {
      throws(() => cfg.validateConfig({ ...base, model: { agent: bad } }),
        /model\.agent/, `accepted an unsafe model: ${JSON.stringify(bad)}`);
    }
  });

  test('an explicitly empty model means "let Claude Code decide", not the default', () => {
    // Distinct from an absent key: absent takes the kit default, empty means the
    // CLI passes no --model at all and leaves the resolution to Claude Code.
    eq(cfg.validateConfig({ ...base, model: { agent: '' } }).model.agent, null);
    eq(cfg.validateConfig({ ...base, model: {} }).model.agent, 'sonnet');
  });

  test('model written as a scalar is refused rather than silently ignored', () => {
    // `model: sonnet` is the obvious way to mis-write this; treating it as an
    // empty mapping would drop the one thing the author asked for.
    throws(() => cfg.validateConfig({ ...base, model: 'sonnet' }), /must be a mapping/);
    throws(() => cfg.validateConfig({ ...base, model: ['sonnet'] }), /must be a mapping/);
  });

  test('required fields are enforced', () => {
    throws(() => cfg.validateConfig({ version: 1, package: {} }), /package.name/);
    throws(() => cfg.validateConfig({ version: 1, package: { name: 'p' }, azure_devops: { organization: 'o' } }), /project/);
    throws(() => cfg.validateConfig({ ...base, version: 2 }), /unsupported version/);
  });

  test('embedded credentials are refused', () => {
    throws(() => cfg.validateConfig({ ...base, azure_devops: { ...base.azure_devops, pat: 'x' } }),
      /must not be set/, 'explicit pat key');
    throws(() => cfg.validateConfig({ ...base, azure_devops: { ...base.azure_devops, token: 'y' } }),
      /must not be set/, 'token key');
    throws(() => cfg.validateConfig({
      ...base,
      azure_devops: { ...base.azure_devops, organization: 'A'.repeat(52) },
    }), /embedded credential/, 'credential-shaped value');
  });

  test('numeric bounds are checked', () => {
    throws(() => cfg.validateConfig({ ...base, knowledge: { max_files_per_dir: 0 } }), />= 1/);
    throws(() => cfg.validateConfig({ ...base, sync: { lease_ttl_minutes: -5 } }), />= 1/);
    throws(() => cfg.validateConfig({ ...base, task: { max_concurrent: 'many' } }), /integer/);
  });

  test('policy always re-adds the protected floor', () => {
    const p = cfg.validatePolicy({ version: 1, protected: ['custom/**'] });
    for (const must of cfg.ALWAYS_PROTECTED) ok(p.protected.includes(must), `missing ${must}`);
    ok(p.protected.includes('custom/**'), 'custom kept');
  });

  test('a policy that omits the floor cannot unprotect the kit', () => {
    const p = cfg.validatePolicy({ version: 1, protected: [] });
    ok(p.protected.includes('.claude/**'), '.claude still protected');
    ok(p.protected.includes('.aidev/sync.lock'), 'sync lock still protected');
  });

  test('a missing policy file falls back closed, not open', () => {
    const fx = makeRepo({ withPolicy: false });
    try {
      const p = cfg.loadPolicy(fx.root);
      ok(p.protected.includes('.claude/**'), 'protected floor present');
      eq(p.read_only, ['src/**']);
    } finally { fx.cleanup(); }
  });

  suite('leases: lifecycle');

  test('taskId cannot traverse', () => {
    throws(() => leases.sanitizeTaskId('../etc/passwd'), /invalid taskId/);
    throws(() => leases.sanitizeTaskId('a/b'), /invalid taskId/);
    throws(() => leases.sanitizeTaskId(''), /required/);
    eq(leases.sanitizeTaskId('wi-1234'), 'wi-1234');
  });

  test('TTL expiry is computed from acquiredAt', () => {
    const t0 = Date.now();
    const lease = { acquiredAt: new Date(t0).toISOString(), ttlMinutes: 10 };
    ok(leases.evaluateLease(lease, t0 + 5 * 60000).valid, 'still valid');
    ok(!leases.evaluateLease(lease, t0 + 11 * 60000).valid, 'expired');
    eq(leases.evaluateLease(lease, t0 + 11 * 60000).reason, 'expired');
  });

  test('malformed leases are invalid, never permissive', () => {
    ok(!leases.evaluateLease(null).valid);
    ok(!leases.evaluateLease({}).valid);
    ok(!leases.evaluateLease({ acquiredAt: 'nonsense', ttlMinutes: 10 }).valid);
    ok(!leases.evaluateLease({ acquiredAt: new Date().toISOString(), ttlMinutes: 0 }).valid);
  });

  test('a live sync lease is not stealable, and a stale one is not auto-adopted', () => {
    const fx = makeRepo();
    try {
      leases.acquireSyncLease(fx.root, { targetSha: 'a'.repeat(40), originalSha: 'b'.repeat(40), ttlMinutes: 60 });
      throws(() => leases.acquireSyncLease(fx.root, { targetSha: 'c'.repeat(40) }), /already held/);
      // Force expiry and confirm it still refuses without an explicit resume.
      const p = cfg.syncLockPath(fx.root);
      const l = JSON.parse(fs.readFileSync(p, 'utf8'));
      l.acquiredAt = new Date(Date.now() - 999 * 60000).toISOString();
      fs.writeFileSync(p, JSON.stringify(l));
      throws(() => leases.acquireSyncLease(fx.root, { targetSha: 'c'.repeat(40) }), /stale sync lease/);
      ok(leases.releaseSyncLease(fx.root), 'released');
      const fresh = leases.acquireSyncLease(fx.root, { targetSha: 'c'.repeat(40) });
      eq(fresh.targetSha, 'c'.repeat(40));
    } finally { fx.cleanup(); }
  });

  test('work leases require an ai/wi-<id> branch and a non-empty scope', () => {
    const fx = makeRepo();
    try {
      throws(() => leases.createWorkLease(fx.root, { taskId: 'wi-1', branch: 'main', allowedPaths: ['src/**'] }),
        /ai\/wi-/, 'branch shape');
      throws(() => leases.createWorkLease(fx.root, { taskId: 'wi-1', branch: 'ai/wi-1', allowedPaths: [] }),
        /at least one/, 'empty scope');
      const l = leases.createWorkLease(fx.root, {
        taskId: 'wi-1', branch: 'ai/wi-1', allowedPaths: ['src/src/**'], ttlMinutes: 30,
      });
      eq(l.branch, 'ai/wi-1');
      eq(leases.readWorkLease(fx.root, 'wi-1').taskId, 'wi-1');
      eq(leases.listWorkLeases(fx.root).length, 1);
      ok(leases.releaseWorkLease(fx.root, 'wi-1'), 'released');
      eq(leases.listWorkLeases(fx.root).length, 0);
    } finally { fx.cleanup(); }
  });

  test('a work lease cannot be minted over a secret path', () => {
    const fx = makeRepo();
    try {
      throws(() => leases.createWorkLease(fx.root, {
        taskId: 'wi-2', branch: 'ai/wi-2',
        allowedPaths: ['src/config/secrets/**'],
        secretsPaths: ['src/config/secrets/**'],
      }), /protected path/);
    } finally { fx.cleanup(); }
  });
}

module.exports = { run };
